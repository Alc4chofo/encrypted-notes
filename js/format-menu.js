// notes: The right-click formatting menu for selected text.
"use strict";

// ---------- Right-click on selected text ----------
// Right-clicking inside a selection opens the formatting menu: the toolbar's
// commands, where the pointer already is. With no selection, a click outside
// it, or Shift held, the browser's own menu stays (spelling suggestions and
// Paste live there). Whether the click was inside the selection is decided as
// the button goes down, before the browser can move the caret.
let ctxDown = null;   // the right-click in progress: { inside, range }
const IS_MAC = /Mac/i.test(navigator.platform || "");
$("edit-wrap").addEventListener("mousedown", e => {
  ctxDown = null;
  if (e.button !== 2 && !(IS_MAC && e.button === 0 && e.ctrlKey)) return;   // Ctrl+click is the Mac's right-click
  ctxDown = { inside: false, range: null };
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  if (!surfaceOfNode(r.commonAncestorContainer)) return;
  const x = e.clientX, y = e.clientY;
  if ([...r.getClientRects()].some(b => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1))
    ctxDown = { inside: true, range: r.cloneRange() };
}, true);
// The menu key (or Shift+F10) comes with no button press: it uses the selection as it is.
document.addEventListener("keydown", () => { ctxDown = null; }, true);
// The selection the menu is for, or null where the browser's menu belongs.
function formatMenuTarget(e) {
  if (e.shiftKey || trashViewId || backupView || syncing) return null;
  const t = e.target && e.target.nodeType === 1 ? e.target : null;
  if (t && t.closest("span.inline-media")) return null;   // a picture keeps its own menu
  let r = null;
  if (ctxDown) r = ctxDown.inside ? ctxDown.range : null;
  else { const sel = window.getSelection(); if (sel.rangeCount && !sel.isCollapsed) r = sel.getRangeAt(0); }
  const surf = r && surfaceOfNode(r.commonAncestorContainer);
  return surf && surf.isContentEditable ? { r, surf, mouse: !!ctxDown } : null;
}
$("edit-wrap").addEventListener("contextmenu", e => {
  const t = formatMenuTarget(e);
  ctxDown = null;
  if (!t) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // The selection the menu was opened on, should the browser have moved it.
  const sel = window.getSelection();
  const cur = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!cur || cur.compareBoundaryPoints(Range.START_TO_START, t.r) || cur.compareBoundaryPoints(Range.END_TO_END, t.r)) {
    sel.removeAllRanges();
    sel.addRange(t.r);
  }
  rememberSelection();
  let x = e.clientX, y = e.clientY;
  if (!t.mouse) { const b = t.r.getBoundingClientRect(); x = b.left; y = b.bottom; }
  openMenu(x, y, formatMenuItems(t.surf, tableCellOf(t.r.commonAncestorContainer)));
}, true);
// Cut and Copy from the menu run the same handlers as Ctrl+X and Ctrl+C, so
// censored text leaves as blocks here too.
function clipboardCommand(cmd) {
  if (!restoreSelection()) return;
  let ok = false;
  try { ok = document.execCommand(cmd); } catch {}
  if (!ok) status(`The browser did not allow ${cmd === "cut" ? "Cut" : "Copy"} from the menu: use Ctrl+${cmd === "cut" ? "X" : "C"}`, true);
}
// Ticks show what the selection already has; every command is the toolbar's own.
function formatMenuItems(surf, cell) {
  const r = currentEditorRange();
  const on = cmd => { try { return !!document.queryCommandState(cmd); } catch { return false; } };
  const { fam, size } = r ? fontAt(r, surf) : { fam: "Default", size: "" };
  const align = r ? caretAlign(r, surf) : "left";
  // The palette opens beside the row that was clicked.
  const besideRow = () => ({ getBoundingClientRect: () => lastMenuRowRect });
  const items = [
    { label: "Cut", kbd: "Ctrl+X", mark: false, onClick: () => clipboardCommand("cut") },
    { label: "Copy", kbd: "Ctrl+C", mark: false, onClick: () => clipboardCommand("copy") },
    { sep: true },
    { label: "Bold", kbd: "Ctrl+B", mark: on("bold"), onClick: () => runFmt("bold") },
    { label: "Italic", kbd: "Ctrl+I", mark: on("italic"), onClick: () => runFmt("italic") },
    { label: "Underline", kbd: "Ctrl+U", mark: on("underline"), onClick: () => runFmt("underline") },
    { label: "Strikethrough", mark: on("strikeThrough"), onClick: () => runFmt("strikeThrough") },
    { label: "Censor", mark: !!r && censorStateAt(r, surf), onClick: toggleCensor },
    { sep: true },
    { label: "Font", mark: false, submenu: () => FONT_CHOICES.map(f =>
      ({ label: f, font: f === "Default" ? null : f, mark: f === fam, onClick: () => applyFontName(f) })) },
    { label: "Size", mark: false, submenu: () => SIZE_CHOICES.map(v => ({ label: v, mark: v === size, onClick: () => applyFontSize(v) })) },
    { label: "Text colour...", mark: false, onClick: () => openPalette(besideRow(), "fore", "right") },
    { label: "Highlight...", mark: false, onClick: () => openPalette(besideRow(), "back", "right") },
    { sep: true },
    { label: "Align", mark: false, submenu: () => [["left", "Left"], ["center", "Center"], ["right", "Right"], ["justify", "Justify"]]
      .map(([a, l]) => ({ label: l, mark: align === a, onClick: () => applyAlignment(a) })) },
    { label: "Link...", mark: false, onClick: () => $("fmt-link").click() },
    { label: "Clear formatting", mark: false, onClick: clearFormatting },
  ];
  if (cell) items.push({ sep: true }, { label: "Table", mark: false, submenu: () => tableMenuItems(cell) });
  items.push({ sep: true }, { hint: "Shift+right-click: the browser's menu" });
  return items;
}
