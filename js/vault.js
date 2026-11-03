// notes: The vault model: migration, the encrypted attachment store, state checks and pins.
"use strict";

// ---------- v2 model migration & housekeeping ----------
// v1 -> v2 in memory, lossless: only adds fields, never drops or rewrites any.
// Runs inside openVault so every path (unlock, restore file/script/fetch,
// restorePrev snapshot, sync pull) sees the v2 shape; missing maps are also
// defaulted so merge code can trust them.
function migrateVault(v) {
  if (!v.notes || typeof v.notes !== "object") v.notes = {};
  for (const id in v.notes) {
    const n = v.notes[id];
    if (n.color === undefined) n.color = null;
    if (n.folderId === undefined) n.folderId = null;
    if (!Array.isArray(n.media)) n.media = [];
    if (n.designId !== undefined && typeof n.designId !== "string") delete n.designId;
    // Pages are optional: absent (or malformed) means a plain single-page note,
    // exactly as before. Kept as a real array of {id,name,body,bodyV} so an
    // older copy of the app just ignores a field it does not know.
    if (n.pages !== undefined) {
      const ps = Array.isArray(n.pages) ? n.pages.filter(p => p && typeof p === "object") : [];
      if (!ps.length) delete n.pages;
      // section MUST survive this: it is what makes a page part of the title or
      // closing block, and dropping it silently flattened every design back to
      // plain body pages on the next load.
      else n.pages = ps.map((p, i) => ({
        id: typeof p.id === "string" ? p.id : "p" + i,
        name: typeof p.name === "string" ? p.name : "Page " + (i + 1),
        body: typeof p.body === "string" ? p.body : "",
        bodyV: p.bodyV === 2 ? 2 : undefined,
        ...(p.cont ? { cont: true } : {}),
        ...(p.section === "title" || p.section === "final" ? { section: p.section } : {}),
      }));
    }
  }
  if (!v.folders || typeof v.folders !== "object") v.folders = {};
  if (!v.trash || typeof v.trash !== "object") v.trash = {};
  if (!v.purged || typeof v.purged !== "object") v.purged = {};
  if (!v.presets || typeof v.presets !== "object") v.presets = {};
  // pins is a map note id -> { on, at }; an older vault simply has none yet, so it starts empty.
  if (!v.pins || typeof v.pins !== "object") v.pins = {};
  v.v = 2;
  return v;
}

// Tombstones older than 90 days are pruned. Intended consequence: a device
// that last synced more than 90 days ago will resurrect permanently-deleted
// items on its next merge; under the no-data-loss rule that is the correct
// failure direction, do not "fix" it by letting the stale delete win.
function prunePurged() {
  const cutoff = Date.now() - 90 * 86400e3;
  let changed = false;
  for (const id in vault.purged)
    if (vault.purged[id] < cutoff) { delete vault.purged[id]; changed = true; }
  return changed;
}

// True when any live note or (remaining) trash snapshot references the media id.
// Conflict copies share media ids with their originals, so bytes are only
// tombstoned once nothing references them.
function mediaReferenced(mid) {
  for (const id in vault.notes) {
    const n = vault.notes[id];
    if ((n.media || []).some(m => m.id === mid)) return true;
    // Also honour an inline-only reference in the HTML body, or a still-referenced
    // id would be tombstoned and its bytes deleted out from under the note.
    // noteBodies covers EVERY page: scanning n.body alone would purge an image
    // that only appears on page 2.
    if (noteBodies(n).some(b => b.bodyV === 2 && bodyMediaIds(b.body, 2).includes(mid))) return true;
  }
  for (const id in vault.trash) {
    const d = vault.trash[id].data;
    if (d && (d.media || []).some(m => m.id === mid)) return true;
    if (d && noteBodies(d).some(b => b.bodyV === 2 && bodyMediaIds(b.body, 2).includes(mid))) return true;
  }
  // Presets hold real references too: deleting the note a preset was built from
  // must not delete the bytes the preset still needs.
  for (const pid in (vault.presets || {})) {
    const p = vault.presets[pid];
    if ((p.media || []).some(m => m.id === mid)) return true;
    if ((p.pages || []).some(pg => pg.bodyV === 2 && bodyMediaIds(pg.body, 2).includes(mid))) return true;
  }
  return false;
}

// 30-day trash auto-purge (runs on unlock): expired trash entries become
// purged tombstones; their media ids are tombstoned and their local bytes
// dropped only when no other note still references them.
function autoPurgeTrash() {
  const cutoff = Date.now() - 30 * 86400e3;
  let changed = false;
  for (const id of Object.keys(vault.trash)) {
    const t = vault.trash[id];
    if ((t.deletedAt || 0) >= cutoff) continue;
    const mids = ((t.data && t.data.media) || []).map(m => m.id);
    delete vault.trash[id];
    vault.purged[id] = Date.now();
    if (id in syncMeta.noteMtimes) deletedTitles[id] = (t.data && t.data.title) || "(untitled)";
    for (const mid of mids) if (!mediaReferenced(mid)) {
      vault.purged[mid] = Date.now();
      revokeMediaUrl(mid);
      idbDelete(mid).catch(() => {});
    }
    // Same cleanup the manual purge does, or a stale entry keeps counting as a
    // pending trash deletion forever.
    if (id in syncMeta.trashSeen) delete syncMeta.trashSeen[id];
    changed = true;
  }
  if (changed) saveSyncMeta();
  return changed;
}

// ---------- Encrypted media store ----------
// IndexedDB "notes-media"/"media" holds records {id, bytes:ArrayBuffer} where
// bytes is ALWAYS ciphertext (IV||ct from encryptMedia); plaintext media bytes
// only ever exist transiently and behind blob: URLs in mediaUrls.
let idbPromise = null;
function idb() {
  if (!idbPromise) idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("notes-media", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("media", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
function idbReq(mode, fn) {
  return idb().then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction("media", mode).objectStore("media"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
const idbGet = id => idbReq("readonly", s => s.get(id));            // -> {id, bytes} | undefined
const idbPut = (id, bytes) => idbReq("readwrite", s => s.put({ id, bytes }));  // bytes = IV||ct only
const idbDelete = id => idbReq("readwrite", s => s.delete(id));
// Keys only: which media ids exist locally, without materializing a single byte
// (this is what lets a video tile know it is missing without loading 40MB).
const idbKeys = () => idbReq("readonly", s => s.getAllKeys());

// ANY file can be attached; what varies is RENDERING. Only image/* (minus SVG)
// ever reaches an <img>, video/* a <video>, PDF the lightbox iframe's own
// viewer, and text/* an inert textContent <pre>. Everything else (docx, zips,
// svg, html, ...) is download-only - SVG/HTML are active content and must never
// render as page content, but as saved files they are harmless.
function isAllowedMediaType() { return true; }
const mimeBase = mime => typeof mime === "string" ? mime.toLowerCase().split(";")[0].trim() : "";
const isPdfType = mime => mimeBase(mime) === "application/pdf";
const isTextType = mime => mimeBase(mime).startsWith("text/") && mimeBase(mime) !== "text/html";
const isRenderableImage = mime => mimeBase(mime).startsWith("image/") && mimeBase(mime) !== "image/svg+xml";
// The inline-wrapper/tile kind a freshly ingested file gets.
function kindForMime(mime) {
  const m = mimeBase(mime);
  if (isRenderableImage(m)) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  if (isTextType(m)) return "text";
  return "file";
}

const MEDIA_MIN_LEN = 28;   // 12-byte IV + 16-byte GCM tag

// Media MUST NOT use the session `key`: that one is derived from a per-device
// salt that changes on every KDF upgrade and never converges across devices, so
// bytes encrypted under it become undecryptable after a rekey and unreadable on
// any other device. Instead a random 256-bit media key travels INSIDE the
// encrypted vault (vault.mediaKey, base64), so it survives rekeys, restores and
// syncs. AAD binds each ciphertext to its media id, so blobs cannot be swapped
// between ids by anyone with repo write access.
// Two devices that each start fresh mint different media keys, and the merge
// unions their notes: so the vault carries a RING. mediaKey is the one new
// attachments are sealed with (merge picks it deterministically, smallest b64
// wins, so both sides converge); mediaKeysOld holds every key ever demoted, and
// decryption tries the whole ring. Nothing ever becomes undecryptable.
let mediaKey = null, mediaKeyRing = [];
async function loadMediaKey() {
  if (!vault.mediaKey) vault.mediaKey = b64(crypto.getRandomValues(new Uint8Array(32)).buffer);
  if (!Array.isArray(vault.mediaKeysOld)) vault.mediaKeysOld = [];
  const imp = raw => crypto.subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  mediaKey = await imp(vault.mediaKey);
  mediaKeyRing = [mediaKey, ...await Promise.all(vault.mediaKeysOld.map(imp))];
}
async function encryptMedia(id, bytes) {   // bytes: ArrayBuffer -> ArrayBuffer IV||ct
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc("media:" + id) }, mediaKey, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out.buffer;
}
async function decryptMedia(id, buf) {     // buf: ArrayBuffer IV||ct -> ArrayBuffer plaintext
  const u8 = new Uint8Array(buf);
  if (u8.length < MEDIA_MIN_LEN) throw new Error("media record too short");
  const params = { name: "AES-GCM", iv: u8.subarray(0, 12), additionalData: enc("media:" + id) };
  let err = null;
  for (const k of mediaKeyRing) {
    try { return await crypto.subtle.decrypt(params, k, u8.subarray(12)); }
    catch (e) { err = e; }
  }
  throw err || new Error("no media key");
}

// Central registry of every live decrypted-media object URL, so vault
// replacement paths can revoke everything in one call.
const mediaUrls = new Map();   // mediaId -> blob: object URL
// Declared here (not next to the lightbox code) so the revoke helpers below can
// reference it without a temporal-dead-zone hazard.
let lightbox = null;           // { back, mediaId, revokeOnClose, video }
function mediaObjectUrl(id, mime, plainBytes) {
  revokeMediaUrl(id);
  const type = isAllowedMediaType(mime) ? mime : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([plainBytes], { type }));
  mediaUrls.set(id, url);
  return url;
}
// N:1 sharing. The strip thumbnail and every inline occurrence of the SAME id must
// point at ONE blob URL; mediaObjectUrl's revoke-then-create would blank whichever
// reference decrypted first. Reuse an existing URL, decrypt+create at most once per
// id, and let revokeMediaUrl(id)/revokeAllMediaUrls tear down that single URL for all.
function getOrCreateMediaUrl(id, mime, plainBytes) {
  const existing = mediaUrls.get(id);
  if (existing) return existing;
  const type = isAllowedMediaType(mime) ? mime : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([plainBytes], { type }));
  mediaUrls.set(id, url);
  return url;
}
function revokeMediaUrl(id) {
  // Whatever kills a URL (Remove, a sync-applied purge, a trash purge) must
  // also take down a lightbox that is showing it. closeLightbox nulls the
  // lightbox before it calls back in here, so this cannot recurse.
  if (lightbox && lightbox.mediaId === id) closeLightbox();
  const u = mediaUrls.get(id);
  if (u) { URL.revokeObjectURL(u); mediaUrls.delete(id); }
}
// Plaintext URLs handed to a download anchor: not keyed by media id (a file can
// be downloaded twice), but still revocable by the teardown paths below.
const downloadUrls = new Set();
function revokeDownloadUrl(u) {
  if (downloadUrls.delete(u)) URL.revokeObjectURL(u);
}
function revokeAllMediaUrls() {
  closeLightbox();   // a lightbox showing a URL that is about to die must go first
  for (const u of mediaUrls.values()) URL.revokeObjectURL(u);
  mediaUrls.clear();
  for (const u of [...downloadUrls]) revokeDownloadUrl(u);
}

// Serialized so concurrent saves land in call order. stamp=false preserves the
// blob's own savedAt: a restored vault must NOT look newest, or the next sync
// would push it over a newer remote instead of pulling.
// Fire-and-forget persist that still SURFACES failures. persistChain swallows
// rejections to keep the chain alive, so without this a quota error during a
// colour change or a trash move looked like success and lost the write.
function persistSafe(stamp = true) {
  return persistLocal(stamp).catch(e => {
    status("Save failed: " + e.message, true);
    renderStatus();
  });
}
let persistChain = Promise.resolve();
function persistLocal(stamp = true) {
  // Backup view is strictly read-only: no code path may overwrite the REAL
  // vault in localStorage with the backup being inspected.
  if (backupView) return Promise.resolve();
  const p = persistChain.then(async () => {
    if (stamp) vault.savedAt = Date.now();
    localStorage.setItem("vault", await sealVault());
  });
  persistChain = p.catch(() => {});
  return p;
}

// ---------- State predicates (v2) ----------
// Five independent signals; the Unsynced chip counts their sum. Per-note dots
// use the live-note predicate only.
function isUnsynced(id) { return !(id in syncMeta.noteMtimes) || vault.notes[id].mtime > syncMeta.noteMtimes[id]; }

// ---------- Pinned notes ----------
// Pins live in their own map (vault.pins: id -> { on, at }) instead of on the note,
// so pinning never bumps the note's mtime: a pin on one device can then never
// out-vote a text edit on another in the merge, which picks whole notes by mtime.
// Unpinning keeps the entry with on:false, so the unpin itself syncs and wins
// over an older pin from another device.
function isPinned(id) {
  // So first I look the id up in the pin map, and if there is no entry the note is not pinned.
  const p = vault.pins && vault.pins[id];
  // Only an explicit on:true counts, so an unpin record (on:false) reads as not pinned.
  return !!p && p.on === true;
}
function togglePin(id) {
  // The new state is the opposite of the current one, stamped now so the newest change wins a merge.
  vault.pins[id] = { on: !isPinned(id), at: Date.now() };
  // persistSafe stamps savedAt, which is what makes the next Sync push the change even with no note edited.
  persistSafe();
  // The sidebar moves the note into or out of the Pinned section straight away.
  renderList();
}
function unsyncedIds() { return Object.keys(vault.notes).filter(isUnsynced); }
function unsyncedFolderIds() {
  return Object.keys(vault.folders).filter(fid =>
    !(fid in syncMeta.folderMtimes) || vault.folders[fid].mtime > syncMeta.folderMtimes[fid]);
}
function unsyncedTrashIds() {
  return Object.keys(vault.trash).filter(id => syncMeta.trashSeen[id] !== vault.trash[id].deletedAt);
}
// A pending deletion is a previously synced id now in NEITHER notes nor trash
// (locally purged, tombstone unpushed). Without the not-in-trash clause every
// trashed note double-counts forever and the chip never clears.
function pendingNoteDeletions() {
  return Object.keys(syncMeta.noteMtimes).filter(id => !(id in vault.notes) && !(id in vault.trash));
}
function pendingFolderDeletions() {
  return Object.keys(syncMeta.folderMtimes).filter(fid => !(fid in vault.folders));
}
function unsyncedCount() {
  return unsyncedIds().length + unsyncedFolderIds().length + unsyncedTrashIds().length +
    pendingNoteDeletions().length + pendingFolderDeletions().length;
}
function anyUnsynced() { return unsyncedCount() > 0; }

// syncAll only. Rebuilding every base from the vault also prunes entries whose
// ids no longer exist anywhere, which is exactly what the spec asks for.
// Scoped syncs must NOT come through here (see markScopedSynced).
function markSynced(remoteSha) {
  // After a full merge local and remote agree on every id, so the bases for
  // folders and trash are rebuilt from the vault just like noteMtimes.
  const noteMtimes = {}, folderMtimes = {}, trashSeen = {};
  for (const id in vault.notes) noteMtimes[id] = vault.notes[id].mtime;
  for (const id in vault.folders) folderMtimes[id] = vault.folders[id].mtime;
  for (const id in vault.trash) trashSeen[id] = vault.trash[id].deletedAt;
  syncMeta = { lastSyncedAt: Date.now(), syncedSavedAt: vault.savedAt || 0,
    remoteSha: remoteSha || syncMeta.remoteSha || null,
    noteMtimes, folderMtimes, trashSeen, mediaSynced: syncMeta.mediaSynced || {} };
  saveSyncMeta();
  deletedTitles = {};
  lastSyncError = null;
  renderList();
  renderStatus();
}

// Scoped sync bookkeeping: ONLY the in-scope entries move. markSynced() would
// rebuild every base from the whole vault and so mark unpushed out-of-scope
// edits as synced, and the next merge would silently overwrite them.
// lastSyncedAt (and the "Last synced" label) belongs to syncAll alone.
function markScopedSynced(scope, putSha, outOfScopeDiverged) {
  for (const id of scope.ids) {
    if (vault.notes[id]) syncMeta.noteMtimes[id] = vault.notes[id].mtime;
    else delete syncMeta.noteMtimes[id];
    if (vault.trash[id]) syncMeta.trashSeen[id] = vault.trash[id].deletedAt;
    else delete syncMeta.trashSeen[id];
    delete deletedTitles[id];
  }
  for (const fid of scope.folders) {
    if (vault.folders[fid]) syncMeta.folderMtimes[fid] = vault.folders[fid].mtime;
    else delete syncMeta.folderMtimes[fid];
  }
  // remoteSha poisoning guard: the line-"sha match" fast path assumes only local
  // changes can exist. A scoped sync deliberately skipped out-of-scope remote
  // changes, so recording the new sha would mask them forever.
  syncMeta.remoteSha = outOfScopeDiverged ? null : (putSha || null);
  saveSyncMeta();
  lastSyncError = null;
  renderList();
  renderStatus();
}
