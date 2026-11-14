/*
 * alignment.js - paragraph alignment (left, centre, right, justified), and
 * what Enter does to it.
 *
 * Alignment belongs to paragraphs, and a paragraph here is a run of lines
 * with no empty line between them: pressing Enter twice is what starts a new
 * one. The buttons align the paragraph the caret is in (or every paragraph a
 * selection touches). On an empty line they align that line and the lines
 * after it, never the paragraph above, so an empty line under a centred
 * paragraph is where a differently aligned one can start. Enter keeps the
 * alignment of the line it splits; Enter on an empty line starts the next
 * paragraph at the default (left).
 *
 * Main functions: applyAlignment, caretAlign, alignBlockOf, alignTargets.
 * Auxiliary functions: alignOf, isParaLine, siblingLine, endsAtStartOf, setAlign.
 *
 * Complexity: O(l) in the lines of the paragraphs touched; a selection
 * checks every block of the editor surface, O(b).
 */
"use strict";

// Lines aligned while still empty: Enter on one keeps its alignment (that is
// what was just chosen for what comes next) instead of resetting it.
let alignedEmpty = new WeakSet();

// ---------- Alignment ----------

/**
 * Aligns the paragraphs the selection touches (see alignTargets). Left is
 * stored as no alignment at all. One undo step, then the note counts as
 * edited.
 *
 * Used by: toolbar.js (the alignment buttons), format-menu.js (Align).
 * Uses: restoreSelection, markFormatStep, rememberSelection,
 * markDirtyFromFormatting and syncFormatState (toolbar.js), status
 * (pagination.js), ensureLines (lines.js), alignTargets, setAlign,
 * isParaLine, isEmptyLine (lines.js).
 * Complexity: O(b) over the surface's blocks.
 */
function applyAlignment(align) {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Put the cursor in the text first", true);
    return;
  }
  markFormatStep();
  ensureLines(surface);

  const selection = window.getSelection();
  if (!selection.rangeCount) {
    return;
  }
  const range = selection.getRangeAt(0);
  const targets = alignTargets(range, surface);
  if (!targets.length) {
    return;
  }
  for (const target of targets) {
    setAlign(target, align);
  }
  if (range.collapsed && isParaLine(targets[0]) && isEmptyLine(targets[0])) {
    alignedEmpty.add(targets[0]);
  }
  rememberSelection();
  markDirtyFromFormatting();
  syncFormatState();
}

/**
 * The alignment where the caret is: left, center, right or justify.
 *
 * Used by: toolbar.js (lighting the right button), format-menu.js (the tick in Align).
 * Uses: alignBlockOf, alignOf.
 * Complexity: O(depth).
 */
function caretAlign(range, surface) {
  const block = alignBlockOf(range.startContainer, surface);
  return alignOf(block || surface);
}

/**
 * What alignment applies to at a node: its line, or failing that the list
 * item, table cell or frame it is in; null when there is none below the surface.
 *
 * Used by: this file, censor.js (clearFormatting).
 * Uses: isLineEl and isFrameEl (lines.js).
 * Complexity: O(depth).
 */
function alignBlockOf(node, surface) {
  for (let el = node && (node.nodeType === 1 ? node : node.parentNode); el && el !== surface; el = el.parentNode) {
    if (isLineEl(el) || isFrameEl(el) || el.tagName === "LI" || el.tagName === "TD" || el.tagName === "TH") {
      return el;
    }
  }
  return null;
}

/**
 * The blocks an alignment applies to. With a caret: its paragraph (or, on an
 * empty line, that line and the lines after it). With a selection: every
 * paragraph it touches, not counting a line it only reaches the very start
 * of. A cell or frame holding lines is aligned through its lines.
 *
 * Used by: applyAlignment in this file.
 * Uses: alignBlockOf, endsAtStartOf, isParaLine, isEmptyLine (lines.js), siblingLine.
 * Complexity: O(b) over the surface's blocks.
 */
function alignTargets(range, surface) {
  let blocks = [];
  if (range.collapsed) {
    const block = alignBlockOf(range.startContainer, surface);
    if (block) {
      blocks.push(block);
    }
  } else {
    for (const block of surface.querySelectorAll("div, p, li, td, th")) {
      if (alignBlockOf(block, surface) !== block || !range.intersectsNode(block) || endsAtStartOf(range, block)) {
        continue;
      }
      if (!isParaLine(block) && block.querySelector("div, p, li")) {
        continue;
      }
      blocks.push(block);
    }
  }

  const out = new Set();
  for (const block of blocks) {
    if (!isParaLine(block)) {
      out.add(block);
      continue;
    }
    if (isEmptyLine(block)) {
      out.add(block);
      if (blocks.length === 1) {
        for (let next = siblingLine(block, "nextSibling"); next && !isEmptyLine(next); next = siblingLine(next, "nextSibling")) {
          out.add(next);
        }
      }
      continue;
    }
    let first = block;
    for (let previous = siblingLine(first, "previousSibling"); previous && !isEmptyLine(previous);
      previous = siblingLine(previous, "previousSibling")) {
      first = previous;
    }
    for (let line = first; line && !isEmptyLine(line); line = siblingLine(line, "nextSibling")) {
      out.add(line);
    }
  }
  return [...out];
}

// ---------- On load: Enter ----------

// Enter starts a new line of the same paragraph, keeping its alignment; Enter
// on an empty line starts the next paragraph at the default. Shift+Enter is
// the same as Enter (a line is a line; a bare "\n" in the text was the shape
// that made alignment scramble lines). Lists and table cells keep the
// browser's own Enter: a new item, or leaving the list. A censor state chosen
// at the caret carries over to the new line, the way a pending bold does.
$("edit-wrap").addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) {
    return;
  }
  if (trashViewId || backupView || syncing) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }
  const surface = surfaceOfNode(selection.getRangeAt(0).startContainer);
  if (!surface || !surface.isContentEditable) {
    return;
  }
  const at = selection.getRangeAt(0).startContainer;
  const host = (at.nodeType === 1 ? at : at.parentElement).closest("li, td, th");
  if (host && surface.contains(host)) {
    return;
  }

  ensureLines(surface);
  const range = selection.getRangeAt(0);
  const line = lineOf(range.startContainer, surface);
  if (!line) {
    return;
  }
  event.preventDefault();
  const fresh = range.collapsed && isEmptyLine(line) && !alignedEmpty.has(line);
  const align = line.style.textAlign || "";
  const pending = range.collapsed ? pendingCensorAt(range) : null;
  document.execCommand("insertParagraph");
  if (!selection.rangeCount) {
    return;
  }

  const newRange = selection.getRangeAt(0);
  const next = lineOf(newRange.startContainer, surface);
  if (next && next !== line) {
    if (fresh) {
      setAlign(next, "left");
    } else if (align) {
      next.style.textAlign = align;
    }
    scrubCensorLook(next);
  }
  if (pending !== null) {
    setCensorPending(pending, newRange, surface);
  }
  syncFormatState();
});

// =================== Auxiliary functions ===================

/** An element's computed alignment, as left, center, right or justify. Complexity: O(1). */
function alignOf(el) {
  const align = getComputedStyle(el).textAlign;
  return align === "center" || align === "-webkit-center" ? "center"
    : align === "right" || align === "end" || align === "-webkit-right" ? "right" : align === "justify" ? "justify" : "left";
}

/** Whether a node is a paragraph line: a line of text, or a list item. Complexity: O(1). */
function isParaLine(node) {
  return isLineEl(node) || (!!node && node.nodeType === 1 && node.tagName === "LI");
}

/**
 * The neighbouring line of the same kind (line or list item), looking past
 * pinned pictures (they sit outside the text) and selection markers; null at
 * anything else. Complexity: O(k) in the siblings skipped.
 */
function siblingLine(node, direction) {
  for (let sibling = node[direction]; sibling; sibling = sibling[direction]) {
    if (isFloatEl(sibling) || isSelMarker(sibling) || (sibling.nodeType === 3 && !sibling.data)) {
      continue;
    }
    return isParaLine(sibling) && (sibling.tagName === "LI") === (node.tagName === "LI") ? sibling : null;
  }
  return null;
}

/**
 * Whether a range only reaches the very start of a block: a drag that ends
 * at the start of the next line selects nothing on it. Complexity: O(k) in that span.
 */
function endsAtStartOf(range, block) {
  if (!block.contains(range.endContainer) || block.contains(range.startContainer)) {
    return false;
  }
  const span = document.createRange();
  span.setStart(block, 0);
  span.setEnd(range.endContainer, range.endOffset);
  return span.toString() === "" && !span.cloneContents().querySelector(".inline-media");
}

/**
 * Sets an element's alignment. Left is the default, so it is stored as no
 * alignment at all, unless the element sits in something aligned otherwise (a
 * centred frame) and must say "left". Complexity: O(1).
 */
function setAlign(el, align) {
  if (align === "left" && (!el.parentElement || alignOf(el.parentElement) === "left")) {
    el.style.removeProperty("text-align");
  } else {
    el.style.textAlign = align;
  }
  if (!el.getAttribute("style")) {
    el.removeAttribute("style");
  }
}
