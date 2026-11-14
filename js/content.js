/*
 * content.js - note bodies: what may be in them, pages, searching them, and
 * duplicating a note.
 *
 * The editor is a contenteditable <div>. A note body is either old plain text
 * (bodyV !== 2, shown through textContent, so a literal "<img onerror>" stays
 * text) or sanitised HTML (bodyV === 2) whose only markup is lines, formatting
 * and inline attachment wrappers that carry a media id: never bytes, never a
 * blob: or data: URL. Saving and loading run the same strict allowlist
 * (lines.js and history.js), so a poisoned synced body cannot bring in
 * script, onerror or style, and every stored body names its media by id only.
 *
 * A note has either one body (note.body) or pages (note.pages, a list of
 * { id, name, body, bodyV, section }). Everything that reads content goes
 * through noteBodies(), so both shapes work. A page belongs to one of three
 * parts: title (always first), body (the middle) or final (always last).
 *
 * Main functions: validInlineMedia, bodyMediaIds, notePages, noteBodies,
 * activeBody, noteMatches, bodySnippet, renderPageTabs, switchPage, movePage,
 * setPageSection, sortPagesBySection, toPaged, makePagedAndShow, addPage,
 * renamePage, deletePage, duplicateNote.
 * Auxiliary functions: escapeHtml, isPaged, viewedNote, newPage, pageSection,
 * sectionRank, hasSections, bodyInsertIndex, bodyPlainText, noteSearchText,
 * clearPageDropMark, duplicateTitle.
 *
 * Complexity: searching a note is O(t) in its text, built once per change and
 * cached; drawing the page tabs is O(p) in the pages; duplicating a note is
 * O(s) in its size (a JSON copy).
 */
"use strict";

// ---------- State ----------

// Which note load is current: switching notes cancels inline decrypts still on their way.
let editorSeq = 0;

// getEditorBody() when the note was loaded or last saved: what "has it changed?" compares against.
let editorBaseline = "";

// For a body still in the old plain-text shape, its original string (null otherwise).
let editorPlainOrig = null;

// A media id is a UUID, and an inline attachment is one of these kinds.
const INLINE_MID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE_KINDS = new Set(["image", "video", "pdf", "text", "file"]);

// Each note's searchable text, by note id: { mtime, text, lower }. It is
// plaintext, so lockApp clears it.
const searchTextCache = new Map();

// The page of the open note being edited (this session only).
let currentPage = 0;

// The index of the page tab being dragged to a new place, or null.
let draggingPage = null;

// The three parts a page can belong to, in the order they print.
const SECTIONS = ["title", "body", "final"];
const SECTION_LABEL = { title: "Title", body: "Body", final: "Final" };

// ---------- Note bodies and pages ----------

/**
 * Whether an element is a real inline attachment wrapper: a span with the
 * class inline-media, a UUID in data-mid and a known data-kind. Returns
 * { mid, kind }, or null for anything else, which the sanitiser then drops, so
 * a poisoned body cannot smuggle markup out again when it is saved.
 *
 * Used by: this file (bodyMediaIds), lines.js (serializeBodyInto, wrapperOf),
 * history.js (sanitizeBodyInto).
 * Uses: INLINE_MID_RE and INLINE_KINDS.
 * Complexity: O(1).
 */
function validInlineMedia(el) {
  if (!el || el.nodeType !== 1 || el.tagName !== "SPAN") {
    return null;
  }
  if (!el.classList.contains("inline-media")) {
    return null;
  }
  const mid = el.getAttribute("data-mid") || "";
  const kind = el.getAttribute("data-kind") || "";
  if (!INLINE_MID_RE.test(mid) || !INLINE_KINDS.has(kind)) {
    return null;
  }
  return { mid, kind };
}

/**
 * The media ids a bodyV 2 body places inline. The body is parsed in an inert
 * <template> (nothing is fetched, no onerror runs) and read back through
 * validInlineMedia, so it finds exactly the ids the sanitiser would keep.
 * Without this, an attachment that lives only inline (not in note.media)
 * would be wrongly purged, or never uploaded. Returns [] for a plain body.
 *
 * Used by: vault.js (mediaReferenced), media-sync.js (mediaIdsFor, syncMediaPhase).
 * Uses: validInlineMedia.
 * Complexity: O(n) in the body's length.
 */
function bodyMediaIds(body, bodyV) {
  if (bodyV !== 2 || typeof body !== "string" || body.indexOf("inline-media") === -1) {
    return [];
  }
  const template = document.createElement("template");
  template.innerHTML = body;
  const out = [];
  template.content.querySelectorAll("span.inline-media").forEach(span => {
    const media = validInlineMedia(span);
    if (media) {
      out.push(media.mid);
    }
  });
  return out;
}

/**
 * A note's pages, or null when it has a single body.
 *
 * Used by: this file, attachments.js (addMedia), designs.js (exportDesign,
 * presetFromNote), history.js (designedPages, reloadNoteInPlace,
 * resetNoteLayout, undesignPages, and on load), lines.js (renderSheets),
 * merge.js (applyMerge), notes.js (noteMenu), pagination.js
 * (syncPagesFromDom), split.js (splitLabel).
 * Uses: nothing.
 * Complexity: O(1).
 */
function notePages(note) {
  return (note && Array.isArray(note.pages) && note.pages.length) ? note.pages : null;
}

/**
 * Every body in a note, in order, as { body, bodyV, name }: one per page, or
 * the single body. Anything that scans content (purging media, export,
 * search) goes through this, never note.body alone.
 *
 * Used by: this file (noteSearchText, switchPage), vault.js (mediaReferenced),
 * media-sync.js (mediaIdsFor), designs.js (applyPreset), pdf.js
 * (buildNotePdf, exportNotePdf, sidecarAttachments), split.js (enterSplit).
 * Uses: notePages.
 * Complexity: O(p) in the pages.
 */
function noteBodies(note) {
  if (!note) {
    return [];
  }
  const pages = notePages(note);
  return pages ? pages.map(page => ({ body: page.body || "", bodyV: page.bodyV, name: page.name }))
            : [{ body: note.body || "", bodyV: note.bodyV, name: note.title || "" }];
}

/**
 * What the editor reads and writes: the current page of a paged note, or the
 * note itself. Saving and loading use it, so they need not know the shape.
 *
 * Used by: this file (addPage, deletePage), pagination.js (openNote,
 * openTrash, saveCurrent), history.js (historyApply, reloadNoteInPlace).
 * Uses: notePages, currentPage.
 * Complexity: O(1).
 */
function activeBody(note) {
  const pages = notePages(note);
  return pages ? pages[Math.min(currentPage, pages.length - 1)] : note;
}

/**
 * Puts title pages first and final pages last, keeping the order within each
 * part (the sort is stable), and returns the same list. Runs after anything
 * that moves or adds a page.
 *
 * Used by: this file (movePage, setPageSection, addPage), designs.js (importDesignDoc).
 * Uses: sectionRank.
 * Complexity: O(p log p).
 */
function sortPagesBySection(pages) {
  pages.sort((a, b) => sectionRank(a) - sectionRank(b));
  return pages;
}

/**
 * Turns a one-body note into a paged one, if it is not already, and returns
 * its pages. Page 1 is the current body, so nothing is lost and the note reads
 * the same until a second page is added. An old plain body stays plain.
 *
 * Used by: this file (makePagedAndShow, addPage), designs.js (designItems),
 * history.js (on load).
 * Uses: isPaged, notePages, newPage.
 * Complexity: O(1).
 */
function toPaged(note) {
  if (isPaged(note)) {
    return notePages(note);
  }
  note.pages = [newPage("Page 1", note.body || "")];
  if (note.bodyV !== 2) {
    note.pages[0].bodyV = undefined;
  }
  return note.pages;
}

/**
 * Makes a note paged and shows it as sheets at once (the note menu's "Use pages").
 *
 * Used by: notes.js (noteMenu).
 * Uses: openNote, flushSave and renderStatus (pagination.js), toPaged,
 * persistSafe (vault.js), renderSheets (lines.js), renderPageTabs, renderList (sidebar.js).
 * Complexity: O(p) to draw the sheets.
 */
function makePagedAndShow(id) {
  if (currentId !== id) {
    openNote(id);
  }
  flushSave();
  toPaged(vault.notes[id]);
  vault.notes[id].mtime = Date.now();
  currentPage = 0;
  persistSafe();
  renderSheets();
  unsavedEdits = false;
  renderPageTabs();
  renderList();
  renderStatus();
}

// ---------- Search ----------

/**
 * Whether a note's title or text contains the (lower-case) query. The title
 * is checked first, since it costs nothing; the text comes from the cache.
 *
 * Used by: sidebar.js (renderListInner).
 * Uses: noteSearchText.
 * Complexity: O(t) in the note's text, O(1) to build it again while it is cached.
 */
function noteMatches(id, query) {
  if ((vault.notes[id].title || "").toLowerCase().includes(query)) {
    return true;
  }
  noteSearchText(id);
  return searchTextCache.get(id).lower.includes(query);
}

/**
 * The line under a search result whose match is in the text: up to 28
 * characters before, the match highlighted, up to 60 after, with an ellipsis
 * only where the text is really cut. Built from text nodes and a <mark>,
 * never from HTML, so note text can never become markup in the sidebar.
 * Returns null when the match is not in the text (the row then shows its date).
 *
 * Used by: sidebar.js (noteRow).
 * Uses: noteSearchText, makeElement (sidebar.js).
 * Complexity: O(t) in the note's text.
 */
function bodySnippet(id, query) {
  const text = noteSearchText(id);
  const lower = searchTextCache.get(id).lower;
  const at = lower.indexOf(query);
  if (at < 0) {
    return null;
  }
  const start = Math.max(0, at - 28);
  const end = Math.min(text.length, at + query.length + 60);
  const flat = s => s.replace(/\s+/g, " ");
  const out = makeElement("div", "note-meta note-snippet");
  out.append((start > 0 ? "…" : "") + flat(text.slice(start, at)));
  out.appendChild(makeElement("mark", null, text.slice(at, at + query.length)));
  out.append(flat(text.slice(at + query.length, end)) + (end < text.length ? "…" : ""));
  return out;
}

// ---------- Page tabs ----------

/**
 * Draws the page tabs above the editor (hidden for a one-body note). Left to
 * right is the order the pages print in. A click opens a page, a
 * double-click renames it, dragging moves it, and a right-click gives
 * rename, add after, part (title, body, final) and delete. In a note with
 * parts, a small label starts each part, and the "+" sits where a new body
 * page would land: before the final pages. Nothing can be changed in the
 * trash or in a backup.
 *
 * Used by: this file, lines.js (renderSheets), pagination.js (openNote,
 * openTrash, repaginate, and on load), history.js (reloadNoteInPlace),
 * merge.js (applyMerge).
 * Uses: notePages, hasSections, bodyInsertIndex, pageSection, makeElement
 * (sidebar.js), switchPage, renamePage, addPage, deletePage, movePage,
 * setPageSection, clearPageDropMark, openMenu (menu.js).
 * Complexity: O(p) in the pages.
 */
function renderPageTabs() {
  const bar = $("page-tabs");
  const note = currentId && vault && vault.notes[currentId] ? vault.notes[currentId]
    : (trashViewId && vault && vault.trash[trashViewId] ? vault.trash[trashViewId].data : null);
  const pages = notePages(note);
  if (!pages) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  if (currentPage >= pages.length) {
    currentPage = pages.length - 1;
  }
  bar.style.display = "flex";
  bar.innerHTML = "";

  const sectioned = hasSections(note);
  const addAt = bodyInsertIndex(pages);
  const editable = !trashViewId && !backupView;
  const addButton = () => {
    const button = makeElement("button", "page-add", "+");
    button.type = "button";
    button.title = sectioned ? "Add a page to the Body part" : "Add a page";
    button.disabled = syncing;
    button.onclick = () => addPage();
    return button;
  };

  let lastSection = null;
  pages.forEach((page, i) => {
    if (sectioned && i === addAt && editable) {
      bar.appendChild(addButton());
    }
    const section = pageSection(page);
    if (sectioned && section !== lastSection) {
      bar.appendChild(makeElement("span", "sec-mark sec-" + section, SECTION_LABEL[section]));
      lastSection = section;
    }

    const tab = makeElement("button", "page-tab sec-" + section + (i === currentPage ? " active" : ""), page.name || "Page " + (i + 1));
    tab.type = "button";
    tab.title = (sectioned ? SECTION_LABEL[section] + " part - " : "") + "Page " + (i + 1) + " of " + pages.length;
    tab.onclick = () => switchPage(i);
    tab.ondblclick = () => {
      if (!trashViewId && !backupView) {
        renamePage(i);
      }
    };

    if (!trashViewId && !backupView) {
      tab.draggable = !syncing;
      tab.addEventListener("dragstart", event => {
        draggingPage = i;
        event.dataTransfer.effectAllowed = "move";
        try {
          event.dataTransfer.setData("application/x-page-index", String(i));
        } catch {}
        tab.classList.add("dragging");
      });
      tab.addEventListener("dragend", () => {
        tab.classList.remove("dragging");
        draggingPage = null;
        clearPageDropMark();
      });
      tab.addEventListener("dragover", event => {
        if (draggingPage === null || draggingPage === i) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const box = tab.getBoundingClientRect();
        clearPageDropMark();
        tab.classList.add(event.clientX > box.left + box.width / 2 ? "drop-right" : "drop-left");
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("drop-left", "drop-right"));
      tab.addEventListener("drop", event => {
        if (draggingPage === null) {
          return;
        }
        event.preventDefault();
        const box = tab.getBoundingClientRect();
        movePage(draggingPage, i + (event.clientX > box.left + box.width / 2 ? 1 : 0));
        draggingPage = null;
        clearPageDropMark();
      });
    }

    if (!trashViewId && !backupView) {
      tab.oncontextmenu = event => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, [
          { label: "Rename page", disabled: syncing, onClick: () => renamePage(i) },
          { label: "Add page after", disabled: syncing, onClick: () => addPage(i + 1) },
          { sep: true },
          {
            label: "Part",
            disabled: syncing,
            submenu: () => SECTIONS.map(part => ({
              label: SECTION_LABEL[part] + (part === "title" ? " (always first)" : part === "final" ? " (always last)" : " (the middle)"),
              checked: pageSection(pages[i]) === part,
              disabled: syncing,
              onClick: () => setPageSection(i, part),
            })),
          },
          { sep: true },
          { label: "Delete page", danger: true, disabled: syncing || pages.length < 2, onClick: () => deletePage(i) },
        ]);
      };
    }
    bar.appendChild(tab);
  });

  // A note without parts has its "+" at the end; one with parts got it in the
  // body slot above, unless the body part is empty and last.
  if (editable && (!sectioned || addAt >= pages.length)) {
    bar.appendChild(addButton());
  }
}

/**
 * Opens page i. On sheets every page is already on screen, so this only
 * scrolls there. Otherwise the page being left is saved first, the editor
 * loads page i, and in split view the reference pane follows, frozen at the
 * saved state of this page.
 *
 * Used by: this file (a click on a tab).
 * Uses: viewedNote, notePages, pagedView (lines.js), scrollToPage,
 * markActiveSheet and flushSave (pagination.js), setEditorBody and
 * getEditorBody (lines.js), isPaged, noteBodies, splitLabel and
 * renderPrevPane (split.js), renderPageTabs, renderStatus (pagination.js).
 * Complexity: O(n) in the page's body, to load it.
 */
function switchPage(i) {
  const note = viewedNote();
  const pages = notePages(note);
  if (!pages || i < 0 || i >= pages.length) {
    return;
  }
  if (pagedView()) {
    currentPage = i;
    scrollToPage(i);
    markActiveSheet(i);
    renderPageTabs();
    return;
  }
  if (i === currentPage) {
    return;
  }

  if (!trashViewId) {
    flushSave();
  }
  currentPage = i;
  const page = pages[i];
  setEditorBody(page.body, { bodyV: page.bodyV });
  editorBaseline = getEditorBody();
  if (!trashViewId) {
    unsavedEdits = false;
  }
  if (splitMode && currentId && vault.notes[currentId]) {
    const liveNote = vault.notes[currentId];
    splitRef = {
      paged: isPaged(liveNote),
      pages: noteBodies(liveNote).map(body => ({ ...body })),
      label: splitLabel(liveNote),
    };
    renderPrevPane();
  }
  renderPageTabs();
  renderStatus();
}

/**
 * Moves a page from one place to another (dragging a tab). to is a slot in
 * the list as it was before the move, so a move to the right lands one
 * earlier once the page is taken out. Pages stay within their part. One undo step.
 *
 * Used by: this file (dropping a dragged tab).
 * Uses: viewedNote, notePages, flushSave (pagination.js), historyMark
 * (history.js), sortPagesBySection, persistSafe (vault.js), pagedView and
 * renderSheets (lines.js), renderPageTabs, renderList (sidebar.js),
 * renderStatus and status (pagination.js).
 * Complexity: O(p) in the pages, plus drawing the sheets.
 */
function movePage(from, to) {
  const note = viewedNote();
  const pages = notePages(note);
  if (!pages || syncing || backupView || trashViewId || from === null || !pages[from]) {
    return;
  }
  const destination = to > from ? to - 1 : to;
  if (destination === from || destination < 0 || destination > pages.length - 1) {
    return;
  }
  flushSave();
  historyMark(currentId);
  const [page] = pages.splice(from, 1);
  pages.splice(destination, 0, page);
  sortPagesBySection(pages);
  note.mtime = Date.now();
  currentPage = destination;
  persistSafe();
  if (pagedView()) {
    renderSheets();
  }
  renderPageTabs();
  renderList();
  renderStatus();
  status(`Moved "${page.name || "page"}" to position ${destination + 1}`);
}

/**
 * Moves page i to a part (title, body or final), where it lands at the end
 * of that part. Body is stored as no mark at all.
 *
 * Used by: this file (the tab's right-click menu, Part).
 * Uses: viewedNote, notePages, flushSave (pagination.js), sortPagesBySection,
 * persistSafe (vault.js), pagedView and renderSheets (lines.js),
 * renderPageTabs, renderList (sidebar.js), renderStatus and status (pagination.js).
 * Complexity: O(p log p), plus drawing the sheets.
 */
function setPageSection(i, section) {
  const note = viewedNote();
  const pages = notePages(note);
  if (!pages || !pages[i] || syncing || backupView || trashViewId) {
    return;
  }
  flushSave();
  const page = pages[i];
  if (section === "body") {
    delete page.section;
  } else {
    page.section = section;
  }
  sortPagesBySection(pages);
  currentPage = pages.indexOf(page);
  note.mtime = Date.now();
  persistSafe();
  if (pagedView()) {
    renderSheets();
  }
  renderPageTabs();
  renderList();
  renderStatus();
  status(`Page moved to the ${SECTION_LABEL[section]} part`);
}

// ---------- Adding, renaming and deleting pages ----------

/**
 * Adds an empty body page named "Page N", at a given place or by default at
 * the end of the body part (never after a final page), and opens it. A
 * one-body note becomes paged first. Renaming is a right-click or a
 * double-click on its tab afterwards. One undo step.
 *
 * Used by: this file (the "+" button, "Add page after"), notes.js (noteMenu).
 * Uses: flushSave (pagination.js), historyMark (history.js), toPaged,
 * bodyInsertIndex, newPage, sortPagesBySection, persistSafe (vault.js),
 * pagedView, renderSheets, setEditorBody and getEditorBody (lines.js),
 * isPaged, activeBody, renderPageTabs, renderList (sidebar.js), renderStatus
 * and scrollToPage (pagination.js).
 * Complexity: O(p log p), plus drawing the sheets.
 */
function addPage(at) {
  if (syncing || backupView || !currentId || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  historyMark(currentId);
  const note = vault.notes[currentId];
  const pages = toPaged(note);
  const where = Math.max(0, Math.min(at === undefined ? bodyInsertIndex(pages) : at, pages.length));
  pages.splice(where, 0, newPage("Page " + (pages.length + 1)));
  sortPagesBySection(pages);
  note.mtime = Date.now();
  persistSafe();
  currentPage = where;

  if (pagedView() || isPaged(note)) {
    renderSheets();
    unsavedEdits = false;
    renderPageTabs();
    renderList();
    renderStatus();
    scrollToPage(where);
    const sheetBody = $("sheets").querySelector('.sheet-body[data-page="' + where + '"]');
    if (sheetBody) {
      sheetBody.focus();
    }
  } else {
    const page = activeBody(note);
    setEditorBody(page.body, { bodyV: page.bodyV });
    editorBaseline = getEditorBody();
    unsavedEdits = false;
    renderPageTabs();
    renderList();
    renderStatus();
  }
}

/**
 * Asks for a new name for page i and sets it, on its tab and on its sheet's
 * label. One undo step.
 *
 * Used by: this file (a double-click on a tab, "Rename page").
 * Uses: notePages, promptModal (modal.js), historyMark (history.js),
 * persistSafe (vault.js), renderPageTabs, renderStatus (pagination.js).
 * Complexity: O(1), plus drawing the tabs.
 */
async function renamePage(i) {
  if (syncing || backupView || !currentId) {
    return;
  }
  const note = vault.notes[currentId];
  const pages = notePages(note);
  if (!pages || !pages[i]) {
    return;
  }
  const name = await promptModal({ title: "Rename page", placeholder: "Page name", value: pages[i].name, confirmLabel: "Rename" });
  if (!name || syncing || !vault.notes[currentId]) {
    return;
  }
  historyMark(currentId);
  pages[i].name = name;
  note.mtime = Date.now();
  persistSafe();
  const label = $("sheets").querySelector('.sheet[data-page="' + i + '"] .sheet-label .nm');
  if (label) {
    label.textContent = name;
  }
  renderPageTabs();
  renderStatus();
}

/**
 * Deletes page i after asking (never the last page). A note left with one
 * page stays paged on purpose: going back to one body would silently lose
 * the page's name. Ctrl+Z brings the page back.
 *
 * Used by: this file ("Delete page").
 * Uses: notePages, confirmModal (modal.js), historyMark (history.js),
 * persistSafe (vault.js), pagedView, renderSheets, setEditorBody and
 * getEditorBody (lines.js), activeBody, renderPageTabs, renderList
 * (sidebar.js), renderStatus (pagination.js).
 * Complexity: O(p), plus drawing the sheets.
 */
async function deletePage(i) {
  if (syncing || backupView || !currentId) {
    return;
  }
  const note = vault.notes[currentId];
  const pages = notePages(note);
  if (!pages || pages.length < 2 || !pages[i]) {
    return;
  }
  if (!await confirmModal({ title: `Delete "${pages[i].name}"?`,
    body: "This page and everything on it is removed from the note. Ctrl+Z brings it back.",
    confirmLabel: "Delete page", destructive: true })) {
    return;
  }
  if (syncing || !vault.notes[currentId]) {
    return;
  }
  historyMark(currentId);
  pages.splice(i, 1);
  if (currentPage >= pages.length) {
    currentPage = pages.length - 1;
  }
  note.mtime = Date.now();
  persistSafe();
  if (pagedView()) {
    renderSheets();
  } else {
    const page = activeBody(note);
    setEditorBody(page.body, { bodyV: page.bodyV });
    editorBaseline = getEditorBody();
  }
  unsavedEdits = false;
  renderPageTabs();
  renderList();
  renderStatus();
}

// ---------- Duplicating a note ----------

/**
 * Copies a note (what is on screen, if it is the open one) as "<title>
 * duplicate", at the top of its folder, and opens the copy. The copy is deep:
 * pages, the media list and every field. Attachment ids are shared on
 * purpose: mediaReferenced counts every note that names an id, so both notes
 * point at the same encrypted bytes and neither can delete them alone.
 *
 * Used by: notes.js (noteMenu), designs.js (designItems).
 * Uses: flushSave, openNote, renderStatus and status (pagination.js),
 * duplicateTitle, topOrderOfGroup and renderList (sidebar.js), persistSafe (vault.js).
 * Complexity: O(s) in the note's size, plus O(n) over the notes for the name.
 */
function duplicateNote(id) {
  if (syncing || backupView || !vault.notes[id]) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }
  const copy = JSON.parse(JSON.stringify(vault.notes[id]));
  copy.title = duplicateTitle(vault.notes[id].title);
  copy.mtime = Date.now();
  delete copy.order;
  const folderId = copy.folderId && vault.folders[copy.folderId] ? copy.folderId : null;
  // The copy goes to the top of its folder.
  {
    const order = topOrderOfGroup(folderId);
    if (order !== undefined) {
      copy.order = order;
    }
  }
  const newId = crypto.randomUUID();
  vault.notes[newId] = copy;
  persistSafe();
  openNote(newId);
  renderList();
  renderStatus();
  status(`Duplicated as "${copy.title}"`);
}

// =================== Auxiliary functions ===================

/**
 * Escapes text so it parses back to the same characters and stays inert. A
 * newline is not special in HTML text, so it survives as it is. Also used by
 * lines.js. Complexity: O(n).
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** Whether a note has pages. Also used by several other files. Complexity: O(1). */
function isPaged(note) {
  return !!notePages(note);
}

/** The note on screen, live or read-only from the trash, or null. Also used by lines.js. Complexity: O(1). */
function viewedNote() {
  return trashViewId ? ((vault.trash[trashViewId] || {}).data || null)
    : (currentId ? vault.notes[currentId] : null);
}

/** A new page with a fresh id; a part other than body is recorded on it. Complexity: O(1). */
function newPage(name, body, section) {
  return { id: crypto.randomUUID(), name, body: body || "", bodyV: 2,
    ...(section && section !== "body" ? { section } : {}) };
}

/** The part a page belongs to (body unless marked). Also used by other files. Complexity: O(1). */
function pageSection(page) {
  return SECTIONS.includes(page && page.section) ? page.section : "body";
}

/** A page's part as a number for sorting: title 0, body 1, final 2. Complexity: O(1). */
function sectionRank(page) {
  return SECTIONS.indexOf(pageSection(page));
}

/** Whether any page of a note is marked title or final. Also used by lines.js. Complexity: O(p). */
function hasSections(note) {
  return (notePages(note) || []).some(page => pageSection(page) !== "body");
}

/** Where a new body page goes: before the first final page (or at the end). Complexity: O(p). */
function bodyInsertIndex(pages) {
  let index = pages.length;
  for (let k = 0; k < pages.length; k++) {
    if (pageSection(pages[k]) === "final") {
      index = k;
      break;
    }
  }
  return index;
}

/**
 * The text of one body as the page shows it, for search. A plain body is
 * already text. A v2 body is sanitised (parsed inert: nothing loads or runs)
 * and read line by line, so words on two lines never fuse; censored text is
 * removed first, so it never matches and never shows in a snippet.
 * Complexity: O(n) in the body.
 */
function bodyPlainText(entry) {
  if (entry.bodyV !== 2) {
    return entry.body || "";
  }
  const holder = document.createElement("div");
  holder.appendChild(bodyFragment(entry.body, 2));
  for (const el of holder.querySelectorAll("[data-censor]")) {
    el.remove();
  }
  return plainLines(holder);
}

/**
 * A note's searchable text: every page, joined by newlines so words on two
 * pages never fuse. Built once per change (by mtime) and cached with a
 * lower-case copy, since every search compares lower case. Complexity: O(t)
 * when built, O(1) when cached.
 */
function noteSearchText(id) {
  const note = vault.notes[id];
  const hit = searchTextCache.get(id);
  if (hit && hit.mtime === note.mtime) {
    return hit.text;
  }
  const text = noteBodies(note).map(bodyPlainText).join("\n");
  const entry = { mtime: note.mtime, text, lower: text.toLowerCase() };
  searchTextCache.set(id, entry);
  return text;
}

/** Takes the drop marks off every page tab. Complexity: O(p). */
function clearPageDropMark() {
  for (const el of $("page-tabs").querySelectorAll(".page-tab")) {
    el.classList.remove("drop-left", "drop-right");
  }
}

/**
 * A free name for a copy: "Trip duplicate", then "Trip duplicate1", "Trip
 * duplicate2"... An existing suffix is taken off first, so copying "Trip
 * duplicate" gives "Trip duplicate1", never "Trip duplicate duplicate".
 * Complexity: O(n) over the notes.
 */
function duplicateTitle(base) {
  const stem = (base || "").replace(/\s*duplicate\s*\d*\s*$/i, "").trim() || "(untitled)";
  const taken = new Set(Object.values(vault.notes).map(note => (note.title || "").trim()));
  let name = stem + " duplicate";
  for (let i = 1; taken.has(name); i++) {
    name = stem + " duplicate" + i;
  }
  return name;
}
