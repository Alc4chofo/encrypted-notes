/*
 * events.js - the app's buttons and keys: new notes and folders, the search
 * box, typing and its autosave, and the keyboard shortcuts.
 *
 * Typing saves 400 ms after the last keystroke (saveCurrent in
 * pagination.js), which is one seal of the vault; in the second screen
 * nothing saves until you press Save. Ctrl+S saves now, Ctrl+L locks, and
 * Escape closes the topmost layer first: the lightbox, a menu, a dialog, the
 * colour palette, the detail panel, then the search.
 *
 * Main functions: newNote, startNewFolder, clearSearch.
 * Auxiliary functions: none.
 *
 * Complexity: every handler is O(1) apart from what it calls: a new note
 * saves once (O(n) in the vault's size), and the search redraws the list
 * (O(n) in the notes).
 */
"use strict";

// ---------- New notes and folders ----------

/**
 * Makes a new, empty note (inside a folder when one is given) and opens it
 * with the cursor in its title. The search is cleared first, since an empty
 * title can never match it and the new note would be invisible. The note goes
 * to the top of its group when that group is ordered by hand, and a folded
 * folder opens so the note shows.
 *
 * Used by: this file (the New note button, the note list's menu),
 * notes.js (a folder's "New note").
 * Uses: flushSave and openNote (pagination.js), topOrderOfGroup and
 * revealFolder (sidebar.js), persistSafe (vault.js).
 * Complexity: O(g) in the notes of its group, plus one save.
 */
function newNote(folderId) {
  if (syncing) {
    return;
  }
  flushSave();
  if (searchQuery) {
    searchQuery = "";
    $("search").value = "";
  }

  const parent = folderId && vault.folders[folderId] ? folderId : null;
  const id = crypto.randomUUID();
  vault.notes[id] = { title: "", body: "", color: null, folderId: parent, mtime: Date.now(), media: [] };
  // The top of its group if the group is ordered by hand, otherwise no order (see ensureNoteForMedia).
  {
    const order = topOrderOfGroup(parent);
    if (order !== undefined) {
      vault.notes[id].order = order;
    }
  }
  // Its folder, and every folder around it, opens.
  if (parent) {
    revealFolder(parent);
  }
  persistSafe();
  openNote(id);
  $("title").focus();
}

/**
 * Shows the inline input for a new folder at the top of the note list. The
 * search is cleared first, since the new folder is empty and a search would
 * hide it at once.
 *
 * Used by: this file (the New folder button, the note list's menu).
 * Uses: clearSearch, renderList (sidebar.js).
 * Complexity: O(n) for the redraw.
 */
function startNewFolder() {
  if (syncing) {
    return;
  }
  clearSearch();
  inlineEdit = { kind: "new" };
  renderList();
  $("notelist").scrollTop = 0;
}

/**
 * Empties the search box and shows every note again. Returns whether there
 * was a search to clear.
 *
 * Used by: this file (Escape, the search box), notes.js (a new subfolder).
 * Uses: renderList (sidebar.js).
 * Complexity: O(n) for the redraw.
 */
function clearSearch() {
  if (!searchQuery && !$("search").value) {
    return false;
  }
  searchQuery = "";
  $("search").value = "";
  renderList();
  return true;
}

// ---------- On load: buttons and the search box ----------

$("new-note").onclick = () => newNote();
$("new-folder").onclick = startNewFolder;

$("search").addEventListener("input", () => {
  searchQuery = $("search").value;
  renderList();
});
$("search").addEventListener("keydown", event => {
  if (event.key === "Escape" && $("search").value) {
    // Escape with text in the box clears the search before any other layer.
    event.stopPropagation();
    clearSearch();
  }
});

// ---------- On load: the note list's background ----------

// A drop on the list's background (or its "no notes yet" text) moves a note
// out of any folder, to the end of the loose notes, and a folder to the top
// level. Drops on rows and folder headers stop propagation, so they never get
// here. It works while searching too (it appends, it does not insert). Added
// once: the element outlives every redraw.
$("notelist").addEventListener("dragover", event => {
  if (syncing || (!draggingNoteId && !draggingFolderId)) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});
$("notelist").addEventListener("drop", event => {
  if (syncing || (!draggingNoteId && !draggingFolderId)) {
    return;
  }
  event.preventDefault();
  const noteId = draggingNoteId;
  const folderId = draggingFolderId;
  finishDrag();
  if (noteId) {
    dropIntoLoose(noteId);
  } else {
    nestFolder(folderId, null);
  }
});

// A right-click on the list's empty background offers New note and New
// folder. Rows and folders have their own menus, so a click on one of them
// is left to it.
$("notelist").addEventListener("contextmenu", event => {
  if (event.target.closest(".note-item, .folder-row, .inline-folder")) {
    return;
  }
  event.preventDefault();
  openMenu(event.clientX, event.clientY, [
    { label: "New note", disabled: syncing, onClick: () => newNote() },
    { label: "New folder...", disabled: syncing, onClick: () => startNewFolder() },
  ]);
});

// ---------- On load: the trash item's buttons, Save, the merge banner, the chips ----------

$("trash-restore").onclick = () => {
  if (trashViewId) {
    restoreFromTrash(trashViewId);
  }
};
$("trash-purge").onclick = () => {
  if (trashViewId) {
    purgeFromTrash(trashViewId);
  }
};

$("save").onclick = manualSave;
$("pull-details").onclick = () => {
  panelOpen ? renderDetail() : openPanel();
};
$("pull-dismiss").onclick = dismissBanner;
for (const chipId of ["chip-unsaved", "chip-syncerr"]) {
  $(chipId).onclick = togglePanel;
}

// ---------- On load: typing ----------

// The pending autosave. Typing restarts it; Save, switching notes and Lock run it at once.
let saveTimer;

for (const field of [$("title"), $("editor")]) {
  field.addEventListener("input", () => {
    // A trash item on screen owns the editor's text: never adopt it.
    if (trashViewId) {
      return;
    }
    // Typing with no note open would belong to nothing and be lost quietly,
    // so the text becomes a new note that autosaves like any other.
    if (!currentId) {
      currentId = crypto.randomUUID();
      vault.notes[currentId] = { title: "", body: "", color: null, folderId: null, mtime: Date.now(), media: [] };
      // The top of the loose notes if they are ordered by hand, otherwise no order.
      {
        const order = newLooseOrder();
        if (order !== undefined) {
          vault.notes[currentId].order = order;
        }
      }
      // As for New note: an empty title cannot match a search.
      if (searchQuery) {
        searchQuery = "";
        $("search").value = "";
      }
    }
    if (statusIsError) {
      status("");
    }
    // The empty-note placeholder follows the text.
    updateEditorEmpty();
    // One undo step per burst of typing, not per keystroke.
    historyMarkTyping();
    if (!unsavedEdits) {
      unsavedEdits = true;
      renderList();
    }
    // The second screen saves only when you press Save: autosaving there would
    // commit the rewrite behind your back, and the "save or cancel?" question
    // on leaving could never come up, since nothing would ever be unsaved.
    if (!splitMode) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveCurrent, 400);
    }
    renderStatus();
  });
}

// ---------- On load: deleting an attachment in the text ----------

// Backspace just after an inline attachment, or Delete just before one,
// removes it whole (browsers treat a contentEditable=false child
// inconsistently). It never touches note.media: the file stays in the strip,
// downloadable; only its place in the text goes. This works on every page of
// a paged note too.
$("edit-wrap").addEventListener("keydown", event => {
  if (trashViewId || backupView || syncing) {
    return;
  }
  if (event.key !== "Backspace" && event.key !== "Delete") {
    return;
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }
  const range = selection.getRangeAt(0);
  // A selection being deleted already removes any attachment inside it, and 'input' saves it.
  if (!range.collapsed || !surfaceOfNode(range.startContainer)) {
    return;
  }
  const target = event.key === "Backspace" ? wrapperOf(nodeBeforeCaret(range)) : wrapperOf(nodeAfterCaret(range));
  // Not next to an attachment: an ordinary character delete.
  if (!target) {
    return;
  }

  event.preventDefault();
  const caret = document.createRange();
  if (event.key === "Backspace") {
    caret.setStartBefore(target);
  } else {
    caret.setStartAfter(target);
  }
  caret.collapse(true);
  target.remove();
  selection.removeAllRanges();
  selection.addRange(caret);
  // No 'input' event fires for a removal made by script.
  scheduleInlineSave();
});

// ---------- On load: keyboard shortcuts ----------

document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && vault) {
    event.preventDefault();
    if (!uiLayerOpen() && !trashViewId) {
      manualSave();
    }
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l" && vault) {
    event.preventDefault();
    if (!uiLayerOpen()) {
      lockApp();
    }
  } else if (event.key === "Escape") {
    // The topmost layer first. The inline folder input and the search box
    // handle their own Escape and stop it, so it never reaches here.
    if (typeof window.closeLightboxIfOpen === "function" && window.closeLightboxIfOpen()) {
      return;
    }
    if (menuIsOpen()) {
      closeMenu();
      return;
    }
    if (modalIsOpen()) {
      if (modalCancel) {
        modalCancel();
      }
      return;
    }
    if (palettePop) {
      paletteEscape();
      return;
    }
    if (panelOpen) {
      closePanel();
      return;
    }
    // The last layer: Escape clears a search from anywhere.
    clearSearch();
  }
});

// ---------- On load: clicks outside the detail panel close it ----------

document.addEventListener("click", event => {
  if (!panelOpen) {
    return;
  }
  // composedPath, not contains: the panel's buttons redraw the panel during
  // the click, which detaches the target before the event bubbles up here.
  const path = event.composedPath();
  if (path.includes($("status-detail")) ||
      path.some(node => node && (node.id === "chips" || node.id === "pull-banner"))) {
    return;
  }
  closePanel();
});

// ---------- On load: leaving the page with unsaved edits asks first ----------

window.addEventListener("beforeunload", event => {
  if (unsavedEdits) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// =================== Auxiliary functions ===================
// None: every function above carries out one of this file's purposes.
