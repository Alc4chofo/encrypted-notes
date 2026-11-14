/*
 * attachments.js - attachments: adding them (paste and drop), the strip of
 * tiles under the note, the lightbox, and plain-text paste and drop.
 *
 * Plain attachment bytes only ever exist for a moment in memory and behind
 * the blob: addresses kept in mediaUrls (vault.js); IndexedDB and the
 * repository only ever see encrypted bytes.
 *
 * Encryption. A new attachment is encrypted in addMedia, as soon as it is
 * pasted or dropped, by encryptMedia (vault.js): AES-256-GCM under the
 * vault's attachment key (random, not made from the password), with a fresh
 * random 12-byte IV and "media:<id>" as associated data, so encrypted bytes
 * cannot be swapped between attachments without the check failing. That
 * takes about 3.7 ms per MB (a 10 MB file in 37 ms, Chrome 156). It is
 * decrypted (decryptMedia, about 3 ms per MB) only when shown: a picture's
 * thumbnail when the strip is drawn, one at a time in a queue, and any other
 * kind when it is clicked or downloaded. Guessing the key means trying up to
 * 2^256 keys, which is out of reach.
 *
 * Size. A file may be up to MEDIA_MAX (200 MB), the most that is sensible to
 * encrypt in memory at once. Above MEDIA_CHUNK (20 MB) it is stored in the
 * repository as 20 MB parts (media/<id>.p0, .p1, ...) with a small manifest
 * at media/<id>, because GitHub rejects large API pushes (base64 makes a
 * request about 1.37 times the size) and caps a file at 100 MB.
 *
 * Main functions: mediaCtx, ingestFiles, ensureNoteForMedia,
 * stripImageMetadata, addMedia, insertPlainText, renderAttachments,
 * queueThumb, makeTile, openAttachment, loadMedia, downloadAttachment,
 * downloadPlain, attachmentMenu, removeAttachment, openLightbox, closeLightbox.
 * Auxiliary functions: formatSize, ingestFrozen, ingestBlocked, probeDims,
 * dragHasFiles, setDragHighlight.
 *
 * Complexity: adding a file is O(size) (scrub, encrypt, store); drawing the
 * strip is O(m) in the attachments, plus one decrypt per picture, O(size).
 */
"use strict";

// ---------- State ----------

// The largest attachment, and the size of the parts a large one is stored in.
const MEDIA_MAX = 200 * 1024 * 1024;
const MEDIA_CHUNK = 20 * 1024 * 1024;

// What a parts manifest starts with. Encrypted bytes start with a random IV,
// so no real record can look like one.
const CHUNK_MAGIC = "notes-chunks-v1:";

// The picture types whose metadata is removed before they are encrypted.
const SCRUBBABLE = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

// ---------- Adding attachments ----------

/**
 * Whose attachments are being shown: { note, readOnly } for the open note,
 * or for a note in the trash (read-only: download allowed, nothing removed
 * or added); null when the vault is locked or nothing is open.
 *
 * Used by: this file (renderAttachments), lines.js (hydrateInlineMedia,
 * hydrateOneInline), history.js (inlineDims).
 * Uses: nothing.
 * Complexity: O(1).
 */
function mediaCtx() {
  if (!vault) {
    return null;
  }
  if (trashViewId && vault.trash[trashViewId]) {
    return { note: vault.trash[trashViewId].data || {}, readOnly: true };
  }
  if (currentId && vault.notes[currentId]) {
    return { note: vault.notes[currentId], readOnly: false };
  }
  return null;
}

/**
 * Adds pasted or dropped files, one after another (two 40 MB encrypts at
 * once would double the memory). With options.inline, each goes in the text
 * at options.range (a caret taken before any await), the next one after the
 * last; otherwise it goes in the strip only.
 *
 * Used by: this file (paste and drop, on load).
 * Uses: ingestBlocked, ingestFrozen, addMedia.
 * Complexity: O(size) of all the files.
 */
async function ingestFiles(fileList, options) {
  options = options || {};
  const files = [...(fileList || [])];
  if (!files.length || ingestBlocked()) {
    return;
  }
  // Every type is accepted; what is shown is decided per kind instead.
  const accepted = files;
  const inline = !!options.inline && !trashViewId;
  let range = inline ? (options.range || null) : null;
  for (const file of accepted) {
    if (ingestFrozen()) {
      return;
    }
    const mid = await addMedia(file, inline ? { insertInline: true, range } : null);
    // The caret moves past the wrapper just placed, so the next file follows it.
    if (inline && mid) {
      const wrapper = $("edit-wrap").querySelector('span.inline-media[data-mid="' + mid + '"]');
      if (wrapper && wrapper.isConnected) {
        range = document.createRange();
        range.setStartAfter(wrapper);
        range.collapse(true);
      } else {
        range = null;
      }
    }
  }
}

/**
 * The open note's id, or a new empty note's when none is open: an
 * attachment with no note would belong to nothing and be lost. The new note
 * goes at the top of the loose notes (if they are in a hand-made order) and
 * opens. A search in progress is cleared, so the note can be seen.
 *
 * Used by: this file (addMedia).
 * Uses: newLooseOrder (sidebar.js), persistSafe (vault.js), openNote (pagination.js).
 * Complexity: O(n) over the loose notes, for the order.
 */
function ensureNoteForMedia() {
  if (currentId && vault.notes[currentId]) {
    return currentId;
  }
  if (searchQuery) {
    searchQuery = "";
    $("search").value = "";
  }
  const id = crypto.randomUUID();
  vault.notes[id] = { title: "", body: "", color: null, folderId: null, mtime: Date.now(), media: [] };
  // Left without an order when the loose notes have none, so a vault never
  // reordered by hand keeps its plain newest-first order.
  {
    const order = newLooseOrder();
    if (order !== undefined) {
      vault.notes[id].order = order;
    }
  }
  persistSafe();
  openNote(id);
  return id;
}

/**
 * A copy of a picture with its metadata removed. A phone photo carries EXIF:
 * GPS coordinates, the camera's serial number, the exact time, all inside
 * the bytes that would otherwise be encrypted, synced and put into an
 * exported PDF as they are. Drawing it again through a canvas keeps only the
 * pixels, since the encoder writes a fresh file. PNG and WebP stay lossless;
 * JPEG is encoded again at 0.95, the same to the eye though not byte for
 * byte. Other files are left as they are (a .docx keeps its own metadata:
 * removing it would mean parsing the format). A failure returns the
 * original, so a file is never lost to it.
 *
 * Used by: this file (addMedia, before encrypting).
 * Uses: baseMimeType (vault.js), SCRUBBABLE.
 * Complexity: O(w * h) in the picture's pixels.
 */
async function stripImageMetadata(file) {
  if (!SCRUBBABLE.has(baseMimeType(file.type))) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close && bitmap.close();
    const type = baseMimeType(file.type) === "image/png" ? "image/png"
      : baseMimeType(file.type) === "image/webp" ? "image/webp" : "image/jpeg";
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.95));
    // Lets go of the canvas's pixel memory.
    canvas.width = canvas.height = 0;
    if (!blob || !blob.size) {
      return file;
    }
    return new File([blob], file.name, { type });
  } catch {
    return file;
  }
}

/**
 * Adds one file to the open note (or a new one) and returns its media id, or
 * nothing when it was not added. In order:
 *   1. The note being typed is saved first, and an undo step is marked, so
 *      Ctrl+Z takes the attachment out again.
 *   2. With options.insertInline, a wrapper showing a placeholder goes in at
 *      options.range now, before the encrypt, so the place is kept even if
 *      the user moves on meanwhile (its reference needs no bytes yet).
 *   3. A picture's metadata is removed (stripImageMetadata), before
 *      encrypting: the stored bytes must never hold EXIF, and the note's
 *      entry must describe the bytes really kept.
 *   4. The bytes are encrypted with AES-256-GCM (encryptMedia, about 3.7 ms
 *      per MB) and stored in IndexedDB and in the vault's own media folder.
 *      If that fails, the placeholder comes out again, so the note never
 *      names bytes that were not stored.
 *   5. The entry joins note.media and the note is saved straight away (a
 *      wrapper put in by script fires no input event), then the wrapper is
 *      shown with its real picture.
 *
 * Used by: this file (ingestFiles).
 * Uses: ingestFrozen, formatSize, alertModal (modal.js), flushSave, status
 * and renderStatus (pagination.js), ensureNoteForMedia, historyMark
 * (history.js), probeDims, buildInlineWrapper, applyInlineSize,
 * insertInlineWrapper, updateEditorEmpty, getEditorBody, surfaceOfNode,
 * sheetsSnapshot and hydrateOneInline (lines.js), kindForMime,
 * isAllowedMediaType, encryptMedia, idbPut and persistLocal (vault.js),
 * saveMediaFile (vaults.js), stripImageMetadata, notePages (content.js),
 * renderList (sidebar.js), renderAttachments.
 * Complexity: O(size) of the file.
 */
async function addMedia(file, options) {
  options = options || {};
  if (ingestFrozen() || !isAllowedMediaType(file.type)) {
    return;
  }
  if (file.size > MEDIA_MAX) {
    await alertModal({
      title: "File too large",
      body: `"${file.name || "attachment"}" is ${formatSize(file.size)}. Attachments are capped at ` +
        `${formatSize(MEDIA_MAX)} (larger uploads are split into ${formatSize(MEDIA_CHUNK)} chunks for GitHub, ` +
        `but the whole file must still fit in memory to encrypt).`,
    });
    return;
  }

  flushSave();
  const id = ensureNoteForMedia();
  if (!id || !vault.notes[id]) {
    return;
  }
  historyMark(id);
  const mid = crypto.randomUUID();
  const name = file.name || "attachment";
  // Best effort: it reserves the picture's space, and is null when it fails.
  const dimensions = await probeDims(file);
  // Things may have changed while the size was read.
  if (ingestFrozen() || !vault || !vault.notes[id]) {
    status("");
    return;
  }

  let wrapper = null;
  if (options.insertInline && !trashViewId && currentId === id) {
    wrapper = buildInlineWrapper(mid, kindForMime(file.type));
    if (dimensions) {
      applyInlineSize(wrapper, dimensions.w, dimensions.h);
    }
    insertInlineWrapper(wrapper, options.range);
  }
  status(`Encrypting ${name}...`, false, true);
  let stored = file;
  try {
    stored = await stripImageMetadata(file);
  } catch {}
  try {
    const sealed = await encryptMedia(mid, await stored.arrayBuffer());
    await idbPut(mid, sealed);
    saveMediaFile(mid, sealed);
  } catch (error) {
    status("Could not attach " + name + ": " + error.message, true);
    if (wrapper && wrapper.isConnected) {
      wrapper.remove();
      updateEditorEmpty();
      if (currentId === id && vault.notes[id]) {
        const current = vault.notes[id];
        current.body = getEditorBody();
        current.bodyV = 2;
        editorPlainOrig = null;
        editorBaseline = current.body;
        persistLocal().catch(() => {});
      }
    }
    return;
  }

  // Locked, or the note was trashed, while encrypting.
  if (!vault || !vault.notes[id]) {
    status("");
    return;
  }
  const note = vault.notes[id];
  if (!Array.isArray(note.media)) {
    note.media = [];
  }
  note.media.push({ id: mid, mime: stored.type || file.type, name, size: stored.size, ...(dimensions || {}) });
  if (wrapper && wrapper.isConnected && currentId === id) {
    // On sheets the wrapper is in one page: that page is saved, and the
    // baseline covers every sheet.
    const surface = surfaceOfNode(wrapper);
    const pages = notePages(note);
    if (pages && surface && surface.dataset.page !== undefined && pages[+surface.dataset.page]) {
      const page = pages[+surface.dataset.page];
      page.body = getEditorBody(surface);
      page.bodyV = 2;
      editorPlainOrig = null;
      editorBaseline = sheetsSnapshot();
    } else {
      note.body = getEditorBody();
      note.bodyV = 2;
      editorPlainOrig = null;
      editorBaseline = note.body;
    }
  }
  note.mtime = Date.now();
  // Saved straight through, not through the unsaved-edits flag (which only
  // covers the title and the text), so the note counts as changed and unsynced.
  persistLocal().catch(error => status("Save failed: " + error.message, true));
  renderList();
  renderStatus();
  if (currentId === id) {
    renderAttachments();
  }
  if (wrapper && wrapper.isConnected && currentId === id) {
    hydrateOneInline(wrapper);
  }
  status("Attached " + name);
  return mid;
}

/**
 * Puts pasted or dropped text in as plain text, one line per line, with the
 * censor state of the caret, exactly like typing.
 *
 * Used by: this file (paste and drop, on load).
 * Uses: surfaceOfNode and ensureLines (lines.js), insertPlanAt,
 * carryOutInsert and scrubCensorLook (censor.js), syncFormatState (toolbar.js).
 * Complexity: O(n) in the text.
 */
function insertPlainText(text) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return;
  }
  const surface = surfaceOfNode(selection.getRangeAt(0).startContainer);
  if (!surface) {
    return;
  }
  const plan = insertPlanAt(selection.getRangeAt(0), surface);
  inPlainPaste = true;
  try {
    document.execCommand("insertText", false, String(text).replace(/\r\n?/g, "\n"));
  } finally {
    inPlainPaste = false;
  }
  if (plan) {
    carryOutInsert(plan);
  }
  ensureLines(surface);
  scrubCensorLook(surface);
  syncFormatState();
}

// ---------- On load: pasting ----------

// A pasted file is attached, never put in as text: at the caret when the
// editor has the focus (and in the strip), otherwise in the strip only.
// Pasted text always goes in as plain text: pasted HTML (formatting, <img
// onerror>, data: addresses, tables) must never enter the page; the
// sanitiser on saving is a second line of defence. Censored text copied in
// this app comes back censored, not as blocks.
document.addEventListener("paste", event => {
  if (ingestBlocked()) {
    return;
  }
  const files = event.clipboardData && event.clipboardData.files;
  const hasMedia = files && files.length && [...files].some(file => isAllowedMediaType(file.type));
  if (hasMedia) {
    event.preventDefault();
    const inline = !trashViewId && editorHasFocus(event.target);
    ingestFiles(files, inline ? { inline: true, range: currentEditorRange() } : null);
    return;
  }
  if (!trashViewId && editorHasFocus(event.target)) {
    event.preventDefault();
    const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    if (text && appClip && sameClipText(text, appClip.plain)) {
      insertSegments(appClip.segs);
    } else if (text) {
      insertPlainText(text);
    }
  }
});

// ---------- On load: dropping files ----------

// How deep inside #main a file drag is (dragenter and dragleave fire for
// every child element).
let dragDepth = 0;

// The whole main column (editor, strip, banners) takes dropped files. On the
// editor they go in where they are dropped; elsewhere in the strip only.
$("main").addEventListener("dragenter", event => {
  if (!dragHasFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth++;
  if (!ingestBlocked()) {
    setDragHighlight(true);
  }
});
$("main").addEventListener("dragover", event => {
  if (!dragHasFiles(event)) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = ingestBlocked() ? "none" : "copy";
});
$("main").addEventListener("dragleave", event => {
  if (!dragHasFiles(event)) {
    return;
  }
  if (--dragDepth <= 0) {
    dragDepth = 0;
    setDragHighlight(false);
  }
});
$("main").addEventListener("drop", event => {
  if (!dragHasFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  setDragHighlight(false);
  if (ingestBlocked()) {
    return;
  }
  let options = null;
  if (!trashViewId && $("editor").contains(event.target)) {
    const range = caretRangeAt(event.clientX, event.clientY);
    options = { inline: true, range: (range && $("editor").contains(range.commonAncestorContainer)) ? range : null };
  }
  ingestFiles(event.dataTransfer.files, options);
});

// Outside the main column the browser would leave the app (and anything
// unsaved) to show the file: that is stopped, and the status line says where to drop.
document.addEventListener("dragover", event => {
  if (dragHasFiles(event)) {
    event.preventDefault();
  }
});
document.addEventListener("drop", event => {
  if (!dragHasFiles(event)) {
    return;
  }
  event.preventDefault();
  if (!$("main").contains(event.target) && !ingestFrozen()) {
    status("Drop images or videos on the editor to attach them");
  }
});

// ---------- On load: dragging inside the editor ----------

// Dragging starts. For an inline attachment: its node is remembered, with
// where it was grabbed, and the drag carries only a private type (never Files
// or text/plain), so no other handler takes it and the node can never leak
// out as content. The listener is on the whole editing area, since on sheets
// the wrappers are inside .sheet-body. For selected text: like a copy, the
// drag never carries censored characters out, and they come back censored
// when dropped into a note.
$("edit-wrap").addEventListener("dragstart", event => {
  const wrapper = (event.target && event.target.nodeType === 1) ? event.target.closest("span.inline-media") : null;
  if (!wrapperOf(wrapper)) {
    appDrag = null;
    const censored = event.dataTransfer ? censoredSelection() : null;
    if (censored) {
      const plain = censoredCopy(censored) || "";
      try {
        event.dataTransfer.clearData();
        event.dataTransfer.setData("text/plain", plain);
      } catch {}
      appDrag = { plain, segs: copySegments(censored) };
    }
    return;
  }
  // The read-only reference pane.
  if (!surfaceOfNode(wrapper)) {
    return;
  }
  if (ingestBlocked()) {
    event.preventDefault();
    return;
  }
  // The handles are not part of the content and must not travel with it.
  if (selectedMedia === wrapper) {
    clearMediaSelection();
  }
  // Where in the picture it was grabbed, so it lands under the pointer.
  {
    const box = wrapper.getBoundingClientRect();
    dragGrab = { dx: event.clientX - box.left, dy: event.clientY - box.top };
  }
  draggingInlineNode = wrapper;
  event.dataTransfer.effectAllowed = "move";
  try {
    event.dataTransfer.setData("application/x-inline-media", wrapper.getAttribute("data-mid") || "1");
  } catch {}
  wrapper.classList.add("dragging");
});

// Dragging ends. The click the browser makes at the end of a drag is
// swallowed, or the picture would be selected again at once.
$("edit-wrap").addEventListener("dragend", () => {
  appDrag = null;
  if (draggingInlineNode) {
    draggingInlineNode.classList.remove("dragging");
  }
  draggingInlineNode = null;
  hideDragGuide();
  justDraggedMedia = true;
  setTimeout(() => {
    justDraggedMedia = false;
  }, 0);
});

// While an attachment is dragged, the browser's own caret shows where it
// would land, and the guide shows the middle of the page.
$("edit-wrap").addEventListener("dragover", event => {
  if (draggingInlineNode) {
    if (ingestBlocked()) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const range = caretRangeAt(event.clientX, event.clientY);
    const selection = window.getSelection();
    if (range && selection && surfaceOfNode(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const surface = (range && surfaceOfNode(range.commonAncestorContainer)) || activeSurface();
    if (surface) {
      showDragGuide(surface, event.clientX);
    }
    return;
  }
  if (dragHasFiles(event) || ingestBlocked()) {
    return;
  }
  // Needed for the drop event to fire, so the drop can be made plain text.
  event.preventDefault();
});

// A drop. An attachment being moved is pinned exactly where it is dropped
// (centred on the page when it snapped to the middle): the same node, so
// nothing new comes in or goes out. Files are left to #main's handler. Text
// from another page or window goes in as plain text at the drop point, never
// as live HTML.
$("edit-wrap").addEventListener("drop", event => {
  if (draggingInlineNode) {
    event.preventDefault();
    event.stopPropagation();
    if (!ingestBlocked()) {
      const node = draggingInlineNode;
      const surface = surfaceAtPoint(event.clientX, event.clientY) || activeSurface();
      const snap = surface ? showDragGuide(surface, event.clientX) : false;
      let grab = dragGrab;
      if (snap && surface) {
        const page = surface.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        grab = {
          dx: (event.clientX - (page.left + page.width / 2 - box.width / 2)),
          dy: grab ? grab.dy : box.height / 2,
        };
      }
      if (placeFloating(node, surface, event.clientX, event.clientY, grab)) {
        markDirtyFromFormatting();
      }
    }
    hideDragGuide();
    dragGrab = null;
    // dragend clears draggingInlineNode.
    return;
  }
  if (dragHasFiles(event)) {
    return;
  }
  event.preventDefault();
  if (ingestBlocked()) {
    return;
  }
  const text = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
  if (!text) {
    return;
  }
  const range = caretRangeAt(event.clientX, event.clientY);
  const target = range && surfaceOfNode(range.commonAncestorContainer);
  if (!target) {
    return;
  }
  target.focus();
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (appDrag && sameClipText(text, appDrag.plain)) {
    insertSegments(appDrag.segs);
  } else {
    insertPlainText(text);
  }
});

// ---------- The strip: state ----------

// Which drawing of the strip is current: a decrypt from an older one must not paint.
let attachSeq = 0;

// The decrypt queue: strictly one decrypt at a time, shared with inline pictures.
let decryptChain = Promise.resolve();

// What a tile's tooltip adds for each state.
const TILE_NOTE = {
  pending: "decrypting", video: "video", pdf: "pdf", text: "text", file: "file",
  missing: "not on this device", corrupt: "corrupted", blocked: "unsupported type", image: "",
};

// ---------- The strip ----------

/**
 * Draws the strip of attachment tiles under the note (hidden when it has
 * none). One read of IndexedDB's keys, without any bytes, tells every tile
 * whether its bytes are on this device. Pictures are then queued for a
 * thumbnail; every other kind is a tile that decrypts when clicked. Drawing
 * again makes every decrypt still on its way stale.
 *
 * Used by: this file (addMedia, removeAttachment), pagination.js (openNote,
 * openTrash), notes.js (purgeTrashCore, trashNote), history.js
 * (applyDesignToNote, reloadNoteInPlace, resetNoteLayout,
 * restoreSplitSnapshot), designs.js (applyDesign), media-sync.js
 * (overwriteRemote, syncOnce), merge.js (applyMerge), panel.js
 * (restorePrev), lock.js (on load).
 * Uses: mediaCtx, makeTile, idbKeys, isAllowedMediaType and kindForMime (vault.js), queueThumb.
 * Complexity: O(m) in the attachments, plus one AES-GCM decrypt per picture.
 */
function renderAttachments() {
  const strip = $("attachments");
  const generation = ++attachSeq;
  strip.innerHTML = "";
  const context = mediaCtx();
  const media = context && Array.isArray(context.note.media) ? context.note.media : [];
  if (!media.length) {
    strip.style.display = "none";
    return;
  }
  strip.style.display = "flex";
  const tiles = media.map(meta => {
    const tile = makeTile(meta, context.readOnly);
    strip.appendChild(tile.el);
    return tile;
  });
  idbKeys().then(keys => {
    if (generation !== attachSeq) {
      return;
    }
    const have = new Set(keys);
    for (const tile of tiles) {
      if (!isAllowedMediaType(tile.meta.mime)) {
        tile.setState("blocked");
        continue;
      }
      if (!have.has(tile.meta.id)) {
        tile.setState("missing");
        continue;
      }
      const kind = kindForMime(tile.meta.mime);
      if (kind === "image") {
        queueThumb(generation, tile);
      } else {
        tile.setState(kind);
      }
    }
  }).catch(() => {
    if (generation === attachSeq) {
      for (const tile of tiles) {
        tile.setState("missing");
      }
    }
  });
}

/**
 * Decrypts a picture for its tile, in the shared queue. An address already
 * made (by an inline copy, or an earlier drawing) is used again, so a
 * picture shown both in the strip and in the text is decrypted once. The
 * bytes come from IndexedDB and are decrypted with AES-256-GCM (decryptMedia,
 * about 3 ms per MB). Bytes that fail to decrypt (a damaged record, a file
 * tampered with in the repository) show "Attachment corrupted". Nothing is
 * made once the vault is locked, or a plain address would outlive the lock.
 *
 * Used by: this file (renderAttachments).
 * Uses: mediaUrls, idbGet, decryptMedia and getOrCreateMediaUrl (vault.js), decryptChain.
 * Complexity: O(size) of the picture.
 */
function queueThumb(generation, tile) {
  const cached = mediaUrls.get(tile.meta.id);
  if (cached) {
    tile.setImage(cached);
    return;
  }
  decryptChain = decryptChain.then(async () => {
    if (generation !== attachSeq || !vault) {
      return;
    }
    try {
      const record = await idbGet(tile.meta.id);
      if (generation !== attachSeq || !vault) {
        return;
      }
      if (!record) {
        tile.setState("missing");
        return;
      }
      if (mediaUrls.get(tile.meta.id)) {
        tile.setImage(mediaUrls.get(tile.meta.id));
        return;
      }
      const plain = await decryptMedia(tile.meta.id, record.bytes);
      if (generation !== attachSeq || !vault) {
        return;
      }
      tile.setImage(getOrCreateMediaUrl(tile.meta.id, tile.meta.mime, plain));
    } catch {
      if (generation === attachSeq) {
        tile.setState("corrupt");
      }
    }
  }).catch(() => {});
}

/**
 * A new tile for an attachment: { el, meta, state, setState, setImage }. A
 * state shows a placeholder (a video, PDF, text or file tile, or a notice);
 * setImage shows the thumbnail. A click opens it, a right-click (or the menu
 * key, or Shift+F10) gives its menu, and it can be reached with Tab and
 * opened with Enter or Space.
 *
 * Used by: this file (renderAttachments).
 * Uses: makeElement (sidebar.js), formatSize, TILE_NOTE, openAttachment,
 * openMenu (menu.js), attachmentMenu.
 * Complexity: O(1).
 */
function makeTile(meta, readOnly) {
  const el = makeElement("div", "att");
  const placeholder = makeElement("div", "att-ph");
  el.appendChild(placeholder);
  const tile = { el, meta, state: "pending" };
  const label = state => [meta.name || "attachment", formatSize(meta.size), TILE_NOTE[state]].filter(Boolean).join(" - ");

  tile.setState = state => {
    tile.state = state;
    const img = el.querySelector("img");
    if (img) {
      img.remove();
    }
    placeholder.className = "att-ph" + (state === "missing" || state === "corrupt" ? " warn" : "");
    placeholder.style.display = "";
    placeholder.innerHTML = "";
    if (state === "video") {
      placeholder.appendChild(makeElement("div", "glyph", "▶"));
      placeholder.appendChild(makeElement("div", "nm", meta.name || "video"));
      placeholder.appendChild(makeElement("div", null, formatSize(meta.size)));
    } else if (state === "pdf" || state === "text" || state === "file") {
      placeholder.appendChild(makeElement("div", "glyph", state === "pdf" ? "▤" : state === "text" ? "≡" : "⇓"));
      placeholder.appendChild(makeElement("div", "nm", meta.name || state));
      placeholder.appendChild(makeElement("div", null, formatSize(meta.size)));
    } else if (state === "missing") {
      placeholder.appendChild(makeElement("div", "glyph", "↓"));
      placeholder.appendChild(makeElement("div", null, "Not on this device"));
      placeholder.appendChild(makeElement("div", null, "Sync to fetch"));
    } else if (state === "corrupt") {
      placeholder.appendChild(makeElement("div", "glyph", "!"));
      placeholder.appendChild(makeElement("div", null, "Attachment corrupted"));
    } else if (state === "blocked") {
      placeholder.appendChild(makeElement("div", "glyph", "!"));
      placeholder.appendChild(makeElement("div", null, "Unsupported type"));
    }
    el.title = label(state);
  };

  tile.setImage = url => {
    tile.state = "image";
    placeholder.style.display = "none";
    const img = makeElement("img");
    img.alt = meta.name || "";
    img.src = url;
    el.appendChild(img);
    el.title = label("image");
  };

  el.onclick = () => openAttachment(tile);
  el.oncontextmenu = event => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, attachmentMenu(tile, readOnly));
  };
  el.tabIndex = 0;
  el.onkeydown = event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAttachment(tile);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      openMenu(box.left + 8, box.bottom - 8, attachmentMenu(tile, readOnly));
    }
  };
  tile.setState("pending");
  return tile;
}

/**
 * Opens a tile: a picture in the lightbox, a file as a download, and a
 * video, PDF or text decrypted (AES-256-GCM, about 3 ms per MB) into the
 * lightbox, which owns that address and revokes it when it closes. A
 * placeholder tile opens nothing. Nothing opens if the strip was drawn again
 * (another note) or the app was locked meanwhile, so decrypted content never
 * appears over the lock screen.
 *
 * Used by: this file (a click, Enter or Space on a tile).
 * Uses: openLightbox, downloadAttachment, status (pagination.js), loadMedia,
 * mediaUrls and mediaObjectUrl (vault.js).
 * Complexity: O(size) of the attachment.
 */
async function openAttachment(tile) {
  if (tile.state === "image") {
    openLightbox(tile.meta, mediaUrls.get(tile.meta.id), false);
    return;
  }
  // Nothing here shows a .docx: it is saved instead.
  if (tile.state === "file") {
    downloadAttachment(tile);
    return;
  }
  if (tile.state !== "video" && tile.state !== "pdf" && tile.state !== "text") {
    return;
  }
  const generation = attachSeq;
  status("Decrypting " + (tile.meta.name || tile.state) + "...", false, true);
  const plain = await loadMedia(tile);
  if (!plain || generation !== attachSeq || !vault) {
    status("");
    return;
  }
  status("");
  openLightbox(tile.meta, mediaObjectUrl(tile.meta.id, tile.meta.mime, plain), true);
}

/**
 * Reads and decrypts a tile's attachment (AES-256-GCM), or returns null,
 * showing the tile as missing or corrupted instead of failing. A lock clears
 * the keys, so a decrypt on its way when the app locks fails here: that is
 * not reported, since saying so on the lock screen would tell that an
 * attachment was being opened.
 *
 * Used by: this file (openAttachment, downloadAttachment).
 * Uses: idbGet and decryptMedia (vault.js), status (pagination.js).
 * Complexity: O(size) of the attachment.
 */
async function loadMedia(tile) {
  try {
    const record = await idbGet(tile.meta.id);
    if (!vault) {
      return null;
    }
    if (!record) {
      tile.setState("missing");
      status("Not on this device - Sync to fetch", true);
      return null;
    }
    const plain = await decryptMedia(tile.meta.id, record.bytes);
    return vault ? plain : null;
  } catch {
    if (!vault) {
      return null;
    }
    tile.setState("corrupt");
    status("Attachment corrupted", true);
    return null;
  }
}

/**
 * Decrypts a tile's attachment and saves it as a download.
 *
 * Used by: this file (openAttachment, attachmentMenu).
 * Uses: loadMedia, downloadPlain.
 * Complexity: O(size) of the attachment.
 */
async function downloadAttachment(tile) {
  const plain = await loadMedia(tile);
  if (!plain) {
    return;
  }
  downloadPlain(tile.meta.name, tile.meta.mime, plain);
}

/**
 * Saves bytes as a download. The address is tracked, so a lock, a purge or
 * a note switch can revoke it too, and it is revoked after 10 seconds in any
 * case (an untracked one once kept plain bytes alive through every
 * teardown). Nothing is saved once the vault is locked.
 *
 * Used by: this file (downloadAttachment), lines.js (openInlineMedia),
 * pdf.js (exportNoteInternal), designs.js (exportDesign), backups.js (writeFolderFile).
 * Uses: downloadUrls and revokeDownloadUrl (vault.js).
 * Complexity: O(1), besides the browser's copy of the bytes.
 */
function downloadPlain(name, mime, plain) {
  if (!vault) {
    return;
  }
  const url = URL.createObjectURL(new Blob([plain], { type: mime || "application/octet-stream" }));
  downloadUrls.add(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "attachment";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => revokeDownloadUrl(url), 10000);
}

/**
 * A tile's menu: Download (when its bytes are here), "Sync this note" (when
 * they are not), and Remove (not in the trash).
 *
 * Used by: this file (makeTile).
 * Uses: downloadAttachment, flushSave (pagination.js), syncNote (media-sync.js), removeAttachment.
 * Complexity: O(1).
 */
function attachmentMenu(tile, readOnly) {
  const items = [];
  if (tile.state !== "missing" && tile.state !== "corrupt" && tile.state !== "blocked") {
    items.push({ label: "Download", onClick: () => downloadAttachment(tile) });
  }
  if (tile.state === "missing") {
    if (readOnly) {
      items.push({ label: "Not on this device", disabled: true });
    } else {
      items.push({
        label: "Sync this note",
        disabled: syncing,
        onClick: () => {
          flushSave();
          if (currentId) {
            window.syncNote(currentId);
          }
        },
      });
    }
  }
  if (!readOnly) {
    if (items.length) {
      items.push({ sep: true });
    }
    items.push({ label: "Remove", danger: true, disabled: syncing, onClick: () => removeAttachment(tile.meta.id) });
  }
  if (!items.length) {
    items.push({ label: "No actions", disabled: true });
  }
  return items;
}

/**
 * Removes an attachment from the open note, after asking. Every inline copy
 * comes out of the text too, before its address is revoked (no inline
 * picture is left pointing at a dead address), and the text is saved again.
 * The encrypted bytes stay in IndexedDB until the next sync deletes the
 * remote copy and the local record, and only if no other note still names
 * them (a conflict copy shares its original's attachments).
 *
 * Used by: this file (attachmentMenu).
 * Uses: confirmModal (modal.js), flushSave, status and renderStatus
 * (pagination.js), getEditorBody and updateEditorEmpty (lines.js),
 * closeLightbox, revokeMediaUrl, mediaReferenced and persistLocal
 * (vault.js), renderList (sidebar.js), renderAttachments.
 * Complexity: O(n) over the notes, to see whether anything else names it.
 */
async function removeAttachment(mid) {
  if (syncing || trashViewId || !currentId) {
    return;
  }
  const noteId = currentId;
  const note = vault.notes[noteId];
  if (!note) {
    return;
  }
  const meta = (note.media || []).find(item => item.id === mid);
  if (!meta) {
    return;
  }
  const confirmed = await confirmModal({
    title: "Remove attachment?",
    body: `"${meta.name || "attachment"}" will be removed from this note and, on the next sync, from the repo.`,
    confirmLabel: "Remove", destructive: true,
  });
  if (!confirmed || syncing || trashViewId || currentId !== noteId || !vault.notes[noteId]) {
    return;
  }

  flushSave();
  note.media = (note.media || []).filter(item => item.id !== mid);
  const wrappers = [...$("editor").querySelectorAll('span.inline-media[data-mid="' + mid + '"]')];
  if (wrappers.length) {
    for (const wrapper of wrappers) {
      wrapper.remove();
    }
    note.body = getEditorBody();
    note.bodyV = 2;
    editorPlainOrig = null;
    editorBaseline = note.body;
    updateEditorEmpty();
  }
  note.mtime = Date.now();
  if (lightbox && lightbox.mediaId === mid) {
    closeLightbox();
  }
  revokeMediaUrl(mid);
  if (!mediaReferenced(mid)) {
    vault.purged[mid] = Date.now();
  }
  persistLocal().catch(error => status("Save failed: " + error.message, true));
  renderList();
  renderStatus();
  renderAttachments();
  status("Attachment removed");
}

// ---------- The lightbox ----------

// For other scripts: whether it is open, and closing it if it is (true when it was).
// lightbox itself is declared in vault.js, with the address registry.
window.isLightboxOpen = () => !!lightbox;
window.closeLightboxIfOpen = () => {
  if (!lightbox) {
    return false;
  }
  closeLightbox();
  return true;
};

/**
 * Shows an attachment full-screen over the app: a video with its controls,
 * a PDF in the browser's own viewer (boxed in an iframe on a blob: address,
 * so the document never becomes page content), text through textContent
 * only (inert for any content, even markup mislabelled as text), or a
 * picture. A click on the dark backdrop, never on the content, closes it.
 * revokeOnClose says the lightbox owns the address.
 *
 * Used by: this file (openAttachment), lines.js (openInlineMedia, setInlineImage).
 * Uses: closeLightbox, makeElement (sidebar.js), isPdfType and isTextType (vault.js), formatSize.
 * Complexity: O(1), besides the browser showing the content.
 */
function openLightbox(meta, url, revokeOnClose) {
  if (!url) {
    return;
  }
  closeLightbox();
  const back = makeElement("div", "lb-back");
  let video = null;
  if ((meta.mime || "").startsWith("video/")) {
    video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.src = url;
    back.appendChild(video);
  } else if (isPdfType(meta.mime)) {
    const frame = document.createElement("iframe");
    frame.className = "lb-pdf";
    frame.title = meta.name || "PDF";
    frame.src = url;
    back.appendChild(frame);
  } else if (isTextType(meta.mime)) {
    const pre = makeElement("pre", "lb-text");
    fetch(url).then(response => response.text()).then(text => {
      pre.textContent = text;
    }).catch(() => {
      pre.textContent = "(could not read)";
    });
    back.appendChild(pre);
  } else {
    const img = makeElement("img");
    img.alt = meta.name || "";
    img.src = url;
    back.appendChild(img);
  }
  back.appendChild(makeElement("div", "lb-cap", [meta.name, formatSize(meta.size)].filter(Boolean).join("  ")));
  back.onclick = event => {
    if (event.target === back) {
      closeLightbox();
    }
  };
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add("show"));
  lightbox = { back, mediaId: meta.id, revokeOnClose: !!revokeOnClose, video };
}

/**
 * Closes the lightbox: a video stops and lets go of its source before the
 * address is revoked (when the lightbox owned it).
 *
 * Used by: this file (openLightbox, removeAttachment), settings.js (lockApp),
 * vault.js (revokeAllMediaUrls, revokeMediaUrl).
 * Uses: fadeOut (menu.js), revokeMediaUrl (vault.js).
 * Complexity: O(1).
 */
function closeLightbox() {
  if (!lightbox) {
    return;
  }
  const shown = lightbox;
  lightbox = null;
  if (shown.video) {
    try {
      shown.video.pause();
      shown.video.removeAttribute("src");
      shown.video.load();
    } catch {}
  }
  fadeOut(shown.back);
  if (shown.revokeOnClose) {
    revokeMediaUrl(shown.mediaId);
  }
}

// =================== Auxiliary functions ===================

/** A byte count for people: "512 B", "12 KB", "3.4 MB"; "" when unknown. Also used by pdf.js. Complexity: O(1). */
function formatSize(bytes) {
  if (!(bytes >= 0)) {
    return "";
  }
  if (bytes < 1024) {
    return bytes + " B";
  }
  if (bytes < 1048576) {
    return Math.round(bytes / 1024) + " KB";
  }
  const megabytes = bytes / 1048576;
  return (megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)) + " MB";
}

/** Whether adding is off: locked, a sync running, or the trash or a backup on screen. Complexity: O(1). */
function ingestFrozen() {
  return !vault || syncing || !!trashViewId || !!backupView;
}

/**
 * Whether a paste or drop must be ignored: adding is off, or a dialog, menu
 * or lightbox is open (an image pasted over a dialog must not attach
 * silently). Complexity: O(1).
 */
function ingestBlocked() {
  return ingestFrozen() || uiLayerOpen();
}

/**
 * A picture's or video's size in pixels, { w, h }, to reserve its space, or
 * null (other kinds, a failure, or no answer within 5 seconds). It reads a
 * short-lived address on the bytes just given, revoked at once and never
 * stored. Complexity: O(1) besides the browser reading the header.
 */
function probeDims(file) {
  return new Promise(resolve => {
    const kind = kindForMime(file.type);
    if (kind !== "image" && kind !== "video") {
      return resolve(null);
    }
    const url = URL.createObjectURL(file);
    const done = dimensions => {
      URL.revokeObjectURL(url);
      resolve(dimensions);
    };
    const timer = setTimeout(() => done(null), 5000);
    if (file.type.toLowerCase().startsWith("video/")) {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        done(video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null);
      };
      video.onerror = () => {
        clearTimeout(timer);
        done(null);
      };
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        done(img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      };
      img.onerror = () => {
        clearTimeout(timer);
        done(null);
      };
      img.src = url;
    }
  });
}

/** Whether a drag carries files. Complexity: O(t) in its types. */
function dragHasFiles(event) {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes("Files");
}

/** Lights up the main column while files are dragged over it. Complexity: O(1). */
function setDragHighlight(on) {
  $("main").classList.toggle("drag-over", on);
}
