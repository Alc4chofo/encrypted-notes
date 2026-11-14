/*
 * split.js - the second screen: the note as it was, beside the note you edit.
 *
 * The left pane is the version as it was when you opened the second screen,
 * frozen, to read and copy from; the right pane is the live editor.
 * Autosave pauses: "Save edit" commits the right side only, and the left
 * deliberately does not follow, so a long rewrite always has the original
 * beside it. Leaving offers to overwrite the note, cancel the changes (the
 * whole note goes back to its snapshot), or keep editing.
 *
 * Main functions: enterSplit, exitSplit, renderPrevPane.
 * Auxiliary functions: hydratePrevMedia, splitLabel.
 *
 * Complexity: entering copies the note once, O(b) in its size; drawing the
 * reference pane is O(b) plus one decryption per image shown.
 */
"use strict";

// ---------- State ----------

let splitMode = false;

// { paged, pages, label }, captured on entry and never written back.
let splitRef = null;

// The whole note as it was on entry, for "Cancel the changes".
let splitSnapshot = null;

// ---------- The second screen ----------

/**
 * Opens the second screen for the open note. The open note is saved first,
 * so the reference shows the saved text and not a half-typed buffer. Every
 * page is captured, so the reference scrolls through the whole document,
 * plus a full snapshot of the note that "Cancel the changes" puts back
 * wholesale (which is what makes the format switch and applying a design in
 * this mode safely undoable, not only the typing).
 *
 * Used by: history.js (the second-screen button).
 * Uses: flushSave, renderStatus and status (pagination.js), isPaged,
 * noteBodies (content.js), splitLabel, renderPrevPane, fitSheets (lines.js),
 * updateSplitButtons (history.js).
 * Complexity: O(b) in the note's size.
 */
function enterSplit() {
  if (splitMode || syncing || backupView || trashViewId || !currentId || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  const note = vault.notes[currentId];
  if (!note) {
    return;
  }

  splitRef = { paged: isPaged(note), pages: noteBodies(note).map(body => ({ ...body })), label: splitLabel(note) };
  splitSnapshot = JSON.parse(JSON.stringify({
    title: note.title || "",
    body: note.body || "",
    bodyV: note.bodyV,
    pages: note.pages || null,
    media: note.media || [],
    designId: note.designId || null,
  }));
  splitMode = true;
  document.body.classList.add("split-edit");
  renderPrevPane();
  // The pane just got narrower; the page did not.
  fitSheets();
  updateSplitButtons();
  renderStatus();
  status("Second screen on - autosave is paused, use Save edit (the left pane stays frozen)");
}

/**
 * Leaves the second screen. A forced exit (switching notes, the trash view,
 * Lock) is teardown, never a discard: autosave is paused in this mode, so the
 * buffer is saved or it would simply be lost. Otherwise, with unsaved
 * changes, it asks: overwrite the note, cancel the changes (the snapshot goes
 * back), or keep editing. Resolves with false when you keep editing.
 *
 * Used by: settings.js (Lock), pagination.js (opening another note or the
 * trash), history.js (the second-screen buttons).
 * Uses: flushSave and renderStatus (pagination.js), showModal (modal.js),
 * restoreSplitSnapshot (history.js), fitSheets (lines.js).
 * Complexity: O(1), plus one save when it saves.
 */
async function exitSplit(force) {
  if (!splitMode) {
    return true;
  }
  if (force && unsavedEdits && currentId && vault && !backupView) {
    flushSave();
  }

  if (!force && unsavedEdits && currentId) {
    const choice = await showModal({
      title: "Unsaved changes on the right",
      body: "Overwrite the note with what you have written, or cancel those changes and keep the saved version?",
      choices: [
        { id: "save", label: "Overwrite with my changes" },
        { id: "discard", label: "Cancel the changes", danger: true },
        { id: "stay", label: "Keep editing" },
      ],
      defaultId: "stay",
    });
    if (choice === "stay") {
      return false;
    }
    if (choice === "save") {
      flushSave();
    } else if (choice === "discard") {
      restoreSplitSnapshot();
    }
  }

  splitMode = false;
  splitRef = null;
  splitSnapshot = null;
  document.body.classList.remove("split-edit");
  $("prev-body").innerHTML = "";
  // Full width again: the page can show bigger.
  fitSheets();
  renderStatus();
  return true;
}

/**
 * Draws the reference pane from the captured pages. A paged note keeps its
 * page format here: the reference is the same stack of sheets you edit,
 * scrollable, not only the page you happen to be on. Its inline attachments
 * cannot be dragged: they belong to a frozen snapshot, and the editor's move
 * handler would try to move a node that is not in the editor.
 *
 * Used by: enterSplit in this file, content.js (after a page change).
 * Uses: makeElement (sidebar.js), bodyFragment (lines.js), hydratePrevMedia.
 * Complexity: O(b) in the note's size.
 */
function renderPrevPane() {
  const head = $("prev-head");
  const box = $("prev-body");
  box.innerHTML = "";
  if (!splitRef) {
    head.textContent = "Previous";
    return;
  }

  const pages = splitRef.pages || [];
  head.textContent = "Previous" +
    (pages.length > 1 ? ` - ${pages.length} pages` : splitRef.label ? " - " + splitRef.label : "");

  pages.forEach((page, i) => {
    let host = box;
    if (splitRef.paged) {
      const sheet = makeElement("div", "sheet prev-sheet");
      const label = makeElement("div", "sheet-label");
      label.appendChild(makeElement("span", "nm", page.name || "Page " + (i + 1)));
      label.appendChild(makeElement("span", "n", (i + 1) + " / " + pages.length));
      sheet.appendChild(label);
      host = makeElement("div", "sheet-body");
      sheet.appendChild(host);
      box.appendChild(sheet);
    }
    host.appendChild(bodyFragment(page.body, page.bodyV));
  });

  box.querySelectorAll("span.inline-media").forEach(wrapper => {
    wrapper.draggable = false;
  });
  hydratePrevMedia();
}

// =================== Auxiliary functions ===================

/**
 * Paints the reference pane's attachments through the same decryption queue,
 * URL cache and generation check as the editor, so an image decrypts once
 * and both panes share it. Videos, PDFs and other files stay tiles that open
 * on click. Complexity: O(m) in the attachments, plus one decryption per new image.
 */
function hydratePrevMedia() {
  const wrappers = [...$("prev-body").querySelectorAll("span.inline-media")];
  if (!wrappers.length || !vault) {
    return;
  }
  // A note switch or a lock makes these stale too.
  const generation = editorSeq;
  const note = currentId ? vault.notes[currentId] : null;
  const metaFor = mediaId => ((note && note.media) || []).find(media => media.id === mediaId) || null;

  idbKeys().then(keys => {
    if (generation !== editorSeq || !vault) {
      return;
    }
    const have = new Set(keys);
    for (const wrapper of wrappers) {
      if (!wrapper.isConnected) {
        continue;
      }
      const mediaId = wrapper.getAttribute("data-mid");
      const kind = wrapper.getAttribute("data-kind");
      const meta = metaFor(mediaId);
      if (meta) {
        applyInlineSize(wrapper, meta.w, meta.h);
      }
      if (!have.has(mediaId) || !meta) {
        setInlineState(wrapper, "missing");
        continue;
      }
      if (kind !== "image") {
        setInlineState(wrapper, kind);
        wrapper.onclick = () => openInlineMedia(wrapper, mediaId, meta, kind);
        continue;
      }
      if (!isRenderableImage(meta.mime)) {
        setInlineState(wrapper, "blocked");
        continue;
      }
      queueInlineImage(generation, wrapper, mediaId, meta.mime, meta);
    }
  }).catch(() => {
    for (const wrapper of wrappers) {
      if (wrapper.isConnected) {
        setInlineState(wrapper, "missing");
      }
    }
  });
}

/** The name of the page the editor shows, for the reference pane's heading ("" for a plain note). Complexity: O(1). */
function splitLabel(note) {
  const pages = notePages(note);
  return pages ? (pages[Math.min(currentPage, pages.length - 1)].name || "page") : "";
}
