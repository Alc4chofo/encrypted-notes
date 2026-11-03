// notes: Laying out pictures and files in a note: menu, resize handles, table grip, guides.
"use strict";

// ---------- Image / file layout menu ----------
// Right-click any attachment in the note: resize and align it, Word-style.
function mediaLayoutMenu(el) {
  const cur = mediaLayout(el);
  const setW = w => {
    if (w) el.setAttribute("data-w", String(w)); else el.removeAttribute("data-w");
    if (!w) { el.style.width = ""; el.style.height = ""; }
    applyMediaLayout(el);
    markDirtyFromFormatting();
  };
  const setAlign = a => {
    if (a) el.setAttribute("data-align", a); else el.removeAttribute("data-align");
    applyMediaLayout(el);
    markDirtyFromFormatting();
  };
  const sizes = [["Small", 160], ["Medium", 320], ["Large", 520], ["Full width", 1000]];
  return [
    { label: "Size", submenu: () => [
      ...sizes.map(([lab, w]) => ({ label: lab, checked: cur.w === w, onClick: () => setW(w) })),
      { sep: true },
      { label: "Original", checked: !cur.w, onClick: () => setW(null) },
    ] },
    { label: "Position", submenu: () => [
      { label: "Free - drag it anywhere", checked: cur.fx !== null, disabled: cur.fx !== null,
        onClick: () => {
          const surf = surfaceOfNode(el) || activeSurface();
          if (surf) { placeFloating(el, surf, el.getBoundingClientRect().left, el.getBoundingClientRect().top,
            { dx: 0, dy: 0 }); markDirtyFromFormatting(); }
        } },
      { label: "Back in the text", checked: cur.fx === null, onClick: () => {
        el.removeAttribute("data-fx"); el.removeAttribute("data-fy");
        applyMediaLayout(el);
        markDirtyFromFormatting();
      } },
    ] },
    { label: "Align in text", disabled: cur.fx !== null, submenu: () => [
      { label: "Left", checked: cur.align === "left", onClick: () => setAlign("left") },
      { label: "Center", checked: cur.align === "center", onClick: () => setAlign("center") },
      { label: "Right", checked: cur.align === "right", onClick: () => setAlign("right") },
      { sep: true },
      { label: "Inline with text", checked: !cur.align, onClick: () => setAlign(null) },
    ] },
    { sep: true },
    { label: "Remove from note", danger: true, onClick: () => {
      el.remove();
      markDirtyFromFormatting();
      updateEditorEmpty();
    } },
  ];
}
// ---------- Image handles: click to select, drag a corner to resize ----------
// Google-Docs style. The size is written to data-w (the same attribute the menu
// and the PDF read), so a handle drag and a menu choice are the same thing.
let selectedMedia = null, resizing = null, justDraggedMedia = false, movingFloat = null;
function selectMedia(el) {
  if (selectedMedia === el) return;
  clearMediaSelection();
  if (!el) return;
  selectedMedia = el;
  el.classList.add("selected");
  for (const c of ["nw", "ne", "sw", "se"]) {
    const h = mk("span", "media-handle h-" + c);
    h.dataset.corner = c;
    h.contentEditable = "false";
    el.appendChild(h);
  }
}
function clearMediaSelection() {
  if (!selectedMedia) return;
  selectedMedia.classList.remove("selected");
  for (const h of [...selectedMedia.querySelectorAll(".media-handle")]) h.remove();
  selectedMedia = null;
}
// Resizing starts on mousedown (the handles only exist once something is
// selected, so no mutation happens here).
$("edit-wrap").addEventListener("mousedown", e => {
  const h = e.target && e.target.classList && e.target.classList.contains("media-handle") ? e.target : null;
  if (h && selectedMedia) {
    e.preventDefault();
    const r = selectedMedia.getBoundingClientRect();
    resizing = { el: selectedMedia, startX: e.clientX, startW: r.width,
      left: h.dataset.corner === "nw" || h.dataset.corner === "sw" };
    return;
  }
  // A pinned image is dragged directly with the mouse (no HTML5 drag needed):
  // it follows the pointer and stays wherever it is released.
  const el = e.target && e.target.nodeType === 1 ? e.target.closest("span.inline-media.floating") : null;
  if (!el || !surfaceOfNode(el) || trashViewId || backupView || syncing) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  movingFloat = { el, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
});
// Selection happens on CLICK, never on mousedown. selectMedia() appends the
// handle elements into the very node the user may be about to drag, and mutating
// a drag source between mousedown and the drag threshold makes the browser
// abandon the gesture - which is exactly why images could not be moved.
$("edit-wrap").addEventListener("click", e => {
  if (justDraggedMedia) return;            // the click that ends a drag is not a selection
  const el = e.target && e.target.nodeType === 1 ? e.target.closest("span.inline-media") : null;
  if (el && surfaceOfNode(el) && !trashViewId && !backupView) selectMedia(el);
  else clearMediaSelection();
});
window.addEventListener("mousemove", e => {
  if (resizing) {
    const dx = (e.clientX - resizing.startX) * (resizing.left ? -1 : 1);
    const w = Math.max(40, Math.min(2000, Math.round(resizing.startW + dx)));
    resizing.el.setAttribute("data-w", String(w));
    applyMediaLayout(resizing.el);
    return;
  }
  if (!movingFloat) return;
  const surf = surfaceAtPoint(e.clientX, e.clientY) || surfaceOfNode(movingFloat.el);
  if (!surf) return;
  movingFloat.moved = true;
  if (movingFloat.grip) {
    // Tables follow the grip directly; the centre guide still applies.
    const box = surf.getBoundingClientRect(), r = movingFloat.el.getBoundingClientRect();
    const snapped = showDragGuide(surf, e.clientX - movingFloat.dx + r.width / 2);
    const grab = snapped
      ? { dx: e.clientX - (box.left + box.width / 2 - r.width / 2), dy: movingFloat.dy }
      : { dx: movingFloat.dx, dy: movingFloat.dy };
    placeFloating(movingFloat.el, surf, e.clientX, e.clientY, grab);
    positionGrip();
    return;
  }
  const snap = showDragGuide(surf, e.clientX - movingFloat.dx + movingFloat.el.getBoundingClientRect().width / 2);
  let grab = { dx: movingFloat.dx, dy: movingFloat.dy };
  if (snap) {
    const box = surf.getBoundingClientRect(), r = movingFloat.el.getBoundingClientRect();
    grab = { dx: e.clientX - (box.left + box.width / 2 - r.width / 2), dy: movingFloat.dy };
  }
  placeFloating(movingFloat.el, surf, e.clientX, e.clientY, grab);
});
window.addEventListener("mouseup", () => {
  if (resizing) { resizing = null; markDirtyFromFormatting(); return; }
  if (!movingFloat) return;
  const moved = movingFloat.moved;
  movingFloat = null;
  hideDragGuide();
  if (moved) markDirtyFromFormatting();
});

// ---------- Table move grip ----------
// Tables cannot be HTML5-dragged (every cell is an edit target), so they get a
// Word-style grip at the top-left. Dragging it pins the table wherever you drop
// it, exactly like an image. The grip lives on <body>, so it is never part of
// the note content and never gets serialized.
let gripTable = null;
function positionGrip() {
  if (!gripTable || !gripTable.isConnected) { hideTableGrip(); return; }
  const r = gripTable.getBoundingClientRect();
  const wrap = $("edit-wrap").getBoundingClientRect();
  // Hide it when the table scrolls out of the editing area.
  if (r.bottom < wrap.top || r.top > wrap.bottom) { tableGrip.style.display = "none"; return; }
  tableGrip.style.display = "flex";
  tableGrip.style.left = Math.round(r.left - 20) + "px";
  tableGrip.style.top = Math.round(r.top - 2) + "px";
}
// ---- Column / row size handles ----
// One small button per column (above it) and per row (left of it). Drag to size
// continuously, or just click to step it up. They live on <body> beside the
// grip, so none of this chrome can ever end up inside the note.
let sizeBar = null, sizing = null;
const COL_STEP = 24, ROW_STEP = 10;
function tableRows(t) { return [...t.querySelectorAll("tr")]; }
function colCells(t, i) { return tableRows(t).map(r => r.children[i]).filter(Boolean); }
// Fixed layout only honours widths it has actually been given. If a table has
// never been resized, freeze every column at its CURRENT rendered width first -
// otherwise setting one column makes the browser re-share the leftover space
// among the others, which is what made them jump around.
function materializeColWidths(t) {
  const first = tableRows(t)[0];
  if (!first) return;
  if ([...first.children].every(c => /\d+px/.test(c.style.width || ""))) return;
  const widths = [...first.children].map(c => Math.round(c.getBoundingClientRect().width));
  widths.forEach((w, i) => { for (const c of colCells(t, i)) c.style.width = Math.max(24, w) + "px"; });
}
function setColWidth(t, i, px) {
  materializeColWidths(t);
  const w = Math.max(24, Math.min(1600, Math.round(px)));
  for (const c of colCells(t, i)) c.style.width = w + "px";
  markDirtyFromFormatting();
}
function setRowHeight(tr, px) {
  const h = Math.max(16, Math.min(1200, Math.round(px)));
  for (const c of tr.children) c.style.height = h + "px";
  markDirtyFromFormatting();
}
function buildSizeHandles() {
  if (!sizeBar) {
    sizeBar = mk("div", "size-bar");
    // Same grace rule as the grip: reaching for a size button must not dismiss it.
    sizeBar.addEventListener("mouseenter", keepChrome);
    sizeBar.addEventListener("mouseleave", scheduleHideChrome);
    document.body.appendChild(sizeBar);
  }
  sizeBar.innerHTML = "";
  if (!gripTable || !gripTable.isConnected) return;
  const rows = tableRows(gripTable);
  const first = rows[0];
  if (!first) return;
  // Column handles, above each column.
  [...first.children].forEach((cell, i) => {
    const h = mk("button", "size-handle col", "↔");
    h.type = "button";
    h.title = "Drag to set this column's width (click to widen)";
    h.dataset.col = String(i);
    sizeBar.appendChild(h);
  });
  // Row handles, to the left of each row.
  rows.forEach((tr, j) => {
    const h = mk("button", "size-handle row", "↕");
    h.type = "button";
    h.title = "Drag to set this row's height (click to make it taller)";
    h.dataset.row = String(j);
    sizeBar.appendChild(h);
  });
  positionSizeHandles();
}
function positionSizeHandles() {
  if (!sizeBar || !gripTable || !gripTable.isConnected) return;
  const rows = tableRows(gripTable), first = rows[0];
  if (!first) return;
  const wrap = $("edit-wrap").getBoundingClientRect();
  for (const h of sizeBar.children) {
    if (h.dataset.col !== undefined) {
      const cell = first.children[+h.dataset.col];
      if (!cell) { h.style.display = "none"; continue; }
      const r = cell.getBoundingClientRect();
      h.style.display = (r.top - 18 < wrap.top || r.top > wrap.bottom) ? "none" : "flex";
      h.style.left = Math.round(r.left + r.width / 2 - 9) + "px";
      h.style.top = Math.round(r.top - 20) + "px";
    } else {
      const tr = rows[+h.dataset.row];
      if (!tr) { h.style.display = "none"; continue; }
      const r = tr.getBoundingClientRect();
      h.style.display = (r.bottom < wrap.top || r.top > wrap.bottom) ? "none" : "flex";
      h.style.left = Math.round(r.left - 20) + "px";
      h.style.top = Math.round(r.top + r.height / 2 - 9) + "px";
    }
  }
}
function hideSizeHandles() { if (sizeBar) sizeBar.innerHTML = ""; }
// Drag on a handle sizes live; a click with no movement steps it up.
document.addEventListener("mousedown", e => {
  const h = e.target && e.target.classList && e.target.classList.contains("size-handle") ? e.target : null;
  if (!h || !gripTable) return;
  e.preventDefault();
  e.stopPropagation();
  const isCol = h.dataset.col !== undefined;
  const rows = tableRows(gripTable);
  const cell = isCol ? rows[0].children[+h.dataset.col] : null;
  const tr = isCol ? null : rows[+h.dataset.row];
  const r = (cell || tr).getBoundingClientRect();
  sizing = { table: gripTable, isCol, index: isCol ? +h.dataset.col : +h.dataset.row,
    startX: e.clientX, startY: e.clientY, startW: r.width, startH: r.height, tr, moved: false };
}, true);
window.addEventListener("mousemove", e => {
  if (!sizing) return;
  const dx = e.clientX - sizing.startX, dy = e.clientY - sizing.startY;
  if (Math.abs(dx) + Math.abs(dy) > 3) sizing.moved = true;
  if (!sizing.moved) return;
  if (sizing.isCol) setColWidth(sizing.table, sizing.index, sizing.startW + dx);
  else setRowHeight(sizing.tr, sizing.startH + dy);
  positionSizeHandles();
  positionGrip();
});
window.addEventListener("mouseup", () => {
  if (!sizing) return;
  if (!sizing.moved) {
    // A plain click: nudge it one step bigger, so the buttons work without dragging.
    if (sizing.isCol) setColWidth(sizing.table, sizing.index, sizing.startW + COL_STEP);
    else setRowHeight(sizing.tr, sizing.startH + ROW_STEP);
    positionSizeHandles();
    positionGrip();
  }
  sizing = null;
});

let tableGrip = null;
function showTableGrip(table) {
  if (trashViewId || backupView || syncing) return;
  const changed = gripTable !== table;
  gripTable = table;
  if (changed) buildSizeHandles();
  if (!tableGrip) {
    tableGrip = mk("div", "table-grip", "✥");
    tableGrip.title = "Drag to move this table anywhere on the page";
    tableGrip.addEventListener("mousedown", e => {
      if (!gripTable) return;
      e.preventDefault();
      e.stopPropagation();
      const surf = surfaceOfNode(gripTable);
      if (!surf) return;
      const r = gripTable.getBoundingClientRect();
      // Pin it where it already is before the first move, so it does not jump.
      if (!gripTable.classList.contains("floating"))
        placeFloating(gripTable, surf, r.left, r.top, { dx: 0, dy: 0 });
      movingFloat = { el: gripTable, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, grip: true };
    });
    // Hovering the grip itself keeps the whole set alive.
    tableGrip.addEventListener("mouseenter", keepChrome);
    tableGrip.addEventListener("mouseleave", scheduleHideChrome);
    document.body.appendChild(tableGrip);
  }
  positionGrip();
}
function hideTableGrip() {
  if (sizing) return;   // never yank the handles away mid-resize
  gripTable = null;
  if (tableGrip) tableGrip.style.display = "none";
  hideSizeHandles();
}
// The grip and the size buttons sit OUTSIDE the table (just above and to the
// left of it), so moving the pointer towards them technically leaves the table.
// Hiding on that instant is what made them vanish before you could click.
// Instead: hide on a short delay, and cancel that the moment the pointer lands
// on any of the chrome, is back on the table, or is busy dragging/resizing.
let chromeHideTimer = null;
function keepChrome() { if (chromeHideTimer) { clearTimeout(chromeHideTimer); chromeHideTimer = null; } }
function scheduleHideChrome() {
  keepChrome();
  chromeHideTimer = setTimeout(() => {
    chromeHideTimer = null;
    if (sizing || movingFloat) return;                 // never mid-gesture
    if (gripTable && gripTable.contains(document.activeElement)) return;   // still editing in it
    hideTableGrip();
  }, 600);
}
$("edit-wrap").addEventListener("mouseover", e => {
  const t = e.target && e.target.closest ? e.target.closest("table") : null;
  if (t && surfaceOfNode(t)) { keepChrome(); showTableGrip(t); }
  else scheduleHideChrome();
});
$("edit-wrap").addEventListener("mouseleave", scheduleHideChrome);
const repositionTableChrome = () => { positionGrip(); positionSizeHandles(); };
$("edit-wrap").addEventListener("scroll", repositionTableChrome, true);
window.addEventListener("resize", repositionTableChrome);

// ---------- Drag guides ----------
// While an image is dragged, a vertical line marks the page centre; releasing
// within the snap zone centres the image instead of dropping it mid-sentence.
let dragGuide = null;
const SNAP_PX = 28;
function showDragGuide(surface, x) {
  const r = surface.getBoundingClientRect();
  const mid = r.left + r.width / 2;
  const near = Math.abs(x - mid) <= SNAP_PX;
  if (!dragGuide) {
    dragGuide = mk("div", "drag-guide");
    document.body.appendChild(dragGuide);
  }
  dragGuide.style.left = Math.round(mid) + "px";
  dragGuide.style.top = Math.round(r.top) + "px";
  dragGuide.style.height = Math.round(r.height) + "px";
  dragGuide.classList.toggle("snap", near);
  return near;
}
function hideDragGuide() { if (dragGuide) { dragGuide.remove(); dragGuide = null; } }

$("edit-wrap").addEventListener("contextmenu", e => {
  const el = e.target && e.target.nodeType === 1 ? e.target.closest("span.inline-media") : null;
  if (!el || !surfaceOfNode(el) || trashViewId || backupView || syncing) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, mediaLayoutMenu(el));
});
