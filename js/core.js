/*
 * core.js - what every other script shares: settings, app-wide state, and the
 * encryption that seals and opens the vault.
 *
 * Everything you write lives in one object, the vault: notes, folders, trash,
 * pins, designs, the attachment keys and the GitHub token. In the clear it
 * exists only in memory, while the app is unlocked. Wherever it is stored
 * (localStorage, the vault's folder, the GitHub repo) it is sealed with
 * AES-256-GCM under a key derived from the master password with PBKDF2-SHA256.
 * Attachments are encrypted on their own (vault.js), with a random key that
 * travels inside the vault.
 *
 * Main functions: readSelectedVault, saveCollapsed, saveSyncMeta, deriveKey,
 * sealObject, sealVault, openVault.
 * Auxiliary functions: $, repoApiUrl, contentsApiUrl, vaultPath,
 * vaultStorageKey, textToBytes, toBase64, fromBase64, parseBlobText.
 *
 * Complexity: deriving a key is the one deliberately slow step (about 0.6 s
 * at 1,200,000 rounds). Sealing and opening are linear in the vault's size.
 *
 * ---------- Encryption lifecycle ----------
 * Every place the app derives a key, encrypts, decrypts or hashes, and when.
 * Times were measured in Chrome 156 on a fast desktop; a phone is roughly 3
 * to 10 times slower.
 *
 * Deriving the vault key (PBKDF2-SHA256, 1,200,000 rounds, about 0.6 s):
 *   - Unlocking: after a fixed 3-second wait (guard.js), openVault derives
 *     the key from the stored blob's own salt, then decrypts it.
 *   - Creating a vault: a new random 16-byte salt, then one derivation.
 *   - Opening an older blob (310,000 or 600,000 rounds, 0.13 to 0.3 s): it is
 *     re-keyed right away with a new salt, one more derivation at 1,200,000,
 *     and re-sealed.
 *   - Sync, when the repo's vault.enc changed since the last sync: openVault
 *     derives a key from the repo copy's own salt to read it. When nothing
 *     changed in the repo, Sync derives nothing.
 *   - Opening a weekly or monthly backup from the lock screen, and restoring
 *     the pre-merge snapshot: one derivation each.
 *   Nothing else derives a key. The key stays in memory until Lock.
 *
 * Sealing the vault (AES-256-GCM, a fresh random 12-byte IV every time,
 * about 20 ms for a 500 KB vault including JSON and base64):
 *   - Every save. That is 400 ms after you stop typing (in the second screen
 *     only when you press Save), and at once for every change of structure:
 *     a new note or folder, a colour, a pin, the trash, pages, designs. The
 *     sealed text replaces the copy in localStorage and, when the app may
 *     write to its folder, vault.enc and vault.enc.js in the vault's folder
 *     (persistLocal in vault.js).
 *   - Every Sync that pushes: the merged vault is sealed again for upload.
 *   - Every backup: weekly, monthly and the Backup download.
 *   - Lock encrypts nothing by itself. If the open note has unsaved edits,
 *     Lock asks to save them first (that save is one seal), and auto-lock
 *     saves them without asking. Then the vault, the key, the salt, the
 *     attachment keys, the password and the undo history are dropped from
 *     memory, and every decrypted attachment URL is revoked (settings.js).
 *
 * Opening a sealed blob (AES-256-GCM decrypt and authenticate, about 1 ms
 * for 500 KB, after the derivation above): unlocking, Sync's pull, a backup
 * view, the pre-merge snapshot.
 *
 * Attachments (AES-256-GCM under the attachment key, about 35 ms per 10 MB):
 *   - Encrypted once, when a file is attached (encryptMedia in vault.js).
 *   - Decrypted every time one is shown or saved: a thumbnail, an inline
 *     image, the lightbox, a download, a PDF export. Also once when Sync
 *     downloads it, to check it before it is stored (decryptMedia).
 *
 * Hashing:
 *   - SHA-256 (merge.js) settles a tie when the same note changed on two
 *     devices in the same millisecond: the larger hash wins.
 *   - SHA-1 (updates.js) checks that every file of an app update arrived
 *     whole, the way git names file contents. It is not a security check.
 *
 * Guessing the password: whoever copies vault.enc pays one full derivation
 * per guess, about 2.4 million SHA-256 compressions. One high-end GPU tries
 * roughly 8,000 passwords a second, so five random words (64.6 bits) take
 * about 54 million years on one GPU, and eight random lowercase letters about
 * 5 months. The 10-attempt limit (guard.js) only slows guessing on this device.
 */
"use strict";

// ---------- Settings ----------

// Your own private repo comes from config.js, which loads before every other
// script. It is the one file that differs between your copy and the public
// one. Missing or unchanged, it leaves the placeholders, and Sync refuses to
// run (see sync.js).
const CONFIG = window.NOTES_CONFIG || {};
const OWNER = String(CONFIG.owner || "YOUR_GITHUB_USER");
const REPO = String(CONFIG.repo || "YOUR_PRIVATE_REPO");

const FILE = "vault.enc";
const WRAPPER = "vault.enc.js";

// The only defence that survives someone copying vault.enc to another
// machine: every password they try costs this many PBKDF2 rounds. Raised from
// 600,000 to 1,200,000 (twice the cost of a guess). It applies to new seals;
// an older blob keeps its own count, is still opened with it, and is re-keyed
// to this one when it is unlocked.
const PBKDF2_ITERATIONS = 1200000;

// ---------- Which vault this device opens ----------

// Several vaults can live side by side. Each has a folder of its own next to
// index.html (vault.enc, vault.enc.js, media/ and its backups) and the same
// folder in the repo. One is selected per device, and everything that belongs
// to a vault (its copy in this browser, its sync bookkeeping, its repo and
// folder paths) goes through vaultStorageKey() and vaultPath(), so it lands in
// that vault's place. A dir of "" is the layout from before folders: one
// vault at the top level, which keeps working there as "Main" until it is
// moved into its folder (see vaults.js).
const LEGACY_VAULT = "Main";

// The old top-level vault.enc.js, if index.html found one (its <script> runs
// before this file).
const legacyBlob = window.__VAULT__ && typeof window.__VAULT__ === "object" ? JSON.stringify(window.__VAULT__) : null;

let selectedVault = readSelectedVault();

// ---------- App-wide state ----------

// The open vault (v2 shape, always migrated in memory when it is opened):
// { v: 2, token, savedAt,
//   notes:   { id: { title, body, color, folderId, mtime, media: [{ id, mime, name, size }] } },
//   folders: { id: { name, color, mtime } },
//   trash:   { id: { data: <the whole note>, deletedAt } },
//   purged:  { id: purgedAtMs } }   tombstones for permanent deletions, of notes and of attachments
let vault = null;

// The AES-GCM key derived from the master password, and the salt it came from.
let vaultKey = null;
let vaultSalt = null;
let currentId = null;

// "weekly" or "monthly" while a backup is open read-only. Nothing is saved then.
let backupView = null;

// The PBKDF2 rounds the current key was derived with. sealObject writes this
// number into every blob, never PBKDF2_ITERATIONS, or a blob could state a
// count its key was not made with and never open again.
let vaultKeyIterations = PBKDF2_ITERATIONS;

// Kept from the unlock: Sync and the snapshot restore open blobs that may use
// another salt or round count, so they need the password itself, not the key.
let masterPassword = null;

// The editor holds changes that are not in vault.notes[currentId] yet.
let unsavedEdits = false;

// True while a sync runs, so a second click cannot start another.
let syncing = false;
let panelOpen = false;

// What the last sync failure was: { at, httpStatus, kind, raw, sha? }. For this session only.
let lastSyncError = null;

// Titles that changed in the last pull, for the detail panel. Never stored.
let pullDiff = null;

// Titles of deletions that are not synced yet (id -> title), for the detail panel.
let deletedTitles = {};

// A trash item on screen. It is deliberately not currentId: a trashed note is
// shown read-only and must never be written back into vault.notes. While it is
// set the editor is read-only, saving does nothing, pasting or dropping files
// does nothing, and its attachments can only be downloaded.
let trashViewId = null;

// The search box's text. For this session only.
let searchQuery = "";

// The inline input row in the sidebar: { kind: "new" | "rename", folderId }.
let inlineEdit = null;

// Muted colours that fit the theme. A note or folder without one has null.
const COLORS = ["#b5605e", "#b08b4f", "#8a9a5b", "#5f8d87", "#6d83a3", "#8b6f9e", "#a06e85"];

// Which folders are folded. Kept in memory only: every unlock folds them all again.
let collapsed = new Set();
let trashCollapsed = localStorage.getItem("trashCollapsed") === "1";

// This device's sync bookkeeping: ids and timestamps only, never a title or a
// body, so storing it unencrypted reveals nothing. markSynced writes it after
// a sync succeeds.
let syncMeta = {
  lastSyncedAt: null,
  syncedSavedAt: 0,
  remoteSha: null,
  noteMtimes: {},
  folderMtimes: {},
  trashSeen: {},
  mediaSynced: {},
};

try {
  // The stored shape may be from v1: laying it over the v2 defaults keeps
  // remoteSha, noteMtimes and lastSyncedAt through the upgrade.
  const stored = JSON.parse(localStorage.getItem(vaultStorageKey("syncMeta")));
  if (stored && stored.noteMtimes) {
    syncMeta = { ...syncMeta, ...stored };
  }
} catch {}

// The banner after the last pull: counts only, never titles.
let pullBanner = null;

try {
  pullBanner = JSON.parse(localStorage.getItem(vaultStorageKey("pullBanner")));
} catch {}

// ---------- Small per-device state ----------

/**
 * Reads which vault this device opens: { name, dir }, from localStorage. On
 * the first run of the folders version on a device that already had a vault,
 * that vault is the old top-level one, "Main" with dir "". With no vault at
 * all it returns null, and the lock screen offers to make one.
 *
 * Used by: this file, once while it loads, to set selectedVault.
 * Uses: nothing but localStorage.
 * Complexity: O(1).
 */
function readSelectedVault() {
  try {
    const stored = JSON.parse(localStorage.getItem("vaultSel"));
    if (stored && typeof stored.name === "string" && typeof stored.dir === "string") {
      return stored;
    }
  } catch {}

  if (localStorage.getItem("vault") || legacyBlob) {
    return { name: LEGACY_VAULT, dir: "" };
  }
  return null;
}

/**
 * Stores which folders are folded, as a list of folder ids.
 *
 * Used by: sidebar.js (folding a folder, dragging, revealing a note's folder),
 * notes.js (deleting a folder).
 * Uses: nothing but localStorage.
 * Complexity: O(f) in the number of folded folders.
 */
function saveCollapsed() {
  localStorage.setItem("collapsedFolders", JSON.stringify([...collapsed]));
}

/**
 * Stores this device's sync bookkeeping under the selected vault's key. It
 * holds ids and timestamps only, so it may be written at any time, but never
 * while a backup is open (nothing is saved then).
 *
 * Used by: vault.js (markSynced, markScopedSynced, the 30-day trash purge),
 * media-sync.js (the attachment phase and the sync itself), notes.js
 * (restoring and purging trash), panel.js (restoring the pre-merge snapshot).
 * Uses: vaultStorageKey.
 * Complexity: O(n) in the number of ids it lists.
 */
function saveSyncMeta() {
  if (backupView) {
    return;
  }
  localStorage.setItem(vaultStorageKey("syncMeta"), JSON.stringify(syncMeta));
}

// ---------- Sealing and opening the vault ----------

/**
 * Turns the master password into the AES-256-GCM key that seals the vault.
 * PBKDF2-HMAC-SHA256 runs `iterations` rounds over the password and a 16-byte
 * random salt. The key it returns is non-extractable: page code can encrypt
 * and decrypt with it, but can never read its bytes.
 *
 * Used by: openVault (every time a sealed blob is opened), and lock.js (the
 * unlock form: a brand-new vault, and the upgrade of an older blob).
 * Uses: textToBytes.
 * Complexity: O(iterations), and slow on purpose: at 1,200,000 rounds about
 * 0.6 s in Chrome on a fast desktop, several seconds on a phone. Anyone who
 * copies vault.enc pays the same price for every password they try: about
 * 2.4 million SHA-256 compressions per guess, roughly 8,000 guesses a second
 * on one high-end GPU.
 */
async function deriveKey(password, saltBytes, iterations) {
  const passwordKey = await crypto.subtle.importKey("raw", textToBytes(password), "PBKDF2", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]);
}

/**
 * Seals any object: its JSON is encrypted with AES-256-GCM under the vault key
 * and a fresh random 12-byte IV, and stored as the text
 * {"v":1,"iter":...,"salt":...,"iv":...,"data":...} (the bytes in base64). The
 * 16-byte GCM tag at the end of `data` authenticates the whole blob: change
 * one bit of it, its salt, IV or round count, and opening it fails as a whole.
 *
 * The outer shape never changes. `iter` is the round count this key was really
 * derived with (vaultKeyIterations), so the blob can always be opened again.
 *
 * Used by: sealVault, and media-sync.js (Sync seals the merged vault it pushes,
 * which is not always the open one).
 * Uses: textToBytes, toBase64.
 * Complexity: O(n) in the size of the JSON: about 20 ms for a 500 KB vault,
 * JSON and base64 included (AES-GCM alone is under 1 ms). It derives nothing:
 * the key is already in memory.
 */
async function sealObject(object) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vaultKey, textToBytes(JSON.stringify(object)));

  return JSON.stringify({
    v: 1,
    iter: vaultKeyIterations,
    salt: toBase64(vaultSalt),
    iv: toBase64(iv),
    data: toBase64(data),
  });
}

/**
 * Seals the open vault. This is the step behind every save, every Sync push
 * and every backup.
 *
 * Used by: vault.js (persistLocal, every save), media-sync.js (Sync, and
 * "Overwrite remote"), merge.js (applying a merge), backups.js (the weekly and
 * monthly backups and the Backup download), vaults.js (moving a vault's files
 * into its folder).
 * Uses: sealObject.
 * Complexity: that of sealObject, O(n) in the vault's size.
 */
async function sealVault() {
  return sealObject(vault);
}

/**
 * Opens a sealed blob with a password. The blob is vault.enc's JSON, or the
 * vault.enc.js wrapper around it. It derives the key from the blob's own salt
 * and round count, decrypts and authenticates, parses the JSON and brings it
 * to the current v2 shape. A wrong password or any tampering makes the
 * AES-GCM decryption throw.
 *
 * Returns { vault, key, salt, iter } so the caller can keep sealing with the
 * same key. A blob from before round counts were stored has no `iter`: it was
 * made with 310,000 rounds.
 *
 * Used by: lock.js (the unlock form and the backup viewer), media-sync.js
 * (Sync opens the repo's copy with the master password), panel.js (restoring
 * the pre-merge snapshot).
 * Uses: parseBlobText, fromBase64, deriveKey, migrateVault (vault.js).
 * Complexity: one key derivation at the blob's round count (about 0.6 s at
 * 1,200,000, 0.13 s at 310,000), then O(n) to decrypt and parse (about 1 ms
 * of AES-GCM per 500 KB).
 */
async function openVault(blobText, password) {
  const blob = JSON.parse(parseBlobText(blobText));
  const iterations = blob.iter || 310000;
  const key = await deriveKey(password, fromBase64(blob.salt), iterations);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(blob.iv) }, key, fromBase64(blob.data));

  return {
    vault: migrateVault(JSON.parse(new TextDecoder().decode(plain))),
    key,
    salt: fromBase64(blob.salt),
    iter: iterations,
  };
}

// =================== Auxiliary functions ===================

/** Shorthand for document.getElementById, used everywhere. Complexity: O(1). */
function $(id) {
  return document.getElementById(id);
}

/** The GitHub API address of something in this repo, e.g. "commits". Complexity: O(1). */
function repoApiUrl(sub) {
  return `https://api.github.com/repos/${OWNER}/${REPO}/${sub}`;
}

/** The GitHub contents-API address of a file in this repo. Complexity: O(1). */
function contentsApiUrl(path) {
  return repoApiUrl(`contents/${path}`);
}

/**
 * A path inside the selected vault's folder ("Work/vault.enc"), or the path
 * itself for the old top-level vault. Complexity: O(1).
 */
function vaultPath(path) {
  return selectedVault && selectedVault.dir ? selectedVault.dir + "/" + path : path;
}

/**
 * The localStorage key for one of the selected vault's values ("syncMeta@Work"),
 * or the bare key for the old top-level vault. Complexity: O(1).
 */
function vaultStorageKey(name) {
  return selectedVault && selectedVault.dir ? name + "@" + selectedVault.dir : name;
}

/** UTF-8 bytes of a string. Complexity: O(n). */
function textToBytes(text) {
  return new TextEncoder().encode(text);
}

/**
 * Base64 of any byte buffer, built in 32 KB slices: spreading a large buffer
 * into one call overflows the call stack once the vault passes about 100 KB.
 * Complexity: O(n).
 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The bytes of a base64 string. Complexity: O(n). */
function fromBase64(text) {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

/**
 * The JSON blob inside a sealed file, whichever format it is: vault.enc's
 * plain JSON, or the vault.enc.js script that wraps it. Complexity: O(n).
 */
function parseBlobText(text) {
  text = text.trim();
  if (!text.startsWith("{")) {
    text = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  }
  return text;
}
