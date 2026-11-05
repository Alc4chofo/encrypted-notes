// notes: Attachments: adding them, the strip and the lightbox.
"use strict";

// ---------- Attachments: ingest (paste / drag-drop) ----------
// Plaintext media bytes only ever exist transiently in memory and behind the
// blob: URLs tracked in mediaUrls; IndexedDB and the repo see ciphertext only.
// Per file. base64 inflates the PUT body ~1.37x, so 25MB of bytes is a ~34MB
// JSON request. 40MB (a ~54MB body) sits right at the contents API's
// request-size limit and could not be verified against the live API without
// writing to the real repo, so the cap ships at the safe value; raise this one
// constant back to 40MB after a single real 40MB PUT succeeds.
// Attachments above MEDIA_CHUNK are split into MEDIA_CHUNK-sized repo files
// (media/<id>.p0, .p1, ...) with a tiny manifest at media/<id>, because GitHub
// rejects large API pushes (base64 request bodies) and hard-caps repo files at
// 100MB. MEDIA_MAX is only a sanity ceiling for whole-buffer encrypt in memory.
const MEDIA_MAX = 200 * 1024 * 1024;
const MEDIA_CHUNK = 20 * 1024 * 1024;
const CHUNK_MAGIC = "notes-chunks-v1:";   // ciphertext starts with a random IV: no real record can collide

function fmtSize(b) {
  if (!(b >= 0)) return "";
  if (b < 1024) return b + " B";
  if (b < 1048576) return Math.round(b / 1024) + " KB";
  const mb = b / 1048576;
  return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
}

// Whose media the strip is showing: the live note, or a trash snapshot
// (read-only - download allowed, no remove, no ingest).
function mediaCtx() {
  if (!vault) return null;
  if (trashViewId && vault.trash[trashViewId]) return { note: vault.trash[trashViewId].data || {}, readOnly: true };
  if (currentId && vault.notes[currentId]) return { note: vault.notes[currentId], readOnly: false };
  return null;
}

// Locked, frozen mid-sync, or read-only trash view: ingest is inert. Any open
// overlay (modal, menu, lightbox) also swallows it, so pasting an image over a
// confirm dialog cannot silently attach a file.
function ingestFrozen() { return !vault || syncing || !!trashViewId || !!backupView; }
function ingestBlocked() { return ingestFrozen() || uiLayerOpen(); }

// opts.inline: insert an inline wrapper at opts.range (a caret captured BEFORE any
// await); each file lands after the previous one. Unfocused / outside-editor ingest
// passes no opts and stays strip-only, exactly as before.
async function ingestFiles(fileList, opts) {
  opts = opts || {};
  const files = [...(fileList || [])];
  if (!files.length || ingestBlocked()) return;
  const ok = files;   // every type attaches; rendering is gated per kind instead
  const inline = !!opts.inline && !trashViewId;
  let range = inline ? (opts.range || null) : null;
  // Sequential on purpose: two 40MB encrypts in parallel would spike memory.
  for (const f of ok) {
    if (ingestFrozen()) return;
    const mid = await addMedia(f, inline ? { insertInline: true, range } : null);
    // Advance the caret past the wrapper we just placed so the next file follows it.
    if (inline && mid) {
      const w = $("edit-wrap").querySelector('span.inline-media[data-mid="' + mid + '"]');
      if (w && w.isConnected) { range = document.createRange(); range.setStartAfter(w); range.collapse(true); }
      else range = null;
    }
  }
}

// Media with no note selected would own nothing and be lost: adopt it into a
// fresh note, the same pattern the type-with-no-selection handler uses.
function ensureNoteForMedia() {
  if (currentId && vault.notes[currentId]) return currentId;
  if (searchQuery) { searchQuery = ""; $("search").value = ""; }
  const id = crypto.randomUUID();
  vault.notes[id] = { title: "", body: "", color: null, folderId: null, mtime: Date.now(), media: [] };
  // If the loose list is already manually ordered, seat the new note at the TOP
  // (matching today's newest-first); otherwise leave it un-ordered so an un-dragged
  // vault keeps the group fully-legacy and behaves exactly as before.
  { const o = newLooseOrder(); if (o !== undefined) vault.notes[id].order = o; }
  persistSafe();
  openNote(id);
  return id;
}

// Metadata scrub on ingest. A phone photo carries EXIF: GPS coordinates, the
// camera serial, the exact timestamp - all of it inside the bytes we would
// otherwise encrypt and sync verbatim, and all of it would land in an exported
// PDF too. Re-drawing through a canvas keeps only the pixels; every metadata
// block is dropped because the encoder writes a fresh file.
// Cost: a re-encode. PNG/WebP are lossless here; JPEG is re-encoded at 0.95, so
// the file is pixel-identical in practice but not byte-identical to the source.
// Non-images are untouched (a docx keeps its own metadata - stripping that
// would mean parsing the format).
const SCRUBBABLE = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
async function stripImageMetadata(file) {
  if (!SCRUBBABLE.has(mimeBase(file.type))) return file;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const type = mimeBase(file.type) === "image/png" ? "image/png"
      : mimeBase(file.type) === "image/webp" ? "image/webp" : "image/jpeg";
    const blob = await new Promise(res => canvas.toBlob(res, type, 0.95));
    canvas.width = canvas.height = 0;                 // drop the backing store
    if (!blob || !blob.size) return file;             // never lose the file to a scrub failure
    return new File([blob], file.name, { type });
  } catch { return file; }
}

// Returns the media id on success (so the caller can locate the inserted wrapper),
// or undefined. opts.insertInline places an atomic inline wrapper at opts.range.
async function addMedia(file, opts) {
  opts = opts || {};
  if (ingestFrozen() || !isAllowedMediaType(file.type)) return;
  if (file.size > MEDIA_MAX) {
    await alertModal({
      title: "File too large",
      body: `"${file.name || "attachment"}" is ${fmtSize(file.size)}. Attachments are capped at ` +
        `${fmtSize(MEDIA_MAX)} (larger uploads are split into ${fmtSize(MEDIA_CHUNK)} chunks for GitHub, ` +
        `but the whole file must still fit in memory to encrypt).`,
    });
    return;
  }
  // Commit the editor buffer first: this write bumps the same note's mtime and
  // persists it, so a pending keystroke must already be in the vault.
  flushSave();
  const id = ensureNoteForMedia();
  if (!id || !vault.notes[id]) return;
  historyMark(id);              // undo takes the attachment back out
  const mid = crypto.randomUUID();
  const name = file.name || "attachment";
  const dims = await probeDims(file);   // best-effort; reserves inline space, resolves null on failure
  if (ingestFrozen() || !vault || !vault.notes[id]) { status(""); return; }   // state may have changed during probe
  // Insert the wrapper (showing a placeholder) NOW, before the async encrypt, so the
  // caret position at paste/drop time is captured even if the user navigates during
  // the encrypt. It serializes from data-mid/data-kind alone, so no bytes are needed
  // yet. insertInlineWrapper falls back to the editor end if ensureNoteForMedia just
  // reseated the editor (new note), invalidating the captured range.
  let wrapper = null;
  if (opts.insertInline && !trashViewId && currentId === id) {
    wrapper = buildInlineWrapper(mid, kindForMime(file.type));
    if (dims) applyInlineSize(wrapper, dims.w, dims.h);
    insertInlineWrapper(wrapper, opts.range);
  }
  status(`Encrypting ${name}...`, false, true);
  // Scrub BEFORE encrypting: the stored ciphertext must never contain EXIF, and
  // the metadata entry must describe the bytes we actually kept.
  let stored = file;
  try { stored = await stripImageMetadata(file); } catch {}
  try {
    const sealed = await encryptMedia(mid, await stored.arrayBuffer());
    await idbPut(mid, sealed);
    saveMediaFile(mid, sealed);   // the vault's own media folder, when access is granted
  } catch (e) {
    status("Could not attach " + name + ": " + e.message, true);
    // Roll the placeholder back out so the body never references bytes that failed
    // to store; re-serialize if it was already in the DOM.
    if (wrapper && wrapper.isConnected) {
      wrapper.remove();
      updateEditorEmpty();
      if (currentId === id && vault.notes[id]) {
        const nn = vault.notes[id];
        nn.body = getEditorBody(); nn.bodyV = 2; editorPlainOrig = null; editorBaseline = nn.body;
        persistLocal().catch(() => {});
      }
    }
    return;
  }
  if (!vault || !vault.notes[id]) { status(""); return; }   // locked or trashed while encrypting
  const n = vault.notes[id];
  if (!Array.isArray(n.media)) n.media = [];
  n.media.push({ id: mid, mime: stored.type || file.type, name, size: stored.size, ...(dims || {}) });
  // Persist the body too: a programmatic DOM insert fires no 'input', so without this
  // a lock/switch before the debounce would keep the file (in the strip) but lose its
  // inline placement. Bytes are already in IDB, so the reference is never dangling.
  if (wrapper && wrapper.isConnected && currentId === id) {
    // Paged note: the wrapper lives in a sheet, so commit THAT page and
    // re-baseline across all sheets; single-page keeps the original path.
    const surf = surfaceOfNode(wrapper);
    const ps = notePages(n);
    if (ps && surf && surf.dataset.page !== undefined && ps[+surf.dataset.page]) {
      const pg = ps[+surf.dataset.page];
      pg.body = getEditorBody(surf);
      pg.bodyV = 2;
      editorPlainOrig = null;
      editorBaseline = sheetsSnapshot();
    } else {
      n.body = getEditorBody();
      n.bodyV = 2;
      editorPlainOrig = null;
      editorBaseline = n.body;
    }
  }
  n.mtime = Date.now();
  // Written straight through (not via the `dirty` editor-buffer flag, which
  // only tracks title/body) so the note lands in the autosave/unsynced path.
  persistLocal().catch(e => status("Save failed: " + e.message, true));
  renderList();
  renderStatus();
  if (currentId === id) renderAttachments();
  // Repaint the placeholder into the real image / video poster now the bytes exist.
  if (wrapper && wrapper.isConnected && currentId === id) hydrateOneInline(wrapper);
  status("Attached " + name);
  return mid;
}

// Intrinsic pixel size of an image/video file, for reserving inline space. Uses
// a transient plaintext object URL (the same bytes the user just supplied),
// revoked immediately and never persisted. Best-effort: resolves null on any
// failure so ingest never blocks on it.
function probeDims(file) {
  return new Promise(resolve => {
    const k = kindForMime(file.type);
    if (k !== "image" && k !== "video") return resolve(null);   // only pixels have a size to reserve
    const url = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(url); resolve(d); };
    const t = setTimeout(() => done(null), 5000);
    if (file.type.toLowerCase().startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => { clearTimeout(t); done(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null); };
      v.onerror = () => { clearTimeout(t); done(null); };
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => { clearTimeout(t); done(img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null); };
      img.onerror = () => { clearTimeout(t); done(null); };
      img.src = url;
    }
  });
}

const dragHasFiles = e => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

document.addEventListener("paste", e => {
  if (ingestBlocked()) return;
  const files = e.clipboardData && e.clipboardData.files;
  const hasMedia = files && files.length && [...files].some(f => isAllowedMediaType(f.type));
  if (hasMedia) {
    e.preventDefault();   // never let a file paste land in the editor as text
    // Editor focused -> insert inline at the caret AND keep the strip entry; else
    // (unfocused) attach to the strip only, as before.
    const inline = !trashViewId && editorHasFocus(e.target);
    ingestFiles(files, inline ? { inline: true, range: currentEditorRange() } : null);
    return;
  }
  // Force plain text into the contenteditable: arbitrary pasted HTML (formatting,
  // <img onerror>, data: URLs, tables) must NEVER enter the live DOM. Save-side
  // sanitize is defense in depth; this stops rich HTML at the source.
  if (!trashViewId && editorHasFocus(e.target)) {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    // Censored text copied in this app comes back censored, not as blocks.
    if (text && appClip && sameClipText(text, appClip.plain)) insertSegments(appClip.segs);
    else if (text) insertPlainText(text);
  }
});
// Pasted or dropped text goes in as plain text, one line per line, and takes the
// censor state of the caret exactly like typing does.
function insertPlainText(text) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const surf = surfaceOfNode(sel.getRangeAt(0).startContainer);
  if (!surf) return;
  const plan = insertPlanAt(sel.getRangeAt(0), surf);
  inPlainPaste = true;
  try { document.execCommand("insertText", false, String(text).replace(/\r\n?/g, "\n")); }
  finally { inPlainPaste = false; }
  if (plan) carryOutInsert(plan);
  ensureLines(surf);
  scrubCensorLook(surf);
  syncFmtState();
}

// Drop target is the whole main column (editor, strip, banners).
let dragDepth = 0;
function setDragHighlight(on) { $("main").classList.toggle("drag-over", on); }
$("main").addEventListener("dragenter", e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (!ingestBlocked()) setDragHighlight(true);
});
$("main").addEventListener("dragover", e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = ingestBlocked() ? "none" : "copy";
});
$("main").addEventListener("dragleave", e => {
  if (!dragHasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; setDragHighlight(false); }
});
$("main").addEventListener("drop", e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragHighlight(false);
  if (ingestBlocked()) return;
  // Dropped onto the editor -> inline insert at the drop point; elsewhere in #main
  // (strip, banners) -> strip-only, as before.
  let opts = null;
  if (!trashViewId && $("editor").contains(e.target)) {
    const r = caretRangeAt(e.clientX, e.clientY);
    opts = { inline: true, range: (r && $("editor").contains(r.commonAncestorContainer)) ? r : null };
  }
  ingestFiles(e.dataTransfer.files, opts);
});
// Outside the drop zone the browser would navigate away from the app (and the
// unsaved buffer) to display the file: swallow it and say where to drop.
document.addEventListener("dragover", e => { if (dragHasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (!$("main").contains(e.target) && !ingestFrozen())
    status("Drop images or videos on the editor to attach them");
});
// A non-file drag (text/HTML from another page or window) dropped INTO the editor
// would otherwise inject live HTML: force it to plain text at the drop point.
// File drags fall through to the #main handlers above (strip attach). A sidebar
// note-row drag carries neither Files nor text/plain, so it is a no-op here.
// Start of an inline-media reposition: record the exact node and stamp a PRIVATE
// MIME (never 'Files' / 'text/plain'), so the file handlers and the text-drop path
// all ignore it and the node can never leak out as content.
// Bound to the whole editing area, not just #editor: with a paged note the
// wrappers live inside .sheet-body, so a listener on #editor never saw the drag
// and the browser fell back to its own copy behaviour - which is what made a
// dragged image reappear as a duplicate instead of moving.
$("edit-wrap").addEventListener("dragstart", e => {
  const w = (e.target && e.target.nodeType === 1) ? e.target.closest("span.inline-media") : null;
  if (!wrapperOf(w)) {
    // Dragging selected text, from the note or the reference pane: like a copy,
    // it never carries censored characters out (and comes back censored when
    // dropped into a note).
    appDrag = null;
    const c = e.dataTransfer ? censoredSelection() : null;
    if (c) {
      const plain = censoredCopy(c) || "";
      try { e.dataTransfer.clearData(); e.dataTransfer.setData("text/plain", plain); } catch {}
      appDrag = { plain, segs: copySegments(c) };
    }
    return;
  }
  if (!surfaceOfNode(w)) return;   // the read-only reference pane
  if (ingestBlocked()) { e.preventDefault(); return; }
  // The handles must not travel with the node (they are not part of the
  // content, and removing them mid-drag would mutate the drag source).
  if (selectedMedia === w) clearMediaSelection();
  // Remember where inside the image the user grabbed it, so it does not jump
  // under the cursor when it lands.
  { const r = w.getBoundingClientRect(); dragGrab = { dx: e.clientX - r.left, dy: e.clientY - r.top }; }
  draggingInlineNode = w;
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("application/x-inline-media", w.getAttribute("data-mid") || "1"); } catch {}
  w.classList.add("dragging");
});
$("edit-wrap").addEventListener("dragend", () => {
  appDrag = null;
  if (draggingInlineNode) draggingInlineNode.classList.remove("dragging");
  draggingInlineNode = null;
  hideDragGuide();
  // Swallow the click the browser synthesises at the end of a drag, or the note
  // would immediately re-select the image and pop the handles back up.
  justDraggedMedia = true;
  setTimeout(() => { justDraggedMedia = false; }, 0);
});
$("edit-wrap").addEventListener("dragover", e => {
  if (draggingInlineNode) {
    if (ingestBlocked()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Native caret previews the landing spot; no custom indicator, no layout shift.
    const r = caretRangeAt(e.clientX, e.clientY);
    const sel = window.getSelection();
    if (r && sel && surfaceOfNode(r.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(r); }
    const surf = (r && surfaceOfNode(r.commonAncestorContainer)) || activeSurface();
    if (surf) showDragGuide(surf, e.clientX);
    return;
  }
  if (dragHasFiles(e) || ingestBlocked()) return;
  e.preventDefault();   // required for the drop event to fire so we can sanitize it
});
$("edit-wrap").addEventListener("drop", e => {
  if (draggingInlineNode) {   // internal reposition: same node moved, no content in/out
    e.preventDefault();
    e.stopPropagation();      // never let #main treat this as an ingest
    if (!ingestBlocked()) {
      const node = draggingInlineNode;
      // Where the pointer is, not which line it is over: the image is pinned at
      // the exact drop point rather than being threaded back into the text.
      const surf = surfaceAtPoint(e.clientX, e.clientY) || activeSurface();
      const snap = surf ? showDragGuide(surf, e.clientX) : false;
      let grab = dragGrab;
      if (snap && surf) {
        // Snapped to the middle: centre it horizontally on the page.
        const box = surf.getBoundingClientRect(), r = node.getBoundingClientRect();
        grab = { dx: (e.clientX - (box.left + box.width / 2 - r.width / 2)), dy: grab ? grab.dy : r.height / 2 };
      }
      if (placeFloating(node, surf, e.clientX, e.clientY, grab)) markDirtyFromFormatting();
    }
    hideDragGuide();
    dragGrab = null;
    return;   // dragend clears draggingInlineNode + .dragging
  }
  if (dragHasFiles(e)) return;   // files: let #main's drop handler ingest them
  e.preventDefault();
  if (ingestBlocked()) return;
  const text = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
  if (!text) return;
  const r = caretRangeAt(e.clientX, e.clientY);
  const target = r && surfaceOfNode(r.commonAncestorContainer);
  if (!target) return;
  target.focus();
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  if (appDrag && sameClipText(text, appDrag.plain)) insertSegments(appDrag.segs);
  else insertPlainText(text);
});

// ---------- Attachments: strip ----------
let attachSeq = 0;                      // render generation: stale decrypts must not paint
let decryptChain = Promise.resolve();   // FIFO, strictly one decrypt at a time

function renderAttachments() {
  const strip = $("attachments");
  const gen = ++attachSeq;              // invalidates every in-flight decrypt
  strip.innerHTML = "";
  const ctx = mediaCtx();
  const media = ctx && Array.isArray(ctx.note.media) ? ctx.note.media : [];
  if (!media.length) { strip.style.display = "none"; return; }
  strip.style.display = "flex";
  const tiles = media.map(m => {
    const t = makeTile(m, ctx.readOnly);
    strip.appendChild(t.el);
    return t;
  });
  // One key-only IDB read for the whole strip: no bytes are materialized, so
  // even video tiles learn they are missing without touching their payload.
  idbKeys().then(keys => {
    if (gen !== attachSeq) return;
    const have = new Set(keys);
    for (const t of tiles) {
      if (!isAllowedMediaType(t.meta.mime)) { t.setState("blocked"); continue; }
      if (!have.has(t.meta.id)) { t.setState("missing"); continue; }
      // Only images decrypt for a thumbnail (lazily, through the FIFO queue);
      // every other kind is a static tile that decrypts on click.
      const k = kindForMime(t.meta.mime);
      if (k === "image") queueThumb(gen, t);
      else t.setState(k);
    }
  }).catch(() => { if (gen === attachSeq) for (const t of tiles) t.setState("missing"); });
}

function queueThumb(gen, tile) {
  // Reuse a URL an inline occurrence (or a prior render) already decrypted, so a
  // note shown with both a strip tile and inline copies decrypts each id once.
  const cached = mediaUrls.get(tile.meta.id);
  if (cached) { tile.setImage(cached); return; }
  decryptChain = decryptChain.then(async () => {
    if (gen !== attachSeq || !vault) return;
    try {
      const rec = await idbGet(tile.meta.id);
      if (gen !== attachSeq || !vault) return;
      if (!rec) { tile.setState("missing"); return; }
      if (mediaUrls.get(tile.meta.id)) { tile.setImage(mediaUrls.get(tile.meta.id)); return; }
      const plain = await decryptMedia(tile.meta.id, rec.bytes);
      // !vault: otherwise this re-populates mediaUrls with a live plaintext blob:
      // URL after lockApp's revoke sweep, and it then outlives the lock.
      if (gen !== attachSeq || !vault) return;
      tile.setImage(getOrCreateMediaUrl(tile.meta.id, tile.meta.mime, plain));
    } catch {
      // Corrupted IDB record or tampered remote file: same fixed-size tile,
      // never an exception thrown out of the render path.
      if (gen === attachSeq) tile.setState("corrupt");
    }
  }).catch(() => {});
}

const TILE_NOTE = {
  pending: "decrypting", video: "video", pdf: "pdf", text: "text", file: "file",
  missing: "not on this device", corrupt: "corrupted", blocked: "unsupported type", image: "",
};
function makeTile(meta, readOnly) {
  const el = mk("div", "att");
  const ph = mk("div", "att-ph");
  el.appendChild(ph);
  const t = { el, meta, state: "pending" };
  const label = s => [meta.name || "attachment", fmtSize(meta.size), TILE_NOTE[s]].filter(Boolean).join(" - ");
  t.setState = s => {
    t.state = s;
    const img = el.querySelector("img");
    if (img) img.remove();
    ph.className = "att-ph" + (s === "missing" || s === "corrupt" ? " warn" : "");
    ph.style.display = "";
    ph.innerHTML = "";
    if (s === "video") {
      ph.appendChild(mk("div", "glyph", "▶"));
      ph.appendChild(mk("div", "nm", meta.name || "video"));
      ph.appendChild(mk("div", null, fmtSize(meta.size)));
    } else if (s === "pdf" || s === "text" || s === "file") {
      ph.appendChild(mk("div", "glyph", s === "pdf" ? "▤" : s === "text" ? "≡" : "⇓"));
      ph.appendChild(mk("div", "nm", meta.name || s));
      ph.appendChild(mk("div", null, fmtSize(meta.size)));
    } else if (s === "missing") {
      ph.appendChild(mk("div", "glyph", "↓"));
      ph.appendChild(mk("div", null, "Not on this device"));
      ph.appendChild(mk("div", null, "Sync to fetch"));
    } else if (s === "corrupt") {
      ph.appendChild(mk("div", "glyph", "!"));
      ph.appendChild(mk("div", null, "Attachment corrupted"));
    } else if (s === "blocked") {
      ph.appendChild(mk("div", "glyph", "!"));
      ph.appendChild(mk("div", null, "Unsupported type"));
    }
    el.title = label(s);
  };
  t.setImage = url => {
    t.state = "image";
    ph.style.display = "none";
    const img = mk("img");
    img.alt = meta.name || "";
    img.src = url;
    el.appendChild(img);
    el.title = label("image");
  };
  el.onclick = () => openAttachment(t);
  el.oncontextmenu = e => { e.preventDefault(); openMenu(e.clientX, e.clientY, attachmentMenu(t, readOnly)); };
  // Keyboard parity: the tiles already had a :focus-visible style they could
  // never reach, being plain divs.
  el.tabIndex = 0;
  el.onkeydown = e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAttachment(t); }
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      openMenu(r.left + 8, r.bottom - 8, attachmentMenu(t, readOnly));
    }
  };
  t.setState("pending");
  return t;
}

// Placeholder tiles never open the lightbox.
async function openAttachment(t) {
  if (t.state === "image") { openLightbox(t.meta, mediaUrls.get(t.meta.id), false); return; }
  if (t.state === "file") { downloadAttachment(t); return; }   // nothing renders a docx: save it
  if (t.state !== "video" && t.state !== "pdf" && t.state !== "text") return;
  // Generation guard, same as queueThumb: a big decrypt outlives a note switch,
  // and the lightbox must not pop open over a note the user already left.
  const gen = attachSeq;
  status("Decrypting " + (t.meta.name || t.state) + "...", false, true);
  const plain = await loadMedia(t);
  // !vault: the lock happened while this decrypt was in flight - without it the
  // lightbox paints decrypted plaintext full-screen over the lock screen.
  if (!plain || gen !== attachSeq || !vault) { status(""); return; }   // sticky message must not strand
  status("");
  // The video URL is owned by the lightbox and revoked when it closes; nothing
  // else holds it, because video tiles are never decrypted for a thumbnail.
  openLightbox(t.meta, mediaObjectUrl(t.meta.id, t.meta.mime, plain), true);
}

// Decrypt on demand, degrading a tile in place instead of throwing.
async function loadMedia(t) {
  try {
    const rec = await idbGet(t.meta.id);
    if (!vault) return null;   // locked mid-decrypt: drop it, do not touch the DOM
    if (!rec) { t.setState("missing"); status("Not on this device - Sync to fetch", true); return null; }
    const plain = await decryptMedia(t.meta.id, rec.bytes);
    return vault ? plain : null;
  } catch {
    // A lock nulls the keys, so a decrypt in flight fails HERE: reporting that
    // on the lock screen would leak that an attachment was being opened.
    if (!vault) return null;
    t.setState("corrupt");
    status("Attachment corrupted", true);
    return null;
  }
}

function downloadPlain(name, mime, plain) {
  if (!vault) return;   // locked while the decrypt was in flight: never write plaintext to disk
  const url = URL.createObjectURL(new Blob([plain], { type: mime || "application/octet-stream" }));
  // Tracked, so a lock/purge/note-switch can revoke it too: an untracked URL
  // outlived every teardown path and kept plaintext alive for its whole timeout.
  downloadUrls.add(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "attachment";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => revokeDownloadUrl(url), 10000);
}
async function downloadAttachment(t) {
  const plain = await loadMedia(t);
  if (!plain) return;
  downloadPlain(t.meta.name, t.meta.mime, plain);
}

function attachmentMenu(t, readOnly) {
  const items = [];
  if (t.state !== "missing" && t.state !== "corrupt" && t.state !== "blocked")
    items.push({ label: "Download", onClick: () => downloadAttachment(t) });
  if (t.state === "missing") {
    if (readOnly) items.push({ label: "Not on this device", disabled: true });
    else items.push({ label: "Sync this note", disabled: syncing,
      onClick: () => { flushSave(); if (currentId) window.syncNote(currentId); } });
  }
  if (!readOnly) {
    if (items.length) items.push({ sep: true });
    items.push({ label: "Remove", danger: true, disabled: syncing, onClick: () => removeAttachment(t.meta.id) });
  }
  if (!items.length) items.push({ label: "No actions", disabled: true });
  return items;
}

// Removes the metadata from the note; the encrypted bytes stay in IndexedDB
// until the tombstone is applied (the next sync DELETEs the remote copy and
// drops the local record), and only if nothing else still references them -
// conflict copies share media ids with their originals.
async function removeAttachment(mid) {
  if (syncing || trashViewId || !currentId) return;
  const noteId = currentId, n = vault.notes[noteId];
  if (!n) return;
  const meta = (n.media || []).find(m => m.id === mid);
  if (!meta) return;
  const ok = await confirmModal({
    title: "Remove attachment?",
    body: `"${meta.name || "attachment"}" will be removed from this note and, on the next sync, from the repo.`,
    confirmLabel: "Remove", destructive: true,
  });
  if (!ok || syncing || trashViewId || currentId !== noteId || !vault.notes[noteId]) return;
  flushSave();
  n.media = (n.media || []).filter(m => m.id !== mid);
  // Remove every inline occurrence too, BEFORE revoke: leave no inline <img> pointing
  // at a URL we are about to revoke, and clear the body reference so mediaReferenced
  // (now body-aware) lets the bytes be tombstoned. Re-serialize + rebaseline so the
  // stripped body is what saves, not the pre-removal one.
  const wraps = [...$("editor").querySelectorAll('span.inline-media[data-mid="' + mid + '"]')];
  if (wraps.length) {
    for (const w of wraps) w.remove();
    n.body = getEditorBody();
    n.bodyV = 2;
    editorPlainOrig = null;
    editorBaseline = n.body;
    updateEditorEmpty();
  }
  n.mtime = Date.now();
  if (lightbox && lightbox.mediaId === mid) closeLightbox();
  revokeMediaUrl(mid);
  if (!mediaReferenced(mid)) vault.purged[mid] = Date.now();
  persistLocal().catch(e => status("Save failed: " + e.message, true));
  renderList();
  renderStatus();
  renderAttachments();
  status("Attachment removed");
}

// ---------- Lightbox ----------
// (`lightbox` itself is declared with the media-URL registry above.)
window.isLightboxOpen = () => !!lightbox;
window.closeLightboxIfOpen = () => { if (!lightbox) return false; closeLightbox(); return true; };

function openLightbox(meta, url, revokeOnClose) {
  if (!url) return;
  closeLightbox();
  const back = mk("div", "lb-back");
  let video = null;
  if ((meta.mime || "").startsWith("video/")) {
    video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.src = url;
    back.appendChild(video);
  } else if (isPdfType(meta.mime)) {
    // The browser's own PDF viewer, boxed in an iframe on a blob: URL - the
    // document never becomes page content, same isolation story as videos.
    const frame = document.createElement("iframe");
    frame.className = "lb-pdf";
    frame.title = meta.name || "PDF";
    frame.src = url;
    back.appendChild(frame);
  } else if (isTextType(meta.mime)) {
    // textContent only: inert for ANY payload, even mislabeled markup.
    const pre = mk("pre", "lb-text");
    fetch(url).then(r => r.text()).then(t => { pre.textContent = t; }).catch(() => { pre.textContent = "(could not read)"; });
    back.appendChild(pre);
  } else {
    const img = mk("img");
    img.alt = meta.name || "";
    img.src = url;
    back.appendChild(img);
  }
  back.appendChild(mk("div", "lb-cap", [meta.name, fmtSize(meta.size)].filter(Boolean).join("  ")));
  // Click-away means the backdrop only, never the image or the video controls.
  back.onclick = e => { if (e.target === back) closeLightbox(); };
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add("show"));
  lightbox = { back, mediaId: meta.id, revokeOnClose: !!revokeOnClose, video };
}

function closeLightbox() {
  if (!lightbox) return;
  const lb = lightbox;
  lightbox = null;
  if (lb.video) {
    // Stop playback and detach the source before the URL dies.
    try { lb.video.pause(); lb.video.removeAttribute("src"); lb.video.load(); } catch {}
  }
  fadeOut(lb.back);
  if (lb.revokeOnClose) revokeMediaUrl(lb.mediaId);
}
