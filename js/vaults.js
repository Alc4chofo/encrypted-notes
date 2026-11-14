/*
 * vaults.js - vaults side by side: their folders next to index.html,
 * choosing one, making one, keeping its folder up to date, and moving the
 * old top-level vault into its own folder.
 *
 * Each vault has a folder of its own, next to index.html and in the
 * repository, named after the vault. In it: vault.enc (the sealed vault),
 * vault.enc.js (the same bytes as a script, which a page opened from a file
 * can read where fetch is blocked), the backups, and media/ with every
 * attachment. Everything in the folder is the same ciphertext this browser
 * keeps (AES-256-GCM; nothing is decrypted to be written); only the time the
 * vault last changed ("at") is plain text, so the lock screen can say it
 * before unlocking. Before folders, the one vault lived at the top level;
 * moving it puts every file it owns under "Main/", in the repository, in
 * this browser and in the app folder.
 *
 * Main functions: knownVaults, rememberVault, selectVault, resetVaultState,
 * vaultNameProblem, scanVaults, saveVaultFiles, inVaultFolder,
 * askAppDirAccess, saveMediaFile, loadMediaFile, removeMediaFile,
 * moveVaultToFolder, moveRepoVault, moveRepoVaultOnce, moveDiskVault,
 * offerVaultMove.
 * Auxiliary functions: legacyVaultHere, formatWhen, grantedAppDir,
 * vaultFolder, writeDirFile, vaultWrapper, vaultMediaDir.
 *
 * Complexity: a save writes two files; moving a vault is one commit in the
 * repository (no file uploaded again) and one copy per file on disk.
 */
"use strict";

// ---------- State ----------

// What the old top-level vault owns: its two vault files and its backups (and
// all of media/), and its localStorage keys in this browser.
const LEGACY_FILES = [FILE, WRAPPER, "backup-weekly.enc.js", "backup-monthly.enc.js"];
const VAULT_KEYS = ["vault", "vault.prev", "vault.prevAt", "syncMeta", "pullBanner", "backupMeta"];

// ---------- Which vaults there are ----------

/**
 * The vaults this device knows, each with its folder and when it last
 * changed: { name: { dir, at } }. Plain localStorage: names and times,
 * nothing from inside a vault.
 *
 * Used by: this file (rememberVault, vaultNameProblem), lock.js
 * (renderVaultLine, renderVaultList, and the vault being made).
 * Uses: nothing.
 * Complexity: O(v) in the vaults.
 */
function knownVaults() {
  try {
    const known = JSON.parse(localStorage.getItem("vaults"));
    if (known && typeof known === "object") {
      return known;
    }
  } catch {}
  return {};
}

/**
 * Remembers a vault, its folder and when it last changed (never moving that
 * time backwards).
 *
 * Used by: this file (selectVault, scanVaults), lock.js (on load), vault.js (persistLocal).
 * Uses: knownVaults.
 * Complexity: O(v).
 */
function rememberVault(name, dir, at) {
  const known = knownVaults();
  known[name] = { dir, at: Math.max(+at || 0, (known[name] && known[name].at) || 0) };
  localStorage.setItem("vaults", JSON.stringify(known));
}

/**
 * Makes a vault the one this device opens. Switching is a reload: every
 * value kept per vault (its sync bookkeeping, its backups) is then read fresh.
 *
 * Used by: this file (moveVaultToFolder), lock.js (renderVaultList, and on load).
 * Uses: rememberVault.
 * Complexity: O(v).
 */
function selectVault(name, dir) {
  selectedVault = { name, dir };
  localStorage.setItem("vaultSel", JSON.stringify(selectedVault));
  rememberVault(name, dir, 0);
}

/**
 * Clears the per-vault state for a vault made in this page: nothing of the
 * previous one may carry over.
 *
 * Used by: lock.js (making a vault, on load).
 * Uses: syncMeta, pullBanner and lastSyncError (core.js), backupMeta (backups.js).
 * Complexity: O(1).
 */
function resetVaultState() {
  syncMeta = { lastSyncedAt: null, syncedSavedAt: 0, remoteSha: null,
    noteMtimes: {}, folderMtimes: {}, trashSeen: {}, mediaSynced: {} };
  pullBanner = null;
  backupMeta = { weeklyAt: 0, monthlyAt: 0 };
  lastSyncError = null;
}

/**
 * What is wrong with a name for a new vault, or null. A vault's name is also
 * its folder's, next to index.html and in the repository: up to 40 letters,
 * digits, spaces and . _ -, starting with a letter or digit, not ending in a
 * dot or space, not a reserved DOS name, not one of the app's own folders
 * (css, js, media), not "Main" while the old vault is still here, and not a
 * name already in use.
 *
 * Used by: lock.js (making a vault, on load).
 * Uses: LEGACY_VAULT (core.js), legacyVaultHere, knownVaults.
 * Complexity: O(v).
 */
function vaultNameProblem(name) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    return "Use up to 40 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.";
  }
  const lower = name.toLowerCase();
  if (["css", "js", "media"].includes(lower)) {
    return "That name is taken by one of the app's own folders.";
  }
  if (lower === LEGACY_VAULT.toLowerCase() && legacyVaultHere()) {
    return "\"Main\" is kept for the vault that is already here.";
  }
  if (Object.keys(knownVaults()).some(known => known.toLowerCase() === lower)) {
    return "There is already a vault with that name.";
  }
  return null;
}

/**
 * Finds the vaults in the app folder: every folder holding a vault.enc (or
 * vault.enc.js), plus the old top-level one, and remembers each with the
 * time its files last changed. Asks for the folder when needed (picker or
 * permission prompt). Returns whether it could look.
 *
 * Used by: lock.js (the vault list, on load).
 * Uses: notesDirHandle (backups.js), FILE, WRAPPER and LEGACY_VAULT (core.js), rememberVault.
 * Complexity: O(d) in the app folder's entries.
 */
async function scanVaults() {
  const root = await notesDirHandle();
  if (!root) {
    return false;
  }
  const stamp = async (dir, name) => {
    try {
      return (await (await dir.getFileHandle(name)).getFile()).lastModified;
    } catch {
      return 0;
    }
  };
  let folderMain = false;
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== "directory" || ["css", "js", "media"].includes(name.toLowerCase())) {
      continue;
    }
    const at = Math.max(await stamp(handle, FILE), await stamp(handle, WRAPPER));
    if (!at) {
      continue;
    }
    rememberVault(name, name, at);
    if (name === LEGACY_VAULT) {
      folderMain = true;
    }
  }
  const top = Math.max(await stamp(root, FILE), await stamp(root, WRAPPER));
  if (top && !folderMain) {
    rememberVault(LEGACY_VAULT, "", top);
  }
  return true;
}

// ---------- The vault's folder on disk ----------

/**
 * After every save: the vault's folder gets the same sealed vault as this
 * browser, as vault.enc and vault.enc.js. Only for a vault in a folder, and
 * only with access already given (saving never opens a prompt).
 *
 * Used by: this file (moveDiskVault), vault.js (persistLocal).
 * Uses: vaultFolder, writeDirFile, vaultWrapper, FILE and WRAPPER (core.js).
 * Complexity: O(n) in the sealed vault.
 */
async function saveVaultFiles(sealed, at) {
  const dir = await vaultFolder();
  if (!dir) {
    return;
  }
  await writeDirFile(dir, FILE, sealed);
  await writeDirFile(dir, WRAPPER, vaultWrapper(sealed, at));
}

/**
 * The chosen vault's own folder inside the app folder, made if missing (the
 * old top-level vault's "folder" is the app folder itself); null when it
 * cannot be had.
 *
 * Used by: this file (vaultFolder), backups.js (updateBackup, converting a backup).
 * Uses: selectedVault (core.js).
 * Complexity: O(1).
 */
async function inVaultFolder(root) {
  if (!root || !selectedVault || !selectedVault.dir) {
    return root;
  }
  try {
    return await root.getDirectoryHandle(selectedVault.dir, { create: true });
  } catch {
    return null;
  }
}

/**
 * Asks once per unlock for write access to the app folder remembered (the
 * Unlock click is the gesture it needs), so the vault's folder can be written
 * from then on. It never opens the folder picker.
 *
 * Used by: lock.js (unlocking, on load).
 * Uses: idbGet (vault.js).
 * Complexity: O(1).
 */
async function askAppDirAccess() {
  try {
    const record = await idbGet("__notesDir__");
    if (record && record.bytes) {
      await record.bytes.requestPermission({ mode: "readwrite" });
    }
  } catch {}
}

/**
 * Writes an attachment, still encrypted, into the vault's media folder.
 * Best effort.
 *
 * Used by: attachments.js (addMedia), media-sync.js (getMedia).
 * Uses: vaultMediaDir, writeDirFile.
 * Complexity: O(size).
 */
async function saveMediaFile(id, bytes) {
  const dir = await vaultMediaDir();
  if (dir) {
    try {
      await writeDirFile(dir, id, bytes);
    } catch {}
  }
}

/**
 * Reads an attachment's encrypted bytes from the vault's media folder, or
 * null (read before downloading it, so bytes already beside index.html are
 * not fetched again).
 *
 * Used by: media-sync.js (syncMediaPhase).
 * Uses: vaultMediaDir.
 * Complexity: O(size).
 */
async function loadMediaFile(id) {
  const dir = await vaultMediaDir();
  try {
    return dir ? await (await (await dir.getFileHandle(id)).getFile()).arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * Removes an attachment from the vault's media folder when it is purged.
 * Best effort.
 *
 * Used by: media-sync.js (syncMediaPhase), notes.js (purgeTrashCore), vault.js (autoPurgeTrash).
 * Uses: vaultMediaDir.
 * Complexity: O(1).
 */
async function removeMediaFile(id) {
  const dir = await vaultMediaDir();
  if (dir) {
    try {
      await dir.removeEntry(id);
    } catch {}
  }
}

// ---------- Moving the old top-level vault into its folder ----------

/**
 * Moves the old top-level vault into its folder, in three places. The
 * repository first: if that fails, nothing else has moved and the vault
 * stays where it was. Then this browser: its copy and bookkeeping move to
 * the folder's keys; a save still on its way lands first, and from the
 * renames on nothing is awaited until the vault is selected, so no save can
 * fall between the old keys and the new. Then the app folder, when access is
 * granted (a later save writes the vault there anyway).
 *
 * Used by: this file (offerVaultMove), media-sync.js (runSync, following a
 * move made on another device).
 * Uses: moveRepoVault, persistChain (vault.js), VAULT_KEYS, selectVault,
 * LEGACY_VAULT (core.js), moveDiskVault.
 * Complexity: that of moveRepoVault and moveDiskVault.
 */
async function moveVaultToFolder(dir) {
  if (vault.token) {
    await moveRepoVault(dir);
  }
  await persistChain;
  for (const key of VAULT_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      localStorage.setItem(key + "@" + dir, value);
      localStorage.removeItem(key);
    }
  }
  selectVault(LEGACY_VAULT, dir);
  await moveDiskVault(dir).catch(() => {});
}

/**
 * Moves the vault's files in the repository, trying again (after 1.5 s, then
 * 3 s) on a 422 (someone pushed in between, and the branch only moves
 * forward) or a TypeError (the connection dropped). Trying again is safe
 * either way: a move whose answer was lost already landed, and finds nothing
 * left to move.
 *
 * Used by: this file (moveVaultToFolder).
 * Uses: moveRepoVaultOnce.
 * Complexity: at most three tries.
 */
async function moveRepoVault(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await moveRepoVaultOnce(dir);
    } catch (error) {
      if (!(error.status === 422 || error instanceof TypeError) || attempt >= 2) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

/**
 * One commit on the default branch that moves every file of the vault
 * (vault.enc, its wrapper, the backups and all of media/) into the folder.
 * The files themselves are reused, so nothing is uploaded again. A file the
 * folder already has (put back at the top by an older copy of the app) is
 * only removed: that device's own copy still holds its changes, and its
 * next Sync merges them into the folder. Returns whether there was anything
 * to move; a repository too large for one tree listing is refused.
 *
 * Used by: this file (moveRepoVault).
 * Uses: ensurePrivateRepo and ghGit (sync.js), LEGACY_FILES.
 * Complexity: five requests, plus O(t) over the repository's tree.
 */
async function moveRepoVaultOnce(dir) {
  const branch = (await ensurePrivateRepo()).default_branch || "main";
  const head = (await ghGit("GET", "git/ref/heads/" + encodeURIComponent(branch))).object.sha;
  const commit = await ghGit("GET", "git/commits/" + head);
  const tree = await ghGit("GET", "git/trees/" + commit.tree.sha + "?recursive=1");
  if (tree.truncated) {
    throw new Error("the repo is too large to move in one step");
  }
  const have = new Set(tree.tree.map(entry => entry.path));
  const changes = [];
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !(LEGACY_FILES.includes(entry.path) || entry.path.startsWith("media/"))) {
      continue;
    }
    const to = dir + "/" + entry.path;
    if (!have.has(to)) {
      changes.push({ path: to, mode: entry.mode, type: "blob", sha: entry.sha });
    }
    changes.push({ path: entry.path, mode: entry.mode, type: "blob", sha: null });
  }
  if (!changes.length) {
    return false;
  }
  const newTree = await ghGit("POST", "git/trees", { base_tree: commit.tree.sha, tree: changes });
  const newCommit = await ghGit("POST", "git/commits", { message: `Move the vault into ${dir}/`, tree: newTree.sha, parents: [head] });
  await ghGit("PATCH", "git/refs/heads/" + encodeURIComponent(branch), { sha: newCommit.sha });
  return true;
}

/**
 * Moves the vault in the app folder (when access is already granted): the
 * backups and media/ move into the folder (renamed in place where the
 * browser can, copied otherwise; a file already there is kept), the vault
 * itself is written there freshly sealed, and the old top-level copies go.
 * Returns whether it could.
 *
 * Used by: this file (moveVaultToFolder).
 * Uses: grantedAppDir, writeDirFile, LEGACY_FILES, status (pagination.js),
 * saveVaultFiles, sealVault (core.js).
 * Complexity: O(f) in the files moved, plus one seal.
 */
async function moveDiskVault(dir) {
  const root = await grantedAppDir();
  if (!root) {
    return false;
  }
  const to = await root.getDirectoryHandle(dir, { create: true });
  const move = async (from, name, dest) => {
    let fileHandle;
    try {
      fileHandle = await from.getFileHandle(name);
    } catch {
      return;
    }
    let there = true;
    try {
      await dest.getFileHandle(name);
    } catch {
      there = false;
    }
    if (!there) {
      if (typeof fileHandle.move === "function") {
        try {
          await fileHandle.move(dest);
          return;
        } catch {}
      }
      await writeDirFile(dest, name, await fileHandle.getFile());
    }
    await from.removeEntry(name);
  };
  for (const name of LEGACY_FILES.slice(2)) {
    await move(root, name, to);
  }
  let media = null;
  try {
    media = await root.getDirectoryHandle("media");
  } catch {}
  if (media) {
    const dest = await to.getDirectoryHandle("media", { create: true });
    const names = [];
    for await (const [name, handle] of media.entries()) {
      if (handle.kind === "file") {
        names.push(name);
      }
    }
    for (let i = 0; i < names.length; i++) {
      if (i % 20 === 0) {
        status(`Moving attachments into the vault's folder (${i}/${names.length})...`, false, true);
      }
      await move(media, names[i], dest);
    }
    // Only once it is empty.
    try {
      await root.removeEntry("media");
    } catch {}
  }
  await saveVaultFiles(await sealVault(), vault.savedAt);
  for (const name of LEGACY_FILES.slice(0, 2)) {
    try {
      await root.removeEntry(name);
    } catch {}
  }
  return true;
}

/**
 * Offered after unlocking the old top-level vault, until it is moved: asks,
 * then moves it into "Main" with editing frozen. The confirming click is the
 * gesture the folder picker needs, so folder access is asked for first.
 *
 * Used by: lock.js (unlocking, on load).
 * Uses: confirmModal (modal.js), notesDirHandle (backups.js),
 * setEditingEnabled (sync.js), status and renderStatus (pagination.js),
 * moveVaultToFolder, LEGACY_VAULT (core.js).
 * Complexity: that of moveVaultToFolder.
 */
async function offerVaultMove() {
  if (!vault || backupView || !selectedVault || selectedVault.dir) {
    return;
  }
  const confirmed = await confirmModal({
    title: "Move this vault into its own folder?",
    body: "Every vault now has a folder of its own. This one moves into \"Main\", next to index.html and in the repo. " +
      "Update the app on your other devices first: an older copy would put the vault back at the top level.",
    confirmLabel: "Move it now", cancelLabel: "Later",
  });
  if (!confirmed || !vault || syncing || selectedVault.dir) {
    return;
  }
  await notesDirHandle();
  syncing = true;
  setEditingEnabled(false);
  status("Moving the vault into its folder...", false, true);
  try {
    await moveVaultToFolder(LEGACY_VAULT);
    status("Vault moved into its folder \"Main\"");
  } catch (error) {
    status(error instanceof TypeError ? "Could not reach GitHub, so nothing was moved. Lock and unlock to try again."
      : "Could not move the vault: " + error.message, true);
  } finally {
    syncing = false;
    setEditingEnabled(true);
    renderStatus();
  }
}

// =================== Auxiliary functions ===================

/** Whether the old top-level vault is still in use here. Complexity: O(1). */
function legacyVaultHere() {
  return !!legacyBlob || !!localStorage.getItem("vault") || !!(selectedVault && !selectedVault.dir);
}

/** A time as "4 Nov 2026, 19:14" in the app's language. Also used by lock.js. Complexity: O(1). */
function formatWhen(at) {
  return new Date(at).toLocaleString(LANG, { dateStyle: "medium", timeStyle: "short" });
}

/** The app folder's handle, only when write access is already granted (saving must never prompt). Complexity: O(1). */
async function grantedAppDir() {
  if (!("showDirectoryPicker" in window)) {
    return null;
  }
  try {
    const record = await idbGet("__notesDir__");
    const handle = record && record.bytes;
    return handle && await handle.queryPermission({ mode: "readwrite" }) === "granted" ? handle : null;
  } catch {
    return null;
  }
}

/** The chosen vault's folder for saving as you go (a vault in a folder, access given). Complexity: O(1). */
async function vaultFolder() {
  if (!selectedVault || !selectedVault.dir) {
    return null;
  }
  return inVaultFolder(await grantedAppDir());
}

/** Writes data into a file in a folder (made if missing). Also used by backups.js. Complexity: O(n). */
async function writeDirFile(dir, name, data) {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * The vault.enc.js script for a sealed vault: the same bytes as a script a
 * page opened from a file can load, with the plain-text time it last
 * changed. Also used by backups.js and sync.js. Complexity: O(n).
 */
function vaultWrapper(sealed, at) {
  return `window.__VAULT__ = ${sealed};\nwindow.__VAULT_AT__ = ${+at || 0};`;
}

/** The vault folder's media/ folder (made if missing), or null. Complexity: O(1). */
async function vaultMediaDir() {
  const dir = await vaultFolder();
  try {
    return dir && await dir.getDirectoryHandle("media", { create: true });
  } catch {
    return null;
  }
}
