// notes: The line model: one block per line in the editor.
"use strict";

// ---------- Lines ----------
// The editor works in LINES: every visual line of a note is a <div> of its own,
// directly in the page or in a design frame. That is what lets alignment, Enter
// and censoring act on exactly the line or paragraph the caret is in. Stored
// bodies keep their old shape (plain lines joined by "\n", a styled line as
// <div style>, tables, lists and frames as blocks), so older copies of the app
// read them unchanged. normalizeLines turns that shape, or whatever the browser
// produced while typing, into one <div> per line, by the same rules the browser
// lays the markup out with under white-space: pre-wrap, so nothing moves:
//   - "\n" and <br> end a line, and an empty line between two breaks is a line;
//   - a break at the end of a run adds no line ("a\n" is one line), while one at
//     its start does ("<div>b</div>\nc" has an empty line between b and c);
//   - a table, a list, a frame and a styled line sit on lines of their own, and
//     a plain <div> just contributes the lines it holds.
// Formatting that spans a break (<b>a\nb</b>) is cloned onto each line, and a
// table or list found inside a censored span takes the censoring down into its
// own text, so restructuring can never uncensor anything.
const LINE_TAG = t => t === "DIV" || t === "P";
const isFrameEl = n => !!n && n.nodeType === 1 && LINE_TAG(n.tagName) &&
  (n.getAttribute("data-frame") === "top" || n.getAttribute("data-frame") === "bottom");
const isLineEl = n => !!n && n.nodeType === 1 && LINE_TAG(n.tagName) && !isFrameEl(n);
const isMediaEl = n => !!n && n.nodeType === 1 && !!n.classList && n.classList.contains("inline-media");
// Pinned pictures and tables sit at their own spot on the page, out of the text flow.
const isFloatEl = n => !!n && n.nodeType === 1 && !!n.classList && n.classList.contains("floating");
// The two zero-size markers keepSelection parks the selection on while lines are rebuilt.
const isSelMarker = n => !!n && n.nodeType === 1 && n.hasAttribute("data-sel");
const isCensorEl = n => !!n && n.nodeType === 1 && n.getAttribute("data-censor") === "1";
// Makes el a censor mark. Spell-checking is off inside it: squiggles under a bar
// would show where its words end and which are misspelt. (spellcheck is a live
// attribute only; the serializer never writes it.)
function censorMark(el) {
  el.setAttribute("data-censor", "1");
  el.setAttribute("spellcheck", "false");
  return el;
}
function uncensorMark(el) {
  el.removeAttribute("data-censor");
  el.removeAttribute("spellcheck");
}
// A mark carrying nothing else, which can merge with a neighbouring one.
const isBareMark = n => !!n && n.nodeType === 1 && n.tagName === "SPAN" && isCensorEl(n) &&
  [...n.attributes].every(a => a.name === "data-censor" || a.name === "spellcheck");
// Structure that stays as it is: never split into lines, never put inside one.
const isStructEl = n => !!n && n.nodeType === 1 && /^(TABLE|UL|OL|LI|THEAD|TBODY|TFOOT|TR|TD|TH)$/.test(n.tagName);

// A line already in shape: no block inside it, no "\n", and no <br> except one
// placeholder at its very end (which is what gives an empty line its height).
function isCleanLine(el) {
  if (!isLineEl(el)) return false;
  let brs = 0, last = null, ok = true;
  (function scan(node) {
    for (const c of node.childNodes) {
      if (!ok) return;
      if (c.nodeType === 3) { if (c.data.includes("\n")) ok = false; else if (c.data) last = c; }
      else if (c.nodeType === 1) {
        if (isMediaEl(c)) { if (isFloatEl(c)) ok = false; else last = c; }
        else if (c.tagName === "BR") { brs++; last = c; }
        else if (LINE_TAG(c.tagName) || isStructEl(c)) ok = false;
        else if (!isSelMarker(c)) scan(c);
      }
    }
  })(el);
  return ok && (brs === 0 || (brs === 1 && !!last && last.tagName === "BR"));
}

// Flattens a run of nodes into pieces: { leaf, chain } for text, attachments and
// markers (chain = the inline elements around it, outermost first), LINE_BREAK,
// { open: style } / { close } around a plain <div>'s own lines, { block } for
// structure that stays whole and { float } for pinned items.
const LINE_BREAK = { br: true };
function flattenRun(nodes, chain, out) {
  for (const c of nodes) {
    if (c.nodeType === 3) {
      if (!c.data) continue;
      if (!c.data.includes("\n")) { out.push({ leaf: c, chain }); continue; }
      c.data.split("\n").forEach((part, i) => {
        if (i) out.push(LINE_BREAK);
        if (part) out.push({ leaf: document.createTextNode(part), chain });
      });
    } else if (c.nodeType === 1) {
      if (c.tagName === "BR") out.push(LINE_BREAK);
      else if (isSelMarker(c)) out.push({ leaf: c, chain, marker: true });
      else if (isFloatEl(c)) out.push({ float: c });
      else if (isMediaEl(c)) out.push({ leaf: c, chain });
      else if (isFrameEl(c) || isStructEl(c)) out.push({ block: c, chain });
      else if (LINE_TAG(c.tagName)) {
        out.push({ open: c.getAttribute("style") || "" });
        flattenRun([...c.childNodes], chain, out);
        out.push({ close: true });
      } else flattenRun([...c.childNodes], [...chain, c], out);
    }
  }
}
// The declarations of two style strings, the inner one winning.
function mergeStyle(outer, inner) {
  if (!outer) return inner || "";
  if (!inner) return outer;
  const decls = new Map();
  for (const s of [outer, inner]) for (const d of s.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) decls.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim());
  }
  return [...decls].map(([k, v]) => k + ":" + v).join(";");
}
// One line <div> from its pieces, re-creating the inline formatting around each
// piece (shared between neighbours, so "<b>ab</b>" stays one <b>).
function buildLine(pieces, style) {
  const div = document.createElement("div");
  if (style) div.setAttribute("style", style);
  const open = [];   // { orig, el }: clones of the formatting chain currently open
  for (const p of pieces) {
    let k = 0;
    while (k < open.length && k < p.chain.length && open[k].orig === p.chain[k]) k++;
    open.length = k;
    let parent = k ? open[k - 1].el : div;
    // A caret marker never opens formatting of its own (that would leave an
    // empty <b></b> behind once the marker is gone).
    if (!p.marker) for (let j = k; j < p.chain.length; j++) {
      const cl = p.chain[j].cloneNode(false);
      parent.appendChild(cl);
      open.push({ orig: p.chain[j], el: cl });
      parent = cl;
    }
    parent.appendChild(p.leaf);
  }
  if (!pieces.some(p => !p.marker)) div.appendChild(document.createElement("br"));
  return div;
}
function appendToLine(line, pieces) {
  const br = line.lastChild && line.lastChild.nodeType === 1 && line.lastChild.tagName === "BR" ? line.lastChild : null;
  for (const p of pieces) line.insertBefore(p.leaf, br);
}
// Wraps every piece of text and every attachment under root in a censor mark,
// for structure lifted out of a censored span.
function censorizeAll(root) {
  const atoms = [];
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.data && !/^(TABLE|THEAD|TBODY|TFOOT|TR|UL|OL)$/.test(n.tagName)) atoms.push(c); }
      else if (c.nodeType === 1 && !isCensorEl(c)) { if (isMediaEl(c)) { if (!isFloatEl(c)) atoms.push(c); } else walk(c); }
    }
  })(root);
  for (const a of atoms) {
    const sp = censorMark(document.createElement("span"));
    a.parentNode.insertBefore(sp, a);
    sp.appendChild(a);
  }
}
function linesFromPieces(pieces) {
  const made = [], styles = [""];
  let seg = [], carry = [];
  const lastLine = () => { for (let i = made.length - 1; i >= 0; i--) if (isLineEl(made[i])) return made[i]; return null; };
  const end = byBreak => {
    const s = carry.length ? carry.concat(seg) : seg;
    carry = []; seg = [];
    if (byBreak || s.some(p => !p.marker)) made.push(buildLine(s, styles[styles.length - 1]));
    else if (s.length) {
      // Only a caret marker, at the end of a run: it belongs at the end of the
      // line before, not on a line of its own that the layout does not have.
      const ln = lastLine();
      if (ln) appendToLine(ln, s); else carry = s;
    }
  };
  for (const p of pieces) {
    if (p === LINE_BREAK) end(true);
    else if (p.open !== undefined) { end(false); styles.push(mergeStyle(styles[styles.length - 1], p.open)); }
    else if (p.close) { end(false); styles.pop(); }
    else if (p.float) made.push(p.float);
    else if (p.block) {
      end(false);
      if (p.chain.some(isCensorEl)) censorizeAll(p.block);
      if (isFrameEl(p.block)) normalizeLines(p.block);
      made.push(p.block);
    } else seg.push(p);
  }
  end(false);
  if (carry.length) { const ln = lastLine(); if (ln) appendToLine(ln, carry); else made.push(buildLine(carry, "")); }
  return made;
}
// Puts a container (a page, a frame, a fragment about to become one) into line
// form. Lines already in shape stay exactly as they are, keeping their identity
// (so a live caret or a selected picture is not disturbed); only the runs of
// anything else are rebuilt. Returns true when it changed something.
function normalizeLines(container) {
  let changed = false, run = [];
  const flush = () => {
    if (!run.length) return;
    const anchor = document.createComment("");
    container.insertBefore(anchor, run[0]);
    const pieces = [];
    flattenRun(run, [], pieces);
    const made = linesFromPieces(pieces);
    for (const n of made) container.insertBefore(n, anchor);
    // What is left of the run is husks: emptied wrappers and the text that was split.
    for (const n of run) if (n.parentNode === container && !made.includes(n)) n.remove();
    anchor.remove();
    run = [];
    changed = true;
  };
  for (const c of [...container.childNodes]) {
    if ((c.nodeType === 3 && !c.data) || c.nodeType === 8) { c.remove(); changed = true; continue; }
    if (isCleanLine(c) || isStructEl(c) || isFloatEl(c)) { flush(); continue; }
    if (isFrameEl(c)) { flush(); if (normalizeLines(c)) changed = true; continue; }
    run.push(c);
  }
  flush();
  return changed;
}
function linesNeeded(container) {
  for (const c of container.childNodes) {
    if (isFrameEl(c)) { if (linesNeeded(c)) return true; continue; }
    if (!(isCleanLine(c) || isStructEl(c) || isFloatEl(c))) return true;
  }
  return false;
}
// Runs fn, which may rebuild DOM under root, and puts the selection back on the
// same characters afterwards. The selection rides along on two marker elements:
// a rebuild moves nodes around, which would otherwise reset it.
function keepSelection(root, fn) {
  const sel = window.getSelection();
  let s = null, e = null;
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (root.contains(r.startContainer) && root.contains(r.endContainer)) {
      const mark = () => { const m = document.createElement("span"); m.setAttribute("data-sel", ""); return m; };
      if (!r.collapsed) { e = mark(); const re = r.cloneRange(); re.collapse(false); re.insertNode(e); }
      s = mark();
      const rs = r.cloneRange(); rs.collapse(true); rs.insertNode(s);
    }
  }
  try { return fn(); }
  finally { if (s) selectFromMarkers(s, e); }
}
function selectFromMarkers(s, e) {
  if (!s.isConnected) { s.remove(); if (e) e.remove(); return; }
  const r = document.createRange();
  r.setStartBefore(s);
  if (e && e.isConnected) r.setEndBefore(e); else r.collapse(true);
  const parents = new Set([s.parentNode, e && e.parentNode]);
  s.remove();
  if (e) e.remove();
  // The markers split the text they were dropped into; join it back up. The
  // range is live, so it follows the merge.
  for (const p of parents) if (p && p.isConnected) p.normalize();
  snapToText(r);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
// A boundary between two nodes moves into the text beside it, where the caret
// of a typing user actually lives.
function snapToText(r) {
  const snap = (node, off) => {
    if (node.nodeType !== 1) return [node, off];
    const before = node.childNodes[off - 1], after = node.childNodes[off];
    if (before && before.nodeType === 3) return [before, before.data.length];
    if (after && after.nodeType === 3) return [after, 0];
    return [node, off];
  };
  const [sc, so] = snap(r.startContainer, r.startOffset);
  if (r.collapsed) { r.setStart(sc, so); r.collapse(true); return; }
  const [ec, eo] = snap(r.endContainer, r.endOffset);
  r.setStart(sc, so);
  r.setEnd(ec, eo);
}
// Makes sure the surface is in line form before an operation that works on
// lines. Lines already in shape are left alone, so this is cheap when nothing
// strayed (typing into an emptied page leaves bare text the browser never
// wraps, for one).
function ensureLines(surface) {
  if (!surface || !linesNeeded(surface)) return false;
  keepSelection(surface, () => normalizeLines(surface));
  return true;
}
// A stored body as page content: sanitized, attachment rows packed, in lines.
function bodyFragment(body, bodyV) {
  let frag;
  if (bodyV === 2) frag = sanitizeBodyFragment(body || "");
  else {
    // Legacy plain text stays text: it only ever becomes text nodes.
    frag = document.createDocumentFragment();
    if (body) frag.appendChild(document.createTextNode(body));
  }
  packAttachmentRuns(frag);
  normalizeLines(frag);
  // An empty page still has one (empty) line, so the first thing typed lands in
  // a line like everything after it: into a bare page the browser types text
  // that belongs to no line at all.
  if (!frag.firstChild) frag.appendChild(buildLine([], ""));
  return frag;
}
// sanitize + lines + serialize, for code that rewrites stored bodies.
function canonicalBody(holder) {
  normalizeLines(holder);
  const acc = { s: "" };
  serializeBodyInto(holder, acc);
  return acc.s;
}
// The line (a <div> directly in a page or a frame) holding a node, or null.
function lineOf(node, surf) {
  for (let n = node && (node.nodeType === 1 ? node : node.parentNode); n && n !== surf; n = n.parentNode) {
    if (isLineEl(n) && n.parentNode && (n.parentNode === surf || isFrameEl(n.parentNode))) return n;
    if (isStructEl(n)) return null;   // inside a table or a list
  }
  return null;
}
// A line with nothing typed on it: no attachment and no visible character.
const isEmptyLine = el => !el.querySelector(".inline-media") && !/[^\s\u200b]/.test(el.textContent || "");

// ----- save side: canonical serializer (same allowlist, string out) -----
// Line breaks (from <br> or block boundaries) canonicalize to "\n"; inline media
// serialize from validated data-mid/data-kind ALONE (never from the live child),
// so a device missing the bytes still round-trips the reference losslessly and no
// blob:/data: src can ever reach the stored string. serialize(sanitize(B)) === B.
// acc.at marks where a line is known to begin without a "\n": the start of a
// container (the note, a frame, a list item, a cell) and the end of a block.
// Writing a "\n" there as well put an empty line after every centred line, frame
// or table each time the note was reopened, because under pre-wrap a newline
// right after a block is an empty line of its own.
// acc.pend: a plain line has just ended. Its "\n" is only written if more
// inline content follows directly (a picture dropped after the last line, say),
// which would otherwise join the line above it on the next load.
function serializeBodyInto(node, acc) {
  if (acc.at === undefined) acc.at = acc.s.length;
  const lineStart = () => acc.s.length === acc.at || acc.s.endsWith("\n");
  const inline = () => { if (acc.pend) { if (!lineStart()) acc.s += "\n"; acc.pend = false; } };
  node.childNodes.forEach(child => {
    if (child.nodeType === 3) {
      if (!child.data) return;
      inline();
      acc.s += escapeHtml(child.data);
    } else if (child.nodeType === 1) {
      const im = validInlineMedia(child);
      if (im || child.tagName === "BR" || child.tagName === "A" || INLINE_FMT_TAGS.has(child.tagName)) inline();
      else if (EDITOR_BLOCK_TAGS.has(child.tagName) || LIST_TAGS.has(child.tagName) || TABLE_TAGS.has(child.tagName))
        acc.pend = false;   // a block writes its own line break
      if (im) {
        const lay = mediaLayout(child);
        acc.s += '<span class="inline-media" data-mid="' + im.mid + '" data-kind="' + im.kind + '"' +
          (lay.w ? ' data-w="' + lay.w + '"' : "") + (lay.align ? ' data-align="' + lay.align + '"' : "") +
          (lay.fx !== null ? ' data-fx="' + lay.fx + '" data-fy="' + lay.fy + '"' : "") + ">" +
          (im.kind === "video" ? "<video></video>" : "<img>") + "</span>";
      } else if (child.tagName === "BR") {
        acc.s += "\n";
      } else if (child.classList && child.classList.contains("inline-media")) {
        // inline-media span with an invalid id/kind: cannot reference real bytes - drop it
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName)) {
        // A block only survives as markup when it carries formatting we allow;
        // otherwise it collapses to a newline exactly as it always did, so an
        // unformatted note round-trips byte-identically to the old format.
        const st = sanitizeStyle(child.getAttribute("style"));
        const fr = child.getAttribute && child.getAttribute("data-frame");
        if (fr === "top" || fr === "bottom" || st) {
          if (!lineStart()) acc.s += "\n";
          acc.s += "<div" + (fr === "top" || fr === "bottom" ? ' data-frame="' + fr + '"' : "") +
            (st ? ' style="' + st + '"' : "") + ">";
          acc.at = acc.s.length;
          serializeBodyInto(child, acc);
          acc.s += "</div>";
          acc.at = acc.s.length;
        } else {
          if (!lineStart()) acc.s += "\n";
          serializeBodyInto(child, acc);
          acc.pend = true;
        }
      } else if (LIST_TAGS.has(child.tagName) || TABLE_TAGS.has(child.tagName)) {
        const tag = child.tagName.toLowerCase();
        const st = sanitizeStyle(child.getAttribute("style"));
        let attrs = st ? ' style="' + st + '"' : "";
        if (tag === "table") {
          const lay = mediaLayout(child);
          if (lay.fx !== null) attrs += ' data-fx="' + lay.fx + '" data-fy="' + lay.fy + '"';
          if (lay.w) attrs += ' data-w="' + lay.w + '"';
        }
        for (const a of ["colspan", "rowspan"]) {
          const v = parseInt(child.getAttribute(a) || "", 10);
          if (v > 1 && v <= 50) attrs += ` ${a}="${v}"`;
        }
        acc.s += "<" + tag + attrs + ">";
        acc.at = acc.s.length;
        serializeBodyInto(child, acc);
        acc.s += "</" + tag + ">";
        acc.at = acc.s.length;
      } else if (child.tagName === "A") {
        const href = safeHref(child.getAttribute("href"));
        if (!href) { serializeBodyInto(child, acc); return; }
        acc.s += '<a href="' + escapeHtml(href).replace(/"/g, "&quot;") + '">';
        serializeBodyInto(child, acc);
        acc.s += "</a>";
      } else if (INLINE_FMT_TAGS.has(child.tagName)) {
        const tag = INLINE_FMT_TAGS.get(child.tagName);
        const st = sanitizeStyle(child.getAttribute("style"), true);
        const censored = child.getAttribute("data-censor") === "1";
        if (tag === "span" && !st && !censored) { serializeBodyInto(child, acc); return; }
        acc.s += "<" + tag + (censored ? ' data-censor="1"' : "") + (st ? ' style="' + st + '"' : "") + ">";
        serializeBodyInto(child, acc);
        acc.s += "</" + tag + ">";
      } else {
        serializeBodyInto(child, acc);
      }
    }
  });
}
// ---- Editing surfaces ----
// A single-page note is edited in #editor, exactly as it always was. A paged
// note is edited in a stack of .sheet-body elements (one per page), all live at
// once. Everything below takes an explicit surface and defaults to the active
// one, so no single-page behaviour changes.
const pagedView = () => document.body.classList.contains("paged-view");
const surfaces = () => pagedView() ? [...$("sheets").querySelectorAll(".sheet-body")] : [$("editor")];
// The surface the caret is in, else the first one.
function activeSurface() {
  const list = surfaces();
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const hit = list.find(el => el.contains(node));
    if (hit) return hit;
  }
  const act = list.find(el => el === document.activeElement);
  return act || list[0] || $("editor");
}
const surfaceOfNode = node => surfaces().find(el => el.contains(node)) || null;

function getEditorBody(el) {
  const editor = el || activeSurface();
  // Normalize a visually-empty editor (a stray <br>, whitespace-only markup) to ""
  // so noteKey equality and the baseline comparison stay stable.
  if (!editor.querySelector("span.inline-media") && editor.textContent === "") return "";
  const acc = { s: "" };
  serializeBodyInto(editor, acc);
  return acc.s;
}

function editorHasInlineMedia() { return !!$("editor").querySelector("span.inline-media"); }
function editorHasFocus(target) {
  const list = surfaces();
  if (target && list.some(el => el.contains(target))) return true;
  if (list.includes(document.activeElement)) return true;
  const sel = window.getSelection();
  return !!(sel && sel.rangeCount && list.some(el => el.contains(sel.getRangeAt(0).commonAncestorContainer)));
}
// The live caret/selection if it is inside the editor (cloned so later DOM changes
// cannot mutate it out from under us), else null. Captured synchronously before any
// await so an inline paste lands where the caret actually was.
function currentEditorRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (surfaceOfNode(r.commonAncestorContainer)) return r.cloneRange();
  }
  return null;
}

// View-only overlay shown inside a wrapper while (or instead of) the decrypted
// media. It never changes data-mid/data-kind, so the reference still round-trips.
function inlinePlaceholder(state) {
  const box = mk("span", "inline-ph" + (state === "missing" || state === "corrupt" ? " warn" : ""));
  if (state === "video") { box.appendChild(mk("span", "inline-glyph", "▶")); box.appendChild(mk("span", null, "Play video")); }
  else if (state === "pdf") { box.appendChild(mk("span", "inline-glyph", "▤")); box.appendChild(mk("span", null, "Open PDF")); }
  else if (state === "text") { box.appendChild(mk("span", "inline-glyph", "≡")); box.appendChild(mk("span", null, "View text")); }
  else if (state === "file") { box.appendChild(mk("span", "inline-glyph", "⇓")); box.appendChild(mk("span", null, "Download file")); }
  else if (state === "missing") { box.appendChild(mk("span", "inline-glyph", "↓")); box.appendChild(mk("span", null, "Not on this device - Sync")); }
  else if (state === "corrupt") { box.appendChild(mk("span", "inline-glyph", "!")); box.appendChild(mk("span", null, "Attachment unavailable")); }
  else if (state === "blocked") { box.appendChild(mk("span", "inline-glyph", "!")); box.appendChild(mk("span", null, "Unsupported type")); }
  else { box.appendChild(mk("span", null, "Decrypting...")); }
  return box;
}
// Reserve the eventual display box (clamped to the 320x240 max, aspect kept) so
// the decrypted image paints in place instead of growing from a text pill and
// reflowing the rest of the note. No-op when dimensions are unknown.
const INLINE_MAX_W = 320, INLINE_MAX_H = 240;
function applyInlineSize(span, w, h) {
  // An explicit user size wins over the intrinsic one.
  // A resized image keeps the width the user chose, but the box still has to be
  // reserved: applyMediaLayout leaves height:auto, so the wrapper stayed ~30px
  // tall until the decrypt landed and the first pagination pass measured a page
  // that was about to double in height.
  if (mediaLayout(span).w) {
    applyMediaLayout(span);
    if (+w > 0 && +h > 0) span.style.aspectRatio = (+w) + " / " + (+h);
    return;
  }
  w = +w; h = +h;
  if (!(w > 0) || !(h > 0)) { span.style.width = span.style.height = ""; return; }
  const s = Math.min(1, INLINE_MAX_W / w, INLINE_MAX_H / h);
  span.style.width = Math.round(w * s) + "px";
  span.style.height = Math.round(h * s) + "px";
}
function setInlineState(span, state) { span.replaceChildren(inlinePlaceholder(state)); }
function setInlineImage(span, url, meta) {
  const img = document.createElement("img");
  img.alt = "";
  // An <img> is draggable by default, so grabbing the picture started a NATIVE
  // image drag (carrying the blob URL) instead of our reposition drag - the
  // browser then dropped a copy rather than moving the node. Only the wrapper
  // may start a drag.
  img.draggable = false;
  img.src = url;
  // Click-to-zoom parity with inline videos. contentEditable=false already stops
  // the caret landing inside; guard against a drag being read as a click.
  if (meta) {
    img.setAttribute("data-zoom", "1");
    let downX = 0, downY = 0;
    img.addEventListener("mousedown", e => { downX = e.clientX; downY = e.clientY; });
    img.addEventListener("click", e => {
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return;   // it was a drag
      e.preventDefault();
      const u = mediaUrls.get(meta.id);
      if (u) openLightbox(meta, u, false);
    });
  }
  // An image only gets its real height once the bytes are decoded, which is
  // long after pagination last measured the page. Re-flow when it lands, or a
  // page full of pictures silently stays oversized.
  img.addEventListener("load", () => { if (typeof scheduleRepaginate === "function") scheduleRepaginate(); });
  span.replaceChildren(img);
}
function buildInlineWrapper(mid, kind) {
  const span = document.createElement("span");
  span.className = "inline-media";
  span.setAttribute("data-mid", mid);
  span.setAttribute("data-kind", kind);
  span.contentEditable = "false";   // atomic: caret sits beside it; Backspace/Delete remove it whole
  span.draggable = true;            // reposition among the text (see the editor dragstart/drop handlers)
  setInlineState(span, "pending");
  return span;
}

// Decrypt each wrapper through the SAME FIFO + shared URL map the strip uses,
// guarded by editorSeq (a note switch cancels) AND isConnected (the node must
// still be in this editor), so a slow decrypt can never paint the wrong note.
function hydrateInlineMedia(gen, root) {
  const editor = root || $("editor");
  const wraps = [...editor.querySelectorAll("span.inline-media")];
  if (!wraps.length) return;
  const ctx = mediaCtx();
  const metaFor = mid => ((ctx && ctx.note && ctx.note.media) || []).find(m => m.id === mid) || null;
  idbKeys().then(keys => {
    if (gen !== editorSeq) return;
    const have = new Set(keys);
    for (const w of wraps) {
      if (gen !== editorSeq || !w.isConnected) continue;
      const mid = w.getAttribute("data-mid"), kind = w.getAttribute("data-kind");
      const meta = metaFor(mid);
      if (meta) applyInlineSize(w, meta.w, meta.h);
      if (!have.has(mid)) { setInlineState(w, "missing"); continue; }
      // Only images decrypt for a preview: every other kind is a static tile
      // that decrypts on click (lightbox for video/pdf/text, download for file).
      if (kind !== "image") {
        setInlineState(w, kind);
        w.onclick = () => openInlineMedia(w, mid, meta, kind);
        continue;
      }
      // No metadata entry means the body references an id that is not in
      // note.media (a corrupt/hand-edited state): show the missing tile rather
      // than guessing an invalid "image/*" Blob type.
      if (!meta) { setInlineState(w, "missing"); continue; }
      if (!isAllowedMediaType(meta.mime)) { setInlineState(w, "blocked"); continue; }
      queueInlineImage(gen, w, mid, meta.mime, meta);
    }
    // Every wrapper's size is settled here - video posters, "not on this
    // device" tiles and blocked tiles included. Only <img> had a load hook, so
    // without this a page full of videos or offline attachments grew past the
    // paper and never reflowed.
    scheduleRepaginate();
  }).catch(() => { if (gen === editorSeq) for (const w of wraps) if (w.isConnected) setInlineState(w, "missing"); });
}
function queueInlineImage(gen, span, mid, mime, meta) {
  decryptChain = decryptChain.then(async () => {
    if (gen !== editorSeq || !span.isConnected || !vault) return;
    const cached = mediaUrls.get(mid);
    if (cached) { setInlineImage(span, cached, meta); return; }
    try {
      const rec = await idbGet(mid);
      if (gen !== editorSeq || !span.isConnected || !vault) return;
      if (!rec) { setInlineState(span, "missing"); return; }
      if (mediaUrls.get(mid)) { setInlineImage(span, mediaUrls.get(mid), meta); return; }
      const plain = await decryptMedia(mid, rec.bytes);
      if (gen !== editorSeq || !span.isConnected || !vault) return;
      setInlineImage(span, getOrCreateMediaUrl(mid, mime, plain), meta);
    } catch {
      if (gen === editorSeq && span.isConnected) setInlineState(span, "corrupt");
    }
  }).catch(() => {});
}
// Inline non-image kinds, like strip tiles, never decrypt for a preview: click
// decrypts and either opens the lightbox (video/pdf/text - it owns and revokes
// that URL) or hands the bytes straight to a download (generic files). The
// editorSeq guard keeps a decrypt outliving a note switch from popping over the
// wrong note.
const KIND_FALLBACK_MIME = { video: "video/mp4", pdf: "application/pdf", text: "text/plain" };
async function openInlineMedia(span, mid, meta, kind) {
  const gen = editorSeq;
  const name = (meta && meta.name) || kind;
  status("Decrypting " + name + "...", false, true);
  let rec = null;
  try { rec = await idbGet(mid); } catch { rec = null; }
  if (gen !== editorSeq || !vault) { status(""); return; }
  if (!rec) { setInlineState(span, "missing"); status("Not on this device - Sync to fetch", true); return; }
  let plain;
  try { plain = await decryptMedia(mid, rec.bytes); }
  catch { if (vault) { setInlineState(span, "corrupt"); status("Attachment corrupted", true); } return; }
  // !vault: a lock landed mid-decrypt; never open the lightbox over the lock screen.
  if (gen !== editorSeq || !vault) { status(""); return; }
  status("");
  const mime = (meta && meta.mime) || KIND_FALLBACK_MIME[kind] || "application/octet-stream";
  if (kind === "file") { downloadPlain(name, mime, plain); return; }
  openLightbox(meta || { id: mid, mime, name }, mediaObjectUrl(mid, mime, plain), true);
}

// ----- inline media: insert / hydrate one / reposition / delete -----
// The node currently being dragged to reposition (module-scoped because the drop
// handler needs the exact node, and dataTransfer values are unreadable mid-drag).
let draggingInlineNode = null;
let dragGrab = null;   // where inside the image it was picked up, so it lands under the cursor
// The editing surface under a point, used for free placement (caretRangeAt only
// answers "which line", which is exactly what we do NOT want here).
function surfaceAtPoint(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const s = surfaceOfNode(el);
    if (s) return s;
  }
  return null;
}

// Insert an already-built wrapper at `range` (a caret captured before the async
// encrypt). If the range no longer lives in this editor - the note was reseated by
// ensureNoteForMedia/openNote, detaching the captured nodes - fall back to the end,
// so a paste into a not-yet-existing note still lands its media.
function insertInlineWrapper(wrapper, range) {
  // The target is whichever surface the caret was in - a page sheet for a paged
  // note, #editor otherwise. Hard-coding #editor dropped every attachment into
  // the hidden single-page editor while a paged note was open.
  const editor = (range && surfaceOfNode(range.commonAncestorContainer)) || activeSurface();
  let r;
  if (range && editor.contains(range.commonAncestorContainer)) {
    r = range.cloneRange();
    r.collapse(false);
  } else {
    r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
  }
  r.insertNode(wrapper);
  const after = document.createRange();
  after.setStartAfter(wrapper);
  after.collapse(true);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(after); }
  // Dropped past the last line it would sit in no line at all: give it one.
  ensureLines(editor);
  updateEditorEmpty();
}

// Hydrate a single wrapper (bytes just landed, or a reposition needs a repaint)
// through the same generation-guarded FIFO as the bulk hydrate.
function hydrateOneInline(span) {
  if (!span || !span.isConnected) return;
  const gen = editorSeq;
  const mid = span.getAttribute("data-mid"), kind = span.getAttribute("data-kind");
  if (!mid) return;
  const ctx = mediaCtx();
  const meta = ((ctx && ctx.note && ctx.note.media) || []).find(m => m.id === mid) || null;
  if (meta) applyInlineSize(span, meta.w, meta.h);
  if (kind !== "image") {
    setInlineState(span, kind);
    span.onclick = () => openInlineMedia(span, mid, meta, kind);
    return;
  }
  const mime = meta ? meta.mime : "image/*";
  if (!isAllowedMediaType(mime)) { setInlineState(span, "blocked"); return; }
  queueInlineImage(gen, span, mid, mime, meta);
}

// The node immediately before / after a COLLAPSED caret (for single-unit Backspace/
// Delete of an atomic wrapper). Returns null when the caret is inside text, so a
// normal character delete falls through to the browser.
function nodeBeforeCaret(r) {
  const c = r.startContainer, o = r.startOffset;
  if (c.nodeType === 3) return o === 0 ? c.previousSibling : null;
  return o > 0 ? c.childNodes[o - 1] : null;
}
function nodeAfterCaret(r) {
  const c = r.startContainer, o = r.startOffset;
  if (c.nodeType === 3) return o === c.data.length ? c.nextSibling : null;
  return o < c.childNodes.length ? c.childNodes[o] : null;
}
function wrapperOf(node) { return validInlineMedia(node) ? node : null; }

// Persist a body-only change (an inline delete or reposition) that fires no 'input'
// event. Debounced like typing so a burst of moves coalesces into one save; the
// dirty flag guards beforeunload until it lands.
function scheduleInlineSave() {
  if (trashViewId || !currentId) return;
  if (statusIsError) status("");
  updateEditorEmpty();
  if (!dirty) { dirty = true; renderList(); }
  if (!splitMode) {   // explicit-save session, same as typing (see the input handler)
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 400);
  }
  scheduleRepaginate();   // a page that lost a picture may take lines back from the next
  renderStatus();
}

// caretRangeFromPoint is WebKit/Blink; Firefox only has caretPositionFromPoint.
// Without this shim every point-based drop was a silent no-op there.
function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) {
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
  }
  return null;
}

// Reposition an inline wrapper to the caret under (x,y). Same node, moved: no
// re-encrypt, no new URL, no external content ever enters the editor.
function moveInlineNode(node, x, y) {
  // Works across every editing surface, so an image can be dragged to another
  // spot on the page OR onto a different page of the same note.
  if (!node || !surfaceOfNode(node)) return;
  const r = caretRangeAt(x, y);
  if (!r || !surfaceOfNode(r.commonAncestorContainer)) return;
  if (node.contains(r.startContainer) || node === r.startContainer) return;   // never into itself
  node.remove();
  r.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(after); }
  scheduleInlineSave();
}

// The empty-state placeholder (a <div> ignores the placeholder attribute).
function updateEditorEmpty() {
  const editor = $("editor");   // the placeholder only exists on the single-page surface
  editor.dataset.empty = (!editor.querySelector("span.inline-media") && editor.textContent === "") ? "true" : "false";
}

// setEditorBody: legacy plain text -> textContent (XSS-safe; newlines via pre-wrap);
// v2 HTML -> sanitize (defense in depth: a synced body is attacker-influenceable) then
// hydrate media. editorBaseline is captured AFTER the DOM is built so merely opening a
// note is never counted as an edit (no spurious v1->v2 migration or resync churn).
function setEditorBody(body, opts) {
  opts = opts || {};
  const gen = ++editorSeq;
  const editor = $("editor");
  // Both shapes are shown as lines: a legacy plain body only ever becomes text
  // nodes inside them, so it stays exactly as inert as textContent made it.
  editor.replaceChildren(bodyFragment(body, opts.bodyV));
  if (opts.bodyV === 2) {
    editorPlainOrig = null;
    hydrateInlineMedia(gen);
  } else editorPlainOrig = body || "";
  editorBaseline = getEditorBody(editor);
  updateEditorEmpty();
}
// Show the A4 sheets at whatever size the pane allows. The sheet's LAYOUT stays
// 210mm - that is the whole point, the page you see must be the page that
// prints - so this only scales what is painted, and takes back the space the
// scale frees with negative margins so the stack still scrolls naturally.
function fitSheets() {
  const box = $("sheets");
  if (!box || !document.body.classList.contains("paged-view")) return;
  const sheets = [...box.querySelectorAll(".sheet")];
  if (!sheets.length) return;
  const avail = box.clientWidth - 32;   // 16px clear on either side
  const natural = sheets[0].offsetWidth || 1;
  const k = Math.min(1, avail / natural);
  box.style.setProperty("--sheet-k", k.toFixed(4));
  for (const s of sheets) {
    const h = s.offsetHeight;
    // scale(k) leaves the layout box full size: pull the leftover back.
    s.style.marginBottom = (20 - h * (1 - k)) + "px";
    s.style.marginLeft = 16 + Math.max(0, (avail - natural * k) / 2) + "px";
    s.style.marginRight = (-natural * (1 - k)) + "px";
  }
}
addEventListener("resize", () => fitSheets());
// Build the sheet stack for a paged note. Every page is editable at once, so
// scrolling through them is the same document you export.
function renderSheets() {
  const n = viewedNote(), ps = notePages(n);
  const box = $("sheets");
  if (!ps) { document.body.classList.remove("paged-view"); box.innerHTML = ""; return; }
  const gen = ++editorSeq;
  document.body.classList.add("paged-view");
  box.innerHTML = "";
  const ro = !!trashViewId || !!backupView || syncing;
  const sectioned = hasSections(n);
  ps.forEach((p, i) => {
    const sec = pageSection(p);
    const sheet = mk("div", "sheet sec-" + sec + (i === currentPage ? " active" : ""));
    sheet.dataset.page = String(i);
    sheet.dataset.src = String(i);             // identity, kept while data-page is renumbered
    if (p.cont) sheet.dataset.cont = "1";      // a page the reflow made, and may take back
    const label = mk("div", "sheet-label");
    if (sectioned) label.appendChild(mk("span", "sec-chip sec-" + sec, SECTION_LABEL[sec]));
    label.appendChild(mk("span", "nm", p.name || "Page " + (i + 1)));
    label.appendChild(mk("span", "n", (i + 1) + " / " + ps.length));
    const bodyEl = mk("div", "sheet-body");
    bodyEl.contentEditable = ro ? "false" : "true";
    bodyEl.spellcheck = true;
    bodyEl.dataset.page = String(i);
    bodyEl.replaceChildren(bodyFragment(p.body, p.bodyV));
    sheet.appendChild(label);
    sheet.appendChild(bodyEl);
    box.appendChild(sheet);
  });
  editorPlainOrig = null;        // pages are always serialized as HTML
  hydrateInlineMedia(gen, box);  // images paint inside the sheets
  // A page stored longer than a sheet is split now, so what is on screen is
  // already what the PDF will print.
  editorBaseline = sheetsSnapshot();
  // Reflow once the sheets have really been laid out (a rAF here measures a
  // half-built page and finds nothing to split).
  fitSheets();
  setTimeout(() => {
    if (!pagedView()) return;
    if (repaginateDom()) { syncPagesFromDom(); renderPageTabs(); editorBaseline = sheetsSnapshot(); }
    fitSheets();                 // pages may have been added or removed
  }, 60);
}
// One string covering every page, so `dirty` works exactly as it does for a
// single body without tracking a baseline per sheet.
const sheetsSnapshot = () => JSON.stringify(surfaces().map(el => getEditorBody(el)));
