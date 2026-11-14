/*
 * sidebar.js - the sidebar: the note list with its folder tree, dragging
 * notes and folders around it, the Unsynced section and the trash.
 *
 * Folders nest up to 5 levels. A folder's parentId syncs with the folder
 * itself, so nesting needed no merge changes; every walk up the tree is safe
 * against loops, because two devices can nest A in B and B in A
 * independently and the merge will stitch the loop together.
 *
 * Order by hand: notes and subfolders of one parent share one order space
 * (`order`, spaced ORDER_GAP apart), so a note can sit between two
 * subfolders, and a drag moves exactly one item (one mtime stamped) by taking
 * the midpoint of its new neighbours. An item without an order sorts by
 * mtime, newest first, which is how a level looks until its first drag.
 *
 * Main functions: renderList, renderListInner, noteRow, folderRow,
 * renderUnsynced, renderTrash, purgeAllTrash, revealFolder, topOrderOfGroup,
 * newLooseOrder, placeNote, reorderDrop, noteBesideFolderDrop, dropIntoFolder,
 * nestFolder, reorderFolderDrop, dropIntoLoose, finishDrag.
 * Auxiliary functions: makeElement, relativeTime, compareByName, folderName,
 * noteIdsInFolder, parentOf, folderChain, folderDepth, isDescendantOf,
 * subtreeHeight, folderPath, folderTrail, noteRailColors, applyRails,
 * groupOf, compareNotes, groupIds, siblingRecord, siblingKey, compareSiblings,
 * siblingItems, ensureSiblingOrders, reseedSiblings, orderForSlot,
 * makeRowKeyboardAccessible, showDropIndicator, clearDropIndicator,
 * clearFolderDropHighlight, showLooseDropBar, hideLooseDropBar,
 * expandFolderInline, scheduleHoverExpand, cancelHoverExpand.
 *
 * Complexity: drawing the list is O(n log n) in the notes (each level is
 * sorted) plus O(f * d) for the folder walks, d at most 5. A drop is O(s log s)
 * in the items of one level, plus one save (O(n) in the vault's size).
 */
"use strict";

// ---------- State ----------

// Folders nest at most this deep (levels 0 to 4), so the indent rails always fit the sidebar.
const MAX_NEST = 5;

// The step between two order values: room for 16 halvings between neighbours
// before a level has to be re-spaced.
const ORDER_GAP = 1 << 16;

// What is being dragged. dataTransfer cannot be read during dragover, so the
// drop targets read these instead.
let draggingNoteId = null;
let draggingFolderId = null;

// Swallows the click a finished drag leaves on the row.
let justDragged = false;

// The one row showing an insertion line.
let lastDropRow = null;

// Holding a dragged note over a folded folder opens it after a moment.
let hoverExpandTimer = null;
let hoverExpandFid = null;

// A folder was opened mid-drag: finishDrag owes the list a full redraw.
let hoverExpanded = false;

// The "drop here to leave the folder" bar, while a dragged note or folder can leave its folder.
let looseDropBar = null;

// True while the list is being drawn: an inline input losing the focus
// mid-draw must not start another draw.
let renderingList = false;

// Whether the Unsynced section is folded (it starts folded).
let unsyncedCollapsed = localStorage.getItem("unsyncedCollapsed") !== "0";

// ---------- Drawing the sidebar ----------

/**
 * Draws the whole sidebar: the note list, then the Unsynced section and the
 * trash. It is the one function that writes the list, and it does nothing
 * while a draw is already running.
 *
 * Used by: almost every change to notes or folders: attachments.js,
 * content.js, designs.js, events.js, history.js, lines.js, lock.js,
 * media-sync.js, merge.js, notes.js, pagination.js, panel.js, toolbar.js and
 * vault.js, plus this file.
 * Uses: renderListInner, renderUnsynced, renderTrash.
 * Complexity: O(n log n + f * d) over notes and folders.
 */
function renderList() {
  if (renderingList) {
    return;
  }
  renderingList = true;
  try {
    renderListInner();
  } finally {
    renderingList = false;
  }
  renderUnsynced();
  renderTrash();
}

/**
 * Draws the note list. First the Pinned section (most recently pinned first,
 * outside the folder tree), then the top level, where loose notes and folders
 * interleave in their shared order, each folder followed by its own notes and
 * subfolders unless it is folded.
 *
 * While searching, a note shows when its title or text matches, and a folder
 * when its name matches (then all its notes show), when one of its notes
 * matches, or when a folder inside it shows. Folded folders open while
 * searching, without that being remembered. A folder caught in a merged loop
 * is unreachable from the top, so it is shown at the top level instead of
 * vanishing.
 *
 * Each row gets indent rails, one coloured stripe per level; a folder's first
 * and last rows get a 4px cap on its own stripe, so each block reads as a
 * unit.
 *
 * Used by: renderList in this file.
 * Uses: saveCollapsed (core.js), isPinned (vault.js), noteMatches
 * (content.js), inlineFolderRow (notes.js), finishDrag, parentOf, folderName,
 * folderRow, noteRow, siblingItems, applyRails, makeElement, compareNotes.
 * Complexity: O(n log n + f * d).
 */
function renderListInner() {
  const list = $("notelist");
  list.innerHTML = "";
  const query = searchQuery.trim().toLowerCase();
  const searching = query.length > 0;

  // Forget folds of folders that no longer exist.
  let pruned = false;
  for (const folderId of [...collapsed]) {
    if (!vault.folders[folderId]) {
      collapsed.delete(folderId);
      pruned = true;
    }
  }
  if (pruned) {
    saveCollapsed();
  }

  const byFolder = {};
  const loose = [];
  for (const id in vault.notes) {
    // A pinned note is listed once, in the Pinned section, never again in its folder.
    if (isPinned(id)) {
      continue;
    }
    const folderId = vault.notes[id].folderId;
    if (folderId && vault.folders[folderId]) {
      (byFolder[folderId] = byFolder[folderId] || []).push(id);
    } else {
      // A note pointing at a deleted folder shows as loose.
      loose.push(id);
    }
  }
  // Each group sorts by the drag order (ordered notes first, then the rest by mtime).
  for (const folderId in byFolder) {
    byFolder[folderId].sort(compareNotes);
  }
  loose.sort(compareNotes);

  // A note shows when nothing is searched, or when its title or text contains the query.
  const visibleNote = id => !searching || noteMatches(id, query);

  if (inlineEdit && inlineEdit.kind === "new") {
    list.appendChild(inlineFolderRow(null));
  }

  // A drag whose source row this redraw is about to destroy can never finish
  // (its dragend may fire on a detached node, or not at all): clean up now,
  // so stale drag state cannot hijack the next drag. Drop handlers clear the
  // state before they change anything, so this only fires for background
  // redraws, such as a sync.
  if (draggingNoteId || draggingFolderId) {
    finishDrag();
  }

  // The folder tree: children per parent id ("" is the top level). The order
  // within a level comes from siblingItems; childrenOf only feeds reachability
  // and the search. Folders unreachable from the top (a merged loop) are
  // added to the top level, and the walked set below stops the loop.
  const childrenOf = { "": [] };
  const folderIds = Object.keys(vault.folders);
  for (const folderId of folderIds) {
    const parent = parentOf(folderId) || "";
    (childrenOf[parent] = childrenOf[parent] || []).push(folderId);
  }
  {
    const reached = new Set();
    const stack = [...childrenOf[""]];
    while (stack.length) {
      const folderId = stack.pop();
      if (reached.has(folderId)) {
        continue;
      }
      reached.add(folderId);
      for (const child of childrenOf[folderId] || []) {
        stack.push(child);
      }
    }
    for (const folderId of folderIds) {
      if (!reached.has(folderId)) {
        childrenOf[""].push(folderId);
      }
    }
  }

  // While searching: which notes of each folder show, and which folders show.
  const visibleNotes = {};
  const showFolder = {};
  const visited = new Set();
  const computeVisibility = folderId => {
    // Loop guard.
    if (visited.has(folderId)) {
      return false;
    }
    visited.add(folderId);
    const all = byFolder[folderId] || [];
    const nameMatches = searching && folderName(folderId).toLowerCase().includes(query);
    visibleNotes[folderId] = (!searching || nameMatches) ? all : all.filter(visibleNote);
    let show = !searching || nameMatches || visibleNotes[folderId].length > 0;
    for (const child of childrenOf[folderId] || []) {
      show = computeVisibility(child) || show;
    }
    return (showFolder[folderId] = show);
  };
  for (const folderId of childrenOf[""]) {
    computeVisibility(folderId);
  }

  // The walk appends rows and records each row's rails. Rails and indent stop
  // at MAX_NEST, so a deeper merged chain still nests in the data but never
  // pushes its stripes or text out of the sidebar.
  let rows = 0;
  const rowDescriptions = [];
  const walked = new Set();
  const pushRow = (el, colors) => {
    list.appendChild(el);
    rowDescriptions.push({ el, rails: colors.map(color => ({ color })) });
  };
  const walkFolder = (folderId, colors) => {
    if (walked.has(folderId) || (searching && !showFolder[folderId])) {
      return;
    }
    walked.add(folderId);
    if (inlineEdit && inlineEdit.kind === "rename" && inlineEdit.folderId === folderId) {
      pushRow(inlineFolderRow(folderId, colors.length), colors);
    } else {
      // The count includes the folder's pinned notes, which are listed in the Pinned section instead.
      pushRow(folderRow(folderId, visibleNotes[folderId].length + (pinnedIn[folderId] || 0), colors), colors);
    }
    rows++;
    // While searching, folds are ignored (a match hidden in a folded folder
    // reads as lost data) and never written.
    if (!searching && collapsed.has(folderId)) {
      return;
    }
    const clamped = colors.length >= MAX_NEST;
    const ownColors = clamped ? colors : [...colors, (vault.folders[folderId].color || null)];
    const start = rowDescriptions.length;
    // Its notes and subfolders interleave in their shared order, so a note
    // dragged between two subfolders stays there.
    const visible = new Set(visibleNotes[folderId]);
    for (const item of siblingItems(folderId)) {
      if (item.kind === "note") {
        if (visible.has(item.id)) {
          pushRow(noteRow(item.id, ownColors), ownColors);
        }
      } else {
        walkFolder(item.id, ownColors);
      }
    }
    if (!clamped && rowDescriptions.length > start) {
      rowDescriptions[start].rails[ownColors.length - 1].capTop = true;
      rowDescriptions[rowDescriptions.length - 1].rails[ownColors.length - 1].capBottom = true;
    }
  };

  // The Pinned section: every pinned note that passes the search, most
  // recently pinned first. These rows sit outside the folder tree, so they
  // get no rails, cannot be dragged and are not drop targets (see noteRow).
  const pinnedIds = Object.keys(vault.notes).filter(id => isPinned(id) && visibleNote(id))
    .sort((a, b) => (vault.pins[b].at || 0) - (vault.pins[a].at || 0));
  // How many shown pinned notes belong to each folder, added to that folder's count.
  const pinnedIn = {};
  for (const id of pinnedIds) {
    const folderId = vault.notes[id].folderId;
    if (folderId) {
      pinnedIn[folderId] = (pinnedIn[folderId] || 0) + 1;
    }
  }
  if (pinnedIds.length) {
    list.appendChild(makeElement("div", "list-label", "Pinned"));
    for (const id of pinnedIds) {
      list.appendChild(noteRow(id, []));
      rows++;
    }
    // A second label marks where the ordinary list starts, so the two never blur together.
    list.appendChild(makeElement("div", "list-label", "Notes"));
  }

  // The top level: loose notes and top folders interleave the same way.
  // Folders caught in a loop follow at the end, through childrenOf[""].
  for (const item of siblingItems(null)) {
    if (item.kind === "note") {
      // Pinned notes were listed above.
      if (!isPinned(item.id) && visibleNote(item.id)) {
        pushRow(noteRow(item.id, []), []);
        rows++;
      }
    } else {
      walkFolder(item.id, []);
    }
  }
  for (const folderId of childrenOf[""]) {
    walkFolder(folderId, []);
  }
  for (const description of rowDescriptions) {
    applyRails(description.el, description.rails);
  }

  // No empty-list text under an open inline input: "No notes yet" beneath the
  // new folder's name field invites a click that blurs the input away.
  if (!rows && !inlineEdit) {
    list.appendChild(makeElement("div", "empty-state",
      searching ? "No notes match this search" : "No notes yet - press New note"));
  }
}

/**
 * One note's row: colour, title, an unsynced dot, and below it either where
 * a search matched its text or its date (and, for a pinned note, its folder).
 * A click opens the note, a right-click opens its menu, and it can be
 * dragged: dropped on another row it moves above or below that row. Pinned
 * rows cannot be dragged and take no drops, since they sit outside their
 * folder's order. While searching, drops on rows are refused: the visible
 * neighbours are filtered, so a position would mean nothing.
 *
 * Used by: renderListInner and expandFolderInline in this file.
 * Uses: makeElement, applyRails, isUnsynced and isPinned (vault.js),
 * bodySnippet (content.js), folderName, relativeTime, flushSave and openNote
 * (pagination.js), openMenu (menu.js), noteMenu (notes.js),
 * showLooseDropBar, finishDrag, showDropIndicator, clearDropIndicator,
 * reorderDrop, makeRowKeyboardAccessible.
 * Complexity: O(1), plus a text search for the snippet while searching.
 */
function noteRow(id, railColors = []) {
  const note = vault.notes[id];
  const div = makeElement("div",
    "note-item" + (id === currentId ? " active" : "") + (railColors.length ? " in-folder" : ""));
  if (railColors.length) {
    // 12px per level of nesting.
    div.style.paddingLeft = (9 + 12 * railColors.length) + "px";
    // The walk applies the capped rails afterwards.
    applyRails(div, railColors.map(color => ({ color })));
  }
  if (note.color) {
    div.style.borderLeftColor = note.color;
  }

  const row = makeElement("div", "note-title");
  const dot = makeElement("span", "color-dot");
  if (note.color) {
    dot.style.background = note.color;
  }
  row.appendChild(dot);
  row.appendChild(makeElement("span", "t" + (note.title ? "" : " untitled"), note.title || "(untitled)"));
  // Always there, only shown or hidden: adding it only when needed made the
  // title jump on every save and sync.
  const unsyncedDot = makeElement("span", "dot", "●");
  unsyncedDot.style.visibility = (isUnsynced(id) || (id === currentId && unsavedEdits)) ? "" : "hidden";
  row.appendChild(unsyncedDot);
  div.appendChild(row);

  // The second line: while searching, where the text matched; otherwise the date.
  const query = searchQuery.trim().toLowerCase();
  const pinned = isPinned(id);
  // A query the title does not contain must have matched the text: show it.
  const snippet = query && !(note.title || "").toLowerCase().includes(query) ? bodySnippet(id, query) : null;
  if (snippet) {
    div.appendChild(snippet);
  } else {
    // A pinned row has left its folder's place in the list, so its date line names the folder.
    const where = pinned && note.folderId && vault.folders[note.folderId] ? folderName(note.folderId) + " · " : "";
    div.appendChild(makeElement("div", "note-meta", where + relativeTime(note.mtime)));
  }
  // The class draws the small pin mark.
  if (pinned) {
    div.classList.add("pinned");
  }

  // A real click never starts a drag (native drag only starts past the
  // system's threshold), so it opens the note; the click a finished drag
  // leaves behind is swallowed. The keyboard (below) is unaffected.
  div.onclick = () => {
    if (justDragged) {
      return;
    }
    flushSave();
    openNote(id);
  };
  div.oncontextmenu = event => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, noteMenu(id));
  };

  // Dragging: not mid-sync, not in a backup view, and not a pinned row.
  div.draggable = !syncing && !backupView && !pinned;
  div.addEventListener("dragstart", event => {
    if (syncing) {
      event.preventDefault();
      return;
    }
    draggingNoteId = id;
    event.dataTransfer.effectAllowed = "move";
    // A private type only: no Files and no text/plain, so the editor's file
    // and text drop handlers ignore it, and the id can never land in a note.
    try {
      event.dataTransfer.setData("application/x-note-id", id);
    } catch {}
    div.classList.add("dragging");
    // A note in a folder needs a target to leave it even when the list has no
    // free space to aim at: a drop bar shows for the length of the drag.
    if (vault.notes[id] && vault.notes[id].folderId && vault.folders[vault.notes[id].folderId] && !searchQuery.trim()) {
      showLooseDropBar();
    }
  });
  div.addEventListener("dragend", () => {
    div.classList.remove("dragging");
    finishDrag();
  });

  div.addEventListener("dragover", event => {
    // A pinned row is never a target: its neighbours in the Pinned section are not its folder's.
    if (syncing || !draggingNoteId || draggingNoteId === id || searchQuery.trim() || pinned) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = div.getBoundingClientRect();
    showDropIndicator(div, event.clientY > box.top + box.height / 2);
  });
  div.addEventListener("dragleave", () => {
    if (lastDropRow === div) {
      clearDropIndicator();
    }
  });
  div.addEventListener("drop", event => {
    // A folder dropped on a note row is ambiguous: swallowed (folders land only
    // on folder rows, the drop bar or the background), so it cannot bubble to
    // the list's handler and jump to the top level.
    if (draggingFolderId) {
      event.preventDefault();
      event.stopPropagation();
      finishDrag();
      return;
    }
    if (syncing || !draggingNoteId) {
      return;
    }
    // Not also the list's own drop handler.
    event.stopPropagation();
    // While searching, on the row itself, or on a pinned row: swallowed, so
    // it cannot land at a meaningless position.
    if (searchQuery.trim() || draggingNoteId === id || pinned) {
      event.preventDefault();
      finishDrag();
      return;
    }
    event.preventDefault();
    const dragId = draggingNoteId;
    const box = div.getBoundingClientRect();
    const below = event.clientY > box.top + box.height / 2;
    finishDrag();
    reorderDrop(dragId, id, below);
  });

  // Deleting lives only in the menu, so the menu must be reachable without a mouse.
  makeRowKeyboardAccessible(div, () => {
    flushSave();
    openNote(id);
  }, () => noteMenu(id));
  return div;
}

/**
 * One folder's row: arrow, colour, name and note count. A click folds or
 * unfolds it (not while searching), a right-click opens its menu. It can be
 * dragged, and it takes drops in three zones: the top and bottom quarters
 * place the dragged item before or after this folder (in its parent's
 * order), the middle half puts it inside. Holding a dragged note over a
 * folded folder opens it after 600 ms, so the note can be dropped among its
 * notes. While searching every drop goes inside (no position would mean
 * anything).
 *
 * Used by: renderListInner in this file.
 * Uses: makeElement, saveCollapsed (core.js), renderList, openMenu (menu.js),
 * folderMenu (notes.js), parentOf, showLooseDropBar, finishDrag,
 * isDescendantOf, clearDropIndicator, showDropIndicator, scheduleHoverExpand,
 * cancelHoverExpand, dropIntoFolder, noteBesideFolderDrop, nestFolder,
 * reorderFolderDrop, makeRowKeyboardAccessible.
 * Complexity: O(1); the descendant check during a drag is O(d).
 */
function folderRow(folderId, count, railColors = []) {
  const folder = vault.folders[folderId];
  const searching = searchQuery.trim().length > 0;
  const open = searching || !collapsed.has(folderId);

  const row = makeElement("div", "folder-row" + (railColors.length ? " nested" : ""));
  if (railColors.length) {
    row.style.paddingLeft = (9 + 12 * railColors.length) + "px";
  }
  row.appendChild(makeElement("span", "folder-arrow" + (open ? " open" : ""), "▶"));
  const dot = makeElement("span", "color-dot");
  if (folder.color) {
    dot.style.background = folder.color;
  }
  row.appendChild(dot);
  row.appendChild(makeElement("span", "folder-name", folder.name || "(unnamed)"));
  row.appendChild(makeElement("span", "folder-count", String(count)));

  row.onclick = () => {
    // The click a finished drag leaves behind.
    if (justDragged) {
      return;
    }
    // Folding does nothing while searching.
    if (searching) {
      return;
    }
    if (collapsed.has(folderId)) {
      collapsed.delete(folderId);
    } else {
      collapsed.add(folderId);
    }
    saveCollapsed();
    renderList();
  };
  row.oncontextmenu = event => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, folderMenu(folderId));
  };

  // Dragging the folder: into another folder, or out to the top level.
  row.draggable = !syncing && !backupView;
  row.addEventListener("dragstart", event => {
    if (syncing) {
      event.preventDefault();
      return;
    }
    draggingFolderId = folderId;
    event.dataTransfer.effectAllowed = "move";
    // A private type only, as for notes: the editor's drop handlers ignore it.
    try {
      event.dataTransfer.setData("application/x-folder-id", folderId);
    } catch {}
    row.classList.add("dragging");
    if (parentOf(folderId) && !searchQuery.trim()) {
      showLooseDropBar("Drop here to move to top level");
    }
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    finishDrag();
  });

  // "before", "after" or "into".
  const folderDropZone = event => {
    if (searchQuery.trim()) {
      return "into";
    }
    const box = row.getBoundingClientRect();
    const position = (event.clientY - box.top) / box.height;
    return position < .25 ? "before" : position > .75 ? "after" : "into";
  };
  row.addEventListener("dragover", event => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) {
      return;
    }
    // A folder can never go into itself or its own subfolders (a loop).
    if (draggingFolderId && (draggingFolderId === folderId || isDescendantOf(folderId, draggingFolderId))) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const zone = folderDropZone(event);
    if (zone === "into") {
      clearDropIndicator();
      row.classList.add("drop-target");
    } else {
      row.classList.remove("drop-target");
      showDropIndicator(row, zone === "after");
    }
    if (zone === "into" && draggingNoteId && !searchQuery.trim() && collapsed.has(folderId)) {
      scheduleHoverExpand(folderId, row);
    }
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-target");
    if (lastDropRow === row) {
      clearDropIndicator();
    }
    if (hoverExpandFid === folderId) {
      cancelHoverExpand();
    }
  });
  row.addEventListener("drop", event => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const noteId = draggingNoteId;
    const draggedFolderId = draggingFolderId;
    const zone = folderDropZone(event);
    finishDrag();
    if (noteId) {
      if (zone === "into") {
        dropIntoFolder(noteId, folderId);
      } else {
        noteBesideFolderDrop(noteId, folderId, zone === "after");
      }
    } else if (zone === "into") {
      nestFolder(draggedFolderId, folderId);
    } else {
      reorderFolderDrop(draggedFolderId, folderId, zone === "after");
    }
  });

  makeRowKeyboardAccessible(row, () => row.onclick(), () => folderMenu(folderId));
  return row;
}

/**
 * Draws the Unsynced section above the trash: everything the repo does not
 * have yet, folded like the trash. Each entry shows where it lives
 * ("Design/Title") above its title; notes and trashed notes open on click.
 * The path is a location you named, so it is never translated. Hidden while
 * nothing is unsynced.
 *
 * Used by: renderList in this file, pagination.js (renderStatus).
 * Uses: the unsynced lists (vault.js), makeElement, compareByName,
 * folderName, folderTrail, makeRowKeyboardAccessible, t (i18n.js), flushSave,
 * openNote and openTrash (pagination.js).
 * Complexity: O(n log n + f log f + t) over notes, folders and trash.
 */
function renderUnsynced() {
  const section = $("unsynced-section");
  const head = $("unsynced-head");
  const list = $("unsynced-list");
  if (!section || !vault) {
    return;
  }

  const noteIds = unsyncedIds().sort((a, b) => vault.notes[b].mtime - vault.notes[a].mtime);
  const folderIds = unsyncedFolderIds().sort((a, b) => compareByName(folderName(a), folderName(b)));
  const trashIds = unsyncedTrashIds();
  const deletedNoteIds = pendingNoteDeletions();
  const deletedFolderIds = pendingFolderDeletions();
  const total = noteIds.length + folderIds.length + trashIds.length + deletedNoteIds.length + deletedFolderIds.length;
  section.style.display = total ? "" : "none";
  if (!total) {
    return;
  }

  head.innerHTML = "";
  head.appendChild(makeElement("span", "folder-arrow" + (unsyncedCollapsed ? "" : " open"), "▶"));
  head.appendChild(makeElement("span", "folder-name ui-label", `Unsynced content (${total})`));
  head.onclick = () => {
    unsyncedCollapsed = !unsyncedCollapsed;
    localStorage.setItem("unsyncedCollapsed", unsyncedCollapsed ? "1" : "0");
    renderUnsynced();
  };
  list.innerHTML = "";
  list.style.display = unsyncedCollapsed ? "none" : "";
  if (unsyncedCollapsed) {
    return;
  }

  // One entry: the path line, then the title.
  const entry = (path, title, open) => {
    const div = makeElement("div", "unsynced-item" + (open ? "" : " inert"));
    const pathLine = makeElement("div", "note-path", path);
    pathLine.setAttribute("translate", "no");
    div.appendChild(pathLine);
    const row = makeElement("div", "note-title");
    row.appendChild(makeElement("span", "t" + (title ? "" : " untitled"), title || "(untitled)"));
    div.appendChild(row);
    if (open) {
      div.onclick = open;
      makeRowKeyboardAccessible(div, open, () => []);
    }
    list.appendChild(div);
  };
  const untitled = () => t("(untitled)");

  for (const id of noteIds) {
    const note = vault.notes[id];
    entry((note.folderId ? folderTrail(note.folderId) : "") + "/" + (note.title || untitled()), note.title, () => {
      flushSave();
      openNote(id);
    });
  }
  for (const folderId of folderIds) {
    entry(folderTrail(folderId) + "/", folderName(folderId), null);
  }
  for (const id of trashIds) {
    const data = vault.trash[id].data || {};
    entry(t("Trash") + "/" + (data.title || untitled()), data.title, () => openTrash(id));
  }
  for (const id of deletedNoteIds) {
    entry(t("deleted"), deletedTitles[id] || "", null);
  }
  for (const folderId of deletedFolderIds) {
    entry(t("deleted"), t("folder"), null);
  }
}

/**
 * Draws the trash at the bottom of the sidebar, newest first and never
 * filtered by the search. Unfolded, it offers "Delete all" (not in a backup
 * view). A click opens a trashed note read-only; a right-click offers
 * Restore and Delete permanently.
 *
 * Used by: renderList in this file.
 * Uses: makeElement, relativeTime, purgeAllTrash, renderList, openTrash
 * (pagination.js), openMenu (menu.js), trashMenu (notes.js),
 * makeRowKeyboardAccessible.
 * Complexity: O(t log t) in the trash entries.
 */
function renderTrash() {
  const head = $("trash-head");
  const list = $("trash-list");
  const ids = Object.keys(vault.trash)
    .sort((a, b) => (vault.trash[b].deletedAt || 0) - (vault.trash[a].deletedAt || 0));

  head.innerHTML = "";
  head.appendChild(makeElement("span", "folder-arrow" + (trashCollapsed ? "" : " open"), "▶"));
  head.appendChild(makeElement("span", "folder-name ui-label", `Trash (${ids.length})`));
  if (!trashCollapsed && ids.length && !backupView) {
    const clear = makeElement("button", "trash-clear", "Delete all");
    clear.type = "button";
    clear.title = "Delete every trashed note permanently";
    clear.disabled = syncing;
    clear.onclick = event => {
      event.stopPropagation();
      purgeAllTrash();
    };
    head.appendChild(clear);
  }
  head.onclick = () => {
    trashCollapsed = !trashCollapsed;
    localStorage.setItem("trashCollapsed", trashCollapsed ? "1" : "0");
    renderList();
  };

  list.innerHTML = "";
  list.style.display = trashCollapsed ? "none" : "";
  if (trashCollapsed) {
    return;
  }
  if (!ids.length) {
    list.appendChild(makeElement("div", "empty-state", "Trash is empty"));
    return;
  }

  for (const id of ids) {
    const entry = vault.trash[id];
    const data = entry.data || {};
    const div = makeElement("div", "trash-item" + (id === trashViewId ? " active" : ""));
    const row = makeElement("div", "note-title");
    row.appendChild(makeElement("span", "t" + (data.title ? "" : " untitled"), data.title || "(untitled)"));
    div.appendChild(row);
    div.appendChild(makeElement("div", "note-meta", "deleted " + relativeTime(entry.deletedAt || 0)));
    div.onclick = () => openTrash(id);
    div.oncontextmenu = event => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY, trashMenu(id));
    };
    makeRowKeyboardAccessible(div, () => openTrash(id), () => trashMenu(id));
    list.appendChild(div);
  }
}

/**
 * Empties the trash for good, after one question for everything.
 *
 * Used by: renderTrash in this file (Delete all).
 * Uses: confirmModal (modal.js), purgeTrashCore (notes.js), persistSafe
 * (vault.js), renderList, renderStatus and status (pagination.js).
 * Complexity: O(t * a * n * b), each entry's attachments checked against
 * every note, plus one save.
 */
async function purgeAllTrash() {
  const count = Object.keys(vault.trash).length;
  if (syncing || backupView || !count) {
    return;
  }
  const ok = await confirmModal({
    title: `Empty the trash (${count} note${count === 1 ? "" : "s"})?`,
    body: "Every note in the trash and its attachments will be removed from this device and, on the next sync, from the repo. This cannot be undone.",
    confirmLabel: "Delete all permanently",
    destructive: true,
  });
  if (!ok || syncing || backupView || !vault) {
    return;
  }
  for (const id of Object.keys(vault.trash)) {
    purgeTrashCore(id);
  }
  persistSafe();
  renderList();
  renderStatus();
  status("Trash emptied");
}

// ---------- Folders ----------

/**
 * Shows a folder in the sidebar: unfolds it and every folder around it. A
 * folded parent hides everything inside it, so unfolding only the folder
 * itself would still leave a moved or new item out of sight.
 *
 * Used by: this file (placeNote, nestFolder, reorderFolderDrop), events.js
 * (newNote), notes.js (setNoteFolder, folderMenu), designs.js (designItems,
 * importDesign, newDesign), pagination.js (openNote).
 * Uses: folderChain, saveCollapsed (core.js).
 * Complexity: O(d) in the folder's depth.
 */
function revealFolder(folderId) {
  let changed = collapsed.delete(folderId);
  for (const parent of folderChain(folderId)) {
    changed = collapsed.delete(parent) || changed;
  }
  if (changed) {
    saveCollapsed();
  }
}

// ---------- Ordering and moving by hand ----------

/**
 * The order value that places a new item at the top of a level, or undefined
 * while nothing in that level has an order yet (then the new note is left
 * without one and the level keeps sorting by date).
 *
 * Used by: events.js (newNote), notes.js (restoreFromTrash), content.js
 * (duplicateNote), designs.js (importDesign, newDesign), and newLooseOrder.
 * Uses: siblingItems, siblingRecord.
 * Complexity: O(s log s) in the items of the level.
 */
function topOrderOfGroup(folderId) {
  let min = Infinity;
  let any = false;
  for (const item of siblingItems(folderId || null)) {
    const order = siblingRecord(item).order;
    if (typeof order === "number") {
      any = true;
      if (order < min) {
        min = order;
      }
    }
  }
  return any ? min - ORDER_GAP : undefined;
}

/**
 * The order value for a new loose note at the top of the top level.
 *
 * Used by: events.js (typing with no note open), attachments.js (ensureNoteForMedia).
 * Uses: topOrderOfGroup.
 * Complexity: O(s log s).
 */
function newLooseOrder() {
  return topOrderOfGroup(null);
}

/**
 * The one change every note reorder or move goes through: a new order and/or
 * folder, the mtime stamped (the merge decides by mtime, so a move that left
 * it alone would never reach the other devices and never light the unsynced
 * dot), the folder shown, then a save and a redraw.
 *
 * Used by: reorderDrop, noteBesideFolderDrop, dropIntoFolder and
 * dropIntoLoose in this file.
 * Uses: revealFolder, persistSafe (vault.js), renderList, renderStatus (pagination.js).
 * Complexity: O(1) plus one save and a redraw.
 */
function placeNote(id, order, folderId) {
  if (syncing || !vault.notes[id]) {
    return;
  }
  const note = vault.notes[id];
  if (typeof order === "number") {
    note.order = order;
  }
  if (folderId !== undefined) {
    note.folderId = folderId;
  }
  note.mtime = Date.now();
  // Its folder and every folder around it, or the note vanishes.
  if (folderId) {
    revealFolder(folderId);
  }
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Drops a dragged note above or below another note: it takes that place in
 * the target's group, moving into the group in the same change (one mtime)
 * when it came from another. A drop that would leave it exactly where it was
 * changes nothing, so an idle drag never shows an unsynced dot.
 *
 * Used by: noteRow in this file (a drop on a note).
 * Uses: groupOf, orderForSlot, placeNote.
 * Complexity: O(s log s) in the level, plus one save.
 */
function reorderDrop(dragId, targetId, below) {
  if (syncing || !vault.notes[dragId] || !vault.notes[targetId] || dragId === targetId) {
    return;
  }
  const folderId = groupOf(targetId);
  const order = orderForSlot(folderId, { kind: "note", id: dragId }, { kind: "note", id: targetId }, below);
  if (order === null) {
    return;
  }
  placeNote(dragId, order, groupOf(dragId) === folderId ? undefined : folderId);
}

/**
 * Drops a note above or below a folder's row: the note lands in that folder's
 * parent at that position. Between two subfolders it still simply belongs to
 * the parent, or becomes loose when the folder is at the top level.
 *
 * Used by: folderRow in this file (a drop on a folder's edge).
 * Uses: parentOf, orderForSlot, groupOf, placeNote.
 * Complexity: O(s log s), plus one save.
 */
function noteBesideFolderDrop(dragId, targetFolderId, below) {
  if (syncing || !vault.notes[dragId] || !vault.folders[targetFolderId]) {
    return;
  }
  const parentId = parentOf(targetFolderId);
  const order = orderForSlot(parentId, { kind: "note", id: dragId }, { kind: "folder", id: targetFolderId }, below);
  if (order === null) {
    return;
  }
  placeNote(dragId, order, groupOf(dragId) === (parentId || null) ? undefined : (parentId || null));
}

/**
 * Drops a note on a folder's middle (or on a folder opened mid-drag): it goes
 * to the very end of that folder, after its notes and subfolders.
 *
 * Used by: folderRow in this file.
 * Uses: siblingItems, groupOf, ensureSiblingOrders, siblingRecord, placeNote.
 * Complexity: O(s log s), plus one save.
 */
function dropIntoFolder(dragId, folderId) {
  if (syncing || !vault.notes[dragId] || !vault.folders[folderId]) {
    return;
  }
  const full = siblingItems(folderId);
  const already = groupOf(dragId) === folderId;
  const lastItem = full.length ? full[full.length - 1] : null;
  // Already the last item there.
  if (already && lastItem && lastItem.kind === "note" && lastItem.id === dragId) {
    return;
  }
  // After the no-op check: see orderForSlot.
  ensureSiblingOrders(folderId);
  const rest = siblingItems(folderId).filter(item => !(item.kind === "note" && item.id === dragId));
  const last = rest.length ? siblingRecord(rest[rest.length - 1]) : null;
  placeNote(dragId, last ? last.order + ORDER_GAP : ORDER_GAP, already ? undefined : folderId);
}

/**
 * Drops a note on the list's background: it goes to the very end of the top level.
 *
 * Used by: events.js (a drop on the list's background), showLooseDropBar in this file.
 * Uses: siblingItems, groupOf, ensureSiblingOrders, siblingRecord, placeNote.
 * Complexity: O(s log s), plus one save.
 */
function dropIntoLoose(dragId) {
  if (syncing || !vault.notes[dragId]) {
    return;
  }
  const full = siblingItems(null);
  const already = groupOf(dragId) === null;
  const lastItem = full.length ? full[full.length - 1] : null;
  // Already the last item there.
  if (already && lastItem && lastItem.kind === "note" && lastItem.id === dragId) {
    return;
  }
  // After the no-op check: see orderForSlot.
  ensureSiblingOrders(null);
  const rest = siblingItems(null).filter(item => !(item.kind === "note" && item.id === dragId));
  const last = rest.length ? siblingRecord(rest[rest.length - 1]) : null;
  placeNote(dragId, last ? last.order + ORDER_GAP : ORDER_GAP, already ? undefined : null);
}

/**
 * Moves a folder into another folder, or to the top level (parentId null).
 * It refuses loops and nesting deeper than MAX_NEST, so the rails always fit.
 * Nothing happens when the stored parent already is the request: a dangling
 * parent (deleted by a merge) shows at the top level, and an explicit move
 * to the top must clear it, or the stale id keeps syncing, waiting to nest
 * the folder again.
 *
 * Used by: folderRow and showLooseDropBar in this file, events.js (a drop on
 * the list's background), notes.js (moveFolderItems).
 * Uses: isDescendantOf, folderDepth, subtreeHeight, status and renderStatus
 * (pagination.js), revealFolder, persistSafe (vault.js), renderList.
 * Complexity: O(f * d) for the depth checks, plus one save.
 */
function nestFolder(folderId, parentId) {
  if (syncing || !vault.folders[folderId]) {
    return;
  }
  if (parentId === folderId || (parentId || null) === (vault.folders[folderId].parentId || null)) {
    return;
  }
  if (parentId) {
    if (!vault.folders[parentId]) {
      return;
    }
    if (isDescendantOf(parentId, folderId)) {
      status("Can't move a folder into its own subfolder", true);
      return;
    }
    if (folderDepth(parentId) + 1 + subtreeHeight(folderId) >= MAX_NEST) {
      status(`Folders only nest ${MAX_NEST} levels deep`, true);
      return;
    }
  }
  vault.folders[folderId].parentId = parentId || null;
  vault.folders[folderId].mtime = Date.now();
  // A folder moved under folded parents would vanish: unfold them.
  if (parentId) {
    revealFolder(parentId);
  }
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Drops a folder above or below another folder: it takes that place in the
 * target's level (folders and notes interleave), moving to the target's
 * parent in the same change when it lives elsewhere. The nesting checks of
 * nestFolder apply only when it changes level, so a merged chain that is too
 * deep can still be rearranged in place. A drop that changes nothing writes
 * nothing, except clearing a dangling parent, which must be written even
 * when the folder stays where it shows.
 *
 * Used by: folderRow in this file.
 * Uses: parentOf, isDescendantOf, folderDepth, subtreeHeight, status and
 * renderStatus (pagination.js), orderForSlot, revealFolder, persistSafe
 * (vault.js), renderList.
 * Complexity: O(s log s + f * d), plus one save.
 */
function reorderFolderDrop(dragId, targetId, below) {
  if (syncing || !vault.folders[dragId] || !vault.folders[targetId] || dragId === targetId) {
    return;
  }
  const newParent = parentOf(targetId);
  const storedParent = vault.folders[dragId].parentId || null;
  // Includes clearing a dangling parent.
  const reParent = (newParent || null) !== storedParent;
  if (reParent && newParent) {
    if (newParent === dragId || isDescendantOf(newParent, dragId)) {
      status("Can't move a folder into its own subfolder", true);
      return;
    }
    if (folderDepth(targetId) + subtreeHeight(dragId) >= MAX_NEST) {
      status(`Folders only nest ${MAX_NEST} levels deep`, true);
      return;
    }
  }

  const order = orderForSlot(newParent, { kind: "folder", id: dragId }, { kind: "folder", id: targetId }, below);
  if (order === null && !reParent) {
    return;
  }
  const folder = vault.folders[dragId];
  if (order !== null) {
    folder.order = order;
  }
  folder.parentId = newParent || null;
  folder.mtime = Date.now();
  if (newParent) {
    revealFolder(newParent);
  }
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Cleans up after a drag, and may run twice: from the drop handler before
 * the redraw, and again from dragend (which may fire on a detached row). A
 * folder opened mid-drag is remembered open. If one was opened, the list is
 * redrawn: that quick opening added the folder's notes only, and a
 * cancelled drag would leave that half-drawn state on screen.
 *
 * Used by: this file (rows, the drop bar, renderListInner), events.js (a drop
 * on the list's background).
 * Uses: clearDropIndicator, clearFolderDropHighlight, hideLooseDropBar,
 * cancelHoverExpand, saveCollapsed (core.js), renderList.
 * Complexity: O(r) in the rows it un-highlights.
 */
function finishDrag() {
  clearDropIndicator();
  clearFolderDropHighlight();
  hideLooseDropBar();
  cancelHoverExpand();
  saveCollapsed();
  draggingNoteId = null;
  draggingFolderId = null;
  justDragged = true;
  setTimeout(() => {
    justDragged = false;
  }, 0);
  if (hoverExpanded) {
    hoverExpanded = false;
    renderList();
  }
}

// =================== Auxiliary functions ===================

/** Makes an element with an optional class and text. Used across the app. Complexity: O(1). */
function makeElement(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) {
    el.className = cls;
  }
  if (text != null) {
    el.textContent = text;
  }
  return el;
}

/** "just now", "5m ago", "3h ago", "yesterday", or a short date. Complexity: O(1). */
function relativeTime(time) {
  const elapsed = Date.now() - time;
  if (elapsed < 60e3) {
    return "just now";
  }
  if (elapsed < 3600e3) {
    return Math.floor(elapsed / 60e3) + "m ago";
  }
  if (elapsed < 86400e3) {
    return Math.floor(elapsed / 3600e3) + "h ago";
  }
  const date = new Date(time);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "yesterday";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compares two names alphabetically, ignoring case. Complexity: O(k) in their length. */
function compareByName(a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

/** A folder's name, or "(unnamed)". Complexity: O(1). */
function folderName(folderId) {
  return (vault.folders[folderId] && vault.folders[folderId].name) || "(unnamed)";
}

/** The ids of the notes directly inside a folder. Complexity: O(n). */
function noteIdsInFolder(folderId) {
  return Object.keys(vault.notes).filter(id => vault.notes[id].folderId === folderId);
}

/**
 * A folder's parent, or null at the top level (also when the parent is
 * missing, or is the folder itself). Complexity: O(1).
 */
function parentOf(folderId) {
  const folder = vault.folders[folderId];
  const parent = folder && folder.parentId;
  return (parent && parent !== folderId && vault.folders[parent]) ? parent : null;
}

/** A folder's parents, nearest first; it stops at a repeat, so a merged loop just ends. Complexity: O(d). */
function folderChain(folderId) {
  const out = [];
  const seen = new Set([folderId]);
  for (let parent = parentOf(folderId); parent && !seen.has(parent); parent = parentOf(parent)) {
    out.push(parent);
    seen.add(parent);
  }
  return out;
}

/** How deep a folder sits (0 at the top level). Complexity: O(d). */
function folderDepth(folderId) {
  return folderChain(folderId).length;
}

/** Whether a folder is inside another, at any depth. Complexity: O(d). */
function isDescendantOf(folderId, ancestor) {
  return folderChain(folderId).includes(ancestor);
}

/**
 * How many folder levels sit under a folder (0 for none). A merged loop
 * stops at the guard instead of overflowing the stack. Complexity: O(f * d).
 */
function subtreeHeight(folderId, guard = 0) {
  if (guard > MAX_NEST + 2) {
    return 0;
  }
  let height = 0;
  for (const id in vault.folders) {
    if (parentOf(id) === folderId) {
      height = Math.max(height, 1 + subtreeHeight(id, guard + 1));
    }
  }
  return height;
}

/** A folder's full path for menus: "Root / Sub / Leaf". Complexity: O(d). */
function folderPath(folderId) {
  return [...folderChain(folderId)].reverse().concat(folderId).map(folderName).join(" / ");
}

/** A folder's path for the Unsynced section: "Root/Sub/Leaf" ("" for none). Complexity: O(d). */
function folderTrail(folderId) {
  return folderId ? [...folderChain(folderId)].reverse().concat(folderId).map(folderName).join("/") : "";
}

/**
 * The rail colours for notes directly inside a folder, outermost first, cut
 * at MAX_NEST with the same rule as the list's walk, so rows added mid-drag
 * match the redrawn ones. Complexity: O(d).
 */
function noteRailColors(folderId) {
  const path = [...folderChain(folderId)].reverse().concat(folderId);
  return (path.length > MAX_NEST ? path.slice(0, MAX_NEST) : path)
    .map(id => (vault.folders[id] && vault.folders[id].color) || null);
}

/**
 * Paints a row's indent rails as CSS backgrounds: one 2px stripe per level at
 * x = 10 + 12 * level, dimmed at rest so bright folder colours do not shout.
 * --rails-hi (on hover and for the open note) lights the innermost stripe in
 * full. A capped stripe is inset 4px at its top or bottom. Complexity: O(d).
 */
function applyRails(el, rails) {
  if (!rails.length) {
    return;
  }
  const layer = (rail, level, highlighted) => {
    const color = rail.color || "#8a8a8a";
    const paint = highlighted ? color : `color-mix(in srgb, ${color} 45%, transparent)`;
    const top = rail.capTop ? 4 : 0;
    const cut = top + (rail.capBottom ? 4 : 0);
    return `linear-gradient(${paint}, ${paint}) ${10 + 12 * level}px ${top}px / 2px calc(100% - ${cut}px) no-repeat`;
  };
  el.style.setProperty("--rails", rails.map((rail, level) => layer(rail, level, false)).join(", "));
  el.style.setProperty("--rails-hi", rails.map((rail, level) => layer(rail, level, level === rails.length - 1)).join(", "));
}

/** A note's group: its folder, or null when loose (a deleted folder counts as loose). Complexity: O(1). */
function groupOf(id) {
  const note = vault.notes[id];
  return (note && note.folderId && vault.folders[note.folderId]) ? note.folderId : null;
}

/**
 * The order of notes within a group, the same on every device: notes with an
 * order first (ascending), then the others by mtime, newest first, every tie
 * broken by id. A group never dragged keeps its plain newest-first order.
 * Complexity: O(1) per comparison.
 */
function compareNotes(a, b) {
  const noteA = vault.notes[a];
  const noteB = vault.notes[b];
  const orderedA = typeof noteA.order === "number";
  const orderedB = typeof noteB.order === "number";
  if (orderedA && orderedB) {
    return (noteA.order - noteB.order) || ((noteB.mtime || 0) - (noteA.mtime || 0)) || (a < b ? -1 : a > b ? 1 : 0);
  }
  if (orderedA !== orderedB) {
    return orderedA ? -1 : 1;
  }
  return ((noteB.mtime || 0) - (noteA.mtime || 0)) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The ids of a group's notes (null for loose), in display order. Complexity: O(n log n). */
function groupIds(folderId) {
  const out = [];
  for (const id in vault.notes) {
    if (groupOf(id) === folderId) {
      out.push(id);
    }
  }
  return out.sort(compareNotes);
}

/** The note or folder behind a sibling item { kind, id }. Complexity: O(1). */
function siblingRecord(item) {
  return item.kind === "note" ? vault.notes[item.id] : vault.folders[item.id];
}

/** A unique key for a sibling item: "note:<id>" or "folder:<id>". Complexity: O(1). */
function siblingKey(item) {
  return item.kind + ":" + item.id;
}

/**
 * The comparison for one level's notes and subfolders: ordered items first by
 * order. A level never dragged keeps its old look: inside a folder notes come
 * before subfolders, at the top level folders come before loose notes.
 * Complexity: O(1) per comparison.
 */
function compareSiblings(parentId) {
  // The top level keeps folders above loose notes.
  const notesFirstLegacy = !!parentId;
  return (a, b) => {
    const recordA = siblingRecord(a);
    const recordB = siblingRecord(b);
    const orderedA = typeof recordA.order === "number";
    const orderedB = typeof recordB.order === "number";
    if (orderedA !== orderedB) {
      return orderedA ? -1 : 1;
    }
    if (orderedA) {
      return (recordA.order - recordB.order) ||
        (a.kind !== b.kind ? (a.kind === "note" ? -1 : 1) : 0) || (a.id < b.id ? -1 : 1);
    }
    if (a.kind !== b.kind) {
      return (a.kind === "note") === notesFirstLegacy ? -1 : 1;
    }
    if (a.kind === "note") {
      return ((recordB.mtime || 0) - (recordA.mtime || 0)) || (a.id < b.id ? -1 : 1);
    }
    return compareByName(folderName(a.id), folderName(b.id)) || (a.id < b.id ? -1 : 1);
  };
}

/** The notes and subfolders of one level (null for the top), in display order. Complexity: O((n + f) log(n + f)). */
function siblingItems(parentId) {
  const out = [];
  for (const id in vault.notes) {
    if (groupOf(id) === (parentId || null)) {
      out.push({ kind: "note", id });
    }
  }
  for (const id in vault.folders) {
    if (parentOf(id) === (parentId || null)) {
      out.push({ kind: "folder", id });
    }
  }
  return out.sort(compareSiblings(parentId));
}

/**
 * Gives every item of a level without an order one, after the ordered ones
 * and in display order, stamping only those mtimes. It writes in memory only,
 * so it must run after any "nothing changes" check: a drop that changes
 * nothing must not leave unsaved stamps that light unsynced dots on the next
 * unrelated save. Complexity: O(s log s).
 */
function ensureSiblingOrders(parentId) {
  const items = siblingItems(parentId);
  const now = Date.now();
  let max = 0;
  for (const item of items) {
    const order = siblingRecord(item).order;
    if (typeof order === "number" && order > max) {
      max = order;
    }
  }
  for (const item of items) {
    const record = siblingRecord(item);
    if (typeof record.order !== "number") {
      max += ORDER_GAP;
      record.order = max;
      record.mtime = now;
    }
  }
}

/**
 * Re-spaces a level's order values when two neighbours have no whole number
 * left between them (practically never for one person's notes), keeping the
 * order. Complexity: O(s log s).
 */
function reseedSiblings(parentId) {
  const items = siblingItems(parentId);
  const now = Date.now();
  items.forEach((item, i) => {
    const record = siblingRecord(item);
    record.order = (i + 1) * ORDER_GAP;
    record.mtime = now;
  });
}

/**
 * The order value that puts the dragged item before or after an anchor in a
 * level: the midpoint of its new neighbours. null when that is exactly where
 * it already is, or the anchor is gone. Re-spaces the level and tries again
 * when there is no room. Complexity: O(s log s).
 */
function orderForSlot(parentId, drag, anchor, below) {
  const full = siblingItems(parentId);
  const others = full.filter(item => siblingKey(item) !== siblingKey(drag));
  const anchorIndex = others.findIndex(item => siblingKey(item) === siblingKey(anchor));
  if (anchorIndex < 0) {
    return null;
  }
  const at = below ? anchorIndex + 1 : anchorIndex;
  const left = at > 0 ? others[at - 1] : null;
  const right = at < others.length ? others[at] : null;

  // Within the same level: dropping it where it already is changes nothing.
  const currentIndex = full.findIndex(item => siblingKey(item) === siblingKey(drag));
  if (currentIndex >= 0) {
    const previous = currentIndex > 0 ? siblingKey(full[currentIndex - 1]) : null;
    const next = currentIndex < full.length - 1 ? siblingKey(full[currentIndex + 1]) : null;
    if ((left ? siblingKey(left) : null) === previous && (right ? siblingKey(right) : null) === next) {
      return null;
    }
  }

  ensureSiblingOrders(parentId);
  const orderOf = item => siblingRecord(item).order;
  if (left && right) {
    if (orderOf(right) - orderOf(left) <= 1) {
      reseedSiblings(parentId);
      return orderForSlot(parentId, drag, anchor, below);
    }
    return Math.floor((orderOf(left) + orderOf(right)) / 2);
  }
  if (right) {
    return orderOf(right) - ORDER_GAP;
  }
  if (left) {
    return orderOf(left) + ORDER_GAP;
  }
  return ORDER_GAP;
}

/** Enter or Space activates a row; the ContextMenu key or Shift+F10 opens its menu at its corner. Complexity: O(1). */
function makeRowKeyboardAccessible(el, activate, menuItems) {
  el.tabIndex = 0;
  el.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      openMenu(box.left + 12, box.bottom - 4, menuItems());
    }
  });
}

/** Shows the insertion line above or below a row (one row at a time). Complexity: O(1). */
function showDropIndicator(row, below) {
  clearDropIndicator();
  row.classList.add(below ? "drop-after" : "drop-before");
  lastDropRow = row;
}

/** Hides the insertion line. Complexity: O(1). */
function clearDropIndicator() {
  if (lastDropRow) {
    lastDropRow.classList.remove("drop-before", "drop-after");
    lastDropRow = null;
  }
}

/** Un-highlights every folder row marked as a drop target. Complexity: O(f). */
function clearFolderDropHighlight() {
  for (const el of $("notelist").querySelectorAll(".folder-row.drop-target")) {
    el.classList.remove("drop-target");
  }
}

/**
 * Shows the "drop here to leave the folder" bar while a note in a folder (or
 * a nested folder) is dragged: a full or overflowing list may have no free
 * space to aim at. Complexity: O(1).
 */
function showLooseDropBar(label = "Drop here to remove from folder") {
  if (looseDropBar) {
    return;
  }
  looseDropBar = makeElement("div", "loose-drop-bar", label);
  looseDropBar.addEventListener("dragover", event => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    looseDropBar.classList.add("over");
  });
  looseDropBar.addEventListener("dragleave", () => looseDropBar && looseDropBar.classList.remove("over"));
  looseDropBar.addEventListener("drop", event => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const noteId = draggingNoteId;
    const folderId = draggingFolderId;
    finishDrag();
    if (noteId) {
      dropIntoLoose(noteId);
    } else {
      nestFolder(folderId, null);
    }
  });
  $("notelist").appendChild(looseDropBar);
}

/** Removes the drop bar. Complexity: O(1). */
function hideLooseDropBar() {
  if (looseDropBar) {
    looseDropBar.remove();
    looseDropBar = null;
  }
}

/**
 * Opens a folded folder mid-drag without redrawing the list (a redraw
 * destroys the dragged row and ends the drag in most browsers): its notes
 * are inserted right after its row, with plain rails. The drop's own redraw
 * makes it right; finishDrag remembers the folder open. Complexity: O(g log g).
 */
function expandFolderInline(folderId, headerRow) {
  if (!collapsed.has(folderId) || !headerRow.isConnected) {
    return;
  }
  collapsed.delete(folderId);
  hoverExpanded = true;
  const arrow = headerRow.querySelector(".folder-arrow");
  if (arrow) {
    arrow.classList.add("open");
  }
  let anchor = headerRow;
  // Only the folder's own notes: subfolder rows are not drop targets here.
  const rails = noteRailColors(folderId);
  for (const id of groupIds(folderId)) {
    const row = noteRow(id, rails);
    anchor.after(row);
    anchor = row;
  }
}

/** Opens a folded folder after a dragged note has stayed over it for 600 ms. Complexity: O(1). */
function scheduleHoverExpand(folderId, row) {
  if (hoverExpandFid === folderId) {
    return;
  }
  cancelHoverExpand();
  hoverExpandFid = folderId;
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null;
    if (draggingNoteId && collapsed.has(folderId)) {
      expandFolderInline(folderId, row);
    }
  }, 600);
}

/** Cancels a pending mid-drag opening. Complexity: O(1). */
function cancelHoverExpand() {
  if (hoverExpandTimer) {
    clearTimeout(hoverExpandTimer);
    hoverExpandTimer = null;
  }
  hoverExpandFid = null;
}
