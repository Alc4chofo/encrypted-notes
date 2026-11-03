// notes: Paragraph alignment.
"use strict";

// ---------- Alignment ----------
// Alignment belongs to PARAGRAPHS, and a paragraph here is a run of lines with
// no empty line between them: pressing Enter twice is what starts a new one.
// The buttons align the paragraph the caret is in (every paragraph a selection
// touches). On an empty line they align that line and the lines after it, never
// the paragraph above, so an empty line under a centred paragraph is where a
// differently aligned one can start. Enter keeps the alignment of the line it
// splits; Enter on an empty line starts the next paragraph at the default.
// Lines the user aligned while still empty: Enter on one keeps its alignment
// (that is what the user just chose for what comes next) instead of resetting.
let alignedEmpty = new WeakSet();
const alignOf = el => {
  const a = getComputedStyle(el).textAlign;
  return a === "center" || a === "-webkit-center" ? "center"
    : a === "right" || a === "end" || a === "-webkit-right" ? "right" : a === "justify" ? "justify" : "left";
};
// What alignment applies to at a node: its line, or failing that the list item,
// the table cell or the frame it is in.
function alignBlockOf(node, surf) {
  for (let n = node && (node.nodeType === 1 ? node : node.parentNode); n && n !== surf; n = n.parentNode)
    if (isLineEl(n) || isFrameEl(n) || n.tagName === "LI" || n.tagName === "TD" || n.tagName === "TH") return n;
  return null;
}
function caretAlign(r, surf) {
  const b = alignBlockOf(r.startContainer, surf);
  return alignOf(b || surf);
}
const isParaLine = n => isLineEl(n) || (!!n && n.nodeType === 1 && n.tagName === "LI");
// The neighbouring line of the same kind, looking past pinned items (they sit
// outside the text flow); null at anything else.
function siblingLine(n, dir) {
  for (let s = n[dir]; s; s = s[dir]) {
    if (isFloatEl(s) || isSelMarker(s) || (s.nodeType === 3 && !s.data)) continue;
    return isParaLine(s) && (s.tagName === "LI") === (n.tagName === "LI") ? s : null;
  }
  return null;
}
// Does the range only touch the very start of block b (a drag that ends at the
// start of the next line selects nothing on it)?
function endsAtStartOf(r, b) {
  if (!b.contains(r.endContainer) || b.contains(r.startContainer)) return false;
  const t = document.createRange();
  t.setStart(b, 0);
  t.setEnd(r.endContainer, r.endOffset);
  return t.toString() === "" && !t.cloneContents().querySelector(".inline-media");
}
function alignTargets(r, surf) {
  let blocks = [];
  if (r.collapsed) { const b = alignBlockOf(r.startContainer, surf); if (b) blocks.push(b); }
  else for (const b of surf.querySelectorAll("div, p, li, td, th")) {
    if (alignBlockOf(b, surf) !== b || !r.intersectsNode(b) || endsAtStartOf(r, b)) continue;
    // A cell or frame holding lines is aligned through its lines.
    if (!isParaLine(b) && b.querySelector("div, p, li")) continue;
    blocks.push(b);
  }
  const out = new Set();
  for (const b of blocks) {
    if (!isParaLine(b)) { out.add(b); continue; }
    if (isEmptyLine(b)) {
      out.add(b);
      if (blocks.length === 1)
        for (let n = siblingLine(b, "nextSibling"); n && !isEmptyLine(n); n = siblingLine(n, "nextSibling")) out.add(n);
      continue;
    }
    let first = b;
    for (let p = siblingLine(first, "previousSibling"); p && !isEmptyLine(p); p = siblingLine(p, "previousSibling")) first = p;
    for (let n = first; n && !isEmptyLine(n); n = siblingLine(n, "nextSibling")) out.add(n);
  }
  return [...out];
}
// Left is the default, so it is stored as no alignment at all, unless the line
// sits in something aligned otherwise (a centred frame) and must say "left".
function setAlign(el, align) {
  if (align === "left" && (!el.parentElement || alignOf(el.parentElement) === "left")) el.style.removeProperty("text-align");
  else el.style.textAlign = align;
  if (!el.getAttribute("style")) el.removeAttribute("style");
}
function applyAlignment(align) {
  if (trashViewId || backupView || syncing) return;
  const surf = restoreSelection();
  if (!surf) { status("Put the cursor in the text first", true); return; }
  markFormatStep();
  ensureLines(surf);
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const targets = alignTargets(r, surf);
  if (!targets.length) return;
  for (const t of targets) setAlign(t, align);
  if (r.collapsed && isParaLine(targets[0]) && isEmptyLine(targets[0])) alignedEmpty.add(targets[0]);
  rememberSelection();
  markDirtyFromFormatting();
  syncFmtState();
}
// Enter starts a new line of the same paragraph, keeping its alignment; Enter on
// an empty line starts the next paragraph at the default. Shift+Enter is the
// same as Enter (a line is a line; a bare "\n" in the text was the shape that
// made alignment scramble lines). Lists and table cells keep the browser's own
// Enter: a new item, or leaving the list.
$("edit-wrap").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return;
  if (trashViewId || backupView || syncing) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const surf = surfaceOfNode(sel.getRangeAt(0).startContainer);
  if (!surf || !surf.isContentEditable) return;
  const at = sel.getRangeAt(0).startContainer;
  const host = (at.nodeType === 1 ? at : at.parentElement).closest("li, td, th");
  if (host && surf.contains(host)) return;
  ensureLines(surf);
  const r = sel.getRangeAt(0);
  const line = lineOf(r.startContainer, surf);
  if (!line) return;
  e.preventDefault();
  const fresh = r.collapsed && isEmptyLine(line) && !alignedEmpty.has(line);
  const align = line.style.textAlign || "";
  const pend = r.collapsed ? pendingCensorAt(r) : null;
  document.execCommand("insertParagraph");
  if (!sel.rangeCount) return;
  const r2 = sel.getRangeAt(0);
  const next = lineOf(r2.startContainer, surf);
  if (next && next !== line) {
    if (fresh) setAlign(next, "left");
    else if (align) next.style.textAlign = align;
    scrubCensorLook(next);
  }
  // A censor state chosen at the caret carries over to the new line, the way a
  // pending bold does.
  if (pend !== null) setCensorPending(pend, r2, surf);
  syncFmtState();
});
