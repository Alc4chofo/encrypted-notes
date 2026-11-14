/*
 * vault.js - the vault as data: its shape, saving it, the encrypted
 * attachment store, attachment encryption, and what is not synced yet.
 *
 * Saving: persistLocal seals the whole vault (sealVault in core.js) and
 * writes the sealed text to localStorage and, when the app may, to the
 * vault's folder. Saves run one after another, in the order they were asked
 * for.
 *
 * Attachments: each file is encrypted on its own with AES-256-GCM under the
 * attachment key, a random 256-bit key that travels inside the vault, so it
 * survives re-keys and works on every device. The ciphertext is kept in
 * IndexedDB ("notes-media"). Plain bytes exist only while a file is shown,
 * behind a blob: URL that is revoked when it is no longer needed and at Lock.
 *
 * Main functions: migrateVault, prunePurged, persistLocal, persistSafe,
 * mediaReferenced, autoPurgeTrash, idbGet, idbPut, idbDelete, idbKeys,
 * loadMediaKey, encryptMedia, decryptMedia, mediaObjectUrl,
 * getOrCreateMediaUrl, revokeMediaUrl, revokeDownloadUrl, revokeAllMediaUrls,
 * isUnsynced, unsyncedIds, unsyncedFolderIds, unsyncedTrashIds,
 * pendingNoteDeletions, pendingFolderDeletions, unsyncedCount, anyUnsynced,
 * markSynced, markScopedSynced, isPinned, togglePin.
 * Auxiliary functions: openMediaDatabase, mediaStoreRequest,
 * isAllowedMediaType, baseMimeType, isPdfType, isTextType, isRenderableImage,
 * kindForMime.
 *
 * Complexity: a save is O(n) in the vault's size (about 20 ms for 500 KB).
 * Encrypting or decrypting an attachment is O(n) in its size (about 35 ms per
 * 10 MB). The unsynced counts are O(n) in the number of notes, folders and
 * trash entries, and mediaReferenced is O(n * b) in notes times body size.
 */
"use strict";

// ---------- State ----------

// The IndexedDB connection, opened on first use and then shared.
let mediaDatabase = null;

// The smallest valid encrypted attachment: a 12-byte IV and the 16-byte GCM tag.
const MEDIA_MIN_LEN = 28;

// The attachment key new files are sealed with, and every key that can open
// one (the current key first, then every older one the vault remembers).
let mediaKey = null;
let mediaKeyRing = [];

// Every live blob: URL of a decrypted attachment (attachment id -> URL), so
// replacing or locking the vault can revoke them all in one sweep.
const mediaUrls = new Map();

// The lightbox on screen: { back, mediaId, revokeOnClose, video }. Declared
// here, before the revoke functions below that close it.
let lightbox = null;

// blob: URLs handed to a download link. They are not keyed by attachment (a
// file can be downloaded twice), but the teardown still revokes them.
const downloadUrls = new Set();

// Saves, and the copies written to the vault's folder, each run one at a
// time, in the order they were asked for.
let persistChain = Promise.resolve();
let vaultFileChain = Promise.resolve();

// ---------- The vault's shape ----------

/**
 * Brings an opened vault to the current shape (v2), in memory and without
 * losing anything: it only adds missing fields and maps, never drops or
 * rewrites one. Pages keep their section, which is what puts a page in a
 * design's title or closing block.
 *
 * Used by: core.js (openVault, so every opened blob gets the v2 shape), lock.js
 * (a brand-new vault starts from it too).
 * Uses: nothing.
 * Complexity: O(n + p) in notes and pages.
 */
function migrateVault(v) {
  if (!v.notes || typeof v.notes !== "object") {
    v.notes = {};
  }

  for (const id in v.notes) {
    const note = v.notes[id];
    if (note.color === undefined) {
      note.color = null;
    }
    if (note.folderId === undefined) {
      note.folderId = null;
    }
    if (!Array.isArray(note.media)) {
      note.media = [];
    }
    if (note.designId !== undefined && typeof note.designId !== "string") {
      delete note.designId;
    }

    // Pages are optional: missing (or broken) means a plain one-page note. They
    // stay a real array of { id, name, body, bodyV }, so an older copy of the app
    // ignores a field it does not know. `section` must survive this: dropping
    // it once flattened every design back to plain pages on the next load.
    if (note.pages !== undefined) {
      const pages = Array.isArray(note.pages) ? note.pages.filter(page => page && typeof page === "object") : [];
      if (!pages.length) {
        delete note.pages;
      } else {
        note.pages = pages.map((page, i) => ({
          id: typeof page.id === "string" ? page.id : "p" + i,
          name: typeof page.name === "string" ? page.name : "Page " + (i + 1),
          body: typeof page.body === "string" ? page.body : "",
          bodyV: page.bodyV === 2 ? 2 : undefined,
          ...(page.cont ? { cont: true } : {}),
          ...(page.section === "title" || page.section === "final" ? { section: page.section } : {}),
        }));
      }
    }
  }

  if (!v.folders || typeof v.folders !== "object") {
    v.folders = {};
  }
  if (!v.trash || typeof v.trash !== "object") {
    v.trash = {};
  }
  if (!v.purged || typeof v.purged !== "object") {
    v.purged = {};
  }
  if (!v.presets || typeof v.presets !== "object") {
    v.presets = {};
  }
  // pins maps a note id to { on, at }. An older vault has none yet, so it starts empty.
  if (!v.pins || typeof v.pins !== "object") {
    v.pins = {};
  }
  v.v = 2;
  return v;
}

/**
 * Forgets tombstones older than 90 days. On purpose, a device that last
 * synced more than 90 days ago will bring permanently deleted items back on
 * its next merge: losing nothing is the rule, so that is the right way to
 * fail. Do not "fix" it by letting the old deletion win.
 *
 * Used by: lock.js (after every unlock).
 * Uses: nothing.
 * Complexity: O(t) in the number of tombstones. Returns whether any went.
 */
function prunePurged() {
  const cutoff = Date.now() - 90 * 86400e3;
  let changed = false;
  for (const id in vault.purged) {
    if (vault.purged[id] < cutoff) {
      delete vault.purged[id];
      changed = true;
    }
  }
  return changed;
}

// ---------- Saving ----------

/**
 * Saves the vault: seals it and writes the sealed text to localStorage under
 * the selected vault's key, records the vault's last change for the lock
 * screen, and queues the same ciphertext for the vault's folder (vault.enc
 * and vault.enc.js), which never holds up the save. Saves run one at a time
 * in the order they were asked for.
 *
 * With stamp left true the vault's savedAt becomes now. A restore passes
 * false: a restored vault must not look newest, or the next sync would push
 * it over a newer copy instead of pulling. While a backup is open nothing is
 * written at all, so a backup can never overwrite the real vault.
 *
 * Used by: pagination.js (saveCurrent: typing and Save), history.js (undo and
 * redo), attachments.js (adding and removing attachments), media-sync.js
 * (Sync and "Overwrite remote"), merge.js (applying a merge), panel.js
 * (restoring the pre-merge snapshot, applying a new token), lock.js (after
 * unlocking, when the vault was upgraded or tidied), and persistSafe.
 * Uses: sealVault (core.js), vaultStorageKey (core.js), rememberVault and
 * saveVaultFiles (vaults.js).
 * Complexity: O(n) in the vault's size, one seal: about 20 ms for 500 KB.
 */
function persistLocal(stamp = true) {
  if (backupView) {
    return Promise.resolve();
  }

  const save = persistChain.then(async () => {
    if (stamp) {
      vault.savedAt = Date.now();
    }
    const sealed = await sealVault();
    localStorage.setItem(vaultStorageKey("vault"), sealed);
    if (selectedVault) {
      rememberVault(selectedVault.name, selectedVault.dir, vault.savedAt);
    }
    const at = vault.savedAt;
    vaultFileChain = vaultFileChain.then(() => saveVaultFiles(sealed, at)).catch(() => {});
  });

  persistChain = save.catch(() => {});
  return save;
}

/**
 * persistLocal for callers that do not wait for it, which still reports a
 * failure on the status line. The save chain swallows errors to keep going,
 * so without this a full disk during a colour change or a trash move looked
 * like success and the change was lost.
 *
 * Used by: every structural change. notes.js (folders, colours, moves, trash),
 * sidebar.js (dragging and nesting, emptying the trash), content.js (pages),
 * designs.js (designs and presets), events.js (a new note), history.js
 * (resetting a layout, the second screen's snapshot), attachments.js (a note
 * made for a dropped file), and togglePin in this file.
 * Uses: persistLocal, status and renderStatus (pagination.js).
 * Complexity: that of persistLocal.
 */
function persistSafe(stamp = true) {
  return persistLocal(stamp).catch(error => {
    status("Save failed: " + error.message, true);
    renderStatus();
  });
}

// ---------- Housekeeping ----------

/**
 * Whether any note, trashed note or design preset still refers to an
 * attachment, in its attachment list or inline in the text of any page.
 * Conflict copies share attachment ids with their originals, so the bytes of
 * an attachment may only be deleted once nothing refers to it.
 *
 * Used by: autoPurgeTrash in this file, attachments.js (removing an
 * attachment), notes.js (purging from the trash), media-sync.js (deleting
 * attachments nothing refers to any more).
 * Uses: noteBodies and bodyMediaIds (content.js).
 * Complexity: O(n * b), the notes, trash entries and presets times the size
 * of their bodies.
 */
function mediaReferenced(mediaId) {
  for (const id in vault.notes) {
    const note = vault.notes[id];
    if ((note.media || []).some(media => media.id === mediaId)) {
      return true;
    }
    // An image that appears only inline in the text counts too, on every page:
    // scanning note.body alone would delete an image that is only on page 2.
    if (noteBodies(note).some(body => body.bodyV === 2 && bodyMediaIds(body.body, 2).includes(mediaId))) {
      return true;
    }
  }

  for (const id in vault.trash) {
    const data = vault.trash[id].data;
    if (data && (data.media || []).some(media => media.id === mediaId)) {
      return true;
    }
    if (data && noteBodies(data).some(body => body.bodyV === 2 && bodyMediaIds(body.body, 2).includes(mediaId))) {
      return true;
    }
  }

  // A preset holds real references too: deleting the note it was made from
  // must not delete the pictures the preset still needs.
  for (const presetId in (vault.presets || {})) {
    const preset = vault.presets[presetId];
    if ((preset.media || []).some(media => media.id === mediaId)) {
      return true;
    }
    if ((preset.pages || []).some(page => page.bodyV === 2 && bodyMediaIds(page.body, 2).includes(mediaId))) {
      return true;
    }
  }
  return false;
}

/**
 * Empties the trash of entries older than 30 days. Each one becomes a
 * tombstone, and its attachments are tombstoned and their local bytes deleted
 * only when nothing else still refers to them.
 *
 * Used by: lock.js (after every unlock), media-sync.js (at the start of every Sync).
 * Uses: mediaReferenced, revokeMediaUrl, idbDelete, removeMediaFile
 * (vaults.js), saveSyncMeta (core.js).
 * Complexity: O(t * n * b): each expired trash entry checks its attachments
 * with mediaReferenced. Returns whether anything changed.
 */
function autoPurgeTrash() {
  const cutoff = Date.now() - 30 * 86400e3;
  let changed = false;

  for (const id of Object.keys(vault.trash)) {
    const entry = vault.trash[id];
    if ((entry.deletedAt || 0) >= cutoff) {
      continue;
    }

    const mediaIds = ((entry.data && entry.data.media) || []).map(media => media.id);
    delete vault.trash[id];
    vault.purged[id] = Date.now();
    if (id in syncMeta.noteMtimes) {
      deletedTitles[id] = (entry.data && entry.data.title) || "(untitled)";
    }

    for (const mediaId of mediaIds) {
      if (!mediaReferenced(mediaId)) {
        vault.purged[mediaId] = Date.now();
        revokeMediaUrl(mediaId);
        idbDelete(mediaId).catch(() => {});
        removeMediaFile(mediaId);
      }
    }

    // The same cleanup a manual purge does, or a stale entry keeps counting
    // as a pending trash deletion forever.
    if (id in syncMeta.trashSeen) {
      delete syncMeta.trashSeen[id];
    }
    changed = true;
  }

  if (changed) {
    saveSyncMeta();
  }
  return changed;
}

// ---------- The encrypted attachment store ----------
// IndexedDB "notes-media", store "media", holds records { id, bytes } where
// bytes is always ciphertext: the 12-byte IV followed by the AES-GCM output.

/**
 * Reads one record from the attachment store: { id, bytes } or undefined.
 * The same store also keeps the attempt counter and folder handles.
 *
 * Used by: attachments.js, lines.js and pdf.js (reading an attachment to
 * decrypt it), media-sync.js (uploading one), guard.js (the attempt counter),
 * backups.js, updates.js and vaults.js (the folder handle).
 * Uses: mediaStoreRequest.
 * Complexity: O(1) lookups; the cost is the record's size.
 */
function idbGet(id) {
  return mediaStoreRequest("readonly", store => store.get(id));
}

/**
 * Writes one record. For attachments, bytes are ciphertext only.
 *
 * Used by: attachments.js (a new attachment), media-sync.js (a downloaded or
 * folder-read attachment), guard.js (the attempt counter), backups.js and
 * updates.js (the folder handle).
 * Uses: mediaStoreRequest.
 * Complexity: O(1) plus the record's size.
 */
function idbPut(id, bytes) {
  return mediaStoreRequest("readwrite", store => store.put({ id, bytes }));
}

/**
 * Deletes one record.
 *
 * Used by: autoPurgeTrash in this file, notes.js (purging from the trash),
 * media-sync.js (deleting attachments nothing refers to).
 * Uses: mediaStoreRequest.
 * Complexity: O(1).
 */
function idbDelete(id) {
  return mediaStoreRequest("readwrite", store => store.delete(id));
}

/**
 * Lists the ids in the store without reading a single byte of them: this is
 * how a video tile knows its file is missing without loading 40 MB.
 *
 * Used by: attachments.js (the attachment strip), lines.js (inline images),
 * media-sync.js (what to upload and download), pdf.js (export), split.js (the
 * reference pane).
 * Uses: mediaStoreRequest.
 * Complexity: O(k) in the number of records.
 */
function idbKeys() {
  return mediaStoreRequest("readonly", store => store.getAllKeys());
}

// ---------- Attachment encryption ----------
// Attachments must not use the vault key: it comes from a per-device salt that
// changes on every re-key and is different on every device, so files sealed
// with it would stop opening after an upgrade and never open on another
// device. A random 256-bit attachment key travels inside the encrypted vault
// instead (vault.mediaKey, base64), so it survives re-keys, restores and syncs.
// The additional authenticated data "media:<id>" binds each file to its id:
// someone with write access to the repo cannot swap two files.
//
// Two devices that each start a vault make different attachment keys, and the
// merge keeps the notes of both. So the vault carries a ring: mediaKey seals
// new files (the merge picks it the same way on every device: the smallest
// base64 wins), mediaKeysOld keeps every key that was ever replaced, and
// decryption tries them all. Nothing ever becomes unreadable.

/**
 * Makes the attachment key ring usable: creates the vault's attachment key
 * the first time (32 random bytes), then imports it and every older key as
 * non-extractable AES-GCM keys.
 *
 * Used by: lock.js (after every unlock), merge.js (after a merge, which may
 * bring new keys), panel.js (after restoring the pre-merge snapshot).
 * Uses: toBase64 and fromBase64 (core.js).
 * Complexity: O(k) in the number of keys; each import takes microseconds.
 */
async function loadMediaKey() {
  if (!vault.mediaKey) {
    vault.mediaKey = toBase64(crypto.getRandomValues(new Uint8Array(32)).buffer);
  }
  if (!Array.isArray(vault.mediaKeysOld)) {
    vault.mediaKeysOld = [];
  }

  const importRawKey = raw =>
    crypto.subtle.importKey("raw", fromBase64(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  mediaKey = await importRawKey(vault.mediaKey);
  mediaKeyRing = [mediaKey, ...await Promise.all(vault.mediaKeysOld.map(importRawKey))];
}

/**
 * Encrypts one attachment: AES-256-GCM under the current attachment key,
 * with a fresh random 12-byte IV and "media:<id>" as additional data.
 * Returns the IV followed by the ciphertext and its 16-byte tag.
 *
 * Used by: attachments.js (once, when a file is attached).
 * Uses: textToBytes (core.js).
 * Complexity: O(n) in the file's size, about 35 ms per 10 MB.
 */
async function encryptMedia(id, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textToBytes("media:" + id) }, mediaKey, bytes);

  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out.buffer;
}

/**
 * Decrypts and authenticates one attachment (IV followed by ciphertext),
 * trying every key in the ring. A damaged or swapped file throws instead of
 * returning wrong bytes.
 *
 * Used by: attachments.js (thumbnails, opening and downloading), lines.js
 * (inline images and opening them), pdf.js (export), media-sync.js (checking
 * a downloaded or folder-read file before it is stored).
 * Uses: textToBytes (core.js).
 * Complexity: O(n) in the file's size, about 31 ms per 10 MB, times the keys
 * tried (one, unless the file predates a merge of two key rings).
 */
async function decryptMedia(id, buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < MEDIA_MIN_LEN) {
    throw new Error("media record too short");
  }

  const params = { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: textToBytes("media:" + id) };
  let lastError = null;
  for (const key of mediaKeyRing) {
    try {
      return await crypto.subtle.decrypt(params, key, bytes.subarray(12));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("no media key");
}

// ---------- Decrypted attachment URLs ----------

/**
 * A fresh blob: URL for an attachment's plain bytes, replacing (and revoking)
 * any URL that attachment already had.
 *
 * Used by: attachments.js (opening an attachment), lines.js (opening an
 * inline one).
 * Uses: revokeMediaUrl, isAllowedMediaType.
 * Complexity: O(1); the browser keeps the bytes.
 */
function mediaObjectUrl(id, mime, plainBytes) {
  revokeMediaUrl(id);
  const type = isAllowedMediaType(mime) ? mime : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([plainBytes], { type }));
  mediaUrls.set(id, url);
  return url;
}

/**
 * The blob: URL for an attachment, reusing the existing one. The thumbnail in
 * the strip and every inline copy of the same image must share one URL:
 * mediaObjectUrl's revoke-then-create would blank whichever copy decrypted
 * first. So each attachment is decrypted and given a URL at most once, and
 * revokeMediaUrl tears that one URL down for all of them.
 *
 * Used by: attachments.js (thumbnails), lines.js (inline images).
 * Uses: isAllowedMediaType.
 * Complexity: O(1).
 */
function getOrCreateMediaUrl(id, mime, plainBytes) {
  const existing = mediaUrls.get(id);
  if (existing) {
    return existing;
  }
  const type = isAllowedMediaType(mime) ? mime : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([plainBytes], { type }));
  mediaUrls.set(id, url);
  return url;
}

/**
 * Revokes an attachment's blob: URL, so its plain bytes can be freed. A
 * lightbox showing it closes first. closeLightbox clears `lightbox` before it
 * calls back in here, so this cannot recurse.
 *
 * Used by: mediaObjectUrl and autoPurgeTrash in this file, attachments.js
 * (removing an attachment, closing the lightbox), notes.js (purging from the
 * trash), media-sync.js (deleting attachments nothing refers to).
 * Uses: closeLightbox (attachments.js).
 * Complexity: O(1).
 */
function revokeMediaUrl(id) {
  if (lightbox && lightbox.mediaId === id) {
    closeLightbox();
  }
  const url = mediaUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    mediaUrls.delete(id);
  }
}

/**
 * Revokes one URL that was handed to a download link.
 *
 * Used by: revokeAllMediaUrls in this file, attachments.js (once a download started).
 * Uses: nothing.
 * Complexity: O(1).
 */
function revokeDownloadUrl(url) {
  if (downloadUrls.delete(url)) {
    URL.revokeObjectURL(url);
  }
}

/**
 * Revokes every decrypted attachment URL at once, after closing a lightbox
 * that shows one: the plain bytes of every attachment become unreachable.
 *
 * Used by: settings.js (Lock), pagination.js (opening another note or a
 * trash item), notes.js (trashing and purging), merge.js (applying a merge),
 * panel.js (restoring the pre-merge snapshot).
 * Uses: closeLightbox (attachments.js), revokeDownloadUrl.
 * Complexity: O(u) in the number of live URLs.
 */
function revokeAllMediaUrls() {
  closeLightbox();
  for (const url of mediaUrls.values()) {
    URL.revokeObjectURL(url);
  }
  mediaUrls.clear();
  for (const url of [...downloadUrls]) {
    revokeDownloadUrl(url);
  }
}

// ---------- What is not synced yet ----------
// Five independent signals; the Unsynced section counts their sum. A note's
// own dot in the sidebar uses isUnsynced only.

/**
 * Whether a note changed since the last sync, or was never synced.
 *
 * Used by: unsyncedIds in this file, sidebar.js (a note's dot).
 * Uses: nothing.
 * Complexity: O(1).
 */
function isUnsynced(id) {
  return !(id in syncMeta.noteMtimes) || vault.notes[id].mtime > syncMeta.noteMtimes[id];
}

/**
 * The ids of notes that changed since the last sync.
 *
 * Used by: unsyncedCount in this file, panel.js (the detail panel), sidebar.js
 * (the Unsynced section).
 * Uses: isUnsynced.
 * Complexity: O(n) in the number of notes.
 */
function unsyncedIds() {
  return Object.keys(vault.notes).filter(isUnsynced);
}

/**
 * The ids of folders that changed since the last sync.
 *
 * Used by: unsyncedCount in this file, panel.js (the detail panel), sidebar.js
 * (the Unsynced section).
 * Uses: nothing.
 * Complexity: O(f) in the number of folders.
 */
function unsyncedFolderIds() {
  return Object.keys(vault.folders).filter(folderId =>
    !(folderId in syncMeta.folderMtimes) || vault.folders[folderId].mtime > syncMeta.folderMtimes[folderId]);
}

/**
 * The ids of trash entries that are new or changed since the last sync.
 *
 * Used by: unsyncedCount in this file, panel.js (the detail panel), sidebar.js
 * (the Unsynced section).
 * Uses: nothing.
 * Complexity: O(t) in the number of trash entries.
 */
function unsyncedTrashIds() {
  return Object.keys(vault.trash).filter(id => syncMeta.trashSeen[id] !== vault.trash[id].deletedAt);
}

/**
 * Notes deleted for good whose deletion is not synced yet: synced before, and
 * now in neither the notes nor the trash. Without the trash check every
 * trashed note would count twice forever, and the count would never clear.
 *
 * Used by: unsyncedCount in this file, panel.js (the detail panel), sidebar.js
 * (the Unsynced section).
 * Uses: nothing.
 * Complexity: O(s) in the number of synced note ids.
 */
function pendingNoteDeletions() {
  return Object.keys(syncMeta.noteMtimes).filter(id => !(id in vault.notes) && !(id in vault.trash));
}

/**
 * Folders deleted since the last sync.
 *
 * Used by: unsyncedCount in this file, panel.js (the detail panel), sidebar.js
 * (the Unsynced section).
 * Uses: nothing.
 * Complexity: O(s) in the number of synced folder ids.
 */
function pendingFolderDeletions() {
  return Object.keys(syncMeta.folderMtimes).filter(folderId => !(folderId in vault.folders));
}

/**
 * How many things are not synced yet: changed notes, folders and trash
 * entries, and pending deletions.
 *
 * Used by: anyUnsynced in this file, pagination.js (the status line).
 * Uses: unsyncedIds, unsyncedFolderIds, unsyncedTrashIds,
 * pendingNoteDeletions, pendingFolderDeletions.
 * Complexity: O(n + f + t) over notes, folders and trash.
 */
function unsyncedCount() {
  return unsyncedIds().length + unsyncedFolderIds().length + unsyncedTrashIds().length +
    pendingNoteDeletions().length + pendingFolderDeletions().length;
}

/**
 * Whether anything at all is not synced yet.
 *
 * Used by: media-sync.js (deciding whether a sync has to push), merge.js
 * (asking before a merge replaces unsynced edits).
 * Uses: unsyncedCount.
 * Complexity: O(n + f + t).
 */
function anyUnsynced() {
  return unsyncedCount() > 0;
}

/**
 * Records a full sync: every note, folder and trash entry now counts as
 * synced. Rebuilding the bookkeeping from the vault also drops ids that no
 * longer exist anywhere. Only a full sync may do this (see markScopedSynced).
 *
 * Used by: media-sync.js (a full sync, and "Overwrite remote").
 * Uses: saveSyncMeta (core.js), renderList (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(n + f + t).
 */
function markSynced(remoteSha) {
  // After a full merge both sides agree on every id, so the bookkeeping for
  // folders and trash is rebuilt from the vault just like the notes'.
  const noteMtimes = {};
  const folderMtimes = {};
  const trashSeen = {};
  for (const id in vault.notes) {
    noteMtimes[id] = vault.notes[id].mtime;
  }
  for (const id in vault.folders) {
    folderMtimes[id] = vault.folders[id].mtime;
  }
  for (const id in vault.trash) {
    trashSeen[id] = vault.trash[id].deletedAt;
  }

  syncMeta = {
    lastSyncedAt: Date.now(),
    syncedSavedAt: vault.savedAt || 0,
    remoteSha: remoteSha || syncMeta.remoteSha || null,
    noteMtimes,
    folderMtimes,
    trashSeen,
    mediaSynced: syncMeta.mediaSynced || {},
  };
  saveSyncMeta();
  deletedTitles = {};
  lastSyncError = null;
  renderList();
  renderStatus();
}

/**
 * Records a sync of a few notes and folders only: just those entries move.
 * markSynced would mark unpushed changes elsewhere as synced, and the next
 * merge would quietly overwrite them. "Last synced" belongs to full syncs.
 *
 * The repo's blob id is kept only when nothing outside the scope differed:
 * a scoped sync skips remote changes outside its scope on purpose, and
 * recording the new id would let the "nothing changed" shortcut hide them
 * forever.
 *
 * Used by: media-sync.js (a sync of one note or folder).
 * Uses: saveSyncMeta (core.js), renderList (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(s) in the size of the scope.
 */
function markScopedSynced(scope, putSha, outOfScopeDiverged) {
  for (const id of scope.ids) {
    if (vault.notes[id]) {
      syncMeta.noteMtimes[id] = vault.notes[id].mtime;
    } else {
      delete syncMeta.noteMtimes[id];
    }
    if (vault.trash[id]) {
      syncMeta.trashSeen[id] = vault.trash[id].deletedAt;
    } else {
      delete syncMeta.trashSeen[id];
    }
    delete deletedTitles[id];
  }

  for (const folderId of scope.folders) {
    if (vault.folders[folderId]) {
      syncMeta.folderMtimes[folderId] = vault.folders[folderId].mtime;
    } else {
      delete syncMeta.folderMtimes[folderId];
    }
  }

  syncMeta.remoteSha = outOfScopeDiverged ? null : (putSha || null);
  saveSyncMeta();
  lastSyncError = null;
  renderList();
  renderStatus();
}

// ---------- Pinned notes ----------
// Pins live in their own map (vault.pins: id -> { on, at }) instead of on the
// note, so pinning never changes a note's mtime: a pin on one device can then
// never outvote a text edit on another, since the merge picks whole notes by
// mtime. Unpinning keeps the entry with on: false, so the unpin itself syncs
// and wins over an older pin from another device.

/**
 * Whether a note is pinned. Only an explicit on: true counts; an unpin record
 * (on: false) or no record at all means not pinned.
 *
 * Used by: togglePin in this file, notes.js (the note menu), sidebar.js (the
 * Pinned section and a note's row).
 * Uses: nothing.
 * Complexity: O(1).
 */
function isPinned(id) {
  const pin = vault.pins && vault.pins[id];
  return !!pin && pin.on === true;
}

/**
 * Pins or unpins a note, stamped now so the newest change wins a merge, then
 * saves (which is what makes the next Sync push it, with no note edited) and
 * moves the note into or out of the Pinned section.
 *
 * Used by: notes.js (the note menu).
 * Uses: isPinned, persistSafe, renderList (sidebar.js).
 * Complexity: O(n) for the save and the redraw.
 */
function togglePin(id) {
  vault.pins[id] = { on: !isPinned(id), at: Date.now() };
  persistSafe();
  renderList();
}

// =================== Auxiliary functions ===================

/** Opens the "notes-media" IndexedDB database once, creating its store the first time. Complexity: O(1). */
function openMediaDatabase() {
  if (!mediaDatabase) {
    mediaDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open("notes-media", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("media", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return mediaDatabase;
}

/** Runs one request on the "media" store and resolves with its result. Complexity: O(1) plus the request. */
function mediaStoreRequest(mode, makeRequest) {
  return openMediaDatabase().then(database => new Promise((resolve, reject) => {
    const request = makeRequest(database.transaction("media", mode).objectStore("media"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

/**
 * Any file may be attached; what varies is how it is shown. Only images
 * (never SVG) reach an <img>, videos a <video>, PDFs the browser's own
 * viewer, and text an inert <pre>. Everything else (SVG, HTML, documents,
 * archives) can only be downloaded: as page content SVG and HTML could run
 * code, as saved files they are harmless. Complexity: O(1).
 */
function isAllowedMediaType() {
  return true;
}

/** The lowercase MIME type without parameters ("image/png; x=1" -> "image/png"). Complexity: O(1). */
function baseMimeType(mime) {
  return typeof mime === "string" ? mime.toLowerCase().split(";")[0].trim() : "";
}

/** Whether a MIME type is a PDF. Complexity: O(1). */
function isPdfType(mime) {
  return baseMimeType(mime) === "application/pdf";
}

/** Whether a MIME type is text that may be shown as text (never HTML). Complexity: O(1). */
function isTextType(mime) {
  return baseMimeType(mime).startsWith("text/") && baseMimeType(mime) !== "text/html";
}

/** Whether a MIME type is an image that may be rendered (never SVG). Complexity: O(1). */
function isRenderableImage(mime) {
  return baseMimeType(mime).startsWith("image/") && baseMimeType(mime) !== "image/svg+xml";
}

/** The kind of tile a new attachment gets: image, video, pdf, text or file. Complexity: O(1). */
function kindForMime(mime) {
  const type = baseMimeType(mime);
  if (isRenderableImage(type)) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type === "application/pdf") {
    return "pdf";
  }
  if (isTextType(type)) {
    return "text";
  }
  return "file";
}
