// notes: Tables: inserting them and their menu.
"use strict";

// ---------- Tables ----------
const tableCellOf = node => {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el && el.closest ? el.closest("td,th") : null;
};
function currentCell() {
  const r = currentEditorRange() || lastFmtRange;
  return r ? tableCellOf(r.commonAncestorContainer) : null;
}
function buildTable(rows, cols, header) {
  const t = document.createElement("table");
  const tb = document.createElement("tbody");
  for (let i = 0; i < rows; i++) {
    const tr = document.createElement("tr");
    for (let j = 0; j < cols; j++) {
      const cell = document.createElement(header && i === 0 ? "th" : "td");
      // A real starting width, so the table is a sensible size from the start
      // and each column can be resized on its own.
      cell.style.width = "150px";
      cell.appendChild(document.createElement("br"));   // keeps the cell clickable when empty
      tr.appendChild(cell);
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return t;
}
async function insertTable() {
  if (trashViewId || backupView || syncing) return;
  const surf = restoreSelection() || activeSurface();
  if (!surf) { status("Put the cursor in the text first", true); return; }
  const spec = await promptModal({ title: "Insert table", placeholder: "rows x columns",
    value: "3x3", confirmLabel: "Insert" });
  if (!spec) return;
  const m = /^\s*(\d{1,2})\s*[x×,\s]\s*(\d{1,2})\s*$/i.exec(spec);
  if (!m) { status('Use "rows x columns", for example 3x4', true); return; }
  const rows = Math.min(50, Math.max(1, +m[1])), cols = Math.min(20, Math.max(1, +m[2]));
  const t = buildTable(rows, cols, true);
  const host = restoreSelection();
  if (host) ensureLines(host);
  const r = host ? window.getSelection().getRangeAt(0) : null;
  const line = r ? lineOf(r.startContainer, host) : null;
  if (line) {
    // A table is a block of its own: it goes between lines, never inside one.
    // The line is cut at the caret and what followed it continues under the table.
    r.collapse(false);
    const head = document.createRange();
    head.setStart(line, 0);
    head.setEnd(r.startContainer, r.startOffset);
    if (!head.toString().trim() && !head.cloneContents().querySelector(".inline-media")) line.before(t);
    else {
      const tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset);
      tail.setEnd(line, line.childNodes.length);
      const rest = line.cloneNode(false);
      rest.appendChild(tail.extractContents());
      if (!atomsOf(rest).length) rest.replaceChildren(document.createElement("br"));
      line.after(t);
      t.after(rest);
    }
  } else {
    // In a table cell or a list item the table nests where the caret is.
    if (r) { r.collapse(false); r.insertNode(t); }
    else surf.appendChild(t);
    // A trailing line after the table, or there is no way to type past it.
    const after = document.createElement("div");
    after.appendChild(document.createElement("br"));
    t.after(after);
  }
  const first = t.querySelector("th,td");
  if (first) {
    const nr = document.createRange();
    nr.setStart(first, 0); nr.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(nr);
  }
  markDirtyFromFormatting();
}
// The operations Google Docs offers on a table, driven from the cell the caret
// is in.
function tableMenuItems(cell) {
  const tr = cell.parentElement, table = cell.closest("table");
  const rowsOf = () => [...table.querySelectorAll("tr")];
  const colIndex = [...tr.children].indexOf(cell);
  const mkCell = like => {
    const c = document.createElement(like.tagName.toLowerCase());
    if (like.style && like.style.width) c.style.width = like.style.width;   // keep the column's width
    c.appendChild(document.createElement("br"));
    return c;
  };
  const insertRow = below => {
    const nr = document.createElement("tr");
    for (const c of tr.children) nr.appendChild(mkCell(c));
    tr.parentElement.insertBefore(nr, below ? tr.nextSibling : tr);
    markDirtyFromFormatting();
  };
  const insertCol = right => {
    for (const row of rowsOf()) {
      const ref = row.children[colIndex];
      const c = mkCell(ref || row.children[0] || cell);
      row.insertBefore(c, right ? (ref ? ref.nextSibling : null) : ref || null);
    }
    markDirtyFromFormatting();
  };
  return [
    { label: "Insert row above", onClick: () => insertRow(false) },
    { label: "Insert row below", onClick: () => insertRow(true) },
    { label: "Insert column left", onClick: () => insertCol(false) },
    { label: "Insert column right", onClick: () => insertCol(true) },
    { sep: true },
    { label: "Delete row", danger: true, disabled: rowsOf().length < 2, onClick: () => {
      tr.remove(); markDirtyFromFormatting(); } },
    { label: "Delete column", danger: true, disabled: tr.children.length < 2, onClick: () => {
      for (const row of rowsOf()) { const c = row.children[colIndex]; if (c) c.remove(); }
      markDirtyFromFormatting(); } },
    { label: "Delete table", danger: true, onClick: () => { table.remove(); markDirtyFromFormatting(); } },
    { sep: true },
    { label: (table.querySelector("th") ? "Remove" : "Use") + " header row", onClick: () => {
      const first = table.querySelector("tr");
      if (!first) return;
      const toHeader = !table.querySelector("th");
      for (const c of [...first.children]) {
        const n = document.createElement(toHeader ? "th" : "td");
        while (c.firstChild) n.appendChild(c.firstChild);
        c.replaceWith(n);
      }
      markDirtyFromFormatting();
    } },
    { label: "Cell alignment", submenu: () => ["left", "center", "right"].map(a => ({
      label: a[0].toUpperCase() + a.slice(1),
      onClick: () => { cell.style.textAlign = a; markDirtyFromFormatting(); },
    })) },
    { label: "Position", submenu: () => [
      { label: "Free - drag it anywhere", checked: table.classList.contains("floating"),
        onClick: () => {
          const surf = surfaceOfNode(table) || activeSurface();
          const r = table.getBoundingClientRect();
          if (surf && placeFloating(table, surf, r.left, r.top, { dx: 0, dy: 0 })) {
            positionGrip();
            markDirtyFromFormatting();
          }
        } },
      { label: "Back in the text", checked: !table.classList.contains("floating"),
        onClick: () => {
          table.removeAttribute("data-fx"); table.removeAttribute("data-fy");
          applyMediaLayout(table);
          positionGrip();
          markDirtyFromFormatting();
        } },
    ] },
  ];
}
$("fmt-table").addEventListener("mousedown", e => { e.preventDefault(); rememberSelection(); });
$("fmt-table").onclick = () => {
  const cell = currentCell();
  const r = $("fmt-table").getBoundingClientRect();
  if (cell) openMenu(r.left, r.bottom + 2, tableMenuItems(cell));
  else insertTable();
};
// Right-clicking inside a table gives the same operations where the cursor is.
// (Right-clicking selected text gets the formatting menu instead, which has
// these under Table.)
$("edit-wrap").addEventListener("contextmenu", e => {
  const cell = tableCellOf(e.target);
  if (!cell || !surfaceOfNode(cell) || trashViewId || backupView || syncing || formatMenuTarget(e)) return;
  e.preventDefault();
  e.stopPropagation();
  openMenu(e.clientX, e.clientY, tableMenuItems(cell));
}, true);
