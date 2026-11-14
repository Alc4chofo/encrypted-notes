/*
 * settings.js - the Settings dialog, auto-lock, and locking the app.
 *
 * Locking is where every decrypted thing leaves memory: the vault, the keys,
 * the master password, the undo history, every decrypted attachment URL and
 * every panel that showed plaintext. It encrypts nothing by itself: the
 * sealed vault is already stored after every save, so unlocking again brings
 * everything back. Unsaved edits are saved first (asked on a manual Lock,
 * done silently by auto-lock); that save is one seal of the vault.
 *
 * Main functions: openSettings, closeSettings, checkIdle, autoLock, lockApp.
 * Auxiliary functions: none.
 *
 * Complexity: everything here is O(1) apart from what it calls: lockApp's
 * save is O(n) in the vault's size (one seal, about 20 ms for 500 KB) and
 * its teardown is O(u) in the decrypted attachment URLs it revokes.
 */
"use strict";

// ---------- State ----------

// The open Settings dialog's backdrop, or null.
let settingsBack = null;

// ---------- The Settings dialog ----------
// It rides on the shared dialog machinery (modalOpenCount and modalCancel in
// modal.js), so Escape closes it and Ctrl+S and Ctrl+L stay quiet while it is
// open, exactly as for every other dialog.

/**
 * Opens the Settings dialog: auto-lock time and the two backup reminders
 * (each saved the moment it changes), what the lock screen found to show
 * behind it, and the app's build with "Check now" for an update. Only one at
 * a time, and only while unlocked.
 *
 * Used by: this file (the Settings button).
 * Uses: makeElement (sidebar.js), saveSettings, formatMinutes, formatDays,
 * renderBackupBar, appFolderInfo (backups.js), lockBgFile and stillMotion
 * (lock.js), manualAppUpdate (updates.js), closeSettings.
 * Complexity: O(1).
 */
function openSettings() {
  if (settingsBack || !vault) {
    return;
  }

  const back = makeElement("div", "modal-back");
  const card = makeElement("div", "modal settings");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.appendChild(makeElement("h3", null, "Settings"));

  // One row per setting: name and explanation on the left, the choice on the
  // right. key is the settings field it edits; every change is saved at once,
  // then after() applies it.
  const addRow = (key, name, help, choices, format, after) => {
    const row = makeElement("div", "set-row");
    const words = makeElement("div", "set-words");
    const label = makeElement("label", "set-name", name);
    label.htmlFor = "set-" + key;
    words.appendChild(label);
    words.appendChild(makeElement("div", "set-help", help));
    row.appendChild(words);

    const select = makeElement("select");
    select.id = "set-" + key;
    for (const value of choices) {
      const option = makeElement("option", null, format(value));
      option.value = String(value);
      select.appendChild(option);
    }
    select.value = String(settings[key]);
    select.onchange = () => {
      settings[key] = Number(select.value);
      saveSettings();
      after();
    };
    row.appendChild(select);
    card.appendChild(row);
    return select;
  };

  // A new lock time restarts the idle clock from now, so it never locks the instant it changes.
  const first = addRow("autoLockMin", "Auto-lock",
    "Lock the vault after this long with no typing, clicking or scrolling. Unsaved edits are saved first.",
    AUTOLOCK_CHOICES, formatMinutes, () => {
      lastActivity = Date.now();
    });
  // A new reminder limit recolours the backup pills at once; the question itself comes at the next unlock.
  addRow("weeklyDays", "Weekly backup reminder", "When you unlock, ask to update the weekly backup once it is this old.",
    BACKUP_DAY_CHOICES.weekly, formatDays, renderBackupBar);
  addRow("monthlyDays", "Monthly backup reminder", "When you unlock, ask to update the monthly backup once it is this old.",
    BACKUP_DAY_CHOICES.monthly, formatDays, renderBackupBar);

  // Not a setting: what the lock screen found to show behind it (lock.js), so
  // a video with the wrong name or in the wrong folder says so instead of
  // failing silently.
  const background = makeElement("div", "set-row");
  const backgroundWords = makeElement("div", "set-words");
  backgroundWords.appendChild(makeElement("div", "set-name", "Lock screen background"));
  const backgroundFile = lockBgFile();
  const app = appFolderInfo();
  backgroundWords.appendChild(makeElement("div", "set-help", !backgroundFile
    ? `None found. Put a video named lock-background.webm or lock-background.mp4 next to ${app ? app.file : "index.html"}` +
      (app ? `, in ${app.display}` : "") + ", then reload."
    : stillMotion.matches
      ? `${backgroundFile}, shown still: your system asks for less motion (on Windows: Settings > Accessibility > Visual effects > Animation effects).`
      : `${backgroundFile}, from the app's folder. It plays, muted, while the lock screen shows.`));
  background.appendChild(backgroundWords);
  card.appendChild(background);

  // Not a setting either: which build these files are, and the update check
  // Sync runs (updates.js).
  const version = makeElement("div", "set-row");
  const versionWords = makeElement("div", "set-words");
  versionWords.appendChild(makeElement("div", "set-name", "App version"));
  versionWords.appendChild(makeElement("div", "set-help",
    `Build ${APP_BUILD}. Sync asks before installing a newer build of the app from the repo. ` +
    "Check now also offers one you said no to."));
  version.appendChild(versionWords);
  const check = makeElement("button", null, "Check now");
  check.type = "button";
  check.disabled = syncing || !!backupView || REPO_UNSET || appUpdateBusy;
  if (REPO_UNSET) {
    check.title = "No repo set: edit owner and repo in config.js";
  }
  check.onclick = () => {
    closeSettings();
    manualAppUpdate();
  };
  version.appendChild(check);
  card.appendChild(version);

  card.appendChild(makeElement("p", "set-note", "Settings are saved on this device only."));
  const actions = makeElement("div", "modal-actions");
  const done = makeElement("button", "primary", "Done");
  done.type = "button";
  done.onclick = closeSettings;
  actions.appendChild(done);
  card.appendChild(actions);
  back.appendChild(card);

  // A click on the dim backdrop (not inside the card) closes it, like the other dialogs.
  back.addEventListener("mousedown", event => {
    if (event.target === back) {
      closeSettings();
    }
  });
  document.body.appendChild(back);
  settingsBack = back;
  modalOpenCount++;
  modalCancel = closeSettings;
  requestAnimationFrame(() => back.classList.add("show"));
  first.focus();
}

/**
 * Closes the Settings dialog with the same fade as every dialog (it stays
 * mounted 140 ms with clicks passing through). Escape and Done can both
 * arrive, so nothing open means nothing to do.
 *
 * Used by: this file (Done, the backdrop, Escape through modalCancel, "Check
 * now", Lock).
 * Uses: nothing.
 * Complexity: O(1).
 */
function closeSettings() {
  if (!settingsBack) {
    return;
  }
  const back = settingsBack;
  settingsBack = null;
  modalOpenCount--;
  if (modalCancel === closeSettings) {
    modalCancel = null;
  }
  back.classList.remove("show");
  back.classList.add("closing");
  setTimeout(() => back.remove(), 140);
}

// ---------- Auto-lock ----------
// Any input counts as activity. Instead of a timer per event, a check every
// 15 s compares the clock with the last activity: that survives the timer
// slowdown of background tabs and a laptop waking from sleep (the first check
// after waking locks at once if the limit passed while it slept).

/**
 * Locks the app when it has been idle longer than the chosen time. Nothing
 * happens while locked, or when auto-lock is off (0 minutes).
 *
 * Used by: this file (every 15 s, and whenever the tab becomes visible again).
 * Uses: autoLock.
 * Complexity: O(1).
 */
function checkIdle() {
  if (!vault || !settings.autoLockMin) {
    return;
  }
  if (Date.now() - lastActivity < settings.autoLockMin * 60000) {
    return;
  }
  autoLock();
}

/**
 * Locks because of inactivity. A running sync is never interrupted (the next
 * check, 15 s later, tries again). An open dialog is answered "Cancel" first,
 * so nothing waits over the lock screen, and unsaved edits are saved, the
 * same as answering "Save and lock". Then the lock screen says why it locked.
 *
 * Used by: checkIdle in this file.
 * Uses: flushSave (pagination.js), lockApp, formatMinutes (backups.js).
 * Complexity: that of lockApp: one seal when there were unsaved edits.
 */
async function autoLock() {
  if (syncing) {
    return;
  }
  if (modalCancel) {
    modalCancel();
  }
  if (unsavedEdits) {
    flushSave();
  }
  // force: the save above already answered the question lockApp would otherwise ask.
  await lockApp(true);
  // Only if it really locked: say why, so an unexpected lock screen explains itself.
  if (!vault) {
    $("lock-msg").style.color = "var(--t3)";
    $("lock-msg").textContent = `Locked after ${formatMinutes(settings.autoLockMin)} without activity.`;
  }
}

// ---------- Locking ----------

/**
 * Locks the app: drops every decrypted thing from memory and shows the lock
 * screen. The ciphertext in localStorage, the vault's folder and IndexedDB is
 * untouched, so unlocking again restores everything. It encrypts nothing by
 * itself: if the open note has unsaved edits it asks first, and "Save and
 * lock" is one ordinary save (one seal of the vault).
 *
 * What goes: the vault, the vault key, its salt and round count, the
 * attachment key ring, the master password, the undo history (whole-note
 * snapshots), the body-search index (plain text of every note), censored text
 * kept for pasting back, every decrypted attachment URL, the sheets, the
 * second screen's reference pane, the detail panel (titles, and any token
 * typed into it), and the form fields. Every decryption still running is
 * made to abort instead of painting over the lock screen.
 *
 * force === true skips the question (auto-lock has saved already). It is a
 * strict check because the Lock button passes its click event as the first
 * argument.
 *
 * Used by: this file (the Lock button, auto-lock), events.js (Ctrl+L),
 * backups.js (leaving a backup view).
 * Uses: confirmModal (modal.js), flushSave, clearEditor and status
 * (pagination.js), closeMenu (menu.js), closePanel (panel.js), closeLightbox
 * (attachments.js), revokeAllMediaUrls (vault.js), closePalette (toolbar.js),
 * closeSettings, exitSplit (split.js), refreshLockBackupRow (backups.js),
 * renderHistoryButtons (history.js), syncLockBg and setLockMode (lock.js),
 * stopAmbientLines (ambient.js).
 * Complexity: O(u) in the decrypted attachment URLs it revokes, plus one seal
 * (O(n), about 20 ms for 500 KB) when it saves first.
 */
async function lockApp(force) {
  if (syncing) {
    return;
  }
  if (force !== true && unsavedEdits && !await confirmModal({
    title: "Lock with unsaved changes?",
    body: "The note you are editing has unsaved changes. Save before locking, or lock and lose them?",
    confirmLabel: "Save and lock",
  }).then(ok => {
    if (ok) {
      flushSave();
    }
    return ok;
  })) {
    return;
  }

  closeMenu();
  closePanel();
  closeLightbox();
  revokeAllMediaUrls();
  // A colour being edited is not worth a question at lock time.
  closePalette(true);
  // Censored text copied or dragged in the app, kept for pasting back.
  appClip = appDrag = null;
  // A dialog must not stay up over the lock screen.
  closeSettings();
  // The body-search index is the plain text of every note.
  searchTextCache.clear();
  // The reference pane holds plain text from the open note.
  exitSplit(true);
  currentPage = 0;
  $("page-tabs").innerHTML = "";
  $("page-tabs").style.display = "none";
  // The sheets hold decrypted page content.
  $("sheets").innerHTML = "";
  document.body.classList.remove("paged-view");

  // Every decryption in flight is tied to one of these generations. Bumping
  // both makes each pending one abort instead of painting plain content (a
  // lightbox, a thumbnail, a fresh blob: URL) over the lock screen after the
  // revoke sweep above. The `!vault` checks in those paths are the second
  // line of defence.
  attachSeq++;
  editorSeq++;

  // Leaving a backup view restores the normal chrome and the lock screen's backup row.
  backupView = null;
  pendingBackupKind = null;
  document.body.classList.remove("backup-view");
  $("backup-banner").style.display = "none";
  refreshLockBackupRow();

  vault = null;
  vaultKey = null;
  vaultSalt = null;
  vaultKeyIterations = PBKDF2_ITERATIONS;
  mediaKey = null;
  mediaKeyRing = [];
  masterPassword = null;

  // The undo stacks are whole-note snapshots: up to 30 plain copies of every
  // note edited this session. They must not outlive the vault they belong to.
  histories.clear();
  historyTypingMarked = false;
  structureDirty = false;
  renderHistoryButtons();

  currentId = null;
  trashViewId = null;
  unsavedEdits = false;
  deletedTitles = {};
  pullDiff = null;
  $("title").value = "";
  clearEditor();
  $("search").value = "";
  searchQuery = "";
  $("notelist").innerHTML = "";
  $("trash-list").innerHTML = "";
  $("attachments").innerHTML = "";

  // The detail panel is drawn once, not a live view: closePanel only drops a
  // CSS class, so without this every note title, folder name and merge title
  // it listed, and any GitHub token typed into its field, stayed readable in
  // the page behind the lock screen.
  $("status-detail").innerHTML = "";
  // A lasting status can hold an attachment's name ("Decrypting invoice.pdf...").
  status("");
  // For this session only, but it outlived the lock and kept the panel's
  // destructive "Overwrite remote" row ready for whatever vault opened next.
  lastSyncError = null;

  $("app").style.display = "none";
  stopAmbientLines();
  $("lock").style.display = "flex";
  syncLockBg();
  // A vault exists now: never the first-run form again.
  setLockMode();
  $("lock-msg").textContent = "";
  $("password").value = "";
  $("password2").value = "";
  $("token").value = "";
  // The strength meter described the old password; with the field empty it must not linger.
  $("pw-meter").style.display = "none";
  $("password").focus();
}

// ---------- On load ----------

$("settings-btn").onclick = openSettings;

// When you last typed, clicked, scrolled or touched anything.
let lastActivity = Date.now();

for (const eventName of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
  document.addEventListener(eventName, () => {
    lastActivity = Date.now();
  }, { capture: true, passive: true });
}

// Started once every script has loaded, since locking uses the lock screen's
// code (lock.js). Coming back to the tab checks at once instead of up to 15 s later.
document.addEventListener("DOMContentLoaded", () => {
  setInterval(checkIdle, 15000);
  document.addEventListener("visibilitychange", checkIdle);
});

$("lock-btn").onclick = lockApp;

// =================== Auxiliary functions ===================
// None: every function above carries out one of this file's purposes.
