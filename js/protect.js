/*
 * protect.js - notes and folders behind a password of their own.
 *
 * A protected note keeps its title, colour, folder and attachment list in
 * the vault as before, but its text (body and pages) is sealed with a key of
 * its own: PBKDF2-SHA256 over its password (PBKDF2_ITERATIONS rounds, a
 * random 16-byte salt) and AES-256-GCM, stored as note.lock = { v: 1, iter,
 * salt, iv, data, media }, with the text taken out of the note. media lists
 * the attachments the sealed text shows inline (their random ids only), so
 * Sync and the clean-up still know they are in use. The vault then seals all
 * of it again under the master password, as before.
 *
 * Opening a protected note asks for its password every time. Its text is
 * opened into the note in memory (marked unsealed) while it is the open
 * note, and sealed again as soon as another note opens, the trash shows,
 * Sync starts or the vault locks. Every save in between goes out sealed
 * (storedForm, called by sealObject for every save, Sync push and backup),
 * so the text never reaches this browser's storage, the app folder or the
 * repository unsealed.
 *
 * A protected folder asks for its password each time it is unfolded
 * (folding it asks nothing) and before anything inside it opens; while it is
 * folded, its notes and subfolders show nowhere: not in search, Pinned or
 * Unsynced. Its lock seals only a check value: the folder's name and its
 * notes' titles stay as they are, and its notes' text is sealed only if they
 * are protected too, which protecting the folder offers, with the same
 * password and salt, so changing the folder's password carries them along.
 *
 * Main functions: noteSealed, folderLocked, noteHidden, protectGate,
 * unfoldProtectedFolder, foldProtectedFolder, relockNotes, sealBeforeSync,
 * storedForm, lockedMediaIds, protectionItems, withFolderOpen, lockMark,
 * forgetProtection.
 * Auxiliary functions: openNoteText, protectNote, protectFolder,
 * changeNotePassword, changeFolderPassword, unprotectNote, unprotectFolder,
 * askPassword, askNewPassword, currentLock, sealText, openText, sealCheck,
 * contentJson, putText, stripText, inlineMediaIds, lockedFoldersAbove,
 * notesUnder, closeOpenNote.
 *
 * Complexity: each password costs one PBKDF2 derivation (about a second, on
 * purpose: it is what makes guessing slow); sealing or opening a note's text
 * is O(n) in its size; a save looks at every note once, O(N).
 */
"use strict";

// ---------- State ----------

// The keys of protected texts opened this session, by salt: { key, iter }. A
// note's copies (its duplicate, its trash entry, a conflict copy) share its
// salt, and so its key.
let openKeys = new Map();

// The last seal of each unsealed note: id -> { plain, salt, lock }, so an
// unchanged text keeps the lock it had and does not look edited to Sync.
let sealCache = new Map();

// The protected folders unfolded with their password, until folded again.
let unlockedFolders = new Set();

// What a folder's lock seals: a fixed value, so its password can be checked.
const FOLDER_CHECK = "notes: folder password check";

// ---------- Where protection applies ----------

/**
 * Whether a note's text is sealed now: it is protected and not open in this
 * session.
 *
 * Used by: this file, notes.js (its menu: what needs the text).
 * Uses: nothing.
 * Complexity: O(1).
 */
function noteSealed(id) {
  const note = vault.notes[id];
  return !!(note && note.lock && !note.unsealed);
}

/**
 * Whether a folder is protected and not unfolded with its password now.
 *
 * Used by: this file, sidebar.js (its row, the walk, unfolding on a drag).
 * Uses: nothing.
 * Complexity: O(1).
 */
function folderLocked(folderId) {
  const folder = vault.folders[folderId];
  return !!(folder && folder.lock && !unlockedFolders.has(folderId));
}

/**
 * Whether a note sits inside a locked folder (at any depth), so it shows
 * nowhere until that folder is unfolded with its password.
 *
 * Used by: sidebar.js (the list, Pinned and Unsynced).
 * Uses: lockedFoldersAbove.
 * Complexity: O(d) in the folder depth.
 */
function noteHidden(id) {
  const note = vault.notes[id];
  return !!(note && note.folderId && lockedFoldersAbove(note.folderId).length);
}

// ---------- Opening ----------

/**
 * Stands in front of openNote: when the note is inside a locked folder, or
 * its text is sealed, asks for each password (the outer folder first), and
 * opens the note once they are all right. Returns true when it took over
 * (openNote then stops), false when nothing needs a password. Nothing opens
 * during a Sync, which works on sealed notes only.
 *
 * Used by: pagination.js (openNote).
 * Uses: lockedFoldersAbove, unfoldProtectedFolder, openNoteText, openNote
 * (pagination.js), status (pagination.js).
 * Complexity: one PBKDF2 derivation per password asked.
 */
function protectGate(id) {
  const note = vault.notes[id];
  const folders = note && note.folderId ? lockedFoldersAbove(note.folderId) : [];
  if (!note || (!folders.length && !noteSealed(id))) {
    return false;
  }
  if (syncing) {
    status("A protected note opens once the sync is done");
    return true;
  }
  (async () => {
    for (const folderId of folders) {
      if (!await unfoldProtectedFolder(folderId)) {
        return;
      }
    }
    if (noteSealed(id) && !await openNoteText(id)) {
      return;
    }
    if (vault && vault.notes[id] && !syncing) {
      openNote(id);
    }
  })();
  return true;
}

/**
 * Unfolds a protected folder once its password is right (a folder that is
 * not locked unfolds at once). Returns whether it is open.
 *
 * Used by: this file (protectGate, withFolderOpen), sidebar.js (a click on
 * the folder's row).
 * Uses: askPassword, openText, saveCollapsed (core.js), renderList (sidebar.js).
 * Complexity: one PBKDF2 derivation.
 */
async function unfoldProtectedFolder(folderId) {
  const folder = vault.folders[folderId];
  if (folder && folderLocked(folderId)) {
    const opened = await askPassword({
      title: `Open "${folder.name || "(unnamed)"}"`,
      body: "This folder is protected. Enter its password.",
      lock: folder.lock,
    });
    if (!opened || !vault || vault.folders[folderId] !== folder) {
      return false;
    }
    unlockedFolders.add(folderId);
  }
  if (!vault || !vault.folders[folderId]) {
    return false;
  }
  if (collapsed.delete(folderId)) {
    saveCollapsed();
  }
  renderList();
  return true;
}

/**
 * Folding a protected folder closes it again: the next unfold asks for its
 * password.
 *
 * Used by: sidebar.js (a click on the folder's row).
 * Uses: nothing.
 * Complexity: O(1).
 */
function foldProtectedFolder(folderId) {
  unlockedFolders.delete(folderId);
}

/**
 * Runs an action on a folder only once it is open: a locked folder asks for
 * its password first. For what would show or move its contents (deleting it,
 * a new note or subfolder in it).
 *
 * Used by: notes.js (the folder's menu).
 * Uses: folderLocked, unfoldProtectedFolder.
 * Complexity: one PBKDF2 derivation when it asks.
 */
async function withFolderOpen(folderId, action) {
  if (folderLocked(folderId) && !await unfoldProtectedFolder(folderId)) {
    return;
  }
  action();
}

// ---------- Sealing again ----------

/**
 * Seals the text of every unsealed note but `exceptId` again (in the list
 * and in the trash), and takes it out of memory. A text not changed since it
 * was opened gets its old lock back. A note opened again meanwhile is left
 * open.
 *
 * Used by: this file (sealBeforeSync), pagination.js (openNote, openTrash).
 * Uses: currentLock, stripText, searchTextCache (content.js), histories (history.js).
 * Complexity: O(N) to find them, plus one AES-GCM seal per changed text.
 */
async function relockNotes(exceptId) {
  const open = [];
  for (const id in vault.notes) {
    if (id !== exceptId && vault.notes[id].unsealed) {
      open.push([id, vault.notes[id]]);
    }
  }
  for (const id in vault.trash) {
    const data = vault.trash[id].data;
    if (id !== exceptId && data && data.unsealed) {
      open.push([id, data]);
    }
  }
  for (const [id, note] of open) {
    const lock = await currentLock(id, note);
    if (!vault || !note.unsealed || id === currentId || !lock) {
      continue;
    }
    note.lock = lock;
    stripText(note);
    delete note.unsealed;
    sealCache.delete(id);
    searchTextCache.delete(id);
    // Its undo steps are whole copies of its text.
    histories.delete(id);
  }
  // A key no unsealed note uses any more is dropped.
  const inUse = new Set();
  for (const note of [...Object.values(vault.notes), ...Object.values(vault.trash).map(item => item.data)]) {
    if (note && note.unsealed && note.lock) {
      inUse.add(note.lock.salt);
    }
  }
  for (const salt of [...openKeys.keys()]) {
    if (!inUse.has(salt)) {
      openKeys.delete(salt);
    }
  }
}

/**
 * Before a Sync: every protected note is sealed again and the open one is
 * closed, so the merge only ever sees sealed text.
 *
 * Used by: media-sync.js (runSync).
 * Uses: relockNotes, closeOpenNote.
 * Complexity: that of relockNotes.
 */
async function sealBeforeSync() {
  // Closed first: sealing again leaves the open note alone.
  if (currentId && vault.notes[currentId] && vault.notes[currentId].unsealed) {
    closeOpenNote();
  }
  await relockNotes(null);
}

/**
 * The object as it may be stored: every unsealed note in it (in the list or
 * the trash) with its text sealed again and taken out. Called for every save,
 * Sync push and backup, so an open protected note never leaves the page
 * unsealed. Without a key (it cannot happen: keys stay while a note uses
 * them) the note goes out with its last lock and without the text.
 *
 * Used by: core.js (sealObject).
 * Uses: currentLock, stripText.
 * Complexity: O(N), plus one AES-GCM seal per changed text.
 */
async function storedForm(object) {
  if (!object || !object.notes || !object.trash) {
    return object;
  }
  // Collected before the first await: a lock of the vault meanwhile cannot drop a key mid-way.
  const open = [];
  for (const id in object.notes) {
    if (object.notes[id].unsealed) {
      open.push({ id, note: object.notes[id], where: "notes" });
    }
  }
  for (const id in object.trash) {
    const data = object.trash[id].data;
    if (data && data.unsealed) {
      open.push({ id, note: data, where: "trash" });
    }
  }
  if (!open.length) {
    return object;
  }
  const notes = { ...object.notes };
  const trash = { ...object.trash };
  for (const { id, note, where } of open) {
    const lock = await currentLock(id, note).catch(() => null) || note.lock;
    const stored = stripText({ ...note, lock });
    delete stored.unsealed;
    if (where === "notes") {
      notes[id] = stored;
    } else {
      trash[id] = { ...object.trash[id], data: stored };
    }
  }
  return { ...object, notes, trash };
}

/**
 * The attachments a sealed text shows inline, which the text itself cannot
 * name while it is sealed.
 *
 * Used by: vault.js (mediaReferenced), media-sync.js (mediaIdsFor).
 * Uses: nothing.
 * Complexity: O(m) in their number.
 */
function lockedMediaIds(note) {
  return note && note.lock && Array.isArray(note.lock.media) ? note.lock.media : [];
}

/**
 * Forgets every key and unfolded folder once the vault is locked (after the
 * last save, which may still need a key).
 *
 * Used by: settings.js (lockApp).
 * Uses: persistChain (vault.js).
 * Complexity: O(1).
 */
function forgetProtection() {
  persistChain.then(() => {
    if (!vault) {
      openKeys = new Map();
      sealCache = new Map();
      unlockedFolders = new Set();
    }
  });
}

// ---------- In the menus and the list ----------

/**
 * The password items of a note's or a folder's menu: "Protect with a
 * password..." while it has none, "Change the password..." and "Remove the
 * password..." once it has one.
 *
 * Used by: notes.js (noteMenu, folderMenu).
 * Uses: protectNote, protectFolder, changeNotePassword, changeFolderPassword,
 * unprotectNote, unprotectFolder.
 * Complexity: O(1).
 */
function protectionItems(kind, id) {
  const item = kind === "note" ? vault.notes[id] : vault.folders[id];
  if (!item) {
    return [];
  }
  if (!item.lock) {
    return [{
      label: "Protect with a password...",
      disabled: syncing,
      onClick: () => (kind === "note" ? protectNote(id) : protectFolder(id)),
    }];
  }
  return [
    {
      label: "Change the password...",
      disabled: syncing,
      onClick: () => (kind === "note" ? changeNotePassword(id) : changeFolderPassword(id)),
    },
    {
      label: "Remove the password...",
      disabled: syncing,
      onClick: () => (kind === "note" ? unprotectNote(id) : unprotectFolder(id)),
    },
  ];
}

/**
 * The small lock drawn beside a protected note's or folder's name.
 *
 * Used by: sidebar.js (noteRow, folderRow).
 * Uses: t (i18n.js).
 * Complexity: O(1).
 */
function lockMark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "lock-mark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("Protected"));
  const shackle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shackle.setAttribute("d", "M5 7.5V5.2a3 3 0 0 1 6 0v2.3");
  shackle.setAttribute("fill", "none");
  shackle.setAttribute("stroke", "currentColor");
  shackle.setAttribute("stroke-width", "1.6");
  const body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  body.setAttribute("x", "3");
  body.setAttribute("y", "7.5");
  body.setAttribute("width", "10");
  body.setAttribute("height", "7");
  body.setAttribute("rx", "1.6");
  body.setAttribute("fill", "currentColor");
  svg.append(shackle, body);
  return svg;
}

// =================== Auxiliary functions ===================

/**
 * Asks for a sealed note's password and opens its text into the note in
 * memory. Returns whether it opened. Complexity: one PBKDF2 derivation.
 */
async function openNoteText(id) {
  const note = vault.notes[id];
  const lock = note.lock;
  const opened = await askPassword({
    title: `Open "${note.title || "(untitled)"}"`,
    body: "This note is protected. Enter its password.",
    lock,
  });
  // A sync or a restore may have replaced the note while the question was up.
  if (!opened || !vault || vault.notes[id] !== note || note.lock !== lock) {
    return false;
  }
  putText(note, opened.payload);
  note.unsealed = true;
  openKeys.set(lock.salt, { key: opened.key, iter: lock.iter });
  sealCache.set(id, { plain: contentJson(note), salt: lock.salt, lock });
  searchTextCache.delete(id);
  return true;
}

/**
 * "Protect with a password..." on a note: its text is sealed at once (it
 * stays open if it is the open note). Complexity: one PBKDF2 derivation.
 */
async function protectNote(id) {
  const note = vault.notes[id];
  if (!note || note.lock) {
    return;
  }
  const chosen = await askNewPassword({
    title: `Protect "${note.title || "(untitled)"}"`,
    body: "Opening this note will ask for this password, every time. Without it, its text cannot be read, by anyone.",
  });
  if (!chosen || !vault || vault.notes[id] !== note || note.lock) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }
  const plain = contentJson(note);
  const lock = await sealText(chosen.key, chosen.salt, chosen.iter, plain, inlineMediaIds(note));
  note.lock = lock;
  note.mtime = Date.now();
  if (id === currentId) {
    note.unsealed = true;
    openKeys.set(lock.salt, { key: chosen.key, iter: chosen.iter });
    sealCache.set(id, { plain, salt: lock.salt, lock });
  } else {
    stripText(note);
    searchTextCache.delete(id);
  }
  persistSafe();
  renderList();
  renderStatus();
  status("Note protected");
}

/**
 * "Protect with a password..." on a folder: its lock, then the offer to seal
 * every note inside it (subfolders included) with the same password, all
 * sharing one salt. The folder folds. Complexity: one PBKDF2 derivation and
 * one seal per note.
 */
async function protectFolder(folderId) {
  const folder = vault.folders[folderId];
  if (!folder || folder.lock) {
    return;
  }
  const chosen = await askNewPassword({
    title: `Protect "${folder.name || "(unnamed)"}"`,
    body: "Unfolding this folder, or opening anything in it, will ask for this password, every time.",
  });
  if (!chosen || !vault || vault.folders[folderId] !== folder || folder.lock) {
    return;
  }
  const inside = notesUnder(folderId).filter(id => !vault.notes[id].lock);
  let alsoNotes = false;
  if (inside.length) {
    alsoNotes = await showModal({
      title: "Protect its notes too?",
      body: t("Seal the text of the {0} note(s) in this folder with the same password? Each then asks for it when it opens, wherever it is moved. Notes that already have a password keep theirs.", inside.length),
      choices: [{ id: "yes", label: "Protect the notes too" }, { id: "no", label: "Only the folder" }],
      defaultId: "yes",
    }) === "yes";
  }
  if (!vault || vault.folders[folderId] !== folder || folder.lock) {
    return;
  }
  if (alsoNotes && currentId && inside.includes(currentId)) {
    flushSave();
  }
  folder.lock = await sealCheck(chosen.key, chosen.salt, chosen.iter);
  folder.mtime = Date.now();
  for (const id of alsoNotes ? inside : []) {
    const note = vault.notes[id];
    if (!note || note.lock) {
      continue;
    }
    const plain = contentJson(note);
    note.lock = await sealText(chosen.key, chosen.salt, chosen.iter, plain, inlineMediaIds(note));
    note.mtime = Date.now();
    if (id === currentId) {
      note.unsealed = true;
      openKeys.set(chosen.salt, { key: chosen.key, iter: chosen.iter });
      sealCache.set(id, { plain, salt: chosen.salt, lock: note.lock });
    } else {
      stripText(note);
      searchTextCache.delete(id);
    }
  }
  unlockedFolders.delete(folderId);
  collapsed.add(folderId);
  saveCollapsed();
  persistSafe();
  renderList();
  renderStatus();
  status(alsoNotes ? "Folder and its notes protected" : "Folder protected");
}

/** "Change the password..." on a note: the old one, then the new one twice. Complexity: two PBKDF2 derivations. */
async function changeNotePassword(id) {
  const note = vault.notes[id];
  if (!note || !note.lock) {
    return;
  }
  const lock = note.lock;
  const old = await askPassword({ title: `Change the password of "${note.title || "(untitled)"}"`,
    body: "Enter its current password.", lock, confirmLabel: "Next" });
  if (!old || !vault || vault.notes[id] !== note || note.lock !== lock) {
    return;
  }
  const chosen = await askNewPassword({ title: `Change the password of "${note.title || "(untitled)"}"`,
    body: "Choose its new password." });
  if (!chosen || !vault || vault.notes[id] !== note || note.lock !== lock) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }
  // Sealed, its text is the one just opened; open, it is the one in the note.
  const plain = note.unsealed ? contentJson(note) : JSON.stringify(old.payload);
  const media = note.unsealed ? inlineMediaIds(note) : lockedMediaIds(note);
  note.lock = await sealText(chosen.key, chosen.salt, chosen.iter, plain, media);
  note.mtime = Date.now();
  if (note.unsealed) {
    openKeys.set(chosen.salt, { key: chosen.key, iter: chosen.iter });
    sealCache.set(id, { plain, salt: chosen.salt, lock: note.lock });
  }
  persistSafe();
  renderStatus();
  status("Password changed");
}

/**
 * "Change the password..." on a folder: the old one, the new one twice; the
 * notes inside that share the folder's password follow it. Complexity: two
 * PBKDF2 derivations and one seal per such note.
 */
async function changeFolderPassword(folderId) {
  const folder = vault.folders[folderId];
  if (!folder || !folder.lock) {
    return;
  }
  const lock = folder.lock;
  const name = folder.name || "(unnamed)";
  const old = await askPassword({ title: `Change the password of "${name}"`, body: "Enter its current password.",
    lock, confirmLabel: "Next" });
  if (!old || !vault || vault.folders[folderId] !== folder || folder.lock !== lock) {
    return;
  }
  const chosen = await askNewPassword({ title: `Change the password of "${name}"`,
    body: "Choose its new password. The notes inside that use the folder's password change with it." });
  if (!chosen || !vault || vault.folders[folderId] !== folder || folder.lock !== lock) {
    return;
  }
  if (currentId && vault.notes[currentId] && vault.notes[currentId].unsealed) {
    flushSave();
  }
  folder.lock = await sealCheck(chosen.key, chosen.salt, chosen.iter);
  folder.mtime = Date.now();
  for (const id of notesUnder(folderId)) {
    const note = vault.notes[id];
    if (!note.lock || note.lock.salt !== lock.salt) {
      continue;
    }
    const plain = note.unsealed ? contentJson(note) : JSON.stringify(await openText(old.key, note.lock));
    const media = note.unsealed ? inlineMediaIds(note) : lockedMediaIds(note);
    note.lock = await sealText(chosen.key, chosen.salt, chosen.iter, plain, media);
    note.mtime = Date.now();
    if (note.unsealed) {
      openKeys.set(chosen.salt, { key: chosen.key, iter: chosen.iter });
      sealCache.set(id, { plain, salt: chosen.salt, lock: note.lock });
    }
  }
  persistSafe();
  renderList();
  renderStatus();
  status("Password changed");
}

/**
 * "Remove the password..." on a note: asks for it, then the text goes back
 * into the note. Complexity: one PBKDF2 derivation.
 */
async function unprotectNote(id) {
  const note = vault.notes[id];
  if (!note || !note.lock) {
    return;
  }
  const lock = note.lock;
  const opened = await askPassword({ title: `Remove the password of "${note.title || "(untitled)"}"`,
    body: "Enter its password. Its text is then stored like any other note's, sealed only by the master password.",
    lock, confirmLabel: "Remove the password" });
  if (!opened || !vault || vault.notes[id] !== note || note.lock !== lock) {
    return;
  }
  if (!note.unsealed) {
    putText(note, opened.payload);
  }
  delete note.lock;
  delete note.unsealed;
  sealCache.delete(id);
  searchTextCache.delete(id);
  note.mtime = Date.now();
  persistSafe();
  renderList();
  renderStatus();
  status("Password removed");
}

/**
 * "Remove the password..." on a folder: asks for it, then whether the notes
 * inside that share it lose it too. Complexity: one PBKDF2 derivation and one
 * opening per such note.
 */
async function unprotectFolder(folderId) {
  const folder = vault.folders[folderId];
  if (!folder || !folder.lock) {
    return;
  }
  const lock = folder.lock;
  const opened = await askPassword({ title: `Remove the password of "${folder.name || "(unnamed)"}"`,
    body: "Enter its password.", lock, confirmLabel: "Next" });
  if (!opened || !vault || vault.folders[folderId] !== folder || folder.lock !== lock) {
    return;
  }
  const sharing = notesUnder(folderId).filter(id => vault.notes[id].lock && vault.notes[id].lock.salt === lock.salt);
  let alsoNotes = false;
  if (sharing.length) {
    const choice = await showModal({
      title: "Remove it from its notes too?",
      body: t("{0} note(s) in this folder use the folder's password. Remove it from them too, or keep them protected?", sharing.length),
      choices: [{ id: "all", label: "From the notes too" }, { id: "folder", label: "Only the folder" },
        { id: "cancel", label: "Cancel" }],
      defaultId: "folder",
    });
    if (choice !== "all" && choice !== "folder") {
      return;
    }
    alsoNotes = choice === "all";
  }
  if (!vault || vault.folders[folderId] !== folder || folder.lock !== lock) {
    return;
  }
  delete folder.lock;
  folder.mtime = Date.now();
  unlockedFolders.delete(folderId);
  for (const id of alsoNotes ? sharing : []) {
    const note = vault.notes[id];
    if (!note || !note.lock || note.lock.salt !== lock.salt) {
      continue;
    }
    if (!note.unsealed) {
      putText(note, await openText(opened.key, note.lock));
    }
    delete note.lock;
    delete note.unsealed;
    sealCache.delete(id);
    searchTextCache.delete(id);
    note.mtime = Date.now();
  }
  persistSafe();
  renderList();
  renderStatus();
  status("Password removed");
}

/**
 * Asks for the password of a lock until it opens it, or the question is
 * cancelled: { key, payload } or null. "Wrong password" shows in the
 * question. Complexity: one PBKDF2 derivation per try.
 */
async function askPassword({ title, body, lock, confirmLabel }) {
  let error = "";
  for (;;) {
    const values = await passwordModal({ title, body, fields: ["Password"], confirmLabel: confirmLabel || "Open", error });
    if (!values) {
      return null;
    }
    status("Checking the password...", false, true);
    try {
      const key = await deriveKey(values[0], fromBase64(lock.salt), lock.iter);
      const payload = await openText(key, lock);
      status("");
      return { key, payload };
    } catch {
      status("");
      error = "Wrong password.";
    }
  }
}

/**
 * Asks for a new password twice, until both match and it is not empty:
 * { key, salt, iter } (a fresh salt) or null. Complexity: one PBKDF2 derivation.
 */
async function askNewPassword({ title, body }) {
  let error = "";
  for (;;) {
    const values = await passwordModal({ title, body, fields: ["New password", "Confirm the new password"],
      confirmLabel: "Protect", error });
    if (!values) {
      return null;
    }
    if (!values[0]) {
      error = "Choose a password.";
    } else if (values[0] !== values[1]) {
      error = "The two passwords do not match.";
    } else {
      status("Protecting...", false, true);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(values[0], salt, PBKDF2_ITERATIONS);
      status("");
      return { key, salt: toBase64(salt), iter: PBKDF2_ITERATIONS };
    }
  }
}

/** The lock an unsealed note's text has now: its last one when unchanged, a fresh seal otherwise. Complexity: O(n). */
async function currentLock(id, note) {
  const plain = contentJson(note);
  const cached = sealCache.get(id);
  if (cached && cached.plain === plain && cached.salt === note.lock.salt) {
    return cached.lock;
  }
  const open = openKeys.get(note.lock.salt);
  if (!open) {
    console.error("protect.js: no key for an open protected note", id);
    return null;
  }
  const lock = await sealText(open.key, note.lock.salt, open.iter, plain, inlineMediaIds(note));
  sealCache.set(id, { plain, salt: note.lock.salt, lock });
  return lock;
}

/** Seals a note's text (as JSON) under its key, with a fresh 12-byte IV. Complexity: O(n). */
async function sealText(key, salt, iter, plain, media) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textToBytes(plain));
  return { v: 1, iter, salt, iv: toBase64(iv), data: toBase64(data), media };
}

/** Opens a lock with its key: the sealed value, or a throw when the key is wrong. Complexity: O(n). */
async function openText(key, lock) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(lock.iv) }, key, fromBase64(lock.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** A folder's lock: the check value sealed under its key. Complexity: O(1). */
async function sealCheck(key, salt, iter) {
  const lock = await sealText(key, salt, iter, JSON.stringify(FOLDER_CHECK), []);
  delete lock.media;
  return lock;
}

/** A note's text, the part a lock seals, as JSON. Complexity: O(n). */
function contentJson(note) {
  return JSON.stringify({ body: note.body || "", bodyV: note.bodyV, pages: note.pages });
}

/** Puts an opened text back into its note. Complexity: O(1). */
function putText(note, payload) {
  note.body = payload.body || "";
  if (payload.bodyV !== undefined) {
    note.bodyV = payload.bodyV;
  }
  if (payload.pages !== undefined) {
    note.pages = payload.pages;
  }
}

/** Takes the text out of a note (its lock holds it); returns the note. Complexity: O(1). */
function stripText(note) {
  note.body = "";
  delete note.bodyV;
  delete note.pages;
  return note;
}

/** The attachments an open text shows inline (ids only). Complexity: O(n). */
function inlineMediaIds(note) {
  const ids = new Set();
  for (const entry of noteBodies(note)) {
    if (entry.bodyV === 2) {
      for (const id of bodyMediaIds(entry.body, 2)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** The locked folders from the top down to this one (this one included). Complexity: O(d). */
function lockedFoldersAbove(folderId) {
  const out = [];
  const seen = new Set();
  for (let id = folderId; id && vault.folders[id] && !seen.has(id); id = parentOf(id)) {
    seen.add(id);
    if (folderLocked(id)) {
      out.unshift(id);
    }
  }
  return out;
}

/** Every note inside a folder, subfolders included. Complexity: O(N * d). */
function notesUnder(folderId) {
  return Object.keys(vault.notes).filter(id => {
    const seen = new Set();
    for (let at = vault.notes[id].folderId; at && vault.folders[at] && !seen.has(at); at = parentOf(at)) {
      if (at === folderId) {
        return true;
      }
      seen.add(at);
    }
    return false;
  });
}

/** Closes the open note: nothing in the editor. Complexity: O(1). */
function closeOpenNote() {
  revokeAllMediaUrls();
  exitSplit(true);
  currentId = null;
  $("title").value = "";
  clearEditor();
  unsavedEdits = false;
  renderAttachments();
  renderList();
}
