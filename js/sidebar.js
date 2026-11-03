// notes: Small UI helpers, the folder tree and dragging notes and folders in the sidebar.
"use strict";

// ---------- UI ----------
function mk(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function relTime(t) {
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return Math.floor(d / 60e3) + "m ago";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h ago";
  const dt = new Date(t), y = new Date();
  y.setDate(y.getDate() - 1);
  if (dt.toDateString() === y.toDateString()) return "yesterday";
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
const folderName = fid => (vault.folders[fid] && vault.folders[fid].name) || "(unnamed)";
const noteIdsInFolder = fid => Object.keys(vault.notes).filter(id => vault.notes[id].folderId === fid);

// ---------- Folder nesting ----------
// folder.parentId (null/absent = top level) rides the whole-folder LWW merge, so
// nesting syncs with no merge changes. Every walk below is cycle-safe: two
// devices can independently nest A->B and B->A and the merge will happily stitch
// the loop, so a plain parent walk could spin forever.
const MAX_NEST = 5;   // folder depth 0..4: rails + indent always fit the 230px sidebar
const parentOf = fid => {
  const f = vault.folders[fid], p = f && f.parentId;
  return (p && p !== fid && vault.folders[p]) ? p : null;
};
// Ancestor chain, nearest first; stops at a repeat so a merged cycle just truncates.
function folderChain(fid) {
  const out = [], seen = new Set([fid]);
  for (let p = parentOf(fid); p && !seen.has(p); p = parentOf(p)) { out.push(p); seen.add(p); }
  return out;
}
const folderDepth = fid => folderChain(fid).length;
const isDescendantOf = (fid, ancestor) => folderChain(fid).includes(ancestor);
// Height of a folder's subtree in folder levels (0 = no child folders).
function subtreeHeight(fid, guard = 0) {
  if (guard > MAX_NEST + 2) return 0;   // ponytail: merged cycles bottom out here, not in a stack overflow
  let h = 0;
  for (const id in vault.folders) if (parentOf(id) === fid) h = Math.max(h, 1 + subtreeHeight(id, guard + 1));
  return h;
}
// "Root / Sub / Leaf" label for menus.
const folderPath = fid => [...folderChain(fid)].reverse().concat(fid).map(folderName).join(" / ");
// Rail colors for notes directly inside fid: root-most colors first, clamped with
// the EXACT formula of the render walk (root-most MAX_NEST wins, own color dropped
// beyond the cap) so hover-expanded rows match the settled render.
const noteRailColors = fid => {
  const path = [...folderChain(fid)].reverse().concat(fid);
  return (path.length > MAX_NEST ? path.slice(0, MAX_NEST) : path)
    .map(f => (vault.folders[f] && vault.folders[f].color) || null);
};
// Reveal a folder in the sidebar: uncollapse it AND every ancestor - a collapsed
// ancestor hides the whole subtree, so uncollapsing only the target still leaves
// the moved/created item invisible.
function revealFolder(fid) {
  let changed = collapsed.delete(fid);
  for (const p of folderChain(fid)) changed = collapsed.delete(p) || changed;
  if (changed) saveCollapsed();
}

// Paint a row's indent rails: one gradient stripe per level at x = 10 + 12*level,
// dimmed via alpha at rest so bright folder colors don't shout. --rails-hi (used
// on hover/active) lights the innermost stripe at full strength. capTop/capBottom
// inset a stripe 4px so each folder's block reads as a discrete unit.
function applyRails(el, rails) {
  if (!rails.length) return;
  const layer = (r, k, hi) => {
    const c = r.color || "#8a8a8a";
    const col = hi ? c : `color-mix(in srgb, ${c} 45%, transparent)`;
    const top = r.capTop ? 4 : 0, cut = top + (r.capBottom ? 4 : 0);
    return `linear-gradient(${col}, ${col}) ${10 + 12 * k}px ${top}px / 2px calc(100% - ${cut}px) no-repeat`;
  };
  el.style.setProperty("--rails", rails.map((r, k) => layer(r, k, false)).join(", "));
  el.style.setProperty("--rails-hi", rails.map((r, k) => layer(r, k, k === rails.length - 1)).join(", "));
}

// ---------- Sidebar drag & drop: note reorder + move between folders ----------
// note.order is a spaced integer (ORDER_GAP apart) so a reorder slots a note at the
// midpoint of two neighbours without touching anyone else - exactly one mtime bump per
// drag after the one-time group seed. A note with NO order sorts by mtime desc (today's
// behaviour), so a never-dragged vault renders identically and legacy notes hash
// byte-identically across versions. order rides in noteKey only when numeric, so a
// reorder syncs; the merge's order-only branch keeps two devices' reorders from forking.
const ORDER_GAP = 1 << 16;
let draggingNoteId = null;   // set on dragstart; drives indicator/target logic (dataTransfer is unreadable during dragover)
let draggingFolderId = null; // folder drag: drop on a folder header nests, background/bar un-nests
let justDragged = false;     // swallows the synthetic click a completed drag leaves on the row
let lastDropRow = null;      // the row currently showing an insertion line (exactly one at a time)
let hoverExpandTimer = null, hoverExpandFid = null;   // dwell-to-expand a collapsed folder mid-drag
let hoverExpanded = false;   // an inline expand ran: finishDrag owes a full re-render

// A note's group: its folder id, or null when loose (incl. a note whose folder was
// deleted, which renders loose - matches renderListInner's bucketing).
const groupOf = id => {
  const n = vault.notes[id];
  return (n && n.folderId && vault.folders[n.folderId]) ? n.folderId : null;
};
// Deterministic on both devices: ordered notes first (order asc), then legacy notes by
// mtime desc; every tie broken by id so both devices render the identical sequence. A
// fully-legacy group keeps today's exact mtime-desc order. The mixed (ha!==hb) case is
// transient - the first drag seeds the whole group - and keeps ordered-above-unordered.
function cmpNotes(a, b) {
  const A = vault.notes[a], B = vault.notes[b];
  const ha = typeof A.order === "number", hb = typeof B.order === "number";
  if (ha && hb) return (A.order - B.order) || ((B.mtime || 0) - (A.mtime || 0)) || (a < b ? -1 : a > b ? 1 : 0);
  if (ha !== hb) return ha ? -1 : 1;
  return ((B.mtime || 0) - (A.mtime || 0)) || (a < b ? -1 : a > b ? 1 : 0);
}
// Ordered ids of a group (fid=null for loose), by the live comparator.
function groupIds(fid) {
  const out = [];
  for (const id in vault.notes) if (groupOf(id) === fid) out.push(id);
  return out.sort(cmpNotes);
}
// ---- Unified sibling order: the notes AND subfolders of one parent share one
// order space, so a note can sit BETWEEN two subfolders (it is still simply a
// note of the parent, just positioned there). Legacy (never-dragged) levels keep
// the pre-interleave look - notes above subfolders inside a folder, folders
// above loose notes at root - and nothing is written until a drag touches the
// level. An item is {kind:"note"|"folder", id}. ----
const sibRec = it => it.kind === "note" ? vault.notes[it.id] : vault.folders[it.id];
const sibKey = it => it.kind + ":" + it.id;
function cmpSiblings(parentId) {
  const notesFirstLegacy = !!parentId;   // root keeps folders above loose notes
  return (a, b) => {
    const A = sibRec(a), B = sibRec(b);
    const ha = typeof A.order === "number", hb = typeof B.order === "number";
    if (ha !== hb) return ha ? -1 : 1;
    if (ha) return (A.order - B.order) ||
      (a.kind !== b.kind ? (a.kind === "note" ? -1 : 1) : 0) || (a.id < b.id ? -1 : 1);
    if (a.kind !== b.kind) return (a.kind === "note") === notesFirstLegacy ? -1 : 1;
    if (a.kind === "note") return ((B.mtime || 0) - (A.mtime || 0)) || (a.id < b.id ? -1 : 1);
    return byName(folderName(a.id), folderName(b.id)) || (a.id < b.id ? -1 : 1);
  };
}
function siblingItems(parentId) {
  const out = [];
  for (const id in vault.notes) if (groupOf(id) === (parentId || null)) out.push({ kind: "note", id });
  for (const id in vault.folders) if (parentOf(id) === (parentId || null)) out.push({ kind: "folder", id });
  return out.sort(cmpSiblings(parentId));
}
// Stamp an order on every UNORDERED sibling (appended after the ordered ones, in
// display sequence), bumping only the mtimes it stamps. After this, neighbour
// math never sees an undefined order. Must run AFTER any no-op check: it writes
// in memory only, and a drop that changes nothing must not leave unpersisted
// ghosts that light unsynced dots on the next unrelated save.
function ensureSiblingOrders(parentId) {
  const items = siblingItems(parentId), now = Date.now();
  let max = 0;
  for (const it of items) { const o = sibRec(it).order; if (typeof o === "number" && o > max) max = o; }
  for (const it of items) {
    const r = sibRec(it);
    if (typeof r.order !== "number") { max += ORDER_GAP; r.order = max; r.mtime = now; }
  }
}
// Re-space a level when two neighbours have no integer room left (~never for a
// personal vault). Preserves the current relative order.
function reseedSiblings(parentId) {
  const items = siblingItems(parentId), now = Date.now();
  items.forEach((it, i) => { const r = sibRec(it); r.order = (i + 1) * ORDER_GAP; r.mtime = now; });
}
// The order value that puts `drag` before/after `anchor` in parentId's combined
// sequence, or null when that slot is drag's current one (no-op) / the anchor is
// missing. Recurses through a reseed when out of integer room.
function orderForSlot(parentId, drag, anchor, below) {
  const full = siblingItems(parentId);
  const ids = full.filter(it => sibKey(it) !== sibKey(drag));
  const ti = ids.findIndex(it => sibKey(it) === sibKey(anchor));
  if (ti < 0) return null;
  const at = below ? ti + 1 : ti;
  const Lit = at > 0 ? ids[at - 1] : null, Rit = at < ids.length ? ids[at] : null;
  const ci = full.findIndex(it => sibKey(it) === sibKey(drag));
  if (ci >= 0) {   // dragging within this level: exact-slot no-op
    const prev = ci > 0 ? sibKey(full[ci - 1]) : null;
    const next = ci < full.length - 1 ? sibKey(full[ci + 1]) : null;
    if ((Lit ? sibKey(Lit) : null) === prev && (Rit ? sibKey(Rit) : null) === next) return null;
  }
  ensureSiblingOrders(parentId);
  const ord = it => sibRec(it).order;
  if (Lit && Rit) {
    if (ord(Rit) - ord(Lit) <= 1) { reseedSiblings(parentId); return orderForSlot(parentId, drag, anchor, below); }
    return Math.floor((ord(Lit) + ord(Rit)) / 2);
  }
  if (Rit) return ord(Rit) - ORDER_GAP;
  if (Lit) return ord(Lit) + ORDER_GAP;
  return ORDER_GAP;
}
// The order that places a note at the TOP of a level, or undefined when the
// level is still fully legacy (so the note is left un-ordered and the level
// keeps behaving exactly as before).
function topOrderOfGroup(fid) {
  let min = Infinity, any = false;
  for (const it of siblingItems(fid || null)) {
    const o = sibRec(it).order;
    if (typeof o === "number") { any = true; if (o < min) min = o; }
  }
  return any ? min - ORDER_GAP : undefined;
}
const newLooseOrder = () => topOrderOfGroup(null);

// The single mutation every reorder/move goes through. The mtime bump is mandatory: the
// merge decides by mtime, so a reorder that left mtime alone would never reach the other
// device and isUnsynced would never light the dot. Modeled on setNoteFolder.
function placeNote(id, order, folderId) {
  if (syncing || !vault.notes[id]) return;
  const n = vault.notes[id];
  if (typeof order === "number") n.order = order;
  if (folderId !== undefined) n.folderId = folderId;
  n.mtime = Date.now();
  if (folderId) revealFolder(folderId);   // incl. collapsed ANCESTORS, or the note vanishes
  persistSafe();
  renderList();
  renderStatus();
}

// Drop a dragged note above/below a target row: reorder within the target's group, and
// re-parent in the SAME call (single mtime bump) when the target is in another group.
// No-op drops (the note would keep its exact slot) return WITHOUT bumping mtime, so an
// idle drag never shows a spurious unsynced dot.
function reorderDrop(dragId, targetId, below) {
  if (syncing || !vault.notes[dragId] || !vault.notes[targetId] || dragId === targetId) return;
  const fid = groupOf(targetId);
  const order = orderForSlot(fid, { kind: "note", id: dragId }, { kind: "note", id: targetId }, below);
  if (order === null) return;
  placeNote(dragId, order, groupOf(dragId) === fid ? undefined : fid);
}
// Drop a note above/below a FOLDER row: the note lands in that folder's PARENT
// at that position - between two sibling subfolders it still simply belongs to
// the parent (or becomes loose when the target folder sits at top level).
function noteBesideFolderDrop(dragId, targetFid, below) {
  if (syncing || !vault.notes[dragId] || !vault.folders[targetFid]) return;
  const parentId = parentOf(targetFid);
  const order = orderForSlot(parentId, { kind: "note", id: dragId }, { kind: "folder", id: targetFid }, below);
  if (order === null) return;
  placeNote(dragId, order, groupOf(dragId) === (parentId || null) ? undefined : (parentId || null));
}
// Drop on a folder header (or a hover-expanded folder): append to the very end
// of the folder's block (after its notes AND subfolders).
function dropIntoFolder(dragId, fid) {
  if (syncing || !vault.notes[dragId] || !vault.folders[fid]) return;
  const full = siblingItems(fid), already = groupOf(dragId) === fid;
  const lastIt = full.length ? full[full.length - 1] : null;
  if (already && lastIt && lastIt.kind === "note" && lastIt.id === dragId) return;   // already last
  ensureSiblingOrders(fid);   // after the no-op check: see orderForSlot
  const rest = siblingItems(fid).filter(it => !(it.kind === "note" && it.id === dragId));
  const last = rest.length ? sibRec(rest[rest.length - 1]) : null;
  placeNote(dragId, last ? last.order + ORDER_GAP : ORDER_GAP, already ? undefined : fid);
}
// Re-parent a folder (parentId null = top level). Refuses cycles and over-deep
// nesting so the indent rails always fit the sidebar. mtime bump: the merge
// decides by mtime, so a silent re-parent would never reach the other device.
function nestFolder(fid, parentId) {
  if (syncing || !vault.folders[fid]) return;
  // No-op iff the STORED pointer already equals the request: a dangling parentId
  // (parent purged by a merge) renders at top level, and an explicit move-to-top
  // must clear it or the stale id keeps riding sync waiting to re-nest.
  if (parentId === fid || (parentId || null) === (vault.folders[fid].parentId || null)) return;
  if (parentId) {
    if (!vault.folders[parentId]) return;
    if (isDescendantOf(parentId, fid)) { status("Can't move a folder into its own subfolder", true); return; }
    if (folderDepth(parentId) + 1 + subtreeHeight(fid) >= MAX_NEST) {
      status(`Folders only nest ${MAX_NEST} levels deep`, true); return;
    }
  }
  vault.folders[fid].parentId = parentId || null;
  vault.folders[fid].mtime = Date.now();
  // A folder moved under a collapsed ancestor chain would vanish: open it all.
  if (parentId) revealFolder(parentId);
  persistSafe();
  renderList();
  renderStatus();
}

// Drop a dragged folder above/below a target folder row: reorder within the
// target's combined sibling level (folders AND notes interleave), re-parenting
// to the target's parent in the same single mtime bump when the target lives at
// another level. No-op drops return without bumping mtime - except the
// dangling-pointer cleanup below, which must write even when the visual slot is
// unchanged.
function reorderFolderDrop(dragId, targetId, below) {
  if (syncing || !vault.folders[dragId] || !vault.folders[targetId] || dragId === targetId) return;
  const newParent = parentOf(targetId);
  const rawCur = vault.folders[dragId].parentId || null;
  const reParent = (newParent || null) !== rawCur;   // incl. dangling-pointer cleanup
  if (reParent && newParent) {
    // Same guards as nestFolder; skipped for a pure same-level reorder so an
    // over-deep merged chain can still be rearranged in place.
    if (newParent === dragId || isDescendantOf(newParent, dragId)) { status("Can't move a folder into its own subfolder", true); return; }
    if (folderDepth(targetId) + subtreeHeight(dragId) >= MAX_NEST) {
      status(`Folders only nest ${MAX_NEST} levels deep`, true); return;
    }
  }
  const order = orderForSlot(newParent, { kind: "folder", id: dragId }, { kind: "folder", id: targetId }, below);
  if (order === null && !reParent) return;
  const f = vault.folders[dragId];
  if (order !== null) f.order = order;
  f.parentId = newParent || null;
  f.mtime = Date.now();
  if (newParent) revealFolder(newParent);
  persistSafe();
  renderList();
  renderStatus();
}

// Drop on the loose-area background: append to the very end of the top level.
function dropIntoLoose(dragId) {
  if (syncing || !vault.notes[dragId]) return;
  const full = siblingItems(null), already = groupOf(dragId) === null;
  const lastIt = full.length ? full[full.length - 1] : null;
  if (already && lastIt && lastIt.kind === "note" && lastIt.id === dragId) return;   // already last
  ensureSiblingOrders(null);   // after the no-op check: see orderForSlot
  const rest = siblingItems(null).filter(it => !(it.kind === "note" && it.id === dragId));
  const last = rest.length ? sibRec(rest[rest.length - 1]) : null;
  placeNote(dragId, last ? last.order + ORDER_GAP : ORDER_GAP, already ? undefined : null);
}

// ---- Drag visuals + lifecycle ----
function showDropIndicator(row, below) {
  clearDropIndicator();
  row.classList.add(below ? "drop-after" : "drop-before");
  lastDropRow = row;
}
function clearDropIndicator() {
  if (lastDropRow) { lastDropRow.classList.remove("drop-before", "drop-after"); lastDropRow = null; }
}
function clearFolderDropHighlight() {
  for (const el of $("notelist").querySelectorAll(".folder-row.drop-target")) el.classList.remove("drop-target");
}
// Explicit "drop here to leave the folder" bar, shown only while dragging a
// note that is currently in a folder (a packed/overflowing list may have no
// loose-area gap to aim at otherwise).
let looseDropBar = null;
function showLooseDropBar(label = "Drop here to remove from folder") {
  if (looseDropBar) return;
  looseDropBar = mk("div", "loose-drop-bar", label);
  looseDropBar.addEventListener("dragover", e => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    looseDropBar.classList.add("over");
  });
  looseDropBar.addEventListener("dragleave", () => looseDropBar && looseDropBar.classList.remove("over"));
  looseDropBar.addEventListener("drop", e => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) return;
    e.preventDefault(); e.stopPropagation();
    const noteId = draggingNoteId, folderId = draggingFolderId;
    finishDrag();
    if (noteId) dropIntoLoose(noteId);
    else nestFolder(folderId, null);
  });
  $("notelist").appendChild(looseDropBar);
}
function hideLooseDropBar() {
  if (looseDropBar) { looseDropBar.remove(); looseDropBar = null; }
}
// Expand a collapsed folder mid-drag WITHOUT renderList (which rebuilds #notelist and
// destroys the dragged source row, aborting the drag in most browsers): insert this
// folder's rows right after its header. The eventual drop's placeNote does the
// authoritative renderList; finishDrag persists the collapse state.
function expandFolderInline(fid, headerRow) {
  if (!collapsed.has(fid) || !headerRow.isConnected) return;
  collapsed.delete(fid);
  hoverExpanded = true;
  const arrow = headerRow.querySelector(".folder-arrow");
  if (arrow) arrow.classList.add("open");
  let anchor = headerRow;
  // Transient drag affordance: rails without caps (renderList redraws them capped),
  // and the folder's own notes only - subfolder rows aren't drop targets here.
  const rails = noteRailColors(fid);
  for (const id of groupIds(fid)) { const r = noteRow(id, rails); anchor.after(r); anchor = r; }
}
function scheduleHoverExpand(fid, row) {
  if (hoverExpandFid === fid) return;
  cancelHoverExpand();
  hoverExpandFid = fid;
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null;
    if (draggingNoteId && collapsed.has(fid)) expandFolderInline(fid, row);
  }, 600);
}
function cancelHoverExpand() {
  if (hoverExpandTimer) { clearTimeout(hoverExpandTimer); hoverExpandTimer = null; }
  hoverExpandFid = null;
}
// End-of-drag cleanup, idempotent: runs from the drop handler BEFORE the authoritative
// renderList, and again from dragend (which may fire on a now-detached source row).
function finishDrag() {
  clearDropIndicator();
  clearFolderDropHighlight();
  hideLooseDropBar();
  cancelHoverExpand();
  saveCollapsed();   // persist any hover-expand
  draggingNoteId = null;
  draggingFolderId = null;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  // An inline expand inserted note rows only (no subfolder headers, uncapped
  // rails). A drop re-renders anyway; a CANCELLED drag would leave that
  // half-rendered state on screen forever - settle it now that state is clear.
  if (hoverExpanded) { hoverExpanded = false; renderList(); }
}

// Single writer for the whole sidebar (note list + trash). Guarded because an
// inline input losing focus mid-render must not re-enter renderList.
let renderingList = false;
function renderList() {
  if (renderingList) return;
  renderingList = true;
  try { renderListInner(); } finally { renderingList = false; }
  renderTrash();
}

function renderListInner() {
  const list = $("notelist");
  list.innerHTML = "";
  const q = searchQuery.trim().toLowerCase();
  const searching = q.length > 0;

  // Drop collapse entries for folders that no longer exist.
  let pruned = false;
  for (const fid of [...collapsed]) if (!vault.folders[fid]) { collapsed.delete(fid); pruned = true; }
  if (pruned) saveCollapsed();

  const byFolder = {}, loose = [];
  for (const id in vault.notes) {
    // Pinned notes are listed once, in the Pinned section above, never again inside their folder.
    if (isPinned(id)) continue;
    const fid = vault.notes[id].folderId;
    if (fid && vault.folders[fid]) (byFolder[fid] = byFolder[fid] || []).push(id);
    else loose.push(id);   // a note pointing at a deleted folder shows in the plain list
  }
  // Sort each group by the drag comparator (ordered notes asc, then legacy mtime desc);
  // a fully-legacy group keeps the exact newest-first order the whole list used before.
  for (const fid in byFolder) byFolder[fid].sort(cmpNotes);
  loose.sort(cmpNotes);
  // A note shows when nothing is being searched, or when its title OR its body text contains the query.
  const visibleNote = id => !searching || noteMatches(id, q);

  if (inlineEdit && inlineEdit.kind === "new") list.appendChild(inlineFolderRow(null));

  // A drag whose source row this rebuild is about to destroy can never finish
  // (its dragend may fire on a detached node or not at all): clean up now so
  // stale drag state can't hijack the next drag. Drop paths already cleared
  // state before mutating, so this only fires for background renders (sync).
  if (draggingNoteId || draggingFolderId) finishDrag();

  // Folder tree: children per parent id ("" = top level). Display order within a
  // level comes from siblingItems (notes and folders interleaved); kidsOf only
  // feeds reachability and search visibility. A merged parent cycle makes its
  // members unreachable from the root, so they'd silently vanish: surface every
  // unreached folder at top level instead (the walked-set below stops the loop
  // from rendering forever).
  const kidsOf = { "": [] };
  const fids = Object.keys(vault.folders);
  for (const fid of fids) { const p = parentOf(fid) || ""; (kidsOf[p] = kidsOf[p] || []).push(fid); }
  { const reach = new Set(), stack = [...kidsOf[""]];
    while (stack.length) { const f = stack.pop(); if (reach.has(f)) continue; reach.add(f); for (const c of kidsOf[f] || []) stack.push(c); }
    for (const fid of fids) if (!reach.has(fid)) kidsOf[""].push(fid); }

  // While searching: a folder shows if its NAME matches (then all its notes show),
  // if any of its own notes match, or if any descendant folder shows (ancestors
  // must render to give the match its path and rails).
  const visNotes = {}, showFolder = {}, visSeen = new Set();
  const computeVis = fid => {
    if (visSeen.has(fid)) return false;   // cycle guard
    visSeen.add(fid);
    const all = byFolder[fid] || [];
    const nameMatches = searching && folderName(fid).toLowerCase().includes(q);
    visNotes[fid] = (!searching || nameMatches) ? all : all.filter(visibleNote);
    let show = !searching || nameMatches || visNotes[fid].length > 0;
    for (const c of kidsOf[fid] || []) show = computeVis(c) || show;
    return (showFolder[fid] = show);
  };
  for (const fid of kidsOf[""]) computeVis(fid);

  // The walk appends rows and records each row's rail descriptors; after a
  // folder's block is emitted, its first and last rows get the 4px inset caps on
  // that folder's own (innermost) rail level. Rails/indent are clamped to
  // MAX_NEST so an over-deep merged chain still nests logically but never walks
  // its stripes past the gutter or its text off the 230px sidebar.
  let rows = 0;
  const rowDescs = [], walked = new Set();
  const pushRow = (el, colors) => {
    list.appendChild(el);
    rowDescs.push({ el, rails: colors.map(c => ({ color: c })) });
  };
  const walkFolder = (fid, colors) => {
    if (walked.has(fid) || (searching && !showFolder[fid])) return;
    walked.add(fid);
    if (inlineEdit && inlineEdit.kind === "rename" && inlineEdit.folderId === fid)
      pushRow(inlineFolderRow(fid, colors.length), colors);
    // The count includes this folder's pinned notes, which are listed in the Pinned section instead.
    else pushRow(folderRow(fid, visNotes[fid].length + (pinnedIn[fid] || 0), colors), colors);
    rows++;
    // While searching, persisted collapse state is ignored (a match hidden
    // inside a collapsed folder reads as data loss) and never written to.
    if (!searching && collapsed.has(fid)) return;
    const clamped = colors.length >= MAX_NEST;
    const myColors = clamped ? colors : [...colors, (vault.folders[fid].color || null)];
    const start = rowDescs.length;
    // Combined sequence: the folder's notes and subfolders interleave by their
    // shared order space, so a note dragged between two subfolders stays there.
    const vis = new Set(visNotes[fid]);
    for (const it of siblingItems(fid)) {
      if (it.kind === "note") { if (vis.has(it.id)) pushRow(noteRow(it.id, myColors), myColors); }
      else walkFolder(it.id, myColors);
    }
    if (!clamped && rowDescs.length > start) {
      rowDescs[start].rails[myColors.length - 1].capTop = true;
      rowDescs[rowDescs.length - 1].rails[myColors.length - 1].capBottom = true;
    }
  };
  // Pinned section: every pinned note that passes the search, most recently pinned
  // first, under a small label. These rows sit outside the folder tree, so they
  // get no rails, cannot be dragged, and are not drop targets (see noteRow).
  const pinnedIds = Object.keys(vault.notes).filter(id => isPinned(id) && visibleNote(id))
    .sort((a, b) => (vault.pins[b].at || 0) - (vault.pins[a].at || 0));
  // How many shown pinned notes belong to each folder: added to that folder's count below.
  const pinnedIn = {};
  for (const id of pinnedIds) { const f = vault.notes[id].folderId; if (f) pinnedIn[f] = (pinnedIn[f] || 0) + 1; }
  if (pinnedIds.length) {
    list.appendChild(mk("div", "list-label", "Pinned"));
    for (const id of pinnedIds) { list.appendChild(noteRow(id, [])); rows++; }
    // A second label marks where the ordinary list starts, so the two never blur together.
    list.appendChild(mk("div", "list-label", "Notes"));
  }
  // Top level: loose notes and root folders interleave the same way. Cycle
  // orphans (unreachable from the root) follow at the end via kidsOf[""].
  for (const it of siblingItems(null)) {
    // Pinned notes were listed above, so they are skipped here as well as inside folders.
    if (it.kind === "note") { if (!isPinned(it.id) && visibleNote(it.id)) { pushRow(noteRow(it.id, []), []); rows++; } }
    else walkFolder(it.id, []);
  }
  for (const fid of kidsOf[""]) walkFolder(fid, []);
  for (const d of rowDescs) applyRails(d.el, d.rails);

  // No empty-state under an active inline input: "No notes yet - press New note"
  // beneath the new-folder name field invites a click that blurs the edit away.
  if (!rows && !inlineEdit) list.appendChild(mk("div", "empty-state",
    searching ? "No notes match this search" : "No notes yet - press New note"));
}

function noteRow(id, railColors = []) {
  const n = vault.notes[id];
  const div = mk("div", "note-item" + (id === currentId ? " active" : "") + (railColors.length ? " in-folder" : ""));
  if (railColors.length) {
    div.style.paddingLeft = (9 + 12 * railColors.length) + "px";   // 12px per nesting level
    applyRails(div, railColors.map(c => ({ color: c })));          // capped variant re-applied by the walk
  }
  if (n.color) div.style.borderLeftColor = n.color;
  const row = mk("div", "note-title");
  const dot = mk("span", "color-dot");
  if (n.color) dot.style.background = n.color;
  row.appendChild(dot);
  row.appendChild(mk("span", "t" + (n.title ? "" : " untitled"), n.title || "(untitled)"));
  // Always present, only toggled: appending it conditionally re-flowed the
  // title on every save and sync.
  const d = mk("span", "dot", "●");
  d.style.visibility = (isUnsynced(id) || (id === currentId && dirty)) ? "" : "hidden";
  row.appendChild(d);
  div.appendChild(row);
  // Second line: while searching, a body match shows WHERE it matched; otherwise the usual date.
  const q = searchQuery.trim().toLowerCase();
  const pinned = isPinned(id);
  // So first, if there is a query the title does not contain, the match must be in the body: show it.
  const snippet = q && !(n.title || "").toLowerCase().includes(q) ? bodySnippet(id, q) : null;
  if (snippet) div.appendChild(snippet);
  else {
    // A pinned row has left its folder's place in the list, so its date line also names the folder.
    const where = pinned && n.folderId && vault.folders[n.folderId] ? folderName(n.folderId) + " · " : "";
    div.appendChild(mk("div", "note-meta", where + relTime(n.mtime)));
  }
  // The class drives the small pin mark in the stylesheet.
  if (pinned) div.classList.add("pinned");
  // justDragged swallows the synthetic click a completed drag leaves behind; a real
  // click never fires dragstart (native DnD only starts past the OS threshold) so it
  // opens normally. Keyboard activation (below) is unaffected.
  div.onclick = () => { if (justDragged) return; flushSave(); openNote(id); };
  div.oncontextmenu = e => { e.preventDefault(); openMenu(e.clientX, e.clientY, noteMenu(id)); };

  // ---- Drag source: reorder within a group / move between folders ----
  // No DnD mid-sync, in a read-only backup view, or on a pinned row (it sits outside the folder order it would reorder).
  div.draggable = !syncing && !backupView && !pinned;
  div.addEventListener("dragstart", e => {
    if (syncing) { e.preventDefault(); return; }
    draggingNoteId = id;
    e.dataTransfer.effectAllowed = "move";
    // Only a private id type: no Files and no text/plain, so the editor/#main file-drop
    // and text-drop handlers all ignore it and the id can never land in a note as text.
    try { e.dataTransfer.setData("application/x-note-id", id); } catch {}
    div.classList.add("dragging");
    // A note inside a folder needs a reachable "out to loose" target even when the
    // list overflows: reveal an explicit drop bar for the duration of the drag.
    if (vault.notes[id] && vault.notes[id].folderId && vault.folders[vault.notes[id].folderId] && !searchQuery.trim())
      showLooseDropBar();
  });
  div.addEventListener("dragend", () => { div.classList.remove("dragging"); finishDrag(); });
  // Row is a reorder drop target (suppressed while searching: visible neighbours are
  // filtered, so an insertion index would be meaningless - move-to-folder still works).
  div.addEventListener("dragover", e => {
    // A pinned row is never a reorder target: its neighbours in the Pinned section are not its folder siblings.
    if (syncing || !draggingNoteId || draggingNoteId === id || searchQuery.trim() || pinned) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = div.getBoundingClientRect();
    showDropIndicator(div, e.clientY > r.top + r.height / 2);
  });
  div.addEventListener("dragleave", () => { if (lastDropRow === div) clearDropIndicator(); });
  div.addEventListener("drop", e => {
    // A folder dropped on a note row is ambiguous: swallow it (folders land only
    // on folder headers, the drop bar, or the background) so it can't bubble to
    // the #notelist handler and silently jump to top level.
    if (draggingFolderId) { e.preventDefault(); e.stopPropagation(); finishDrag(); return; }
    if (syncing || !draggingNoteId) return;
    e.stopPropagation();   // don't also fire the #notelist loose-area drop
    // While searching, ignore the row drop entirely (stopPropagation above blocks the
    // loose fallback too); the drop must not land at a filtered index.
    // Same for a drop on a pinned row: swallowed, so it cannot land at a meaningless index.
    if (searchQuery.trim() || draggingNoteId === id || pinned) { e.preventDefault(); finishDrag(); return; }
    e.preventDefault();
    const dragId = draggingNoteId;
    const r = div.getBoundingClientRect();
    const below = e.clientY > r.top + r.height / 2;
    finishDrag();
    reorderDrop(dragId, id, below);
  });

  // Deletion lives only in the context menu, so the menu must be reachable
  // without a mouse.
  makeRowKeyboardAccessible(div, () => { flushSave(); openNote(id); }, () => noteMenu(id));
  return div;
}

// Enter/Space activates, ContextMenu or Shift+F10 opens the row's menu at the
// row's own corner.
function makeRowKeyboardAccessible(el, activate, menuItems) {
  el.tabIndex = 0;
  el.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      openMenu(r.left + 12, r.bottom - 4, menuItems());
    }
  });
}

function folderRow(fid, count, railColors = []) {
  const f = vault.folders[fid];
  const searching = searchQuery.trim().length > 0;
  const open = searching || !collapsed.has(fid);
  const row = mk("div", "folder-row" + (railColors.length ? " nested" : ""));
  if (railColors.length) row.style.paddingLeft = (9 + 12 * railColors.length) + "px";
  row.appendChild(mk("span", "folder-arrow" + (open ? " open" : ""), "▶"));
  const dot = mk("span", "color-dot");
  if (f.color) dot.style.background = f.color;
  row.appendChild(dot);
  row.appendChild(mk("span", "folder-name", f.name || "(unnamed)"));
  row.appendChild(mk("span", "folder-count", String(count)));
  row.onclick = () => {
    if (justDragged) return;   // swallow the synthetic click a completed drag leaves
    if (searching) return;     // disclosure is inert while searching
    if (collapsed.has(fid)) collapsed.delete(fid); else collapsed.add(fid);
    saveCollapsed();
    renderList();
  };
  row.oncontextmenu = e => { e.preventDefault(); openMenu(e.clientX, e.clientY, folderMenu(fid)); };

  // ---- Drag source: nest this folder under another (or out to top level). ----
  row.draggable = !syncing && !backupView;
  row.addEventListener("dragstart", e => {
    if (syncing) { e.preventDefault(); return; }
    draggingFolderId = fid;
    e.dataTransfer.effectAllowed = "move";
    // Private id type only, same reason as notes: editor drop handlers ignore it.
    try { e.dataTransfer.setData("application/x-folder-id", fid); } catch {}
    row.classList.add("dragging");
    if (parentOf(fid) && !searchQuery.trim()) showLooseDropBar("Drop here to move to top level");
  });
  row.addEventListener("dragend", () => { row.classList.remove("dragging"); finishDrag(); });

  // ---- Drop target: a dragged note appends to this folder's end; a dragged
  // folder splits the row into three zones - top/bottom quarter inserts the
  // folder before/after this one (sibling reorder, insertion line), middle half
  // nests it inside (row highlight). Stays active while searching (an append
  // needs no insertion index; sibling reorder is suppressed like note reorder,
  // since visible neighbours are filtered). A dwell over a collapsed folder
  // expands it in place so a NOTE can be dropped among its rows.
  const folderDropZone = e => {   // "before" | "after" | "into"
    if (searchQuery.trim()) return "into";
    const r = row.getBoundingClientRect();
    const t = (e.clientY - r.top) / r.height;
    return t < .25 ? "before" : t > .75 ? "after" : "into";
  };
  row.addEventListener("dragover", e => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) return;
    // Dropping a folder on itself or its own subtree can't be allowed (cycle).
    if (draggingFolderId && (draggingFolderId === fid || isDescendantOf(fid, draggingFolderId))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Notes get the same three zones: edges insert the note beside this folder
    // (into its PARENT's sequence), the middle drops it inside.
    const zone = folderDropZone(e);
    if (zone === "into") {
      clearDropIndicator();
      row.classList.add("drop-target");
    } else {
      row.classList.remove("drop-target");
      showDropIndicator(row, zone === "after");
    }
    if (zone === "into" && draggingNoteId && !searchQuery.trim() && collapsed.has(fid)) scheduleHoverExpand(fid, row);
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-target");
    if (lastDropRow === row) clearDropIndicator();
    if (hoverExpandFid === fid) cancelHoverExpand();
  });
  row.addEventListener("drop", e => {
    if (syncing || (!draggingNoteId && !draggingFolderId)) return;
    e.preventDefault();
    e.stopPropagation();
    const noteId = draggingNoteId, folderId = draggingFolderId;
    const zone = folderDropZone(e);
    finishDrag();
    if (noteId) {
      if (zone === "into") dropIntoFolder(noteId, fid);
      else noteBesideFolderDrop(noteId, fid, zone === "after");
    } else if (zone === "into") nestFolder(folderId, fid);
    else reorderFolderDrop(folderId, fid, zone === "after");
  });

  makeRowKeyboardAccessible(row, () => row.onclick(), () => folderMenu(fid));
  return row;
}

async function purgeAllTrash() {
  const n = Object.keys(vault.trash).length;
  if (syncing || backupView || !n) return;
  const ok = await confirmModal({
    title: `Empty the trash (${n} note${n === 1 ? "" : "s"})?`,
    body: "Every note in the trash and its attachments will be removed from this device and, on the next sync, from the repo. This cannot be undone.",
    confirmLabel: "Delete all permanently", destructive: true,
  });
  if (!ok || syncing || backupView || !vault) return;
  for (const id of Object.keys(vault.trash)) purgeTrashCore(id);
  persistSafe();
  renderList();
  renderStatus();
  status("Trash emptied");
}

// Pinned at the bottom, never filtered by the search box.
function renderTrash() {
  const head = $("trash-head"), list = $("trash-list");
  const ids = Object.keys(vault.trash).sort((a, b) => (vault.trash[b].deletedAt || 0) - (vault.trash[a].deletedAt || 0));
  head.innerHTML = "";
  head.appendChild(mk("span", "folder-arrow" + (trashCollapsed ? "" : " open"), "▶"));
  head.appendChild(mk("span", "folder-name", `Trash (${ids.length})`));
  if (!trashCollapsed && ids.length && !backupView) {
    const clear = mk("button", "trash-clear", "Delete all");
    clear.type = "button";
    clear.title = "Delete every trashed note permanently";
    clear.disabled = syncing;
    clear.onclick = e => { e.stopPropagation(); purgeAllTrash(); };
    head.appendChild(clear);
  }
  head.onclick = () => {
    trashCollapsed = !trashCollapsed;
    localStorage.setItem("trashCollapsed", trashCollapsed ? "1" : "0");
    renderList();
  };
  list.innerHTML = "";
  list.style.display = trashCollapsed ? "none" : "";
  if (trashCollapsed) return;
  if (!ids.length) { list.appendChild(mk("div", "empty-state", "Trash is empty")); return; }
  for (const id of ids) {
    const t = vault.trash[id], d = t.data || {};
    const div = mk("div", "trash-item" + (id === trashViewId ? " active" : ""));
    const row = mk("div", "note-title");
    row.appendChild(mk("span", "t" + (d.title ? "" : " untitled"), d.title || "(untitled)"));
    div.appendChild(row);
    div.appendChild(mk("div", "note-meta", "deleted " + relTime(t.deletedAt || 0)));
    div.onclick = () => openTrash(id);
    div.oncontextmenu = e => { e.preventDefault(); openMenu(e.clientX, e.clientY, trashMenu(id)); };
    makeRowKeyboardAccessible(div, () => openTrash(id), () => trashMenu(id));
    list.appendChild(div);
  }
}
