/*
 * media-layout.js - laying out pictures, files and tables in a note: the
 * right-click layout menu, the resize handles, moving pinned items, the
 * table's move grip and size buttons, and the centre guide.
 *
 * A size chosen by hand is written to data-w, the same attribute the menu
 * and the PDF read, so dragging a handle and choosing a size in the menu are
 * the same thing. A pinned ("floating") item stays at its own spot on the
 * page, out of the text flow; it is dragged straight with the mouse. Tables
 * cannot be dragged the browser's way (every cell is a place to type), so
 * they get a grip at the top left, and a small button per column and per row
 * to size them. The grip, the buttons and the guide live on <body>, so none
 * of them can ever end up inside the note or be saved.
 *
 * Main functions: mediaLayoutMenu, selectMedia, clearMediaSelection,
 * positionGrip, setColWidth, setRowHeight, buildSizeHandles,
 * positionSizeHandles, showTableGrip, hideTableGrip, scheduleHideChrome,
 * showDragGuide, hideDragGuide.
 * Auxiliary functions: tableRows, colCells, materializeColWidths,
 * hideSizeHandles, keepChrome, repositionTableChrome.
 *
 * Complexity: O(1) per pointer move for a picture; O(r) for a table's rows
 * and O(r * c) to size a column the first time (every cell gets a width).
 */
"use strict";

// ---------- State ----------

// The picture with handles showing; the resize in progress; whether a drag
// just ended (its click must not select); the pinned item being moved.
let selectedMedia = null;
let resizing = null;
let justDraggedMedia = false;
let movingFloat = null;

// ---------- The layout menu ----------

/**
 * The right-click menu for an attachment in the note: its size (small,
 * medium, large, full width or its own), its position (free, pinned where it
 * is, or back in the text), its alignment in the text, and removing it from
 * the note (the attachment stays in the strip).
 *
 * Used by: this file (the right-click, on load).
 * Uses: mediaLayout, applyMediaLayout and placeFloating (history.js),
 * markDirtyFromFormatting (toolbar.js), surfaceOfNode, activeSurface and
 * updateEditorEmpty (lines.js).
 * Complexity: O(1).
 */
function mediaLayoutMenu(el) {
  const current = mediaLayout(el);
  const setWidth = width => {
    if (width) {
      el.setAttribute("data-w", String(width));
    } else {
      el.removeAttribute("data-w");
    }
    if (!width) {
      el.style.width = "";
      el.style.height = "";
    }
    applyMediaLayout(el);
    markDirtyFromFormatting();
  };
  const alignTo = align => {
    if (align) {
      el.setAttribute("data-align", align);
    } else {
      el.removeAttribute("data-align");
    }
    applyMediaLayout(el);
    markDirtyFromFormatting();
  };
  const sizes = [["Small", 160], ["Medium", 320], ["Large", 520], ["Full width", 1000]];

  return [
    {
      label: "Size",
      submenu: () => [
        ...sizes.map(([label, width]) => ({ label, checked: current.w === width, onClick: () => setWidth(width) })),
        { sep: true },
        { label: "Original", checked: !current.w, onClick: () => setWidth(null) },
      ],
    },
    {
      label: "Position",
      submenu: () => [
        {
          label: "Free - drag it anywhere",
          checked: current.fx !== null,
          disabled: current.fx !== null,
          onClick: () => {
            const surface = surfaceOfNode(el) || activeSurface();
            if (surface) {
              placeFloating(el, surface, el.getBoundingClientRect().left, el.getBoundingClientRect().top,
                { dx: 0, dy: 0 });
              markDirtyFromFormatting();
            }
          },
        },
        {
          label: "Back in the text",
          checked: current.fx === null,
          onClick: () => {
            el.removeAttribute("data-fx");
            el.removeAttribute("data-fy");
            applyMediaLayout(el);
            markDirtyFromFormatting();
          },
        },
      ],
    },
    {
      label: "Align in text",
      disabled: current.fx !== null,
      submenu: () => [
        { label: "Left", checked: current.align === "left", onClick: () => alignTo("left") },
        { label: "Center", checked: current.align === "center", onClick: () => alignTo("center") },
        { label: "Right", checked: current.align === "right", onClick: () => alignTo("right") },
        { sep: true },
        { label: "Inline with text", checked: !current.align, onClick: () => alignTo(null) },
      ],
    },
    { sep: true },
    {
      label: "Remove from note",
      danger: true,
      onClick: () => {
        el.remove();
        markDirtyFromFormatting();
        updateEditorEmpty();
      },
    },
  ];
}

// ---------- Selecting and resizing pictures ----------

/**
 * Selects an attachment in the note: it is outlined and gets a resize
 * handle at each corner. Selecting happens on click, never on mousedown:
 * adding the handles changes the very node the user may be about to drag,
 * and changing a drag's source before it starts makes the browser give up
 * the drag, which is why pictures once could not be moved.
 *
 * Used by: this file (a click, on load).
 * Uses: clearMediaSelection, makeElement (sidebar.js).
 * Complexity: O(1).
 */
function selectMedia(el) {
  if (selectedMedia === el) {
    return;
  }
  clearMediaSelection();
  if (!el) {
    return;
  }
  selectedMedia = el;
  el.classList.add("selected");
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const handle = makeElement("span", "media-handle h-" + corner);
    handle.dataset.corner = corner;
    handle.contentEditable = "false";
    el.appendChild(handle);
  }
}

/**
 * Unselects the selected attachment and takes its handles away.
 *
 * Used by: this file, attachments.js (before an attachment is dragged, on load).
 * Uses: nothing.
 * Complexity: O(1).
 */
function clearMediaSelection() {
  if (!selectedMedia) {
    return;
  }
  selectedMedia.classList.remove("selected");
  for (const handle of [...selectedMedia.querySelectorAll(".media-handle")]) {
    handle.remove();
  }
  selectedMedia = null;
}

// ---------- On load: resizing and moving pictures with the mouse ----------

// A press on a handle starts a resize (the handles only exist once something
// is selected, so nothing changes here). A press on a pinned picture starts
// moving it: it follows the pointer and stays wherever it is released.
$("edit-wrap").addEventListener("mousedown", event => {
  const handle = event.target && event.target.classList && event.target.classList.contains("media-handle") ? event.target : null;
  if (handle && selectedMedia) {
    event.preventDefault();
    const box = selectedMedia.getBoundingClientRect();
    resizing = { el: selectedMedia, startX: event.clientX, startW: box.width,
      left: handle.dataset.corner === "nw" || handle.dataset.corner === "sw" };
    return;
  }
  const el = event.target && event.target.nodeType === 1 ? event.target.closest("span.inline-media.floating") : null;
  if (!el || !surfaceOfNode(el) || trashViewId || backupView || syncing) {
    return;
  }
  event.preventDefault();
  const box = el.getBoundingClientRect();
  movingFloat = { el, dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
});

// A click selects the attachment under it, or unselects. The click that ends
// a drag is not a selection.
$("edit-wrap").addEventListener("click", event => {
  if (justDraggedMedia) {
    return;
  }
  const el = event.target && event.target.nodeType === 1 ? event.target.closest("span.inline-media") : null;
  if (el && surfaceOfNode(el) && !trashViewId && !backupView) {
    selectMedia(el);
  } else {
    clearMediaSelection();
  }
});

// A resize changes the width (40 to 2000px, from the corner dragged). A move
// places the item under the pointer, centred on the page when the guide
// snaps; a table follows its grip.
window.addEventListener("mousemove", event => {
  if (resizing) {
    const delta = (event.clientX - resizing.startX) * (resizing.left ? -1 : 1);
    const width = Math.max(40, Math.min(2000, Math.round(resizing.startW + delta)));
    resizing.el.setAttribute("data-w", String(width));
    applyMediaLayout(resizing.el);
    return;
  }
  if (!movingFloat) {
    return;
  }
  const surface = surfaceAtPoint(event.clientX, event.clientY) || surfaceOfNode(movingFloat.el);
  if (!surface) {
    return;
  }
  movingFloat.moved = true;
  if (movingFloat.grip) {
    const page = surface.getBoundingClientRect();
    const box = movingFloat.el.getBoundingClientRect();
    const snapped = showDragGuide(surface, event.clientX - movingFloat.dx + box.width / 2);
    const grab = snapped
      ? { dx: event.clientX - (page.left + page.width / 2 - box.width / 2), dy: movingFloat.dy }
      : { dx: movingFloat.dx, dy: movingFloat.dy };
    placeFloating(movingFloat.el, surface, event.clientX, event.clientY, grab);
    positionGrip();
    return;
  }
  const snap = showDragGuide(surface,
    event.clientX - movingFloat.dx + movingFloat.el.getBoundingClientRect().width / 2);
  let grab = { dx: movingFloat.dx, dy: movingFloat.dy };
  if (snap) {
    const page = surface.getBoundingClientRect();
    const box = movingFloat.el.getBoundingClientRect();
    grab = { dx: event.clientX - (page.left + page.width / 2 - box.width / 2), dy: movingFloat.dy };
  }
  placeFloating(movingFloat.el, surface, event.clientX, event.clientY, grab);
});

// Releasing ends the resize or the move; the note counts as changed.
window.addEventListener("mouseup", () => {
  if (resizing) {
    resizing = null;
    markDirtyFromFormatting();
    return;
  }
  if (!movingFloat) {
    return;
  }
  const moved = movingFloat.moved;
  movingFloat = null;
  hideDragGuide();
  if (moved) {
    markDirtyFromFormatting();
  }
});

// ---------- The table grip and size buttons: state ----------

// The table the grip and buttons are showing for.
let gripTable = null;

// The box holding the size buttons, and the sizing in progress.
let sizeBar = null;
let sizing = null;

// How much a click on a size button adds: to a column's width, to a row's height.
const COL_STEP = 24;
const ROW_STEP = 10;

// ---------- The table grip and size buttons ----------

/**
 * Places the grip at the top left of its table, hidden while the table is
 * scrolled out of the editing area; with no table left, everything is hidden.
 *
 * Used by: this file, tables.js (tableMenuItems, after the table moves).
 * Uses: hideTableGrip.
 * Complexity: O(1).
 */
function positionGrip() {
  if (!gripTable || !gripTable.isConnected) {
    hideTableGrip();
    return;
  }
  const box = gripTable.getBoundingClientRect();
  const area = $("edit-wrap").getBoundingClientRect();
  if (box.bottom < area.top || box.top > area.bottom) {
    tableGrip.style.display = "none";
    return;
  }
  tableGrip.style.display = "flex";
  tableGrip.style.left = Math.round(box.left - 20) + "px";
  tableGrip.style.top = Math.round(box.top - 2) + "px";
}

/**
 * Sets a column's width (24 to 1600px), cell by cell. The first time, every
 * column is fixed at its current width (see materializeColWidths).
 *
 * Used by: this file (the column buttons).
 * Uses: materializeColWidths, colCells, markDirtyFromFormatting (toolbar.js).
 * Complexity: O(r * c) the first time, then O(r).
 */
function setColWidth(table, index, px) {
  materializeColWidths(table);
  const width = Math.max(24, Math.min(1600, Math.round(px)));
  for (const cell of colCells(table, index)) {
    cell.style.width = width + "px";
  }
  markDirtyFromFormatting();
}

/**
 * Sets a row's height (16 to 1200px), cell by cell.
 *
 * Used by: this file (the row buttons).
 * Uses: markDirtyFromFormatting (toolbar.js).
 * Complexity: O(c) in the row's cells.
 */
function setRowHeight(row, px) {
  const height = Math.max(16, Math.min(1200, Math.round(px)));
  for (const cell of row.children) {
    cell.style.height = height + "px";
  }
  markDirtyFromFormatting();
}

/**
 * Makes the size buttons for the grip's table: one above each column (↔)
 * and one left of each row (↕). Reaching for one keeps the set showing, as
 * for the grip.
 *
 * Used by: this file (showTableGrip).
 * Uses: makeElement (sidebar.js), keepChrome, scheduleHideChrome, tableRows, positionSizeHandles.
 * Complexity: O(r + c).
 */
function buildSizeHandles() {
  if (!sizeBar) {
    sizeBar = makeElement("div", "size-bar");
    sizeBar.addEventListener("mouseenter", keepChrome);
    sizeBar.addEventListener("mouseleave", scheduleHideChrome);
    document.body.appendChild(sizeBar);
  }
  sizeBar.innerHTML = "";
  if (!gripTable || !gripTable.isConnected) {
    return;
  }
  const rows = tableRows(gripTable);
  const first = rows[0];
  if (!first) {
    return;
  }
  [...first.children].forEach((cell, i) => {
    const handle = makeElement("button", "size-handle col", "↔");
    handle.type = "button";
    handle.title = "Drag to set this column's width (click to widen)";
    handle.dataset.col = String(i);
    sizeBar.appendChild(handle);
  });
  rows.forEach((row, j) => {
    const handle = makeElement("button", "size-handle row", "↕");
    handle.type = "button";
    handle.title = "Drag to set this row's height (click to make it taller)";
    handle.dataset.row = String(j);
    sizeBar.appendChild(handle);
  });
  positionSizeHandles();
}

/**
 * Places each size button by its column or row, hidden while that part of
 * the table is scrolled out of the editing area.
 *
 * Used by: this file (buildSizeHandles, sizing, scrolling and resizing).
 * Uses: tableRows.
 * Complexity: O(r + c).
 */
function positionSizeHandles() {
  if (!sizeBar || !gripTable || !gripTable.isConnected) {
    return;
  }
  const rows = tableRows(gripTable);
  const first = rows[0];
  if (!first) {
    return;
  }
  const area = $("edit-wrap").getBoundingClientRect();
  for (const handle of sizeBar.children) {
    if (handle.dataset.col !== undefined) {
      const cell = first.children[+handle.dataset.col];
      if (!cell) {
        handle.style.display = "none";
        continue;
      }
      const box = cell.getBoundingClientRect();
      handle.style.display = (box.top - 18 < area.top || box.top > area.bottom) ? "none" : "flex";
      handle.style.left = Math.round(box.left + box.width / 2 - 9) + "px";
      handle.style.top = Math.round(box.top - 20) + "px";
    } else {
      const row = rows[+handle.dataset.row];
      if (!row) {
        handle.style.display = "none";
        continue;
      }
      const box = row.getBoundingClientRect();
      handle.style.display = (box.bottom < area.top || box.top > area.bottom) ? "none" : "flex";
      handle.style.left = Math.round(box.left - 20) + "px";
      handle.style.top = Math.round(box.top + box.height / 2 - 9) + "px";
    }
  }
}

// ---------- On load: the size buttons ----------

// Dragging a size button sizes its column or row as the pointer moves; a
// click with no movement makes it one step bigger.
document.addEventListener("mousedown", event => {
  const handle = event.target && event.target.classList && event.target.classList.contains("size-handle") ? event.target : null;
  if (!handle || !gripTable) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const isCol = handle.dataset.col !== undefined;
  const rows = tableRows(gripTable);
  const cell = isCol ? rows[0].children[+handle.dataset.col] : null;
  const row = isCol ? null : rows[+handle.dataset.row];
  const box = (cell || row).getBoundingClientRect();
  sizing = { table: gripTable, isCol, index: isCol ? +handle.dataset.col : +handle.dataset.row,
    startX: event.clientX, startY: event.clientY, startW: box.width, startH: box.height, tr: row, moved: false };
}, true);

window.addEventListener("mousemove", event => {
  if (!sizing) {
    return;
  }
  const dx = event.clientX - sizing.startX;
  const dy = event.clientY - sizing.startY;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    sizing.moved = true;
  }
  if (!sizing.moved) {
    return;
  }
  if (sizing.isCol) {
    setColWidth(sizing.table, sizing.index, sizing.startW + dx);
  } else {
    setRowHeight(sizing.tr, sizing.startH + dy);
  }
  positionSizeHandles();
  positionGrip();
});

window.addEventListener("mouseup", () => {
  if (!sizing) {
    return;
  }
  if (!sizing.moved) {
    if (sizing.isCol) {
      setColWidth(sizing.table, sizing.index, sizing.startW + COL_STEP);
    } else {
      setRowHeight(sizing.tr, sizing.startH + ROW_STEP);
    }
    positionSizeHandles();
    positionGrip();
  }
  sizing = null;
});

// ---------- Showing and hiding the grip: state ----------

// The grip element, made the first time it is needed.
let tableGrip = null;

// The pending "hide the grip and buttons", or null.
let chromeHideTimer = null;

// ---------- Showing and hiding the grip ----------

/**
 * Shows the grip and size buttons for a table (not in the trash, a backup
 * or during a sync). Dragging the grip pins the table where it already is,
 * so it does not jump, and then moves it like a picture.
 *
 * Used by: this file (the pointer over a table, on load).
 * Uses: buildSizeHandles, makeElement (sidebar.js), surfaceOfNode
 * (lines.js), placeFloating (history.js), keepChrome, scheduleHideChrome, positionGrip.
 * Complexity: O(r + c) when the table changes, else O(1).
 */
function showTableGrip(table) {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const changed = gripTable !== table;
  gripTable = table;
  if (changed) {
    buildSizeHandles();
  }
  if (!tableGrip) {
    tableGrip = makeElement("div", "table-grip", "✥");
    tableGrip.title = "Drag to move this table anywhere on the page";
    tableGrip.addEventListener("mousedown", event => {
      if (!gripTable) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const surface = surfaceOfNode(gripTable);
      if (!surface) {
        return;
      }
      const box = gripTable.getBoundingClientRect();
      if (!gripTable.classList.contains("floating")) {
        placeFloating(gripTable, surface, box.left, box.top, { dx: 0, dy: 0 });
      }
      movingFloat = { el: gripTable, dx: event.clientX - box.left, dy: event.clientY - box.top,
        moved: false, grip: true };
    });
    tableGrip.addEventListener("mouseenter", keepChrome);
    tableGrip.addEventListener("mouseleave", scheduleHideChrome);
    document.body.appendChild(tableGrip);
  }
  positionGrip();
}

/**
 * Hides the grip and the size buttons, never in the middle of a resize.
 *
 * Used by: this file (positionGrip, scheduleHideChrome).
 * Uses: hideSizeHandles.
 * Complexity: O(1).
 */
function hideTableGrip() {
  if (sizing) {
    return;
  }
  gripTable = null;
  if (tableGrip) {
    tableGrip.style.display = "none";
  }
  hideSizeHandles();
}

/**
 * Hides the grip and buttons after 600 ms. They sit outside the table (just
 * above and left of it), so moving towards them leaves the table; hiding at
 * that instant made them vanish before they could be clicked. The pointer
 * reaching them, or coming back to the table, cancels this; so does a drag
 * or resize in progress, or the caret in the table.
 *
 * Used by: this file (leaving a table, the grip or the buttons).
 * Uses: keepChrome, hideTableGrip.
 * Complexity: O(1).
 */
function scheduleHideChrome() {
  keepChrome();
  chromeHideTimer = setTimeout(() => {
    chromeHideTimer = null;
    if (sizing || movingFloat) {
      return;
    }
    if (gripTable && gripTable.contains(document.activeElement)) {
      return;
    }
    hideTableGrip();
  }, 600);
}

// ---------- On load: the grip follows the pointer, the scroll and the window ----------

$("edit-wrap").addEventListener("mouseover", event => {
  const table = event.target && event.target.closest ? event.target.closest("table") : null;
  if (table && surfaceOfNode(table)) {
    keepChrome();
    showTableGrip(table);
  } else {
    scheduleHideChrome();
  }
});
$("edit-wrap").addEventListener("mouseleave", scheduleHideChrome);
$("edit-wrap").addEventListener("scroll", repositionTableChrome, true);
window.addEventListener("resize", repositionTableChrome);

// ---------- The centre guide ----------

// The guide line, while shown, and how near the centre counts as on it.
let dragGuide = null;
const SNAP_PX = 28;

/**
 * Shows a vertical line at the centre of the page while something is
 * dragged, and returns whether x is within 28px of it, where releasing
 * centres the item instead of dropping it mid-sentence.
 *
 * Used by: this file (moving a pinned item), attachments.js (dragging an attachment, on load).
 * Uses: makeElement (sidebar.js).
 * Complexity: O(1).
 */
function showDragGuide(surface, x) {
  const box = surface.getBoundingClientRect();
  const middle = box.left + box.width / 2;
  const near = Math.abs(x - middle) <= SNAP_PX;
  if (!dragGuide) {
    dragGuide = makeElement("div", "drag-guide");
    document.body.appendChild(dragGuide);
  }
  dragGuide.style.left = Math.round(middle) + "px";
  dragGuide.style.top = Math.round(box.top) + "px";
  dragGuide.style.height = Math.round(box.height) + "px";
  dragGuide.classList.toggle("snap", near);
  return near;
}

/**
 * Takes the centre guide away.
 *
 * Used by: this file (releasing a pinned item), attachments.js (the end of a drag, on load).
 * Uses: nothing.
 * Complexity: O(1).
 */
function hideDragGuide() {
  if (dragGuide) {
    dragGuide.remove();
    dragGuide = null;
  }
}

// ---------- On load: right-clicking an attachment ----------

$("edit-wrap").addEventListener("contextmenu", event => {
  const el = event.target && event.target.nodeType === 1 ? event.target.closest("span.inline-media") : null;
  if (!el || !surfaceOfNode(el) || trashViewId || backupView || syncing) {
    return;
  }
  event.preventDefault();
  openMenu(event.clientX, event.clientY, mediaLayoutMenu(el));
});

// =================== Auxiliary functions ===================

/** A table's rows. Complexity: O(r). */
function tableRows(table) {
  return [...table.querySelectorAll("tr")];
}

/** The cells of column i, one per row that has it. Complexity: O(r). */
function colCells(table, i) {
  return tableRows(table).map(row => row.children[i]).filter(Boolean);
}

/**
 * Fixes every column at its current width, unless all already have one in
 * px. A fixed layout only keeps widths it has been given: setting one
 * column of a table never sized before made the browser share the rest of
 * the space out again, so the other columns jumped. Complexity: O(r * c).
 */
function materializeColWidths(table) {
  const first = tableRows(table)[0];
  if (!first) {
    return;
  }
  if ([...first.children].every(cell => /\d+px/.test(cell.style.width || ""))) {
    return;
  }
  const widths = [...first.children].map(cell => Math.round(cell.getBoundingClientRect().width));
  widths.forEach((width, i) => {
    for (const cell of colCells(table, i)) {
      cell.style.width = Math.max(24, width) + "px";
    }
  });
}

/** Takes the size buttons away. Complexity: O(1). */
function hideSizeHandles() {
  if (sizeBar) {
    sizeBar.innerHTML = "";
  }
}

/** Cancels a pending hide of the grip and buttons. Complexity: O(1). */
function keepChrome() {
  if (chromeHideTimer) {
    clearTimeout(chromeHideTimer);
    chromeHideTimer = null;
  }
}

/** Places the grip and the size buttons again (after a scroll or a resize). Complexity: O(r + c). */
function repositionTableChrome() {
  positionGrip();
  positionSizeHandles();
}
