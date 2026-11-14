/*
 * media-sync.js - a sync from start to end: reading the repository's vault,
 * merging, pushing, moving attachments both ways, and the Sync and Backup
 * buttons.
 *
 * One sync (syncOnce): GET vault.enc, open it with the master password,
 * merge (merge.js), apply the result here, PUT the merged vault, move the
 * attachments, and only then mark things synced. A 409 (someone pushed
 * between the GET and the PUT) runs the whole sync again from a fresh GET,
 * never the old body with a new sha, which would overwrite their changes.
 *
 * Encryption on the way. Opening the repository's vault derives its key
 * with PBKDF2-SHA256 (1,200,000 rounds, about 0.6 s here) and decrypts it
 * with AES-256-GCM; it is skipped when the repository's file is unchanged
 * since the last sync (the sha shortcut). The merged vault is sealed again
 * (a fresh random IV, about 20 ms per 500 KB) before the PUT. Attachments
 * travel as the encrypted bytes they already are; each one downloaded is
 * decrypted once to check its GCM tag before it is kept, since the
 * repository's bytes are untrusted. A file that cannot be opened with this
 * password is never overwritten, except through the explicit "overwrite"
 * button. The Backup button saves the vault sealed exactly like vault.enc:
 * guessing its password offline costs a full PBKDF2 per guess.
 *
 * Every failure with an attachment is a warning for that file, never a sync
 * failure: the vault is what must stay consistent.
 *
 * Main functions: runSync, syncOnce, syncMediaPhase, putMedia, getMedia,
 * deleteRemoteMedia, overwriteRemote.
 * Auxiliary functions: mediaIdsFor, putMediaFile.
 *
 * Complexity: a sync is a handful of requests plus the merge (O(n * s)) and
 * one PBKDF2; each attachment moved is O(size), in 20 MB parts when larger.
 */
"use strict";

// ---------- State ----------

// Whether this run already sealed the pre-merge snapshot. Per run, not per
// attempt: a 409 retry goes through applyMerge again, and without this the
// second pass would overwrite the real pre-merge snapshot with the vault the
// first pass had already merged.
let snapshotTakenThisRun = false;

// ---------- A sync ----------

/**
 * The driver for the Sync button, "Sync this note" and "Sync folder": the
 * same freeze, error handling and chips for all three. It saves the open
 * note first, cancels a waiting reflow (it would fire in the middle of the
 * merge and write the old sheets back over the merged note), purges trash
 * that just expired (so its tombstones travel with this sync), and freezes
 * editing. If another device already moved this vault into its folder, it
 * follows it there first, or it would put a fresh vault.enc back at the top
 * level. A 409 runs the whole sync once more. A failure leaves syncMeta and
 * "Last synced" untouched: the old time is the honest one, and the unsynced
 * chip stays lit. A full sync that worked then offers an app update, after
 * the notes and outside the freeze. Never in a backup, which must never talk
 * to the repository.
 *
 * Used by: this file (the Sync button, syncNote and syncFolder, on load).
 * Uses: saveTimer (events.js), repagTimer, saveCurrent, status,
 * classifySyncError and renderStatus (pagination.js), autoPurgeTrash and
 * persistLocal (vault.js), setEditingEnabled and gh (sync.js), selectedVault,
 * LEGACY_VAULT and FILE (core.js), moveVaultToFolder (vaults.js), syncOnce,
 * appUpdateStep (updates.js).
 * Complexity: that of syncOnce, at most twice.
 */
async function runSync(scope) {
  if (syncing || backupView) {
    return;
  }
  syncing = true;
  snapshotTakenThisRun = false;
  clearTimeout(saveTimer);
  clearTimeout(repagTimer);
  saveCurrent();
  if (autoPurgeTrash()) {
    await persistLocal();
  }
  setEditingEnabled(false);
  $("sync").disabled = true;
  $("backup").disabled = true;
  $("sync").textContent = "Syncing...";
  status(scope ? `Syncing this ${scope.label}...` : "Syncing...", false, true);
  let result = null;
  try {
    if (selectedVault && !selectedVault.dir && vault.token &&
        (await gh("GET", null, LEGACY_VAULT + "/" + FILE)).status === 200) {
      status("This vault moved into its folder on another device: following it...", false, true);
      await moveVaultToFolder(LEGACY_VAULT);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        result = await syncOnce(scope);
        break;
      } catch (error) {
        if (error && error.status === 409 && attempt < 2) {
          status("Remote changed, merging again...", false, true);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    lastSyncError = classifySyncError(error);
    status(error.message, true);
    renderStatus();
  } finally {
    syncing = false;
    setEditingEnabled(true);
    $("sync").disabled = false;
    $("backup").disabled = false;
    $("sync").textContent = "Sync";
    renderStatus();
  }
  if (!scope && result === "ok" && !backupView) {
    await appUpdateStep();
  }
}

/**
 * One pass of a sync; returns "ok", or "blocked" when it stopped on purpose
 * (a password mismatch, a cancel), so the caller neither retries nor reports
 * an error.
 *   1. GET vault.enc. When its sha is the one last synced (full sync only),
 *      only local changes can exist and no decrypt or merge is needed; a
 *      scoped sync never takes that shortcut, since it must rebuild the
 *      pushed blob from the remote vault. Otherwise it is read (raw when over
 *      1 MB) and opened with masterPassword, not the password field: the
 *      remote may use another salt or round count, and the field is cleared
 *      at unlock. A vault it cannot open is never pushed over: it may belong
 *      to another password or machine, so the sync stops with "pwmismatch".
 *      With no remote vault yet, a scoped sync becomes a full one (it must
 *      not PUT a one-note vault).
 *   2. Merge: the scope widened by the remote, the stale-device question, the
 *      merge, conflict copies joining the scope, and a confirmation when
 *      unsynced local edits would be replaced without a copy (the snapshot is
 *      kept either way). Attachments whose tombstone the merge lifted are
 *      marked not uploaded, so whichever device has their bytes uploads them
 *      again. The result is applied here.
 *   3. PUT the merged vault when the remote must change, stamped with
 *      savedAt (an older copy of the app still decides pull or push by
 *      savedAt, and an unstamped push would let it push its stale vault over
 *      the merged one), and mirror it as vault.enc.js.
 *   4. Move the attachments, then mark synced (a pull-only merge too, or the
 *      unsynced chip would stick), keeping notes the stale-device guard
 *      skipped unsynced, since they were not pushed. The status line sums up.
 *
 * Used by: this file (runSync).
 * Uses: gh, ghRaw and pushWrapper (sync.js), vaultPath and FILE (core.js),
 * openVault, sealVault and sealObject (core.js), augmentScope,
 * staleDeviceExclusions, mergeVaults and applyMerge (merge.js),
 * confirmModal (modal.js), anyUnsynced, persistLocal, markSynced and
 * markScopedSynced (vault.js), syncMediaPhase, renderAttachments
 * (attachments.js), saveSyncMeta (core.js), renderList (sidebar.js),
 * renderStatus and status (pagination.js).
 * Complexity: one PBKDF2 (about 0.6 s) when the remote changed, the merge, one seal.
 */
async function syncOnce(scope) {
  const res = await gh("GET");
  let sha;
  let remote = null;
  let fast = false;
  if (res.status === 200) {
    const meta = await res.json();
    sha = meta.sha;
    fast = !scope && !!meta.sha && meta.sha === syncMeta.remoteSha;
    if (!fast) {
      // The content is "" for any file over 1 MB: then the raw media type is used.
      const text = meta.content ? atob(meta.content.replace(/\n/g, ""))
        : await (await ghRaw(vaultPath(FILE))).text();
      let opened;
      try {
        opened = await openVault(text, masterPassword);
      } catch {
        lastSyncError = { at: Date.now(), httpStatus: null, kind: "pwmismatch",
          raw: "Remote vault.enc could not be decrypted with this master password.", sha };
        status("Sync blocked: remote password mismatch", true);
        renderStatus();
        return "blocked";
      }
      // openVault brings an old v1 vault up to v2, so the merge never sees missing maps.
      remote = opened.vault;
    }
  } else if (scope) {
    scope = null;
  }

  let info = null;
  let pushed = vault;
  let remoteChanged = true;
  let exclude = null;
  if (remote) {
    if (scope) {
      augmentScope(scope, remote);
    }
    exclude = await staleDeviceExclusions(remote, scope);
    info = await mergeVaults(vault, remote, scope, exclude);
    // Conflict copies are pushed with this scope, so they belong to it.
    if (scope) {
      for (const id of info.newIds) {
        scope.ids.add(id);
      }
    }
    if (info.risky.length) {
      // Asked inside the try: syncing stays true and editing stays frozen.
      const go = await confirmModal({
        title: "Merge will replace unsynced local edits",
        body: `${info.risky.length} note(s) edited here but never synced will be replaced by the ` +
          `repo's version: ${info.risky.slice(0, 5).join(", ")}. A pre-merge snapshot is kept either way.`,
        confirmLabel: "Merge anyway", destructive: true,
      });
      if (!go) {
        status("Sync cancelled");
        return "blocked";
      }
    }
    pushed = info.pushed;
    remoteChanged = info.remoteChanged;
    for (const mid of info.resurrectedMedia) {
      delete syncMeta.mediaSynced[mid];
    }
    if (info.localChanged) {
      await applyMerge(info, remote);
    }
  } else {
    // The shortcut, or a first push: the local vault is the merged state.
    remoteChanged = !(fast && !unsavedEdits && !anyUnsynced() && syncMeta.lastSyncedAt !== null &&
      (vault.savedAt || 0) <= (syncMeta.syncedSavedAt || 0));
  }

  let putSha = sha;
  if (remoteChanged) {
    let sealed;
    if (pushed === vault) {
      await persistLocal();
      sealed = await sealVault();
    } else {
      pushed.savedAt = Date.now();
      sealed = await sealObject(pushed);
    }
    const put = await (await gh("PUT", { message: "sync", content: btoa(sealed), sha })).json();
    putSha = put.content && put.content.sha;
    await pushWrapper(sealed);
  }

  // Bytes arriving or purged change what the strip can show, and the merge
  // may not have touched the vault at all, so the strip is drawn again here too.
  const media = await syncMediaPhase(scope);
  if (media.pulled || media.dropped) {
    renderAttachments();
  }

  if (scope) {
    markScopedSynced(scope, putSha, info ? info.outOfScopeDiverged : true);
  } else {
    markSynced(putSha);
  }

  if (exclude && exclude.size) {
    for (const id of exclude) {
      delete syncMeta.noteMtimes[id];
      delete syncMeta.folderMtimes[id];
    }
    saveSyncMeta();
    renderList();
    renderStatus();
  }

  const bits = [];
  const quiet = !remoteChanged && !(info && info.localChanged) && !media.pulled && !media.dropped;
  if (quiet) {
    bits.push("Already up to date");
  } else {
    bits.push((scope ? "Synced this " + scope.label : "Synced") + " " + new Date().toLocaleTimeString());
  }
  if (info && info.localDelta) {
    bits.push(`${info.localDelta} change(s) merged in`);
  }
  if (info && info.conflicts.length) {
    bits.push(`${info.conflicts.length} conflict copy/copies kept`);
  }
  if (media.pulled) {
    bits.push(`${media.pulled} attachment(s) fetched`);
  }
  if (media.warn.length) {
    bits.push(`${media.warn.length} attachment(s) not transferred`);
  }
  status(bits.join(" - "), media.warn.length > 0);
  return "ok";
}

/**
 * Moves the attachments of the notes in scope (and, on a full sync, of every
 * preset, which can outlive the note it came from) and returns { warn,
 * pulled, dropped } (pulled and dropped count bytes changed here, so the
 * caller knows to draw the strip again):
 *   1. Upload every one this device has and has not uploaded yet.
 *   2. Fetch every one missing here: from the vault's own media folder when
 *      the bytes are already beside index.html, else from the repository;
 *      either way checked (decrypted once) before being kept.
 *   3. Bytes with a tombstone: deleted from the repository (if uploaded from
 *      here) and from this device, retried on every sync while the tombstone
 *      lives, and never while something still names them.
 *
 * Used by: this file (syncOnce, overwriteRemote).
 * Uses: mediaIdsFor, bodyMediaIds (content.js), idbKeys, idbPut, idbDelete,
 * decryptMedia, mediaReferenced and revokeMediaUrl (vault.js), status
 * (pagination.js), putMedia, loadMediaFile and removeMediaFile (vaults.js),
 * getMedia, deleteRemoteMedia, saveSyncMeta (core.js).
 * Complexity: O(size) per attachment moved.
 */
async function syncMediaPhase(scope) {
  const warn = [];
  let pulled = 0;
  let dropped = 0;
  const wanted = mediaIdsFor(vault, scope ? [...scope.ids]
    : [...Object.keys(vault.notes), ...Object.keys(vault.trash)]);
  if (!scope) {
    for (const pid in (vault.presets || {})) {
      const preset = vault.presets[pid];
      for (const item of (preset.media || [])) {
        wanted.add(item.id);
      }
      for (const page of (preset.pages || [])) {
        if (page.bodyV === 2) {
          for (const mid of bodyMediaIds(page.body, 2)) {
            wanted.add(mid);
          }
        }
      }
    }
  }
  let have;
  try {
    have = new Set(await idbKeys());
  } catch {
    return { warn: ["IndexedDB unavailable, attachments not transferred"], pulled: 0, dropped: 0 };
  }

  // 1. Uploads.
  for (const id of wanted) {
    if (!have.has(id) || syncMeta.mediaSynced[id]) {
      continue;
    }
    status("Uploading attachment...", false, true);
    try {
      await putMedia(id);
    } catch (error) {
      warn.push("upload " + id.slice(0, 8) + ": " + error.message);
    }
  }

  // 2. Fetches.
  for (const id of wanted) {
    if (have.has(id)) {
      continue;
    }
    const local = await loadMediaFile(id);
    if (local) {
      try {
        await decryptMedia(id, local);
        await idbPut(id, local);
        have.add(id);
        pulled++;
        continue;
      } catch {}
    }
    status("Downloading attachment...", false, true);
    try {
      if (await getMedia(id)) {
        have.add(id);
        pulled++;
      }
    } catch (error) {
      warn.push("download " + id.slice(0, 8) + ": " + error.message);
    }
  }

  // 3. Tombstones.
  const purgedIds = scope ? [...scope.ids].filter(id => id in vault.purged) : Object.keys(vault.purged);
  for (const id of purgedIds) {
    const pushedHere = !!syncMeta.mediaSynced[id];
    // Not an attachment this device ever held.
    if (!have.has(id) && !pushedHere) {
      continue;
    }
    // Belt and braces: the merge already lifts these.
    if (mediaReferenced(id)) {
      continue;
    }
    if (pushedHere) {
      try {
        await deleteRemoteMedia(id);
      } catch (error) {
        warn.push("delete " + id.slice(0, 8) + ": " + error.message);
        continue;
      }
    }
    if (have.has(id)) {
      revokeMediaUrl(id);
      try {
        await idbDelete(id);
      } catch {}
      removeMediaFile(id);
      have.delete(id);
      dropped++;
    }
    delete syncMeta.mediaSynced[id];
  }
  saveSyncMeta();
  return { warn, pulled, dropped };
}

// ---------- Moving one attachment ----------

/**
 * Uploads one attachment's encrypted bytes from IndexedDB; returns whether
 * it had them. Above MEDIA_CHUNK (20 MB) it goes as parts first and a small
 * manifest last, so a torn upload leaves no manifest and the next sync tries
 * the whole set again.
 *
 * Used by: this file (syncMediaPhase).
 * Uses: idbGet (vault.js), MEDIA_CHUNK and CHUNK_MAGIC (attachments.js),
 * putMediaFile, vaultPath (core.js), status (pagination.js), textToBytes (core.js).
 * Complexity: O(size), one request per 20 MB.
 */
async function putMedia(id) {
  const record = await idbGet(id);
  if (!record || !record.bytes) {
    return false;
  }
  const total = record.bytes.byteLength;
  if (total <= MEDIA_CHUNK) {
    await putMediaFile(vaultPath("media/" + id), record.bytes);
  } else {
    const parts = Math.ceil(total / MEDIA_CHUNK);
    for (let i = 0; i < parts; i++) {
      status(`Uploading attachment (${i + 1}/${parts})...`, false, true);
      await putMediaFile(vaultPath(`media/${id}.p${i}`),
        record.bytes.slice(i * MEDIA_CHUNK, Math.min(total, (i + 1) * MEDIA_CHUNK)));
    }
    await putMediaFile(vaultPath("media/" + id), textToBytes(CHUNK_MAGIC + JSON.stringify({ parts, total })).buffer);
  }
  syncMeta.mediaSynced[id] = 1;
  return true;
}

/**
 * Downloads one attachment and keeps it; returns whether it did. A manifest
 * instead of encrypted bytes means parts: they are put back together, and a
 * missing or short part keeps the placeholder (the GCM tag over the whole
 * still checks the join end to end). The part count is bounded by what this
 * app could ever have written, since the manifest is plain text the
 * repository controls. The bytes are checked (decrypted, AES-256-GCM) before
 * anything is kept: storing them and marking them synced cannot be undone,
 * so a single flipped byte would otherwise replace the attachment with
 * garbage this device then refuses to fetch again. A failed check leaves it
 * missing, and the next sync tries again.
 *
 * Used by: this file (syncMediaPhase).
 * Uses: ghRaw (sync.js), vaultPath (core.js), CHUNK_MAGIC, MEDIA_MAX and
 * MEDIA_CHUNK (attachments.js), status (pagination.js), MEDIA_MIN_LEN,
 * decryptMedia and idbPut (vault.js), saveMediaFile (vaults.js).
 * Complexity: O(size), one request per 20 MB part.
 */
async function getMedia(id) {
  const res = await ghRaw(vaultPath("media/" + id));
  // Not there: the placeholder stays and nothing is marked.
  if (res.status === 404) {
    return false;
  }
  let buf = await res.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, CHUNK_MAGIC.length)) === CHUNK_MAGIC) {
    let manifest = null;
    try {
      manifest = JSON.parse(new TextDecoder().decode(buf).slice(CHUNK_MAGIC.length));
    } catch {}
    const parts = manifest && (manifest.parts | 0);
    if (!(parts > 0 && parts <= Math.ceil(MEDIA_MAX / MEDIA_CHUNK) + 1)) {
      return false;
    }
    const bufs = [];
    for (let i = 0; i < parts; i++) {
      status(`Downloading attachment (${i + 1}/${parts})...`, false, true);
      const partRes = await ghRaw(vaultPath(`media/${id}.p${i}`));
      if (partRes.status === 404) {
        return false;
      }
      bufs.push(new Uint8Array(await partRes.arrayBuffer()));
    }
    const out = new Uint8Array(bufs.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of bufs) {
      out.set(part, offset);
      offset += part.length;
    }
    buf = out.buffer;
  }
  if (buf.byteLength < MEDIA_MIN_LEN) {
    return false;
  }
  try {
    await decryptMedia(id, buf);
  } catch {
    return false;
  }
  await idbPut(id, buf);
  saveMediaFile(id, buf);
  // Pulled attachments must never be pushed again.
  syncMeta.mediaSynced[id] = 1;
  return true;
}

/**
 * Deletes an attachment from the repository: its file and any parts (until
 * the first gap, since parts are always numbered without gaps). A file
 * already gone counts as deleted.
 *
 * Used by: this file (syncMediaPhase).
 * Uses: gh (sync.js), vaultPath (core.js).
 * Complexity: two requests per file.
 */
async function deleteRemoteMedia(id) {
  const remove = async path => {
    const res = await gh("GET", null, path);
    if (res.status === 404) {
      return false;
    }
    const sha = (await res.json()).sha;
    await gh("DELETE", { message: "purge", sha }, path);
    return true;
  };
  await remove(vaultPath("media/" + id));
  for (let i = 0; i < 1024; i++) {
    if (!await remove(vaultPath(`media/${id}.p${i}`))) {
      break;
    }
  }
  return true;
}

// ---------- Overwriting the repository's vault ----------

/**
 * Replaces the repository's vault.enc with this browser's vault, after
 * asking: the only way past a "pwmismatch" (a remote vault this password
 * cannot open). The remote copy cannot be recovered afterwards. This vault's
 * attachments are pushed too, since the replaced copy may have named ones
 * this device never held. Never in a backup: the loaded vault is a
 * read-only snapshot, and this would PUT it over the live repository (the
 * detail panel can be reached there through the merge banner).
 *
 * Used by: panel.js (renderDetail).
 * Uses: confirmModal (modal.js), closePanel (panel.js), setEditingEnabled,
 * gh and pushWrapper (sync.js), persistLocal and markSynced (vault.js),
 * sealVault (core.js), syncMediaPhase, renderAttachments (attachments.js),
 * status, classifySyncError and renderStatus (pagination.js).
 * Complexity: one seal and one PUT, then the attachments.
 */
async function overwriteRemote() {
  if (syncing || backupView || !lastSyncError || lastSyncError.kind !== "pwmismatch") {
    return;
  }
  const confirmed = await confirmModal({
    title: "Overwrite the remote vault?",
    body: "This permanently replaces the remote vault.enc with this browser's vault. The remote copy cannot be recovered afterwards.",
    confirmLabel: "Overwrite remote", destructive: true,
  });
  if (!confirmed || syncing || !lastSyncError || lastSyncError.kind !== "pwmismatch") {
    return;
  }
  const sha = lastSyncError.sha;
  closePanel();
  syncing = true;
  setEditingEnabled(false);
  $("sync").disabled = true;
  $("backup").disabled = true;
  $("sync").textContent = "Syncing...";
  status("Syncing...", false, true);
  try {
    await persistLocal();
    const sealed = await sealVault();
    const put = await (await gh("PUT", { message: "sync", content: btoa(sealed), sha })).json();
    await pushWrapper(sealed);
    markSynced(put.content && put.content.sha);
    const media = await syncMediaPhase(null);
    if (media.pulled || media.dropped) {
      renderAttachments();
    }
    status("Synced " + new Date().toLocaleTimeString() +
      (media.warn.length ? ` - ${media.warn.length} attachment(s) not transferred` : ""), media.warn.length > 0);
  } catch (error) {
    lastSyncError = classifySyncError(error);
    status(error.message, true);
  } finally {
    syncing = false;
    setEditingEnabled(true);
    $("sync").disabled = false;
    $("backup").disabled = false;
    $("sync").textContent = "Sync";
    renderStatus();
  }
}

// ---------- On load: the Sync and Backup buttons ----------

$("sync").onclick = () => runSync(null);

// Scoped syncs merge only these ids, both ways, and leave everything else as
// it is on both sides. The scope covers the id's presence in notes, trash and
// tombstones, so syncing one note the remote trashed or deleted cannot bring it back.
window.syncNote = id => runSync(scopeForNote(id));
window.syncFolder = fid => runSync(scopeForFolder(fid));

// An encrypted backup of the whole vault, sealed exactly like vault.enc, so
// the lock screen's file restore already accepts it. Attachments are not in
// it: they sync through the repository (a large video would not fit a text file).
$("backup").onclick = async () => {
  if (syncing || !vault) {
    return;
  }
  flushSave();
  const date = new Date();
  const pad = n => String(n).padStart(2, "0");
  const name = `notes-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.enc`;
  const url = URL.createObjectURL(new Blob([await sealVault()], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status("Backup saved: " + name);
};

// =================== Auxiliary functions ===================

/**
 * The attachment ids the given notes (live or in the trash) name: in their
 * media lists and inline on every page (an attachment only placed inline
 * must move too, or the other device shows "not on this device" forever).
 * Complexity: O(n) in those notes.
 */
function mediaIdsFor(vaultSide, ids) {
  const out = new Set();
  for (const id of ids) {
    const note = vaultSide.notes[id];
    if (note) {
      for (const item of (note.media || [])) {
        out.add(item.id);
      }
      for (const entry of noteBodies(note)) {
        if (entry.bodyV === 2) {
          for (const mid of bodyMediaIds(entry.body, 2)) {
            out.add(mid);
          }
        }
      }
    }
    const trashed = vaultSide.trash[id];
    if (trashed && trashed.data) {
      for (const item of (trashed.data.media || [])) {
        out.add(item.id);
      }
      for (const entry of noteBodies(trashed.data)) {
        if (entry.bodyV === 2) {
          for (const mid of bodyMediaIds(entry.body, 2)) {
            out.add(mid);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Uploads one file's bytes. A 422 means it already exists: an attachment's
 * bytes never change for its id (the id is bound into the AES-GCM associated
 * data), so the remote cannot disagree. Complexity: O(size).
 */
function putMediaFile(path, buf) {
  return gh("PUT", { message: "media", content: toBase64(buf) }, path).catch(error => {
    if (error.status !== 422) {
      throw error;
    }
  });
}
