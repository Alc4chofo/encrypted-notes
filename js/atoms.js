// notes: Atoms: the characters and attachments a format sits on.
"use strict";

// ---------- Atoms: the characters a format sits on ----------
// Text and inline attachments, in document order. Placeholder text inside an
// attachment ("Decrypting...") is part of the attachment, not of the note.
const inMedia = n => { for (let p = n.parentNode; p; p = p.parentNode) if (isMediaEl(p)) return true; return false; };
function atomsOf(root) {
  const out = [];
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.data) out.push(c); }
      else if (c.nodeType === 1 && !isSelMarker(c)) { if (isMediaEl(c)) { if (!isFloatEl(c)) out.push(c); } else walk(c); }
    }
  })(root);
  return out;
}
const atomLen = a => a.nodeType === 3 ? a.data.length : 1;
const childIndex = n => Array.prototype.indexOf.call(n.parentNode.childNodes, n);
const atomStart = a => a.nodeType === 3 ? [a, 0] : [a.parentNode, childIndex(a)];
// Is the boundary point (n1,o1) before the point (n2,o2)?
function pointBefore(n1, o1, n2, o2) {
  const r = document.createRange();
  r.setStart(n2, o2);
  return r.comparePoint(n1, o1) < 0;
}
// The atoms on either side of a caret inside root.
function neighbourAtoms(node, off, root) {
  if (node.nodeType === 3 && node.data && off > 0 && off < node.data.length && !inMedia(node)) return { before: node, after: node };
  let before = null, after = null;
  for (const a of atomsOf(root)) {
    const [n, o] = atomStart(a);
    if (a === node ? off > 0 : pointBefore(n, o, node, off)) before = a;
    else { after = a; break; }
  }
  return { before, after };
}
// Characters from the start of root to a point (an attachment counts as one).
function textOffset(root, node, off) {
  let k = 0;
  for (const a of atomsOf(root)) {
    if (a === node) return k + off;
    const [n, o] = atomStart(a);
    if (!pointBefore(n, o, node, off)) break;
    k += atomLen(a);
  }
  return k;
}
// The point that many characters into root (the end of a text it lands at the
// end of, so a range starting there takes in nothing before it).
function pointAtOffset(root, k) {
  let last = null;
  for (const a of atomsOf(root)) {
    if (a.nodeType === 3) { if (k <= a.data.length) return [a, k]; k -= a.data.length; }
    else { if (k <= 0) return atomStart(a); k -= 1; }
    last = a;
  }
  if (last) return last.nodeType === 3 ? [last, last.data.length] : [last.parentNode, childIndex(last) + 1];
  return [root, root.childNodes.length];
}
// Same caret place: nothing typed or attached lies between the two points.
function samePlace(n1, o1, n2, o2) {
  const r = document.createRange();
  if (pointBefore(n2, o2, n1, o1)) { r.setStart(n2, o2); r.setEnd(n1, o1); }
  else { r.setStart(n1, o1); r.setEnd(n2, o2); }
  return r.toString() === "" && !r.cloneContents().querySelector(".inline-media");
}
// Splits the text at the ends of a range, so every text node is either wholly
// inside it or wholly outside; returns the equivalent range.
function splitRangeEnds(r) {
  let sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
  if (ec.nodeType === 3 && eo > 0 && eo < ec.data.length) ec.splitText(eo);
  if (sc.nodeType === 3 && so > 0 && so < sc.data.length) {
    const right = sc.splitText(so);
    if (ec === sc) { ec = right; eo -= so; }
    sc = right; so = 0;
  }
  const out = document.createRange();
  out.setStart(sc, so);
  out.setEnd(ec, eo);
  return out;
}
// The atoms lying wholly inside a range.
function atomsIn(r, surf) {
  const c = r.commonAncestorContainer;
  const root = c.nodeType === 1 ? c : c.parentNode;
  return atomsOf(root.contains(surf) ? surf : root).filter(a => {
    const [n, o] = atomStart(a);
    return !pointBefore(n, o, r.startContainer, r.startOffset) &&
      !pointBefore(r.endContainer, r.endOffset, ...(a.nodeType === 3 ? [a, a.data.length] : [a.parentNode, childIndex(a) + 1]));
  });
}
// The atoms a range touches with at least one character, without splitting anything.
function atomsTouched(r, surf) {
  const c = r.commonAncestorContainer;
  const root = c.nodeType === 1 ? c : c.parentNode;
  return atomsOf(root.contains(surf) ? surf : root).filter(a => {
    if (!r.intersectsNode(a)) return false;
    if (a.nodeType !== 3) return true;
    if (a === r.startContainer && r.startOffset >= a.data.length) return false;
    if (a === r.endContainer && r.endOffset === 0) return false;
    return true;
  });
}
function unwrapEl(el) {
  while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
  el.remove();
}
// Cuts an inline element in three around the atoms first..last (both inside
// it) and returns the middle part, which holds exactly them. The parts before
// and after keep the element's formatting.
function isolate(el, first, last) {
  const tail = document.createRange();
  tail.setStartAfter(last);
  tail.setEnd(el, el.childNodes.length);
  if (!tail.collapsed) { const t = el.cloneNode(false); t.appendChild(tail.extractContents()); el.after(t); }
  const head = document.createRange();
  head.setStart(el, 0);
  head.setEndBefore(first);
  if (!head.collapsed) { const h = el.cloneNode(false); h.appendChild(head.extractContents()); el.before(h); }
  return el;
}
const INLINE_FORMAT_EL = /^(B|I|U|S|STRIKE|STRONG|EM|FONT|SPAN|SUB|SUP)$/;
// Inline wrappers a split left empty go, and censor marks that ended up side by
// side become one.
function tidyInline(root) {
  for (const el of [...root.querySelectorAll("b,i,u,s,strike,strong,em,font,span,sub,sup,a")].reverse()) {
    if (isMediaEl(el) || isSelMarker(el) || inMedia(el)) continue;
    if (!el.firstChild || (el.textContent === "" && !el.querySelector("br,.inline-media,[data-sel]"))) el.remove();
  }
  for (const sp of [...root.querySelectorAll('span[data-censor="1"]')]) {
    if (!sp.isConnected || !isBareMark(sp)) continue;
    for (;;) {
      let n = sp.nextSibling;
      while (n && n.nodeType === 3 && !n.data) { const x = n.nextSibling; n.remove(); n = x; }
      if (!isBareMark(n)) break;
      while (n.firstChild) sp.appendChild(n.firstChild);
      n.remove();
    }
  }
}
function selectAtoms(first, last) {
  const r = document.createRange();
  if (first.nodeType === 3) r.setStart(first, 0); else r.setStartBefore(first);
  if (last.nodeType === 3) r.setEnd(last, last.data.length); else r.setEndAfter(last);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}
