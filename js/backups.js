/*
 * backups.js - the per-device settings, and the weekly and monthly backups:
 * folder access, writing them, viewing one read-only, and the lock screen's
 * backup row.
 *
 * Settings live in plain localStorage under "settings": they hold no note
 * content, and a laptop and a phone sharing one vault may well want
 * different lock times. Only the offered values are accepted when read back,
 * so a hand-edited entry cannot set something odd.
 *
 * A backup is a sealed snapshot of the whole vault, written next to
 * index.html as a script wrapper (so the lock screen finds and reads it on
 * file:// exactly like vault.enc.js) and pushed to the repository, so a
 * destroyed device still has a copy in the cloud. Sealing is the vault's own
 * encryption: AES-256-GCM with a fresh random IV under the key derived from
 * the master password (about 20 ms per 500 KB); only the time it was taken
 * ("at") is plain text, since its age must be readable before unlock.
 * Guessing the password of a backup file costs a full PBKDF2 (1,200,000
 * rounds) per guess, as for the vault.
 *
 * Main functions: updateBackup, promptDueBackups, renderBackupBar,
 * enterBackupView, refreshLockBackupRow, notesDirHandle, writeFolderFile,
 * appFolderInfo.
 * Auxiliary functions: saveSettings, formatMinutes, formatDays,
 * backupWrapper, backupAt, backupZone, formatAge, startInFor, dirHasFile.
 *
 * Complexity: a backup is one seal of the vault (O(n)) and two requests.
 */
"use strict";

// ---------- State: settings ----------

// Defined here, above the backups, because backupZone reads the reminder limits.
// The lock times offered, in minutes (0 is never), and the days after which
// each backup counts as overdue, so unlocking asks to update it.
const AUTOLOCK_CHOICES = [0, 1, 2, 5, 10, 15, 30, 60];
const BACKUP_DAY_CHOICES = { weekly: [1, 2, 3, 5, 7, 10, 14], monthly: [14, 21, 30, 45, 60, 90] };

// The defaults: lock after 10 idle minutes, ask for the weekly backup after
// 7 days and the monthly after 30. A stored value is only taken if it is one
// of the choices offered; anything else keeps the default.
let settings = { autoLockMin: 10, weeklyDays: 7, monthlyDays: 30 };
try {
  const saved = JSON.parse(localStorage.getItem("settings"));
  if (saved && AUTOLOCK_CHOICES.includes(saved.autoLockMin)) {
    settings.autoLockMin = saved.autoLockMin;
  }
  if (saved && BACKUP_DAY_CHOICES.weekly.includes(saved.weeklyDays)) {
    settings.weeklyDays = saved.weeklyDays;
  }
  if (saved && BACKUP_DAY_CHOICES.monthly.includes(saved.monthlyDays)) {
    settings.monthlyDays = saved.monthlyDays;
  }
} catch {}

// ---------- State: backups ----------

// Each kind's file and script variable, and where its age pill turns yellow
// and orange, as fractions of the overdue limit (3 and 4 of 7 days, 12 and 18
// of 30 at the defaults), so they scale when Settings changes the limit.
const BACKUP_KINDS = {
  weekly:  { file: "backup-weekly.enc.js",  varName: "__BACKUP_WEEKLY__",  zones: [3 / 7, 4 / 7] },
  monthly: { file: "backup-monthly.enc.js", varName: "__BACKUP_MONTHLY__", zones: [0.4, 0.6] },
};

// The backup chosen on the lock screen, for the next unlock to open.
let pendingBackupKind = null;

// When each backup was last written from this browser.
let backupMeta = { weeklyAt: 0, monthlyAt: 0 };
try {
  const meta = JSON.parse(localStorage.getItem(vaultStorageKey("backupMeta")));
  if (meta) {
    backupMeta = { ...backupMeta, ...meta };
  }
} catch {}

// The age pill's colours: safe, normal, danger, unsafe.
const BACKUP_AGE_COLORS = ["#7c6", "#dc5", "#e83", "#e55"];

// The folder ids the directory picker understands as a starting place.
const WELL_KNOWN_DIRS = ["documents", "desktop", "downloads", "pictures", "music", "videos"];

// Whether a backup is being written (one at a time).
let backupBusy = false;

// ---------- Writing a backup ----------

/**
 * Writes the weekly or monthly backup: the vault sealed into a script
 * wrapper in the vault's own folder (or downloaded, to be moved there), then
 * pushed to the repository (a failed push is a warning, never a rollback:
 * the local file exists). The folder is asked for first, while the click's
 * permission is still fresh: the picker refuses once it expires, and sealing
 * the vault in between is exactly the kind of delay that spends it. Not
 * during a sync, in a backup, or while another backup is being written.
 *
 * Used by: this file (the backup buttons, promptDueBackups).
 * Uses: flushSave and status (pagination.js), inVaultFolder (vaults.js),
 * notesDirHandle, sealVault and vaultStorageKey (core.js), writeFolderFile,
 * gh (sync.js), vaultPath (core.js), renderBackupBar, appFolderInfo.
 * Complexity: one seal (about 20 ms per 500 KB) and two requests.
 */
async function updateBackup(kind) {
  if (!vault || syncing || backupView || backupBusy) {
    return;
  }
  backupBusy = true;
  try {
    flushSave();
    const info = BACKUP_KINDS[kind];
    const dir = await inVaultFolder(await notesDirHandle());
    const at = Date.now();
    status(`Sealing ${kind} backup...`, false, true);
    const text = `window.${info.varName} = ${JSON.stringify({ at, data: await sealVault() })};`;
    const how = await writeFolderFile(info.file, text, dir);
    backupMeta[kind + "At"] = at;
    localStorage.setItem(vaultStorageKey("backupMeta"), JSON.stringify(backupMeta));
    let cloud = "";
    if (vault && vault.token) {
      status(`Pushing ${kind} backup to the repo...`, false, true);
      try {
        const res = await gh("GET", null, vaultPath(info.file));
        const sha = res.status === 200 ? (await res.json()).sha : undefined;
        await gh("PUT", { message: kind + " backup", content: btoa(text), sha }, vaultPath(info.file));
        cloud = ", pushed to the repo";
      } catch (error) {
        cloud = `, repo push failed (${error.message})`;
      }
    }
    renderBackupBar();
    const app = appFolderInfo();
    status(`${kind[0].toUpperCase() + kind.slice(1)} backup ` +
      (how === "folder" ? "saved to " + (dir ? dir.name : "the notes folder")
        : `downloaded - move it into ${app ? app.display : "the notes folder"}`) + cloud);
  } finally {
    backupBusy = false;
  }
}

/**
 * At every unlock: asks to update the backups that are overdue (past their
 * limit, or never taken), and does what is chosen. "Not now" just asks again
 * at the next unlock.
 *
 * Used by: lock.js (unlocking, on load).
 * Uses: backupZone, backupAt, formatAge, showModal (modal.js), updateBackup.
 * Complexity: O(1), plus the backups chosen.
 */
async function promptDueBackups() {
  const due = ["weekly", "monthly"].filter(kind => backupZone(kind) === 3);
  if (!due.length) {
    return;
  }
  const line = kind => {
    const at = backupAt(kind);
    return `${kind[0].toUpperCase() + kind.slice(1)}: ` +
      (at ? `${formatAge(at)} old (${new Date(at).toLocaleDateString()})` : "never taken");
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
  if (choice === "weekly" || choice === "both") {
    await updateBackup("weekly");
  }
  if (choice === "monthly" || choice === "both") {
    await updateBackup("monthly");
  }
}

/**
 * Brings the two backup buttons up to date: the age pill (coloured by how
 * overdue it is), and a tooltip with the last time and where it is saved.
 *
 * Used by: this file (updateBackup), lock.js (unlocking, on load), settings.js (openSettings).
 * Uses: backupAt, appFolderInfo, formatAge, backupZone, BACKUP_AGE_COLORS.
 * Complexity: O(1).
 */
function renderBackupBar() {
  for (const kind of ["weekly", "monthly"]) {
    const button = $("bk-" + kind);
    const at = backupAt(kind);
    button.disabled = syncing || !!backupView;
    const app = appFolderInfo();
    button.title = `Update the ${kind} backup now` + (at ? ` - last: ${new Date(at).toLocaleString()}` : " - never taken") +
      (app ? `\nSaved as ${BACKUP_KINDS[kind].file} in ${app.display}, and pushed to the repo` : "");
    const age = button.querySelector(".bk-age");
    age.textContent = formatAge(at);
    age.style.setProperty("--bk", BACKUP_AGE_COLORS[backupZone(kind)]);
  }
}

// ---------- On load: the backup buttons ----------

$("bk-weekly").onclick = () => updateBackup("weekly");
$("bk-monthly").onclick = () => updateBackup("monthly");

// ---------- Viewing a backup read-only ----------

/**
 * Shows the unlocked vault as a read-only backup: a banner says which one
 * and from when, and nothing can be edited or synced.
 *
 * Used by: lock.js (unlocking a backup, on load).
 * Uses: applyReadonly (pagination.js).
 * Complexity: O(1).
 */
function enterBackupView(kind, at) {
  backupView = kind;
  document.body.classList.add("backup-view");
  $("backup-banner").style.display = "flex";
  $("backup-banner-text").textContent =
    `Viewing the ${kind} backup from ${new Date(at).toLocaleString()} - read-only`;
  applyReadonly();
}

// ---------- On load: leaving or converting a backup ----------

$("backup-exit").onclick = () => lockApp();

// "Convert": after asking, the viewed backup replaces this browser's vault
// (sealed under the current key; attachments already here are kept, and
// nothing is pushed until Sync). savedAt stays as the backup recorded it, so
// if the repository is newer the next Sync pulls rather than overwrites. The
// folder's vault.enc and vault.enc.js are refreshed too when there is folder
// access, then the page reloads to unlock the converted vault normally.
$("backup-convert").onclick = async () => {
  if (!backupView || !vault) {
    return;
  }
  const confirmed = await confirmModal({
    title: "Convert this backup to the original file?",
    body: "The vault in this browser is REPLACED by this backup (notes, folders, trash, settings). " +
      "Media bytes already on this device are kept. Nothing is pushed to the repo until you Sync. This cannot be undone.",
    confirmLabel: "Overwrite my vault with this backup", destructive: true,
  });
  if (!confirmed || !backupView || !vault) {
    return;
  }
  status("Converting backup...", false, true);
  const sealed = await sealVault();
  localStorage.setItem(vaultStorageKey("vault"), sealed);
  const dir = await inVaultFolder(await notesDirHandle());
  if (dir) {
    try {
      for (const [name, text] of [[FILE, sealed], [WRAPPER, vaultWrapper(sealed, vault.savedAt)]]) {
        await writeDirFile(dir, name, text);
      }
    } catch {}
  }
  location.reload();
};

// ---------- The lock screen's backup row ----------

// The lock screen's age colours (muted: the lock screen has no colour of its
// own): safe, normal, danger, unsafe.
const LOCK_AGE_COLORS = ["#a9a39a", "#c9a36a", "#c98a5c", "#c96b5c"];

/**
 * Shows the lock screen's backup row when a backup sits beside index.html:
 * one button per backup found, with its age tinted by how overdue it is,
 * the one chosen marked, and a line saying the master password now opens it
 * read-only.
 *
 * Used by: this file (on load, and choosing a backup), lock.js (on load), settings.js (lockApp).
 * Uses: backupWrapper, makeElement (sidebar.js), formatAge, backupZone, LOCK_AGE_COLORS.
 * Complexity: O(1).
 */
function refreshLockBackupRow() {
  const any = backupWrapper("weekly") || backupWrapper("monthly");
  $("backup-row").style.display = any ? "flex" : "none";
  for (const kind of ["weekly", "monthly"]) {
    const button = $("view-" + kind);
    const wrapper = backupWrapper(kind);
    button.style.display = wrapper ? "" : "none";
    if (wrapper) {
      button.textContent = "";
      button.appendChild(makeElement("span", "bk-name", kind === "weekly" ? "View weekly backup" : "View monthly backup"));
      const age = makeElement("span", "bk-age", formatAge(wrapper.at));
      age.style.setProperty("--bk", LOCK_AGE_COLORS[backupZone(kind)]);
      button.appendChild(age);
      button.title = `View the ${kind} backup read-only (taken ${new Date(wrapper.at).toLocaleString()})`;
      button.setAttribute("aria-pressed", pendingBackupKind === kind ? "true" : "false");
    }
    button.classList.toggle("sel", pendingBackupKind === kind);
  }
  $("backup-sel").style.display = pendingBackupKind ? "block" : "none";
  if (pendingBackupKind) {
    $("backup-sel").textContent = `Now enter the master password to view the ${pendingBackupKind} backup (read-only).`;
  }
}

// ---------- On load: choosing a backup on the lock screen ----------

// A click chooses (or unchooses) that backup, and the unlock button then says
// which one it opens. (syncUnlockLabel is not called inside
// refreshLockBackupRow: that first runs while the page loads, before lock.js exists.)
$("view-weekly").onclick = () => {
  pendingBackupKind = pendingBackupKind === "weekly" ? null : "weekly";
  refreshLockBackupRow();
  syncUnlockLabel();
};
$("view-monthly").onclick = () => {
  pendingBackupKind = pendingBackupKind === "monthly" ? null : "monthly";
  refreshLockBackupRow();
  syncUnlockLabel();
};
refreshLockBackupRow();

// ---------- Folder access ----------

/**
 * The notes folder's handle with write access, or null. The handle is
 * remembered in IndexedDB (under a key that can never be a media id, those
 * being UUIDs). Without it, or without permission, the picker opens (both
 * need a click), where Chrome last confirmed it, starting near this app's
 * folder the first time. A folder that does not hold this app's index.html
 * is confirmed first: a wrong folder fails silently and late (backups saved
 * where the lock screen never looks). If IndexedDB refuses to remember it,
 * the folder just chosen is still used for this write.
 *
 * Used by: this file (updateBackup, converting a backup), lock.js (on load),
 * vaults.js (offerVaultMove, scanVaults).
 * Uses: idbGet and idbPut (vault.js), appFolderInfo, startInFor, dirHasFile, confirmModal (modal.js).
 * Complexity: O(1), besides the picker.
 */
async function notesDirHandle() {
  if (!("showDirectoryPicker" in window)) {
    return null;
  }
  let handle = null;
  try {
    const record = await idbGet("__notesDir__");
    handle = (record && record.bytes) || null;
  } catch {}
  const app = appFolderInfo();
  try {
    if (handle) {
      if (await handle.queryPermission({ mode: "readwrite" }) === "granted") {
        return handle;
      }
      if (await handle.requestPermission({ mode: "readwrite" }) === "granted") {
        return handle;
      }
    }
    handle = await window.showDirectoryPicker({ id: "notes-folder", mode: "readwrite", startIn: startInFor(app) });
    if (app && !await dirHasFile(handle, app.file)) {
      const confirmed = await confirmModal({
        title: "That is not the notes folder",
        body: `Backups belong next to ${app.file}, in:\n${app.display}\n\n` +
          `"${handle.name}" does not contain ${app.file}, so backups saved there will NOT be offered at the login screen. Use it anyway?`,
        confirmLabel: "Use this folder anyway",
      });
      if (!confirmed) {
        return null;
      }
    }
    try {
      await idbPut("__notesDir__", handle);
    } catch {}
    return handle;
  } catch {
    // Cancelled, or blocked on this origin.
    return null;
  }
}

/**
 * Writes a text file into a folder and returns "folder", or, without a
 * folder (or when writing fails), downloads it (to be moved next to
 * index.html by hand) and returns "download".
 *
 * Used by: this file (updateBackup).
 * Uses: downloadPlain (attachments.js).
 * Complexity: O(n) in the text.
 */
async function writeFolderFile(name, text, dir) {
  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
      return "folder";
    } catch {}
  }
  downloadPlain(name, "text/javascript", text);
  return "download";
}

/**
 * The folder this page was opened from: { dir, file, name, display }, or
 * null over http. It is the default place for backups, since a backup is
 * only found by the lock screen beside index.html. A page cannot get its own
 * folder as a handle (no API grants that), so the picker is opened as close
 * to it as the platform allows and the pick is checked against this path.
 * display is a Windows path (C:\...) where it is one.
 *
 * Used by: this file (renderBackupBar, notesDirHandle, updateBackup),
 * settings.js (openSettings), updates.js (appDirHandle, offerAppUpdate).
 * Uses: nothing.
 * Complexity: O(n) in the path.
 */
function appFolderInfo() {
  if (location.protocol !== "file:") {
    return null;
  }
  const full = decodeURIComponent(location.pathname).replace(/^\/+/, "");
  const cut = full.lastIndexOf("/");
  if (cut < 0) {
    return null;
  }
  const dir = full.slice(0, cut);
  return {
    dir, file: full.slice(cut + 1) || "index.html",
    name: dir.slice(dir.lastIndexOf("/") + 1),
    display: /^[a-z]:/i.test(dir) ? dir.replace(/\//g, "\\") : "/" + dir,
  };
}

// =================== Auxiliary functions ===================

/** Saves the settings. Used by settings.js. Complexity: O(1). */
function saveSettings() {
  localStorage.setItem("settings", JSON.stringify(settings));
}

/** A lock time for people: "Never", "1 minute", "5 minutes", "1 hour". Used by settings.js. Complexity: O(1). */
function formatMinutes(minutes) {
  return (minutes === 0 ? "Never" : minutes === 60 ? "1 hour" : minutes === 1 ? "1 minute" : minutes + " minutes");
}

/** A number of days for people: "1 day", "7 days". Used by settings.js. Complexity: O(1). */
function formatDays(days) {
  return (days === 1 ? "1 day" : days + " days");
}

/** The backup script found beside index.html ({ at, data }), or null. Also used by lock.js. Complexity: O(1). */
function backupWrapper(kind) {
  const wrapper = window[BACKUP_KINDS[kind].varName];
  return (wrapper && typeof wrapper === "object" && typeof wrapper.at === "number" && typeof wrapper.data === "string")
    ? wrapper : null;
}

/**
 * When a backup was last taken: the file in the folder is the truth, and
 * localStorage covers a downloaded backup (saved elsewhere) and one just
 * written (the script variable is then stale). Complexity: O(1).
 */
function backupAt(kind) {
  const wrapper = backupWrapper(kind);
  return Math.max(wrapper ? wrapper.at : 0, backupMeta[kind + "At"] || 0);
}

/**
 * How overdue a backup is: 0 safe, 1 normal, 2 danger, 3 unsafe (past the
 * limit chosen in Settings, or never taken). Complexity: O(1).
 */
function backupZone(kind) {
  const at = backupAt(kind);
  if (!at) {
    return 3;
  }
  const age = Date.now() - at;
  const info = BACKUP_KINDS[kind];
  const limit = settings[kind + "Days"] * 864e5;
  return age >= limit ? 3 : age >= info.zones[1] * limit ? 2 : age >= info.zones[0] * limit ? 1 : 0;
}

/**
 * A backup's age for its pill: "now", "5h", "3d", or "none" (shorter than
 * "never" in the sidebar's narrow pill; the red and the tooltip carry the
 * meaning). Complexity: O(1).
 */
function formatAge(at) {
  if (!at) {
    return "none";
  }
  const hours = Math.floor((Date.now() - at) / 36e5);
  if (hours < 1) {
    return "now";
  }
  if (hours < 24) {
    return hours + "h";
  }
  return Math.floor(hours / 24) + "d";
}

/**
 * Where to start the picker for a folder: startIn accepts only well-known
 * ids or a handle, never a path, so the nearest well-known folder above it.
 * Also used by updates.js. Complexity: O(n) in the path.
 */
function startInFor(app) {
  if (!app) {
    return undefined;
  }
  const path = ("/" + app.dir + "/").toLowerCase();
  return WELL_KNOWN_DIRS.find(dir => path.includes("/" + dir + "/"));
}

/** Whether a folder holds a file of that name. Also used by updates.js. Complexity: O(1). */
async function dirHasFile(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}
