/*
 * tables.js - tables: inserting one, and the menu of things to do to one.
 *
 * The table button inserts a table (asking for "rows x columns"), or, with the
 * caret in a table, opens the table's menu: rows and columns, the header row,
 * cell alignment, and whether it sits in the text or floats freely.
 * Right-clicking a cell opens the same menu.
 *
 * Main functions: insertTable, tableMenuItems.
 * Auxiliary functions: tableCellOf, currentCell, buildTable.
 *
 * Complexity: building a table is O(r * c) in its cells; adding or removing
 * a column is O(r) over its rows.
 */
"use strict";

// ---------- Tables ----------

/**
 * Asks for a size ("3x3" by default, at most 50 rows and 20 columns) and
 * inserts a table with a header row at the caret. A table is a block of its
 * own: it goes between lines, never inside one, so the line is cut at the
 * caret and what followed continues under the table. In a table cell or a
 * list item it nests where the caret is, with an empty line after it so you
 * can type past it. The caret ends in the first cell.
 *
 * Used by: this file (the table button, with the caret outside a table).
 * Uses: restoreSelection and markDirtyFromFormatting (toolbar.js),
 * activeSurface, ensureLines and lineOf (lines.js), status (pagination.js),
 * promptModal (modal.js), buildTable, atomsOf (atoms.js).
 * Complexity: O(r * c).
 */
async function insertTable() {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const surface = restoreSelection() || activeSurface();
  if (!surface) {
    status("Put the cursor in the text first", true);
    return;
  }
  const spec = await promptModal({ title: "Insert table", placeholder: "rows x columns", value: "3x3", confirmLabel: "Insert" });
  if (!spec) {
    return;
  }
  const match = /^\s*(\d{1,2})\s*[x×,\s]\s*(\d{1,2})\s*$/i.exec(spec);
  if (!match) {
    status('Use "rows x columns", for example 3x4', true);
    return;
  }
  const rows = Math.min(50, Math.max(1, +match[1]));
  const cols = Math.min(20, Math.max(1, +match[2]));
  const table = buildTable(rows, cols, true);

  const host = restoreSelection();
  if (host) {
    ensureLines(host);
  }
  const range = host ? window.getSelection().getRangeAt(0) : null;
  const line = range ? lineOf(range.startContainer, host) : null;

  if (line) {
    range.collapse(false);
    const head = document.createRange();
    head.setStart(line, 0);
    head.setEnd(range.startContainer, range.startOffset);
    if (!head.toString().trim() && !head.cloneContents().querySelector(".inline-media")) {
      line.before(table);
    } else {
      const tail = document.createRange();
      tail.setStart(range.startContainer, range.startOffset);
      tail.setEnd(line, line.childNodes.length);
      const rest = line.cloneNode(false);
      rest.appendChild(tail.extractContents());
      if (!atomsOf(rest).length) {
        rest.replaceChildren(document.createElement("br"));
      }
      line.after(table);
      table.after(rest);
    }
  } else {
    if (range) {
      range.collapse(false);
      range.insertNode(table);
    } else {
      surface.appendChild(table);
    }
    const after = document.createElement("div");
    after.appendChild(document.createElement("br"));
    table.after(after);
  }

  const first = table.querySelector("th,td");
  if (first) {
    const caret = document.createRange();
    caret.setStart(first, 0);
    caret.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
  }
  markDirtyFromFormatting();
}

/**
 * The table menu for a cell: insert rows above or below and columns left or
 * right (new cells keep their column's width), delete the row, the column or
 * the whole table, turn the header row on or off, align the cell, and choose
 * whether the table floats freely or sits back in the text.
 *
 * Used by: this file (the table button and right-clicking a cell),
 * format-menu.js (Table, in the formatting menu).
 * Uses: markDirtyFromFormatting (toolbar.js), surfaceOfNode and
 * activeSurface (lines.js), placeFloating and applyMediaLayout (history.js),
 * positionGrip (media-layout.js).
 * Complexity: O(1) to build; inserting or deleting a column is O(r).
 */
function tableMenuItems(cell) {
  const row = cell.parentElement;
  const table = cell.closest("table");
  const rowsOf = () => [...table.querySelectorAll("tr")];
  const colIndex = [...row.children].indexOf(cell);
  const makeCell = like => {
    const newCell = document.createElement(like.tagName.toLowerCase());
    // Keep the column's width.
    if (like.style && like.style.width) {
      newCell.style.width = like.style.width;
    }
    newCell.appendChild(document.createElement("br"));
    return newCell;
  };
  const insertRow = below => {
    const newRow = document.createElement("tr");
    for (const existing of row.children) {
      newRow.appendChild(makeCell(existing));
    }
    row.parentElement.insertBefore(newRow, below ? row.nextSibling : row);
    markDirtyFromFormatting();
  };
  const insertCol = right => {
    for (const each of rowsOf()) {
      const reference = each.children[colIndex];
      const newCell = makeCell(reference || each.children[0] || cell);
      each.insertBefore(newCell, right ? (reference ? reference.nextSibling : null) : reference || null);
    }
    markDirtyFromFormatting();
  };

  return [
    { label: "Insert row above", onClick: () => insertRow(false) },
    { label: "Insert row below", onClick: () => insertRow(true) },
    { label: "Insert column left", onClick: () => insertCol(false) },
    { label: "Insert column right", onClick: () => insertCol(true) },
    { sep: true },
    {
      label: "Delete row",
      danger: true,
      disabled: rowsOf().length < 2,
      onClick: () => {
        row.remove();
        markDirtyFromFormatting();
      },
    },
    {
      label: "Delete column",
      danger: true,
      disabled: row.children.length < 2,
      onClick: () => {
        for (const each of rowsOf()) {
          const target = each.children[colIndex];
          if (target) {
            target.remove();
          }
        }
        markDirtyFromFormatting();
      },
    },
    {
      label: "Delete table",
      danger: true,
      onClick: () => {
        table.remove();
        markDirtyFromFormatting();
      },
    },
    { sep: true },
    {
      label: (table.querySelector("th") ? "Remove" : "Use") + " header row",
      onClick: () => {
        const first = table.querySelector("tr");
        if (!first) {
          return;
        }
        const toHeader = !table.querySelector("th");
        for (const existing of [...first.children]) {
          const replacement = document.createElement(toHeader ? "th" : "td");
          while (existing.firstChild) {
            replacement.appendChild(existing.firstChild);
          }
          existing.replaceWith(replacement);
        }
        markDirtyFromFormatting();
      },
    },
    {
      label: "Cell alignment",
      submenu: () => ["left", "center", "right"].map(align => ({
        label: align[0].toUpperCase() + align.slice(1),
        onClick: () => {
          cell.style.textAlign = align;
          markDirtyFromFormatting();
        },
      })),
    },
    {
      label: "Position",
      submenu: () => [
        {
          label: "Free - drag it anywhere",
          checked: table.classList.contains("floating"),
          onClick: () => {
            const surface = surfaceOfNode(table) || activeSurface();
            const box = table.getBoundingClientRect();
            if (surface && placeFloating(table, surface, box.left, box.top, { dx: 0, dy: 0 })) {
              positionGrip();
              markDirtyFromFormatting();
            }
          },
        },
        {
          label: "Back in the text",
          checked: !table.classList.contains("floating"),
          onClick: () => {
            table.removeAttribute("data-fx");
            table.removeAttribute("data-fy");
            applyMediaLayout(table);
            positionGrip();
            markDirtyFromFormatting();
          },
        },
      ],
    },
  ];
}

// ---------- On load: the table button and right-clicks in a table ----------

$("fmt-table").addEventListener("mousedown", event => {
  event.preventDefault();
  rememberSelection();
});
$("fmt-table").onclick = () => {
  const cell = currentCell();
  const box = $("fmt-table").getBoundingClientRect();
  if (cell) {
    openMenu(box.left, box.bottom + 2, tableMenuItems(cell));
  } else {
    insertTable();
  }
};

// Right-clicking inside a table gives the same commands where the cursor is.
// Right-clicking selected text gets the formatting menu instead, which has
// them under Table.
$("edit-wrap").addEventListener("contextmenu", event => {
  const cell = tableCellOf(event.target);
  if (!cell || !surfaceOfNode(cell) || trashViewId || backupView || syncing || formatMenuTarget(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  openMenu(event.clientX, event.clientY, tableMenuItems(cell));
}, true);

// =================== Auxiliary functions ===================

/** The table cell a node sits in, or null. Also used by format-menu.js. Complexity: O(depth). */
function tableCellOf(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el && el.closest ? el.closest("td,th") : null;
}

/** The cell the caret (or the last remembered selection) is in, or null. Complexity: O(depth). */
function currentCell() {
  const range = currentEditorRange() || lastFormatRange;
  return range ? tableCellOf(range.commonAncestorContainer) : null;
}

/**
 * A new table of rows by cols, with a header row when asked. Each cell starts
 * 150px wide (a sensible size, each column resizable on its own) and holds a
 * line break, so an empty cell can still be clicked. Complexity: O(r * c).
 */
function buildTable(rows, cols, header) {
  const table = document.createElement("table");
  const body = document.createElement("tbody");
  for (let i = 0; i < rows; i++) {
    const row = document.createElement("tr");
    for (let j = 0; j < cols; j++) {
      const cell = document.createElement(header && i === 0 ? "th" : "td");
      cell.style.width = "150px";
      cell.appendChild(document.createElement("br"));
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.appendChild(body);
  return table;
}
