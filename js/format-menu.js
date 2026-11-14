/*
 * format-menu.js - the right-click formatting menu for selected text.
 *
 * Right-clicking inside a selection opens the toolbar's commands where the
 * pointer already is. With no selection, a click outside it, or Shift held,
 * the browser's own menu stays (spelling suggestions and Paste live there).
 * Whether the click was inside the selection is decided as the button goes
 * down, before the browser can move the caret.
 *
 * Main functions: formatMenuTarget, formatMenuItems, clipboardCommand.
 * Auxiliary functions: none.
 *
 * Complexity: O(r) in the rectangles of the selection when the button goes
 * down; building the menu is O(1) (its submenus are built when they open).
 */
"use strict";

// ---------- State ----------

// The right-click in progress: { inside, range }, or null.
let contextMenuDown = null;

// On a Mac, Ctrl+click is the right-click.
const IS_MAC = /Mac/i.test(navigator.platform || "");

// ---------- On load: noting where the right-click went down ----------

$("edit-wrap").addEventListener("mousedown", event => {
  contextMenuDown = null;
  if (event.button !== 2 && !(IS_MAC && event.button === 0 && event.ctrlKey)) {
    return;
  }
  contextMenuDown = { inside: false, range: null };
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (!surfaceOfNode(range.commonAncestorContainer)) {
    return;
  }
  const x = event.clientX;
  const y = event.clientY;
  if ([...range.getClientRects()]
    .some(box => x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1)) {
    contextMenuDown = { inside: true, range: range.cloneRange() };
  }
}, true);

// The menu key (or Shift+F10) comes with no button press: it uses the selection as it is.
document.addEventListener("keydown", () => {
  contextMenuDown = null;
}, true);

// ---------- The menu ----------

/**
 * The selection a right-click's formatting menu is for, as { r, surf, mouse },
 * or null where the browser's menu belongs: Shift held, a trash item or a
 * backup on screen, a sync running, a click on a picture (it has its own
 * menu), or no selection under the click.
 *
 * Used by: this file (the right-click), tables.js (a table cell's menu stands
 * aside when there is a selection).
 * Uses: surfaceOfNode (lines.js).
 * Complexity: O(1).
 */
function formatMenuTarget(event) {
  if (event.shiftKey || trashViewId || backupView || syncing) {
    return null;
  }
  const target = event.target && event.target.nodeType === 1 ? event.target : null;
  if (target && target.closest("span.inline-media")) {
    return null;
  }

  let range = null;
  if (contextMenuDown) {
    range = contextMenuDown.inside ? contextMenuDown.range : null;
  } else {
    const selection = window.getSelection();
    if (selection.rangeCount && !selection.isCollapsed) {
      range = selection.getRangeAt(0);
    }
  }
  const surface = range && surfaceOfNode(range.commonAncestorContainer);
  return surface && surface.isContentEditable ? { r: range, surf: surface, mouse: !!contextMenuDown } : null;
}

/**
 * The formatting menu's items. Ticks show what the selection already has;
 * every command is the toolbar's own: cut, copy, bold, italic, underline,
 * strikethrough, censor, font, size, text colour, highlight, alignment, link
 * and clear formatting, and inside a table the table's own commands.
 *
 * Used by: this file (the right-click).
 * Uses: currentEditorRange (lines.js), fontAt, runFormat, applyFontName,
 * applyFontSize and openPalette (toolbar.js), caretAlign and applyAlignment
 * (alignment.js), censorStateAt, toggleCensor and clearFormatting (censor.js),
 * FONT_CHOICES and SIZE_CHOICES (designs.js), lastMenuRowRect (menu.js),
 * tableMenuItems (tables.js), clipboardCommand.
 * Complexity: O(1).
 */
function formatMenuItems(surface, cell) {
  const range = currentEditorRange();
  const on = command => {
    try {
      return !!document.queryCommandState(command);
    } catch {
      return false;
    }
  };
  const { fam, size } = range ? fontAt(range, surface) : { fam: "Default", size: "" };
  const align = range ? caretAlign(range, surface) : "left";
  // The palette opens beside the row that was clicked.
  const besideRow = () => ({ getBoundingClientRect: () => lastMenuRowRect });

  const items = [
    { label: "Cut", kbd: "Ctrl+X", mark: false, onClick: () => clipboardCommand("cut") },
    { label: "Copy", kbd: "Ctrl+C", mark: false, onClick: () => clipboardCommand("copy") },
    { sep: true },
    { label: "Bold", kbd: "Ctrl+B", mark: on("bold"), onClick: () => runFormat("bold") },
    { label: "Italic", kbd: "Ctrl+I", mark: on("italic"), onClick: () => runFormat("italic") },
    { label: "Underline", kbd: "Ctrl+U", mark: on("underline"), onClick: () => runFormat("underline") },
    { label: "Strikethrough", mark: on("strikeThrough"), onClick: () => runFormat("strikeThrough") },
    { label: "Censor", mark: !!range && censorStateAt(range, surface), onClick: toggleCensor },
    { sep: true },
    {
      label: "Font",
      mark: false,
      submenu: () => FONT_CHOICES.map(font => ({
        label: font,
        font: font === "Default" ? null : font,
        mark: font === fam,
        onClick: () => applyFontName(font),
      })),
    },
    {
      label: "Size",
      mark: false,
      submenu: () => SIZE_CHOICES.map(value => ({
        label: value,
        mark: value === size,
        onClick: () => applyFontSize(value),
      })),
    },
    { label: "Text colour...", mark: false, onClick: () => openPalette(besideRow(), "fore", "right") },
    { label: "Highlight...", mark: false, onClick: () => openPalette(besideRow(), "back", "right") },
    { sep: true },
    {
      label: "Align",
      mark: false,
      submenu: () => [["left", "Left"], ["center", "Center"], ["right", "Right"], ["justify", "Justify"]]
        .map(([value, label]) => ({ label, mark: align === value, onClick: () => applyAlignment(value) })),
    },
    { label: "Link...", mark: false, onClick: () => $("fmt-link").click() },
    { label: "Clear formatting", mark: false, onClick: clearFormatting },
  ];
  if (cell) {
    items.push({ sep: true }, { label: "Table", mark: false, submenu: () => tableMenuItems(cell) });
  }
  items.push({ sep: true }, { hint: "Shift+right-click: the browser's menu" });
  return items;
}

/**
 * Cut or Copy from the menu. They run the same handlers as Ctrl+X and
 * Ctrl+C, so censored text leaves as blocks here too. When the browser
 * refuses a scripted cut or copy, the status line says to use the keys.
 *
 * Used by: formatMenuItems in this file.
 * Uses: restoreSelection (toolbar.js), status (pagination.js).
 * Complexity: O(n) in the selection, through the copy handler.
 */
function clipboardCommand(command) {
  if (!restoreSelection()) {
    return;
  }
  let ok = false;
  try {
    ok = document.execCommand(command);
  } catch {}
  if (!ok) {
    status(`The browser did not allow ${command === "cut" ? "Cut" : "Copy"} from the menu: use Ctrl+${command === "cut" ? "X" : "C"}`, true);
  }
}

// ---------- On load: the right-click itself ----------

$("edit-wrap").addEventListener("contextmenu", event => {
  const target = formatMenuTarget(event);
  contextMenuDown = null;
  if (!target) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();

  // Put back the selection the menu was opened on, should the browser have moved it.
  const selection = window.getSelection();
  const current = selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!current || current.compareBoundaryPoints(Range.START_TO_START, target.r) ||
      current.compareBoundaryPoints(Range.END_TO_END, target.r)) {
    selection.removeAllRanges();
    selection.addRange(target.r);
  }
  rememberSelection();

  let x = event.clientX;
  let y = event.clientY;
  if (!target.mouse) {
    const box = target.r.getBoundingClientRect();
    x = box.left;
    y = box.bottom;
  }
  openMenu(x, y, formatMenuItems(target.surf, tableCellOf(target.r.commonAncestorContainer)));
}, true);

// =================== Auxiliary functions ===================
// None: every function above carries out one of this file's purposes.
