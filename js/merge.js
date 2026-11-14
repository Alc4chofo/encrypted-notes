/*
 * merge.js - the merge engine: joining this device's vault with the one in
 * the repository so that no note is ever lost, and applying the result.
 *
 * Every note, trashed note, permanent-delete tombstone and folder is merged
 * by id, both ways at once: mergeVaults returns what this device must take
 * and the exact blob to push. The rules, in order: the same content keeps
 * the newer stamp; without a known base (a restored backup, a second
 * device's first sync) the newer wins; versions that differ only in order,
 * or in order and colour or folder, merge instead of forking; a real
 * conflict (both changed since the base) keeps both, the loser as a
 * "(conflict ...)" copy; a newer trash beats an older live note and the
 * other way round; a tombstone kills what is older than it and deletes
 * itself when something newer survives (which is what lets "restore from
 * trash" beat a delete made on another device).
 *
 * Both devices must reach the same result without talking to each other, so
 * every choice is deterministic: ties are broken by SHA-256 of the note,
 * conflict copies get an id derived by SHA-256 (never random) and a title
 * stamped in UTC with fixed month names. SHA-256 here is not for secrecy; it
 * is a fixed function both sides compute alike (about 0.7 ms per 500 KB).
 * Sealed bytes are never compared: a fresh random IV makes two seals of the
 * same vault differ every time.
 *
 * Main functions: mergeVaults, resolveConflict, applyMerge,
 * staleDeviceExclusions, scopeForNote, scopeForFolder, augmentScope,
 * computeOutOfScopeDiverged.
 * Auxiliary functions: canonicalJson, noteKey, contentKey, textKey,
 * orderWinner, mergedOrder, pickMax, setOrDelete, countDiff, sha256Hex,
 * conflictStamp, scopeAddNote.
 *
 * Complexity: a merge is O(n * s) over the ids and the size of each note
 * (each is serialised to compare it), plus one SHA-256 per tie.
 */
"use strict";

// ---------- State ----------

// Month names for conflict titles, fixed so both devices write the same title.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- Merging ----------

/**
 * Merges the local vault with the remote one and returns info: info.local
 * (the maps this device must take), info.pushed (the blob to PUT: the remote
 * vault with only the entries in scope replaced; it must never be rebuilt
 * from the local vault, or a scoped sync would wipe everything else in the
 * repository), what changed for the user (lost, replaced, added, conflicts),
 * the "risky" list the confirm dialog is built from (unsynced local work a
 * merge would drop), the ids of new conflict copies, attachments whose
 * tombstone was lifted, the merged attachment key ring, and whether
 * anything changed locally or remotely (counted per id, never from bytes).
 * scope is null for everything, or { ids, folders } for one note or folder;
 * exclude holds ids to leave alone on both sides (a device offline too long).
 * Presets and pins are merged per id (newer wins), separately from the notes,
 * so a pin never decides which version of a note survives. The token: local
 * wins, remote fills in (a vault restored from a token-less backup takes the
 * token back instead of pushing an empty one over it). The attachment key
 * ring: both sides converge on the same primary key (the smallest) and keep
 * every other, so attachments sealed under any of them stay readable.
 *
 * Used by: media-sync.js (syncOnce).
 * Uses: pickMax, noteKey, contentKey, textKey, orderWinner, mergedOrder,
 * resolveConflict, setOrDelete, countDiff,
 * computeOutOfScopeDiverged, syncMeta (core.js).
 * Complexity: O(n * s) over the ids and the notes' sizes.
 */
async function mergeVaults(local, remote, scope, exclude) {
  const localNotes = { ...local.notes };
  const localFolders = { ...local.folders };
  const localTrash = { ...local.trash };
  const localPurged = { ...local.purged };
  const remoteNotes = { ...remote.notes };
  const remoteFolders = { ...remote.folders };
  const remoteTrash = { ...remote.trash };
  const remotePurged = { ...remote.purged };
  const info = { lost: [], replaced: [], added: [], conflicts: [], risky: [], newIds: [],
    resurrectedMedia: [], outOfScopeDiverged: false };

  const folderIds = new Set([...Object.keys(local.folders), ...Object.keys(remote.folders)]);
  let ids;
  if (scope) {
    ids = new Set(scope.ids);
  } else {
    ids = new Set([...Object.keys(local.notes), ...Object.keys(remote.notes),
      ...Object.keys(local.trash), ...Object.keys(remote.trash),
      ...Object.keys(local.purged), ...Object.keys(remote.purged)]);
    // Folder ids are resolved in the folder pass.
    for (const folderId of folderIds) {
      ids.delete(folderId);
    }
  }
  const folderScope = scope ? new Set(scope.folders) : folderIds;

  // Notes, trash and tombstones, id by id.
  for (const id of ids) {
    // A device offline too long: both sides are left alone.
    if (exclude && exclude.has(id)) {
      continue;
    }
    const localNote = local.notes[id];
    const remoteNote = remote.notes[id];
    const localTrashed = local.trash[id];
    const remoteTrashed = remote.trash[id];
    const base = syncMeta.noteMtimes[id];
    let tombstone = pickMax(local.purged[id], remote.purged[id]);
    let live = null;
    let copy = null;
    let cid = null;

    if (localNote && remoteNote) {
      if (noteKey(localNote) === noteKey(remoteNote)) {
        // The same content: the newer stamp is kept.
        live = (remoteNote.mtime || 0) > (localNote.mtime || 0) ? remoteNote : localNote;
      } else if (base === undefined) {
        // No base (a restored backup, a second device's first sync, cleared
        // storage): the newer wins, never a conflict copy, or a copy of every
        // note would come out of each restore. vault.prev is the safety net.
        live = (remoteNote.mtime || 0) > (localNote.mtime || 0) ? remoteNote : localNote;
      } else if (contentKey(localNote) === contentKey(remoteNote)) {
        // They differ only in order (a reorder on one device or both, or a
        // one-time seed): one deterministic winner instead of a fork.
        live = orderWinner(localNote, remoteNote);
      } else if (textKey(localNote) === textKey(remoteNote)) {
        // The same text and attachments, with a different order and colour or
        // folder: a reorder racing a recolour is no real conflict either. The
        // newer carries its colour and folder, the order winner its place.
        const winner = (remoteNote.mtime || 0) > (localNote.mtime || 0) ? remoteNote : localNote;
        live = { ...winner, order: mergedOrder(localNote, remoteNote) };
      } else if (((localNote.mtime || 0) > base && (remoteNote.mtime || 0) > base) ||
        (localNote.mtime || 0) === (remoteNote.mtime || 0)) {
        // Both changed since the base and their text or attachments differ: a
        // real conflict, so both are kept. The merge remembers only when a
        // note last synced, not what it said then, so it cannot tell a text
        // edit from a reorder or a move (all three stamp the note). Keeping
        // only the newer here once dropped the other device's text.
        const resolved = await resolveConflict(id, localNote, remoteNote);
        live = resolved.winner;
        copy = resolved.copy;
        cid = resolved.cid;
      } else {
        live = (remoteNote.mtime || 0) > (localNote.mtime || 0) ? remoteNote : localNote;
      }
    } else {
      live = localNote || remoteNote || null;
    }

    // Trash: the union by id, the newer deletedAt wins.
    let trashed = (localTrashed && remoteTrashed)
      ? ((remoteTrashed.deletedAt || 0) > (localTrashed.deletedAt || 0) ? remoteTrashed : localTrashed)
      : (localTrashed || remoteTrashed || null);

    // Trash against live, and the loser cleaned up on both sides so it cannot come back.
    if (live && trashed) {
      const liveMtime = live.mtime || 0;
      const deletedAt = trashed.deletedAt || 0;
      if (liveMtime > deletedAt) {
        trashed = null;
      } else {
        // The newer note goes inside the trash entry, so a live edit made
        // meanwhile is kept rather than dropped.
        const inner = (trashed.data && (trashed.data.mtime || 0) >= liveMtime) ? trashed.data : live;
        trashed = { data: inner, deletedAt };
        live = null;
        // No point making a conflict copy of a note in the bin.
        copy = null;
        cid = null;
      }
    }

    // One tombstone rule, which cleans itself up: a survivor deletes its own
    // tombstone, so it cannot be killed again on a later sync or a third device.
    if (tombstone != null) {
      if (live) {
        if (tombstone >= (live.mtime || 0)) {
          live = null;
        } else {
          tombstone = null;
        }
      } else if (trashed) {
        if (tombstone >= (trashed.deletedAt || 0)) {
          trashed = null;
        } else {
          tombstone = null;
        }
      }
    }

    setOrDelete(localNotes, id, live);
    setOrDelete(localTrash, id, trashed);
    setOrDelete(localPurged, id, tombstone);
    setOrDelete(remoteNotes, id, live);
    setOrDelete(remoteTrash, id, trashed);
    setOrDelete(remotePurged, id, tombstone);
    if (copy && cid) {
      if (!local.notes[cid]) {
        localNotes[cid] = copy;
      }
      if (!remote.notes[cid]) {
        remoteNotes[cid] = copy;
      }
      info.conflicts.push(copy.title);
      // A scoped sync must record its base too, or it shows a false unsynced dot.
      info.newIds.push(cid);
    }

    // What changed for the user, and the risky list.
    const titleOf = note => (note && note.title) || "(untitled)";
    if (localNote && !live && !trashed) {
      info.lost.push(titleOf(localNote));
    } else if (localNote && live && noteKey(live) !== noteKey(localNote)) {
      info.replaced.push(titleOf(localNote));
    } else if (!localNote && live) {
      info.added.push(titleOf(live));
    }
    if (localNote && !copy) {
      const wasUnsynced = !(id in syncMeta.noteMtimes) || (localNote.mtime || 0) > syncMeta.noteMtimes[id];
      const keptInTrash = trashed && trashed.data && noteKey(trashed.data) === noteKey(localNote);
      if (wasUnsynced && !keptInTrash && (!live || noteKey(live) !== noteKey(localNote))) {
        info.risky.push(titleOf(localNote));
      }
    }
  }

  // Folders: the newer wins, and tombstones work as for notes.
  for (const folderId of folderScope) {
    if (exclude && exclude.has(folderId)) {
      continue;
    }
    const localFolder = local.folders[folderId];
    const remoteFolder = remote.folders[folderId];
    let tombstone = pickMax(local.purged[folderId], remote.purged[folderId]);
    let folder = (localFolder && remoteFolder)
      ? ((remoteFolder.mtime || 0) > (localFolder.mtime || 0) ? remoteFolder : localFolder)
      : (localFolder || remoteFolder || null);
    if (tombstone != null && folder) {
      if (tombstone >= (folder.mtime || 0)) {
        folder = null;
      } else {
        tombstone = null;
      }
    }
    setOrDelete(localFolders, folderId, folder);
    setOrDelete(localPurged, folderId, tombstone);
    setOrDelete(remoteFolders, folderId, folder);
    setOrDelete(remotePurged, folderId, tombstone);
  }

  // An attachment's tombstone is lifted while anything still names it (a
  // conflict copy shares attachments with its original): with no data loss
  // as the rule, the reference wins over the delete. A scoped sync only lifts
  // tombstones it owns, or it would change the pushed blob outside its scope.
  const refs = new Set();
  const addRefs = (notes, trash) => {
    for (const key in notes) {
      for (const item of (notes[key].media || [])) {
        refs.add(item.id);
      }
    }
    for (const key in trash) {
      const data = trash[key].data;
      if (data) {
        for (const item of (data.media || [])) {
          refs.add(item.id);
        }
      }
    }
  };
  addRefs(localNotes, localTrash);
  addRefs(remoteNotes, remoteTrash);
  const inScope = id => !exclude || !exclude.has(id);
  for (const id in localPurged) {
    if (refs.has(id) && inScope(id)) {
      delete localPurged[id];
      info.resurrectedMedia.push(id);
    }
  }
  for (const id in remotePurged) {
    if (refs.has(id) && inScope(id)) {
      delete remotePurged[id];
      info.resurrectedMedia.push(id);
    }
  }

  const token = local.token || remote.token || null;

  const keySet = new Set([...(local.mediaKeysOld || []), ...(remote.mediaKeysOld || [])]);
  if (local.mediaKey) {
    keySet.add(local.mediaKey);
  }
  if (remote.mediaKey) {
    keySet.add(remote.mediaKey);
  }
  const allKeys = [...keySet].sort();
  const primaryKey = allKeys[0] || null;
  const oldKeys = allKeys.slice(1);
  info.mediaKey = primaryKey;
  info.mediaKeysOld = oldKeys;

  // Presets and pins must be listed here: info.local is built field by field,
  // so anything left out would be dropped from this device on the next sync.
  const presets = {};
  for (const pid of new Set([...Object.keys(local.presets || {}), ...Object.keys(remote.presets || {})])) {
    const localPreset = (local.presets || {})[pid];
    const remotePreset = (remote.presets || {})[pid];
    presets[pid] = (localPreset && remotePreset)
      ? ((remotePreset.mtime || 0) > (localPreset.mtime || 0) ? remotePreset : localPreset)
      : (localPreset || remotePreset);
  }
  // For pins the newer change, pin or unpin (by its "at"), wins.
  const pins = {};
  for (const id of new Set([...Object.keys(local.pins || {}), ...Object.keys(remote.pins || {})])) {
    const localPin = (local.pins || {})[id];
    const remotePin = (remote.pins || {})[id];
    if (localPin && remotePin) {
      pins[id] = (remotePin.at || 0) > (localPin.at || 0) ? remotePin : localPin;
    } else {
      pins[id] = localPin || remotePin;
    }
  }

  info.local = { notes: localNotes, folders: localFolders, trash: localTrash, purged: localPurged, presets, pins, token,
    mediaKey: primaryKey, mediaKeysOld: oldKeys };
  info.pushed = { ...remote, v: 2, notes: remoteNotes, folders: remoteFolders, trash: remoteTrash, purged: remotePurged,
    presets, pins, token, mediaKey: primaryKey, mediaKeysOld: oldKeys };

  // "Changed nothing remotely" is counted per id, never from bytes. A pin
  // made here must still be pushed, and one made elsewhere applied here.
  const keyRingDiff = vaultSide => (vaultSide.mediaKey || null) !== primaryKey ||
    (vaultSide.mediaKeysOld || []).length !== oldKeys.length;
  info.remoteChanged = countDiff(remoteNotes, remote.notes) + countDiff(remoteFolders, remote.folders) +
    countDiff(remoteTrash, remote.trash) + countDiff(remotePurged, remote.purged) > 0 ||
    countDiff(pins, remote.pins || {}) > 0 ||
    (remote.token || null) !== token || keyRingDiff(remote);
  info.localDelta = countDiff(localNotes, local.notes) + countDiff(localFolders, local.folders) +
    countDiff(localTrash, local.trash);
  info.localChanged = info.localDelta > 0 || countDiff(localPurged, local.purged) > 0 ||
    countDiff(pins, local.pins || {}) > 0 ||
    (local.token || null) !== token || keyRingDiff(local);
  if (scope) {
    info.outOfScopeDiverged = computeOutOfScopeDiverged(local, remote, scope);
  }
  return info;
}

/**
 * Resolves a real conflict the same way on both devices, whatever order the
 * versions come in: the newer mtime wins, a tie is broken by the larger
 * SHA-256 of noteKey (the same key the difference was found with, which
 * covers colour and folder: hashing less once made two versions differing
 * only in colour look identical, and one side's change vanished). The loser
 * becomes a copy with its body, attachments, folder, colour and mtime
 * unchanged; only its title gains " (conflict <its own mtime>)", never the
 * current time. The copy's id is derived (never random), so both devices
 * make the same id and the union keeps one copy instead of forking twice.
 * Returns { winner, loser, copy, cid }, with no copy when they hash the same.
 *
 * Used by: this file (mergeVaults).
 * Uses: sha256Hex, noteKey, conflictStamp.
 * Complexity: O(s) in the notes' size (SHA-256, about 0.7 ms per 500 KB).
 */
async function resolveConflict(id, a, b) {
  const aMtime = a.mtime || 0;
  const bMtime = b.mtime || 0;
  let winner;
  let loser;
  if (aMtime !== bMtime) {
    winner = aMtime > bMtime ? a : b;
    loser = aMtime > bMtime ? b : a;
  } else {
    const hashA = await sha256Hex(noteKey(a));
    const hashB = await sha256Hex(noteKey(b));
    if (hashA === hashB) {
      return { winner: aMtime >= bMtime ? a : b, copy: null, cid: null };
    }
    winner = hashA > hashB ? a : b;
    loser = hashA > hashB ? b : a;
  }
  const cid = "c-" + (await sha256Hex(id + ":" + (loser.mtime || 0) + ":" + (winner.mtime || 0))).slice(0, 16);
  const copy = { ...loser, media: (loser.media || []).map(item => ({ ...item })) };
  copy.title = (loser.title || "") + " (conflict " + conflictStamp(loser.mtime || 0) + ")";
  return { winner, loser, copy, cid };
}

/**
 * Applies a merge to the app. Order matters: snapshot, apply and save, then
 * (in the caller) the PUT, and only then syncMeta moves on. A crash between
 * applying and syncMeta is safe: noteMtimes did not move, so everything
 * still reads as unsynced and the next sync merges again to the same result.
 *   1. The vault as it was is sealed into vault.prev (AES-256-GCM, about
 *      20 ms per 500 KB) when the merge drops or replaces local notes, when
 *      this device has unsynced work, or when there is no snapshot yet: a
 *      pull that deletes notes is exactly what "Restore" is for. Once per
 *      run, so a retry after a 409 never overwrites the real earlier state.
 *   2. Decrypted attachment addresses are revoked (they belong to the old
 *      vault) and the merged maps, pins, token and key ring are taken.
 *   3. The open note (or trashed note) is shown again in its merged shape,
 *      as openNote would (a note turned into pages elsewhere, shown here in
 *      the one-page editor from its old body, had that body saved over its
 *      first page by the next key), or closed when it is gone.
 *   4. The vault is saved, and a banner names what was lost or replaced.
 *
 * Used by: media-sync.js (syncOnce).
 * Uses: snapshotTakenThisRun (media-sync.js), anyUnsynced, revokeAllMediaUrls,
 * loadMediaKey and persistLocal (vault.js), sealVault and vaultStorageKey
 * (core.js), isPaged, notePages and renderPageTabs (content.js),
 * renderSheets, sheetsSnapshot and setEditorBody (lines.js), clearEditor,
 * applyReadonly and renderStatus (pagination.js), renderList (sidebar.js),
 * renderAttachments (attachments.js).
 * Complexity: O(n) in the vault, plus one seal.
 */
async function applyMerge(info, remote) {
  if (!snapshotTakenThisRun &&
      (anyUnsynced() || info.lost.length || info.replaced.length || !localStorage.getItem(vaultStorageKey("vault.prev")))) {
    localStorage.setItem(vaultStorageKey("vault.prev"), await sealVault());
    localStorage.setItem(vaultStorageKey("vault.prevAt"), String(vault.savedAt || 0));
    snapshotTakenThisRun = true;
  }
  revokeAllMediaUrls();
  vault.notes = info.local.notes;
  vault.folders = info.local.folders;
  vault.trash = info.local.trash;
  vault.purged = info.local.purged;
  vault.presets = info.local.presets || vault.presets || {};
  vault.pins = info.local.pins || vault.pins || {};
  vault.token = info.local.token || vault.token;
  vault.v = 2;
  // The merged key ring is taken before anything tries to decrypt pulled attachments.
  if (info.local.mediaKey) {
    vault.mediaKey = info.local.mediaKey;
    vault.mediaKeysOld = info.local.mediaKeysOld;
    await loadMediaKey();
  }

  const reseat = note => {
    if (isPaged(note)) {
      currentPage = Math.min(currentPage, Math.max(0, notePages(note).length - 1));
      renderSheets();
      editorBaseline = sheetsSnapshot();
    } else {
      document.body.classList.remove("paged-view");
      $("sheets").innerHTML = "";
      currentPage = 0;
      setEditorBody(note.body, { bodyV: note.bodyV });
    }
    renderPageTabs();
  };
  if (currentId && !vault.notes[currentId]) {
    currentId = null;
    $("title").value = "";
    clearEditor();
    document.body.classList.remove("paged-view");
    $("sheets").innerHTML = "";
    renderPageTabs();
  } else if (currentId) {
    $("title").value = vault.notes[currentId].title;
    reseat(vault.notes[currentId]);
  }
  if (trashViewId && !vault.trash[trashViewId]) {
    trashViewId = null;
    $("title").value = "";
    clearEditor();
    document.body.classList.remove("paged-view");
    $("sheets").innerHTML = "";
    renderPageTabs();
  } else if (trashViewId) {
    const snapshot = vault.trash[trashViewId].data || {};
    $("title").value = snapshot.title || "";
    reseat(snapshot);
  }
  applyReadonly();
  unsavedEdits = false;
  await persistLocal();
  if (info.lost.length || info.replaced.length) {
    pullDiff = { lost: info.lost, replaced: info.replaced, added: info.added, conflicts: info.conflicts };
    pullBanner = { at: Date.now(), remoteSavedAt: remote.savedAt || 0,
      lost: info.lost.length, replaced: info.replaced.length, added: info.added.length };
    localStorage.setItem(vaultStorageKey("pullBanner"), JSON.stringify(pullBanner));
  }
  renderList();
  renderStatus();
  renderAttachments();
}

/**
 * For a device offline longer than the tombstone window (90 days): its notes
 * the repository has no trace of may be notes deleted for good elsewhere
 * (their tombstones were pruned), which pushing would bring back. It asks
 * once per run; the ids skipped are left alone here and kept out of the
 * push. Returns that set, or null.
 *
 * Used by: media-sync.js (syncOnce).
 * Uses: syncMeta (core.js), confirmModal (modal.js).
 * Complexity: O(n) over the notes.
 */
async function staleDeviceExclusions(remote, scope) {
  const lastSynced = syncMeta.lastSyncedAt;
  if (lastSynced == null || Date.now() - lastSynced < 90 * 86400e3) {
    return null;
  }
  const candidates = Object.keys(vault.notes).filter(id =>
    (!scope || scope.ids.has(id)) && !remote.notes[id] && !remote.trash[id] && !(id in remote.purged));
  if (!candidates.length) {
    return null;
  }
  const push = await confirmModal({
    title: "Push old local notes?",
    body: `${candidates.length} note(s) on this device were deleted from the vault more than 90 days ago ` +
      `OR were never synced. Push them back into the repo?`,
    confirmLabel: "Push them", cancelLabel: "Skip them",
  });
  return push ? null : new Set(candidates);
}

// ---------- Scopes: syncing one note or one folder ----------

/**
 * The scope for syncing one note: its id and the ids of its attachments,
 * which share the notes' keyspace (trash and tombstones too).
 *
 * Used by: media-sync.js (syncNote, on load).
 * Uses: scopeAddNote.
 * Complexity: O(m) in its attachments.
 */
function scopeForNote(id) {
  const scope = { ids: new Set(), folders: new Set(), label: "note" };
  scopeAddNote(scope, vault, id);
  return scope;
}

/**
 * The scope for syncing a folder: its whole subtree (syncing a parent
 * without its children would push a vault where the child folders look
 * deleted here) and every note and trashed note in it.
 *
 * Used by: media-sync.js (syncFolder, on load).
 * Uses: parentOf (sidebar.js), scopeAddNote.
 * Complexity: O(f^2 + n) over the folders and notes.
 */
function scopeForFolder(folderId) {
  const subtree = new Set([folderId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const id in vault.folders) {
      if (!subtree.has(id) && subtree.has(parentOf(id))) {
        subtree.add(id);
        grew = true;
      }
    }
  }
  const scope = { ids: new Set(), folders: subtree, label: "folder", folderScan: subtree };
  for (const id in vault.notes) {
    if (subtree.has(vault.notes[id].folderId)) {
      scopeAddNote(scope, vault, id);
    }
  }
  for (const id in vault.trash) {
    const data = vault.trash[id].data;
    if (data && subtree.has(data.folderId)) {
      scopeAddNote(scope, vault, id);
    }
  }
  return scope;
}

/**
 * Widens a scope with what the remote vault knows: attachments only the
 * remote copy has, and for a folder the subfolders created or moved
 * elsewhere (followed along the remote's parent links until nothing new
 * appears) and their notes. Without it, syncing one note the remote has
 * trashed or deleted brings it back and leaves half its attachments behind,
 * and a folder sync silently skips subfolders it has never seen.
 *
 * Used by: media-sync.js (syncOnce).
 * Uses: scopeAddNote.
 * Complexity: O(f^2 + n) over the remote's folders and notes.
 */
function augmentScope(scope, remote) {
  for (const id of [...scope.ids]) {
    scopeAddNote(scope, remote, id);
  }
  if (scope.folderScan) {
    // The same Set as scope.folders.
    const subtree = scope.folderScan;
    for (let grew = true; grew;) {
      grew = false;
      for (const id in remote.folders) {
        const parent = remote.folders[id].parentId;
        if (!subtree.has(id) && parent && subtree.has(parent)) {
          subtree.add(id);
          grew = true;
        }
      }
    }
    for (const id in remote.notes) {
      if (subtree.has(remote.notes[id].folderId)) {
        scopeAddNote(scope, remote, id);
      }
    }
    for (const id in remote.trash) {
      const data = remote.trash[id].data;
      if (data && subtree.has(data.folderId)) {
        scopeAddNote(scope, remote, id);
      }
    }
    for (const id of [...scope.ids]) {
      scopeAddNote(scope, vault, id);
    }
  }
}

/**
 * Whether the remote holds anything outside the scope this device has not
 * seen (or this device holds anything the remote lacks). If so, a scoped
 * push must not record the remote's sha, or the "unchanged sha" shortcut
 * would hide those changes forever.
 *
 * Used by: this file (mergeVaults).
 * Uses: syncMeta (core.js).
 * Complexity: O(n) over both vaults.
 */
function computeOutOfScopeDiverged(local, remote, scope) {
  const inNoteScope = id => scope.ids.has(id);
  const inFolderScope = id => scope.folders.has(id);
  for (const id in remote.notes) {
    if (!inNoteScope(id) && syncMeta.noteMtimes[id] !== remote.notes[id].mtime) {
      return true;
    }
  }
  for (const id in local.notes) {
    if (!inNoteScope(id) && !remote.notes[id]) {
      return true;
    }
  }
  for (const id in remote.trash) {
    if (!inNoteScope(id) && syncMeta.trashSeen[id] !== remote.trash[id].deletedAt) {
      return true;
    }
  }
  for (const id in local.trash) {
    if (!inNoteScope(id) && !remote.trash[id]) {
      return true;
    }
  }
  for (const id in remote.folders) {
    if (!inFolderScope(id) && syncMeta.folderMtimes[id] !== remote.folders[id].mtime) {
      return true;
    }
  }
  for (const id in local.folders) {
    if (!inFolderScope(id) && !remote.folders[id]) {
      return true;
    }
  }
  for (const id in remote.purged) {
    if (!inNoteScope(id) && !inFolderScope(id) && !(id in local.purged)) {
      return true;
    }
  }
  for (const id in local.purged) {
    if (!inNoteScope(id) && !inFolderScope(id) && !(id in remote.purged)) {
      return true;
    }
  }
  return false;
}

// =================== Auxiliary functions ===================

/** A value as JSON with object keys sorted, so equal structures give equal strings. Complexity: O(s log k). */
function canonicalJson(value) {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

/**
 * What "the content differs" means for a note: everything but mtime. order
 * is added only when it is a number, so a note never reordered gives the same
 * key on a device upgraded and one not yet (no mass fork on the first sync
 * across versions). bodyV is left out: it always travels with an HTML body,
 * and the body covers the content. Complexity: O(s).
 */
function noteKey(note) {
  if (!note) {
    return "";
  }
  const base = [note.title || "", note.body || "", note.color || null, note.folderId || null,
    (note.media || []).map(item => [item.id, item.mime, item.name, item.size])];
  if (typeof note.order === "number") {
    base.push(note.order);
  }
  return canonicalJson(base);
}

/** noteKey without order: tells "the two differ only in order". Complexity: O(s). */
function contentKey(note) {
  return note ? canonicalJson([note.title || "", note.body || "", note.color || null, note.folderId || null,
    (note.media || []).map(item => [item.id, item.mime, item.name, item.size])]) : "";
}

/**
 * Text and attachments only (no colour, folder or order): a reorder racing a
 * recolour or a move touches other fields, so it merges instead of forking.
 * Complexity: O(s).
 */
function textKey(note) {
  return note ? canonicalJson([note.title || "", note.body || "",
    (note.media || []).map(item => [item.id, item.mime, item.name, item.size])]) : "";
}

/**
 * Which of two versions wins on order: the newer mtime, a tie broken by the
 * larger order. The same whichever comes first, so two devices pick the same
 * one and no note forks over order alone. Complexity: O(1).
 */
function orderWinner(a, b) {
  return (a.mtime || 0) !== (b.mtime || 0)
    ? ((a.mtime || 0) > (b.mtime || 0) ? a : b)
    : ((a.order || 0) >= (b.order || 0) ? a : b);
}

/**
 * The order to carry forward: the winner's if it has one, else the other's,
 * so a seed (which set an order) racing a newer text edit (which did not)
 * keeps its place instead of falling to the bottom of its group. Complexity: O(1).
 */
function mergedOrder(a, b) {
  const winner = orderWinner(a, b);
  return winner.order !== undefined ? winner.order : (a.order !== undefined ? a.order : b.order);
}

/** The larger of two numbers, either of which may be missing (null when both are). Complexity: O(1). */
function pickMax(a, b) {
  return (a == null ? (b == null ? null : b) : (b == null ? a : Math.max(a, b)));
}

/** Sets map[key] to value, or deletes it when value is null. Complexity: O(1). */
function setOrDelete(map, key, value) {
  if (value == null) {
    delete map[key];
  } else {
    map[key] = value;
  }
}

/** How many keys differ between two maps (added, removed or changed). Complexity: O(n * s). */
function countDiff(a, b) {
  let count = 0;
  for (const key in a) {
    if (!(key in b) || canonicalJson(a[key]) !== canonicalJson(b[key])) {
      count++;
    }
  }
  for (const key in b) {
    if (!(key in a)) {
      count++;
    }
  }
  return count;
}

/** A string's SHA-256 as hex. Complexity: O(n) (about 0.7 ms per 500 KB). */
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", textToBytes(s));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}

/**
 * A time as "13 Nov 09:05", in UTC with fixed month names on purpose: both
 * devices must write the loser's time the same, or their conflict copies get
 * different titles, look like a new conflict on the next sync, and fork
 * forever. Complexity: O(1).
 */
function conflictStamp(ms) {
  const date = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Adds a note's id, and the ids of its attachments (live or in the trash), to a scope. Complexity: O(m). */
function scopeAddNote(scope, vaultSide, id) {
  scope.ids.add(id);
  const note = vaultSide.notes[id];
  if (note) {
    for (const item of (note.media || [])) {
      scope.ids.add(item.id);
    }
  }
  const trashed = vaultSide.trash[id];
  if (trashed && trashed.data) {
    for (const item of (trashed.data.media || [])) {
      scope.ids.add(item.id);
    }
  }
}
