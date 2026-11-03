// notes: Editor events: typing, saving and keyboard shortcuts.
"use strict";

// ---------- Editor events ----------
function newNote(folderId) {
  if (syncing) return;
  flushSave();
  // An empty title can never match an active search, so the new note would be
  // invisible: clear the filter first.
  if (searchQuery) { searchQuery = ""; $("search").value = ""; }
  const fid = folderId && vault.folders[folderId] ? folderId : null;
  const id = crypto.randomUUID();
  vault.notes[id] = { title: "", body: "", color: null, folderId: fid, mtime: Date.now(), media: [] };
  // Top of its group if that group is manually ordered, else un-ordered (see ensureNoteForMedia).
  { const o = topOrderOfGroup(fid); if (o !== undefined) vault.notes[id].order = o; }
  // A note created inside a collapsed folder would be hidden: open the folder.
  if (fid) revealFolder(fid);   // incl. collapsed ancestors
  persistSafe();
  openNote(id);
  $("title").focus();
}
$("new-note").onclick = () => newNote();

function startNewFolder() {
  if (syncing) return;
  clearSearch();   // the new folder is empty, so a live filter would hide it instantly
  inlineEdit = { kind: "new" };
  renderList();
  $("notelist").scrollTop = 0;
}
$("new-folder").onclick = startNewFolder;

function clearSearch() {
  if (!searchQuery && !$("search").value) return false;
  searchQuery = "";
  $("search").value = "";
  renderList();
  return true;
}
$("search").addEventListener("input", () => { searchQuery = $("search").value; renderList(); });
$("search").addEventListener("keydown", e => {
  if (e.key === "Escape" && $("search").value) {
    e.stopPropagation();     // Esc with text clears the search before any other layer
    clearSearch();
  }
});

// Loose-area drop target. Row and folder-header drops call stopPropagation, so this
// fires ONLY for a drop on the container background / empty-state -> move the note out
// of any folder and append it to the loose end. Stays active while searching (append,
// not insert). Attached once (the element persists across renders).
$("notelist").addEventListener("dragover", e => {
  if (syncing || (!draggingNoteId && !draggingFolderId)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
});
$("notelist").addEventListener("drop", e => {
  if (syncing || (!draggingNoteId && !draggingFolderId)) return;
  e.preventDefault();
  const noteId = draggingNoteId, folderId = draggingFolderId;
  finishDrag();
  if (noteId) dropIntoLoose(noteId);
  else nestFolder(folderId, null);   // background = out of any folder, like notes
});

// Right-click the empty sidebar background (or the "no notes yet" placeholder):
// offer New note / New folder. Row and folder handlers run first on their own
// element; bail if the click landed on any of them so only the blank area here
// gets this menu.
$("notelist").addEventListener("contextmenu", e => {
  if (e.target.closest(".note-item, .folder-row, .inline-folder")) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, [
    { label: "New note", disabled: syncing, onClick: () => newNote() },
    { label: "New folder...", disabled: syncing, onClick: () => startNewFolder() },
  ]);
});

$("trash-restore").onclick = () => { if (trashViewId) restoreFromTrash(trashViewId); };
$("trash-purge").onclick = () => { if (trashViewId) purgeFromTrash(trashViewId); };

$("save").onclick = manualSave;
$("pull-details").onclick = () => { panelOpen ? renderDetail() : openPanel(); };
$("pull-dismiss").onclick = dismissBanner;
for (const cid of ["chip-unsaved", "chip-unsynced", "chip-syncerr"]) $(cid).onclick = togglePanel;

let saveTimer;
for (const el of [$("title"), $("editor")])
  el.addEventListener("input", () => {
    if (trashViewId) return;   // read-only trash view owns the buffer; never adopt it
    // Typing with no note selected would otherwise own nothing and be silently
    // lost: adopt the buffer into a fresh note so it autosaves like any other.
    if (!currentId) {
      currentId = crypto.randomUUID();
      vault.notes[currentId] = { title: "", body: "", color: null, folderId: null, mtime: Date.now(), media: [] };
      // Top of the loose list if it is manually ordered, else un-ordered (see ensureNoteForMedia).
      { const o = newLooseOrder(); if (o !== undefined) vault.notes[currentId].order = o; }
      // Same reason as New note: an empty title cannot match an active filter.
      if (searchQuery) { searchQuery = ""; $("search").value = ""; }
    }
    if (statusIsError) status("");
    updateEditorEmpty();   // keep the empty-state placeholder in sync as text is typed/cleared
    historyMarkTyping();   // one undo step per burst of typing, not per keystroke
    if (!dirty) { dirty = true; renderList(); }
    // Second screen is an explicit-save session: autosaving here would commit
    // the rewrite behind your back, and the "save or cancel?" prompt on close
    // could never fire because nothing would ever be unsaved.
    if (!splitMode) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveCurrent, 400);
    }
    renderStatus();
  });

// Atomic delete of an inline wrapper: Backspace just after one, or Delete just before
// one, removes the whole node as a unit (browsers handle a contentEditable=false child
// inconsistently). Deleting an inline element NEVER touches note.media - the file stays
// in the strip, downloadable; only the body reference and its placement are dropped.
// On every page of a paged note too, not only the single-page editor.
$("edit-wrap").addEventListener("keydown", e => {
  if (trashViewId || backupView || syncing) return;
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (!r.collapsed || !surfaceOfNode(r.startContainer)) return;   // a range delete already removes any wrapper inside it; 'input' persists
  const target = e.key === "Backspace" ? wrapperOf(nodeBeforeCaret(r)) : wrapperOf(nodeAfterCaret(r));
  if (!target) return;        // caret not adjacent to a wrapper: ordinary character delete
  e.preventDefault();
  const caret = document.createRange();
  if (e.key === "Backspace") caret.setStartBefore(target); else caret.setStartAfter(target);
  caret.collapse(true);
  target.remove();
  sel.removeAllRanges();
  sel.addRange(caret);
  scheduleInlineSave();       // no 'input' fires for a scripted removal
});

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && vault) {
    e.preventDefault();
    if (!uiLayerOpen() && !trashViewId) manualSave();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l" && vault) {
    e.preventDefault();
    if (!uiLayerOpen()) lockApp();
  } else if (e.key === "Escape") {
    // Topmost layer first. The inline folder input and the search box handle
    // their own Escape and stop propagation, so they never reach this handler.
    if (typeof window.closeLightboxIfOpen === "function" && window.closeLightboxIfOpen()) return;
    if (menuIsOpen()) { closeMenu(); return; }
    if (modalIsOpen()) { if (modalCancel) modalCancel(); return; }
    if (palettePop) { paletteEscape(); return; }
    if (panelOpen) { closePanel(); return; }
    clearSearch();   // last layer: Esc clears an active filter from anywhere
  }
});

document.addEventListener("click", e => {
  if (!panelOpen) return;
  // composedPath, not contains: panel buttons re-render the panel during the
  // click, detaching the target before the event bubbles here.
  const path = e.composedPath();
  if (path.includes($("status-detail")) ||
      path.some(n => n && (n.id === "chips" || n.id === "pull-banner"))) return;
  closePanel();
});

window.addEventListener("beforeunload", e => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});
