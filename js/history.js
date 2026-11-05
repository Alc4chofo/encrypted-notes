// notes: Undo and redo.
"use strict";

// ---------- Undo / redo ----------
// One history per note, holding whole-note snapshots: text, page structure,
// sections, the applied design and the attachment list all move together, so
// "turn into pages" and "apply design" walk back exactly like a typo does.
// Snapshots live in memory only - 30 copies of a note per note is far too much
// to put in the vault, where it would be encrypted and synced on every save.
const HIST_MAX = 30;                       // well past the 20 steps asked for
const histories = new Map();               // note id -> { past: [], future: [] }
// Set by anything that reshapes the note and then re-renders (design applied,
// format switched, undo in the second screen). Those paths reset editorBaseline
// to the NEW screen, so saveCurrent's "nothing changed" fast-path matched and
// "Save edit" silently saved NOTHING - the change was gone on the next unlock.
// While this flag is up the fast-paths are void; it drops only when a real
// persist runs or the change is deliberately thrown away.
let structureDirty = false;
let histTypingMarked = false;
const noteSnap = id => { const n = vault && vault.notes[id]; return n ? JSON.stringify(n) : null; };
function histFor(id) {
  let h = histories.get(id);
  if (!h) { h = { past: [], future: [] }; histories.set(id, h); }
  return h;
}
// Call BEFORE changing a note. Cheap when nothing actually changed.
function historyMark(id) {
  id = id || currentId;
  if (!id || !vault || !vault.notes[id] || backupView || trashViewId) return;
  const s = noteSnap(id);
  if (s === null) return;
  const h = histFor(id);
  if (h.past.length && h.past[h.past.length - 1] === s) return;
  h.past.push(s);
  while (h.past.length > HIST_MAX) h.past.shift();
  h.future.length = 0;                     // a new edit forks the timeline
  renderHistoryButtons();
}
// Typing is one step per burst, not one per keystroke: the mark is taken on the
// first keystroke after a save, when the note still holds the previous text.
function historyMarkTyping() {
  if (histTypingMarked) return;
  histTypingMarked = true;
  historyMark(currentId);
}
function historyApply(dir) {
  if (!currentId || !vault || !vault.notes[currentId] || backupView || trashViewId) return;
  const h = histFor(currentId);
  const from = dir === "undo" ? h.past : h.future;
  const to = dir === "undo" ? h.future : h.past;
  if (!from.length) { status(dir === "undo" ? "Nothing to undo" : "Nothing to redo"); return; }
  // Commit whatever is on screen first, or the pending keystrokes would come
  // back as a phantom edit after the swap.
  clearTimeout(saveTimer);
  if (!splitMode) saveCurrent();
  else {
    // Autosave is paused here, so typed text lives ONLY in the DOM. Fold it
    // into the in-memory note (no persist) before snapshotting - without this,
    // Ctrl+Z rebuilt the sheets from the stale note and the typing vanished
    // from the screen AND from every history entry: unrecoverable. Safe to
    // mutate: the discard path restores splitSnapshot wholesale.
    const n = vault.notes[currentId];
    n.title = $("title").value;
    if (pagedView() && isPaged(n)) syncPagesFromDom();
    else { const t = activeBody(n); t.body = getEditorBody(); t.bodyV = 2; }
  }
  const now = noteSnap(currentId);
  const next = from.pop();
  if (next === now && from.length) { to.push(now); return historyApply(dir); }
  to.push(now);
  vault.notes[currentId] = JSON.parse(next);
  currentPage = 0;
  histTypingMarked = false;
  reloadNoteInPlace();
  // In the second screen nothing is written: undo is part of the temporary
  // edit, and cancelling still throws the whole session away. structureDirty
  // makes the eventual "Save edit" write even though the baseline was re-taken.
  if (splitMode) { dirty = true; structureDirty = true; renderStatus(); }
  else persistLocal().catch(e => status("Save failed: " + e.message, true));
  updateSplitButtons();
  renderHistoryButtons();
  status(dir === "undo" ? "Undone" : "Redone");
}
const historyUndo = () => historyApply("undo");
const historyRedo = () => historyApply("redo");
function renderHistoryButtons() {
  const h = currentId ? histories.get(currentId) : null;
  const u = $("undo-btn"), r = $("redo-btn");
  if (u) { u.disabled = !h || !h.past.length; u.title = "Undo (Ctrl+Z)" + (h ? " - " + h.past.length + " step" + (h.past.length === 1 ? "" : "s") : ""); }
  if (r) { r.disabled = !h || !h.future.length; r.title = "Redo (Ctrl+Y)" + (h ? " - " + h.future.length + " step" + (h.future.length === 1 ? "" : "s") : ""); }
}
function reloadNoteInPlace() {
  const n = currentId && vault ? vault.notes[currentId] : null;
  if (!n) return;
  currentPage = Math.min(currentPage, Math.max(0, (notePages(n) || [1]).length - 1));
  if (isPaged(n)) renderSheets();
  else {
    document.body.classList.remove("paged-view");
    $("sheets").innerHTML = "";
    const t = activeBody(n);
    setEditorBody(t.body, { bodyV: t.bodyV });
  }
  editorBaseline = pagedView() ? sheetsSnapshot() : getEditorBody();
  dirty = false;
  renderPageTabs();
  renderList();
  renderStatus();
  renderAttachments();
}

// Puts the note back exactly as it was when the second screen opened - text,
// page structure and attachment list together. Both structural buttons rely on
// this, so a design or a format switch can always be walked back.
function restoreSplitSnapshot() {
  if (!splitSnapshot || !currentId || !vault || !vault.notes[currentId]) return false;
  const n = vault.notes[currentId];
  const s = splitSnapshot;
  n.title = s.title;
  n.body = s.body;
  if (s.bodyV === 2) n.bodyV = 2; else delete n.bodyV;
  if (s.pages) n.pages = JSON.parse(JSON.stringify(s.pages)); else delete n.pages;
  if (s.designId) n.designId = s.designId; else delete n.designId;   // the applied design is part of the state
  n.media = JSON.parse(JSON.stringify(s.media || []));
  n.mtime = Date.now();
  currentPage = 0;
  dirty = false;
  structureDirty = false;    // the pending change was deliberately thrown away
  persistSafe();
  reloadNoteInPlace();
  renderAttachments();
  return true;
}

// ---- Second-screen structure buttons ----
// Both change the note's SHAPE, which is why they live here: leaving the second
// screen and choosing "cancel the changes" restores the snapshot above.
function updateSplitButtons() {
  const n = currentId && vault ? vault.notes[currentId] : null;
  $("split-format").textContent = n && isPaged(n) ? "Turn into note" : "Turn into pages";
}
$("split-format").onclick = async () => {
  if (!splitMode || syncing || backupView || !currentId || !vault.notes[currentId]) return;
  flushSave();
  let n = vault.notes[currentId];
  // Asks before reshaping the note, so a misclick costs nothing. This confirms
  // the ACTION only - it still saves nothing, and closing the second screen
  // with "cancel the changes" undoes it like any other edit.
  const toPages = !isPaged(n);
  if (!await confirmModal({
    title: toPages ? "Turn this note into pages?" : "Turn this note into a single page?",
    body: toPages
      ? "The note is laid out as A4 pages, exactly as it will export. Nothing is saved yet - leaving the second screen still asks you to save or cancel."
      : "Every page is joined back into one continuous note. Nothing is saved yet - leaving the second screen still asks you to save or cancel.",
    confirmLabel: toPages ? "Turn into pages" : "Turn into note",
  })) return;
  // The vault can have moved on while the dialog was open.
  if (!splitMode || syncing || backupView || !currentId || !vault.notes[currentId]) return;
  n = vault.notes[currentId];
  if (isPaged(n) === toPages) return;               // someone already flipped it
  historyMark(currentId);
  if (isPaged(n)) {
    // Paged -> single note: every page is concatenated, nothing is dropped.
    const parts = notePages(n).map(p => p.body || "");
    n.body = parts.filter(s => s.length).join("\n");
    n.bodyV = 2;
    delete n.pages;
    status("Now a single page - close the second screen and cancel to undo");
  } else {
    toPaged(n);
    status("Now in page layout - close the second screen and cancel to undo");
  }
  n.mtime = Date.now();
  currentPage = 0;
  reloadNoteInPlace();
  // NOT persisted and deliberately left dirty: leaving the second
  // screen must offer save or cancel, and cancel restores the snapshot.
  dirty = true;
  structureDirty = true;   // "Save edit" must write even though the baseline just re-took
  renderStatus();
  updateSplitButtons();
};
// Wraps the note in a design: its TITLE pages go in front, its FINAL pages go
// at the end, and everything already written becomes the body in between -
// adapted, never replaced.
// Strip whatever a previous design added: its title/final pages, and the frame
// it wrapped around each body page. What is left is purely what you wrote.
const CONTENT_MARK = "{{content}}";
// The mark as people type it: {content} or {{content}}, any case, spaces inside allowed.
const CONTENT_RE = /\{\{?\s*content\s*\}\}?/i;
function undesignPages(n) {
  const ps = notePages(n);
  if (!ps) return [{ name: "Page 1", body: n.body || "", bodyV: n.bodyV }];
  return ps.filter(p => pageSection(p) === "body").map(p => {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeBodyFragment(p.body || ""));
    const frames = [...holder.querySelectorAll("[data-frame]")];
    if (frames.length) {
      for (const f of frames) f.remove();          // drop the old design's frame
      return { name: p.name, body: canonicalBody(holder).replace(/^\n+|\n+$/g, ""), bodyV: 2 };
    }
    return { name: p.name, body: p.body || "", bodyV: p.bodyV };
  });
}
// Wrap one page of content in the design's body frame. The frame may mark where
// the text goes with {content}: the lines above the mark become the top frame,
// the lines below it the bottom frame, and the mark's own line is where the
// content goes. Without a mark the whole frame sits above the content.
// Split by LINES, not by cutting the stored text at the mark: a cut there left
// the mark's own <div> open in one half and closed in the other, which pushed
// the bottom frame out of its frame.
function frameBody(tplBody, content) {
  if (!tplBody) return content;
  const holder = document.createElement("div");
  holder.appendChild(sanitizeBodyFragment(tplBody));
  normalizeLines(holder);
  const kids = [...holder.childNodes];
  const at = kids.findIndex(k => CONTENT_RE.test(k.textContent || ""));
  const html = nodes => { const d = document.createElement("div"); for (const k of nodes) d.appendChild(k.cloneNode(true)); return canonicalBody(d); };
  const wrap = (nodes, pos) => { const s = html(nodes).replace(/^\n+|\n+$/g, ""); return s.trim() ? `<div data-frame="${pos}">${s}</div>` : ""; };
  if (at < 0) return wrap(kids, "top") + "\n" + (content || "");
  return [wrap(kids.slice(0, at), "top"), content || "", wrap(kids.slice(at + 1), "bottom")].filter(Boolean).join("\n");
}
// A note wrapped in a design: the design's title pages in front, its closing
// pages at the end, and the note's own writing (with any earlier design taken
// off first) in the body, inside the frame of the design's page that holds the
// {content} mark. Body pages before or after that page come along too, so a
// design laid out as cover / content / back cover works without marking parts.
function designedPages(n, src) {
  const dp = notePages(src) || [];
  const page = (p, i, sec) => { const q = newPageFrom(p, i); if (sec !== "body") q.section = sec; else delete q.section; return q; };
  const front = dp.filter(p => pageSection(p) === "title").map((p, i) => page(p, i, "title"));
  const back = dp.filter(p => pageSection(p) === "final").map((p, i) => page(p, i, "final"));
  const bodies = dp.filter(p => pageSection(p) === "body");
  const ti = bodies.findIndex(p => CONTENT_RE.test(p.body || ""));
  const tpl = ti >= 0 ? bodies[ti] : bodies[0];
  // Unmarked pages around the {content} page are front and back matter: they
  // become title and closing pages, so the reflow never pours the note's text
  // into a cover, and a later design takes them off again like any other.
  const before = ti > 0 ? bodies.slice(0, ti).map((p, i) => page(p, i, "title")) : [];
  const after = ti >= 0 ? bodies.slice(ti + 1).map((p, i) => page(p, i, "final")) : [];
  // The body is re-flowed as ONE stream rather than framing each old page where
  // it stood. Those page breaks were made for a page with no header or footer;
  // keeping them meant every page was suddenly too full, spilled, and left
  // half-empty pages. One page in, and the pagination lays it out for the frame.
  const kept = undesignPages(n).map(p => (p.body || "").trim()).filter(Boolean);
  const mine = { id: crypto.randomUUID(), name: "Body",
    body: frameBody(tpl ? tpl.body : "", kept.join("\n")), bodyV: 2, cont: true };
  return { pages: [...front, ...before, mine, ...after, ...back], front: front.length + before.length, back: back.length + after.length };
}
// The design's pictures come along, so its pages are not full of placeholders.
function adoptDesignMedia(n, src) {
  if (!Array.isArray(n.media)) n.media = [];
  const have = new Set(n.media.map(m => m.id));
  for (const m of (src.media || [])) if (!have.has(m.id)) { n.media.push({ ...m }); have.add(m.id); }
}
// Strip EVERY piece of stored layout state from a note and leave one plain page
// holding all of its content. A note that has been designed, re-designed and
// re-paged many times carries a lot of invisible state - a remembered design,
// frame blocks around the text, title/final marks, continuation flags, and
// per-item width/alignment/pin overrides - and one bad value in any of it
// follows the note around forever. This is the way out that does not involve
// rebuilding the note by hand.
// Text and attachments are untouched; only the layout is forgotten.
async function resetNoteLayout(id) {
  const n = vault && vault.notes[id];
  if (!n || syncing || backupView) return;
  if (currentId === id) flushSave();
  const pageCount = (notePages(n) || []).length;
  if (!await confirmModal({
    title: `Reset the layout of "${(n.title || "Untitled").trim() || "Untitled"}"?`,
    body: "Every word and every attachment is kept, joined into one plain page. "
      + "What is forgotten: the design and its header/footer, the title and closing page marks, "
      + (pageCount > 1 ? `the ${pageCount} page breaks, ` : "")
      + "and any size, alignment or pinned position set on individual pictures. "
      + "Use it when a note has been designed so many times that its layout misbehaves. Ctrl+Z undoes it.",
    confirmLabel: "Reset layout", destructive: true,
  })) return;
  if (syncing || !vault.notes[id]) return;
  historyMark(id);
  // undesignPages already removes a design's frames and drops its title/final
  // pages, leaving only what was written.
  const kept = undesignPages(n).map(p => {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeBodyFragment(p.body || ""));
    for (const el of holder.querySelectorAll("[data-frame]")) el.replaceWith(...el.childNodes);
    for (const el of holder.querySelectorAll(".inline-media")) {
      for (const a of ["data-w", "data-align", "data-fx", "data-fy"]) el.removeAttribute(a);
      el.removeAttribute("style");
    }
    for (const el of holder.querySelectorAll("[data-split]")) el.removeAttribute("data-split");
    return canonicalBody(holder).trim();
  }).filter(Boolean);
  n.body = kept.join("\n");
  n.bodyV = 2;
  delete n.pages;
  delete n.designId;
  n.mtime = Date.now();
  currentPage = 0;
  if (currentId === id) { exitSplit(true); reloadNoteInPlace(); }
  persistSafe();
  renderList(); renderStatus(); renderAttachments();
  status("Layout reset - one plain page, nothing else changed");
}
async function applyDesignToNote(designId) {
  let src = vault.notes[designId], n = currentId && vault.notes[currentId];
  if (!src || !n || src === n || syncing || backupView) return;
  flushSave();
  // Confirms the action only - picking a design off the menu by accident should
  // not silently restructure the note. Still saves nothing.
  if (!await confirmModal({
    title: `Apply the design "${src.title || "(untitled)"}"?`,
    body: "Its title pages go in front, its closing pages at the end, and what you have written becomes the body in between. Any design already on this note is replaced. Nothing is saved yet - leaving the second screen still asks you to save or cancel.",
    confirmLabel: "Apply design",
  })) return;
  src = vault.notes[designId]; n = currentId && vault.notes[currentId];
  if (!src || !n || src === n || syncing || backupView || !splitMode) return;
  historyMark(currentId);      // one undo step puts the whole design back
  // Swap, never stack: the previous design's pages and frames come off first.
  const d = designedPages(n, src);
  n.designId = designId;      // remembered, so we know what to strip next time
  n.pages = d.pages;
  delete n.bodyV;
  adoptDesignMedia(n, src);
  n.mtime = Date.now();
  currentPage = 0;
  reloadNoteInPlace();
  // NOT persisted and deliberately left dirty: leaving the second
  // screen must offer save or cancel, and cancel restores the snapshot.
  dirty = true;
  structureDirty = true;
  renderStatus();
  renderAttachments();
  updateSplitButtons();
  status(`"${src.title}" applied - ${d.front} front, 1 body, ${d.back} closing`);
}
$("split-design").onclick = () => {
  if (!splitMode || syncing || backupView || !currentId) return;
  const ids = designNoteIds().filter(id => id !== currentId);
  const r = $("split-design").getBoundingClientRect();
  openMenu(r.left, r.top - 8, ids.length
    ? ids.sort((a, b) => byName(vault.notes[a].title || "", vault.notes[b].title || ""))
        .map(id => ({ label: vault.notes[id].title || "(untitled)", onClick: () => applyDesignToNote(id) }))
    : [{ label: "No designs yet - import one first", disabled: true }]);
};

$("split-btn").onclick = () => { splitMode ? exitSplit(false) : enterSplit(); };
// One click to walk the whole session back: everything from this second screen
// - text, pages, designs, format switches, attachments - is discarded and the
// note returns to how it was when the screen opened. Asks first, because it
// destroys work; the discarded state goes into history first, so even this can
// be undone with Ctrl+Z.
$("split-cancel").onclick = async () => {
  if (!splitMode || syncing || backupView || !currentId || !vault.notes[currentId]) return;
  if (!await confirmModal({
    title: "Return to the previous version?",
    body: "Everything from this second-screen session is thrown away and the note goes back to exactly how it was when the second screen opened. Ctrl+Z can bring the discarded work back.",
    confirmLabel: "Return to previous", destructive: true,
  })) return;
  if (!splitMode || syncing || !currentId || !vault.notes[currentId]) return;
  flushSave();                        // capture the buffer so history holds ALL of it
  historyMark(currentId);
  restoreSplitSnapshot();             // clears dirty, so the exit below never prompts
  await exitSplit(false);
  status("Back to the previous version - Ctrl+Z restores the discarded edit");
};
$("split-save").onclick = () => {
  if (!splitMode || syncing || backupView) return;
  // Saves the right side; renderPrevPane is deliberately NOT called, so the
  // reference on the left stays exactly as it was when the session started.
  manualSave();
  status("Edit saved - the left pane still shows the previous version");
};

const EDITOR_BLOCK_TAGS = new Set(["DIV", "P"]);
// The browser writes every colour it applies as rgb()/rgba(), never as the hex
// the palette handed it, and a hex-only rule silently dropped them all: text
// colour and highlight never survived a save. A strictly numeric rgb()/rgba()
// becomes hex again here; anything looser still never gets through. Returns
// "transparent" for a fully transparent colour, null for anything unreadable.
function cssColorHex(val) {
  const v = String(val || "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/.test(v)) return v;
  if (v === "transparent") return "transparent";
  const m = /^rgba?\(\s*(\d{1,3})\s*(?:,\s*|\s+)(\d{1,3})\s*(?:,\s*|\s+)(\d{1,3})\s*(?:[,/]\s*(\d*\.?\d+)(%?)\s*)?\)$/.exec(v);
  if (!m) return null;
  const rgb = [m[1], m[2], m[3]].map(Number);
  if (rgb.some(n => n > 255)) return null;
  let a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  if (!(a >= 0 && a <= 1)) return null;
  if (a === 0) return "transparent";
  const hx = n => n.toString(16).padStart(2, "0");
  return "#" + rgb.map(hx).join("") + (a < 1 ? hx(Math.round(a * 255)) : "");
}
// Colours the browser itself writes when it preserves a style while moving or
// clearing text: the editor's own ink and paper. Nobody picks them, and keeping
// them would print the dark editor's pale default text onto the white page.
const BROWSER_COLORS = new Set(["#dcd6cc", "#111111"]);
const BROWSER_BACKGROUNDS = new Set(["#181715", "#fffdf7"]);
// inline=true for a text element (span, b, ...): alignment and sizes do nothing
// there, so they are not kept (the browser leaves text-align on a span when two
// lines with different alignment are joined).
function sanitizeStyle(style, inline) {
  const out = [];
  let color = null, background = null;
  for (const decl of String(style || "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    let val = decl.slice(i + 1).trim();
    // Colours first: they are the one place a function, rgb(), is accepted, and
    // only in the strict numeric form cssColorHex reads.
    if (prop === "color") { color = cssColorHex(val); continue; }
    if (prop === "background-color" || prop === "background") { background = cssColorHex(val); continue; }
    // Nothing that can fetch, position or escape: no url(), no functions, no
    // backslashes, no at-rules.
    if (/[\\(){}@;]|url|expression|import|var\s*\(/i.test(val)) continue;
    if (prop === "text-align" && /^(left|right|center|justify)$/i.test(val)) { if (!inline) out.push("text-align:" + val.toLowerCase()); }
    else if (prop === "font-weight" && /^(bold|bolder|normal|[1-9]00)$/i.test(val)) out.push("font-weight:" + val.toLowerCase());
    else if (prop === "font-style" && /^(italic|normal)$/i.test(val)) out.push("font-style:" + val.toLowerCase());
    else if (prop === "text-decoration" && /^(underline|line-through|none)$/i.test(val)) out.push("text-decoration:" + val.toLowerCase());
    else if (prop === "font-size" && /^\d{1,3}(pt|px)$/i.test(val)) out.push("font-size:" + val.toLowerCase());
    else if (prop === "font-family") {
      const fam = val.replace(/["']/g, "").split(",")[0].trim();
      if (FONT_ALLOW.has(fam.toLowerCase())) out.push("font-family:" + fam);
    }
    else if (prop === "text-decoration-line" && /^(underline|line-through|none)$/i.test(val))
      out.push("text-decoration:" + val.toLowerCase());
    // Table cell sizing, bounded and px-only (no calc(), no percentages that
    // could blow the layout out of the page).
    else if (!inline && (prop === "width" || prop === "height") && /^\d{1,4}px$/i.test(val)) {
      const n = parseInt(val, 10);
      if (n >= 8 && n <= 2000) out.push(prop + ":" + n + "px");
    }
  }
  // Transparent ink on a black box is the LOOK of censored text, which the
  // browser copies onto new typing after censored text is deleted. Without the
  // data-censor mark it is ordinary text that only looks hidden: drop the look
  // rather than keep a redaction that is not one.
  if (color === "transparent") {
    color = null;
    if (background === "#000" || background === "#000000") background = null;
  }
  if (color && !BROWSER_COLORS.has(color)) out.push("color:" + color);
  if (background && background !== "transparent" && !BROWSER_BACKGROUNDS.has(background))
    out.push("background-color:" + background);   // highlight; only a colour, never a url()
  return out.join(";");
}
// Image presentation, stored as data attributes rather than free-form CSS so the
// serializer never has to trust a style string for layout.
// fx/fy are the image's own coordinates as a PERCENTAGE of the page it sits on
// (top-left corner). Percentages rather than pixels because the sheet is drawn
// at whatever width the window allows but always exports as A4 - a percentage
// means the same spot on screen and in the PDF.
const pct = v => { const n = parseFloat(v); return (isFinite(n) && n >= -20 && n <= 120) ? Math.round(n * 100) / 100 : null; };
function mediaLayout(el) {
  const w = parseInt(el.getAttribute("data-w") || "", 10);
  const a = (el.getAttribute("data-align") || "").toLowerCase();
  const fx = pct(el.getAttribute("data-fx")), fy = pct(el.getAttribute("data-fy"));
  return { w: (w >= 40 && w <= 2000) ? w : null, align: ALIGN_OK.has(a) ? a : null,
    fx: (fx !== null && fy !== null) ? fx : null, fy: (fx !== null && fy !== null) ? fy : null };
}
// Apply a stored layout to a live wrapper.
// One page's worth of content height, in screen pixels.
function onePageContentPx() {
  const b = document.querySelector("#sheets .sheet-body");
  return b ? contentCapacity(b) : 0;
}
function inlineDims(el) {
  const mid = el.getAttribute("data-mid");
  const ctx = mediaCtx();
  const m = ((ctx && ctx.note && ctx.note.media) || []).find(x => x.id === mid);
  return m && +m.w > 0 && +m.h > 0 ? { w: +m.w, h: +m.h } : null;
}
function applyMediaLayout(el) {
  let { w, align, fx } = mediaLayout(el);
  if (w) {
    // A picture cannot be split across pages, so it must never be sized past
    // one. Widths up to 2000px are allowed and drop the 320x240 clamp, which
    // let a portrait image stand taller than the paper - the page then just
    // stayed oversized because there was nothing to move off it. data-w keeps
    // the user's number; only what is drawn is capped.
    const cap = onePageContentPx(), d = cap ? inlineDims(el) : null;
    if (d && w * d.h / d.w > cap) w = Math.max(40, Math.floor(cap * d.w / d.h));
    el.style.width = w + "px"; el.style.height = "auto";
  }
  const floating = fx !== null;
  el.classList.toggle("floating", floating);
  if (floating) {
    // Free placement: it sits exactly where it was dropped and text ignores it.
    el.style.left = el.getAttribute("data-fx") + "%";
    el.style.top = el.getAttribute("data-fy") + "%";
    el.classList.remove("align-left", "align-center", "align-right");
    return;
  }
  el.style.left = el.style.top = "";
  el.classList.toggle("align-left", align === "left");
  el.classList.toggle("align-center", align === "center");
  el.classList.toggle("align-right", align === "right");
}
// Pin a wrapper at a point on the surface it was dropped on. The node becomes a
// direct child of that surface so the percentages are relative to the page
// itself, not to whatever paragraph happened to be underneath.
function placeFloating(node, surface, clientX, clientY, grab) {
  if (!node || !surface) return false;
  const box = surface.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return false;
  const r = node.getBoundingClientRect();
  // Keep the grab point under the cursor; default to the middle of the image.
  const offX = grab && isFinite(grab.dx) ? grab.dx : r.width / 2;
  const offY = grab && isFinite(grab.dy) ? grab.dy : r.height / 2;
  const x = clientX - box.left - offX + surface.scrollLeft;
  const y = clientY - box.top - offY + surface.scrollTop;
  const fx = Math.max(-5, Math.min(105, x / box.width * 100));
  const fy = Math.max(-5, Math.min(105, y / box.height * 100));
  node.setAttribute("data-fx", fx.toFixed(2));
  node.setAttribute("data-fy", fy.toFixed(2));
  node.removeAttribute("data-align");
  if (node.parentNode !== surface) surface.appendChild(node);
  applyMediaLayout(node);
  return true;
}

// ----- load side: strict sanitizer (inert parse -> allowlist rebuild) -----
// Copy ONLY whitelisted nodes into a FRESH fragment; never assign the stored string
// to a live/attached node (a detached node still fires img loads / onerror).
// Tables stored before columns carried widths have nothing for fixed layout to
// size from, so they would collapse to the cell min-width. Give any unsized
// column a sensible share of an A4 text column. Runs on the detached fragment,
// so it never needs layout.
function ensureColWidths(t) {
  const first = t.querySelector("tr");
  if (!first) return;
  const cols = first.children.length;
  if (!cols) return;
  const w = Math.max(60, Math.min(150, Math.floor(660 / cols)));
  [...first.children].forEach((c, i) => {
    if (/\d+px/.test(c.style.width || "")) return;   // already sized: leave it alone
    for (const r of t.querySelectorAll("tr")) if (r.children[i]) r.children[i].style.width = w + "px";
  });
}
// Attachments sit shoulder to shoulder. A line break between two reference
// cards becomes a plain space, so a run of them flows across the row and wraps
// onto the next one when it runs out of width - like a row of pictures, instead
// of one card per line with most of the page left empty.
// Applied to what is DISPLAYED and to what the PDF writer parses, so both agree
// even for notes saved before this existed.
function packAttachmentRuns(root) {
  // Any inline media, pictures included: a line holding nothing but media packs,
  // whether it is three PDFs, a picture next to a PDF, or a row of photographs.
  // A picture on a line of its own used to keep the whole row to itself.
  const isCard = n => n && n.nodeType === 1 && n.classList && n.classList.contains("inline-media")
    && !(n.dataset && n.dataset.fx !== undefined);        // pinned media is placed, not flowed
  const blank = n => n && n.nodeType === 3 && !n.data.trim();
  // The nearest real neighbour, looking past the whitespace between lines.
  const near = (n, dir) => { let s = n[dir]; while (blank(s)) s = s[dir]; return s; };
  // A line holding nothing but attachments. Pressing Enter in the editor wraps
  // each one in its own DIV, which is a block, which is a whole row each.
  const cardLine = n => n && n.nodeType === 1 && (n.tagName === "DIV" || n.tagName === "P")
    && !(n.dataset && n.dataset.frame)
    && [...n.childNodes].some(isCard)
    && [...n.childNodes].every(c => isCard(c) || blank(c) || (c.nodeType === 1 && c.tagName === "BR"));
  const walk = el => {
    el.normalize();
    // A run of those lines becomes ONE line, the cards side by side, so they
    // pack across the row and wrap onto the next when they run out of room.
    // (Merged rather than dissolved into the page: every line stays a line.)
    for (const b of [...el.children]) {
      if (b.parentNode !== el) continue;                 // merged into an earlier line
      if (!cardLine(b)) { if (!isMediaEl(b)) walk(b); continue; }
      for (let n = near(b, "nextSibling"); n && cardLine(n); n = near(b, "nextSibling")) {
        while (b.nextSibling !== n) b.nextSibling.remove();   // the blank text between them
        for (const c of [...n.childNodes]) if (isCard(c)) { b.appendChild(document.createTextNode(" ")); b.appendChild(c); }
        n.remove();
      }
      for (const c of [...b.childNodes]) if (c.nodeType === 1 && c.tagName === "BR") c.remove();
    }
    el.normalize();
    // And a line break between two attachments is just a space.
    for (const t of [...el.childNodes]) {
      if (!blank(t) || !t.data.includes("\n")) continue;
      if (isCard(near(t, "previousSibling")) && isCard(near(t, "nextSibling"))) t.data = " ";
    }
  };
  walk(root);
  return root;
}
function sanitizeBodyInto(src, dest) {
  src.childNodes.forEach(child => {
    if (child.nodeType === 3) {
      dest.appendChild(document.createTextNode(child.data));
    } else if (child.nodeType === 1) {
      const im = validInlineMedia(child);
      if (im) {
        const w = buildInlineWrapper(im.mid, im.kind);   // subtree discarded
        // Carry the presentation across, validated (see mediaLayout).
        const lay = mediaLayout(child);
        if (lay.w) w.setAttribute("data-w", String(lay.w));
        if (lay.align) w.setAttribute("data-align", lay.align);
        if (lay.fx !== null) { w.setAttribute("data-fx", String(lay.fx)); w.setAttribute("data-fy", String(lay.fy)); }
        applyMediaLayout(w);
        dest.appendChild(w);
      } else if (child.tagName === "BR") {
        dest.appendChild(document.createElement("br"));
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName)) {
        const div = document.createElement("div");
        const st = sanitizeStyle(child.getAttribute("style"));
        if (st) div.setAttribute("style", st);
        // data-frame marks a design's frame so a later design can strip it.
        const fr = child.getAttribute && child.getAttribute("data-frame");
        if (fr === "top" || fr === "bottom") div.setAttribute("data-frame", fr);
        sanitizeBodyInto(child, div);
        dest.appendChild(div);
      } else if (LIST_TAGS.has(child.tagName) || TABLE_TAGS.has(child.tagName)) {
        // Lists and tables are structure, not decoration: without them here a
        // list or table was flattened into plain text on the first save.
        const el = document.createElement(child.tagName.toLowerCase());
        const st = sanitizeStyle(child.getAttribute("style"));
        if (st) el.setAttribute("style", st);
        if (child.tagName === "TABLE") {
          // A pinned table carries its own page coordinates, exactly like a
          // pinned image.
          const lay = mediaLayout(child);
          if (lay.fx !== null) { el.setAttribute("data-fx", String(lay.fx)); el.setAttribute("data-fy", String(lay.fy)); }
          if (lay.w) el.setAttribute("data-w", String(lay.w));
          applyMediaLayout(el);
        }
        // Spans are the only table attributes allowed, and only as small ints.
        for (const a of ["colspan", "rowspan"]) {
          const v = parseInt(child.getAttribute(a) || "", 10);
          if (v > 1 && v <= 50) el.setAttribute(a, String(v));
        }
        sanitizeBodyInto(child, el);
        if (child.tagName === "TABLE") ensureColWidths(el);
        dest.appendChild(el);
      } else if (child.tagName === "A") {
        // Only safe schemes survive, and the link always opens sandboxed.
        const href = safeHref(child.getAttribute("href"));
        if (!href) { sanitizeBodyInto(child, dest); return; }   // unwrap a rejected link
        const a = document.createElement("a");
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        const st = sanitizeStyle(child.getAttribute("style"), true);
        if (st) a.setAttribute("style", st);
        sanitizeBodyInto(child, a);
        dest.appendChild(a);
      } else if (INLINE_FMT_TAGS.has(child.tagName)) {
        const tag = INLINE_FMT_TAGS.get(child.tagName);
        const st = sanitizeStyle(child.getAttribute("style"), true);
        const censored = child.getAttribute("data-censor") === "1";
        // A <span> that carries nothing we allow is pure noise: unwrap it.
        if (tag === "span" && !st && !censored) { sanitizeBodyInto(child, dest); return; }
        const el = document.createElement(tag);
        if (st) el.setAttribute("style", st);
        if (censored) censorMark(el);
        sanitizeBodyInto(child, el);
        dest.appendChild(el);
      } else {
        sanitizeBodyInto(child, dest);   // unwrap any disallowed element to its text/children
      }
    }
    // comments, CDATA, PIs: dropped
  });
}
function sanitizeBodyFragment(html) {
  // <template> content is inert: no resource fetch, no onerror, scripts never run.
  const tpl = document.createElement("template");
  tpl.innerHTML = html || "";
  const frag = document.createDocumentFragment();
  sanitizeBodyInto(tpl.content, frag);
  return frag;
}
