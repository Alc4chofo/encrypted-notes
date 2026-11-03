// notes: Moving attachments to and from the repo.
"use strict";

// ---------- Media transfer ----------
// Every failure here is a per-file warning, never a sync failure: the vault
// blob is the thing that must stay consistent.
function mediaIdsFor(v, ids) {
  const out = new Set();
  for (const id of ids) {
    const n = v.notes[id];
    if (n) {
      for (const m of (n.media || [])) out.add(m.id);
      // Inline-only ids must join the upload/download set too, or a receiving device
      // shows a permanent "not on this device" that Sync could never resolve.
      // Every page, not just the first.
      for (const b of noteBodies(n)) if (b.bodyV === 2) for (const mid of bodyMediaIds(b.body, 2)) out.add(mid);
    }
    const t = v.trash[id];
    if (t && t.data) {
      for (const m of (t.data.media || [])) out.add(m.id);
      for (const b of noteBodies(t.data)) if (b.bodyV === 2) for (const mid of bodyMediaIds(b.body, 2)) out.add(mid);
    }
  }
  return out;
}

// 422 with no sha = the file already exists. Media bytes are immutable per id
// (the id is bound into the AES-GCM AAD), so the remote cannot disagree.
const putMediaFile = (path, buf) =>
  gh("PUT", { message: "media", content: b64(buf) }, path).catch(e => { if (e.status !== 422) throw e; });

async function putMedia(id) {
  const rec = await idbGet(id);
  if (!rec || !rec.bytes) return false;
  const total = rec.bytes.byteLength;
  if (total <= MEDIA_CHUNK) {
    await putMediaFile("media/" + id, rec.bytes);
  } else {
    // GitHub's workaround: parts first, manifest LAST - a torn upload leaves no
    // manifest, so mediaSynced stays unset and the next sync retries the whole set.
    const parts = Math.ceil(total / MEDIA_CHUNK);
    for (let i = 0; i < parts; i++) {
      status(`Uploading attachment (${i + 1}/${parts})...`, false, true);
      await putMediaFile(`media/${id}.p${i}`, rec.bytes.slice(i * MEDIA_CHUNK, Math.min(total, (i + 1) * MEDIA_CHUNK)));
    }
    await putMediaFile("media/" + id, enc(CHUNK_MAGIC + JSON.stringify({ parts, total })).buffer);
  }
  syncMeta.mediaSynced[id] = 1;
  return true;
}

async function getMedia(id) {
  const res = await ghRaw("media/" + id);
  if (res.status === 404) return false;   // keeps the placeholder tile, marks nothing
  let buf = await res.arrayBuffer();
  // A chunk manifest instead of ciphertext? Reassemble; any missing/short part
  // keeps the placeholder (return false), and the GCM tag over the whole
  // ciphertext still authenticates the reassembly end to end.
  if (new TextDecoder().decode(buf.slice(0, CHUNK_MAGIC.length)) === CHUNK_MAGIC) {
    let man = null;
    try { man = JSON.parse(new TextDecoder().decode(buf).slice(CHUNK_MAGIC.length)); } catch {}
    const parts = man && (man.parts | 0);
    // Bound by what this app could ever have written (MEDIA_MAX / MEDIA_CHUNK):
    // the manifest is plaintext and repo-controlled, so an unbounded part count
    // would be an attacker-chosen allocation and a long run of API calls.
    if (!(parts > 0 && parts <= Math.ceil(MEDIA_MAX / MEDIA_CHUNK) + 1)) return false;
    const bufs = [];
    for (let i = 0; i < parts; i++) {
      status(`Downloading attachment (${i + 1}/${parts})...`, false, true);
      const r = await ghRaw(`media/${id}.p${i}`);
      if (r.status === 404) return false;
      bufs.push(new Uint8Array(await r.arrayBuffer()));
    }
    const out = new Uint8Array(bufs.reduce((s, b) => s + b.length, 0));
    let off = 0;
    for (const b of bufs) { out.set(b, off); off += b.length; }
    buf = out.buffer;
  }
  if (buf.byteLength < MEDIA_MIN_LEN) return false;
  // AUTHENTICATE BEFORE COMMITTING. These bytes are repo-controlled, and both
  // the store and the mediaSynced latch are one-way: writing first would let a
  // single flipped byte replace the attachment with permanent garbage that this
  // device then refuses to re-fetch. A failed tag just leaves it "missing", and
  // the next sync retries.
  try { await decryptMedia(id, buf); }
  catch { return false; }
  await idbPut(id, buf);
  syncMeta.mediaSynced[id] = 1;           // pulled media must never be re-pushed
  return true;
}

async function deleteRemoteMedia(id) {
  const del = async path => {
    const r = await gh("GET", null, path);
    if (r.status === 404) return false;   // already gone counts as success
    const sha = (await r.json()).sha;
    await gh("DELETE", { message: "purge", sha }, path);
    return true;
  };
  await del("media/" + id);
  // Chunked parts: delete until the first gap (parts are always contiguous).
  for (let i = 0; i < 1024; i++) if (!await del(`media/${id}.p${i}`)) break;
  return true;
}

// -> { warn, pulled, dropped }. `pulled`/`dropped` count LOCAL byte changes, so
// the caller knows the attachments strip has to be repainted.
async function syncMediaPhase(scope) {
  const warn = [];
  let pulled = 0, dropped = 0;
  const wanted = mediaIdsFor(vault, scope ? [...scope.ids]
    : [...Object.keys(vault.notes), ...Object.keys(vault.trash)]);
  // Preset attachments ride along on a full sync: a preset can outlive the note
  // it came from, and its images must exist on every device that has it.
  if (!scope) for (const pid in (vault.presets || {})) {
    const p = vault.presets[pid];
    for (const m of (p.media || [])) wanted.add(m.id);
    for (const pg of (p.pages || [])) if (pg.bodyV === 2) for (const mid of bodyMediaIds(pg.body, 2)) wanted.add(mid);
  }
  let have;
  try { have = new Set(await idbKeys()); }
  catch { return { warn: ["IndexedDB unavailable, attachments not transferred"], pulled: 0, dropped: 0 }; }

  for (const id of wanted) {
    if (!have.has(id) || syncMeta.mediaSynced[id]) continue;
    status("Uploading attachment...", false, true);
    try { await putMedia(id); } catch (e) { warn.push("upload " + id.slice(0, 8) + ": " + e.message); }
  }
  for (const id of wanted) {
    if (have.has(id)) continue;
    status("Downloading attachment...", false, true);
    try { if (await getMedia(id)) { have.add(id); pulled++; } }
    catch (e) { warn.push("download " + id.slice(0, 8) + ": " + e.message); }
  }
  // Tombstoned bytes: retried on every sync while the tombstone lives.
  const purgedIds = scope ? [...scope.ids].filter(id => id in vault.purged) : Object.keys(vault.purged);
  for (const id of purgedIds) {
    const pushedHere = !!syncMeta.mediaSynced[id];
    if (!have.has(id) && !pushedHere) continue;   // not a media id this device ever held
    if (mediaReferenced(id)) continue;            // belt and braces; the merge already clears these
    if (pushedHere) {
      try { await deleteRemoteMedia(id); }
      catch (e) { warn.push("delete " + id.slice(0, 8) + ": " + e.message); continue; }
    }
    if (have.has(id)) {
      revokeMediaUrl(id);
      try { await idbDelete(id); } catch {}
      have.delete(id);
      dropped++;
    }
    delete syncMeta.mediaSynced[id];
  }
  saveSyncMeta();
  return { warn, pulled, dropped };
}

async function overwriteRemote() {
  // backupView: the loaded vault is a read-only snapshot, and this would PUT it
  // over the live repo (and delete remote media) - the exact "no sync while
  // viewing a backup" guarantee. Reachable there via the pull banner's Details
  // button, which opens the panel even though the chips are hidden.
  if (syncing || backupView || !lastSyncError || lastSyncError.kind !== "pwmismatch") return;
  const ok = await confirmModal({
    title: "Overwrite the remote vault?",
    body: "This permanently replaces the remote vault.enc with this browser's vault. The remote copy cannot be recovered afterwards.",
    confirmLabel: "Overwrite remote", destructive: true,
  });
  if (!ok || syncing || !lastSyncError || lastSyncError.kind !== "pwmismatch") return;
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
    // Push this vault's attachments too; the remote copy we just replaced may
    // have referenced media ids this device never held.
    const media = await syncMediaPhase(null);
    if (media.pulled || media.dropped) renderAttachments();
    status("Synced " + new Date().toLocaleTimeString() +
      (media.warn.length ? ` - ${media.warn.length} attachment(s) not transferred` : ""), media.warn.length > 0);
  } catch (e) {
    lastSyncError = classifySyncError(e);
    status(e.message, true);
  } finally {
    syncing = false;
    setEditingEnabled(true);
    $("sync").disabled = false;
    $("backup").disabled = false;
    $("sync").textContent = "Sync";
    renderStatus();
  }
}

// One pass: GET, merge, apply locally, PUT, move the media, update syncMeta.
// Returns "blocked" when it deliberately stopped (password mismatch, user
// cancel) so the caller neither retries nor reports an error.
async function syncOnce(scope) {
  const res = await gh("GET");
  let sha, remote = null, fast = false;
  if (res.status === 200) {
    const meta = await res.json();
    sha = meta.sha;
    // sha fast path (syncAll only): the remote is byte-identical to what this
    // device last synced, so only local changes can exist and no decrypt or
    // merge is needed. A SCOPED sync can never take it - it must rebuild the
    // pushed blob from the remote vault, which a sha cannot give it.
    fast = !scope && !!meta.sha && meta.sha === syncMeta.remoteSha;
    if (!fast) {
      // content is "" for any file over 1MB: fall back to the raw media type.
      const text = meta.content ? atob(meta.content.replace(/\n/g, ""))
        : await (await ghRaw(FILE)).text();
      let opened;
      try {
        // masterPw, not the DOM input: the remote blob may use a different
        // salt/iter (e.g. still 310k) and the password field is cleared at unlock.
        opened = await openVault(text, masterPw);
      } catch {
        // Never push over a vault we cannot read: it may belong to another
        // password or machine. Abort; overwrite only via the explicit button.
        lastSyncError = { at: Date.now(), httpStatus: null, kind: "pwmismatch",
          raw: "Remote vault.enc could not be decrypted with this master password.", sha };
        status("Sync blocked: remote password mismatch", true);
        renderStatus();
        return "blocked";
      }
      remote = opened.vault;   // openVault migrates v1 -> v2, so the merge never sees undefined maps
    }
  } else if (scope) {
    scope = null;   // no remote vault yet: a scoped sync must not PUT a one-note vault
  }

  let info = null, pushed = vault, remoteChanged = true, exclude = null;
  if (remote) {
    if (scope) augmentScope(scope, remote);
    exclude = await staleDeviceExclusions(remote, scope);
    info = await mergeVaults(vault, remote, scope, exclude);
    // Conflict copies are pushed with this scope, so they belong to it.
    if (scope) for (const id of info.newIds) scope.ids.add(id);
    if (info.risky.length) {
      // The only case where local work would go without a conflict copy.
      // Awaited inside the try: `syncing` stays true and editing stays frozen.
      const go = await confirmModal({
        title: "Merge will replace unsynced local edits",
        body: `${info.risky.length} note(s) edited here but never synced will be replaced by the ` +
          `repo's version: ${info.risky.slice(0, 5).join(", ")}. A pre-merge snapshot is kept either way.`,
        confirmLabel: "Merge anyway", destructive: true,
      });
      if (!go) { status("Sync cancelled"); return "blocked"; }
    }
    pushed = info.pushed;
    remoteChanged = info.remoteChanged;
    // A media tombstone the merge dropped (a surviving note still references it)
    // means the file may be gone from the repo while this device still believes
    // it uploaded it. Forget that, so the media phase re-uploads from whichever
    // device still holds the bytes.
    for (const mid of info.resurrectedMedia) delete syncMeta.mediaSynced[mid];
    if (info.localChanged) await applyMerge(info, remote);
  } else {
    // Fast path / first push: local IS the merged state.
    remoteChanged = !(fast && !dirty && !anyUnsynced() && syncMeta.lastSyncedAt !== null &&
      (vault.savedAt || 0) <= (syncMeta.syncedSavedAt || 0));
  }

  let putSha = sha;
  if (remoteChanged) {
    let sealed;
    if (pushed === vault) { await persistLocal(); sealed = await sealVault(); }
    else {
      // Every real PUT stamps savedAt: a not-yet-upgraded copy of the app
      // still decides pull-vs-push by savedAt, and an unstamped push would let
      // it shove its stale whole blob over the merged remote.
      pushed.savedAt = Date.now();
      sealed = await sealObject(pushed);
    }
    const put = await (await gh("PUT", { message: "sync", content: btoa(sealed), sha })).json();
    putSha = put.content && put.content.sha;
    await pushWrapper(sealed);
  }

  const media = await syncMediaPhase(scope);
  // Bytes arriving (or being purged) change what the strip can show, and the
  // merge may not have touched the vault at all, so repaint here too.
  if (media.pulled || media.dropped) renderAttachments();

  // Only now: a pull-only merge must still mark everything synced or the
  // Unsynced chip sticks forever.
  if (scope) markScopedSynced(scope, putSha, info ? info.outOfScopeDiverged : true);
  else markSynced(putSha);

  // Notes the stale-device guard skipped were NOT pushed, so they must keep
  // reading as unsynced (dot lit) even though they are still in the vault.
  if (exclude && exclude.size) {
    for (const id of exclude) { delete syncMeta.noteMtimes[id]; delete syncMeta.folderMtimes[id]; }
    saveSyncMeta();
    renderList();
    renderStatus();
  }

  const bits = [];
  const quiet = !remoteChanged && !(info && info.localChanged) && !media.pulled && !media.dropped;
  if (quiet) bits.push("Already up to date");
  else bits.push((scope ? "Synced this " + scope.label : "Synced") + " " + new Date().toLocaleTimeString());
  if (info && info.localDelta) bits.push(`${info.localDelta} change(s) merged in`);
  if (info && info.conflicts.length) bits.push(`${info.conflicts.length} conflict copy/copies kept`);
  if (media.pulled) bits.push(`${media.pulled} attachment(s) fetched`);
  if (media.warn.length) bits.push(`${media.warn.length} attachment(s) not transferred`);
  status(bits.join(" - "), media.warn.length > 0);
  return "ok";
}

// Shared driver for the Sync button, "Sync this note" and "Sync folder": same
// freeze, same error classification, same chips.
// Per-run, not per-attempt: a 409 retry re-enters applyMerge, and without this
// the second pass would overwrite the genuine pre-merge snapshot with the
// already-merged vault from the first pass.
let snapshotTakenThisRun = false;

async function runSync(scope) {
  if (syncing || backupView) return;   // a backup view must never talk to the repo
  syncing = true;
  snapshotTakenThisRun = false;
  clearTimeout(saveTimer);
  // A pending reflow would fire mid-merge and write the pre-merge sheets back
  // over the merged note.
  clearTimeout(repagTimer);
  saveCurrent();          // flushSave equivalent: commit the buffer before reading the vault
  // Freshly expired trash is purged before the merge so the tombstones travel
  // with this sync instead of waiting for the next unlock.
  if (autoPurgeTrash()) await persistLocal();
  setEditingEnabled(false);
  $("sync").disabled = true;
  $("backup").disabled = true;
  $("sync").textContent = "Syncing...";
  status(scope ? `Syncing this ${scope.label}...` : "Syncing...", false, true);
  let result = null;
  try {
    for (let attempt = 1; ; attempt++) {
      try { result = await syncOnce(scope); break; }
      catch (e) {
        // 409: someone pushed between our GET and our PUT. Re-run the WHOLE
        // sync (fresh GET, fresh merge, fresh seal) - never re-PUT the old body
        // with a refreshed sha, or their changes would be overwritten.
        if (e && e.status === 409 && attempt < 2) {
          status("Remote changed, merging again...", false, true);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    // Failure leaves syncMeta and Last synced untouched: the old timestamp is
    // the honest reading, and the Unsynced chip stays lit.
    lastSyncError = classifySyncError(e);
    status(e.message, true);
    renderStatus();
  } finally {
    syncing = false;
    setEditingEnabled(true);
    $("sync").disabled = false;
    $("backup").disabled = false;
    $("sync").textContent = "Sync";
    renderStatus();
  }
  // A full Sync also brings the app itself up to date (App updates). After the
  // notes and outside the freeze: the question waits for an answer, and the
  // notes are synced whatever it is.
  if (!scope && result === "ok" && !backupView) await appUpdateStep();
}

$("sync").onclick = () => runSync(null);
// Scoped: merge ONLY these ids in both directions and leave everything else
// exactly as it is on both sides.
// The scope is the id's presence across notes, trash AND purged, so per-note
// sync of a remotely-trashed or remotely-purged note cannot resurrect it.
window.syncNote = id => runSync(scopeForNote(id));
window.syncFolder = fid => runSync(scopeForFolder(fid));

// Encrypted backup of the whole vault, sealed exactly like vault.enc, so the
// existing file-picker restore path already accepts it. Media is NOT included:
// it syncs through the repo (a 40MB video per file would not fit a text blob).
$("backup").onclick = async () => {
  if (syncing || !vault) return;
  flushSave();
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const name = `notes-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.enc`;
  const url = URL.createObjectURL(new Blob([await sealVault()], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status("Backup saved: " + name);
};
