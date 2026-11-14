/*
 * history.js - undo and redo, the second screen's structure buttons,
 * wrapping a note in a design, the sanitiser every stored body is loaded
 * through, and the layout of pictures and tables.
 *
 * Undo and redo. Each note has its own history of whole-note snapshots:
 * text, pages, parts, the applied design and the attachment list move
 * together, so "turn into pages" and "apply design" walk back exactly like a
 * typo does. Snapshots live in memory only (30 copies of a note is far too
 * much to encrypt and sync on every save), and lockApp clears them, since
 * they are plaintext.
 *
 * The sanitiser. A stored body is never put into the page as it is: it is
 * parsed in an inert <template> (nothing loads, no onerror runs, no script
 * runs), and only the allowed nodes are copied, one by one, into a fresh
 * fragment: text, line breaks, lines and frames, lists, tables, safe links,
 * formatting and inline attachment wrappers rebuilt from a checked id. A
 * style is rebuilt declaration by declaration (sanitizeStyle). So a body
 * tampered with in the repository cannot run anything or fetch anything.
 *
 * Main functions: historyMark, historyMarkTyping, historyApply, historyUndo,
 * historyRedo, renderHistoryButtons, reloadNoteInPlace,
 * restoreSplitSnapshot, updateSplitButtons, designedPages,
 * adoptDesignMedia, applyDesignToNote, resetNoteLayout,
 * sanitizeBodyFragment, sanitizeBodyInto, sanitizeStyle, cssColorHex,
 * packAttachmentRuns, mediaLayout, applyMediaLayout, placeFloating.
 * Auxiliary functions: noteSnapshot, historyFor, undesignPages, frameBody,
 * parsePercent, onePageContentPx, inlineDims, ensureColWidths.
 *
 * Complexity: a snapshot is O(s) in the note's size (one JSON copy), and a
 * history holds at most 30, so O(30 s) of memory per note; sanitising a body
 * is O(n) in its markup.
 */
"use strict";

// ---------- State ----------

// The most snapshots a note keeps (well past the 20 steps asked for), and
// the histories: note id -> { past: [], future: [] }.
const HISTORY_LIMIT = 30;
const histories = new Map();

// Set by anything that reshapes the note and draws it again (a design
// applied, a format switched, undo in the second screen). Those paths take
// the baseline again from the new screen, so saveCurrent's "nothing changed"
// shortcut matched and "Save edit" once saved nothing at all: the change was
// gone on the next unlock. While this is set the shortcuts are off; it drops
// only when the note is really saved, or the change deliberately thrown away.
let structureDirty = false;

// Whether the current burst of typing already has its undo step.
let historyTypingMarked = false;

// ---------- Undo and redo ----------

/**
 * Takes an undo step: call it before changing a note. The snapshot is the
 * note as it is now; it is skipped when it equals the last one, so marking
 * costs nothing when nothing changed. A new step drops what could be redone.
 *
 * Used by: this file, toolbar.js (markFormatStep), content.js (addPage,
 * deletePage, movePage, renamePage), designs.js (applyDesign, applyPreset),
 * attachments.js (addMedia).
 * Uses: noteSnapshot, historyFor, renderHistoryButtons.
 * Complexity: O(s) in the note's size.
 */
function historyMark(id) {
  id = id || currentId;
  if (!id || !vault || !vault.notes[id] || backupView || trashViewId) {
    return;
  }
  const snapshot = noteSnapshot(id);
  if (snapshot === null) {
    return;
  }
  const timeline = historyFor(id);
  if (timeline.past.length && timeline.past[timeline.past.length - 1] === snapshot) {
    return;
  }
  timeline.past.push(snapshot);
  while (timeline.past.length > HISTORY_LIMIT) {
    timeline.past.shift();
  }
  timeline.future.length = 0;
  renderHistoryButtons();
}

/**
 * The undo step for typing: one per burst, not one per key. It is taken at
 * the first key after a save, when the note still holds the earlier text.
 *
 * Used by: events.js (typing, on load), pagination.js (the title, on load).
 * Uses: historyMark.
 * Complexity: O(s) once per burst.
 */
function historyMarkTyping() {
  if (historyTypingMarked) {
    return;
  }
  historyTypingMarked = true;
  historyMark(currentId);
}

/**
 * Undoes ("undo") or redoes ("redo") one step of the open note. What is on
 * screen is taken in first, or keys still waiting to be saved would come
 * back as a phantom edit after the swap. In the second screen saving is
 * paused, so typed text lives only on the page: it is folded into the note
 * in memory (not saved) before the snapshot; without that, Ctrl+Z rebuilt
 * the sheets from the old note and the typing vanished from the screen and
 * from every step. There nothing is written either: the undo is part of the
 * temporary edit, and structureDirty makes the eventual "Save edit" write.
 * A step equal to the screen is skipped.
 *
 * Used by: this file (historyUndo, historyRedo).
 * Uses: historyFor, status, saveCurrent, syncPagesFromDom and renderStatus
 * (pagination.js), pagedView and getEditorBody (lines.js), isPaged and
 * activeBody (content.js), noteSnapshot, reloadNoteInPlace, persistLocal
 * (vault.js), updateSplitButtons, renderHistoryButtons.
 * Complexity: O(s) in the note's size.
 */
function historyApply(direction) {
  if (!currentId || !vault || !vault.notes[currentId] || backupView || trashViewId) {
    return;
  }
  const timeline = historyFor(currentId);
  const from = direction === "undo" ? timeline.past : timeline.future;
  const to = direction === "undo" ? timeline.future : timeline.past;
  if (!from.length) {
    status(direction === "undo" ? "Nothing to undo" : "Nothing to redo");
    return;
  }

  clearTimeout(saveTimer);
  if (!splitMode) {
    saveCurrent();
  } else {
    const note = vault.notes[currentId];
    note.title = $("title").value;
    if (pagedView() && isPaged(note)) {
      syncPagesFromDom();
    } else {
      const target = activeBody(note);
      target.body = getEditorBody();
      target.bodyV = 2;
    }
  }

  const now = noteSnapshot(currentId);
  const next = from.pop();
  if (next === now && from.length) {
    to.push(now);
    return historyApply(direction);
  }
  to.push(now);
  vault.notes[currentId] = JSON.parse(next);
  currentPage = 0;
  historyTypingMarked = false;
  reloadNoteInPlace();
  if (splitMode) {
    unsavedEdits = true;
    structureDirty = true;
    renderStatus();
  } else {
    persistLocal().catch(error => status("Save failed: " + error.message, true));
  }
  updateSplitButtons();
  renderHistoryButtons();
  status(direction === "undo" ? "Undone" : "Redone");
}

/**
 * Undoes one step (Ctrl+Z, the undo button, the browser's own Undo).
 *
 * Used by: censor.js (the keyboard, the buttons and beforeinput, on load).
 * Uses: historyApply.
 * Complexity: O(s).
 */
function historyUndo() {
  return historyApply("undo");
}

/**
 * Redoes one step (Ctrl+Y or Ctrl+Shift+Z, the redo button).
 *
 * Used by: censor.js (the keyboard, the buttons and beforeinput, on load).
 * Uses: historyApply.
 * Complexity: O(s).
 */
function historyRedo() {
  return historyApply("redo");
}

/**
 * Turns the undo and redo buttons on or off, with the number of steps each
 * has in its tooltip.
 *
 * Used by: this file, pagination.js (openNote), settings.js (lockApp).
 * Uses: nothing.
 * Complexity: O(1).
 */
function renderHistoryButtons() {
  const timeline = currentId ? histories.get(currentId) : null;
  const undoButton = $("undo-btn");
  const redoButton = $("redo-btn");
  if (undoButton) {
    undoButton.disabled = !timeline || !timeline.past.length;
    undoButton.title = "Undo (Ctrl+Z)" +
      (timeline ? " - " + timeline.past.length + " step" + (timeline.past.length === 1 ? "" : "s") : "");
  }
  if (redoButton) {
    redoButton.disabled = !timeline || !timeline.future.length;
    redoButton.title = "Redo (Ctrl+Y)" +
      (timeline ? " - " + timeline.future.length + " step" + (timeline.future.length === 1 ? "" : "s") : "");
  }
}

/**
 * Draws the open note again from what is in the vault (after an undo, a
 * design, a format switch): sheets for a paged note, else the one-page
 * editor, then a fresh baseline, the tabs, the list, the status and the strip.
 *
 * Used by: this file (historyApply, restoreSplitSnapshot, applyDesignToNote,
 * resetNoteLayout, and the format switch on load).
 * Uses: notePages, isPaged, activeBody and renderPageTabs (content.js),
 * renderSheets, setEditorBody, pagedView, sheetsSnapshot and getEditorBody
 * (lines.js), renderList (sidebar.js), renderStatus (pagination.js),
 * renderAttachments (attachments.js).
 * Complexity: O(n) in the note's content.
 */
function reloadNoteInPlace() {
  const note = currentId && vault ? vault.notes[currentId] : null;
  if (!note) {
    return;
  }
  currentPage = Math.min(currentPage, Math.max(0, (notePages(note) || [1]).length - 1));
  if (isPaged(note)) {
    renderSheets();
  } else {
    document.body.classList.remove("paged-view");
    $("sheets").innerHTML = "";
    const body = activeBody(note);
    setEditorBody(body.body, { bodyV: body.bodyV });
  }
  editorBaseline = pagedView() ? sheetsSnapshot() : getEditorBody();
  unsavedEdits = false;
  renderPageTabs();
  renderList();
  renderStatus();
  renderAttachments();
}

// ---------- The second screen: its structure ----------

/**
 * Puts the note back exactly as it was when the second screen opened: text,
 * pages, the applied design and the attachment list together, and saves
 * that. Both structure buttons rely on it, so a design or a format switch
 * can always be walked back. Returns whether there was a snapshot.
 *
 * Used by: this file ("Return to previous", on load), split.js (exitSplit).
 * Uses: splitSnapshot (split.js), persistSafe (vault.js), reloadNoteInPlace,
 * renderAttachments (attachments.js).
 * Complexity: O(s) in the note's size.
 */
function restoreSplitSnapshot() {
  if (!splitSnapshot || !currentId || !vault || !vault.notes[currentId]) {
    return false;
  }
  const note = vault.notes[currentId];
  const snapshot = splitSnapshot;
  note.title = snapshot.title;
  note.body = snapshot.body;
  if (snapshot.bodyV === 2) {
    note.bodyV = 2;
  } else {
    delete note.bodyV;
  }
  if (snapshot.pages) {
    note.pages = JSON.parse(JSON.stringify(snapshot.pages));
  } else {
    delete note.pages;
  }
  if (snapshot.designId) {
    note.designId = snapshot.designId;
  } else {
    delete note.designId;
  }
  note.media = JSON.parse(JSON.stringify(snapshot.media || []));
  note.mtime = Date.now();
  currentPage = 0;
  unsavedEdits = false;
  // The change waiting to be saved was deliberately thrown away.
  structureDirty = false;
  persistSafe();
  reloadNoteInPlace();
  renderAttachments();
  return true;
}

/**
 * Names the second screen's format button for what it would do: "Turn into
 * note" for a paged note, "Turn into pages" otherwise.
 *
 * Used by: this file, split.js (enterSplit).
 * Uses: isPaged (content.js).
 * Complexity: O(1).
 */
function updateSplitButtons() {
  const note = currentId && vault ? vault.notes[currentId] : null;
  $("split-format").textContent = note && isPaged(note) ? "Turn into note" : "Turn into pages";
}

// ---------- On load: the format button of the second screen ----------

// Turns the note into pages, or its pages back into one note (every page
// joined, nothing dropped), after asking: this confirms the action only.
// Nothing is saved, and it is left unsaved on purpose: leaving the second
// screen offers save or cancel, and cancel restores the snapshot.
$("split-format").onclick = async () => {
  if (!splitMode || syncing || backupView || !currentId || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  let note = vault.notes[currentId];
  const toPages = !isPaged(note);
  if (!await confirmModal({
    title: toPages ? "Turn this note into pages?" : "Turn this note into a single page?",
    body: toPages
      ? "The note is laid out as A4 pages, exactly as it will export. Nothing is saved yet - leaving the second screen still asks you to save or cancel."
      : "Every page is joined back into one continuous note. Nothing is saved yet - leaving the second screen still asks you to save or cancel.",
    confirmLabel: toPages ? "Turn into pages" : "Turn into note",
  })) {
    return;
  }
  // The vault can have moved on while the dialog was open.
  if (!splitMode || syncing || backupView || !currentId || !vault.notes[currentId]) {
    return;
  }
  note = vault.notes[currentId];
  // Someone already switched it.
  if (isPaged(note) === toPages) {
    return;
  }
  historyMark(currentId);
  if (isPaged(note)) {
    const parts = notePages(note).map(page => page.body || "");
    note.body = parts.filter(part => part.length).join("\n");
    note.bodyV = 2;
    delete note.pages;
    status("Now a single page - close the second screen and cancel to undo");
  } else {
    toPaged(note);
    status("Now in page layout - close the second screen and cancel to undo");
  }
  note.mtime = Date.now();
  currentPage = 0;
  reloadNoteInPlace();
  unsavedEdits = true;
  // "Save edit" must write, though the baseline was just taken again.
  structureDirty = true;
  renderStatus();
  updateSplitButtons();
};

// ---------- Designs: state ----------

// The mark for where the note's writing goes. CONTENT_MARK is the canonical
// spelling and is not read anywhere at the moment; CONTENT_RE matches the
// mark as people type it: {content} or {{content}}, any case, spaces inside allowed.
const CONTENT_MARK = "{{content}}";
const CONTENT_RE = /\{\{?\s*content\s*\}\}?/i;

// ---------- Designs ----------

/**
 * A note wrapped in a design, as { pages, front, back } (how many pages go
 * before and after the body). The design's title pages go in front, its
 * closing pages at the end, and the note's own writing (with any earlier
 * design taken off first) becomes one body page in between, inside the
 * frame of the design's page that holds the {content} mark. Unmarked body
 * pages before or after that page become title and closing pages, so a
 * design laid out as cover, content, back cover works without marking parts,
 * and the reflow never pours the note's text into a cover. The body goes in
 * as one stream rather than framing each old page where it stood: those page
 * breaks were made for a page with no header or footer, so every page was
 * suddenly too full and spilled; the pagination lays it out for the frame.
 *
 * Used by: this file (applyDesignToNote), designs.js (applyDesign).
 * Uses: notePages and pageSection (content.js), newPageFrom (designs.js),
 * undesignPages, frameBody, CONTENT_RE.
 * Complexity: O(n) in the note and the design.
 */
function designedPages(note, design) {
  const designPages = notePages(design) || [];
  const copyAs = (source, i, section) => {
    const made = newPageFrom(source, i);
    if (section !== "body") {
      made.section = section;
    } else {
      delete made.section;
    }
    return made;
  };
  const front = designPages.filter(source => pageSection(source) === "title")
    .map((source, i) => copyAs(source, i, "title"));
  const back = designPages.filter(source => pageSection(source) === "final")
    .map((source, i) => copyAs(source, i, "final"));
  const bodies = designPages.filter(source => pageSection(source) === "body");
  const templateIndex = bodies.findIndex(source => CONTENT_RE.test(source.body || ""));
  const template = templateIndex >= 0 ? bodies[templateIndex] : bodies[0];
  const before = templateIndex > 0 ? bodies.slice(0, templateIndex).map((source, i) => copyAs(source, i, "title")) : [];
  const after = templateIndex >= 0
    ? bodies.slice(templateIndex + 1).map((source, i) => copyAs(source, i, "final")) : [];
  const kept = undesignPages(note).map(page => (page.body || "").trim()).filter(Boolean);
  const written = { id: crypto.randomUUID(), name: "Body",
    body: frameBody(template ? template.body : "", kept.join("\n")), bodyV: 2, cont: true };
  return {
    pages: [...front, ...before, written, ...after, ...back],
    front: front.length + before.length,
    back: back.length + after.length,
  };
}

/**
 * Adds a design's attachment entries to a note (existing ones win), so the
 * design's pictures show instead of placeholders.
 *
 * Used by: this file (applyDesignToNote), designs.js (applyDesign).
 * Uses: nothing.
 * Complexity: O(m) in the attachments.
 */
function adoptDesignMedia(note, design) {
  if (!Array.isArray(note.media)) {
    note.media = [];
  }
  const have = new Set(note.media.map(item => item.id));
  for (const item of (design.media || [])) {
    if (!have.has(item.id)) {
      note.media.push({ ...item });
      have.add(item.id);
    }
  }
}

/**
 * Wraps the open note in a design from the second screen, after asking
 * (picking one off the menu by accident must not silently restructure the
 * note). A design already on the note is swapped, never stacked: its pages
 * and frames come off first. One undo step. Nothing is saved, and it is left
 * unsaved on purpose: leaving the second screen offers save or cancel.
 *
 * Used by: this file (the design button, on load).
 * Uses: flushSave, renderStatus and status (pagination.js), confirmModal
 * (modal.js), historyMark, designedPages, adoptDesignMedia,
 * reloadNoteInPlace, renderAttachments (attachments.js), updateSplitButtons.
 * Complexity: O(n) in the note and the design.
 */
async function applyDesignToNote(designId) {
  let design = vault.notes[designId];
  let note = currentId && vault.notes[currentId];
  if (!design || !note || design === note || syncing || backupView) {
    return;
  }
  flushSave();
  if (!await confirmModal({
    title: `Apply the design "${design.title || "(untitled)"}"?`,
    body: "Its title pages go in front, its closing pages at the end, and what you have written becomes the body in between. Any design already on this note is replaced. Nothing is saved yet - leaving the second screen still asks you to save or cancel.",
    confirmLabel: "Apply design",
  })) {
    return;
  }
  design = vault.notes[designId];
  note = currentId && vault.notes[currentId];
  if (!design || !note || design === note || syncing || backupView || !splitMode) {
    return;
  }
  historyMark(currentId);
  const wrapped = designedPages(note, design);
  // Remembered, so the next design knows what to take off.
  note.designId = designId;
  note.pages = wrapped.pages;
  delete note.bodyV;
  adoptDesignMedia(note, design);
  note.mtime = Date.now();
  currentPage = 0;
  reloadNoteInPlace();
  unsavedEdits = true;
  structureDirty = true;
  renderStatus();
  renderAttachments();
  updateSplitButtons();
  status(`"${design.title}" applied - ${wrapped.front} front, 1 body, ${wrapped.back} closing`);
}

/**
 * Forgets every piece of stored layout on a note, after asking, leaving one
 * plain page holding all of its content: the design and its frames, title
 * and closing marks, page breaks, continuation flags, and the size,
 * alignment and pin of each picture. A note designed and re-paged many times
 * carries a lot of invisible state, and one bad value in it follows the note
 * forever; this is the way out short of rebuilding it by hand. Text and
 * attachments are untouched. One undo step.
 *
 * Used by: notes.js (noteMenu).
 * Uses: flushSave, renderStatus and status (pagination.js), notePages
 * (content.js), confirmModal (modal.js), historyMark, undesignPages,
 * sanitizeBodyFragment, canonicalBody (lines.js), exitSplit (split.js),
 * reloadNoteInPlace, persistSafe (vault.js), renderList (sidebar.js),
 * renderAttachments (attachments.js).
 * Complexity: O(n) in the note.
 */
async function resetNoteLayout(id) {
  const note = vault && vault.notes[id];
  if (!note || syncing || backupView) {
    return;
  }
  if (currentId === id) {
    flushSave();
  }
  const pageCount = (notePages(note) || []).length;
  if (!await confirmModal({
    title: `Reset the layout of "${(note.title || "Untitled").trim() || "Untitled"}"?`,
    body: "Every word and every attachment is kept, joined into one plain page. "
      + "What is forgotten: the design and its header/footer, the title and closing page marks, "
      + (pageCount > 1 ? `the ${pageCount} page breaks, ` : "")
      + "and any size, alignment or pinned position set on individual pictures. "
      + "Use it when a note has been designed so many times that its layout misbehaves. Ctrl+Z undoes it.",
    confirmLabel: "Reset layout", destructive: true,
  })) {
    return;
  }
  if (syncing || !vault.notes[id]) {
    return;
  }

  historyMark(id);
  // undesignPages already takes off a design's frames and its title and
  // closing pages, leaving only what was written.
  const kept = undesignPages(note).map(page => {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeBodyFragment(page.body || ""));
    for (const el of holder.querySelectorAll("[data-frame]")) {
      el.replaceWith(...el.childNodes);
    }
    for (const el of holder.querySelectorAll(".inline-media")) {
      for (const attribute of ["data-w", "data-align", "data-fx", "data-fy"]) {
        el.removeAttribute(attribute);
      }
      el.removeAttribute("style");
    }
    for (const el of holder.querySelectorAll("[data-split]")) {
      el.removeAttribute("data-split");
    }
    return canonicalBody(holder).trim();
  }).filter(Boolean);
  note.body = kept.join("\n");
  note.bodyV = 2;
  delete note.pages;
  delete note.designId;
  note.mtime = Date.now();
  currentPage = 0;
  if (currentId === id) {
    exitSplit(true);
    reloadNoteInPlace();
  }
  persistSafe();
  renderList();
  renderStatus();
  renderAttachments();
  status("Layout reset - one plain page, nothing else changed");
}

// ---------- On load: the second screen's buttons ----------

// The design button: the designs to wrap the note in, by name.
$("split-design").onclick = () => {
  if (!splitMode || syncing || backupView || !currentId) {
    return;
  }
  const ids = designNoteIds().filter(id => id !== currentId);
  const box = $("split-design").getBoundingClientRect();
  openMenu(box.left, box.top - 8, ids.length
    ? ids.sort((a, b) => compareByName(vault.notes[a].title || "", vault.notes[b].title || ""))
        .map(id => ({ label: vault.notes[id].title || "(untitled)", onClick: () => applyDesignToNote(id) }))
    : [{ label: "No designs yet - import one first", disabled: true }]);
};

$("split-btn").onclick = () => {
  splitMode ? exitSplit(false) : enterSplit();
};

// "Return to previous": the whole session walked back in one click. Text,
// pages, designs, format switches and attachments from this second screen
// are discarded and the note returns to how it was when the screen opened.
// It asks first, because it destroys work, and the discarded state goes into
// the history first (everything typed included), so even this can be undone.
$("split-cancel").onclick = async () => {
  if (!splitMode || syncing || backupView || !currentId || !vault.notes[currentId]) {
    return;
  }
  if (!await confirmModal({
    title: "Return to the previous version?",
    body: "Everything from this second-screen session is thrown away and the note goes back to exactly how it was when the second screen opened. Ctrl+Z can bring the discarded work back.",
    confirmLabel: "Return to previous", destructive: true,
  })) {
    return;
  }
  if (!splitMode || syncing || !currentId || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  historyMark(currentId);
  // It clears the unsaved flag, so leaving below never asks.
  restoreSplitSnapshot();
  await exitSplit(false);
  status("Back to the previous version - Ctrl+Z restores the discarded edit");
};

// "Save edit" saves the right side. The reference on the left is not drawn
// again, so it stays as it was when the session started.
$("split-save").onclick = () => {
  if (!splitMode || syncing || backupView) {
    return;
  }
  manualSave();
  status("Edit saved - the left pane still shows the previous version");
};

// ---------- The sanitiser: state ----------

// The tags a line can have.
const EDITOR_BLOCK_TAGS = new Set(["DIV", "P"]);

// Colours the browser writes by itself when it keeps a style while moving or
// clearing text: the editor's own ink and paper. Nobody picks them, and
// keeping them would print the dark editor's pale text onto the white page.
const BROWSER_COLORS = new Set(["#dcd6cc", "#111111"]);
const BROWSER_BACKGROUNDS = new Set(["#181715", "#fffdf7"]);

// ---------- The sanitiser ----------

/**
 * A stored body as a fresh fragment holding only allowed content. The body
 * is parsed in a <template>, whose content is inert: nothing is fetched, no
 * onerror runs, scripts never run. The stored string is never given to a
 * live or attached node (even a detached <img> loads and fires onerror).
 *
 * Used by: lines.js (bodyFragment), designs.js (importDesignDoc,
 * stripCensoredForExport), pdf.js (censorSplitMediaIds), this file
 * (undesignPages, frameBody, resetNoteLayout).
 * Uses: sanitizeBodyInto.
 * Complexity: O(n) in the body.
 */
function sanitizeBodyFragment(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  const fragment = document.createDocumentFragment();
  sanitizeBodyInto(template.content, fragment);
  return fragment;
}

/**
 * Copies the allowed content of source into dest, node by node; anything
 * else is unwrapped to its text and children, and comments, CDATA and
 * processing instructions are dropped. Kept: text; <br>; lines (DIV, P) with
 * a sanitised style and a frame mark; lists and tables with a sanitised
 * style, a pinned table's place and width, and colspan or rowspan as small
 * numbers (2 to 50) only; links with a safe address only (else unwrapped),
 * always opening in a new tab with no opener; formatting tags, censor marks
 * and styled spans (a span carrying nothing allowed is unwrapped); inline
 * attachment wrappers, rebuilt fresh from their checked id and kind (their
 * stored content is thrown away), with a checked size, alignment and place.
 * Lists and tables are structure, not decoration: without them here they
 * were flattened into plain text on the first save.
 *
 * Used by: this file (sanitizeBodyFragment).
 * Uses: validInlineMedia (content.js), buildInlineWrapper and censorMark
 * (lines.js), mediaLayout, applyMediaLayout, sanitizeStyle, ensureColWidths,
 * safeHref, INLINE_FMT_TAGS, LIST_TAGS and TABLE_TAGS (designs.js).
 * Complexity: O(n) in the markup.
 */
function sanitizeBodyInto(source, dest) {
  source.childNodes.forEach(child => {
    if (child.nodeType === 3) {
      dest.appendChild(document.createTextNode(child.data));
    } else if (child.nodeType === 1) {
      const media = validInlineMedia(child);
      if (media) {
        const wrapper = buildInlineWrapper(media.mid, media.kind);
        const layout = mediaLayout(child);
        if (layout.w) {
          wrapper.setAttribute("data-w", String(layout.w));
        }
        if (layout.align) {
          wrapper.setAttribute("data-align", layout.align);
        }
        if (layout.fx !== null) {
          wrapper.setAttribute("data-fx", String(layout.fx));
          wrapper.setAttribute("data-fy", String(layout.fy));
        }
        applyMediaLayout(wrapper);
        dest.appendChild(wrapper);
      } else if (child.tagName === "BR") {
        dest.appendChild(document.createElement("br"));
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName)) {
        const div = document.createElement("div");
        const style = sanitizeStyle(child.getAttribute("style"));
        if (style) {
          div.setAttribute("style", style);
        }
        // data-frame marks a design's frame, so a later design can take it off.
        const frame = child.getAttribute && child.getAttribute("data-frame");
        if (frame === "top" || frame === "bottom") {
          div.setAttribute("data-frame", frame);
        }
        sanitizeBodyInto(child, div);
        dest.appendChild(div);
      } else if (LIST_TAGS.has(child.tagName) || TABLE_TAGS.has(child.tagName)) {
        const el = document.createElement(child.tagName.toLowerCase());
        const style = sanitizeStyle(child.getAttribute("style"));
        if (style) {
          el.setAttribute("style", style);
        }
        if (child.tagName === "TABLE") {
          // A pinned table carries its own place on the page, exactly like a pinned picture.
          const layout = mediaLayout(child);
          if (layout.fx !== null) {
            el.setAttribute("data-fx", String(layout.fx));
            el.setAttribute("data-fy", String(layout.fy));
          }
          if (layout.w) {
            el.setAttribute("data-w", String(layout.w));
          }
          applyMediaLayout(el);
        }
        for (const attribute of ["colspan", "rowspan"]) {
          const value = parseInt(child.getAttribute(attribute) || "", 10);
          if (value > 1 && value <= 50) {
            el.setAttribute(attribute, String(value));
          }
        }
        sanitizeBodyInto(child, el);
        if (child.tagName === "TABLE") {
          ensureColWidths(el);
        }
        dest.appendChild(el);
      } else if (child.tagName === "A") {
        const href = safeHref(child.getAttribute("href"));
        if (!href) {
          sanitizeBodyInto(child, dest);
          return;
        }
        const link = document.createElement("a");
        link.setAttribute("href", href);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        const style = sanitizeStyle(child.getAttribute("style"), true);
        if (style) {
          link.setAttribute("style", style);
        }
        sanitizeBodyInto(child, link);
        dest.appendChild(link);
      } else if (INLINE_FMT_TAGS.has(child.tagName)) {
        const tag = INLINE_FMT_TAGS.get(child.tagName);
        const style = sanitizeStyle(child.getAttribute("style"), true);
        const censored = child.getAttribute("data-censor") === "1";
        if (tag === "span" && !style && !censored) {
          sanitizeBodyInto(child, dest);
          return;
        }
        const el = document.createElement(tag);
        if (style) {
          el.setAttribute("style", style);
        }
        if (censored) {
          censorMark(el);
        }
        sanitizeBodyInto(child, el);
        dest.appendChild(el);
      } else {
        sanitizeBodyInto(child, dest);
      }
    }
  });
}

/**
 * A style attribute rebuilt from the declarations that are allowed, each
 * checked against a strict pattern: text-align (not on inline elements,
 * where the browser leaves it after joining lines), font-weight, font-style,
 * text-decoration, font-size in pt or px (up to 3 digits), a font from the
 * list, a table cell's width or height in px (8 to 2000), the text colour
 * and the highlight. Nothing that can fetch, position or escape survives: a
 * value with url, expression, import, var(, a backslash, a bracket, a brace,
 * an at sign or a semicolon is dropped, and colours go through cssColorHex.
 * Transparent ink on a black box is the look of censored text, which the
 * browser copies onto new typing after censored text is deleted: without the
 * data-censor mark it is ordinary text that only looks hidden, so the look
 * is dropped rather than keeping a redaction that is not one. The browser's
 * own ink and paper colours are dropped too.
 *
 * Used by: this file (sanitizeBodyInto), lines.js (serializeBodyInto).
 * Uses: cssColorHex, FONT_ALLOW (designs.js), BROWSER_COLORS, BROWSER_BACKGROUNDS.
 * Complexity: O(d) in the declarations.
 */
function sanitizeStyle(style, inline) {
  const out = [];
  let color = null;
  let background = null;
  for (const declaration of String(style || "").split(";")) {
    const i = declaration.indexOf(":");
    if (i < 0) {
      continue;
    }
    const prop = declaration.slice(0, i).trim().toLowerCase();
    let value = declaration.slice(i + 1).trim();
    // Colours first: the one place a function, rgb(), is accepted, and only
    // in the strict numeric form cssColorHex reads.
    if (prop === "color") {
      color = cssColorHex(value);
      continue;
    }
    if (prop === "background-color" || prop === "background") {
      background = cssColorHex(value);
      continue;
    }
    if (/[\\(){}@;]|url|expression|import|var\s*\(/i.test(value)) {
      continue;
    }
    if (prop === "text-align" && /^(left|right|center|justify)$/i.test(value)) {
      if (!inline) {
        out.push("text-align:" + value.toLowerCase());
      }
    } else if (prop === "font-weight" && /^(bold|bolder|normal|[1-9]00)$/i.test(value)) {
      out.push("font-weight:" + value.toLowerCase());
    } else if (prop === "font-style" && /^(italic|normal)$/i.test(value)) {
      out.push("font-style:" + value.toLowerCase());
    } else if (prop === "text-decoration" && /^(underline|line-through|none)$/i.test(value)) {
      out.push("text-decoration:" + value.toLowerCase());
    } else if (prop === "font-size" && /^\d{1,3}(pt|px)$/i.test(value)) {
      out.push("font-size:" + value.toLowerCase());
    } else if (prop === "font-family") {
      const family = value.replace(/["']/g, "").split(",")[0].trim();
      if (FONT_ALLOW.has(family.toLowerCase())) {
        out.push("font-family:" + family);
      }
    } else if (prop === "text-decoration-line" && /^(underline|line-through|none)$/i.test(value)) {
      out.push("text-decoration:" + value.toLowerCase());
    } else if (!inline && (prop === "width" || prop === "height") && /^\d{1,4}px$/i.test(value)) {
      // Table cell sizes: px only and bounded (no calc(), no percentage that
      // could push the layout out of the page).
      const n = parseInt(value, 10);
      if (n >= 8 && n <= 2000) {
        out.push(prop + ":" + n + "px");
      }
    }
  }

  if (color === "transparent") {
    color = null;
    if (background === "#000" || background === "#000000") {
      background = null;
    }
  }
  if (color && !BROWSER_COLORS.has(color)) {
    out.push("color:" + color);
  }
  if (background && background !== "transparent" && !BROWSER_BACKGROUNDS.has(background)) {
    out.push("background-color:" + background);
  }
  return out.join(";");
}

/**
 * A CSS colour as hex ("#rgb", "#rrggbb" or "#rrggbbaa"), "transparent", or
 * null when it cannot be read. The browser writes every colour it applies as
 * rgb() or rgba(), never as the hex the palette gave it, and a hex-only rule
 * once dropped them all, so a strictly numeric rgb() or rgba() becomes hex
 * again here; anything looser never gets through.
 *
 * Used by: this file (sanitizeStyle), censor.js (scrubCensorLook), toolbar.js (colourAtSelection).
 * Uses: nothing.
 * Complexity: O(1).
 */
function cssColorHex(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/.test(text)) {
    return text;
  }
  if (text === "transparent") {
    return "transparent";
  }
  const match =
    /^rgba?\(\s*(\d{1,3})\s*(?:,\s*|\s+)(\d{1,3})\s*(?:,\s*|\s+)(\d{1,3})\s*(?:[,/]\s*(\d*\.?\d+)(%?)\s*)?\)$/
      .exec(text);
  if (!match) {
    return null;
  }
  const rgb = [match[1], match[2], match[3]].map(Number);
  if (rgb.some(channel => channel > 255)) {
    return null;
  }
  let alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1);
  if (!(alpha >= 0 && alpha <= 1)) {
    return null;
  }
  if (alpha === 0) {
    return "transparent";
  }
  const hex = n => n.toString(16).padStart(2, "0");
  return "#" + rgb.map(hex).join("") + (alpha < 1 ? hex(Math.round(alpha * 255)) : "");
}

/**
 * Puts attachments shoulder to shoulder, in what is shown and in what the
 * PDF writer reads, so both agree (notes saved before this included). A run
 * of lines holding nothing but attachments (Enter wraps each in its own
 * line) becomes one line, so they pack across the row and wrap onto the next
 * when they run out of room, like a row of pictures, instead of one per line
 * with most of the page empty. A line break between two attachments becomes
 * a space. Pinned attachments are placed, not flowed, so they are left alone.
 *
 * Used by: lines.js (bodyFragment), pagination.js (repaginate).
 * Uses: isMediaEl (lines.js).
 * Complexity: O(n) in the nodes under root.
 */
function packAttachmentRuns(root) {
  const isCard = node => node && node.nodeType === 1 && node.classList && node.classList.contains("inline-media")
    && !(node.dataset && node.dataset.fx !== undefined);
  const blank = node => node && node.nodeType === 3 && !node.data.trim();
  // The nearest real neighbour, looking past the whitespace between lines.
  const near = (node, direction) => {
    let sibling = node[direction];
    while (blank(sibling)) {
      sibling = sibling[direction];
    }
    return sibling;
  };
  const cardLine = node => node && node.nodeType === 1 && (node.tagName === "DIV" || node.tagName === "P")
    && !(node.dataset && node.dataset.frame)
    && [...node.childNodes].some(isCard)
    && [...node.childNodes].every(child => isCard(child) || blank(child) ||
      (child.nodeType === 1 && child.tagName === "BR"));

  const walk = el => {
    el.normalize();
    for (const line of [...el.children]) {
      // Already merged into an earlier line.
      if (line.parentNode !== el) {
        continue;
      }
      if (!cardLine(line)) {
        if (!isMediaEl(line)) {
          walk(line);
        }
        continue;
      }
      for (let next = near(line, "nextSibling"); next && cardLine(next); next = near(line, "nextSibling")) {
        // The blank text between them goes.
        while (line.nextSibling !== next) {
          line.nextSibling.remove();
        }
        for (const child of [...next.childNodes]) {
          if (isCard(child)) {
            line.appendChild(document.createTextNode(" "));
            line.appendChild(child);
          }
        }
        next.remove();
      }
      for (const child of [...line.childNodes]) {
        if (child.nodeType === 1 && child.tagName === "BR") {
          child.remove();
        }
      }
    }
    el.normalize();
    for (const text of [...el.childNodes]) {
      if (!blank(text) || !text.data.includes("\n")) {
        continue;
      }
      if (isCard(near(text, "previousSibling")) && isCard(near(text, "nextSibling"))) {
        text.data = " ";
      }
    }
  };
  walk(root);
  return root;
}

// ---------- Picture and table layout ----------

/**
 * An element's stored layout, checked: { w, align, fx, fy }. It is kept as
 * data attributes rather than free CSS, so the saver never has to trust a
 * style for layout. w is a width in px (40 to 2000), align left, center or
 * right, and fx and fy the top-left corner as a percentage of the page
 * (-20 to 120, both or neither). Percentages, because the sheet is drawn at
 * whatever width the window allows but always exports as A4: a percentage
 * is the same spot on screen and in the PDF.
 *
 * Used by: this file (sanitizeBodyInto, applyMediaLayout), lines.js
 * (applyInlineSize, serializeBodyInto), media-layout.js (mediaLayoutMenu),
 * pdf.js (collectRuns, exportNotePdf).
 * Uses: parsePercent, ALIGN_OK (designs.js).
 * Complexity: O(1).
 */
function mediaLayout(el) {
  const width = parseInt(el.getAttribute("data-w") || "", 10);
  const align = (el.getAttribute("data-align") || "").toLowerCase();
  const fx = parsePercent(el.getAttribute("data-fx"));
  const fy = parsePercent(el.getAttribute("data-fy"));
  return { w: (width >= 40 && width <= 2000) ? width : null, align: ALIGN_OK.has(align) ? align : null,
    fx: (fx !== null && fy !== null) ? fx : null, fy: (fx !== null && fy !== null) ? fy : null };
}

/**
 * Shows an element as its stored layout says: its width, and either pinned
 * at its place (text ignores it) or aligned in the text. A picture cannot be
 * split across pages, so it is never drawn taller than one: widths up to
 * 2000px drop the 320x240 limit, which let a portrait picture stand taller
 * than the paper, and the page then stayed oversized with nothing to move
 * off it. data-w keeps the chosen number; only what is drawn is capped.
 *
 * Used by: this file (sanitizeBodyInto, placeFloating), lines.js
 * (applyInlineSize), media-layout.js (mediaLayoutMenu, resizing on load),
 * tables.js (tableMenuItems).
 * Uses: mediaLayout, onePageContentPx, inlineDims.
 * Complexity: O(1), besides measuring one page.
 */
function applyMediaLayout(el) {
  let { w: width, align, fx } = mediaLayout(el);
  if (width) {
    const cap = onePageContentPx();
    const dimensions = cap ? inlineDims(el) : null;
    if (dimensions && width * dimensions.h / dimensions.w > cap) {
      width = Math.max(40, Math.floor(cap * dimensions.w / dimensions.h));
    }
    el.style.width = width + "px";
    el.style.height = "auto";
  }
  const floating = fx !== null;
  el.classList.toggle("floating", floating);
  if (floating) {
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

/**
 * Pins an element at a point on the surface it was dropped on, keeping the
 * point it was grabbed by under the pointer (its middle by default), within
 * -5% to 105% of the page. It becomes a direct child of the surface, so the
 * percentages are of the page itself, not of whatever paragraph was under
 * it. Returns false when the surface has no size.
 *
 * Used by: attachments.js (dropping a dragged attachment, on load),
 * media-layout.js (mediaLayoutMenu, showTableGrip, moving on load),
 * tables.js (tableMenuItems).
 * Uses: applyMediaLayout.
 * Complexity: O(1).
 */
function placeFloating(node, surface, clientX, clientY, grab) {
  if (!node || !surface) {
    return false;
  }
  const box = surface.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) {
    return false;
  }
  const own = node.getBoundingClientRect();
  const offsetX = grab && isFinite(grab.dx) ? grab.dx : own.width / 2;
  const offsetY = grab && isFinite(grab.dy) ? grab.dy : own.height / 2;
  const x = clientX - box.left - offsetX + surface.scrollLeft;
  const y = clientY - box.top - offsetY + surface.scrollTop;
  const fx = Math.max(-5, Math.min(105, x / box.width * 100));
  const fy = Math.max(-5, Math.min(105, y / box.height * 100));
  node.setAttribute("data-fx", fx.toFixed(2));
  node.setAttribute("data-fy", fy.toFixed(2));
  node.removeAttribute("data-align");
  if (node.parentNode !== surface) {
    surface.appendChild(node);
  }
  applyMediaLayout(node);
  return true;
}

// =================== Auxiliary functions ===================

/** A note as a JSON string (a snapshot for the history), or null. Complexity: O(s). */
function noteSnapshot(id) {
  const note = vault && vault.notes[id];
  return note ? JSON.stringify(note) : null;
}

/** A note's history, made empty the first time. Complexity: O(1). */
function historyFor(id) {
  let timeline = histories.get(id);
  if (!timeline) {
    timeline = { past: [], future: [] };
    histories.set(id, timeline);
  }
  return timeline;
}

/**
 * What a note's writing is without any design: its body pages only, each
 * with an earlier design's frame taken off. Complexity: O(n) in the note.
 */
function undesignPages(note) {
  const pages = notePages(note);
  if (!pages) {
    return [{ name: "Page 1", body: note.body || "", bodyV: note.bodyV }];
  }
  return pages.filter(page => pageSection(page) === "body").map(page => {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeBodyFragment(page.body || ""));
    const frames = [...holder.querySelectorAll("[data-frame]")];
    if (frames.length) {
      for (const frame of frames) {
        frame.remove();
      }
      return { name: page.name, body: canonicalBody(holder).replace(/^\n+|\n+$/g, ""), bodyV: 2 };
    }
    return { name: page.name, body: page.body || "", bodyV: page.bodyV };
  });
}

/**
 * One body wrapped in a design page's frame. The lines above the {content}
 * mark become the top frame, the lines below it the bottom frame, and the
 * mark's own line is where the content goes; without a mark the whole frame
 * sits above it. Split by lines, not by cutting the stored text at the mark:
 * a cut there left the mark's line open in one half and closed in the other,
 * which pushed the bottom frame out of its frame. Complexity: O(n).
 */
function frameBody(frameTemplate, content) {
  if (!frameTemplate) {
    return content;
  }
  const holder = document.createElement("div");
  holder.appendChild(sanitizeBodyFragment(frameTemplate));
  normalizeLines(holder);
  const lines = [...holder.childNodes];
  const at = lines.findIndex(line => CONTENT_RE.test(line.textContent || ""));
  const html = nodes => {
    const div = document.createElement("div");
    for (const node of nodes) {
      div.appendChild(node.cloneNode(true));
    }
    return canonicalBody(div);
  };
  const wrap = (nodes, position) => {
    const markup = html(nodes).replace(/^\n+|\n+$/g, "");
    return markup.trim() ? `<div data-frame="${position}">${markup}</div>` : "";
  };
  if (at < 0) {
    return wrap(lines, "top") + "\n" + (content || "");
  }
  return [wrap(lines.slice(0, at), "top"), content || "", wrap(lines.slice(at + 1), "bottom")]
    .filter(Boolean).join("\n");
}

/** A stored percentage (-20 to 120, two decimals), or null. Complexity: O(1). */
function parsePercent(value) {
  const n = parseFloat(value);
  return (isFinite(n) && n >= -20 && n <= 120) ? Math.round(n * 100) / 100 : null;
}

/** One page's worth of content height, in screen pixels (0 with no sheets). Complexity: O(1). */
function onePageContentPx() {
  const body = document.querySelector("#sheets .sheet-body");
  return body ? contentCapacity(body) : 0;
}

/** An attachment's own size in pixels from the note's media list, { w, h }, or null. Complexity: O(m). */
function inlineDims(el) {
  const mid = el.getAttribute("data-mid");
  const context = mediaCtx();
  const meta = ((context && context.note && context.note.media) || []).find(item => item.id === mid);
  return meta && +meta.w > 0 && +meta.h > 0 ? { w: +meta.w, h: +meta.h } : null;
}

/**
 * Gives every unsized column of a table a share of an A4 text column (60 to
 * 150px). Tables stored before columns had widths have nothing for the fixed
 * layout to size from, and collapsed to the cells' smallest width. It works
 * on the detached fragment, so it needs no layout. Complexity: O(r * c).
 */
function ensureColWidths(table) {
  const first = table.querySelector("tr");
  if (!first) {
    return;
  }
  const cols = first.children.length;
  if (!cols) {
    return;
  }
  const width = Math.max(60, Math.min(150, Math.floor(660 / cols)));
  [...first.children].forEach((cell, i) => {
    // Already sized: left alone.
    if (/\d+px/.test(cell.style.width || "")) {
      return;
    }
    for (const row of table.querySelectorAll("tr")) {
      if (row.children[i]) {
        row.children[i].style.width = width + "px";
      }
    }
  });
}
