// notes: Censoring: the mark, typing with it, and copying that never carries it out.
"use strict";

// ---------- Censor ----------
// Censoring is a format, like bold: a state at the caret that typing follows,
// and a mark that goes on or comes off a selection. The mark is a
// <span data-censor="1"> placed directly around the text, inside whatever
// formatting was there, so bold, fonts, sizes and colours stay where they were
// and come back unchanged when the mark is removed. In the app it shows as a
// black bar (hover to read it); every export destroys the characters and keeps
// only the bar.
// A censor state chosen at a caret (the button pressed with nothing selected),
// for what is typed there next. It lapses as soon as the caret moves.
let censorPending = null;   // { on, node, off }
function censorAncestor(node, surf) {
  for (let n = node && (node.nodeType === 1 ? node : node.parentNode); n && n !== surf; n = n.parentNode)
    if (isCensorEl(n)) return n;
  return null;
}
// The state typing at a caret takes when nothing was chosen there: that of the
// character before it on its line (what typing extends), or at the start of a
// line that of the character after it.
function caretCensored(r, surf) {
  const root = lineOf(r.startContainer, surf) || alignBlockOf(r.startContainer, surf) || surf;
  const { before, after } = neighbourAtoms(r.startContainer, r.startOffset, root);
  const a = before || after;
  return !!censorAncestor(a || r.startContainer, surf);
}
function pendingCensorAt(r) {
  if (!censorPending) return null;
  if (!censorPending.node.isConnected || !samePlace(censorPending.node, censorPending.off, r.startContainer, r.startOffset)) {
    censorPending = null;
    return null;
  }
  return censorPending.on;
}
function setCensorPending(on, r, surf) {
  censorPending = on === caretCensored(r, surf) ? null : { on, node: r.startContainer, off: r.startOffset };
}
// What the button shows: for a caret the state typing would get, for a
// selection whether all of it is censored. (Read from a copy of just the
// selected content, so dragging a selection across a long note stays cheap.)
function censorStateAt(r, surf) {
  if (r.collapsed) { const p = pendingCensorAt(r); return p !== null ? p : caretCensored(r, surf); }
  if (censorAncestor(r.commonAncestorContainer, surf)) return true;
  let any = false;
  const all = (function walk(n, inMark) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.data) { any = true; if (!inMark) return false; } }
      else if (c.nodeType === 1 && !isSelMarker(c)) {
        if (isMediaEl(c)) { any = true; if (!inMark) return false; }
        else if (!walk(c, inMark || isCensorEl(c))) return false;
      }
    }
    return true;
  })(r.cloneContents(), false);
  return any && all;
}
// Censors (on=true) or uncensors (on=false) exactly the characters in a range,
// leaving every other format alone. Returns the first and last atom, or null.
function setCensorRange(range, surf, on) {
  const r = splitRangeEnds(range);
  const atoms = atomsIn(r, surf);
  if (!atoms.length) return null;
  if (on === undefined) on = !atoms.every(a => censorAncestor(a, surf));
  const lines = new Set(atoms.map(a => lineOf(a, surf) || alignBlockOf(a, surf) || surf));
  if (on) {
    for (const a of atoms) if (!censorAncestor(a, surf)) {
      const sp = censorMark(document.createElement("span"));
      a.parentNode.insertBefore(sp, a);
      sp.appendChild(a);
    }
  } else {
    for (let i = 0; i < atoms.length;) {
      const c = censorAncestor(atoms[i], surf);
      if (!c) { i++; continue; }
      let j = i;
      while (j + 1 < atoms.length && censorAncestor(atoms[j + 1], surf) === c) j++;
      const mid = isolate(c, atoms[i], atoms[j]);
      // The mark comes off; anything else the element carried (a size the
      // browser put on it, say) stays.
      uncensorMark(mid);
      if (!mid.attributes.length) unwrapEl(mid);
      i = j + 1;
    }
  }
  for (const l of lines) if (l.isConnected) tidyInline(l);
  return { first: atoms[0], last: atoms[atoms.length - 1], on };
}
// The browser copies the LOOK of censored text (transparent ink on a black box)
// onto what is typed after censored text is deleted, as inline styles: no
// data-censor mark, so it would be saved and exported as ordinary text while
// looking hidden on screen. That look is stripped wherever it is not a real mark.
function scrubCensorLook(root) {
  if (!root || !root.querySelectorAll) return;
  let leaked = false;
  for (const el of [...root.querySelectorAll("font[color], [style*='color']")]) {
    if (inMedia(el)) continue;
    const c = el.tagName === "FONT" && el.hasAttribute("color") ? el.getAttribute("color") : el.style.color;
    if (!c || cssColorHex(c) !== "transparent") continue;
    leaked = true;
    if (el.tagName === "FONT") el.removeAttribute("color");
    el.style.removeProperty("color");
  }
  if (!leaked) return;
  for (const el of [...root.querySelectorAll("[style*='background']")]) {
    if (inMedia(el) || isCensorEl(el)) continue;
    const b = cssColorHex(el.style.backgroundColor);
    if (b === "#000" || b === "#000000") el.style.removeProperty("background-color");
  }
  for (const el of [...root.querySelectorAll("font, span")]) {
    if (inMedia(el) || isMediaEl(el) || isCensorEl(el) || isSelMarker(el)) continue;
    if (!el.getAttribute("style")) el.removeAttribute("style");
    if (!el.attributes.length) unwrapEl(el);
  }
}
function toggleCensor() {
  if (trashViewId || backupView || syncing) return;
  const surf = restoreSelection();
  if (!surf) { status("Put the cursor in the text first", true); return; }
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let r = sel.getRangeAt(0);
  if (r.collapsed) {
    // Nothing selected: switch the state typing will get here, like bold.
    const now = censorStateAt(r, surf);
    setCensorPending(!now, r, surf);
    syncFmtState();
    status(now ? "Censor off: what you type now stays readable" : "Censor on: what you type now is censored");
    return;
  }
  markFormatStep();
  ensureLines(surf);
  r = sel.getRangeAt(0);
  const res = setCensorRange(r, surf);
  if (!res) { status("Select some text to censor", true); return; }
  selectAtoms(res.first, res.last);
  rememberSelection();
  markDirtyFromFormatting();
  syncFmtState();
}
$("fmt-censor").addEventListener("mousedown", e => e.preventDefault());
$("fmt-censor").onclick = toggleCensor;

// Clear formatting: bold, italic, underline, strikethrough, fonts, sizes,
// colours and highlights come off the selection. Censoring stays (it is a
// redaction, not a look) and so do links and paragraph alignment. Done here
// rather than with the browser's removeFormat, which "clears" text by writing
// the editor's own colours onto it, censored text included.
function clearFormatting() {
  if (trashViewId || backupView || syncing) return;
  const surf = restoreSelection();
  if (!surf) { status("Select the text to clear first", true); return; }
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { status("Select the text to clear first", true); return; }
  markFormatStep();
  ensureLines(surf);
  const r = splitRangeEnds(sel.getRangeAt(0));
  const atoms = atomsIn(r, surf);
  if (!atoms.length) return;
  const lines = new Set(atoms.map(a => lineOf(a, surf) || alignBlockOf(a, surf) || surf));
  const fmtOf = a => {   // the outermost formatting element around an atom, inside its line
    let found = null;
    for (let n = a.parentNode; n && n !== surf && !isLineEl(n) && !isFrameEl(n) && !isStructEl(n); n = n.parentNode)
      if (n.nodeType === 1 && INLINE_FORMAT_EL.test(n.tagName) && !isCensorEl(n)) found = n;
    return found;
  };
  for (let guard = 0; guard < atoms.length * 8 + 64; guard++) {
    const i = atoms.findIndex(a => fmtOf(a));
    if (i < 0) break;
    const f = fmtOf(atoms[i]);
    let j = i;
    while (j + 1 < atoms.length && f.contains(atoms[j + 1])) j++;
    unwrapEl(isolate(f, atoms[i], atoms[j]));
  }
  // Styles the browser put on a censor mark itself go too; the mark stays.
  for (const a of atoms) { const c = censorAncestor(a, surf); if (c) c.removeAttribute("style"); }
  for (const l of lines) if (l.isConnected) tidyInline(l);
  selectAtoms(atoms[0], atoms[atoms.length - 1]);
  rememberSelection();
  markDirtyFromFormatting();
  syncFmtState();
}

// ---------- Typing and the censor state ----------
// The browser decides where typed text lands; the app then gives that text the
// censor state the user chose. Plans are made in beforeinput (what was
// selected, where the caret was) and carried out in input, once the text is in.
let typingPlan = null, deletePlan = null, compositionPlan = null, inPlainPaste = false;
function insertPlanAt(r, surf) {
  let want = r.collapsed ? pendingCensorAt(r) : null;
  // Typing over a selection keeps the state of what it replaces, like bold.
  if (want === null && !r.collapsed) { const a = atomsTouched(r, surf)[0]; if (a) want = !!censorAncestor(a, surf); }
  if (want === null) return null;
  const root = lineOf(r.startContainer, surf) || surf;
  return { surf, want, root, start: textOffset(root, r.startContainer, r.startOffset) };
}
function carryOutInsert(plan) {
  const sel = window.getSelection();
  censorPending = null;   // used up: from here the caret sits in the text it chose
  if (!plan || !sel.rangeCount || !plan.root.isConnected) return;
  const end = sel.getRangeAt(0);
  const [sn, so] = pointAtOffset(plan.root, plan.start);
  const r = document.createRange();
  try { r.setStart(sn, so); r.setEnd(end.startContainer, end.startOffset); } catch { return; }
  if (r.collapsed) return;
  const res = setCensorRange(r, plan.surf, plan.want);
  if (!res) return;
  // The caret goes back to the end of what was typed, inside its new mark.
  const c = document.createRange();
  if (res.last.nodeType === 3) c.setStart(res.last, res.last.data.length); else c.setStartAfter(res.last);
  c.collapse(true);
  sel.removeAllRanges();
  sel.addRange(c);
}
$("edit-wrap").addEventListener("beforeinput", e => {
  const surf = surfaceOfNode(e.target);
  if (!surf || trashViewId || backupView) return;
  const t = e.inputType || "";
  // The browser's own undo (Edit menu, context menu) would rewind the text
  // behind the app's history: route it there instead.
  if (t === "historyUndo" || t === "historyRedo") {
    e.preventDefault();
    if (currentId) (t === "historyUndo" ? historyUndo : historyRedo)();
    return;
  }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (t === "insertText" || t === "insertReplacementText" || t === "insertFromDrop" || t === "insertFromPaste") {
    typingPlan = inPlainPaste ? null : insertPlanAt(r, surf);
  } else if (t.startsWith("delete")) {
    let ranges = [];
    try { ranges = e.getTargetRanges().map(s => { const x = document.createRange(); x.setStart(s.startContainer, s.startOffset); x.setEnd(s.endContainer, s.endOffset); return x; }); } catch {}
    if (!ranges.length && !r.collapsed) ranges = [r];
    const touched = ranges.flatMap(x => atomsTouched(x, surf));
    deletePlan = { surf, censored: touched.some(a => censorAncestor(a, surf)),
      backward: /Backward|ByCut|ByDrag/.test(t) || !r.collapsed };
  }
});
$("edit-wrap").addEventListener("input", e => {
  const surf = surfaceOfNode(e.target);
  if (!surf || e.isComposing) return;
  const t = e.inputType || "";
  const sel = window.getSelection();
  if (typingPlan && /^insert/.test(t) && !inPlainPaste) { const p = typingPlan; typingPlan = null; carryOutInsert(p); }
  if (deletePlan && /^delete/.test(t)) {
    const p = deletePlan;
    deletePlan = null;
    // Deleting censored text backwards and typing on continues censored, as a
    // deleted bold word's typing does; the button shows it, and one click ends it.
    if (p.censored && p.backward && sel.rangeCount && sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (!caretCensored(r, surf)) setCensorPending(true, r, surf);
    }
  }
  const r = sel.rangeCount ? sel.getRangeAt(0) : null;
  scrubCensorLook((r && lineOf(r.startContainer, surf)) || surf);
  syncFmtState();
});
// Composed input (accents typed with a dead key, an IME) cannot be redirected
// while it is being composed: the state is applied to the finished text.
$("edit-wrap").addEventListener("compositionstart", () => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { compositionPlan = null; return; }
  const r = sel.getRangeAt(0);
  const surf = surfaceOfNode(r.startContainer);
  compositionPlan = surf && !trashViewId && !backupView ? insertPlanAt(r, surf) : null;
});
$("edit-wrap").addEventListener("compositionend", () => {
  const p = compositionPlan;
  compositionPlan = null;
  if (p) setTimeout(() => { carryOutInsert(p); scrubCensorLook(p.root); markDirtyFromFormatting(); syncFmtState(); }, 0);
});

// ---------- Copying never carries censored text out ----------
// The clipboard and drag-and-drop are ways out of the app like any export: in
// what they carry, every censored run becomes a row of blocks, sized by the
// same coarse rule as the export's bars. Plain text only, since the rich copy
// would hold the hidden characters with nothing but a style over them.
function plainLines(root) {
  const out = [];
  let cur = "";
  const push = () => { out.push(cur); cur = ""; };
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) cur += c.data;
      else if (c.nodeType !== 1 || isMediaEl(c)) continue;
      else if (isCensorEl(c)) cur += "█".repeat(censorLenBucket((c.textContent || "").length));
      else if (c.tagName === "BR") push();
      else if (LINE_TAG(c.tagName) || c.tagName === "LI" || c.tagName === "TR") {
        if (cur) push();
        walk(c);
        if (cur || !c.textContent) push();
      } else if (c.tagName === "TD" || c.tagName === "TH") { walk(c); cur += "\t"; }
      else walk(c);
    }
  })(root);
  if (cur) push();
  return out.join("\n").replace(/\t(?=\n|$)/g, "");
}
function censoredCopy(r) {
  const holder = document.createElement("div");
  holder.appendChild(r.cloneContents());
  return holder.querySelector('[data-censor="1"]') ? plainLines(holder) : null;
}
// surf bounds the search for an enclosing mark; without one, the whole page.
function rangeTouchesCensor(r, surf) {
  if (censorAncestor(r.startContainer, surf) || censorAncestor(r.endContainer, surf)) return true;
  return !!r.cloneContents().querySelector('[data-censor="1"]');
}
// The selection, widened so a mark it starts or ends inside goes whole, when it
// touches censored text anywhere on the page (the note, or the reference pane
// of the second screen, which shows the same marks); else null.
function censoredSelection() {
  const sel = window.getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || r.collapsed || !rangeTouchesCensor(r, null)) return null;
  const c = r.cloneRange();
  const s = censorAncestor(c.startContainer, null), en = censorAncestor(c.endContainer, null);
  if (s) c.setStartBefore(s);
  if (en) c.setEndAfter(en);
  return c;
}
// What a censored copy or drag was, in runs of { t: text, c: censored }, line
// by line exactly as plainLines writes it. Kept in memory only (never on the
// clipboard, which gets the blocks), so pasting or dropping it back into a note
// brings the text back still censored instead of as a row of blocks. Dropped
// at lock, with the rest of the decrypted vault.
let appClip = null, appDrag = null;   // { plain, segs }
function copySegments(r) {
  const holder = document.createElement("div");
  holder.appendChild(r.cloneContents());
  const toks = [];
  let line = false;   // the current line holds something
  const add = (t, c) => { if (t) { toks.push({ t, c }); line = true; } };
  const push = () => { toks.push({ t: "\n", c: false }); line = false; };
  (function walk(n, c) {
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3) add(ch.data, c);
      else if (ch.nodeType !== 1 || isMediaEl(ch)) continue;
      else if (isCensorEl(ch)) add(ch.textContent || "", true);
      else if (ch.tagName === "BR") push();
      else if (LINE_TAG(ch.tagName) || ch.tagName === "LI" || ch.tagName === "TR") {
        if (line) push();
        walk(ch, c);
        if (line || !ch.textContent) push();
      } else if (ch.tagName === "TD" || ch.tagName === "TH") { walk(ch, c); add("\t", false); }
      else walk(ch, c);
    }
  })(holder, false);
  // plainLines' last steps: no line break after the last line, no tab ending a row.
  if (toks.length && toks[toks.length - 1].t === "\n" && !line) toks.pop();
  const segs = [];
  toks.forEach((tk, i) => {
    if (tk.t === "\t" && (i === toks.length - 1 || toks[i + 1].t === "\n")) return;
    const last = segs[segs.length - 1];
    if (last && last.c === tk.c) last.t += tk.t; else segs.push({ ...tk });
  });
  return segs;
}
// Puts the runs in at the caret (over the selection), each censored or not as
// it was. Line breaks go in on their own: a break typed inside a mark copies an
// empty mark onto the new line, which would make the next run censored.
function insertSegments(segs) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const surf = surfaceOfNode(sel.getRangeAt(0).startContainer);
  if (!surf) return;
  const run = (t, c) => {
    const r = sel.getRangeAt(0);
    const root = lineOf(r.startContainer, surf) || surf;
    const plan = { surf, want: c, root, start: textOffset(root, r.startContainer, r.startOffset) };
    document.execCommand("insertText", false, t);
    carryOutInsert(plan);
  };
  inPlainPaste = true;
  try {
    if (!sel.isCollapsed) document.execCommand("delete");
    for (const sg of segs) {
      sg.t.split("\n").forEach((t, i) => {
        if (!sel.rangeCount) return;
        if (i > 0) {
          document.execCommand("insertParagraph");
          const line = sel.rangeCount && lineOf(sel.getRangeAt(0).startContainer, surf);
          if (line) dropEmptyMarks(line);
        }
        if (t) run(t, sg.c);
      });
    }
  } finally { inPlainPaste = false; }
  ensureLines(surf);
  scrubCensorLook(surf);
  syncFmtState();
}
// A censor mark around nothing (no text, no attachment) marks nothing: it only
// makes whatever is typed there next censored.
function dropEmptyMarks(root) {
  for (const m of [...root.querySelectorAll('[data-censor="1"]')]) if (!atomsOf(m).length) unwrapEl(m);
}
// The clipboard may hand line breaks back as \r\n (Windows): compare without them.
const sameClipText = (a, b) => String(a).replace(/\r\n?/g, "\n") === String(b).replace(/\r\n?/g, "\n");
for (const type of ["copy", "cut"]) document.addEventListener(type, e => {
  appClip = null;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;   // a field's own text
  const c = censoredSelection();
  if (!c) return;
  e.preventDefault();
  const plain = censoredCopy(c) || "";
  e.clipboardData.setData("text/plain", plain);
  appClip = { plain, segs: copySegments(c) };
  const surf = surfaceOfNode(c.startContainer);
  if (type === "cut" && surf && surf.isContentEditable && !trashViewId && !backupView && !syncing) document.execCommand("delete");
});

// Every format the browser applies is written as a styled span, never as a
// <font> tag the sanitizer would strip: from the first time a page is entered.
$("edit-wrap").addEventListener("focusin", () => { try { document.execCommand("styleWithCSS", false, true); } catch {} });

// Listened for only once every script has loaded: the password field's autofocus
// can move the selection while the later files (lines.js) are still on their way.
document.addEventListener("DOMContentLoaded", () => document.addEventListener("selectionchange", () => {
  const r = currentEditorRange();
  if (!r) return;
  // A censor state chosen at the caret lapses when the caret moves.
  if (censorPending) pendingCensorAt(r);
  rememberSelection();
  syncFmtState();
}));
// Ctrl+B/I/U land in the editor natively; route them through runFmt so the
// dirty flag and the autosave rules stay consistent.
document.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  // Undo/redo is ours, not the browser's: the native contenteditable stack
  // knows nothing about pages, designs or attachments, and letting it run would
  // put the text and the note structure out of step. Only for the note itself
  // (its pages and its title): in the search box or a dialog's field Ctrl+Z
  // undid the NOTE behind it instead of the typing in the field.
  if (k === "z" || k === "y") {
    if (!vault || !currentId || backupView || trashViewId || uiLayerOpen()) return;
    const t = e.target;
    if (t && t !== $("title") && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    e.preventDefault();
    if (k === "y" || e.shiftKey) historyRedo(); else historyUndo();
    return;
  }
  const cmd = k === "b" ? "bold" : k === "i" ? "italic" : k === "u" ? "underline" : null;
  if (!cmd || !editorHasFocus(e.target)) return;
  e.preventDefault();
  rememberSelection();
  runFmt(cmd);
});
$("undo-btn").onclick = () => historyUndo();
$("redo-btn").onclick = () => historyRedo();
