/*
 * lines.js - the line model of the editor, turning a page into a stored
 * body and back, the editing surfaces, inline attachments, and the sheets.
 *
 * Lines. The editor works in lines: every visual line of a note is a <div> of
 * its own, directly in the page or in a design frame. That is what lets
 * alignment, Enter and censoring act on exactly the line or paragraph the
 * caret is in. Stored bodies keep their old shape (plain lines joined by
 * "\n", a styled line as <div style>, tables, lists and frames as blocks), so
 * older copies of the app read them unchanged. normalizeLines turns that
 * shape, or whatever the browser produced while typing, into one <div> per
 * line, by the same rules the browser lays the markup out with under
 * white-space: pre-wrap, so nothing moves:
 *   - "\n" and <br> end a line, and an empty line between two breaks is a line;
 *   - a break at the end of a run adds no line ("a\n" is one line), while one
 *     at its start does ("<div>b</div>\nc" has an empty line between b and c);
 *   - a table, a list, a frame and a styled line sit on lines of their own,
 *     and a plain <div> just adds the lines it holds.
 * Formatting that spans a break (<b>a\nb</b>) is cloned onto each line, and a
 * table or list found inside a censored span takes the censoring down into
 * its own text, so restructuring can never uncensor anything.
 *
 * Saving. serializeBodyInto writes a page back as the stored string, through
 * the same allowlist the loader (history.js) uses, so serialize(sanitize(B))
 * is B. An inline attachment is written from its checked data-mid and
 * data-kind alone, never from what it shows, so no blob: or data: address
 * can ever reach the stored text.
 *
 * Surfaces. A one-page note is edited in #editor. A paged note is edited in
 * a stack of .sheet-body elements, one per page, all live at once.
 *
 * Decryption. An inline picture is decrypted (decryptMedia in vault.js) with
 * AES-256-GCM under the vault's attachment key, which is random, not made
 * from the password. It happens when a note is opened or its sheets drawn
 * (pictures only, one at a time in a queue), and when an inline video, PDF,
 * text or file is clicked. The cost grows with the size, about 3 ms per MB
 * (a 10 MB file took 31 ms in Chrome 156). Guessing the key means trying up
 * to 2^256 keys, which is out of reach; altered bytes fail GCM's check and
 * show as "Attachment unavailable".
 *
 * Main functions: normalizeLines, ensureLines, bodyFragment, canonicalBody,
 * lineOf, serializeBodyInto, activeSurface, surfaceOfNode, getEditorBody,
 * currentEditorRange, editorHasFocus, setEditorBody, buildInlineWrapper,
 * insertInlineWrapper, hydrateInlineMedia, hydrateOneInline,
 * queueInlineImage, openInlineMedia, applyInlineSize, scheduleInlineSave,
 * moveInlineNode, updateEditorEmpty, renderSheets, fitSheets, sheetsSnapshot.
 * Auxiliary functions: isLineTag, isFrameEl, isLineEl, isMediaEl, isFloatEl,
 * isSelMarker, isCensorEl, censorMark, uncensorMark, isBareMark, isStructEl,
 * isEmptyLine, isCleanLine, flattenRun, mergeStyle, buildLine, appendToLine,
 * censorizeAll, linesFromPieces, linesNeeded, keepSelection,
 * selectFromMarkers, snapToText, pagedView, surfaces, editorHasInlineMedia,
 * inlinePlaceholder, setInlineState, setInlineImage, surfaceAtPoint,
 * nodeBeforeCaret, nodeAfterCaret, wrapperOf, caretRangeAt.
 *
 * Complexity: putting a page into lines and saving it are both O(n) in its
 * nodes; showing its attachments is O(m) in them, plus one AES-GCM decrypt
 * per picture, O(size).
 */
"use strict";

// ---------- State ----------

// The piece that ends a line, when a run is flattened (see flattenRun).
const LINE_BREAK = { br: true };

// The largest box an inline picture gets before it is resized by hand.
const INLINE_MAX_W = 320;
const INLINE_MAX_H = 240;

// The type to open an inline attachment as when its own is unknown.
const KIND_FALLBACK_MIME = { video: "video/mp4", pdf: "application/pdf", text: "text/plain" };

// The attachment being dragged to a new place, and where in it it was picked
// up (so it lands under the pointer). Set by attachments.js; the drop handler
// needs the node itself, and a drag's data cannot be read until the drop.
let draggingInlineNode = null;
let dragGrab = null;

// ---------- Putting a page into lines ----------

/**
 * Puts a container (a page, a frame, a fragment about to become one) into
 * line form. Lines already in shape stay exactly as they are, keeping their
 * identity, so a live caret or a selected picture is not disturbed; only the
 * runs of anything else are rebuilt. Returns true when it changed something.
 *
 * Used by: this file (ensureLines, bodyFragment, canonicalBody,
 * linesFromPieces), history.js (frameBody), designs.js (stripCensoredForExport).
 * Uses: isCleanLine, isStructEl, isFloatEl, isFrameEl, flattenRun, linesFromPieces.
 * Complexity: O(n) in the container's nodes.
 */
function normalizeLines(container) {
  let changed = false;
  let run = [];
  const flush = () => {
    if (!run.length) {
      return;
    }
    const anchor = document.createComment("");
    container.insertBefore(anchor, run[0]);
    const pieces = [];
    flattenRun(run, [], pieces);
    const made = linesFromPieces(pieces);
    for (const node of made) {
      container.insertBefore(node, anchor);
    }
    // What is left of the run is husks: emptied wrappers and the text that was split.
    for (const node of run) {
      if (node.parentNode === container && !made.includes(node)) {
        node.remove();
      }
    }
    anchor.remove();
    run = [];
    changed = true;
  };

  for (const child of [...container.childNodes]) {
    if ((child.nodeType === 3 && !child.data) || child.nodeType === 8) {
      child.remove();
      changed = true;
      continue;
    }
    if (isCleanLine(child) || isStructEl(child) || isFloatEl(child)) {
      flush();
      continue;
    }
    if (isFrameEl(child)) {
      flush();
      if (normalizeLines(child)) {
        changed = true;
      }
      continue;
    }
    run.push(child);
  }
  flush();
  return changed;
}

/**
 * Makes sure a surface is in line form before something that works on lines,
 * keeping the selection where it was. Lines already in shape are left alone,
 * so this is cheap when nothing strayed (typing into an emptied page leaves
 * bare text the browser never wraps, for one). Returns whether it had to.
 *
 * Used by: this file (insertInlineWrapper), alignment.js (applyAlignment, and
 * Enter on load), censor.js (clearFormatting, insertSegments, toggleCensor),
 * attachments.js (insertPlainText), tables.js (insertTable).
 * Uses: linesNeeded, keepSelection, normalizeLines.
 * Complexity: O(n) in the surface's nodes.
 */
function ensureLines(surface) {
  if (!surface || !linesNeeded(surface)) {
    return false;
  }
  keepSelection(surface, () => normalizeLines(surface));
  return true;
}

/**
 * A stored body as page content: sanitised, attachment rows packed, in
 * lines. An old plain body only ever becomes text nodes. An empty page still
 * gets one empty line, so the first thing typed lands in a line like
 * everything after it (into a bare page the browser types text that belongs
 * to no line at all).
 *
 * Used by: this file (setEditorBody, renderSheets), content.js
 * (bodyPlainText), pdf.js (buildNotePdf, exportNotePdf), split.js (renderPrevPane).
 * Uses: sanitizeBodyFragment and packAttachmentRuns (history.js),
 * normalizeLines, buildLine.
 * Complexity: O(n) in the body.
 */
function bodyFragment(body, bodyV) {
  let fragment;
  if (bodyV === 2) {
    fragment = sanitizeBodyFragment(body || "");
  } else {
    fragment = document.createDocumentFragment();
    if (body) {
      fragment.appendChild(document.createTextNode(body));
    }
  }
  packAttachmentRuns(fragment);
  normalizeLines(fragment);
  if (!fragment.firstChild) {
    fragment.appendChild(buildLine([], ""));
  }
  return fragment;
}

/**
 * Puts a holder into lines and returns it as a stored body string, for code
 * that rewrites stored bodies.
 *
 * Used by: history.js (frameBody, resetNoteLayout, undesignPages), designs.js
 * (importDesignDoc, stripCensoredForExport).
 * Uses: normalizeLines, serializeBodyInto.
 * Complexity: O(n) in the holder's nodes.
 */
function canonicalBody(holder) {
  normalizeLines(holder);
  const output = { s: "" };
  serializeBodyInto(holder, output);
  return output.s;
}

/**
 * The line (a <div> directly in a page or a frame) holding a node, or null,
 * which is also the answer inside a table or a list.
 *
 * Used by: alignment.js (Enter, on load), censor.js (caretCensored,
 * clearFormatting, insertPlanAt, insertSegments, setCensorRange, and on
 * load), tables.js (insertTable).
 * Uses: isLineEl, isFrameEl, isStructEl.
 * Complexity: O(depth).
 */
function lineOf(node, surface) {
  for (let el = node && (node.nodeType === 1 ? node : node.parentNode); el && el !== surface; el = el.parentNode) {
    if (isLineEl(el) && el.parentNode && (el.parentNode === surface || isFrameEl(el.parentNode))) {
      return el;
    }
    if (isStructEl(el)) {
      return null;
    }
  }
  return null;
}

// ---------- Saving: the page as a stored string ----------

/**
 * Appends a node's content to output.s as the stored body: escaped text,
 * "\n" for a line break, and only the markup the allowlist keeps (styled
 * lines and frames, lists, tables, safe links, formatting, inline
 * attachments by id). A plain line collapses to a newline exactly as it
 * always did, so an unformatted note saves byte for byte as before.
 *
 * Two markers keep empty lines from appearing. output.at is where a line is
 * known to begin without a "\n": the start of a container (the note, a
 * frame, a list item, a cell) and the end of a block. Writing a "\n" there as
 * well once put an empty line after every centred line, frame or table each
 * time the note was opened, since under pre-wrap a newline right after a
 * block is an empty line of its own. output.pend means a plain line has just
 * ended: its "\n" is only written if more inline content follows directly (a
 * picture dropped after the last line, say), which would otherwise join the
 * line above it on the next load.
 *
 * Used by: this file (canonicalBody, getEditorBody).
 * Uses: escapeHtml and validInlineMedia (content.js), mediaLayout and
 * sanitizeStyle (history.js), safeHref, INLINE_FMT_TAGS, LIST_TAGS and
 * TABLE_TAGS (designs.js), EDITOR_BLOCK_TAGS (history.js).
 * Complexity: O(n) in the node's content.
 */
function serializeBodyInto(node, output) {
  if (output.at === undefined) {
    output.at = output.s.length;
  }
  const lineStart = () => output.s.length === output.at || output.s.endsWith("\n");
  const inline = () => {
    if (output.pend) {
      if (!lineStart()) {
        output.s += "\n";
      }
      output.pend = false;
    }
  };

  node.childNodes.forEach(child => {
    if (child.nodeType === 3) {
      if (!child.data) {
        return;
      }
      inline();
      output.s += escapeHtml(child.data);
    } else if (child.nodeType === 1) {
      const media = validInlineMedia(child);
      if (media || child.tagName === "BR" || child.tagName === "A" || INLINE_FMT_TAGS.has(child.tagName)) {
        inline();
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName) || LIST_TAGS.has(child.tagName) ||
        TABLE_TAGS.has(child.tagName)) {
        // A block writes its own line break.
        output.pend = false;
      }

      if (media) {
        const layout = mediaLayout(child);
        output.s += '<span class="inline-media" data-mid="' + media.mid + '" data-kind="' + media.kind + '"' +
          (layout.w ? ' data-w="' + layout.w + '"' : "") + (layout.align ? ' data-align="' + layout.align + '"' : "") +
          (layout.fx !== null ? ' data-fx="' + layout.fx + '" data-fy="' + layout.fy + '"' : "") + ">" +
          (media.kind === "video" ? "<video></video>" : "<img>") + "</span>";
      } else if (child.tagName === "BR") {
        output.s += "\n";
      } else if (child.classList && child.classList.contains("inline-media")) {
        // An inline-media span with an invalid id or kind cannot point at real bytes: it is dropped.
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName)) {
        // A block stays markup only when it carries allowed formatting or is a frame.
        const style = sanitizeStyle(child.getAttribute("style"));
        const frame = child.getAttribute && child.getAttribute("data-frame");
        if (frame === "top" || frame === "bottom" || style) {
          if (!lineStart()) {
            output.s += "\n";
          }
          output.s += "<div" + (frame === "top" || frame === "bottom" ? ' data-frame="' + frame + '"' : "") +
            (style ? ' style="' + style + '"' : "") + ">";
          output.at = output.s.length;
          serializeBodyInto(child, output);
          output.s += "</div>";
          output.at = output.s.length;
        } else {
          if (!lineStart()) {
            output.s += "\n";
          }
          serializeBodyInto(child, output);
          output.pend = true;
        }
      } else if (LIST_TAGS.has(child.tagName) || TABLE_TAGS.has(child.tagName)) {
        const tag = child.tagName.toLowerCase();
        const style = sanitizeStyle(child.getAttribute("style"));
        let attributes = style ? ' style="' + style + '"' : "";
        if (tag === "table") {
          const layout = mediaLayout(child);
          if (layout.fx !== null) {
            attributes += ' data-fx="' + layout.fx + '" data-fy="' + layout.fy + '"';
          }
          if (layout.w) {
            attributes += ' data-w="' + layout.w + '"';
          }
        }
        for (const attribute of ["colspan", "rowspan"]) {
          const value = parseInt(child.getAttribute(attribute) || "", 10);
          if (value > 1 && value <= 50) {
            attributes += ` ${attribute}="${value}"`;
          }
        }
        output.s += "<" + tag + attributes + ">";
        output.at = output.s.length;
        serializeBodyInto(child, output);
        output.s += "</" + tag + ">";
        output.at = output.s.length;
      } else if (child.tagName === "A") {
        const href = safeHref(child.getAttribute("href"));
        if (!href) {
          serializeBodyInto(child, output);
          return;
        }
        output.s += '<a href="' + escapeHtml(href).replace(/"/g, "&quot;") + '">';
        serializeBodyInto(child, output);
        output.s += "</a>";
      } else if (INLINE_FMT_TAGS.has(child.tagName)) {
        const tag = INLINE_FMT_TAGS.get(child.tagName);
        const style = sanitizeStyle(child.getAttribute("style"), true);
        const censored = child.getAttribute("data-censor") === "1";
        if (tag === "span" && !style && !censored) {
          serializeBodyInto(child, output);
          return;
        }
        output.s += "<" + tag + (censored ? ' data-censor="1"' : "") + (style ? ' style="' + style + '"' : "") + ">";
        serializeBodyInto(child, output);
        output.s += "</" + tag + ">";
      } else {
        serializeBodyInto(child, output);
      }
    }
  });
}

// ---------- Editing surfaces ----------

/**
 * The surface the caret is in; failing that, the focused one, the first one,
 * or #editor.
 *
 * Used by: this file (getEditorBody, insertInlineWrapper), attachments.js
 * (paste and drop, on load), media-layout.js (mediaLayoutMenu), tables.js
 * (insertTable, tableMenuItems).
 * Uses: surfaces.
 * Complexity: O(p) over the surfaces.
 */
function activeSurface() {
  const list = surfaces();
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    const node = selection.getRangeAt(0).commonAncestorContainer;
    const hit = list.find(el => el.contains(node));
    if (hit) {
      return hit;
    }
  }
  const focused = list.find(el => el === document.activeElement);
  return focused || list[0] || $("editor");
}

/**
 * The editing surface a node is in, or null.
 *
 * Used by: this file, alignment.js, attachments.js, censor.js, events.js,
 * format-menu.js, media-layout.js, pagination.js, tables.js and toolbar.js:
 * everything that must know whether something happened in the note's text.
 * Uses: surfaces.
 * Complexity: O(p * depth).
 */
function surfaceOfNode(node) {
  return surfaces().find(el => el.contains(node)) || null;
}

/**
 * A surface's content as a stored body (the active surface by default). A
 * surface that looks empty (a stray <br>, markup with no text) gives "", so
 * comparing with the last saved state stays stable.
 *
 * Used by: this file (setEditorBody, sheetsSnapshot), content.js (addPage,
 * deletePage, switchPage), pagination.js (saveCurrent, syncPagesFromDom),
 * history.js (historyApply, reloadNoteInPlace), attachments.js (addMedia,
 * removeAttachment).
 * Uses: activeSurface, serializeBodyInto.
 * Complexity: O(n) in the surface's content.
 */
function getEditorBody(el) {
  const editor = el || activeSurface();
  if (!editor.querySelector("span.inline-media") && editor.textContent === "") {
    return "";
  }
  const output = { s: "" };
  serializeBodyInto(editor, output);
  return output.s;
}

/**
 * A copy of the live caret or selection if it is in the note's text, else
 * null. It is a copy, so later changes cannot move it, and it is taken before
 * any await, so a paste lands where the caret really was.
 *
 * Used by: attachments.js (paste, on load), censor.js (on load), format-menu.js
 * (formatMenuItems), tables.js (currentCell), toolbar.js (rememberSelection,
 * restoreSelection, syncFormatState).
 * Uses: surfaceOfNode.
 * Complexity: O(p * depth).
 */
function currentEditorRange() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    if (surfaceOfNode(range.commonAncestorContainer)) {
      return range.cloneRange();
    }
  }
  return null;
}

/**
 * Whether the note's text has the focus: the target is in a surface, a
 * surface is focused, or the selection is in one.
 *
 * Used by: attachments.js (paste, on load), censor.js (copy, on load).
 * Uses: surfaces.
 * Complexity: O(p * depth).
 */
function editorHasFocus(target) {
  const list = surfaces();
  if (target && list.some(el => el.contains(target))) {
    return true;
  }
  if (list.includes(document.activeElement)) {
    return true;
  }
  const selection = window.getSelection();
  return !!(selection && selection.rangeCount &&
    list.some(el => el.contains(selection.getRangeAt(0).commonAncestorContainer)));
}

/**
 * Loads a body into #editor. An old plain body becomes text nodes only (as
 * inert as textContent); a v2 body is sanitised again, since a synced body
 * could have been tampered with, and its attachments are then shown. The
 * baseline is taken after the page is built, so just opening a note never
 * counts as an edit.
 *
 * Used by: content.js (addPage, deletePage, switchPage), pagination.js
 * (openNote, openTrash), history.js (reloadNoteInPlace), merge.js (applyMerge).
 * Uses: bodyFragment, hydrateInlineMedia, getEditorBody, updateEditorEmpty.
 * Complexity: O(n) in the body, plus the decrypts of its pictures.
 */
function setEditorBody(body, options) {
  options = options || {};
  const generation = ++editorSeq;
  const editor = $("editor");
  editor.replaceChildren(bodyFragment(body, options.bodyV));
  if (options.bodyV === 2) {
    editorPlainOrig = null;
    hydrateInlineMedia(generation);
  } else {
    editorPlainOrig = body || "";
  }
  editorBaseline = getEditorBody(editor);
  updateEditorEmpty();
}

/**
 * Shows or hides the "empty note" placeholder (a <div> has no placeholder
 * attribute of its own). It exists only on the one-page editor.
 *
 * Used by: this file (insertInlineWrapper, scheduleInlineSave,
 * setEditorBody), attachments.js (addMedia, removeAttachment), events.js
 * (typing, on load), media-layout.js (mediaLayoutMenu), pagination.js (clearEditor).
 * Uses: nothing.
 * Complexity: O(1).
 */
function updateEditorEmpty() {
  const editor = $("editor");
  editor.dataset.empty = (!editor.querySelector("span.inline-media") && editor.textContent === "") ? "true" : "false";
}

// ---------- Inline attachments ----------

/**
 * A new inline attachment wrapper for a media id, showing "Decrypting...".
 * It is atomic (the caret sits beside it, and Backspace or Delete remove it
 * whole) and can be dragged to another place (attachments.js handles that).
 *
 * Used by: attachments.js (addMedia), history.js (sanitizeBodyInto).
 * Uses: setInlineState.
 * Complexity: O(1).
 */
function buildInlineWrapper(mid, kind) {
  const span = document.createElement("span");
  span.className = "inline-media";
  span.setAttribute("data-mid", mid);
  span.setAttribute("data-kind", kind);
  span.contentEditable = "false";
  span.draggable = true;
  setInlineState(span, "pending");
  return span;
}

/**
 * Inserts a wrapper at a caret taken before the attachment was encrypted,
 * and puts the caret after it. If that caret is no longer in the editor (the
 * note was reopened meanwhile), it goes at the end, so a paste into a note
 * that did not exist yet still keeps its attachment. The target is whichever
 * surface the caret was in, a sheet for a paged note.
 *
 * Used by: attachments.js (addMedia).
 * Uses: surfaceOfNode, activeSurface, ensureLines, updateEditorEmpty.
 * Complexity: O(n) in the surface, to put it into lines.
 */
function insertInlineWrapper(wrapper, range) {
  const editor = (range && surfaceOfNode(range.commonAncestorContainer)) || activeSurface();
  let target;
  if (range && editor.contains(range.commonAncestorContainer)) {
    target = range.cloneRange();
    target.collapse(false);
  } else {
    target = document.createRange();
    target.selectNodeContents(editor);
    target.collapse(false);
  }
  target.insertNode(wrapper);
  const after = document.createRange();
  after.setStartAfter(wrapper);
  after.collapse(true);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(after);
  }
  // Dropped past the last line, it would sit in no line at all: it gets one.
  ensureLines(editor);
  updateEditorEmpty();
}

/**
 * Shows every inline attachment under root (#editor by default). Each one
 * gets its final size at once, so the page does not jump when a picture
 * arrives. One that is not on this device shows "Not on this device - Sync".
 * A picture is queued for decrypting; any other kind is a tile that
 * decrypts when clicked. generation guards the work: opening another note
 * cancels it, and a wrapper no longer on the page is skipped, so a slow
 * decrypt can never paint into the wrong note.
 *
 * Used by: this file (setEditorBody, renderSheets).
 * Uses: mediaCtx (attachments.js), idbKeys and isAllowedMediaType (vault.js),
 * applyInlineSize, setInlineState, openInlineMedia, queueInlineImage,
 * scheduleRepaginate (pagination.js).
 * Complexity: O(m) in the attachments, plus one AES-GCM decrypt per picture.
 */
function hydrateInlineMedia(generation, root) {
  const editor = root || $("editor");
  const wrappers = [...editor.querySelectorAll("span.inline-media")];
  if (!wrappers.length) {
    return;
  }
  const context = mediaCtx();
  const metaFor = mid => ((context && context.note && context.note.media) || []).find(item => item.id === mid) || null;
  idbKeys().then(keys => {
    if (generation !== editorSeq) {
      return;
    }
    const have = new Set(keys);
    for (const wrapper of wrappers) {
      if (generation !== editorSeq || !wrapper.isConnected) {
        continue;
      }
      const mid = wrapper.getAttribute("data-mid");
      const kind = wrapper.getAttribute("data-kind");
      const meta = metaFor(mid);
      if (meta) {
        applyInlineSize(wrapper, meta.w, meta.h);
      }
      if (!have.has(mid)) {
        setInlineState(wrapper, "missing");
        continue;
      }
      if (kind !== "image") {
        setInlineState(wrapper, kind);
        wrapper.onclick = () => openInlineMedia(wrapper, mid, meta, kind);
        continue;
      }
      // An id the note's media list does not have (a damaged or hand-edited
      // note) shows the missing tile rather than guessing a type for its bytes.
      if (!meta) {
        setInlineState(wrapper, "missing");
        continue;
      }
      if (!isAllowedMediaType(meta.mime)) {
        setInlineState(wrapper, "blocked");
        continue;
      }
      queueInlineImage(generation, wrapper, mid, meta.mime, meta);
    }
    // Every wrapper's size is settled here, tiles included (only a picture
    // has a load event), so the pages are measured again.
    scheduleRepaginate();
  }).catch(() => {
    if (generation === editorSeq) {
      for (const wrapper of wrappers) {
        if (wrapper.isConnected) {
          setInlineState(wrapper, "missing");
        }
      }
    }
  });
}

/**
 * Shows one wrapper again (its bytes just arrived, or it was moved), the same
 * way and behind the same guard as hydrateInlineMedia.
 *
 * Used by: attachments.js (addMedia).
 * Uses: mediaCtx (attachments.js), applyInlineSize, setInlineState,
 * openInlineMedia, isAllowedMediaType (vault.js), queueInlineImage.
 * Complexity: O(k) over the note's attachments, plus one decrypt for a picture.
 */
function hydrateOneInline(span) {
  if (!span || !span.isConnected) {
    return;
  }
  const generation = editorSeq;
  const mid = span.getAttribute("data-mid");
  const kind = span.getAttribute("data-kind");
  if (!mid) {
    return;
  }
  const context = mediaCtx();
  const meta = ((context && context.note && context.note.media) || []).find(item => item.id === mid) || null;
  if (meta) {
    applyInlineSize(span, meta.w, meta.h);
  }
  if (kind !== "image") {
    setInlineState(span, kind);
    span.onclick = () => openInlineMedia(span, mid, meta, kind);
    return;
  }
  const mime = meta ? meta.mime : "image/*";
  if (!isAllowedMediaType(mime)) {
    setInlineState(span, "blocked");
    return;
  }
  queueInlineImage(generation, span, mid, mime, meta);
}

/**
 * Decrypts an inline picture and shows it, in the same queue (one decrypt at
 * a time) and with the same address map as the attachment strip, so a
 * picture already decrypted is shown at once. The encrypted bytes come from
 * IndexedDB and are decrypted with AES-256-GCM (decryptMedia, vault.js),
 * about 3 ms per MB. Bytes that fail to decrypt show "Attachment
 * unavailable". Each step checks again that this note is still the one open,
 * the wrapper is still on the page and the vault is still unlocked.
 *
 * Used by: this file (hydrateInlineMedia, hydrateOneInline), split.js (hydratePrevMedia).
 * Uses: decryptChain (attachments.js), mediaUrls, idbGet, decryptMedia and
 * getOrCreateMediaUrl (vault.js), setInlineImage, setInlineState.
 * Complexity: O(size) of the attachment, for the decrypt.
 */
function queueInlineImage(generation, span, mid, mime, meta) {
  decryptChain = decryptChain.then(async () => {
    if (generation !== editorSeq || !span.isConnected || !vault) {
      return;
    }
    const cached = mediaUrls.get(mid);
    if (cached) {
      setInlineImage(span, cached, meta);
      return;
    }
    try {
      const record = await idbGet(mid);
      if (generation !== editorSeq || !span.isConnected || !vault) {
        return;
      }
      if (!record) {
        setInlineState(span, "missing");
        return;
      }
      if (mediaUrls.get(mid)) {
        setInlineImage(span, mediaUrls.get(mid), meta);
        return;
      }
      const plain = await decryptMedia(mid, record.bytes);
      if (generation !== editorSeq || !span.isConnected || !vault) {
        return;
      }
      setInlineImage(span, getOrCreateMediaUrl(mid, mime, plain), meta);
    } catch {
      if (generation === editorSeq && span.isConnected) {
        setInlineState(span, "corrupt");
      }
    }
  }).catch(() => {});
}

/**
 * Opens an inline video, PDF, text or file when it is clicked. Like the
 * strip's tiles, these are never decrypted for a preview: the click decrypts
 * the bytes (AES-256-GCM, about 3 ms per MB) and either opens the lightbox,
 * which owns and later revokes that address, or hands a file straight to a
 * download. Nothing opens if another note was opened, or the app was locked,
 * while it decrypted.
 *
 * Used by: this file (hydrateInlineMedia, hydrateOneInline), split.js (hydratePrevMedia).
 * Uses: status (pagination.js), idbGet, decryptMedia and mediaObjectUrl
 * (vault.js), setInlineState, downloadPlain and openLightbox (attachments.js).
 * Complexity: O(size) of the attachment.
 */
async function openInlineMedia(span, mid, meta, kind) {
  const generation = editorSeq;
  const name = (meta && meta.name) || kind;
  status("Decrypting " + name + "...", false, true);
  let record = null;
  try {
    record = await idbGet(mid);
  } catch {
    record = null;
  }
  if (generation !== editorSeq || !vault) {
    status("");
    return;
  }
  if (!record) {
    setInlineState(span, "missing");
    status("Not on this device - Sync to fetch", true);
    return;
  }

  let plain;
  try {
    plain = await decryptMedia(mid, record.bytes);
  } catch {
    if (vault) {
      setInlineState(span, "corrupt");
      status("Attachment corrupted", true);
    }
    return;
  }
  if (generation !== editorSeq || !vault) {
    status("");
    return;
  }
  status("");
  const mime = (meta && meta.mime) || KIND_FALLBACK_MIME[kind] || "application/octet-stream";
  if (kind === "file") {
    downloadPlain(name, mime, plain);
    return;
  }
  openLightbox(meta || { id: mid, mime, name }, mediaObjectUrl(mid, mime, plain), true);
}

/**
 * Gives a wrapper its final box before its picture arrives (at most 320x240,
 * keeping the shape), so the picture paints in place instead of growing out
 * of a small tile and pushing the rest of the note down. A size chosen by
 * hand wins; its height is still reserved through the aspect ratio, or the
 * first page measurement would see a page about to double in height. Does
 * nothing when the size is unknown.
 *
 * Used by: this file (hydrateInlineMedia, hydrateOneInline), attachments.js
 * (addMedia), pdf.js (buildNotePdf), split.js (hydratePrevMedia).
 * Uses: mediaLayout and applyMediaLayout (history.js).
 * Complexity: O(1).
 */
function applyInlineSize(span, width, height) {
  if (mediaLayout(span).w) {
    applyMediaLayout(span);
    if (+width > 0 && +height > 0) {
      span.style.aspectRatio = (+width) + " / " + (+height);
    }
    return;
  }
  width = +width;
  height = +height;
  if (!(width > 0) || !(height > 0)) {
    span.style.width = span.style.height = "";
    return;
  }
  const scale = Math.min(1, INLINE_MAX_W / width, INLINE_MAX_H / height);
  span.style.width = Math.round(width * scale) + "px";
  span.style.height = Math.round(height * scale) + "px";
}

/**
 * Saves a change to the text that fires no input event (an attachment
 * deleted or moved). It waits like typing does, so a burst of moves becomes
 * one save, and the unsaved flag guards closing the tab until it lands.
 *
 * Used by: this file (moveInlineNode), events.js (Backspace and Delete, on load).
 * Uses: status, renderStatus, saveCurrent and scheduleRepaginate
 * (pagination.js), updateEditorEmpty, renderList (sidebar.js), saveTimer (events.js).
 * Complexity: O(1), plus redrawing the list.
 */
function scheduleInlineSave() {
  if (trashViewId || !currentId) {
    return;
  }
  if (statusIsError) {
    status("");
  }
  updateEditorEmpty();
  if (!unsavedEdits) {
    unsavedEdits = true;
    renderList();
  }
  // In split view saving is explicit, as it is for typing.
  if (!splitMode) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 400);
  }
  // A page that lost a picture may take lines back from the next one.
  scheduleRepaginate();
  renderStatus();
}

/**
 * Moves an inline attachment to the caret under (x, y), on any page of the
 * note. The same node is moved: nothing is encrypted again and nothing from
 * outside enters the editor. It is never dropped into itself.
 *
 * Used by: nothing at the moment (pictures are moved by the attachments script's own
 * drop handler).
 * Uses: surfaceOfNode, caretRangeAt, scheduleInlineSave.
 * Complexity: O(p * depth).
 */
function moveInlineNode(node, x, y) {
  if (!node || !surfaceOfNode(node)) {
    return;
  }
  const range = caretRangeAt(x, y);
  if (!range || !surfaceOfNode(range.commonAncestorContainer)) {
    return;
  }
  if (node.contains(range.startContainer) || node === range.startContainer) {
    return;
  }
  node.remove();
  range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(after);
  }
  scheduleInlineSave();
}

// ---------- Sheets ----------

/**
 * Builds the stack of A4 sheets for a paged note, every page editable at
 * once, so scrolling through them is the same document that is exported.
 * Read-only in the trash, in a backup and during a sync. A page stored longer
 * than a sheet is split once the sheets are really laid out (measuring
 * earlier finds a half-built page and nothing to split), so what is on screen
 * is what the PDF prints. A one-body note leaves the sheet view.
 *
 * Used by: content.js (addPage, deletePage, makePagedAndShow, movePage,
 * setPageSection), pagination.js (openNote, openTrash), history.js
 * (reloadNoteInPlace), merge.js (applyMerge).
 * Uses: viewedNote, notePages, hasSections, pageSection and renderPageTabs
 * (content.js), makeElement (sidebar.js), bodyFragment, hydrateInlineMedia,
 * sheetsSnapshot, fitSheets, pagedView, repaginateDom and syncPagesFromDom
 * (pagination.js).
 * Complexity: O(n) over all the pages' content.
 */
function renderSheets() {
  const note = viewedNote();
  const pages = notePages(note);
  const box = $("sheets");
  if (!pages) {
    document.body.classList.remove("paged-view");
    box.innerHTML = "";
    return;
  }
  const generation = ++editorSeq;
  document.body.classList.add("paged-view");
  box.innerHTML = "";
  const readOnly = !!trashViewId || !!backupView || syncing;
  const sectioned = hasSections(note);

  pages.forEach((page, i) => {
    const section = pageSection(page);
    const sheet = makeElement("div", "sheet sec-" + section + (i === currentPage ? " active" : ""));
    sheet.dataset.page = String(i);
    // Its identity, kept while data-page is renumbered.
    sheet.dataset.src = String(i);
    // A page the reflow made, and may take back.
    if (page.cont) {
      sheet.dataset.cont = "1";
    }
    const label = makeElement("div", "sheet-label");
    if (sectioned) {
      label.appendChild(makeElement("span", "sec-chip sec-" + section, SECTION_LABEL[section]));
    }
    label.appendChild(makeElement("span", "nm", page.name || "Page " + (i + 1)));
    label.appendChild(makeElement("span", "n", (i + 1) + " / " + pages.length));
    const bodyEl = makeElement("div", "sheet-body");
    bodyEl.contentEditable = readOnly ? "false" : "true";
    bodyEl.spellcheck = true;
    bodyEl.dataset.page = String(i);
    bodyEl.replaceChildren(bodyFragment(page.body, page.bodyV));
    sheet.appendChild(label);
    sheet.appendChild(bodyEl);
    box.appendChild(sheet);
  });

  // Pages are always saved as HTML.
  editorPlainOrig = null;
  hydrateInlineMedia(generation, box);
  editorBaseline = sheetsSnapshot();
  fitSheets();
  setTimeout(() => {
    if (!pagedView()) {
      return;
    }
    if (repaginateDom()) {
      syncPagesFromDom();
      renderPageTabs();
      editorBaseline = sheetsSnapshot();
    }
    // Pages may have been added or removed.
    fitSheets();
  }, 60);
}

/**
 * Shows the A4 sheets at whatever size the pane allows. A sheet's layout
 * stays 210 mm wide, since the page on screen must be the page that prints,
 * so this only scales what is painted, and takes back the space the scale
 * frees with negative margins so the stack still scrolls naturally.
 *
 * Used by: this file (renderSheets, and on resize), pagination.js
 * (repaginate), split.js (enterSplit, exitSplit).
 * Uses: nothing.
 * Complexity: O(p) in the sheets.
 */
function fitSheets() {
  const box = $("sheets");
  if (!box || !document.body.classList.contains("paged-view")) {
    return;
  }
  const sheets = [...box.querySelectorAll(".sheet")];
  if (!sheets.length) {
    return;
  }
  // 16px clear on either side.
  const available = box.clientWidth - 32;
  const natural = sheets[0].offsetWidth || 1;
  const scale = Math.min(1, available / natural);
  box.style.setProperty("--sheet-k", scale.toFixed(4));
  for (const sheet of sheets) {
    const height = sheet.offsetHeight;
    // scale() leaves the layout box full size: the leftover is pulled back.
    sheet.style.marginBottom = (20 - height * (1 - scale)) + "px";
    sheet.style.marginLeft = 16 + Math.max(0, (available - natural * scale) / 2) + "px";
    sheet.style.marginRight = (-natural * (1 - scale)) + "px";
  }
}

/**
 * Every page as one string, so "has it changed?" works for sheets exactly as
 * for a single body, without a baseline per sheet.
 *
 * Used by: this file (renderSheets), pagination.js (saveCurrent), history.js
 * (reloadNoteInPlace), merge.js (applyMerge), attachments.js (addMedia).
 * Uses: surfaces, getEditorBody.
 * Complexity: O(n) over all the pages' content.
 */
function sheetsSnapshot() {
  return JSON.stringify(surfaces().map(el => getEditorBody(el)));
}

// ---------- On load: the sheets follow the window's size ----------

addEventListener("resize", () => fitSheets());

// =================== Auxiliary functions ===================

/** Whether a tag name is a line's (DIV or P). Also used by censor.js. Complexity: O(1). */
function isLineTag(tagName) {
  return tagName === "DIV" || tagName === "P";
}

/** Whether a node is a design frame: a line tag marked data-frame top or bottom. Complexity: O(1). */
function isFrameEl(node) {
  return !!node && node.nodeType === 1 && isLineTag(node.tagName) &&
    (node.getAttribute("data-frame") === "top" || node.getAttribute("data-frame") === "bottom");
}

/** Whether a node is a line: a DIV or P that is not a frame. Complexity: O(1). */
function isLineEl(node) {
  return !!node && node.nodeType === 1 && isLineTag(node.tagName) && !isFrameEl(node);
}

/** Whether a node is an inline attachment wrapper. Complexity: O(1). */
function isMediaEl(node) {
  return !!node && node.nodeType === 1 && !!node.classList && node.classList.contains("inline-media");
}

/** Whether a node is pinned: a picture or table at its own spot, out of the text flow. Complexity: O(1). */
function isFloatEl(node) {
  return !!node && node.nodeType === 1 && !!node.classList && node.classList.contains("floating");
}

/** Whether a node is one of the two markers keepSelection parks the selection on. Complexity: O(1). */
function isSelMarker(node) {
  return !!node && node.nodeType === 1 && node.hasAttribute("data-sel");
}

/** Whether a node is a censor mark. Complexity: O(1). */
function isCensorEl(node) {
  return !!node && node.nodeType === 1 && node.getAttribute("data-censor") === "1";
}

/**
 * Makes an element a censor mark. Spell-checking is off inside it: squiggles
 * under a bar would show where its words end and which are misspelt
 * (spellcheck lives on the page only; it is never saved). Complexity: O(1).
 */
function censorMark(el) {
  el.setAttribute("data-censor", "1");
  el.setAttribute("spellcheck", "false");
  return el;
}

/** Makes a censor mark an ordinary element again. Used by censor.js. Complexity: O(1). */
function uncensorMark(el) {
  el.removeAttribute("data-censor");
  el.removeAttribute("spellcheck");
}

/** Whether a node is a censor mark carrying nothing else, so it can merge with a neighbour. Complexity: O(a). */
function isBareMark(node) {
  return !!node && node.nodeType === 1 && node.tagName === "SPAN" && isCensorEl(node) &&
    [...node.attributes].every(attribute => attribute.name === "data-censor" || attribute.name === "spellcheck");
}

/** Whether a node is structure that stays whole (a table or list part), never split into lines. Complexity: O(1). */
function isStructEl(node) {
  return !!node && node.nodeType === 1 && /^(TABLE|UL|OL|LI|THEAD|TBODY|TFOOT|TR|TD|TH)$/.test(node.tagName);
}

/** Whether a line has nothing typed on it: no attachment and no visible character. Complexity: O(n). */
function isEmptyLine(el) {
  return !el.querySelector(".inline-media") && !/[^\s\u200b]/.test(el.textContent || "");
}

/**
 * Whether a line is already in shape: no block inside it, no "\n", and no
 * <br> except one placeholder at its very end (which gives an empty line its
 * height). Complexity: O(n) in the line's nodes.
 */
function isCleanLine(el) {
  if (!isLineEl(el)) {
    return false;
  }
  let breaks = 0;
  let last = null;
  let ok = true;
  (function scan(node) {
    for (const child of node.childNodes) {
      if (!ok) {
        return;
      }
      if (child.nodeType === 3) {
        if (child.data.includes("\n")) {
          ok = false;
        } else if (child.data) {
          last = child;
        }
      } else if (child.nodeType === 1) {
        if (isMediaEl(child)) {
          if (isFloatEl(child)) {
            ok = false;
          } else {
            last = child;
          }
        } else if (child.tagName === "BR") {
          breaks++;
          last = child;
        } else if (isLineTag(child.tagName) || isStructEl(child)) {
          ok = false;
        } else if (!isSelMarker(child)) {
          scan(child);
        }
      }
    }
  })(el);
  return ok && (breaks === 0 || (breaks === 1 && !!last && last.tagName === "BR"));
}

/**
 * Flattens a run of nodes into pieces: { leaf, chain } for text, attachments
 * and markers (chain is the inline elements around it, outermost first),
 * LINE_BREAK, { open: style } and { close } around a plain <div>'s own lines,
 * { block } for structure that stays whole and { float } for pinned items.
 * Complexity: O(n) in the run's nodes.
 */
function flattenRun(nodes, chain, out) {
  for (const child of nodes) {
    if (child.nodeType === 3) {
      if (!child.data) {
        continue;
      }
      if (!child.data.includes("\n")) {
        out.push({ leaf: child, chain });
        continue;
      }
      child.data.split("\n").forEach((part, i) => {
        if (i) {
          out.push(LINE_BREAK);
        }
        if (part) {
          out.push({ leaf: document.createTextNode(part), chain });
        }
      });
    } else if (child.nodeType === 1) {
      if (child.tagName === "BR") {
        out.push(LINE_BREAK);
      } else if (isSelMarker(child)) {
        out.push({ leaf: child, chain, marker: true });
      } else if (isFloatEl(child)) {
        out.push({ float: child });
      } else if (isMediaEl(child)) {
        out.push({ leaf: child, chain });
      } else if (isFrameEl(child) || isStructEl(child)) {
        out.push({ block: child, chain });
      } else if (isLineTag(child.tagName)) {
        out.push({ open: child.getAttribute("style") || "" });
        flattenRun([...child.childNodes], chain, out);
        out.push({ close: true });
      } else {
        flattenRun([...child.childNodes], [...chain, child], out);
      }
    }
  }
}

/** The declarations of two style strings together, the inner one winning. Complexity: O(d) in the declarations. */
function mergeStyle(outer, inner) {
  if (!outer) {
    return inner || "";
  }
  if (!inner) {
    return outer;
  }
  const declarations = new Map();
  for (const style of [outer, inner]) {
    for (const declaration of style.split(";")) {
      const i = declaration.indexOf(":");
      if (i > 0) {
        declarations.set(declaration.slice(0, i).trim().toLowerCase(), declaration.slice(i + 1).trim());
      }
    }
  }
  return [...declarations].map(([property, value]) => property + ":" + value).join(";");
}

/**
 * One line <div> from its pieces, re-creating the inline formatting around
 * each piece, shared between neighbours, so "<b>ab</b>" stays one <b>. A
 * line with nothing but a caret marker gets a <br> to give it height.
 * Complexity: O(k * depth) in the pieces.
 */
function buildLine(pieces, style) {
  const div = document.createElement("div");
  if (style) {
    div.setAttribute("style", style);
  }
  // { orig, el }: the clones of the formatting chain open at this point.
  const open = [];
  for (const piece of pieces) {
    let k = 0;
    while (k < open.length && k < piece.chain.length && open[k].orig === piece.chain[k]) {
      k++;
    }
    open.length = k;
    let parent = k ? open[k - 1].el : div;
    // A caret marker never opens formatting of its own: that would leave an
    // empty <b></b> behind once the marker is gone.
    if (!piece.marker) {
      for (let j = k; j < piece.chain.length; j++) {
        const clone = piece.chain[j].cloneNode(false);
        parent.appendChild(clone);
        open.push({ orig: piece.chain[j], el: clone });
        parent = clone;
      }
    }
    parent.appendChild(piece.leaf);
  }
  if (!pieces.some(piece => !piece.marker)) {
    div.appendChild(document.createElement("br"));
  }
  return div;
}

/** Adds pieces to the end of a line, before its placeholder <br> if it has one. Complexity: O(k). */
function appendToLine(line, pieces) {
  const endBreak = line.lastChild && line.lastChild.nodeType === 1 && line.lastChild.tagName === "BR"
    ? line.lastChild : null;
  for (const piece of pieces) {
    line.insertBefore(piece.leaf, endBreak);
  }
}

/**
 * Wraps every piece of text and every attachment under root in a censor
 * mark, for structure lifted out of a censored span. Complexity: O(n).
 */
function censorizeAll(root) {
  const atoms = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.data && !/^(TABLE|THEAD|TBODY|TFOOT|TR|UL|OL)$/.test(node.tagName)) {
          atoms.push(child);
        }
      } else if (child.nodeType === 1 && !isCensorEl(child)) {
        if (isMediaEl(child)) {
          if (!isFloatEl(child)) {
            atoms.push(child);
          }
        } else {
          walk(child);
        }
      }
    }
  })(root);
  for (const atom of atoms) {
    const mark = censorMark(document.createElement("span"));
    atom.parentNode.insertBefore(mark, atom);
    mark.appendChild(atom);
  }
}

/**
 * Builds the lines (and the blocks and pinned items between them) from a
 * flattened run. A caret marker alone at the end of a run goes at the end of
 * the line before, not on a line of its own that the layout does not have.
 * Complexity: O(k * depth) in the pieces.
 */
function linesFromPieces(pieces) {
  const made = [];
  const styles = [""];
  let segment = [];
  let carry = [];
  const lastLine = () => {
    for (let i = made.length - 1; i >= 0; i--) {
      if (isLineEl(made[i])) {
        return made[i];
      }
    }
    return null;
  };
  const end = byBreak => {
    const run = carry.length ? carry.concat(segment) : segment;
    carry = [];
    segment = [];
    if (byBreak || run.some(piece => !piece.marker)) {
      made.push(buildLine(run, styles[styles.length - 1]));
    } else if (run.length) {
      const line = lastLine();
      if (line) {
        appendToLine(line, run);
      } else {
        carry = run;
      }
    }
  };

  for (const piece of pieces) {
    if (piece === LINE_BREAK) {
      end(true);
    } else if (piece.open !== undefined) {
      end(false);
      styles.push(mergeStyle(styles[styles.length - 1], piece.open));
    } else if (piece.close) {
      end(false);
      styles.pop();
    } else if (piece.float) {
      made.push(piece.float);
    } else if (piece.block) {
      end(false);
      if (piece.chain.some(isCensorEl)) {
        censorizeAll(piece.block);
      }
      if (isFrameEl(piece.block)) {
        normalizeLines(piece.block);
      }
      made.push(piece.block);
    } else {
      segment.push(piece);
    }
  }
  end(false);
  if (carry.length) {
    const line = lastLine();
    if (line) {
      appendToLine(line, carry);
    } else {
      made.push(buildLine(carry, ""));
    }
  }
  return made;
}

/** Whether anything under a container is not yet in line form. Complexity: O(n). */
function linesNeeded(container) {
  for (const child of container.childNodes) {
    if (isFrameEl(child)) {
      if (linesNeeded(child)) {
        return true;
      }
      continue;
    }
    if (!(isCleanLine(child) || isStructEl(child) || isFloatEl(child))) {
      return true;
    }
  }
  return false;
}

/**
 * Runs fn, which may rebuild the page under root, and puts the selection back
 * on the same characters afterwards. The selection rides along on two marker
 * elements, since moving nodes around would otherwise reset it. Complexity:
 * O(1) besides fn.
 */
function keepSelection(root, fn) {
  const selection = window.getSelection();
  let startMarker = null;
  let endMarker = null;
  if (selection && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    if (root.contains(range.startContainer) && root.contains(range.endContainer)) {
      const mark = () => {
        const marker = document.createElement("span");
        marker.setAttribute("data-sel", "");
        return marker;
      };
      if (!range.collapsed) {
        endMarker = mark();
        const endRange = range.cloneRange();
        endRange.collapse(false);
        endRange.insertNode(endMarker);
      }
      startMarker = mark();
      const startRange = range.cloneRange();
      startRange.collapse(true);
      startRange.insertNode(startMarker);
    }
  }
  try {
    return fn();
  } finally {
    if (startMarker) {
      selectFromMarkers(startMarker, endMarker);
    }
  }
}

/**
 * Selects from the start marker to the end marker (or puts the caret at the
 * start one), removes both and joins back the text they split. Complexity: O(c)
 * in the children of their parents.
 */
function selectFromMarkers(startMarker, endMarker) {
  if (!startMarker.isConnected) {
    startMarker.remove();
    if (endMarker) {
      endMarker.remove();
    }
    return;
  }
  const range = document.createRange();
  range.setStartBefore(startMarker);
  if (endMarker && endMarker.isConnected) {
    range.setEndBefore(endMarker);
  } else {
    range.collapse(true);
  }
  const parents = new Set([startMarker.parentNode, endMarker && endMarker.parentNode]);
  startMarker.remove();
  if (endMarker) {
    endMarker.remove();
  }
  // The range is live, so it follows the text being joined.
  for (const parent of parents) {
    if (parent && parent.isConnected) {
      parent.normalize();
    }
  }
  snapToText(range);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Moves a range's ends from between nodes into the text beside them, where a typing caret lives. Complexity: O(1). */
function snapToText(range) {
  const snap = (node, offset) => {
    if (node.nodeType !== 1) {
      return [node, offset];
    }
    const before = node.childNodes[offset - 1];
    const after = node.childNodes[offset];
    if (before && before.nodeType === 3) {
      return [before, before.data.length];
    }
    if (after && after.nodeType === 3) {
      return [after, 0];
    }
    return [node, offset];
  };
  const [startNode, startOffset] = snap(range.startContainer, range.startOffset);
  if (range.collapsed) {
    range.setStart(startNode, startOffset);
    range.collapse(true);
    return;
  }
  const [endNode, endOffset] = snap(range.endContainer, range.endOffset);
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
}

/** Whether the note is shown as sheets. Also used by other files. Complexity: O(1). */
function pagedView() {
  return document.body.classList.contains("paged-view");
}

/** The editing surfaces: every sheet's body, or #editor. Complexity: O(p). */
function surfaces() {
  return pagedView() ? [...$("sheets").querySelectorAll(".sheet-body")] : [$("editor")];
}

/** Whether #editor holds an inline attachment. Used by pagination.js. Complexity: O(n). */
function editorHasInlineMedia() {
  return !!$("editor").querySelector("span.inline-media");
}

/**
 * What a wrapper shows while its picture decrypts, or instead of it: a tile
 * for a video, PDF, text or file, or a notice (not on this device,
 * unavailable, unsupported). It never touches data-mid or data-kind, so the
 * reference is still saved. Complexity: O(1).
 */
function inlinePlaceholder(state) {
  const box = makeElement("span", "inline-ph" + (state === "missing" || state === "corrupt" ? " warn" : ""));
  if (state === "video") {
    box.appendChild(makeElement("span", "inline-glyph", "▶"));
    box.appendChild(makeElement("span", null, "Play video"));
  } else if (state === "pdf") {
    box.appendChild(makeElement("span", "inline-glyph", "▤"));
    box.appendChild(makeElement("span", null, "Open PDF"));
  } else if (state === "text") {
    box.appendChild(makeElement("span", "inline-glyph", "≡"));
    box.appendChild(makeElement("span", null, "View text"));
  } else if (state === "file") {
    box.appendChild(makeElement("span", "inline-glyph", "⇓"));
    box.appendChild(makeElement("span", null, "Download file"));
  } else if (state === "missing") {
    box.appendChild(makeElement("span", "inline-glyph", "↓"));
    box.appendChild(makeElement("span", null, "Not on this device - Sync"));
  } else if (state === "corrupt") {
    box.appendChild(makeElement("span", "inline-glyph", "!"));
    box.appendChild(makeElement("span", null, "Attachment unavailable"));
  } else if (state === "blocked") {
    box.appendChild(makeElement("span", "inline-glyph", "!"));
    box.appendChild(makeElement("span", null, "Unsupported type"));
  } else {
    box.appendChild(makeElement("span", null, "Decrypting..."));
  }
  return box;
}

/** Shows a placeholder state in a wrapper. Also used by pdf.js and split.js. Complexity: O(1). */
function setInlineState(span, state) {
  span.replaceChildren(inlinePlaceholder(state));
}

/**
 * Shows a decrypted picture in a wrapper. The <img> itself cannot be dragged
 * (that started the browser's own image drag, which dropped a copy instead of
 * moving it): only the wrapper can. A click, not a drag, opens it larger. When
 * it has loaded, the pages are measured again, since a picture only gets its
 * real height then. Complexity: O(1).
 */
function setInlineImage(span, url, meta) {
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = url;
  if (meta) {
    img.setAttribute("data-zoom", "1");
    let downX = 0;
    let downY = 0;
    img.addEventListener("mousedown", event => {
      downX = event.clientX;
      downY = event.clientY;
    });
    img.addEventListener("click", event => {
      // Moved more than 4px: it was a drag.
      if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > 4) {
        return;
      }
      event.preventDefault();
      const currentUrl = mediaUrls.get(meta.id);
      if (currentUrl) {
        openLightbox(meta, currentUrl, false);
      }
    });
  }
  img.addEventListener("load", () => {
    if (typeof scheduleRepaginate === "function") {
      scheduleRepaginate();
    }
  });
  span.replaceChildren(img);
}

/**
 * The editing surface under a point, for placing something freely
 * (caretRangeAt only says which line). Also used by attachments.js and
 * media-layout.js. Complexity: O(e) in the elements under the point.
 */
function surfaceAtPoint(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const surface = surfaceOfNode(el);
    if (surface) {
      return surface;
    }
  }
  return null;
}

/**
 * The node just before a collapsed caret, or null inside text (where the
 * browser deletes a character itself). Used by events.js for Backspace on an
 * attachment. Complexity: O(1).
 */
function nodeBeforeCaret(range) {
  const container = range.startContainer;
  const offset = range.startOffset;
  if (container.nodeType === 3) {
    return offset === 0 ? container.previousSibling : null;
  }
  return offset > 0 ? container.childNodes[offset - 1] : null;
}

/** The node just after a collapsed caret, or null inside text. Used by events.js for Delete. Complexity: O(1). */
function nodeAfterCaret(range) {
  const container = range.startContainer;
  const offset = range.startOffset;
  if (container.nodeType === 3) {
    return offset === container.data.length ? container.nextSibling : null;
  }
  return offset < container.childNodes.length ? container.childNodes[offset] : null;
}

/** The node if it is a valid inline attachment wrapper, else null. Complexity: O(1). */
function wrapperOf(node) {
  return validInlineMedia(node) ? node : null;
}

/**
 * A collapsed range at the caret under a point. caretRangeFromPoint is
 * Chrome's and Safari's; Firefox only has caretPositionFromPoint, and without
 * this every drop there did nothing. Complexity: O(1).
 */
function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(x, y);
  }
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (position) {
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
  }
  return null;
}
