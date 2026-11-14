/*
 * notes.js - what you can do to notes, folders and the trash, the right-click
 * menus that offer it, and the sidebar's inline folder-name input.
 *
 * Every change stamps the item's mtime: the merge decides by mtime, so a
 * colour or folder change that left it alone would never reach the other
 * devices. Every change is then saved (persistSafe, one seal of the vault).
 * Moving a note to the trash asks nothing, since it can be undone and the
 * Trash section is right there; deleting for good always asks.
 *
 * Main functions: createFolder, setNoteFolder, setNoteColor, setFolderColor,
 * newFolderForNote, trashNote, restoreFromTrash, purgeFromTrash,
 * purgeTrashCore, deleteFolderFlow, noteMenu, folderMenu, trashMenu,
 * inlineFolderRow.
 * Auxiliary functions: addToFolderItems, moveFolderItems.
 *
 * Complexity: each change is O(1) plus one save, O(n) in the vault's size
 * (about 20 ms for 500 KB). Building a menu is O(f log f) in the folders it
 * lists, sorted by path.
 */
"use strict";

// ---------- Folders ----------

/**
 * Makes a folder (inside another one when parentId is given) and saves.
 * Returns its new id.
 *
 * Used by: this file (the new-folder input, "New folder..." in a note's menu,
 * "New subfolder..."), designs.js (the Designs folder).
 * Uses: persistSafe (vault.js).
 * Complexity: O(1) plus one save.
 */
function createFolder(name, parentId = null) {
  const id = crypto.randomUUID();
  vault.folders[id] = { name, color: null, parentId, mtime: Date.now() };
  persistSafe();
  return id;
}

/**
 * Gives a folder a colour, or none (null).
 *
 * Used by: folderMenu in this file (Color).
 * Uses: persistSafe (vault.js), renderList (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(1) plus one save and a redraw.
 */
function setFolderColor(folderId, color) {
  if (syncing || !vault.folders[folderId]) {
    return;
  }
  vault.folders[folderId].color = color;
  vault.folders[folderId].mtime = Date.now();
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Deletes a folder after asking whether its notes stay (they become loose
 * notes) or go to the trash with it. Its subfolders survive either way: they
 * move up to its parent. A tombstone makes the deletion survive a merge with
 * a repo that still has the folder (folder ids never collide with note or
 * attachment ids).
 *
 * Known limit: moving the subfolders up stamps their mtime, which can beat a
 * deletion of one of them made on another device and not synced yet, and
 * bring it back empty. That is the same "lose nothing" bias the note and
 * attachment merges take; fixing it needs three-way folder state.
 *
 * Used by: folderMenu in this file (Delete...).
 * Uses: noteIdsInFolder and parentOf (sidebar.js), showModal (modal.js),
 * trashNote, saveCollapsed (core.js), persistSafe (vault.js), renderList
 * (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(n + f) over notes and folders, plus one save.
 */
async function deleteFolderFlow(folderId) {
  const folder = vault.folders[folderId];
  if (syncing || !folder) {
    return;
  }

  const noteCount = noteIdsInFolder(folderId).length;
  const subfolderCount = Object.keys(vault.folders).filter(id => parentOf(id) === folderId).length;
  const choice = await showModal({
    title: `Delete folder "${folder.name || "(unnamed)"}"?`,
    body: (noteCount ? `${noteCount} note(s) are in this folder.` : "This folder has no notes of its own.") +
      (subfolderCount ? ` ${subfolderCount} subfolder(s) will move up a level.` : ""),
    choices: [
      { id: "keep", label: "Delete folder only (notes are kept)" },
      { id: "trash", label: "Delete folder and move its notes to trash", danger: true },
      { id: "cancel", label: "Cancel" },
    ],
    defaultId: "cancel",
  });
  if (syncing || !vault.folders[folderId] || (choice !== "keep" && choice !== "trash")) {
    return;
  }

  const ids = noteIdsInFolder(folderId);
  if (choice === "keep") {
    for (const id of ids) {
      vault.notes[id].folderId = null;
      vault.notes[id].mtime = Date.now();
    }
  } else {
    for (const id of ids) {
      trashNote(id, false);
    }
  }

  for (const id in vault.folders) {
    if (parentOf(id) === folderId) {
      vault.folders[id].parentId = parentOf(folderId);
      vault.folders[id].mtime = Date.now();
    }
  }
  delete vault.folders[folderId];
  vault.purged[folderId] = Date.now();
  if (collapsed.delete(folderId)) {
    saveCollapsed();
  }
  persistSafe();
  renderList();
  renderStatus();
}

// ---------- Notes ----------

/**
 * Moves a note into a folder (or out of any, with null) and opens that folder
 * and every folder around it, or the note would vanish from view.
 *
 * Used by: this file (the note menu's "Add to folder" and "Remove from
 * folder", and "New folder...").
 * Uses: revealFolder and renderList (sidebar.js), persistSafe (vault.js),
 * renderStatus (pagination.js).
 * Complexity: O(1) plus one save and a redraw.
 */
function setNoteFolder(id, folderId) {
  if (syncing || !vault.notes[id]) {
    return;
  }
  vault.notes[id].folderId = folderId;
  vault.notes[id].mtime = Date.now();
  if (folderId) {
    revealFolder(folderId);
  }
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Gives a note a colour, or none (null).
 *
 * Used by: noteMenu in this file (Color).
 * Uses: persistSafe (vault.js), renderList (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(1) plus one save and a redraw.
 */
function setNoteColor(id, color) {
  if (syncing || !vault.notes[id]) {
    return;
  }
  vault.notes[id].color = color;
  vault.notes[id].mtime = Date.now();
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Asks for a folder name and moves the note into the new folder. It uses a
 * dialog, not the sidebar's inline input: the sidebar may be scrolled away,
 * and the menu closes on scroll.
 *
 * Used by: addToFolderItems in this file ("New folder...").
 * Uses: promptModal (modal.js), createFolder, setNoteFolder.
 * Complexity: O(1) plus two saves.
 */
async function newFolderForNote(id) {
  const name = await promptModal({ title: "New folder", placeholder: "Folder name", confirmLabel: "Create" });
  if (!name || syncing || !vault.notes[id]) {
    return;
  }
  setNoteFolder(id, createFolder(name));
}

// ---------- The trash ----------

/**
 * Moves a note to the trash. If it is the open note, its last keystrokes are
 * saved first and the editor empties. A trashed note is not a pending
 * deletion (it is still in the vault, under Trash), so no title is kept for
 * the detail panel. With commit false the caller saves and redraws once for
 * many notes.
 *
 * Used by: noteMenu and deleteFolderFlow in this file.
 * Uses: flushSave and clearEditor (pagination.js), revokeAllMediaUrls and
 * persistSafe (vault.js), renderAttachments (attachments.js), renderList
 * (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(1) plus one save when it commits.
 */
function trashNote(id, commit = true) {
  const note = vault.notes[id];
  if (syncing || !note) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }

  vault.trash[id] = { data: vault.notes[id], deletedAt: Date.now() };
  delete vault.notes[id];

  if (id === currentId) {
    revokeAllMediaUrls();
    currentId = null;
    $("title").value = "";
    clearEditor();
    unsavedEdits = false;
    renderAttachments();
  }
  if (commit) {
    persistSafe();
    renderList();
    renderStatus();
  }
}

/**
 * Brings a note back from the trash and opens it. The open note's buffer is
 * saved first, while currentId still points at it (a Restore clicked in the
 * middle of the autosave pause once lost the last keystrokes). Its mtime is
 * stamped so it beats the deletion in a merge, a deleted folder is dropped,
 * and it comes back at the top of its group.
 *
 * Used by: trashMenu in this file, events.js (the Restore button on a trash item).
 * Uses: flushSave, openNote and status (pagination.js), topOrderOfGroup
 * (sidebar.js), saveSyncMeta (core.js), persistSafe (vault.js).
 * Complexity: O(g) in the notes of its group, plus one save.
 */
function restoreFromTrash(id) {
  const entry = vault.trash[id];
  if (syncing || !entry) {
    return;
  }
  flushSave();

  const note = entry.data || { title: "", body: "", color: null, folderId: null, media: [] };
  // Its mtime must beat deletedAt, or the merge's trash-against-live rule trashes it again.
  note.mtime = Date.now();
  if (note.folderId && !vault.folders[note.folderId]) {
    note.folderId = null;
  }
  if (!Array.isArray(note.media)) {
    note.media = [];
  }

  // An order kept from before it was trashed may no longer fit the group it
  // returns to: it comes back at the top of that group (or without an order,
  // sorted by mtime, if the group has none yet).
  {
    const order = topOrderOfGroup((note.folderId && vault.folders[note.folderId]) ? note.folderId : null);
    if (order !== undefined) {
      note.order = order;
    } else {
      delete note.order;
    }
  }

  vault.notes[id] = note;
  delete vault.trash[id];
  if (id in syncMeta.trashSeen) {
    delete syncMeta.trashSeen[id];
    saveSyncMeta();
  }
  delete deletedTitles[id];
  trashViewId = null;
  persistSafe();
  openNote(id);
  status("Restored from trash");
}

/**
 * Deletes a trashed note for good, after asking. "Delete all" uses
 * purgeTrashCore directly, after one question for everything.
 *
 * Used by: trashMenu in this file, events.js (the Delete permanently button
 * on a trash item).
 * Uses: confirmModal (modal.js), purgeTrashCore, persistSafe (vault.js),
 * renderList (sidebar.js), renderStatus (pagination.js).
 * Complexity: that of purgeTrashCore, plus one save.
 */
async function purgeFromTrash(id) {
  const entry = vault.trash[id];
  if (syncing || backupView || !entry) {
    return;
  }
  const title = (entry.data && entry.data.title) || "(untitled)";
  const ok = await confirmModal({
    title: "Delete permanently?",
    body: `"${title}" and its attachments will be removed from this device and, on the next sync, from the repo. This cannot be undone.`,
    confirmLabel: "Delete permanently",
    destructive: true,
  });
  if (!ok || syncing || backupView || !vault.trash[id]) {
    return;
  }
  purgeTrashCore(id);
  persistSafe();
  renderList();
  renderStatus();
}

/**
 * Deletes one trashed note for good, without asking: leaves a tombstone, and
 * deletes its attachments' bytes when nothing else refers to them (conflict
 * copies share attachments with their originals). Its undo history goes too:
 * a note deleted for good must not live on as plain-text snapshots. The
 * caller saves.
 *
 * Used by: purgeFromTrash in this file, sidebar.js (Delete all).
 * Uses: mediaReferenced, revokeMediaUrl, idbDelete and revokeAllMediaUrls
 * (vault.js), removeMediaFile (vaults.js), saveSyncMeta (core.js),
 * clearEditor, applyReadonly (pagination.js), renderAttachments (attachments.js).
 * Complexity: O(a * n * b): each of its attachments is checked with mediaReferenced.
 */
function purgeTrashCore(id) {
  const entry = vault.trash[id];
  if (!entry) {
    return;
  }
  histories.delete(id);

  const title = (entry.data && entry.data.title) || "(untitled)";
  const mediaIds = ((entry.data && entry.data.media) || []).map(media => media.id);
  delete vault.trash[id];
  vault.purged[id] = Date.now();
  // Now it is a real pending deletion: remember the title for the detail panel.
  if (id in syncMeta.noteMtimes) {
    deletedTitles[id] = title;
  }

  for (const mediaId of mediaIds) {
    if (!mediaReferenced(mediaId)) {
      vault.purged[mediaId] = Date.now();
      revokeMediaUrl(mediaId);
      idbDelete(mediaId).catch(() => {});
      removeMediaFile(mediaId);
    }
  }

  if (id in syncMeta.trashSeen) {
    delete syncMeta.trashSeen[id];
    saveSyncMeta();
  }

  if (trashViewId === id) {
    // The URLs this view still holds belong to a note that no longer exists.
    revokeAllMediaUrls();
    trashViewId = null;
    $("title").value = "";
    clearEditor();
    applyReadonly();
    renderAttachments();
  }
}

// ---------- Menus ----------

/**
 * The right-click menu of a note: pin, folder, colour, pages, presets and
 * designs, duplicate, reset layout, export (PDF, a folder with the PDF and
 * its files, or the browser's print dialog), sync this note, and move to
 * trash. Presets and designs act on the open note, so choosing one opens
 * this note first.
 *
 * Used by: sidebar.js (a note's row).
 * Uses: isPinned and togglePin (vault.js), addToFolderItems, setNoteFolder,
 * setNoteColor, notePages, makePagedAndShow, addPage and duplicateNote
 * (content.js), presetItems and designItems (designs.js), resetNoteLayout
 * (history.js), exportNoteInternal and exportNotePdf (pdf.js), flushSave,
 * openNote and status (pagination.js), window.syncNote (media-sync.js), trashNote.
 * Complexity: O(1) to build; the submenus are built when they open.
 */
function noteMenu(id) {
  const note = vault.notes[id] || {};

  // Pin first: it is the item people reach for without thinking, and it reads as on or off.
  const items = [{ label: isPinned(id) ? "Unpin" : "Pin to top", disabled: syncing, onClick: () => togglePin(id) }];
  items.push({ label: "Add to folder", disabled: syncing, submenu: () => addToFolderItems(id) });
  // Only when the folder exists: a note pointing at a deleted folder already
  // shows as loose, so the item would do nothing.
  if (note.folderId && vault.folders[note.folderId]) {
    items.push({ label: "Remove from folder", disabled: syncing, onClick: () => setNoteFolder(id, null) });
  }
  items.push({
    label: "Color",
    disabled: syncing,
    submenu: () => [{ swatches: color => setNoteColor(id, color), current: note.color }],
  });
  items.push({ sep: true });

  items.push({
    label: "Pages",
    disabled: syncing,
    submenu: () => {
      const current = vault.notes[id] || {};
      const pages = notePages(current);
      const out = [];
      if (!pages) {
        out.push({
          label: "Use page layout",
          disabled: syncing,
          onClick: () => {
            makePagedAndShow(id);
            status("Page layout on - this is exactly how it exports to PDF");
          },
        });
      } else {
        out.push({ label: `${pages.length} page(s)`, disabled: true });
      }
      out.push({
        label: "Add a page",
        disabled: syncing,
        onClick: () => {
          makePagedAndShow(id);
          addPage(notePages(vault.notes[id]).length);
        },
      });
      return out;
    },
  });

  items.push({
    label: "Presets",
    disabled: syncing,
    submenu: () => {
      if (currentId !== id) {
        openNote(id);
      }
      return presetItems();
    },
  });
  items.push({
    label: "Design presets",
    disabled: syncing,
    submenu: () => {
      if (currentId !== id) {
        openNote(id);
      }
      return designItems();
    },
  });
  items.push({ label: "Duplicate", disabled: syncing, onClick: () => duplicateNote(id) });
  items.push({ label: "Reset layout...", disabled: syncing, onClick: () => resetNoteLayout(id) });
  items.push({
    label: "Export",
    disabled: syncing,
    submenu: () => [
      { label: "PDF file", onClick: () => exportNoteInternal(id, "pdf") },
      { label: "Folder with the PDF and its files...", onClick: () => exportNoteInternal(id, "folder") },
      { sep: true },
      // An honest label: the browser writes this file and stamps its own
      // Producer and CreationDate into it, which the page cannot remove. The
      // path without that metadata is "PDF file".
      { label: "Print (browser dialog) - adds browser metadata", onClick: () => exportNotePdf(id) },
    ],
  });
  items.push({ sep: true });
  items.push({
    label: "Sync this note",
    disabled: syncing,
    onClick: () => {
      flushSave();
      window.syncNote(id);
    },
  });
  items.push({ sep: true });
  items.push({ label: "Move to trash", danger: true, disabled: syncing, onClick: () => trashNote(id) });
  return items;
}

/**
 * The right-click menu of a folder: new note, new subfolder (unless that
 * would nest too deep), rename, move, colour, sync this folder, delete.
 *
 * Used by: sidebar.js (a folder's row).
 * Uses: newNote (events.js), folderDepth, MAX_NEST, revealFolder and
 * renderList (sidebar.js), promptModal (modal.js), createFolder, clearSearch
 * (events.js), moveFolderItems, setFolderColor, flushSave and renderStatus
 * (pagination.js), window.syncFolder (media-sync.js), deleteFolderFlow.
 * Complexity: O(f log f) for the "Move to" check, which lists the valid targets.
 */
function folderMenu(folderId) {
  return [
    { label: "New note", disabled: syncing, onClick: () => newNote(folderId) },
    {
      label: "New subfolder...",
      disabled: syncing || folderDepth(folderId) + 1 >= MAX_NEST,
      onClick: async () => {
        const name = await promptModal({ title: "New subfolder", placeholder: "Folder name", confirmLabel: "Create" });
        if (!name || syncing || !vault.folders[folderId]) {
          return;
        }
        createFolder(name, folderId);
        // Never create it hidden: an active search or a folded parent would
        // both hide the new, empty folder.
        clearSearch();
        revealFolder(folderId);
        renderList();
        renderStatus();
      },
    },
    { sep: true },
    {
      label: "Rename",
      disabled: syncing,
      onClick: () => {
        inlineEdit = { kind: "rename", folderId };
        renderList();
      },
    },
    ...(moveFolderItems(folderId).length
      ? [{ label: "Move to", disabled: syncing, submenu: () => moveFolderItems(folderId) }]
      : []),
    {
      label: "Color",
      disabled: syncing,
      submenu: () => [{
        swatches: color => setFolderColor(folderId, color),
        current: vault.folders[folderId] && vault.folders[folderId].color,
      }],
    },
    { sep: true },
    {
      label: "Sync folder",
      disabled: syncing,
      onClick: () => {
        flushSave();
        window.syncFolder(folderId);
      },
    },
    { sep: true },
    { label: "Delete...", danger: true, disabled: syncing, onClick: () => deleteFolderFlow(folderId) },
  ];
}

/**
 * The right-click menu of a trashed note: restore, or delete for good.
 *
 * Used by: sidebar.js (a trash row).
 * Uses: restoreFromTrash, purgeFromTrash.
 * Complexity: O(1).
 */
function trashMenu(id) {
  return [
    { label: "Restore", disabled: syncing, onClick: () => restoreFromTrash(id) },
    { label: "Delete permanently", danger: true, disabled: syncing, onClick: () => purgeFromTrash(id) },
  ];
}

// ---------- The inline folder-name input ----------

/**
 * The input row the sidebar shows for a new folder (folderId null) or a
 * rename. Enter or leaving the field keeps a non-empty name; Escape or an
 * empty name cancels. Duplicate names are fine: folders are kept by id.
 *
 * Used by: sidebar.js (while inlineEdit is set).
 * Uses: makeElement (sidebar.js), createFolder, persistSafe (vault.js),
 * renderList (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(1).
 */
function inlineFolderRow(folderId, depth = 0) {
  const wrap = makeElement("div", "inline-folder");
  if (depth) {
    wrap.style.paddingLeft = (9 + 12 * depth) + "px";
  }
  const input = makeElement("input");
  input.type = "text";
  input.placeholder = folderId ? "Folder name" : "New folder";
  input.value = folderId && vault.folders[folderId] ? vault.folders[folderId].name || "" : "";

  let done = false;
  const finish = commit => {
    if (done) {
      return;
    }
    done = true;
    const value = input.value.trim();
    inlineEdit = null;
    if (commit && value && !syncing) {
      if (folderId) {
        if (vault.folders[folderId]) {
          vault.folders[folderId].name = value;
          vault.folders[folderId].mtime = Date.now();
          persistSafe();
        }
      } else {
        createFolder(value);
      }
    }
    if (!renderingList) {
      renderList();
      renderStatus();
    }
  };

  input.onkeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
  wrap.appendChild(input);
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return wrap;
}

// =================== Auxiliary functions ===================

/**
 * The "Add to folder" submenu: every folder by its full path, the note's own
 * folder ticked, then "New folder...". Complexity: O(f log f) in the folders.
 */
function addToFolderItems(id) {
  const current = vault.notes[id] ? vault.notes[id].folderId : null;
  const items = Object.keys(vault.folders)
    .sort((a, b) => compareByName(folderPath(a), folderPath(b)))
    .map(folderId => ({
      label: folderPath(folderId),
      dotColor: vault.folders[folderId].color,
      checked: folderId === current,
      disabled: syncing,
      onClick: () => setNoteFolder(id, folderId),
    }));
  if (items.length) {
    items.push({ sep: true });
  }
  items.push({ label: "New folder...", dotColor: null, disabled: syncing, onClick: () => newFolderForNote(id) });
  return items;
}

/**
 * The "Move to" submenu of a folder: only the places it may go, so every item
 * works. Not itself, not inside itself, not where it already is, and never
 * past the depth limit: the same rules nestFolder enforces.
 * Complexity: O(f log f) in the folders.
 */
function moveFolderItems(folderId) {
  const items = Object.keys(vault.folders)
    .filter(target => target !== folderId && target !== parentOf(folderId) && !isDescendantOf(target, folderId) &&
      folderDepth(target) + 1 + subtreeHeight(folderId) < MAX_NEST)
    .sort((a, b) => compareByName(folderPath(a), folderPath(b)))
    .map(target => ({
      label: folderPath(target),
      dotColor: vault.folders[target].color,
      disabled: syncing,
      onClick: () => nestFolder(folderId, target),
    }));
  if (parentOf(folderId)) {
    if (items.length) {
      items.push({ sep: true });
    }
    items.push({ label: "Move to top level", disabled: syncing, onClick: () => nestFolder(folderId, null) });
  }
  return items;
}
