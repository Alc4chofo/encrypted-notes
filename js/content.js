// notes: Note bodies: sanitising, pages, body search and duplicating a note.
"use strict";

// ---------- Rich editor: serialize / sanitize / hydrate ----------
// The editor is a contenteditable <div>. A note body is EITHER legacy plain text
// (bodyV !== 2, rendered via textContent so a literal "<img onerror>" stays text)
// OR sanitized HTML (bodyV === 2) whose only markup is line breaks and atomic
// inline-media wrappers carrying a media id - never bytes, never blob:/data: URLs.
// Both save (getEditorBody) and load (setEditorBody) run the SAME strict allowlist,
// so a poisoned synced body cannot inject script/onerror/style, and every stored
// body references media by id only.
let editorSeq = 0;          // hydration generation: a note switch cancels stale inline decrypts
let editorBaseline = "";    // getEditorBody() at load / last save: the dirty-comparison anchor
let editorPlainOrig = null; // for a still-legacy body, its ORIGINAL plain string (else null)

// Escape text so it re-parses to identical characters (and stays inert). \n is not
// special in HTML text, so newlines survive verbatim through the round-trip.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

const INLINE_MID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A span is a real inline-media wrapper only with class 'inline-media', a UUID
// data-mid, and data-kind in the fixed set below; anything else is dropped so a
// poisoned body cannot smuggle markup back out through re-serialization.
const INLINE_KINDS = new Set(["image", "video", "pdf", "text", "file"]);
function validInlineMedia(el) {
  if (!el || el.nodeType !== 1 || el.tagName !== "SPAN") return null;
  if (!el.classList.contains("inline-media")) return null;
  const mid = el.getAttribute("data-mid") || "";
  const kind = el.getAttribute("data-kind") || "";
  if (!INLINE_MID_RE.test(mid) || !INLINE_KINDS.has(kind)) return null;
  return { mid, kind };
}

// Media ids referenced INLINE by a bodyV:2 body string (a live note body or a trash
// snapshot). Parsed in an inert <template> (no resource fetch, no onerror) and read
// back through validInlineMedia, so it sees exactly the ids the sanitizer would keep.
// Inline references are otherwise invisible to mediaReferenced / mediaIdsFor, which
// scan note.media only; without this an inline-only id would be wrongly purged or
// never uploaded. Returns [] for legacy plain bodies.
function bodyMediaIds(body, bodyV) {
  if (bodyV !== 2 || typeof body !== "string" || body.indexOf("inline-media") === -1) return [];
  const tpl = document.createElement("template");
  tpl.innerHTML = body;
  const out = [];
  tpl.content.querySelectorAll("span.inline-media").forEach(sp => {
    const im = validInlineMedia(sp);
    if (im) out.push(im.mid);
  });
  return out;
}

// ---------- Pages ----------
// A note is EITHER single-page (note.body, exactly the original shape) or paged
// (note.pages = [{id,name,body,bodyV}], which then holds all the content).
// Everything that reads content goes through noteBodies() so both shapes work,
// and nothing that only knows the old shape is ever written to.
const notePages = n => (n && Array.isArray(n.pages) && n.pages.length) ? n.pages : null;
const isPaged = n => !!notePages(n);
// Every content body in a note, in order. THE scanning primitive: media purges,
// export and search must never look at note.body alone.
function noteBodies(n) {
  if (!n) return [];
  const ps = notePages(n);
  return ps ? ps.map(p => ({ body: p.body || "", bodyV: p.bodyV, name: p.name }))
            : [{ body: n.body || "", bodyV: n.bodyV, name: n.title || "" }];
}

// ---------- Search inside note bodies ----------
// The searchable text of a note is built from EVERY page (noteBodies), in memory
// only, and cached per note until its mtime changes. The cache holds plaintext,
// so lockApp clears it. Censored spans are left out on purpose: a search must
// not surface, in a snippet, text the user chose to black out.
const searchTextCache = new Map();   // note id -> { mtime, text }
function bodyPlainText(b) {
  // A plain (v1) body is already text, so it is used as it is.
  if (b.bodyV !== 2) return b.body || "";
  // A v2 body is sanitized (parsed inert: nothing loads or runs) and laid out in
  // the same lines the page shows, so the words of two lines never fuse.
  const holder = document.createElement("div");
  holder.appendChild(bodyFragment(b.body, 2));
  // Censored spans are removed before reading the text, so they never match and never show.
  for (const el of holder.querySelectorAll("[data-censor]")) el.remove();
  return plainLines(holder);
}
function noteSearchText(id) {
  const n = vault.notes[id];
  // A cached entry built from the same mtime is still right, so it is reused.
  const hit = searchTextCache.get(id);
  if (hit && hit.mtime === n.mtime) return hit.text;
  // Otherwise every page's text is joined with a newline, so words on two pages never fuse.
  const text = noteBodies(n).map(bodyPlainText).join("\n");
  // Stored lower-cased as well, since every search compares lower-case strings.
  const entry = { mtime: n.mtime, text, lower: text.toLowerCase() };
  searchTextCache.set(id, entry);
  return text;
}
// True when the note's title or its body text contains the (lower-cased) query.
function noteMatches(id, q) {
  // So first the title, because that check is free.
  if ((vault.notes[id].title || "").toLowerCase().includes(q)) return true;
  // Then the body: noteSearchText fills the cache, and the cached lower-case copy is searched.
  noteSearchText(id);
  return searchTextCache.get(id).lower.includes(q);
}
// The snippet under a row whose match is in the body: some words before, the
// match highlighted, some words after. Built from text nodes and a <mark>, never
// from HTML, so note text can never become markup in the sidebar.
function bodySnippet(id, q) {
  const text = noteSearchText(id);
  const lower = searchTextCache.get(id).lower;
  const at = lower.indexOf(q);
  // No hit in the body means the caller shows the normal date line instead.
  if (at < 0) return null;
  // Up to 28 characters of context before the match and 60 after, whitespace collapsed to single spaces.
  const start = Math.max(0, at - 28);
  const end = Math.min(text.length, at + q.length + 60);
  const flat = s => s.replace(/\s+/g, " ");
  const out = mk("div", "note-meta note-snippet");
  // An ellipsis only where the snippet really cuts the text.
  out.append((start > 0 ? "…" : "") + flat(text.slice(start, at)));
  out.appendChild(mk("mark", null, text.slice(at, at + q.length)));
  out.append(flat(text.slice(at + q.length, end)) + (end < text.length ? "…" : ""));
  return out;
}
let currentPage = 0;   // session-only index into the open note's pages
let draggingPage = null;   // index of the page tab being dragged to reorder
function clearPageDropMark() {
  for (const el of $("page-tabs").querySelectorAll(".page-tab")) el.classList.remove("drop-left", "drop-right");
}
// Reorder a page. `to` is the slot in the ORIGINAL array, so removing first
// would shift it: compensate when moving right.
function movePage(from, to) {
  const n = viewedNote(), ps = notePages(n);
  if (!ps || syncing || backupView || trashViewId || from === null || !ps[from]) return;
  const dest = to > from ? to - 1 : to;
  if (dest === from || dest < 0 || dest > ps.length - 1) return;
  flushSave();
  historyMark(currentId);
  const [pg] = ps.splice(from, 1);
  ps.splice(dest, 0, pg);
  // Dragging reorders within a part; the parts themselves stay put.
  sortPagesBySection(ps);
  n.mtime = Date.now();
  currentPage = dest;
  persistSafe();
  if (pagedView()) renderSheets();
  renderPageTabs(); renderList(); renderStatus();
  status(`Moved "${pg.name || "page"}" to position ${dest + 1}`);
}
// The object the editor reads and writes: a page for a paged note, the note
// itself otherwise. One accessor so save/load can stay shape-agnostic.
function activeBody(n) {
  const ps = notePages(n);
  return ps ? ps[Math.min(currentPage, ps.length - 1)] : n;
}
const newPage = (name, body, section) => ({ id: crypto.randomUUID(), name, body: body || "", bodyV: 2,
  ...(section && section !== "body" ? { section } : {}) });

// ---- Page sections (title / body / final) ----
// A design preset marks pages as TITLE (always first), BODY (the middle, where
// new pages land) or FINAL (always last). Applying a design copies those marks
// onto the note, so only the notes you apply it to get the structure. A page
// with no mark is body, which is what every ordinary note has.
const SECTIONS = ["title", "body", "final"];
const SECTION_LABEL = { title: "Title", body: "Body", final: "Final" };
const pageSection = p => SECTIONS.includes(p && p.section) ? p.section : "body";
const sectionRank = p => SECTIONS.indexOf(pageSection(p));
// Title pages can never sit after body/final ones: re-sorted (stably, so the
// order WITHIN a part is whatever you dragged it to) after every mutation.
function sortPagesBySection(ps) {
  ps.sort((a, b) => sectionRank(a) - sectionRank(b));
  return ps;
}
const hasSections = n => (notePages(n) || []).some(p => pageSection(p) !== "body");
// Where a new BODY page belongs: after the last body page, i.e. before the
// first FINAL page. This is the slot the "+" button sits in.
function bodyInsertIndex(ps) {
  let i = ps.length;
  for (let k = 0; k < ps.length; k++) if (pageSection(ps[k]) === "final") { i = k; break; }
  return i;
}
function setPageSection(i, section) {
  const n = viewedNote(), ps = notePages(n);
  if (!ps || !ps[i] || syncing || backupView || trashViewId) return;
  flushSave();
  const pg = ps[i];
  if (section === "body") delete pg.section; else pg.section = section;
  sortPagesBySection(ps);
  currentPage = ps.indexOf(pg);
  n.mtime = Date.now();
  persistSafe();
  if (pagedView()) renderSheets();
  renderPageTabs(); renderList(); renderStatus();
  status(`Page moved to the ${SECTION_LABEL[section]} part`);
}

function renderPageTabs() {
  const bar = $("page-tabs");
  const n = currentId && vault && vault.notes[currentId] ? vault.notes[currentId]
    : (trashViewId && vault && vault.trash[trashViewId] ? vault.trash[trashViewId].data : null);
  const ps = notePages(n);
  if (!ps) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  if (currentPage >= ps.length) currentPage = ps.length - 1;
  bar.style.display = "flex";
  bar.innerHTML = "";
  const sectioned = hasSections(n);
  const addAt = bodyInsertIndex(ps);
  const editable = !trashViewId && !backupView;
  // The add button sits exactly where a new page would land: after the last
  // body page, before the FINAL block.
  const addBtn = () => {
    const add = mk("button", "page-add", "+");
    add.type = "button";
    add.title = sectioned ? "Add a page to the Body part" : "Add a page";
    add.disabled = syncing;
    add.onclick = () => addPage();
    return add;
  };
  let lastSec = null;
  ps.forEach((p, i) => {
    if (sectioned && i === addAt && editable) bar.appendChild(addBtn());
    const sec = pageSection(p);
    if (sectioned && sec !== lastSec) {
      bar.appendChild(mk("span", "sec-mark sec-" + sec, SECTION_LABEL[sec]));
      lastSec = sec;
    }
    const t = mk("button", "page-tab sec-" + sec + (i === currentPage ? " active" : ""), p.name || "Page " + (i + 1));
    t.type = "button";
    t.title = (sectioned ? SECTION_LABEL[sec] + " part - " : "") + "Page " + (i + 1) + " of " + ps.length;
    t.onclick = () => switchPage(i);
    t.ondblclick = () => { if (!trashViewId && !backupView) renamePage(i); };
    // Drag a tab to reorder the pages: left-to-right IS the document order, so
    // the first tab prints first and the last prints last.
    if (!trashViewId && !backupView) {
      t.draggable = !syncing;
      t.addEventListener("dragstart", e => {
        draggingPage = i;
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("application/x-page-index", String(i)); } catch {}
        t.classList.add("dragging");
      });
      t.addEventListener("dragend", () => { t.classList.remove("dragging"); draggingPage = null; clearPageDropMark(); });
      t.addEventListener("dragover", e => {
        if (draggingPage === null || draggingPage === i) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = t.getBoundingClientRect();
        clearPageDropMark();
        t.classList.add(e.clientX > r.left + r.width / 2 ? "drop-right" : "drop-left");
      });
      t.addEventListener("dragleave", () => t.classList.remove("drop-left", "drop-right"));
      t.addEventListener("drop", e => {
        if (draggingPage === null) return;
        e.preventDefault();
        const r = t.getBoundingClientRect();
        movePage(draggingPage, i + (e.clientX > r.left + r.width / 2 ? 1 : 0));
        draggingPage = null;
        clearPageDropMark();
      });
    }
    if (!trashViewId && !backupView) t.oncontextmenu = e => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: "Rename page", disabled: syncing, onClick: () => renamePage(i) },
        { label: "Add page after", disabled: syncing, onClick: () => addPage(i + 1) },
        { sep: true },
        { label: "Part", disabled: syncing, submenu: () => SECTIONS.map(s => ({
          label: SECTION_LABEL[s] + (s === "title" ? " (always first)" : s === "final" ? " (always last)" : " (the middle)"),
          checked: pageSection(ps[i]) === s,
          disabled: syncing,
          onClick: () => setPageSection(i, s),
        })) },
        { sep: true },
        { label: "Delete page", danger: true, disabled: syncing || ps.length < 2, onClick: () => deletePage(i) },
      ]);
    };
    bar.appendChild(t);
  });
  // Unsectioned notes keep the plain trailing "+"; sectioned ones already got
  // theirs in the body slot above (unless the body block is empty and last).
  if (editable && (!sectioned || addAt >= ps.length)) bar.appendChild(addBtn());
}
// The note currently on screen, live or read-only from the trash.
const viewedNote = () => trashViewId ? ((vault.trash[trashViewId] || {}).data || null)
  : (currentId ? vault.notes[currentId] : null);
function switchPage(i) {
  const n = viewedNote();
  const ps = notePages(n);
  if (!ps || i < 0 || i >= ps.length) return;
  // Sheet view: every page is already on screen, so a tab is just navigation -
  // nothing is saved, swapped or reloaded.
  if (pagedView()) {
    currentPage = i;
    scrollToPage(i);
    markActiveSheet(i);
    renderPageTabs();
    return;
  }
  if (i === currentPage) return;
  if (!trashViewId) flushSave();   // commit the page being left before swapping bodies
  currentPage = i;
  const t = ps[i];
  setEditorBody(t.body, { bodyV: t.bodyV });
  editorBaseline = getEditorBody();
  if (!trashViewId) dirty = false;
  // The reference pane follows the page you are on, re-frozen at this page's
  // saved state.
  if (splitMode && currentId && vault.notes[currentId]) {
    const nn = vault.notes[currentId];
    splitRef = { paged: isPaged(nn), pages: noteBodies(nn).map(b => ({ ...b })), label: splitLabel(nn) };
    renderPrevPane();
  }
  renderPageTabs();
  renderStatus();
}
// Single-page -> paged: page 1 IS the current body, so nothing is lost and the
// note reads identically until a second page is added.
function toPaged(n) {
  if (isPaged(n)) return notePages(n);
  n.pages = [newPage("Page 1", n.body || "")];
  if (n.bodyV !== 2) n.pages[0].bodyV = undefined;   // keep a legacy body legacy
  return n.pages;
}
// Turn the open note into a paged one and show the sheet view immediately.
function makePagedAndShow(id) {
  if (currentId !== id) openNote(id);
  flushSave();
  toPaged(vault.notes[id]);
  vault.notes[id].mtime = Date.now();
  currentPage = 0;
  persistSafe();
  renderSheets();
  dirty = false;
  renderPageTabs(); renderList(); renderStatus();
}
// One click: the page appears immediately, named "Page N". Rename is a
// right-click (or double-click) on its tab afterwards.
function addPage(at) {
  if (syncing || backupView || !currentId || !vault.notes[currentId]) return;
  flushSave();
  historyMark(currentId);
  const n = vault.notes[currentId];
  const ps = toPaged(n);
  // New pages are BODY pages and land in the body block - never after a FINAL
  // page, which is the whole point of the parts.
  const where = Math.max(0, Math.min(at === undefined ? bodyInsertIndex(ps) : at, ps.length));
  ps.splice(where, 0, newPage("Page " + (ps.length + 1)));
  sortPagesBySection(ps);
  n.mtime = Date.now();
  persistSafe();
  currentPage = where;
  if (pagedView() || isPaged(n)) {
    renderSheets();
    dirty = false;
    renderPageTabs(); renderList(); renderStatus();
    scrollToPage(where);
    const el = $("sheets").querySelector('.sheet-body[data-page="' + where + '"]');
    if (el) el.focus();
  } else {
    const t = activeBody(n);
    setEditorBody(t.body, { bodyV: t.bodyV });
    editorBaseline = getEditorBody();
    dirty = false;
    renderPageTabs(); renderList(); renderStatus();
  }
}
async function renamePage(i) {
  if (syncing || backupView || !currentId) return;
  const n = vault.notes[currentId], ps = notePages(n);
  if (!ps || !ps[i]) return;
  const name = await promptModal({ title: "Rename page", placeholder: "Page name",
    value: ps[i].name, confirmLabel: "Rename" });
  if (!name || syncing || !vault.notes[currentId]) return;
  historyMark(currentId);
  ps[i].name = name;
  n.mtime = Date.now();
  persistSafe();
  // The sheet carries the name in its label, so repaint it too.
  const lab = $("sheets").querySelector('.sheet[data-page="' + i + '"] .sheet-label .nm');
  if (lab) lab.textContent = name;
  renderPageTabs(); renderStatus();
}
async function deletePage(i) {
  if (syncing || backupView || !currentId) return;
  const n = vault.notes[currentId], ps = notePages(n);
  if (!ps || ps.length < 2 || !ps[i]) return;
  if (!await confirmModal({ title: `Delete "${ps[i].name}"?`,
    body: "This page and everything on it is removed from the note. Ctrl+Z brings it back.",
    confirmLabel: "Delete page", destructive: true })) return;
  if (syncing || !vault.notes[currentId]) return;
  historyMark(currentId);
  ps.splice(i, 1);
  // Collapsing back to one page keeps the note paged on purpose: dropping to the
  // single-page shape here would silently discard the page's name.
  if (currentPage >= ps.length) currentPage = ps.length - 1;
  n.mtime = Date.now();
  persistSafe();
  if (pagedView()) renderSheets();
  else { const t = activeBody(n); setEditorBody(t.body, { bodyV: t.bodyV }); editorBaseline = getEditorBody(); }
  dirty = false;
  renderPageTabs(); renderList(); renderStatus();
}

// ---------- Duplicate a note ----------
// "Trip" -> "Trip duplicate" -> "Trip duplicate1" -> "Trip duplicate2"...
// Duplicating a copy strips the existing suffix first, so duplicating
// "Trip duplicate" yields "Trip duplicate1", never "Trip duplicate duplicate".
function duplicateTitle(base) {
  const stem = (base || "").replace(/\s*duplicate\s*\d*\s*$/i, "").trim() || "(untitled)";
  const taken = new Set(Object.values(vault.notes).map(n => (n.title || "").trim()));
  let name = stem + " duplicate";
  for (let i = 1; taken.has(name); i++) name = stem + " duplicate" + i;
  return name;
}
function duplicateNote(id) {
  if (syncing || backupView || !vault.notes[id]) return;
  if (id === currentId) flushSave();   // copy what is on screen, not a stale buffer
  // Deep copy: pages, the media list and every field come along. Attachment IDS
  // are shared on purpose - the ciphertext is refcounted by mediaReferenced(),
  // so both notes point at the same bytes and neither can delete them alone.
  const copy = JSON.parse(JSON.stringify(vault.notes[id]));
  copy.title = duplicateTitle(vault.notes[id].title);
  copy.mtime = Date.now();
  delete copy.order;
  const fid = copy.folderId && vault.folders[copy.folderId] ? copy.folderId : null;
  { const o = topOrderOfGroup(fid); if (o !== undefined) copy.order = o; }
  const nid = crypto.randomUUID();
  vault.notes[nid] = copy;
  persistSafe();
  openNote(nid);
  renderList();
  renderStatus();
  status(`Duplicated as "${copy.title}"`);
}
