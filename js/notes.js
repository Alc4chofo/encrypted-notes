// notes: Note, folder and trash operations, their menus, and the inline folder input.
"use strict";

// ---------- Folder / note / trash operations ----------
function createFolder(name, parentId = null) {
  const id = crypto.randomUUID();
  vault.folders[id] = { name, color: null, parentId, mtime: Date.now() };
  persistSafe();
  return id;
}

// Every mutation bumps mtime: the merge sync decides by mtime, so a colour or
// folder change that leaves mtime alone would never reach the other devices.
function setNoteFolder(id, fid) {
  if (syncing || !vault.notes[id]) return;
  vault.notes[id].folderId = fid;
  vault.notes[id].mtime = Date.now();
  if (fid) revealFolder(fid);   // incl. collapsed ancestors, or the note vanishes
  persistSafe();
  renderList();
  renderStatus();
}

function setNoteColor(id, color) {
  if (syncing || !vault.notes[id]) return;
  vault.notes[id].color = color;
  vault.notes[id].mtime = Date.now();
  persistSafe();
  renderList();
  renderStatus();
}

function setFolderColor(fid, color) {
  if (syncing || !vault.folders[fid]) return;
  vault.folders[fid].color = color;
  vault.folders[fid].mtime = Date.now();
  persistSafe();
  renderList();
  renderStatus();
}

async function newFolderForNote(id) {
  // The sidebar may be scrolled away and the menu closes on scroll, so this
  // path uses the modal instead of the inline row.
  const name = await promptModal({ title: "New folder", placeholder: "Folder name", confirmLabel: "Create" });
  if (!name || syncing || !vault.notes[id]) return;
  setNoteFolder(id, createFolder(name));
}

// No confirm: this is reversible and the Trash section is right there.
function trashNote(id, commit = true) {
  const n = vault.notes[id];
  if (syncing || !n) return;
  if (id === currentId) flushSave();
  // No deletedTitles entry: a trashed note is not a pending DELETION under the
  // v2 predicates (it is still in the vault, listed under Trash).
  vault.trash[id] = { data: vault.notes[id], deletedAt: Date.now() };
  delete vault.notes[id];
  if (id === currentId) {
    revokeAllMediaUrls();
    currentId = null;
    $("title").value = "";
    clearEditor();
    dirty = false;
    renderAttachments();
  }
  if (commit) { persistSafe(); renderList(); renderStatus(); }
}

function restoreFromTrash(id) {
  const t = vault.trash[id];
  if (syncing || !t) return;
  // Commit the open note's buffer first, while currentId still points at it:
  // this is the only note-switch path that skipped the flush, and a Restore
  // clicked mid-debounce silently discarded the last keystrokes.
  flushSave();
  const n = t.data || { title: "", body: "", color: null, folderId: null, media: [] };
  // mtime must beat deletedAt or the trash-vs-live merge rule re-trashes it.
  n.mtime = Date.now();
  if (n.folderId && !vault.folders[n.folderId]) n.folderId = null;
  if (!Array.isArray(n.media)) n.media = [];
  // A stale order carried from before it was trashed may no longer fit the current
  // group: resurface the note at the TOP of its destination group (or drop order to
  // fall back to mtime-desc if that group is still legacy).
  { const o = topOrderOfGroup((n.folderId && vault.folders[n.folderId]) ? n.folderId : null);
    if (o !== undefined) n.order = o; else delete n.order; }
  vault.notes[id] = n;
  delete vault.trash[id];
  if (id in syncMeta.trashSeen) { delete syncMeta.trashSeen[id]; saveSyncMeta(); }
  delete deletedTitles[id];
  trashViewId = null;
  persistSafe();
  openNote(id);
  status("Restored from trash");
}

// The unconfirmed purge core, shared by the per-note flow and Delete all.
function purgeTrashCore(id) {
  const t = vault.trash[id];
  if (!t) return;
  // A permanently deleted note must not live on as plaintext undo snapshots.
  histories.delete(id);
  const title = (t.data && t.data.title) || "(untitled)";
  const mids = ((t.data && t.data.media) || []).map(m => m.id);
  delete vault.trash[id];
  vault.purged[id] = Date.now();
  // Now a real pending deletion: remember the title for the detail panel.
  if (id in syncMeta.noteMtimes) deletedTitles[id] = title;
  // Tombstone media only once nothing else references it (conflict copies share
  // media ids with their originals).
  for (const mid of mids) if (!mediaReferenced(mid)) {
    vault.purged[mid] = Date.now();
    revokeMediaUrl(mid);
    idbDelete(mid).catch(() => {});
  }
  if (id in syncMeta.trashSeen) { delete syncMeta.trashSeen[id]; saveSyncMeta(); }
  if (trashViewId === id) {
    revokeAllMediaUrls();   // this view's remaining URLs belong to a note that no longer exists
    trashViewId = null;
    $("title").value = "";
    clearEditor();
    applyReadonly();
    renderAttachments();
  }
}

async function purgeFromTrash(id) {
  const t = vault.trash[id];
  if (syncing || backupView || !t) return;
  const title = (t.data && t.data.title) || "(untitled)";
  const ok = await confirmModal({
    title: "Delete permanently?",
    body: `"${title}" and its attachments will be removed from this device and, on the next sync, from the repo. This cannot be undone.`,
    confirmLabel: "Delete permanently", destructive: true,
  });
  if (!ok || syncing || backupView || !vault.trash[id]) return;
  purgeTrashCore(id);
  persistSafe();
  renderList();
  renderStatus();
}

async function deleteFolderFlow(fid) {
  const f = vault.folders[fid];
  if (syncing || !f) return;
  const n = noteIdsInFolder(fid).length;
  const subs = Object.keys(vault.folders).filter(id => parentOf(id) === fid).length;
  const choice = await showModal({
    title: `Delete folder "${f.name || "(unnamed)"}"?`,
    body: (n ? `${n} note(s) are in this folder.` : "This folder has no notes of its own.") +
      (subs ? ` ${subs} subfolder(s) will move up a level.` : ""),
    choices: [
      { id: "keep", label: "Delete folder only (notes are kept)" },
      { id: "trash", label: "Delete folder and move its notes to trash", danger: true },
      { id: "cancel", label: "Cancel" },
    ],
    defaultId: "cancel",
  });
  if (syncing || !vault.folders[fid] || (choice !== "keep" && choice !== "trash")) return;
  const ids = noteIdsInFolder(fid);
  if (choice === "keep") for (const id of ids) {
    vault.notes[id].folderId = null;
    vault.notes[id].mtime = Date.now();
  } else for (const id of ids) trashNote(id, false);
  // Child folders survive either choice: they move up to this folder's parent.
  // ponytail: the mtime bump can beat another device's tombstone for a child
  // deleted there but not yet synced, resurrecting it empty - same no-data-loss
  // bias the note/media merges take; fixing it needs three-way folder state.
  for (const id in vault.folders) if (parentOf(id) === fid) {
    vault.folders[id].parentId = parentOf(fid);
    vault.folders[id].mtime = Date.now();
  }
  delete vault.folders[fid];
  // Tombstone so the deletion survives a merge against a remote that still has
  // the folder (folder ids never collide with note or media ids).
  vault.purged[fid] = Date.now();
  if (collapsed.delete(fid)) saveCollapsed();
  persistSafe();
  renderList();
  renderStatus();
}

// ---------- Menu definitions ----------
function addToFolderItems(id) {
  const cur = vault.notes[id] ? vault.notes[id].folderId : null;
  const items = Object.keys(vault.folders)
    .sort((a, b) => byName(folderPath(a), folderPath(b)))
    .map(fid => ({ label: folderPath(fid), dotColor: vault.folders[fid].color, checked: fid === cur,
      disabled: syncing, onClick: () => setNoteFolder(id, fid) }));
  if (items.length) items.push({ sep: true });
  items.push({ label: "New folder...", dotColor: null, disabled: syncing, onClick: () => newFolderForNote(id) });
  return items;
}

function noteMenu(id) {
  const n = vault.notes[id] || {};
  // Pin first: it is the one item people reach for without thinking, and it reads as on/off.
  const items = [{ label: isPinned(id) ? "Unpin" : "Pin to top", disabled: syncing, onClick: () => togglePin(id) }];
  items.push({ label: "Add to folder", disabled: syncing, submenu: () => addToFolderItems(id) });
  // Gate on the folder existing: a note pointing at a deleted folder already
  // renders as loose, so the item would have been a no-op.
  if (n.folderId && vault.folders[n.folderId])
    items.push({ label: "Remove from folder", disabled: syncing, onClick: () => setNoteFolder(id, null) });
  items.push({ label: "Color", disabled: syncing, submenu: () => [{ swatches: c => setNoteColor(id, c), current: n.color }] });
  items.push({ sep: true });
  items.push({ label: "Pages", disabled: syncing, submenu: () => {
    const note = vault.notes[id] || {};
    const ps = notePages(note);
    const out = [];
    if (!ps) out.push({ label: "Use page layout", disabled: syncing, onClick: () => {
      makePagedAndShow(id);
      status("Page layout on - this is exactly how it exports to PDF");
    } });
    else out.push({ label: `${ps.length} page(s)`, disabled: true });
    out.push({ label: "Add a page", disabled: syncing, onClick: () => {
      makePagedAndShow(id);
      addPage(notePages(vault.notes[id]).length);
    } });
    return out;
  } });
  items.push({ label: "Presets", disabled: syncing, submenu: () => {
    if (currentId !== id) openNote(id);   // presets apply to the OPEN note
    return presetItems();
  } });
  items.push({ label: "Design presets", disabled: syncing, submenu: () => {
    if (currentId !== id) openNote(id);
    return designItems();
  } });
  items.push({ label: "Duplicate", disabled: syncing, onClick: () => duplicateNote(id) });
  items.push({ label: "Reset layout...", disabled: syncing, onClick: () => resetNoteLayout(id) });
  items.push({ label: "Export", disabled: syncing, submenu: () => [
    { label: "PDF file", onClick: () => exportNoteInternal(id, "pdf") },
    { label: "Folder with the PDF and its files...", onClick: () => exportNoteInternal(id, "folder") },
    { sep: true },
    // Honest label: the BROWSER writes this file and stamps its own
    // Producer/CreationDate into it, which the page cannot remove. The
    // metadata-free path is "PDF file".
    { label: "Print (browser dialog) - adds browser metadata", onClick: () => exportNotePdf(id) },
  ] });
  items.push({ sep: true });
  items.push({ label: "Sync this note", disabled: syncing, onClick: () => { flushSave(); window.syncNote(id); } });
  items.push({ sep: true });
  items.push({ label: "Move to trash", danger: true, disabled: syncing, onClick: () => trashNote(id) });
  return items;
}

// Valid nesting targets for the "Move to" submenu: not itself, not its own
// subtree, not where it already is, and never past the depth cap - the same
// rules nestFolder enforces, filtered up front so every visible item works.
function moveFolderItems(fid) {
  const items = Object.keys(vault.folders)
    .filter(t => t !== fid && t !== parentOf(fid) && !isDescendantOf(t, fid) &&
      folderDepth(t) + 1 + subtreeHeight(fid) < MAX_NEST)
    .sort((a, b) => byName(folderPath(a), folderPath(b)))
    .map(t => ({ label: folderPath(t), dotColor: vault.folders[t].color,
      disabled: syncing, onClick: () => nestFolder(fid, t) }));
  if (parentOf(fid)) {
    if (items.length) items.push({ sep: true });
    items.push({ label: "Move to top level", disabled: syncing, onClick: () => nestFolder(fid, null) });
  }
  return items;
}

function folderMenu(fid) {
  return [
    { label: "New note", disabled: syncing, onClick: () => newNote(fid) },
    { label: "New subfolder...", disabled: syncing || folderDepth(fid) + 1 >= MAX_NEST, onClick: async () => {
      const name = await promptModal({ title: "New subfolder", placeholder: "Folder name", confirmLabel: "Create" });
      if (!name || syncing || !vault.folders[fid]) return;
      createFolder(name, fid);
      // Don't create it hidden: an active filter or a collapsed ancestor would
      // both make the new (empty, non-matching) folder invisible.
      clearSearch();
      revealFolder(fid);
      renderList();
      renderStatus();
    } },
    { sep: true },
    { label: "Rename", disabled: syncing, onClick: () => { inlineEdit = { kind: "rename", folderId: fid }; renderList(); } },
    ...(moveFolderItems(fid).length ? [{ label: "Move to", disabled: syncing, submenu: () => moveFolderItems(fid) }] : []),
    { label: "Color", disabled: syncing,
      submenu: () => [{ swatches: c => setFolderColor(fid, c), current: vault.folders[fid] && vault.folders[fid].color }] },
    { sep: true },
    { label: "Sync folder", disabled: syncing, onClick: () => { flushSave(); window.syncFolder(fid); } },
    { sep: true },
    { label: "Delete...", danger: true, disabled: syncing, onClick: () => deleteFolderFlow(fid) },
  ];
}

function trashMenu(id) {
  return [
    { label: "Restore", disabled: syncing, onClick: () => restoreFromTrash(id) },
    { label: "Delete permanently", danger: true, disabled: syncing, onClick: () => purgeFromTrash(id) },
  ];
}

// ---------- Inline folder input (rename / new folder) ----------
function inlineFolderRow(fid, depth = 0) {
  const wrap = mk("div", "inline-folder");
  if (depth) wrap.style.paddingLeft = (9 + 12 * depth) + "px";
  const inp = mk("input");
  inp.type = "text";
  inp.placeholder = fid ? "Folder name" : "New folder";
  inp.value = fid && vault.folders[fid] ? vault.folders[fid].name || "" : "";
  let done = false;
  // Blur commits a non-empty name, cancels otherwise; empty Enter cancels too.
  const finish = commit => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    inlineEdit = null;
    if (commit && v && !syncing) {
      if (fid) {
        if (vault.folders[fid]) {
          vault.folders[fid].name = v;      // duplicate names are fine, ids are the keys
          vault.folders[fid].mtime = Date.now();
          persistSafe();
        }
      } else createFolder(v);
    }
    if (!renderingList) { renderList(); renderStatus(); }
  };
  inp.onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  inp.onblur = () => finish(true);
  wrap.appendChild(inp);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  return wrap;
}
