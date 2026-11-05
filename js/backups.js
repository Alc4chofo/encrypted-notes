// notes: Per-device settings and the weekly and monthly backups: folder access, writing them, viewing one read-only, the lock-screen row.
"use strict";

// ---------- Settings (per device) ----------
// Kept in plain localStorage under "settings": they hold no note content, and a
// laptop and a phone sharing one vault may well want different lock times.
// Only the listed values are accepted when reading back, so a hand-edited
// entry cannot set something odd like a fraction of a second.
// Defined here, above the backups, because backupZone reads the reminder limits.
const AUTOLOCK_CHOICES = [0, 1, 2, 5, 10, 15, 30, 60];   // minutes; 0 = never
// Days after which each backup counts as overdue, so unlock asks to update it.
const BACKUP_DAY_CHOICES = { weekly: [1, 2, 3, 5, 7, 10, 14], monthly: [14, 21, 30, 45, 60, 90] };
// The defaults: lock after 10 idle minutes, ask for the weekly backup after 7 days and the monthly after 30.
let settings = { autoLockMin: 10, weeklyDays: 7, monthlyDays: 30 };
try {
  const saved = JSON.parse(localStorage.getItem("settings"));
  // So a stored value is only taken if it is one of the offered choices; anything else keeps the default.
  if (saved && AUTOLOCK_CHOICES.includes(saved.autoLockMin)) settings.autoLockMin = saved.autoLockMin;
  if (saved && BACKUP_DAY_CHOICES.weekly.includes(saved.weeklyDays)) settings.weeklyDays = saved.weeklyDays;
  if (saved && BACKUP_DAY_CHOICES.monthly.includes(saved.monthlyDays)) settings.monthlyDays = saved.monthlyDays;
} catch {}
function saveSettings() { localStorage.setItem("settings", JSON.stringify(settings)); }
const fmtMinutes = m => (m === 0 ? "Never" : m === 60 ? "1 hour" : m === 1 ? "1 minute" : m + " minutes");
const fmtDays = d => (d === 1 ? "1 day" : d + " days");

// ---------- Weekly / monthly backups ----------
// Sealed snapshots of the whole vault written next to index.html as script
// wrappers (so the lock screen detects and reads them on file:// exactly like
// vault.enc.js) AND pushed to the repo, so a destroyed device still has a cloud
// copy. Only `at` is plaintext - age must be readable before unlock.
const BACKUP_KINDS = {
  // zones: where the age pill turns yellow and orange, as fractions of the overdue limit (3 and 4 of 7 days,
  // 12 and 18 of 30 at the defaults), so they scale when Settings changes the limit.
  weekly:  { file: "backup-weekly.enc.js",  varName: "__BACKUP_WEEKLY__",  zones: [3 / 7, 4 / 7] },
  monthly: { file: "backup-monthly.enc.js", varName: "__BACKUP_MONTHLY__", zones: [0.4, 0.6] },
};
let pendingBackupKind = null;   // chosen on the lock screen, consumed by unlock
let backupMeta = { weeklyAt: 0, monthlyAt: 0 };
try { const m = JSON.parse(localStorage.getItem(vkey("backupMeta"))); if (m) backupMeta = { ...backupMeta, ...m }; } catch {}

function backupWrapper(kind) {
  const w = window[BACKUP_KINDS[kind].varName];
  return (w && typeof w === "object" && typeof w.at === "number" && typeof w.data === "string") ? w : null;
}
// The file in the folder is truth; localStorage covers the download fallback
// (file saved elsewhere) and the just-written case (the script var is stale).
function backupAt(kind) {
  const w = backupWrapper(kind);
  return Math.max(w ? w.at : 0, backupMeta[kind + "At"] || 0);
}
const BK_COLORS = ["#7c6", "#dc5", "#e83", "#e55"];   // safe / normal / danger / unsafe
function backupZone(kind) {
  const at = backupAt(kind);
  if (!at) return 3;   // never taken = unsafe
  const age = Date.now() - at, k = BACKUP_KINDS[kind];
  // The overdue limit is the user's choice in Settings (settings.weeklyDays / monthlyDays).
  const limit = settings[kind + "Days"] * 864e5;
  return age >= limit ? 3 : age >= k.zones[1] * limit ? 2 : age >= k.zones[0] * limit ? 1 : 0;
}
function fmtAge(at) {
  if (!at) return "none";   // "never" is wider than the pill's share of a 230px sidebar; the red + tooltip carry the meaning
  const h = Math.floor((Date.now() - at) / 36e5);
  if (h < 1) return "now";
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}
function renderBackupBar() {
  for (const kind of ["weekly", "monthly"]) {
    const btn = $("bk-" + kind);
    const at = backupAt(kind);
    btn.disabled = syncing || !!backupView;
    const app = appFolderInfo();
    btn.title = `Update the ${kind} backup now` + (at ? ` - last: ${new Date(at).toLocaleString()}` : " - never taken") +
      (app ? `\nSaved as ${BACKUP_KINDS[kind].file} in ${app.display}, and pushed to the repo` : "");
    const age = btn.querySelector(".bk-age");
    age.textContent = fmtAge(at);
    age.style.setProperty("--bk", BK_COLORS[backupZone(kind)]);
  }
}

// The folder this page itself was opened from - the default backup target,
// because a backup only gets auto-detected at the lock screen when it sits
// beside index.html. A page cannot read its own folder as a handle (no API
// grants that), so the picker is opened as close to it as the platform allows
// and the pick is then verified against this path. Null when served over http.
function appFolderInfo() {
  if (location.protocol !== "file:") return null;
  const full = decodeURIComponent(location.pathname).replace(/^\/+/, "");
  const cut = full.lastIndexOf("/");
  if (cut < 0) return null;
  const dir = full.slice(0, cut);
  return {
    dir, file: full.slice(cut + 1) || "index.html",
    name: dir.slice(dir.lastIndexOf("/") + 1),
    // Windows paths read as C:\... natively; POSIX ones keep their slashes.
    display: /^[a-z]:/i.test(dir) ? dir.replace(/\//g, "\\") : "/" + dir,
  };
}
// startIn only accepts well-known ids or a handle, never a path: land the
// picker in the nearest ancestor it does understand.
const WELL_KNOWN_DIRS = ["documents", "desktop", "downloads", "pictures", "music", "videos"];
function startInFor(app) {
  if (!app) return undefined;
  const p = ("/" + app.dir + "/").toLowerCase();
  return WELL_KNOWN_DIRS.find(d => p.includes("/" + d + "/"));
}
const dirHasFile = async (dir, name) => { try { await dir.getFileHandle(name); return true; } catch { return false; } };

// ---- Folder access (File System Access API), remembered in IDB. The handle
// key can never collide with a media id (those are UUIDs). Interactive only:
// both requestPermission and the picker need a user gesture.
async function notesDirHandle() {
  if (!("showDirectoryPicker" in window)) return null;
  let handle = null;
  try { const rec = await idbGet("__notesDir__"); handle = (rec && rec.bytes) || null; } catch {}
  const app = appFolderInfo();
  try {
    if (handle) {
      if (await handle.queryPermission({ mode: "readwrite" }) === "granted") return handle;
      if (await handle.requestPermission({ mode: "readwrite" }) === "granted") return handle;
    }
    // id: Chrome reopens this picker wherever it was last confirmed, so the
    // folder is only ever chosen once; startIn seeds that first time.
    handle = await window.showDirectoryPicker({ id: "notes-folder", mode: "readwrite", startIn: startInFor(app) });
    // A wrong folder fails silently and late (backups written somewhere the
    // lock screen never looks), so confirm a pick that is not this app's folder.
    if (app && !await dirHasFile(handle, app.file)) {
      const ok = await confirmModal({
        title: "That is not the notes folder",
        body: `Backups belong next to ${app.file}, in:\n${app.display}\n\n` +
          `"${handle.name}" does not contain ${app.file}, so backups saved there will NOT be offered at the login screen. Use it anyway?`,
        confirmLabel: "Use this folder anyway",
      });
      if (!ok) return null;
    }
    // Remembering the pick is a convenience: if IDB refuses, still use the
    // folder the user just chose for THIS write rather than silently
    // downgrading to a download.
    try { await idbPut("__notesDir__", handle); } catch {}
    return handle;
  } catch { return null; }   // cancelled, or blocked on this origin
}

// ---- Writing a backup ----
async function writeFolderFile(name, text, dir) {
  if (dir) {
    try {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return "folder";
    } catch {}
  }
  downloadPlain(name, "text/javascript", text);   // fallback: save it next to index.html yourself
  return "download";
}

let backupBusy = false;
async function updateBackup(kind) {
  if (!vault || syncing || backupView || backupBusy) return;
  backupBusy = true;
  try {
    flushSave();
    const k = BACKUP_KINDS[kind];
    // Resolve the folder FIRST, while the click's user activation is still
    // fresh: showDirectoryPicker refuses once that expires, and sealing the
    // vault in between is exactly the kind of delay that spends it.
    // The backups of a vault live in its own folder, next to its vault.enc.
    const dir = await inVaultFolder(await notesDirHandle());
    const at = Date.now();
    status(`Sealing ${kind} backup...`, false, true);
    const text = `window.${k.varName} = ${JSON.stringify({ at, data: await sealVault() })};`;
    const how = await writeFolderFile(k.file, text, dir);
    backupMeta[kind + "At"] = at;
    localStorage.setItem(vkey("backupMeta"), JSON.stringify(backupMeta));
    // Cloud copy: failure is a warning, never a rollback - the local file exists.
    let cloud = "";
    if (vault && vault.token) {
      status(`Pushing ${kind} backup to the repo...`, false, true);
      try {
        const r = await gh("GET", null, vpath(k.file));
        const sha = r.status === 200 ? (await r.json()).sha : undefined;
        await gh("PUT", { message: kind + " backup", content: btoa(text), sha }, vpath(k.file));
        cloud = ", pushed to the repo";
      } catch (e) { cloud = `, repo push failed (${e.message})`; }
    }
    renderBackupBar();
    const app = appFolderInfo();
    status(`${kind[0].toUpperCase() + kind.slice(1)} backup ` +
      (how === "folder" ? "saved to " + (dir ? dir.name : "the notes folder")
        : `downloaded - move it into ${app ? app.display : "the notes folder"}`) + cloud);
  } finally { backupBusy = false; }
}
$("bk-weekly").onclick = () => updateBackup("weekly");
$("bk-monthly").onclick = () => updateBackup("monthly");

// Every password entry checks the ages; the modal fires only when a backup is
// overdue (limit passed, or never taken). Rejecting just re-asks next unlock.
async function promptDueBackups() {
  const due = ["weekly", "monthly"].filter(k => backupZone(k) === 3);
  if (!due.length) return;
  const line = k => {
    const at = backupAt(k);
    return `${k[0].toUpperCase() + k.slice(1)}: ` + (at ? `${fmtAge(at)} old (${new Date(at).toLocaleDateString()})` : "never taken");
  };
  const choice = await showModal({
    title: "Do you want to update the backup?",
    body: line("weekly") + " - " + line("monthly"),
    choices: [
      ...(due.includes("weekly") ? [{ id: "weekly", label: "Update weekly backup" }] : []),
      ...(due.includes("monthly") ? [{ id: "monthly", label: "Update monthly backup" }] : []),
      ...(due.length === 2 ? [{ id: "both", label: "Update both" }] : []),
      { id: "no", label: "Not now" },
    ],
    defaultId: "no",
  });
  if (choice === "weekly" || choice === "both") await updateBackup("weekly");
  if (choice === "monthly" || choice === "both") await updateBackup("monthly");
}

// ---- Read-only backup view ----
function enterBackupView(kind, at) {
  backupView = kind;
  document.body.classList.add("backup-view");
  $("backup-banner").style.display = "flex";
  $("backup-banner-text").textContent =
    `Viewing the ${kind} backup from ${new Date(at).toLocaleString()} - read-only`;
  applyReadonly();
}
$("backup-exit").onclick = () => lockApp();
$("backup-convert").onclick = async () => {
  if (!backupView || !vault) return;
  const ok = await confirmModal({
    title: "Convert this backup to the original file?",
    body: "The vault in this browser is REPLACED by this backup (notes, folders, trash, settings). " +
      "Media bytes already on this device are kept. Nothing is pushed to the repo until you Sync. This cannot be undone.",
    confirmLabel: "Overwrite my vault with this backup", destructive: true,
  });
  if (!ok || !backupView || !vault) return;
  status("Converting backup...", false, true);
  // Seal the viewed vault under the current key and make it THE vault. savedAt
  // is left as the backup recorded it (restore convention): if the repo is
  // newer, the next Sync pulls rather than clobbers.
  const sealed = await sealVault();
  localStorage.setItem(vkey("vault"), sealed);
  // Refresh the folder copies too when we have folder access, so the vault's
  // vault.enc(.js) match what this browser now opens.
  const dir = await inVaultFolder(await notesDirHandle());
  if (dir) {
    try {
      for (const [name, text] of [[FILE, sealed], [WRAPPER, vaultWrapper(sealed, vault.savedAt)]]) await writeDirFile(dir, name, text);
    } catch {}
  }
  location.reload();   // clean re-entry: unlock the converted vault normally
};

// Lock-screen detection row.
const LOCK_AGE_COLORS = ["#a9a39a", "#c9a36a", "#c98a5c", "#c96b5c"];   // safe / normal / danger / unsafe
function refreshLockBackupRow() {
  const any = backupWrapper("weekly") || backupWrapper("monthly");
  $("backup-row").style.display = any ? "flex" : "none";
  for (const kind of ["weekly", "monthly"]) {
    const b = $("view-" + kind), w = backupWrapper(kind);
    b.style.display = w ? "" : "none";
    if (w) {
      // A row: the name, then the age, tinted by how overdue it is (muted: the lock screen has no colour of its own).
      b.textContent = "";
      b.appendChild(mk("span", "bk-name", kind === "weekly" ? "View weekly backup" : "View monthly backup"));
      const age = mk("span", "bk-age", fmtAge(w.at));
      age.style.setProperty("--bk", LOCK_AGE_COLORS[backupZone(kind)]);
      b.appendChild(age);
      b.title = `View the ${kind} backup read-only (taken ${new Date(w.at).toLocaleString()})`;
      b.setAttribute("aria-pressed", pendingBackupKind === kind ? "true" : "false");
    }
    b.classList.toggle("sel", pendingBackupKind === kind);
  }
  $("backup-sel").style.display = pendingBackupKind ? "block" : "none";
  if (pendingBackupKind)
    $("backup-sel").textContent = `Now enter the master password to view the ${pendingBackupKind} backup (read-only).`;
}
// The button then says which backup it opens. (Not inside refreshLockBackupRow:
// that first runs while the page loads, before the unlock code in lock.js exists.)
$("view-weekly").onclick = () => { pendingBackupKind = pendingBackupKind === "weekly" ? null : "weekly"; refreshLockBackupRow(); syncUnlockLabel(); };
$("view-monthly").onclick = () => { pendingBackupKind = pendingBackupKind === "monthly" ? null : "monthly"; refreshLockBackupRow(); syncUnlockLabel(); };
refreshLockBackupRow();
