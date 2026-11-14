/*
 * censor.js - censoring: the mark, typing with it, clearing formatting, and
 * copying that never carries censored text out. Also the editor's keyboard
 * shortcuts and the undo and redo buttons.
 *
 * Censoring is a format, like bold: a state at the caret that typing
 * follows, and a mark that goes on or comes off a selection. The mark is a
 * <span data-censor="1"> placed directly around the text, inside whatever
 * formatting was there, so bold, fonts, sizes and colours stay where they
 * were and come back unchanged when the mark is removed. In the app it shows
 * as a black bar (hover to read it); every export destroys the characters
 * and keeps only the bar.
 *
 * The clipboard and drag-and-drop are ways out of the app like any export:
 * in what they carry, every censored run becomes a row of blocks, sized by
 * the same coarse rule as the export's bars. They carry plain text only,
 * since a rich copy would hold the hidden characters with nothing but a style
 * over them. What was really copied stays in memory (never on the
 * clipboard), so pasting it back into a note brings the text back still
 * censored. That copy is dropped at lock, with the rest of the decrypted vault.
 *
 * Main functions: censorStateAt, pendingCensorAt, setCensorPending,
 * setCensorRange, toggleCensor, clearFormatting, scrubCensorLook,
 * insertPlanAt, carryOutInsert, plainLines, censoredCopy, censoredSelection,
 * copySegments, insertSegments.
 * Auxiliary functions: censorAncestor, caretCensored, rangeTouchesCensor,
 * dropEmptyMarks, sameClipText.
 *
 * Complexity: censoring or clearing a selection is O(a * depth) in its atoms
 * (atoms.js); the state at a caret is O(a) over its line; a copy is O(n) in
 * what is copied.
 */
"use strict";

// ---------- State ----------

// A censor state chosen at a caret (the button pressed with nothing
// selected), for what is typed there next: { on, node, off }. It lapses as
// soon as the caret moves.
let censorPending = null;

// ---------- The censor state ----------

/**
 * What the censor button shows. For a caret: the state typing would get
 * there (the one chosen at the caret, else that of the text it extends). For
 * a selection: whether all of it is censored, read from a copy of just the
 * selected content, so dragging a selection across a long note stays cheap.
 *
 * Used by: this file (toggleCensor), toolbar.js (syncFormatState),
 * format-menu.js (formatMenuItems).
 * Uses: pendingCensorAt, caretCensored, censorAncestor, isSelMarker,
 * isMediaEl and isCensorEl (lines.js).
 * Complexity: O(a) over the caret's line, or O(n) in the selection.
 */
function censorStateAt(range, surface) {
  if (range.collapsed) {
    const pending = pendingCensorAt(range);
    return pending !== null ? pending : caretCensored(range, surface);
  }
  if (censorAncestor(range.commonAncestorContainer, surface)) {
    return true;
  }
  let anyContent = false;
  const allCensored = (function walk(node, inMark) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.data) {
          anyContent = true;
          if (!inMark) {
            return false;
          }
        }
      } else if (child.nodeType === 1 && !isSelMarker(child)) {
        if (isMediaEl(child)) {
          anyContent = true;
          if (!inMark) {
            return false;
          }
        } else if (!walk(child, inMark || isCensorEl(child))) {
          return false;
        }
      }
    }
    return true;
  })(range.cloneContents(), false);
  return anyContent && allCensored;
}

/**
 * The censor state chosen at this caret, or null when none was, or when the
 * caret has moved since (the choice then lapses).
 *
 * Used by: this file, alignment.js (Enter, on load).
 * Uses: samePlace (atoms.js).
 * Complexity: O(k) in the content between the two places.
 */
function pendingCensorAt(range) {
  if (!censorPending) {
    return null;
  }
  if (!censorPending.node.isConnected ||
    !samePlace(censorPending.node, censorPending.off, range.startContainer, range.startOffset)) {
    censorPending = null;
    return null;
  }
  return censorPending.on;
}

/**
 * Chooses the censor state for what is typed next at a caret. Choosing what
 * the caret would get anyway clears the choice instead.
 *
 * Used by: this file (toggleCensor, typing after deleting censored text), alignment.js (Enter, on load).
 * Uses: caretCensored.
 * Complexity: O(a) over the caret's line.
 */
function setCensorPending(on, range, surface) {
  censorPending = on === caretCensored(range, surface) ? null
    : { on, node: range.startContainer, off: range.startOffset };
}

// ---------- Censoring a selection ----------

/**
 * Censors (on true) or uncensors (on false) exactly the characters in a
 * range, leaving every other format alone; with on left out, it censors
 * unless all of them already are. Uncensoring cuts the mark around just
 * those characters, and anything else it carried (a size the browser put on
 * it, say) stays. Returns { first, last, on } (the first and last atom), or
 * null when the range holds none.
 *
 * Used by: this file (toggleCensor, carryOutInsert).
 * Uses: splitRangeEnds, atomsIn, isolate, unwrapEl and tidyInline (atoms.js),
 * censorAncestor, lineOf, censorMark and uncensorMark (lines.js), alignBlockOf (alignment.js).
 * Complexity: O(a * depth) in the atoms.
 */
function setCensorRange(range, surface, on) {
  const exactRange = splitRangeEnds(range);
  const atoms = atomsIn(exactRange, surface);
  if (!atoms.length) {
    return null;
  }
  if (on === undefined) {
    on = !atoms.every(atom => censorAncestor(atom, surface));
  }
  const lines = new Set(atoms.map(atom => lineOf(atom, surface) || alignBlockOf(atom, surface) || surface));

  if (on) {
    for (const atom of atoms) {
      if (!censorAncestor(atom, surface)) {
        const mark = censorMark(document.createElement("span"));
        atom.parentNode.insertBefore(mark, atom);
        mark.appendChild(atom);
      }
    }
  } else {
    for (let i = 0; i < atoms.length;) {
      const mark = censorAncestor(atoms[i], surface);
      if (!mark) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < atoms.length && censorAncestor(atoms[j + 1], surface) === mark) {
        j++;
      }
      const middle = isolate(mark, atoms[i], atoms[j]);
      uncensorMark(middle);
      if (!middle.attributes.length) {
        unwrapEl(middle);
      }
      i = j + 1;
    }
  }

  for (const line of lines) {
    if (line.isConnected) {
      tidyInline(line);
    }
  }
  return { first: atoms[0], last: atoms[atoms.length - 1], on };
}

/**
 * The censor button. With nothing selected it switches the state typing will
 * get at the caret, like bold. With a selection it censors it, or uncensors
 * it when all of it already is, as one undo step, and keeps it selected.
 *
 * Used by: this file (the censor button), format-menu.js (formatMenuItems).
 * Uses: restoreSelection, markFormatStep, rememberSelection,
 * markDirtyFromFormatting and syncFormatState (toolbar.js), status
 * (pagination.js), censorStateAt, setCensorPending, ensureLines (lines.js),
 * setCensorRange, selectAtoms (atoms.js).
 * Complexity: O(a * depth) in the selection's atoms.
 */
function toggleCensor() {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Put the cursor in the text first", true);
    return;
  }
  const selection = window.getSelection();
  if (!selection.rangeCount) {
    return;
  }
  let range = selection.getRangeAt(0);
  if (range.collapsed) {
    const censoredNow = censorStateAt(range, surface);
    setCensorPending(!censoredNow, range, surface);
    syncFormatState();
    status(censoredNow ? "Censor off: what you type now stays readable" : "Censor on: what you type now is censored");
    return;
  }

  markFormatStep();
  ensureLines(surface);
  range = selection.getRangeAt(0);
  const result = setCensorRange(range, surface);
  if (!result) {
    status("Select some text to censor", true);
    return;
  }
  selectAtoms(result.first, result.last);
  rememberSelection();
  markDirtyFromFormatting();
  syncFormatState();
}

/**
 * Clear formatting: bold, italic, underline, strikethrough, fonts, sizes,
 * colours and highlights come off the selection. Censoring stays (it is a
 * redaction, not a look), and so do links and paragraph alignment. Done here
 * rather than with the browser's removeFormat, which "clears" text by
 * writing the editor's own colours onto it, censored text included. Styles
 * the browser put on a censor mark itself go too; the mark stays. One undo step.
 *
 * Used by: toolbar.js (the clear button, on load), format-menu.js (formatMenuItems).
 * Uses: restoreSelection, markFormatStep, rememberSelection,
 * markDirtyFromFormatting and syncFormatState (toolbar.js), status
 * (pagination.js), ensureLines, lineOf, isLineEl, isFrameEl, isStructEl and
 * isCensorEl (lines.js), splitRangeEnds, atomsIn, isolate, unwrapEl,
 * tidyInline, selectAtoms and INLINE_FORMAT_EL (atoms.js), alignBlockOf
 * (alignment.js), censorAncestor.
 * Complexity: O(a * depth) per formatting element removed.
 */
function clearFormatting() {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Select the text to clear first", true);
    return;
  }
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) {
    status("Select the text to clear first", true);
    return;
  }
  markFormatStep();
  ensureLines(surface);
  const exactRange = splitRangeEnds(selection.getRangeAt(0));
  const atoms = atomsIn(exactRange, surface);
  if (!atoms.length) {
    return;
  }
  const lines = new Set(atoms.map(atom => lineOf(atom, surface) || alignBlockOf(atom, surface) || surface));

  // The outermost formatting element around an atom, inside its line.
  const formatOf = atom => {
    let found = null;
    for (let el = atom.parentNode; el && el !== surface && !isLineEl(el) && !isFrameEl(el) && !isStructEl(el);
      el = el.parentNode) {
      if (el.nodeType === 1 && INLINE_FORMAT_EL.test(el.tagName) && !isCensorEl(el)) {
        found = el;
      }
    }
    return found;
  };
  // A bounded number of rounds, so a structure the loop cannot shrink can never hang it.
  for (let round = 0; round < atoms.length * 8 + 64; round++) {
    const i = atoms.findIndex(atom => formatOf(atom));
    if (i < 0) {
      break;
    }
    const format = formatOf(atoms[i]);
    let j = i;
    while (j + 1 < atoms.length && format.contains(atoms[j + 1])) {
      j++;
    }
    unwrapEl(isolate(format, atoms[i], atoms[j]));
  }

  for (const atom of atoms) {
    const mark = censorAncestor(atom, surface);
    if (mark) {
      mark.removeAttribute("style");
    }
  }
  for (const line of lines) {
    if (line.isConnected) {
      tidyInline(line);
    }
  }
  selectAtoms(atoms[0], atoms[atoms.length - 1]);
  rememberSelection();
  markDirtyFromFormatting();
  syncFormatState();
}

/**
 * Strips the look of censored text where it is not a real mark. When
 * censored text is deleted, the browser copies its look (transparent ink on
 * a black box) onto what is typed next, as inline styles with no data-censor
 * mark, so it would be saved and exported as ordinary text while looking
 * hidden on screen.
 *
 * Used by: this file (typing, insertSegments), alignment.js (Enter, on load),
 * attachments.js (insertPlainText).
 * Uses: inMedia and unwrapEl (atoms.js), cssColorHex (history.js),
 * isCensorEl, isMediaEl and isSelMarker (lines.js).
 * Complexity: O(e) in the elements under root.
 */
function scrubCensorLook(root) {
  if (!root || !root.querySelectorAll) {
    return;
  }
  let leaked = false;
  for (const el of [...root.querySelectorAll("font[color], [style*='color']")]) {
    if (inMedia(el)) {
      continue;
    }
    const colour = el.tagName === "FONT" && el.hasAttribute("color") ? el.getAttribute("color") : el.style.color;
    if (!colour || cssColorHex(colour) !== "transparent") {
      continue;
    }
    leaked = true;
    if (el.tagName === "FONT") {
      el.removeAttribute("color");
    }
    el.style.removeProperty("color");
  }
  if (!leaked) {
    return;
  }

  for (const el of [...root.querySelectorAll("[style*='background']")]) {
    if (inMedia(el) || isCensorEl(el)) {
      continue;
    }
    const background = cssColorHex(el.style.backgroundColor);
    if (background === "#000" || background === "#000000") {
      el.style.removeProperty("background-color");
    }
  }
  for (const el of [...root.querySelectorAll("font, span")]) {
    if (inMedia(el) || isMediaEl(el) || isCensorEl(el) || isSelMarker(el)) {
      continue;
    }
    if (!el.getAttribute("style")) {
      el.removeAttribute("style");
    }
    if (!el.attributes.length) {
      unwrapEl(el);
    }
  }
}

// ---------- On load: the censor button ----------

$("fmt-censor").addEventListener("mousedown", event => event.preventDefault());
$("fmt-censor").onclick = toggleCensor;

// ---------- Typing: state ----------

// The browser decides where typed text lands; the app then gives that text
// the censor state the user chose. Plans are made in beforeinput (what was
// selected, where the caret was) and carried out in input, once the text is
// in. inPlainPaste is set while insertSegments types a paste itself.
let typingPlan = null;
let deletePlan = null;
let compositionPlan = null;
let inPlainPaste = false;

// ---------- Typing ----------

/**
 * The plan for text about to be typed at a range: { surf, want, root, start }
 * (the censor state it should get, its line, and where it starts, counted in
 * characters), or null when nothing needs doing. Typing over a selection
 * keeps the state of what it replaces, like bold.
 *
 * Used by: this file (beforeinput, compositionstart), attachments.js (pasting and dropping, on load).
 * Uses: pendingCensorAt, atomsTouched and textOffset (atoms.js), censorAncestor, lineOf (lines.js).
 * Complexity: O(a * depth) over the line.
 */
function insertPlanAt(range, surface) {
  let want = range.collapsed ? pendingCensorAt(range) : null;
  if (want === null && !range.collapsed) {
    const atom = atomsTouched(range, surface)[0];
    if (atom) {
      want = !!censorAncestor(atom, surface);
    }
  }
  if (want === null) {
    return null;
  }
  const root = lineOf(range.startContainer, surface) || surface;
  return { surf: surface, want, root, start: textOffset(root, range.startContainer, range.startOffset) };
}

/**
 * Gives the text typed since a plan was made the censor state it asked for,
 * and puts the caret back at the end of that text, inside its new mark. The
 * state chosen at the caret is used up.
 *
 * Used by: this file (input, compositionend, insertSegments), attachments.js (pasting and dropping, on load).
 * Uses: pointAtOffset (atoms.js), setCensorRange.
 * Complexity: O(a * depth) over the line.
 */
function carryOutInsert(plan) {
  const selection = window.getSelection();
  censorPending = null;
  if (!plan || !selection.rangeCount || !plan.root.isConnected) {
    return;
  }
  const end = selection.getRangeAt(0);
  const [startNode, startOffset] = pointAtOffset(plan.root, plan.start);
  const typed = document.createRange();
  try {
    typed.setStart(startNode, startOffset);
    typed.setEnd(end.startContainer, end.startOffset);
  } catch {
    return;
  }
  if (typed.collapsed) {
    return;
  }
  const result = setCensorRange(typed, plan.surf, plan.want);
  if (!result) {
    return;
  }
  const caret = document.createRange();
  if (result.last.nodeType === 3) {
    caret.setStart(result.last, result.last.data.length);
  } else {
    caret.setStartAfter(result.last);
  }
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

// ---------- On load: typing in the editor ----------

// Before the browser changes the text: a typing plan, or a note of what a
// deletion takes away. The browser's own undo (Edit menu, context menu) would
// rewind the text behind the app's history, so it goes there instead.
$("edit-wrap").addEventListener("beforeinput", event => {
  const surface = surfaceOfNode(event.target);
  if (!surface || trashViewId || backupView) {
    return;
  }
  const type = event.inputType || "";
  if (type === "historyUndo" || type === "historyRedo") {
    event.preventDefault();
    if (currentId) {
      (type === "historyUndo" ? historyUndo : historyRedo)();
    }
    return;
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (type === "insertText" || type === "insertReplacementText" || type === "insertFromDrop" || type === "insertFromPaste") {
    typingPlan = inPlainPaste ? null : insertPlanAt(range, surface);
  } else if (type.startsWith("delete")) {
    let ranges = [];
    try {
      ranges = event.getTargetRanges().map(target => {
        const copy = document.createRange();
        copy.setStart(target.startContainer, target.startOffset);
        copy.setEnd(target.endContainer, target.endOffset);
        return copy;
      });
    } catch {}
    if (!ranges.length && !range.collapsed) {
      ranges = [range];
    }
    const touched = ranges.flatMap(each => atomsTouched(each, surface));
    deletePlan = { surf: surface, censored: touched.some(atom => censorAncestor(atom, surface)),
      backward: /Backward|ByCut|ByDrag/.test(type) || !range.collapsed };
  }
});

// After the browser changed the text: the plan is carried out, and a leaked
// censor look is stripped from the line.
$("edit-wrap").addEventListener("input", event => {
  const surface = surfaceOfNode(event.target);
  if (!surface || event.isComposing) {
    return;
  }
  const type = event.inputType || "";
  const selection = window.getSelection();
  if (typingPlan && /^insert/.test(type) && !inPlainPaste) {
    const plan = typingPlan;
    typingPlan = null;
    carryOutInsert(plan);
  }
  if (deletePlan && /^delete/.test(type)) {
    const plan = deletePlan;
    deletePlan = null;
    // Deleting censored text backwards and typing on continues censored, as a
    // deleted bold word's typing does; the button shows it, and one click ends it.
    if (plan.censored && plan.backward && selection.rangeCount && selection.isCollapsed) {
      const caret = selection.getRangeAt(0);
      if (!caretCensored(caret, surface)) {
        setCensorPending(true, caret, surface);
      }
    }
  }
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  scrubCensorLook((range && lineOf(range.startContainer, surface)) || surface);
  syncFormatState();
});

// Composed input (accents typed with a dead key, an IME) cannot be redirected
// while it is being composed: the state is applied to the finished text.
$("edit-wrap").addEventListener("compositionstart", () => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    compositionPlan = null;
    return;
  }
  const range = selection.getRangeAt(0);
  const surface = surfaceOfNode(range.startContainer);
  compositionPlan = surface && !trashViewId && !backupView ? insertPlanAt(range, surface) : null;
});
$("edit-wrap").addEventListener("compositionend", () => {
  const plan = compositionPlan;
  compositionPlan = null;
  if (plan) {
    setTimeout(() => {
      carryOutInsert(plan);
      scrubCensorLook(plan.root);
      markDirtyFromFormatting();
      syncFormatState();
    }, 0);
  }
});

// ---------- Copying: state ----------

// What a censored copy (appClip) or drag (appDrag) really was:
// { plain, segs }, where segs are runs of { t: text, c: censored }.
let appClip = null;
let appDrag = null;

// ---------- Copying never carries censored text out ----------

/**
 * A container's text as plain lines, with every censored run as a row of
 * blocks (█) sized by the export's coarse rule, so the length of what is
 * hidden is not given away exactly. Table cells are separated by tabs.
 *
 * Used by: this file (censoredCopy), content.js (bodyPlainText).
 * Uses: isMediaEl, isCensorEl and isLineTag (lines.js), censorLenBucket (pdf.js).
 * Complexity: O(n) in the container.
 */
function plainLines(root) {
  const out = [];
  let current = "";
  const push = () => {
    out.push(current);
    current = "";
  };
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        current += child.data;
      } else if (child.nodeType !== 1 || isMediaEl(child)) {
        continue;
      } else if (isCensorEl(child)) {
        current += "█".repeat(censorLenBucket((child.textContent || "").length));
      } else if (child.tagName === "BR") {
        push();
      } else if (isLineTag(child.tagName) || child.tagName === "LI" || child.tagName === "TR") {
        if (current) {
          push();
        }
        walk(child);
        if (current || !child.textContent) {
          push();
        }
      } else if (child.tagName === "TD" || child.tagName === "TH") {
        walk(child);
        current += "\t";
      } else {
        walk(child);
      }
    }
  })(root);
  if (current) {
    push();
  }
  return out.join("\n").replace(/\t(?=\n|$)/g, "");
}

/**
 * The plain text with blocks that a copy of a range carries, or null when
 * the range holds nothing censored (the browser's own copy is fine then).
 *
 * Used by: this file (copy and cut, on load), attachments.js (dragging text, on load).
 * Uses: plainLines.
 * Complexity: O(n) in the range.
 */
function censoredCopy(range) {
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return holder.querySelector('[data-censor="1"]') ? plainLines(holder) : null;
}

/**
 * The selection, widened so a mark it starts or ends inside goes whole, when
 * it touches censored text anywhere on the page (the note, or the reference
 * pane of the second screen, which shows the same marks); else null.
 *
 * Used by: this file (copy and cut, on load), attachments.js (dragging text, on load).
 * Uses: rangeTouchesCensor, censorAncestor.
 * Complexity: O(n) in the selection.
 */
function censoredSelection() {
  const selection = window.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || range.collapsed || !rangeTouchesCensor(range, null)) {
    return null;
  }
  const widened = range.cloneRange();
  const startMark = censorAncestor(widened.startContainer, null);
  const endMark = censorAncestor(widened.endContainer, null);
  if (startMark) {
    widened.setStartBefore(startMark);
  }
  if (endMark) {
    widened.setEndAfter(endMark);
  }
  return widened;
}

/**
 * What a range really holds, as runs of { t: text, c: censored }, line by
 * line exactly as plainLines writes it. Kept in memory only, so pasting or
 * dropping it back into a note brings the text back still censored.
 *
 * Used by: this file (copy and cut, on load), attachments.js (dragging text, on load).
 * Uses: isMediaEl, isCensorEl and isLineTag (lines.js).
 * Complexity: O(n) in the range.
 */
function copySegments(range) {
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  const tokens = [];
  // Whether the current line holds something.
  let line = false;
  const add = (text, censored) => {
    if (text) {
      tokens.push({ t: text, c: censored });
      line = true;
    }
  };
  const push = () => {
    tokens.push({ t: "\n", c: false });
    line = false;
  };
  (function walk(node, censored) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        add(child.data, censored);
      } else if (child.nodeType !== 1 || isMediaEl(child)) {
        continue;
      } else if (isCensorEl(child)) {
        add(child.textContent || "", true);
      } else if (child.tagName === "BR") {
        push();
      } else if (isLineTag(child.tagName) || child.tagName === "LI" || child.tagName === "TR") {
        if (line) {
          push();
        }
        walk(child, censored);
        if (line || !child.textContent) {
          push();
        }
      } else if (child.tagName === "TD" || child.tagName === "TH") {
        walk(child, censored);
        add("\t", false);
      } else {
        walk(child, censored);
      }
    }
  })(holder, false);

  // plainLines' last steps: no line break after the last line, no tab ending a row.
  if (tokens.length && tokens[tokens.length - 1].t === "\n" && !line) {
    tokens.pop();
  }
  const segments = [];
  tokens.forEach((token, i) => {
    if (token.t === "\t" && (i === tokens.length - 1 || tokens[i + 1].t === "\n")) {
      return;
    }
    const last = segments[segments.length - 1];
    if (last && last.c === token.c) {
      last.t += token.t;
    } else {
      segments.push({ ...token });
    }
  });
  return segments;
}

/**
 * Types runs in at the caret (over the selection), each censored or not as
 * it was. Line breaks go in on their own: a break typed inside a mark copies
 * an empty mark onto the new line, which would make the next run censored.
 *
 * Used by: attachments.js (pasting and dropping, on load).
 * Uses: surfaceOfNode, lineOf and ensureLines (lines.js), textOffset
 * (atoms.js), carryOutInsert, dropEmptyMarks, scrubCensorLook, syncFormatState (toolbar.js).
 * Complexity: O(n) in the text, plus O(a * depth) per run.
 */
function insertSegments(segments) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }
  const surface = surfaceOfNode(selection.getRangeAt(0).startContainer);
  if (!surface) {
    return;
  }
  const run = (text, censored) => {
    const range = selection.getRangeAt(0);
    const root = lineOf(range.startContainer, surface) || surface;
    const plan = { surf: surface, want: censored, root,
      start: textOffset(root, range.startContainer, range.startOffset) };
    document.execCommand("insertText", false, text);
    carryOutInsert(plan);
  };

  inPlainPaste = true;
  try {
    if (!selection.isCollapsed) {
      document.execCommand("delete");
    }
    for (const segment of segments) {
      segment.t.split("\n").forEach((text, i) => {
        if (!selection.rangeCount) {
          return;
        }
        if (i > 0) {
          document.execCommand("insertParagraph");
          const line = selection.rangeCount && lineOf(selection.getRangeAt(0).startContainer, surface);
          if (line) {
            dropEmptyMarks(line);
          }
        }
        if (text) {
          run(text, segment.c);
        }
      });
    }
  } finally {
    inPlainPaste = false;
  }
  ensureLines(surface);
  scrubCensorLook(surface);
  syncFormatState();
}

// ---------- On load: copying, the selection, and the keyboard ----------

// A copy or cut that touches censored text carries blocks, and the real runs
// stay in appClip. A field's own text is copied as it is.
for (const type of ["copy", "cut"]) {
  document.addEventListener(type, event => {
    appClip = null;
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      return;
    }
    const censored = censoredSelection();
    if (!censored) {
      return;
    }
    event.preventDefault();
    const plain = censoredCopy(censored) || "";
    event.clipboardData.setData("text/plain", plain);
    appClip = { plain, segs: copySegments(censored) };
    const surface = surfaceOfNode(censored.startContainer);
    if (type === "cut" && surface && surface.isContentEditable && !trashViewId && !backupView && !syncing) {
      document.execCommand("delete");
    }
  });
}

// Every format the browser applies is written as a styled span, never as a
// <font> tag the sanitiser would strip, from the first time a page is entered.
$("edit-wrap").addEventListener("focusin", () => {
  try {
    document.execCommand("styleWithCSS", false, true);
  } catch {}
});

// The toolbar follows the caret. Listened for only once every script has
// loaded: the password field's autofocus can move the selection while later
// files (lines.js) are still on their way. A censor state chosen at the caret
// lapses when the caret moves.
document.addEventListener("DOMContentLoaded", () => document.addEventListener("selectionchange", () => {
  const range = currentEditorRange();
  if (!range) {
    return;
  }
  if (censorPending) {
    pendingCensorAt(range);
  }
  rememberSelection();
  syncFormatState();
}));

// Ctrl+Z and Ctrl+Y (Ctrl+Shift+Z) are the app's undo and redo, not the
// browser's: the browser's stack knows nothing about pages, designs or
// attachments, and would put the text and the note out of step. Only for the
// note itself (its pages and its title): in the search box or a dialog's
// field Ctrl+Z once undid the note behind it instead of the typing in the
// field. Ctrl+B, I and U go through runFormat, so the unsaved flag and the
// saving rules are the same as for the buttons.
document.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "z" || key === "y") {
    if (!vault || !currentId || backupView || trashViewId || uiLayerOpen()) {
      return;
    }
    const target = event.target;
    if (target && target !== $("title") &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
      return;
    }
    event.preventDefault();
    if (key === "y" || event.shiftKey) {
      historyRedo();
    } else {
      historyUndo();
    }
    return;
  }
  const cmd = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
  if (!cmd || !editorHasFocus(event.target)) {
    return;
  }
  event.preventDefault();
  rememberSelection();
  runFormat(cmd);
});

$("undo-btn").onclick = () => historyUndo();
$("redo-btn").onclick = () => historyRedo();

// =================== Auxiliary functions ===================

/** The censor mark a node is inside (below surface; anywhere when it is null), or null. Complexity: O(depth). */
function censorAncestor(node, surface) {
  for (let el = node && (node.nodeType === 1 ? node : node.parentNode); el && el !== surface; el = el.parentNode) {
    if (isCensorEl(el)) {
      return el;
    }
  }
  return null;
}

/**
 * The state typing at a caret takes when nothing was chosen there: that of
 * the character before it on its line (what typing extends), or at the start
 * of a line that of the character after it. Complexity: O(a) over the line.
 */
function caretCensored(range, surface) {
  const root = lineOf(range.startContainer, surface) || alignBlockOf(range.startContainer, surface) || surface;
  const { before, after } = neighbourAtoms(range.startContainer, range.startOffset, root);
  const atom = before || after;
  return !!censorAncestor(atom || range.startContainer, surface);
}

/**
 * Whether a range touches censored text: it starts or ends inside a mark, or
 * holds one. surface bounds the search for an enclosing mark (null: the whole
 * page). Complexity: O(n) in the range.
 */
function rangeTouchesCensor(range, surface) {
  if (censorAncestor(range.startContainer, surface) || censorAncestor(range.endContainer, surface)) {
    return true;
  }
  return !!range.cloneContents().querySelector('[data-censor="1"]');
}

/** Unwraps censor marks around nothing: they only make what is typed there next censored. Complexity: O(e). */
function dropEmptyMarks(root) {
  for (const mark of [...root.querySelectorAll('[data-censor="1"]')]) {
    if (!atomsOf(mark).length) {
      unwrapEl(mark);
    }
  }
}

/**
 * Whether two clipboard texts are the same, ignoring \r\n against \n (the
 * Windows clipboard can hand line breaks back as \r\n). Used by attachments.js.
 * Complexity: O(n).
 */
function sameClipText(a, b) {
  return String(a).replace(/\r\n?/g, "\n") === String(b).replace(/\r\n?/g, "\n");
}
