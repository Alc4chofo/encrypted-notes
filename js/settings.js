// notes: The Settings dialog, auto-lock and locking.
"use strict";

// ---------- Settings dialog ----------
// The Settings dialog rides on the shared modal machinery (modalOpenCount and
// modalCancel), so Escape closes it and Ctrl+S / Ctrl+L stay quiet while it is
// open, exactly as for every other dialog.
let settingsBack = null;   // the open dialog's backdrop, or null
function openSettings() {
  // Only one at a time, and only while unlocked.
  if (settingsBack || !vault) return;
  const back = mk("div", "modal-back");
  const card = mk("div", "modal settings");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.appendChild(mk("h3", null, "Settings"));
  // One row per setting: name and explanation on the left, the choice on the right.
  // key is the settings field it edits; every change is saved at once, then after() applies it.
  const addRow = (key, name, help, choices, fmt, after) => {
    const row = mk("div", "set-row");
    const words = mk("div", "set-words");
    const label = mk("label", "set-name", name);
    label.htmlFor = "set-" + key;
    words.appendChild(label);
    words.appendChild(mk("div", "set-help", help));
    row.appendChild(words);
    const sel = mk("select");
    sel.id = "set-" + key;
    for (const v of choices) {
      const o = mk("option", null, fmt(v));
      o.value = String(v);
      sel.appendChild(o);
    }
    sel.value = String(settings[key]);
    sel.onchange = () => { settings[key] = Number(sel.value); saveSettings(); after(); };
    row.appendChild(sel);
    card.appendChild(row);
    return sel;
  };
  // A new lock time restarts the idle clock from now, so it never locks the instant it is changed.
  const first = addRow("autoLockMin", "Auto-lock", "Lock the vault after this long with no typing, clicking or scrolling. Unsaved edits are saved first.",
    AUTOLOCK_CHOICES, fmtMinutes, () => { lastActivity = Date.now(); });
  // A new reminder limit recolours the backup pills straight away; the question itself comes at the next unlock.
  addRow("weeklyDays", "Weekly backup reminder", "When you unlock, ask to update the weekly backup once it is this old.",
    BACKUP_DAY_CHOICES.weekly, fmtDays, renderBackupBar);
  addRow("monthlyDays", "Monthly backup reminder", "When you unlock, ask to update the monthly backup once it is this old.",
    BACKUP_DAY_CHOICES.monthly, fmtDays, renderBackupBar);
  // Not a setting: what the lock screen found to show behind it (lock.js), so a
  // video with the wrong name or in the wrong folder says so instead of failing silently.
  const bg = mk("div", "set-row");
  const bgWords = mk("div", "set-words");
  bgWords.appendChild(mk("div", "set-name", "Lock screen background"));
  const bgFile = lockBgFile(), app = appFolderInfo();
  bgWords.appendChild(mk("div", "set-help", !bgFile
    ? `None found. Put a video named lock-background.webm or lock-background.mp4 next to ${app ? app.file : "index.html"}` +
      (app ? `, in ${app.display}` : "") + ", then reload."
    : stillMotion.matches
      ? `${bgFile}, shown still: your system asks for less motion (on Windows: Settings > Accessibility > Visual effects > Animation effects).`
      : `${bgFile}, from the app's folder. It plays, muted, while the lock screen shows.`));
  bg.appendChild(bgWords);
  card.appendChild(bg);
  // Not a setting: which build these files are, and the update check Sync runs (updates.js).
  const ver = mk("div", "set-row");
  const verWords = mk("div", "set-words");
  verWords.appendChild(mk("div", "set-name", "App version"));
  verWords.appendChild(mk("div", "set-help", `Build ${APP_BUILD}. Sync asks before installing a newer build of the app from the repo. ` +
    "Check now also offers one you said no to."));
  ver.appendChild(verWords);
  const check = mk("button", null, "Check now");
  check.type = "button";
  check.disabled = syncing || !!backupView || REPO_UNSET || appUpdateBusy;
  if (REPO_UNSET) check.title = "No repo set: edit owner and repo in config.js";
  check.onclick = () => { closeSettings(); manualAppUpdate(); };
  ver.appendChild(check);
  card.appendChild(ver);
  card.appendChild(mk("p", "set-note", "Settings are saved on this device only."));
  const actions = mk("div", "modal-actions");
  const done = mk("button", "primary", "Done");
  done.type = "button";
  done.onclick = closeSettings;
  actions.appendChild(done);
  card.appendChild(actions);
  back.appendChild(card);
  // A click on the dim backdrop (not inside the card) closes it, like the other dialogs.
  back.addEventListener("mousedown", e => { if (e.target === back) closeSettings(); });
  document.body.appendChild(back);
  settingsBack = back;
  modalOpenCount++;
  modalCancel = closeSettings;
  requestAnimationFrame(() => back.classList.add("show"));
  first.focus();
}
function closeSettings() {
  // Nothing open means nothing to do (Escape and Done can both arrive).
  if (!settingsBack) return;
  const back = settingsBack;
  settingsBack = null;
  modalOpenCount--;
  if (modalCancel === closeSettings) modalCancel = null;
  // Same fade-out as buildModal: stays mounted 140ms with clicks passing through.
  back.classList.remove("show");
  back.classList.add("closing");
  setTimeout(() => back.remove(), 140);
}
$("settings-btn").onclick = openSettings;

// ---------- Auto-lock ----------
// Any input counts as activity. Instead of a timer per event, a check every 15s
// compares the clock with the last activity: that survives background-tab timer
// throttling and a laptop waking from sleep (the first check after waking locks
// at once if the limit passed while it slept).
let lastActivity = Date.now();
for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"])
  document.addEventListener(ev, () => { lastActivity = Date.now(); }, { capture: true, passive: true });
function checkIdle() {
  // So first: nothing to lock while locked, and 0 means the user turned auto-lock off.
  if (!vault || !settings.autoLockMin) return;
  // Still inside the allowed idle time: wait for the next check.
  if (Date.now() - lastActivity < settings.autoLockMin * 60000) return;
  autoLock();
}
// Started once every script has loaded, since locking uses the lock screen's code
// (lock.js). Coming back to the tab runs the check straight away instead of up to 15s later.
document.addEventListener("DOMContentLoaded", () => {
  setInterval(checkIdle, 15000);
  document.addEventListener("visibilitychange", checkIdle);
});
async function autoLock() {
  // A running sync is never interrupted; the next check, 15s later, tries again.
  if (syncing) return;
  // An open dialog is cancelled first (its flow treats that as "Cancel"), so nothing waits over the lock screen.
  if (modalCancel) modalCancel();
  // Unsaved edits are saved first, the same as answering "Save and lock" to the manual lock prompt.
  if (dirty) flushSave();
  // force: the save above already answered the prompt lockApp would otherwise wait on.
  await lockApp(true);
  // Only if it really locked: say why, so an unexpected lock screen explains itself.
  if (!vault) {
    $("lock-msg").style.color = "var(--t3)";
    $("lock-msg").textContent = `Locked after ${fmtMinutes(settings.autoLockMin)} without activity.`;
  }
}

// force === true is auto-lock: it has already saved, so the unsaved-changes prompt is skipped. A strict
// === true check, because the Lock button calls this with its click event as the first argument.
// Locking. Drops every decrypted artefact: the vault object, the derived keys, the
// master password and every live blob: URL. The ciphertext in localStorage and
// IndexedDB is untouched, so unlocking again restores everything.
async function lockApp(force) {
  if (syncing) return;
  if (force !== true && dirty && !await confirmModal({
    title: "Lock with unsaved changes?",
    body: "The note you are editing has unsaved changes. Save before locking, or lock and lose them?",
    confirmLabel: "Save and lock",
  }).then(ok => { if (ok) flushSave(); return ok; })) return;
  closeMenu(); closePanel(); closeLightbox(); revokeAllMediaUrls();
  closePalette(true);     // a colour being edited is not worth a question at lock time
  appClip = appDrag = null;   // censored text copied or dragged in the app, kept for pasting back
  closeSettings();        // a dialog must not stay up over the lock screen
  searchTextCache.clear();   // the body-search index is plaintext of every note
  exitSplit(true);        // the reference pane holds plaintext from the open note
  currentPage = 0;
  $("page-tabs").innerHTML = ""; $("page-tabs").style.display = "none";
  $("sheets").innerHTML = "";                      // sheets hold decrypted page content
  document.body.classList.remove("paged-view");
  // Every async decrypt in flight is keyed to one of these generations; bumping
  // both makes each pending continuation abort instead of painting plaintext
  // (a lightbox, a thumbnail, a fresh blob: URL) over the lock screen after the
  // revoke sweep has already run. The `!vault` checks in those paths are the
  // belt to this braces.
  attachSeq++; editorSeq++;
  // Leaving a backup view restores the normal chrome and the lock-screen row.
  backupView = null;
  pendingBackupKind = null;
  document.body.classList.remove("backup-view");
  $("backup-banner").style.display = "none";
  refreshLockBackupRow();
  vault = null; key = null; salt = null; iterUsed = ITER;
  mediaKey = null; mediaKeyRing = [];
  masterPw = null;
  // The undo stacks are whole-note snapshots - up to 30 plaintext copies of
  // every note edited this session. They must not outlive the vault they
  // belong to.
  histories.clear();
  histTypingMarked = false;
  structureDirty = false;
  renderHistoryButtons();
  currentId = null; trashViewId = null; dirty = false;
  deletedTitles = {}; pullDiff = null;
  $("title").value = ""; clearEditor(); $("search").value = ""; searchQuery = "";
  $("notelist").innerHTML = ""; $("trash-list").innerHTML = ""; $("attachments").innerHTML = "";
  // The detail panel is rendered DOM, not a live view: closePanel only drops a
  // CSS class, so without this wipe every note title, folder name and merge-diff
  // title it listed - and any GitHub token typed into its auth-recovery field -
  // stayed readable in the document behind the lock screen.
  $("status-detail").innerHTML = "";
  // A sticky status can hold an attachment filename ("Decrypting invoice.pdf...").
  status("");
  // Session-only, but it survived the lock and kept the panel's destructive
  // "Overwrite remote" row renderable against whatever vault is loaded next.
  lastSyncError = null;
  $("app").style.display = "none";
  $("lock").style.display = "flex";
  syncLockBg();
  setLockMode();          // a vault exists now: never the first-run form again
  $("lock-msg").textContent = "";
  $("password").value = "";
  $("password2").value = "";
  $("token").value = "";
  // The strength meter described the old password; with the field empty it must not linger.
  $("pw-meter").style.display = "none";
  $("password").focus();
}
$("lock-btn").onclick = lockApp;
