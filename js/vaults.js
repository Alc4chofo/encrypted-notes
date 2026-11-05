// notes: Vaults side by side: their folders next to index.html, picking one, making one, and moving the old top-level vault into its folder.
"use strict";

// ---------- Which vaults there are ----------
// The vaults this device knows, with each one's folder and when it last
// changed: { name: { dir, at } }. Plain localStorage: names and times, nothing
// from inside a vault.
function knownVaults() {
  try { const v = JSON.parse(localStorage.getItem("vaults")); if (v && typeof v === "object") return v; } catch {}
  return {};
}
function rememberVault(name, dir, at) {
  const v = knownVaults();
  v[name] = { dir, at: Math.max(+at || 0, (v[name] && v[name].at) || 0) };
  localStorage.setItem("vaults", JSON.stringify(v));
}
// The vault this device opens. Switching is a reload: every per-vault value
// (its sync bookkeeping, its backups) is then read fresh for the new one.
function selectVault(name, dir) {
  vaultSel = { name, dir };
  localStorage.setItem("vaultSel", JSON.stringify(vaultSel));
  rememberVault(name, dir, 0);
}
// For a vault made in this page: nothing of the previous one may carry over.
function resetVaultState() {
  syncMeta = { lastSyncedAt: null, syncedSavedAt: 0, remoteSha: null,
    noteMtimes: {}, folderMtimes: {}, trashSeen: {}, mediaSynced: {} };
  pullBanner = null;
  backupMeta = { weeklyAt: 0, monthlyAt: 0 };
  lastSyncError = null;
}
const legacyVaultHere = () => !!legacyBlob || !!localStorage.getItem("vault") || !!(vaultSel && !vaultSel.dir);
// A vault's name is its folder's name too, next to index.html and in the repo:
// letters, digits, spaces and . _ -, and never one of the app's own folders.
function vaultNameProblem(name) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name))
    return "Use up to 40 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.";
  const low = name.toLowerCase();
  if (["css", "js", "media"].includes(low)) return "That name is taken by one of the app's own folders.";
  if (low === LEGACY_VAULT.toLowerCase() && legacyVaultHere()) return "\"Main\" is kept for the vault that is already here.";
  if (Object.keys(knownVaults()).some(n => n.toLowerCase() === low)) return "There is already a vault with that name.";
  return null;
}
// "4 Nov 2026, 19:14" in the app's language.
const fmtWhen = at => new Date(at).toLocaleString(LANG, { dateStyle: "medium", timeStyle: "short" });

// ---------- The vault's folder on disk ----------
// The app folder only when access is already granted: saving must never open a prompt.
async function grantedAppDir() {
  if (!("showDirectoryPicker" in window)) return null;
  try {
    const rec = await idbGet("__notesDir__");
    const h = rec && rec.bytes;
    return h && await h.queryPermission({ mode: "readwrite" }) === "granted" ? h : null;
  } catch { return null; }
}
// Asked once per unlock - pressing Unlock is the gesture it needs - so the
// vault's folder can be written from then on. Never opens the folder picker.
async function askAppDirAccess() {
  try {
    const rec = await idbGet("__notesDir__");
    if (rec && rec.bytes) await rec.bytes.requestPermission({ mode: "readwrite" });
  } catch {}
}
// The selected vault's own folder inside the app folder, made if missing. The
// old top-level vault's "folder" is the app folder itself.
async function inVaultFolder(root) {
  if (!root || !vaultSel || !vaultSel.dir) return root;
  try { return await root.getDirectoryHandle(vaultSel.dir, { create: true }); } catch { return null; }
}
// For saving as you go: only a vault in a folder, only with access already given.
async function vaultFolder() {
  if (!vaultSel || !vaultSel.dir) return null;
  return inVaultFolder(await grantedAppDir());
}
async function writeDirFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
// The wrapper a page opened from a file can read by <script> (fetch is blocked
// there). `at` is plaintext, like a backup's, so the lock screen can say when
// the vault last changed before it is unlocked.
const vaultWrapper = (sealed, at) => `window.__VAULT__ = ${sealed};\nwindow.__VAULT_AT__ = ${+at || 0};`;
// After every save: the vault's folder holds the same ciphertext as this browser.
async function saveVaultFiles(sealed, at) {
  const dir = await vaultFolder();
  if (!dir) return;
  await writeDirFile(dir, FILE, sealed);
  await writeDirFile(dir, WRAPPER, vaultWrapper(sealed, at));
}
// Attachments, still encrypted, in the vault's media folder: written when they
// arrive, read before downloading, removed when purged. Best effort throughout.
async function vaultMediaDir() {
  const dir = await vaultFolder();
  try { return dir && await dir.getDirectoryHandle("media", { create: true }); } catch { return null; }
}
async function saveMediaFile(id, bytes) {
  const dir = await vaultMediaDir();
  if (dir) try { await writeDirFile(dir, id, bytes); } catch {}
}
async function loadMediaFile(id) {
  const dir = await vaultMediaDir();
  try { return dir ? await (await (await dir.getFileHandle(id)).getFile()).arrayBuffer() : null; } catch { return null; }
}
async function removeMediaFile(id) {
  const dir = await vaultMediaDir();
  if (dir) try { await dir.removeEntry(id); } catch {}
}
// The vaults in the app folder: every folder holding a vault.enc(.js), plus the
// old top-level one. Asks for the folder (picker or prompt) when needed.
async function scanVaults() {
  const root = await notesDirHandle();
  if (!root) return false;
  const stamp = async (dir, name) => { try { return (await (await dir.getFileHandle(name)).getFile()).lastModified; } catch { return 0; } };
  let folderMain = false;
  for await (const [name, h] of root.entries()) {
    if (h.kind !== "directory" || ["css", "js", "media"].includes(name.toLowerCase())) continue;
    const at = Math.max(await stamp(h, FILE), await stamp(h, WRAPPER));
    if (!at) continue;
    rememberVault(name, name, at);
    if (name === LEGACY_VAULT) folderMain = true;
  }
  const top = Math.max(await stamp(root, FILE), await stamp(root, WRAPPER));
  if (top && !folderMain) rememberVault(LEGACY_VAULT, "", top);
  return true;
}

// ---------- Moving the old top-level vault into its folder ----------
// Before folders, the one vault lived at the top level of the app folder and of
// the repo. Moving it puts every file it owns under "Main/", in three places.
const LEGACY_FILES = [FILE, WRAPPER, "backup-weekly.enc.js", "backup-monthly.enc.js"];
const VAULT_KEYS = ["vault", "vault.prev", "vault.prevAt", "syncMeta", "pullBanner", "backupMeta"];
async function moveVaultToFolder(dir) {
  // The repo first: if that fails nothing else has moved, and the vault stays where it was.
  if (vault.token) await moveRepoVault(dir);
  // This browser: its copy and bookkeeping move under the folder's keys. A save
  // still in flight lands first; from the renames on, nothing is awaited until
  // the vault is selected, so no save can fall between the old keys and the new.
  await persistChain;
  for (const k of VAULT_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) { localStorage.setItem(k + "@" + dir, v); localStorage.removeItem(k); }
  }
  selectVault(LEGACY_VAULT, dir);
  // The app folder, when access is granted (a later save writes the vault there anyway).
  await moveDiskVault(dir).catch(() => {});
}
// One commit: every file of the vault (vault.enc, its wrapper, the backups and
// all of media/) re-pointed into the folder. The files themselves are reused,
// so nothing is uploaded. A file the folder already has (put back at the top by
// an older copy of the app) is only removed: that device's own copy still holds
// its changes, and its next Sync merges them into the folder.
async function moveRepoVault(dir) {
  const branch = (await ensurePrivateRepo()).default_branch || "main";
  for (let attempt = 0; ; attempt++) {
    const head = (await ghGit("GET", "git/ref/heads/" + encodeURIComponent(branch))).object.sha;
    const commit = await ghGit("GET", "git/commits/" + head);
    const tree = await ghGit("GET", "git/trees/" + commit.tree.sha + "?recursive=1");
    if (tree.truncated) throw new Error("the repo is too large to move in one step");
    const have = new Set(tree.tree.map(e => e.path));
    const changes = [];
    for (const e of tree.tree) {
      if (e.type !== "blob" || !(LEGACY_FILES.includes(e.path) || e.path.startsWith("media/"))) continue;
      const to = dir + "/" + e.path;
      if (!have.has(to)) changes.push({ path: to, mode: e.mode, type: "blob", sha: e.sha });
      changes.push({ path: e.path, mode: e.mode, type: "blob", sha: null });
    }
    if (!changes.length) return false;
    const nt = await ghGit("POST", "git/trees", { base_tree: commit.tree.sha, tree: changes });
    const nc = await ghGit("POST", "git/commits", { message: `Move the vault into ${dir}/`, tree: nt.sha, parents: [head] });
    // Fast-forward only: if someone pushed in between, start again from the new head.
    try { await ghGit("PATCH", "git/refs/heads/" + encodeURIComponent(branch), { sha: nc.sha }); return true; }
    catch (e) { if (e.status !== 422 || attempt >= 2) throw e; }
  }
}
// The app folder: the backups and media/ move into the folder (renamed in place
// where the browser can, copied otherwise), the vault itself is written fresh
// there, and the old top-level copies go.
async function moveDiskVault(dir) {
  const root = await grantedAppDir();
  if (!root) return false;
  const to = await root.getDirectoryHandle(dir, { create: true });
  const move = async (from, name, dest) => {
    let fh;
    try { fh = await from.getFileHandle(name); } catch { return; }
    let there = true;
    try { await dest.getFileHandle(name); } catch { there = false; }
    if (!there) {
      if (typeof fh.move === "function") { try { await fh.move(dest); return; } catch {} }
      await writeDirFile(dest, name, await fh.getFile());
    }
    await from.removeEntry(name);
  };
  for (const name of LEGACY_FILES.slice(2)) await move(root, name, to);
  let media = null;
  try { media = await root.getDirectoryHandle("media"); } catch {}
  if (media) {
    const dest = await to.getDirectoryHandle("media", { create: true });
    const names = [];
    for await (const [name, h] of media.entries()) if (h.kind === "file") names.push(name);
    for (let i = 0; i < names.length; i++) {
      if (i % 20 === 0) status(`Moving attachments into the vault's folder (${i}/${names.length})...`, false, true);
      await move(media, names[i], dest);
    }
    try { await root.removeEntry("media"); } catch {}   // only once it is empty
  }
  await saveVaultFiles(await sealVault(), vault.savedAt);
  for (const name of LEGACY_FILES.slice(0, 2)) try { await root.removeEntry(name); } catch {}
  return true;
}
// Offered after unlocking the old top-level vault, until it is moved.
async function offerVaultMove() {
  if (!vault || backupView || !vaultSel || vaultSel.dir) return;
  const ok = await confirmModal({
    title: "Move this vault into its own folder?",
    body: "Every vault now has a folder of its own. This one moves into \"Main\", next to index.html and in the repo. " +
      "Update the app on your other devices first: an older copy would put the vault back at the top level.",
    confirmLabel: "Move it now", cancelLabel: "Later",
  });
  if (!ok || !vault || syncing || vaultSel.dir) return;
  // The click that confirmed is the gesture the folder picker needs, so ask now.
  await notesDirHandle();
  syncing = true;
  setEditingEnabled(false);
  status("Moving the vault into its folder...", false, true);
  try {
    await moveVaultToFolder(LEGACY_VAULT);
    status("Vault moved into its folder \"Main\"");
  } catch (e) {
    status("Could not move the vault: " + e.message, true);
  } finally {
    syncing = false;
    setEditingEnabled(true);
    renderStatus();
  }
}
