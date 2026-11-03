// notes: Constants, shared state, the master-password key and sealing/opening the vault.
"use strict";

// All data (notes, folders, trash, media metadata + GitHub token) lives in one
// vault object, encrypted with AES-256-GCM under a key derived from the master
// password (PBKDF2-SHA256). New seals use ITER (1,200,000) iterations; older
// blobs (310k, 600k) still open because the iteration count is read from the
// blob itself, and unlocking re-keys them to ITER. GitHub
// and localStorage only ever see ciphertext; media bytes live encrypted in
// IndexedDB (ciphertext only, never plaintext).
// Your own private repo comes from config.js, loaded before every other script:
// the one file that differs between your copy and the public one. Missing or
// unchanged, it leaves the placeholders, and Sync refuses to run (see sync.js).
const CONFIG = window.NOTES_CONFIG || {};
const OWNER = String(CONFIG.owner || "YOUR_GITHUB_USER"), REPO = String(CONFIG.repo || "YOUR_PRIVATE_REPO");
const FILE = "vault.enc", WRAPPER = "vault.enc.js";
const REPO_API = sub => `https://api.github.com/repos/${OWNER}/${REPO}/${sub}`;
const API = path => REPO_API(`contents/${path}`);
// The ONLY defence that survives someone copying vault.enc to their own
// machine: every guess costs this much PBKDF2. Raised 600k -> 1.2M (~2x the
// offline attack cost); existing blobs keep their own iter and are re-sealed at
// this strength on the next unlock. For NEW seals only; openVault honors each
// blob's own iter.
const ITER = 1200000;
const $ = id => document.getElementById(id);

// vault (v2, always migrated in memory on open):
// { v:2, token, savedAt,
//   notes:   { id: { title, body, color, folderId, mtime, media:[{id,mime,name,size}] } },
//   folders: { id: { name, color, mtime } },
//   trash:   { id: { data: <full note object>, deletedAt } },
//   purged:  { id: purgedAtMs } }   // tombstones for permanent deletions (note AND media ids)
let vault = null;
let key = null, salt = null, currentId = null;
let backupView = null;   // "weekly"|"monthly" while viewing a backup read-only: NOTHING persists
let iterUsed = ITER;    // iterations the CURRENT key was derived with; sealVault writes this, never ITER
let masterPw = null;    // captured at unlock; sync/restore decrypt blobs that may use another salt/iter
let dirty = false;      // editor buffer differs from vault.notes[currentId]
let syncing = false;    // reentrancy lock for the sync handler
let panelOpen = false;
let lastSyncError = null;   // { at, httpStatus, kind, raw, sha? } (session-only)
let pullDiff = null;        // titles of the last pull's diff (session-only, never persisted)
let deletedTitles = {};     // session-only: id -> title of unsynced deletions, for the detail panel

// Sidebar state. trashViewId is deliberately NOT currentId: a trash item is
// shown read-only and must never be written back into vault.notes. While it is
// set the editor is readonly, saves no-op, and media ingest (paste/drop) and
// attachment removal must stay inert; trash-view attachments are download-only.
let trashViewId = null;
let searchQuery = "";       // title/name substring filter (session-only, never persisted)
let inlineEdit = null;      // { kind:"new"|"rename", folderId } for the sidebar inline input row
// Muted palette that fits the theme; null means "no color".
const COLORS = ["#b5605e", "#b08b4f", "#8a9a5b", "#5f8d87", "#6d83a3", "#8b6f9e", "#a06e85"];

// Collapse state is in-memory only now: every unlock reseeds it with ALL folder
// ids (everything starts collapsed), so the old localStorage restore is dead.
let collapsed = new Set();
let trashCollapsed = localStorage.getItem("trashCollapsed") === "1";
function saveCollapsed() { localStorage.setItem("collapsedFolders", JSON.stringify([...collapsed])); }
// syncMeta is ids/timestamps only, so writing it outside markSynced is safe.
function saveSyncMeta() { if (backupView) return; localStorage.setItem("syncMeta", JSON.stringify(syncMeta)); }

// Per-device sync snapshot: only UUIDs and timestamps, never titles or bodies,
// so plaintext localStorage leaks nothing. Written ONLY on sync success.
let syncMeta = { lastSyncedAt: null, syncedSavedAt: 0, remoteSha: null,
  noteMtimes: {}, folderMtimes: {}, trashSeen: {}, mediaSynced: {} };
try {
  // v2 shape migration: spread the stored (possibly v1) shape over the v2
  // defaults so remoteSha/noteMtimes/lastSyncedAt survive the upgrade.
  const m = JSON.parse(localStorage.getItem("syncMeta"));
  if (m && m.noteMtimes) syncMeta = { ...syncMeta, ...m };
} catch {}

// Last pull banner: counts only in localStorage (no plaintext titles).
let pullBanner = null;
try { pullBanner = JSON.parse(localStorage.getItem("pullBanner")); } catch {}

const enc = s => new TextEncoder().encode(s);
// Chunked: spreading a large ciphertext as call arguments overflows the call
// stack once the vault passes ~100KB.
const b64 = buf => {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(password, saltBytes, iterations) {
  const base = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Outer blob shape stays {v:1, iter, salt, iv, data} forever; only the iter
// value varies. iterUsed (not ITER) is written so the blob always states the
// iterations its key was actually derived with, or unlocking would brick.
async function sealObject(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iter: iterUsed, salt: b64(salt), iv: b64(iv), data: b64(data) });
}
// The merge pushes a blob that is NOT the local vault (a scoped sync replaces
// only the in-scope entries of the remote), hence sealObject.
async function sealVault() { return sealObject(vault); }

// Accepts both formats: raw vault.enc JSON and the vault.enc.js wrapper.
function parseBlobText(text) {
  text = text.trim();
  if (!text.startsWith("{")) text = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return text;
}

async function openVault(blobText, password) {
  const blob = JSON.parse(parseBlobText(blobText));
  const iter = blob.iter || 310000;   // pre-upgrade blobs; no version check on purpose
  const k = await deriveKey(password, unb64(blob.salt), iter);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, k, unb64(blob.data));
  return { vault: migrateVault(JSON.parse(new TextDecoder().decode(plain))),
    key: k, salt: unb64(blob.salt), iter };
}
