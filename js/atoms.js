/*
 * atoms.js - atoms: the characters and inline attachments a format sits on.
 *
 * Formatting and censoring work on what you see, not on the HTML: a run of
 * text is a row of characters, and an inline attachment counts as one
 * character. These functions find, count and split those atoms, so censor.js
 * can apply or remove a format over exactly the characters you selected,
 * whatever elements they sit in. Placeholder text inside an attachment
 * ("Decrypting...") belongs to the attachment, not to the note.
 *
 * Main functions: atomsOf, neighbourAtoms, textOffset, pointAtOffset,
 * samePlace, splitRangeEnds, atomsIn, atomsTouched, isolate, tidyInline,
 * selectAtoms, unwrapEl, inMedia.
 * Auxiliary functions: atomLen, childIndex, atomStart, pointBefore.
 *
 * Complexity: each function walks the atoms of one line or editor surface,
 * O(a) in their number; comparing a point with each atom makes some
 * O(a * depth).
 */
"use strict";

// Inline elements a format can live in (links are left alone).
const INLINE_FORMAT_EL = /^(B|I|U|S|STRIKE|STRONG|EM|FONT|SPAN|SUB|SUP)$/;

// ---------- Finding atoms ----------

/**
 * Whether a node sits inside an inline attachment.
 *
 * Used by: this file, censor.js (scrubCensorLook).
 * Uses: isMediaEl (lines.js).
 * Complexity: O(depth).
 */
function inMedia(node) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (isMediaEl(parent)) {
      return true;
    }
  }
  return false;
}

/**
 * Every atom under a root, in document order: non-empty text nodes and
 * inline attachments (not pictures floating beside the text, and not
 * selection markers).
 *
 * Used by: this file, censor.js (dropEmptyMarks), tables.js (insertTable).
 * Uses: isSelMarker, isMediaEl and isFloatEl (lines.js).
 * Complexity: O(n) in the nodes under root.
 */
function atomsOf(root) {
  const out = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.data) {
          out.push(child);
        }
      } else if (child.nodeType === 1 && !isSelMarker(child)) {
        if (isMediaEl(child)) {
          if (!isFloatEl(child)) {
            out.push(child);
          }
        } else {
          walk(child);
        }
      }
    }
  })(root);
  return out;
}

/**
 * The atoms on either side of a caret: { before, after }. Inside a text node
 * both are that text node.
 *
 * Used by: censor.js (caretCensored).
 * Uses: inMedia, atomsOf, atomStart, pointBefore.
 * Complexity: O(a * depth).
 */
function neighbourAtoms(node, offset, root) {
  if (node.nodeType === 3 && node.data && offset > 0 && offset < node.data.length && !inMedia(node)) {
    return { before: node, after: node };
  }
  let before = null;
  let after = null;
  for (const atom of atomsOf(root)) {
    const [atomNode, atomOffset] = atomStart(atom);
    if (atom === node ? offset > 0 : pointBefore(atomNode, atomOffset, node, offset)) {
      before = atom;
    } else {
      after = atom;
      break;
    }
  }
  return { before, after };
}

/**
 * How many characters lie from the start of root to a point (an attachment
 * counts as one).
 *
 * Used by: censor.js (insertSegments, insertPlanAt).
 * Uses: atomsOf, atomStart, pointBefore, atomLen.
 * Complexity: O(a * depth).
 */
function textOffset(root, node, offset) {
  let count = 0;
  for (const atom of atomsOf(root)) {
    if (atom === node) {
      return count + offset;
    }
    const [atomNode, atomOffset] = atomStart(atom);
    if (!pointBefore(atomNode, atomOffset, node, offset)) {
      break;
    }
    count += atomLen(atom);
  }
  return count;
}

/**
 * The point that many characters into root. It lands at the end of a text
 * rather than the start of the next, so a range starting there takes in
 * nothing before it.
 *
 * Used by: censor.js (carryOutInsert).
 * Uses: atomsOf, atomStart, childIndex.
 * Complexity: O(a).
 */
function pointAtOffset(root, count) {
  let last = null;
  for (const atom of atomsOf(root)) {
    if (atom.nodeType === 3) {
      if (count <= atom.data.length) {
        return [atom, count];
      }
      count -= atom.data.length;
    } else {
      if (count <= 0) {
        return atomStart(atom);
      }
      count -= 1;
    }
    last = atom;
  }
  if (last) {
    return last.nodeType === 3 ? [last, last.data.length] : [last.parentNode, childIndex(last) + 1];
  }
  return [root, root.childNodes.length];
}

/**
 * Whether two points are the same caret place: nothing typed or attached lies
 * between them.
 *
 * Used by: censor.js (pendingCensorAt).
 * Uses: pointBefore.
 * Complexity: O(k) in the content between them.
 */
function samePlace(nodeA, offsetA, nodeB, offsetB) {
  const range = document.createRange();
  if (pointBefore(nodeB, offsetB, nodeA, offsetA)) {
    range.setStart(nodeB, offsetB);
    range.setEnd(nodeA, offsetA);
  } else {
    range.setStart(nodeA, offsetA);
    range.setEnd(nodeB, offsetB);
  }
  return range.toString() === "" && !range.cloneContents().querySelector(".inline-media");
}

// ---------- Working on a range ----------

/**
 * Splits the text at both ends of a range, so every text node is either
 * wholly inside it or wholly outside, and returns the same range on the
 * split nodes.
 *
 * Used by: censor.js (setCensorRange, clearFormatting).
 * Uses: nothing.
 * Complexity: O(1).
 */
function splitRangeEnds(range) {
  let startNode = range.startContainer;
  let startOffset = range.startOffset;
  let endNode = range.endContainer;
  let endOffset = range.endOffset;

  if (endNode.nodeType === 3 && endOffset > 0 && endOffset < endNode.data.length) {
    endNode.splitText(endOffset);
  }
  if (startNode.nodeType === 3 && startOffset > 0 && startOffset < startNode.data.length) {
    const right = startNode.splitText(startOffset);
    if (endNode === startNode) {
      endNode = right;
      endOffset -= startOffset;
    }
    startNode = right;
    startOffset = 0;
  }

  const out = document.createRange();
  out.setStart(startNode, startOffset);
  out.setEnd(endNode, endOffset);
  return out;
}

/**
 * The atoms lying wholly inside a range.
 *
 * Used by: censor.js (setCensorRange, clearFormatting).
 * Uses: atomsOf, atomStart, pointBefore, childIndex.
 * Complexity: O(a * depth).
 */
function atomsIn(range, surface) {
  const common = range.commonAncestorContainer;
  const root = common.nodeType === 1 ? common : common.parentNode;
  return atomsOf(root.contains(surface) ? surface : root).filter(atom => {
    const [atomNode, atomOffset] = atomStart(atom);
    return !pointBefore(atomNode, atomOffset, range.startContainer, range.startOffset) &&
      !pointBefore(range.endContainer, range.endOffset,
        ...(atom.nodeType === 3 ? [atom, atom.data.length] : [atom.parentNode, childIndex(atom) + 1]));
  });
}

/**
 * The atoms a range touches with at least one character, without splitting anything.
 *
 * Used by: censor.js (insertPlanAt, and the copy handler).
 * Uses: atomsOf.
 * Complexity: O(a).
 */
function atomsTouched(range, surface) {
  const common = range.commonAncestorContainer;
  const root = common.nodeType === 1 ? common : common.parentNode;
  return atomsOf(root.contains(surface) ? surface : root).filter(atom => {
    if (!range.intersectsNode(atom)) {
      return false;
    }
    if (atom.nodeType !== 3) {
      return true;
    }
    if (atom === range.startContainer && range.startOffset >= atom.data.length) {
      return false;
    }
    if (atom === range.endContainer && range.endOffset === 0) {
      return false;
    }
    return true;
  });
}

/**
 * Replaces an element with its own children.
 *
 * Used by: censor.js (setCensorRange, clearFormatting, dropEmptyMarks, scrubCensorLook).
 * Uses: nothing.
 * Complexity: O(c) in its children.
 */
function unwrapEl(el) {
  while (el.firstChild) {
    el.parentNode.insertBefore(el.firstChild, el);
  }
  el.remove();
}

/**
 * Cuts an inline element in three around the atoms first..last (both inside
 * it) and returns the middle part, which holds exactly them. The parts
 * before and after keep the element's formatting.
 *
 * Used by: censor.js (setCensorRange, clearFormatting).
 * Uses: nothing.
 * Complexity: O(c) in the element's content.
 */
function isolate(el, first, last) {
  const tail = document.createRange();
  tail.setStartAfter(last);
  tail.setEnd(el, el.childNodes.length);
  if (!tail.collapsed) {
    const after = el.cloneNode(false);
    after.appendChild(tail.extractContents());
    el.after(after);
  }

  const head = document.createRange();
  head.setStart(el, 0);
  head.setEndBefore(first);
  if (!head.collapsed) {
    const before = el.cloneNode(false);
    before.appendChild(head.extractContents());
    el.before(before);
  }
  return el;
}

/**
 * Tidies what a split left behind: inline wrappers left empty go, and censor
 * marks that ended up side by side become one.
 *
 * Used by: censor.js (setCensorRange, clearFormatting).
 * Uses: isMediaEl, isSelMarker and isBareMark (lines.js), inMedia.
 * Complexity: O(e) in the inline elements under root.
 */
function tidyInline(root) {
  for (const el of [...root.querySelectorAll("b,i,u,s,strike,strong,em,font,span,sub,sup,a")].reverse()) {
    if (isMediaEl(el) || isSelMarker(el) || inMedia(el)) {
      continue;
    }
    if (!el.firstChild || (el.textContent === "" && !el.querySelector("br,.inline-media,[data-sel]"))) {
      el.remove();
    }
  }

  for (const mark of [...root.querySelectorAll('span[data-censor="1"]')]) {
    if (!mark.isConnected || !isBareMark(mark)) {
      continue;
    }
    for (;;) {
      let next = mark.nextSibling;
      while (next && next.nodeType === 3 && !next.data) {
        const after = next.nextSibling;
        next.remove();
        next = after;
      }
      if (!isBareMark(next)) {
        break;
      }
      while (next.firstChild) {
        mark.appendChild(next.firstChild);
      }
      next.remove();
    }
  }
}

/**
 * Selects the atoms first..last and returns that range.
 *
 * Used by: censor.js (toggleCensor, clearFormatting).
 * Uses: nothing.
 * Complexity: O(1).
 */
function selectAtoms(first, last) {
  const range = document.createRange();
  if (first.nodeType === 3) {
    range.setStart(first, 0);
  } else {
    range.setStartBefore(first);
  }
  if (last.nodeType === 3) {
    range.setEnd(last, last.data.length);
  } else {
    range.setEndAfter(last);
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

// =================== Auxiliary functions ===================

/** An atom's length: a text node's characters, or 1 for an attachment. Complexity: O(1). */
function atomLen(atom) {
  return atom.nodeType === 3 ? atom.data.length : 1;
}

/** A node's index among its parent's children. Complexity: O(c). */
function childIndex(node) {
  return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
}

/** The point where an atom starts: [text, 0], or [parent, index] for an attachment. Complexity: O(c). */
function atomStart(atom) {
  return atom.nodeType === 3 ? [atom, 0] : [atom.parentNode, childIndex(atom)];
}

/** Whether the point (nodeA, offsetA) comes before the point (nodeB, offsetB). Complexity: O(depth). */
function pointBefore(nodeA, offsetA, nodeB, offsetB) {
  const range = document.createRange();
  range.setStart(nodeB, offsetB);
  return range.comparePoint(nodeA, offsetA) < 0;
}
