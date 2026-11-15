/*
 * delete-vault.js - deleting the open vault: from this device, from the
 * repository, or from both, behind two questions.
 *
 * The button sits in its own small section of the sidebar, under the trash.
 * Pressing it asks where to delete the vault from (this device, the repo, or
 * both, with Cancel under them), then asks once more, since nothing can bring
 * it back.
 *
 * Deleting from this device erases everything of the vault that this browser
 * and the app folder hold: its copy and bookkeeping in localStorage, its
 * attachments in IndexedDB, and its folder next to index.html (vault.enc,
 * vault.enc.js, the backups, media/). Each piece is first overwritten with
 * random bytes of the same length, then removed; then the page reloads, which
 * also drops every decrypted note from memory. Deleting from the repo removes
 * the vault's folder in one commit, behind the same private-repo guard as
 * every other request, and only when everything in that folder is the
 * vault's own; the vault then stays on this device without its token, so it
 * is not uploaded again.
 *
 * What a web page cannot reach, said plainly: a browser writes files and its
 * storage through its own layers (a fresh copy, then a swap), so overwriting
 * cannot reach blocks the disk had already let go, and an SSD moves data
 * around on its own; the repo keeps old commits in its history; other devices
 * and downloaded backups keep their own copies. All of those are AES-256-GCM
 * ciphertext sealed with the master password (PBKDF2-SHA256, 1,200,000
 * rounds): without the password they cannot be read.
 *
 * Main functions: askDeleteVault, deleteVaultFromRepo, eraseVaultHere,
 * forgetDeletedVault.
 * Auxiliary functions: deleteRepoVaultOnce, vaultMediaIds, eraseFolder,
 * overwriteFile, randomBytes, randomText, reloadPage.
 *
 * Complexity: erasing is O(b) in the vault's bytes, each written over once;
 * the repo takes five requests plus O(t) over its tree.
 */
"use strict";

// What each choice says before it runs, and on the lock screen afterwards.
const DELETE_PLACES = {
  local: {
    confirm: "\"{0}\" will be deleted from this device: its copy in this browser, its attachments and its folder " +
      "next to index.html. Its copy in the repo stays.",
    done: "Vault deleted from this device.",
  },
  repo: {
    confirm: "\"{0}\" will be deleted from the repo. It stays on this device, without its GitHub token, so it is " +
      "not uploaded again.",
    done: "Vault deleted from the repo.",
  },
  both: {
    confirm: "\"{0}\" will be deleted from this device and from the repo.",
    done: "Vault deleted from this device and the repo.",
  },
};

// The files a vault's folder may hold, relative to it: anything else there
// means the folder is not only the vault's, and the repo is left alone.
const VAULT_FILE = /^(vault\.enc|vault\.enc\.js|backup-(weekly|monthly)\.enc\.js|media\/[^/]+)$/;

// Random bytes are written in pieces of this size, so a large attachment
// never needs its whole size in memory at once.
const ERASE_CHUNK = 1 << 20;

// ---------- Asking ----------

/**
 * The "Delete vault" button: asks where to delete the open vault from, then
 * asks once more, then deletes. The repo goes first, since it needs the
 * token from inside the vault; if it fails, nothing else is touched. A save
 * still waiting is dropped and one under way finishes first, so nothing is
 * written back after the vault is gone. When this device's copy goes, the
 * page reloads onto another vault (or none), with a line saying what was
 * deleted.
 *
 * Used by: this file (the button, on load).
 * Uses: showModal and confirmModal (modal.js), status (pagination.js),
 * askAppDirAccess (vaults.js), saveTimer (events.js), persistChain,
 * vaultFileChain and persistLocal (vault.js), deleteVaultFromRepo,
 * vaultMediaIds, eraseVaultHere, forgetDeletedVault, reloadPage.
 * Complexity: that of deleteVaultFromRepo and eraseVaultHere.
 */
async function askDeleteVault() {
  if (!vault || syncing || backupView || !selectedVault) {
    return;
  }
  const name = selectedVault.name;
  const choice = await showModal({
    title: `Delete "${name}"?`,
    body: "Choose where to delete it from. Each file is overwritten with random bytes before it is removed, and " +
      "nothing can bring it back. Whatever is left elsewhere (another device, a downloaded backup, the repo's " +
      "history) stays sealed with your master password.",
    choices: [
      { id: "local", label: "Delete locally", danger: true },
      { id: "repo", label: "Delete repo", danger: true },
      { id: "both", label: "Delete locally & repo", danger: true },
      { id: "cancel", label: "Cancel" },
    ],
    defaultId: "cancel",
    actionsClass: "three-and-cancel",
  });
  const place = DELETE_PLACES[choice];
  if (!place || !vault) {
    return;
  }
  if (choice !== "local" && !vault.token) {
    status("This vault has no GitHub token, so its copy in the repo cannot be reached.", true);
    return;
  }
  const sure = await confirmModal({
    title: "This cannot be undone",
    body: place.confirm.replace("{0}", name),
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!sure || !vault || syncing) {
    return;
  }
  if (choice !== "repo") {
    // Asked while this click still counts: the folder's permission prompt needs one.
    await askAppDirAccess();
  }

  const dir = selectedVault.dir;
  clearTimeout(saveTimer);
  unsavedEdits = false;
  await persistChain;
  await vaultFileChain;
  syncing = true;
  try {
    if (choice !== "local") {
      status("Deleting the vault from the repo...", false, true);
      await deleteVaultFromRepo(dir);
    }
    if (choice === "repo") {
      vault.token = "";
      await persistLocal(false);
      status(place.done);
      return;
    }
    status("Erasing the vault from this device...", false, true);
    await eraseVaultHere(dir, vaultMediaIds());
    forgetDeletedVault(dir, place.done);
    reloadPage();
  } catch (error) {
    status(`Could not delete the vault from the repo: ${error.message}`, true);
  } finally {
    syncing = false;
  }
}

// ---------- Deleting ----------

/**
 * Removes the vault's folder from the repository, trying again (after 1.5 s,
 * then 3 s) when someone pushed in between (422: the branch only moves
 * forward) or the connection dropped. Trying again is safe: a delete whose
 * answer was lost already landed, and finds nothing left. Returns whether
 * there was anything to delete.
 *
 * Used by: this file (askDeleteVault).
 * Uses: deleteRepoVaultOnce.
 * Complexity: at most three tries.
 */
async function deleteVaultFromRepo(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deleteRepoVaultOnce(dir);
    } catch (error) {
      if (!(error.status === 422 || error instanceof TypeError) || attempt >= 2) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

/**
 * Erases the vault from this device: every localStorage value it owns, its
 * attachments in IndexedDB, and its folder next to index.html (when access
 * is granted; the old top-level vault's own files and media/ for a vault
 * without a folder). Each piece is overwritten with random bytes of the same
 * length before it is removed. Returns whether the folder could be reached.
 *
 * Used by: this file (askDeleteVault).
 * Uses: VAULT_KEYS, LEGACY_FILES and grantedAppDir (vaults.js), idbGet,
 * idbPut and idbDelete (vault.js), eraseFolder, overwriteFile, randomBytes,
 * randomText.
 * Complexity: O(b) in the vault's bytes.
 */
async function eraseVaultHere(dir, mediaIds) {
  for (const key of VAULT_KEYS) {
    const stored = dir ? key + "@" + dir : key;
    const value = localStorage.getItem(stored);
    if (value !== null) {
      localStorage.setItem(stored, randomText(value.length));
      localStorage.removeItem(stored);
    }
  }

  for (const id of mediaIds) {
    const record = await idbGet(id).catch(() => null);
    if (record && record.bytes) {
      await idbPut(id, randomBytes(record.bytes.byteLength || 0)).catch(() => {});
    }
    await idbDelete(id).catch(() => {});
  }

  const root = await grantedAppDir();
  if (!root) {
    return false;
  }
  if (dir) {
    const folder = await root.getDirectoryHandle(dir).catch(() => null);
    if (folder) {
      await eraseFolder(folder);
      await root.removeEntry(dir, { recursive: true }).catch(() => {});
    }
    return true;
  }
  for (const file of LEGACY_FILES) {
    const handle = await root.getFileHandle(file).catch(() => null);
    if (handle) {
      await overwriteFile(handle);
      await root.removeEntry(file).catch(() => {});
    }
  }
  const media = await root.getDirectoryHandle("media").catch(() => null);
  if (media) {
    await eraseFolder(media);
    await root.removeEntry("media", { recursive: true }).catch(() => {});
  }
  return true;
}

/**
 * Takes a deleted vault off this device's list and selects the most recent
 * open vault left (or none), and leaves a line for the lock screen the page
 * reloads into.
 *
 * Used by: this file (askDeleteVault).
 * Uses: knownVaults (vaults.js).
 * Complexity: O(v log v).
 */
function forgetDeletedVault(dir, message) {
  const known = knownVaults();
  const name = Object.keys(known).find(other => known[other].dir === dir);
  if (name !== undefined) {
    delete known[name];
  }
  localStorage.setItem("vaults", JSON.stringify(known));
  const next = Object.keys(known).filter(other => !known[other].closed)
    .sort((a, b) => (known[b].at || 0) - (known[a].at || 0))[0];
  if (next === undefined) {
    localStorage.removeItem("vaultSel");
  } else {
    localStorage.setItem("vaultSel", JSON.stringify({ name: next, dir: known[next].dir }));
  }
  sessionStorage.setItem("vaultDeleted", message);
}

// ---------- On load ----------

$("delete-vault").onclick = askDeleteVault;

// The lock screen a deletion reloaded into says, once, what was deleted.
if (sessionStorage.getItem("vaultDeleted")) {
  $("lock-msg").style.color = "var(--t3)";
  $("lock-msg").textContent = sessionStorage.getItem("vaultDeleted");
  sessionStorage.removeItem("vaultDeleted");
}

// =================== Auxiliary functions ===================

/**
 * One commit on the default branch that removes every file of the vault in
 * this folder (or, for the old top-level vault, its own files and media/).
 * Refused, with nothing changed, when the folder holds anything that is not
 * a vault file: then it is not only the vault's. A repository too large for
 * one tree listing is refused too. Returns whether there was anything to
 * delete.
 *
 * Complexity: five requests, plus O(t) over the repository's tree.
 */
async function deleteRepoVaultOnce(dir) {
  const branch = (await ensurePrivateRepo()).default_branch || "main";
  const head = (await ghGit("GET", "git/ref/heads/" + encodeURIComponent(branch))).object.sha;
  const commit = await ghGit("GET", "git/commits/" + head);
  const tree = await ghGit("GET", "git/trees/" + commit.tree.sha + "?recursive=1");
  if (tree.truncated) {
    throw new Error("the repo is too large to change in one step");
  }
  const blobs = tree.tree.filter(entry => entry.type === "blob");
  let owned;
  if (dir) {
    owned = blobs.filter(entry => entry.path.startsWith(dir + "/"));
    if (owned.some(entry => !VAULT_FILE.test(entry.path.slice(dir.length + 1)))) {
      throw new Error("its folder holds files that are not the vault's, so nothing was deleted");
    }
  } else {
    owned = blobs.filter(entry => LEGACY_FILES.includes(entry.path) || /^media\/[^/]+$/.test(entry.path));
  }
  if (!owned.length) {
    return false;
  }
  const changes = owned.map(entry => ({ path: entry.path, mode: entry.mode, type: "blob", sha: null }));
  const newTree = await ghGit("POST", "git/trees", { base_tree: commit.tree.sha, tree: changes });
  const message = dir ? `Delete the vault in ${dir}/` : "Delete the vault at the top level";
  const newCommit = await ghGit("POST", "git/commits", { message, tree: newTree.sha, parents: [head] });
  await ghGit("PATCH", "git/refs/heads/" + encodeURIComponent(branch), { sha: newCommit.sha });
  return true;
}

/** Every attachment id the open vault refers to, in its notes and in its trash. Complexity: O(n). */
function vaultMediaIds() {
  const ids = new Set();
  for (const note of Object.values(vault.notes)) {
    for (const item of note.media || []) {
      ids.add(item.id);
    }
  }
  for (const entry of Object.values(vault.trash)) {
    for (const item of (entry.data && entry.data.media) || []) {
      ids.add(item.id);
    }
  }
  return ids;
}

/** Overwrites every file in a folder and its subfolders with random bytes. Complexity: O(b) in their bytes. */
async function eraseFolder(folder) {
  for await (const [, handle] of folder.entries()) {
    if (handle.kind === "file") {
      await overwriteFile(handle);
    } else {
      await eraseFolder(handle);
    }
  }
}

/**
 * Writes random bytes over a file, as many as it holds, a piece at a time.
 * Best effort: a file that cannot be written is still removed afterwards.
 * Complexity: O(size).
 */
async function overwriteFile(handle) {
  try {
    const size = (await handle.getFile()).size;
    const writable = await handle.createWritable();
    for (let position = 0; position < size; position += ERASE_CHUNK) {
      await writable.write(randomBytes(Math.min(ERASE_CHUNK, size - position)));
    }
    await writable.close();
  } catch {}
}

/** This many random bytes (getRandomValues fills at most 64 KB at a time). Complexity: O(n). */
function randomBytes(length) {
  const bytes = new Uint8Array(length);
  for (let start = 0; start < length; start += 65536) {
    crypto.getRandomValues(bytes.subarray(start, Math.min(length, start + 65536)));
  }
  return bytes;
}

/** Random text of this length, to write over a stored value before removing it. Complexity: O(n). */
function randomText(length) {
  return toBase64(randomBytes(Math.ceil(length * 3 / 4) + 3)).slice(0, length);
}

/** Reloads the page, onto the vault selected now (the checks replace it to stay on the page). Complexity: O(1). */
function reloadPage() {
  location.reload();
}
