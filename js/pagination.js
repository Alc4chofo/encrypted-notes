/*
 * pagination.js - flowing a paged note across its A4 sheets, opening and
 * saving notes, and the status line, chips and banners.
 *
 * A sheet is a printed page, so text that no longer fits moves to the next
 * page instead of making the sheet taller than A4: otherwise the screen and
 * the PDF would disagree, which is the one thing the paged view promises. A
 * design's frame (the data-frame blocks) and pinned items stay put on their
 * page; only the content between the frames flows. Pages the flow made
 * ("continuation" pages, data-cont) are taken back when their content fits
 * on the page before again, so deleting text collapses the pages it created.
 *
 * Every height used here is a layout height (offsetHeight), never a painted
 * one: a sheet may be scaled down to fit a narrow pane, and measuring what
 * is painted made a page look like it fits when it does not, so one sheet
 * swallowed the whole note.
 *
 * Main functions: repaginateDom, syncPagesFromDom, contentCapacity,
 * repaginate, scheduleRepaginate, scrollToPage, markActiveSheet,
 * clearEditor, openNote, openTrash, applyReadonly, saveCurrent, flushSave,
 * manualSave, status, classifySyncError, renderStatus, bannerText, dismissBanner.
 * Auxiliary functions: sheetEls, bodyOf, isFrame, isFloat, flowChildren,
 * layoutH, sheetScale, contentLimit, splitTextTail, splitBox, splitCount,
 * pageBoxHeight, overflowing, flowStart, flowEnd, makeContinuation,
 * renumberSheets, toggleChip, renderBanner, renderTrashBanner.
 *
 * Complexity: a reflow makes at most about b moves per sheet (b its blocks),
 * each followed by a layout measurement, so O(b^2) layout work per sheet in
 * the worst case, and it gives up after 2.5 s (to carry on later); cutting a
 * line of text at the page's bottom is a binary search, O(log n) measurements.
 */
"use strict";

// ---------- Flowing text across the sheets ----------

/**
 * Moves content off every body sheet that overflows, and pulls it back up
 * when room appears again. For each body sheet:
 *   1. Push down, while the sheet is too tall: the last block moves to the
 *      next page (a continuation page is made if needed). Typed prose (one
 *      text node, wrapped by the browser) is cut at the line that crosses
 *      the bottom. When the page is one block too big, it gives: one line
 *      longer than a page is cut and goes on at the top of the next page as
 *      the same line (data-split); a table, list or run of pictures gives up
 *      its last child. A truly atomic block (one huge picture) stays.
 *   2. Pull up, while there is room: the next continuation page's first block
 *      comes back. Every move is a trial: if the page then overflows, the
 *      node goes straight back where it was, or for text only the part that
 *      fits stays; nothing is ever copied, so nothing can be duplicated or
 *      lost. A block split across pages stays split, except a split line,
 *      which rejoins its first half when all of it fits. Pictures only gain
 *      their height once decrypted, so the first reflow is always pessimistic
 *      and this is what stops a page holding one picture from staying.
 *   3. Continuation pages left empty go (one holding only a pinned picture
 *      counts as content).
 * Work is bounded per sheet, never once for the whole note: a single shared
 * budget was the "one massive page" bug (the cost grows with the square of
 * the note, so past ten pages the budget ran out mid-sweep and the last page
 * kept everything, measured at 8444px against a 1123px page). The 2.5 s
 * deadline only guards against a freeze (a real 12-page note takes about
 * 0.5 s); when it is hit, another reflow is scheduled to finish. At most 300
 * sheets. Returns whether anything moved.
 *
 * Used by: this file (repaginate), lines.js (renderSheets).
 * Uses: sheetEls, bodyOf, flowChildren, splitCount, overflowing,
 * contentCapacity, layoutH, splitTextTail, isLineEl (lines.js),
 * makeContinuation, splitBox, flowStart, flowEnd, isFrame, scheduleRepaginate.
 * Complexity: O(b^2) layout work per sheet in the worst case.
 */
function repaginateDom() {
  let moved = false;
  let bailed = false;
  const deadline = performance.now() + 2500;
  for (let i = 0; i < sheetEls().length; i++) {
    let sheets = sheetEls();
    const sheet = sheets[i];
    // Title and closing pages are fixed.
    if (!sheet.classList.contains("sec-body")) {
      continue;
    }
    const el = bodyOf(sheet);
    // Enough steps for every block on this sheet, plus every child that could
    // be split out of its last block (a long table gives up one row at a time).
    const initialChildren = flowChildren(el);
    let guard = 0;
    const budget = 60 + initialChildren.length + splitCount(initialChildren[initialChildren.length - 1]);

    // 1. Push down.
    while (overflowing(el) && guard++ < budget) {
      // Runaway guard: pages are never made without end.
      if (sheetEls().length > 300) {
        break;
      }
      const children = flowChildren(el);
      if (!children.length) {
        break;
      }
      const solid = children.filter(child => child.nodeType !== 3 || child.data.trim());
      const tail = children[children.length - 1];
      const cap = contentCapacity(el);
      // Margins count: a table has a 6px margin above and below, so a block
      // measuring just inside the page still pushed it 12px over.
      const tooTall = node => {
        if (node.nodeType !== 1) {
          return false;
        }
        const style = getComputedStyle(node);
        return layoutH(node) + parseFloat(style.marginTop) + parseFloat(style.marginBottom) > cap;
      };

      // Three ways to make room, in order: move the last block down (last),
      // split inside a page that is one block too big (into, or lineRest for
      // one long line), or neither (an atomic block: left alone).
      let last = null;
      let into = null;
      let lineRest = null;
      let lineBox = null;
      if (tail.nodeType === 3 && tail.data.trim()) {
        last = splitTextTail(el, tail);
        // Nothing of it fits here at all.
        if (!last && children.length > 1) {
          last = tail;
        }
      } else if (children.length > 1 && !(solid.length === 1 && solid[0] === tail && tooTall(tail))) {
        last = tail;
      }
      if (!last) {
        // Nothing can be moved off, so the block itself has to give: whether it
        // is taller than a page is beside the point, it does not fit here.
        const box = tail.nodeType === 1 ? tail : (solid[0] && solid[0].nodeType === 1 ? solid[0] : null);
        const lastText = box && isLineEl(box) ? box.lastChild : null;
        if (lastText && lastText.nodeType === 3 && lastText.data.trim() && (lineRest = splitTextTail(el, lastText))) {
          lineBox = box;
        } else if (box && splitCount(box) > 1) {
          into = box;
        } else {
          break;
        }
      }

      let next = sheetEls()[i + 1];
      if (!next || !next.classList.contains("sec-body") || !next.dataset.cont) {
        next = makeContinuation(sheet);
        // Made by the flow, so it may be taken back.
        next.dataset.cont = "1";
      }
      const nextBody = bodyOf(next);
      if (into) {
        if (!splitBox(nextBody, into)) {
          break;
        }
      } else if (lineRest) {
        const head = flowChildren(nextBody)[0];
        if (head && isLineEl(head) && head.dataset.split === "1") {
          head.insertBefore(lineRest, head.firstChild);
        } else {
          const continued = lineBox.cloneNode(false);
          continued.dataset.split = "1";
          continued.appendChild(lineRest);
          const at = flowStart(nextBody);
          if (at) {
            nextBody.insertBefore(continued, at);
          } else {
            nextBody.appendChild(continued);
          }
        }
        nextBody.normalize();
      } else {
        const at = flowStart(nextBody);
        if (at) {
          nextBody.insertBefore(last, at);
        } else {
          nextBody.appendChild(last);
        }
        // The moved lines stay one run of text.
        nextBody.normalize();
      }
      moved = true;
    }

    // 2. Pull up.
    let up = sheetEls()[i + 1];
    while (up && up.dataset.cont && guard++ < budget) {
      const upBody = bodyOf(up);
      const first = flowChildren(upBody)[0];
      // Empty: step 3 removes it.
      if (!first) {
        break;
      }
      if (first.nodeType === 1 && first.dataset && first.dataset.split === "1") {
        const previous = flowChildren(el).slice(-1)[0];
        if (!(isLineEl(first) && previous && isLineEl(previous))) {
          break;
        }
        const moving = [...first.childNodes];
        for (const child of moving) {
          previous.appendChild(child);
        }
        if (overflowing(el)) {
          for (const child of moving) {
            first.appendChild(child);
          }
          break;
        }
        first.remove();
        previous.normalize();
        moved = true;
        if (!flowChildren(upBody).some(node => node.nodeType !== 3 || node.data.trim())) {
          up.remove();
          up = sheetEls()[i + 1];
        }
        continue;
      }
      // Exactly where to put it back.
      const home = first.nextSibling;
      const at = flowEnd(el);
      if (at) {
        el.insertBefore(first, at);
      } else {
        el.appendChild(first);
      }
      if (overflowing(el)) {
        // Too much to take whole. Text keeps the part that fits and hands the
        // rest straight back: the node is cut and its tail put back, never
        // copied, so no word can end up on both pages.
        const rest = first.nodeType === 3 && first.data.trim() ? splitTextTail(el, first) : null;
        if (!rest || overflowing(el)) {
          // The cut is undone and the node goes home.
          if (rest) {
            first.data += rest.data;
            rest.remove();
          }
          if (first.isConnected) {
            first.remove();
          }
          upBody.insertBefore(first, home);
          upBody.normalize();
          break;
        }
        upBody.insertBefore(rest, home);
        upBody.normalize();
        el.normalize();
        moved = true;
        // The page is full now.
        break;
      }
      // Text that was split is joined again.
      el.normalize();
      upBody.normalize();
      moved = true;
      if (!flowChildren(upBody).some(node => node.nodeType !== 3 || node.data.trim())) {
        up.remove();
        up = sheetEls()[i + 1];
      }
    }

    // 3. Empty continuation pages go.
    let following = sheetEls()[i + 1];
    while (following && following.dataset.cont && guard++ < budget) {
      const followingBody = bodyOf(following);
      const hasText = [...followingBody.childNodes]
        .some(node => !isFrame(node) && (node.nodeType !== 3 || node.data.trim().length > 0));
      if (hasText) {
        break;
      }
      following.remove();
      moved = true;
      following = sheetEls()[i + 1];
    }

    // Checked once per sheet, so a sheet is never left half done.
    if (performance.now() > deadline) {
      bailed = true;
      break;
    }
  }
  // Out of time rather than out of work: it comes back to finish (an early
  // stop once was permanent, and an oversized sheet stayed until the next key).
  if (bailed) {
    scheduleRepaginate();
  }
  return moved;
}

/**
 * Rewrites the open note's pages from the sheets after a reflow. A page's
 * identity comes from data-src, which never moves, not from data-page, a
 * view index that is renumbered: reading it off the index made every page
 * take its neighbour's id whenever a page was added or removed, so page
 * identity flapped on each reflow and forked on sync. A continuation page
 * gets a fresh id and keeps its cont mark when saved; without the mark, the
 * reflow could never take back a page it made once the sheets were rebuilt.
 *
 * Used by: this file (repaginate, saveCurrent), lines.js (renderSheets),
 * history.js (historyApply).
 * Uses: isPaged and notePages (content.js), sheetEls, bodyOf, getEditorBody
 * (lines.js), renumberSheets.
 * Complexity: O(n) over the pages' content.
 */
function syncPagesFromDom() {
  const note = currentId && vault ? vault.notes[currentId] : null;
  if (!note || !isPaged(note)) {
    return;
  }
  const old = notePages(note) || [];
  note.pages = sheetEls().map((sheet, i) => {
    const source = old[+(sheet.dataset.src !== undefined ? sheet.dataset.src : sheet.dataset.page)] || {};
    const section = sheet.classList.contains("sec-title") ? "title"
      : sheet.classList.contains("sec-final") ? "final" : "body";
    const cont = !!(sheet.dataset.cont || source.cont);
    return { id: sheet.dataset.cont ? crypto.randomUUID() : (source.id || crypto.randomUUID()),
      name: (sheet.querySelector(".sheet-label .nm") || {}).textContent || "Page " + (i + 1),
      body: getEditorBody(bodyOf(sheet)), bodyV: 2,
      ...(cont ? { cont: true } : {}),
      ...(section !== "body" ? { section } : {}) };
  });
  renumberSheets();
  // Identity is now based on the new list.
  for (const sheet of sheetEls()) {
    sheet.dataset.src = sheet.dataset.page;
  }
}

/**
 * The room for content on one page, in px: the page box minus its margins
 * and whatever the frame takes (at least 80). It tells "too tall to ever
 * fit" from "does not fit right here".
 *
 * Used by: this file (repaginateDom), history.js (onePageContentPx).
 * Uses: isFrame, layoutH, pageBoxHeight.
 * Complexity: O(c) in the page's children.
 */
function contentCapacity(el) {
  const style = getComputedStyle(el);
  let frames = 0;
  for (const node of el.childNodes) {
    if (isFrame(node)) {
      frames += layoutH(node);
    }
  }
  return Math.max(80, pageBoxHeight(el) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - frames);
}

// ---------- Reflowing as the note changes: state ----------

// The reflow waiting to run, after the last change.
let repagTimer = null;

// ---------- Reflowing as the note changes ----------

/**
 * Reflows the sheets, keeping the caret exactly where it was: a marker rides
 * along with the nodes that move and is removed before anything is saved.
 * Not in the trash, a backup or during a sync (the sheets on screen are then
 * the ones from before the merge, and saving them would write them back over
 * the merged note). In the second screen the pages are only renumbered, not
 * saved: committing a reflow there made the note grow pages, so the
 * structure is written when the edit is saved.
 *
 * Used by: this file (scheduleRepaginate).
 * Uses: pagedView, surfaceOfNode and fitSheets (lines.js), repaginateDom,
 * syncPagesFromDom, renumberSheets, sheetEls, bodyOf, packAttachmentRuns
 * (history.js), renderPageTabs (content.js), renderStatus.
 * Complexity: that of repaginateDom.
 */
function repaginate() {
  if (!pagedView() || trashViewId || backupView || syncing || !currentId) {
    return;
  }
  const selection = window.getSelection();
  let marker = null;
  if (selection && selection.rangeCount && surfaceOfNode(selection.getRangeAt(0).startContainer)) {
    marker = document.createElement("span");
    marker.setAttribute("data-caret", "1");
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    range.insertNode(marker);
  }
  const moved = repaginateDom();
  if (marker && marker.isConnected) {
    const surface = surfaceOfNode(marker);
    const caret = document.createRange();
    caret.setStartAfter(marker);
    caret.collapse(true);
    marker.remove();
    if (surface) {
      surface.focus();
      const current = window.getSelection();
      current.removeAllRanges();
      current.addRange(caret);
    }
  } else if (marker) {
    marker.remove();
  }
  if (moved) {
    if (!splitMode) {
      syncPagesFromDom();
    } else {
      renumberSheets();
    }
    for (const sheet of sheetEls()) {
      packAttachmentRuns(bodyOf(sheet));
    }
    renderPageTabs();
    renderStatus();
  }
  // The sheets' margins come from their heights, so they are worked out
  // again after the pass that settles the layout, whether or not anything moved.
  fitSheets();
}

/**
 * Reflows 220 ms after the last change (typing, a picture arriving), so a
 * burst of changes reflows once.
 *
 * Used by: this file (typing in a sheet, repaginateDom), lines.js
 * (hydrateInlineMedia, scheduleInlineSave, setInlineImage).
 * Uses: pagedView (lines.js), repaginate.
 * Complexity: O(1).
 */
function scheduleRepaginate() {
  if (!pagedView()) {
    return;
  }
  clearTimeout(repagTimer);
  repagTimer = setTimeout(repaginate, 220);
}

/**
 * Scrolls the sheets smoothly to page i.
 *
 * Used by: content.js (addPage, switchPage).
 * Uses: nothing.
 * Complexity: O(1).
 */
function scrollToPage(i) {
  const sheet = $("sheets").querySelector('.sheet[data-page="' + i + '"]');
  if (sheet) {
    sheet.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

/**
 * Rings sheet i as the current one.
 *
 * Used by: this file (scrolling and focus), content.js (switchPage).
 * Uses: nothing.
 * Complexity: O(p) in the sheets.
 */
function markActiveSheet(i) {
  for (const sheet of $("sheets").querySelectorAll(".sheet")) {
    sheet.classList.toggle("active", +sheet.dataset.page === i);
  }
}

// ---------- On load: the sheets ----------

// Scrolling the stack keeps the tabs in step: the sheet nearest the top is
// the current page, so the two ways of moving never disagree.
$("sheets").addEventListener("scroll", () => {
  if (!pagedView()) {
    return;
  }
  const box = $("sheets").getBoundingClientRect();
  let best = 0;
  let bestDistance = Infinity;
  for (const sheet of $("sheets").querySelectorAll(".sheet")) {
    const distance = Math.abs(sheet.getBoundingClientRect().top - box.top - 8);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = +sheet.dataset.page;
    }
  }
  if (best !== currentPage) {
    currentPage = best;
    markActiveSheet(best);
    renderPageTabs();
  }
}, { passive: true });

// Typing in a sheet marks the note as changed, the same way as in #editor,
// and text that no longer fits moves to the next page.
$("sheets").addEventListener("input", event => {
  if (!event.target.classList || !event.target.classList.contains("sheet-body")) {
    return;
  }
  if (trashViewId || backupView || !currentId) {
    return;
  }
  if (statusIsError) {
    status("");
  }
  historyMarkTyping();
  if (!unsavedEdits) {
    unsavedEdits = true;
    renderList();
  }
  if (!splitMode) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 400);
  }
  scheduleRepaginate();
  renderStatus();
});

// Clicking into a sheet makes it the current page for the tabs.
$("sheets").addEventListener("focusin", event => {
  const el = event.target.closest && event.target.closest(".sheet-body");
  if (!el) {
    return;
  }
  const i = +el.dataset.page;
  if (i !== currentPage) {
    currentPage = i;
    markActiveSheet(i);
    renderPageTabs();
  }
});

// ---------- Opening and saving notes ----------

/**
 * Empties the editor: decrypts still on their way are cancelled and the
 * baseline is reset, so the next note opened starts clean.
 *
 * Used by: notes.js (purgeTrashCore, trashNote), merge.js (applyMerge),
 * panel.js (restorePrev), settings.js (lockApp).
 * Uses: updateEditorEmpty (lines.js).
 * Complexity: O(1).
 */
function clearEditor() {
  editorSeq++;
  $("editor").replaceChildren();
  editorPlainOrig = "";
  editorBaseline = "";
  updateEditorEmpty();
}

/**
 * Opens a note: a paged one as sheets (what is seen is the PDF), a one-page
 * one in the plain editor. The second screen closes first (its frozen
 * reference belongs to the note it was taken from), decrypted attachments
 * are revoked (they never outlive the note they were shown for), and the
 * undo and pending-change state start fresh for this note. A note in a
 * collapsed folder is revealed, folders above it included.
 *
 * Used by: attachments.js (ensureNoteForMedia), content.js (duplicateNote,
 * makePagedAndShow), designs.js (applyDesign, applyPreset, designItems,
 * importDesign, newDesign), events.js (newNote), notes.js (noteMenu,
 * restoreFromTrash), panel.js (renderDetail), sidebar.js (noteRow, renderUnsynced).
 * Uses: exitSplit (split.js), revokeAllMediaUrls (vault.js), isPaged,
 * activeBody and renderPageTabs (content.js), renderSheets and setEditorBody
 * (lines.js), revealFolder and renderList (sidebar.js), applyReadonly,
 * renderStatus, renderAttachments (attachments.js), renderHistoryButtons (history.js).
 * Complexity: O(n) in the note's content.
 */
function openNote(id) {
  if (!vault.notes[id]) {
    return;
  }
  exitSplit(true);
  revokeAllMediaUrls();
  // Leaving the read-only trash view.
  trashViewId = null;
  currentId = id;
  currentPage = 0;
  historyTypingMarked = false;
  structureDirty = false;
  const note = vault.notes[id];
  $("title").value = note.title;
  if (isPaged(note)) {
    renderSheets();
  } else {
    document.body.classList.remove("paged-view");
    $("sheets").innerHTML = "";
    const body = activeBody(note);
    setEditorBody(body.body, { bodyV: body.bodyV });
  }
  renderPageTabs();
  if (note.folderId) {
    revealFolder(note.folderId);
  }
  applyReadonly();
  unsavedEdits = false;
  renderList();
  renderStatus();
  renderAttachments();
  renderHistoryButtons();
}

/**
 * Shows a note in the trash, read-only. The open note is saved first, while
 * currentId still points at it. currentId stays null on purpose: nothing in
 * the save path may ever write this buffer back into a live note. A trashed
 * snapshot may be an old plain body or a v2 one, and a paged one shows as
 * read-only sheets; its attachments can be downloaded, not removed or added.
 *
 * Used by: panel.js (renderDetail), sidebar.js (renderTrash, renderUnsynced).
 * Uses: flushSave, exitSplit (split.js), revokeAllMediaUrls (vault.js),
 * isPaged, activeBody and renderPageTabs (content.js), renderSheets and
 * setEditorBody (lines.js), applyReadonly, renderList (sidebar.js),
 * renderStatus, renderAttachments (attachments.js).
 * Complexity: O(n) in the snapshot's content.
 */
function openTrash(id) {
  if (!vault.trash[id]) {
    return;
  }
  flushSave();
  exitSplit(true);
  revokeAllMediaUrls();
  currentId = null;
  currentPage = 0;
  trashViewId = id;
  const snapshot = vault.trash[id].data || {};
  $("title").value = snapshot.title || "";
  if (isPaged(snapshot)) {
    renderSheets();
  } else {
    document.body.classList.remove("paged-view");
    $("sheets").innerHTML = "";
    const body = activeBody(snapshot);
    setEditorBody(body.body || "", { bodyV: body.bodyV });
  }
  renderPageTabs();
  applyReadonly();
  unsavedEdits = false;
  renderList();
  renderStatus();
  renderAttachments();
}

/**
 * Makes the title and the text editable or not: read-only in the trash and
 * in a backup, and the text also while a sync runs (applyMerge calls this
 * mid-sync), so a key can never land during the merge and change its
 * outcome. contentEditable is set to false rather than disabling, so the
 * text can still be selected and copied.
 *
 * Used by: this file (openNote, openTrash), notes.js (purgeTrashCore),
 * merge.js (applyMerge), panel.js (restorePrev), backups.js
 * (enterBackupView), sync.js (setEditingEnabled).
 * Uses: nothing.
 * Complexity: O(p) in the sheets.
 */
function applyReadonly() {
  const readOnly = !!trashViewId || !!backupView;
  $("title").readOnly = readOnly;
  const editable = (readOnly || syncing) ? "false" : "true";
  $("editor").contentEditable = editable;
  for (const el of $("sheets").querySelectorAll(".sheet-body")) {
    el.contentEditable = editable;
  }
  $("main").classList.toggle("readonly", readOnly);
}

/**
 * Saves the open note into the vault (persistLocal seals it with AES-256-GCM,
 * vault.js) and returns whether it wrote anything. Nothing is written when
 * nothing changed since the baseline, unless a structural change is pending
 * (structureDirty, history.js): reshaping the note drew the screen again and
 * took a new baseline, so "nothing changed" was true while the note itself
 * was never saved, and "Save edit" once saved nothing.
 *   - Sheets: the page list is rebuilt from the sheets rather than written
 *     page by page, since a reflow in the second screen can have added sheets
 *     the note knows nothing about.
 *   - One page: the text goes to the current page (or the note itself). The
 *     comparison is with the baseline, not note.body: for an old plain note
 *     the editor's text is HTML while note.body is plain, so they would never
 *     match and every old note merely opened would be converted and synced
 *     again. For the same reason an old plain body whose text is unchanged
 *     (and has no inline attachments) stays plain: renaming an old note never
 *     rewrites its body or forks it against a device not yet upgraded.
 * A failed save is reported and the note stays unsaved.
 *
 * Used by: this file (flushSave, manualSave, typing in a sheet), events.js
 * (typing, on load), history.js (historyApply), lines.js
 * (scheduleInlineSave), toolbar.js (markDirtyFromFormatting), media-sync.js (runSync).
 * Uses: renderStatus, renderList (sidebar.js), pagedView, sheetsSnapshot,
 * getEditorBody and editorHasInlineMedia (lines.js), isPaged and activeBody
 * (content.js), syncPagesFromDom, persistLocal (vault.js), status.
 * Complexity: O(n) in the note, plus the vault's seal.
 */
function saveCurrent() {
  if (trashViewId || !currentId) {
    unsavedEdits = false;
    renderStatus();
    return false;
  }
  const note = vault.notes[currentId];
  const title = $("title").value;

  if (pagedView() && isPaged(note)) {
    const snapshot = sheetsSnapshot();
    if (!structureDirty && note.title === title && snapshot === editorBaseline) {
      unsavedEdits = false;
      renderList();
      renderStatus();
      return false;
    }
    note.title = title;
    syncPagesFromDom();
    note.mtime = Date.now();
    persistLocal().catch(error => {
      unsavedEdits = true;
      status("Save failed: " + error.message, true);
      renderStatus();
    });
    unsavedEdits = false;
    structureDirty = false;
    // The next key starts a new undo step.
    historyTypingMarked = false;
    editorBaseline = snapshot;
    renderList();
    renderStatus();
    return true;
  }

  const html = getEditorBody();
  if (!structureDirty && note.title === title && html === editorBaseline) {
    unsavedEdits = false;
    renderList();
    renderStatus();
    return false;
  }
  note.title = title;
  const target = activeBody(note);
  if (editorPlainOrig !== null && !editorHasInlineMedia() && html === editorBaseline) {
    // The text is unchanged: the body and bodyV stay as they are (only the title moved).
  } else {
    target.body = html;
    target.bodyV = 2;
    editorPlainOrig = null;
  }
  note.mtime = Date.now();
  persistLocal().catch(error => {
    unsavedEdits = true;
    status("Save failed: " + error.message, true);
    renderStatus();
  });
  unsavedEdits = false;
  structureDirty = false;
  historyTypingMarked = false;
  editorBaseline = html;
  renderList();
  renderStatus();
  return true;
}

/**
 * Saves the open note now, cancelling the save waiting after typing: called
 * before anything reads or changes the note, so keys typed a moment ago are
 * in it.
 *
 * Used by: this file (openTrash) and most scripts that change notes:
 * attachments.js, backups.js, content.js, designs.js, events.js, history.js,
 * media-sync.js, notes.js, panel.js, pdf.js, settings.js, sidebar.js,
 * split.js, toolbar.js, updates.js.
 * Uses: saveTimer (events.js), saveCurrent.
 * Complexity: that of saveCurrent.
 */
function flushSave() {
  clearTimeout(saveTimer);
  saveCurrent();
}

/**
 * The Save button and Ctrl+S: saves now and says so with the time.
 *
 * Used by: events.js (the Save button and Ctrl+S, on load), history.js
 * ("Save edit", on load), panel.js (renderDetail).
 * Uses: saveTimer (events.js), saveCurrent, status.
 * Complexity: that of saveCurrent.
 */
function manualSave() {
  clearTimeout(saveTimer);
  const wrote = saveCurrent();
  if (wrote) {
    status("Saved " + new Date().toLocaleTimeString());
  } else if (statusIsError) {
    status("");
  }
}

// ---------- The status line and sync errors: state ----------

// The pending clear of the status line, and whether it shows an error.
let statusTimer = null;
let statusIsError = false;

// The chip text for each kind of sync failure.
const ERROR_LABELS = {
  offline: "Sync failed: offline",
  auth: "Sync failed: token rejected",
  ratelimit: "Sync failed: rate limited",
  conflict: "Sync failed: remote changed",
  pwmismatch: "Sync blocked: remote password mismatch",
  // The two repository-guard refusals: this copy has no repository set yet, or it points at a public one.
  unset: "Sync off: no repo set",
  public: "Sync blocked: repo is public",
  other: "Sync failed",
};

// What each failure means and what to do, for the detail panel.
const ERROR_EXPLANATIONS = {
  offline: "The request never reached GitHub. Your notes are safe in this browser; press Sync when back online.",
  auth: "GitHub rejected the token (expired, revoked, or it lost access to the repo). Paste a new fine-grained token below.",
  ratelimit: "GitHub is rate limiting this token. Wait a few minutes and press Sync again.",
  conflict: "Someone pushed between reading and writing. Press Sync again; your changes will be merged, not overwritten.",
  pwmismatch: "The vault.enc in the repo cannot be decrypted with your master password, so pushing would permanently destroy it. Only overwrite it if you are sure the remote copy is disposable.",
  // The fix for "unset" is editing two values in config.js, so the text says exactly where.
  unset: "This copy is not connected to a repo yet. Open config.js, next to index.html, and set owner and repo to your own private GitHub repo (the names only, not a link). Then reload this page and press Sync. Nothing was sent.",
  // For "public" the point is why it is refused, and that nothing left the page.
  public: "The repo this copy points at is public: anyone could download the encrypted vault and try passwords offline. Notes only sync to a private repo. Make the repo private, or point config.js at a private one and reload this page, then press Sync. Nothing was uploaded.",
  other: "Unexpected error during sync. Press Sync to retry.",
};

// ---------- The status line, chips and banners ----------

/**
 * Shows a message on the status line. An ordinary message clears itself
 * after 4 s; an error stays until the next key, save or sync; a sticky one
 * ("Syncing...") never clears by itself.
 *
 * Used by: this file and almost every script: alignment.js, attachments.js,
 * backups.js, censor.js, content.js, designs.js, events.js, format-menu.js,
 * history.js, lines.js, lock.js, media-sync.js, notes.js, panel.js, pdf.js,
 * settings.js, sidebar.js, split.js, tables.js, toolbar.js, updates.js,
 * vault.js, vaults.js.
 * Uses: nothing.
 * Complexity: O(1).
 */
function status(message, isError, sticky) {
  clearTimeout(statusTimer);
  $("status").textContent = message;
  $("status").style.color = isError ? "var(--bad)" : "var(--t3)";
  statusIsError = !!isError;
  if (message && !isError && !sticky) {
    statusTimer = setTimeout(() => {
      $("status").textContent = "";
    }, 4000);
  }
}

/**
 * What kind of sync failure an error is, as { at, httpStatus, kind, raw }:
 * a repository-guard refusal names its own kind ("unset" or "public") and
 * wins; otherwise offline (a network error), auth (401 or 404), ratelimit
 * (403 saying so), conflict (409) or other.
 *
 * Used by: media-sync.js (overwriteRemote, runSync).
 * Uses: nothing.
 * Complexity: O(1).
 */
function classifySyncError(error) {
  let kind = "other";
  if (error.guard) {
    kind = error.guard;
  } else if (error instanceof TypeError || navigator.onLine === false) {
    kind = "offline";
  } else if (error.status === 401 || error.status === 404) {
    kind = "auth";
  } else if (error.status === 403 && /rate.?limit/i.test(error.message)) {
    kind = "ratelimit";
  } else if (error.status === 409) {
    kind = "conflict";
  }
  return { at: Date.now(), httpStatus: error.status || null, kind, raw: error.message };
}

/**
 * Brings everything that shows the vault's state up to date: the Save
 * button, the second-screen button, "Last synced", the chips (unsaved
 * content, sync error), the unsynced section, the banners, and the detail
 * panel (closed when there is nothing left to show). Every change of state
 * goes through here.
 *
 * Used by: this file and most scripts: attachments.js, content.js,
 * designs.js, events.js, history.js, lines.js, lock.js, media-sync.js,
 * merge.js, notes.js, panel.js, sidebar.js, split.js, toolbar.js, vault.js, vaults.js.
 * Uses: unsyncedCount (vault.js), toggleChip, renderUnsynced (sidebar.js),
 * ERROR_LABELS, renderBanner, renderTrashBanner, closePanel and renderDetail (panel.js).
 * Complexity: O(n) over the vault, to count what is unsynced.
 */
function renderStatus() {
  if (!vault) {
    return;
  }
  const saveButton = $("save");
  saveButton.disabled = !unsavedEdits || syncing || !!trashViewId;
  saveButton.textContent = unsavedEdits ? "Save" : (currentId ? "Saved" : "Save");
  // The label swaps between Save and Saved; the title field must not change width.
  saveButton.style.minWidth = "62px";
  // The second screen compares with the open note: with none open it could do nothing.
  $("split-btn").disabled = !splitMode && (!currentId || !!trashViewId || syncing);

  const lastSynced = $("last-synced");
  if (syncMeta.lastSyncedAt == null) {
    lastSynced.textContent = "Never synced";
    lastSynced.style.color = "var(--warn)";
  } else {
    const when = new Date(syncMeta.lastSyncedAt);
    const dateOptions = { month: "short", day: "numeric" };
    if (when.getFullYear() !== new Date().getFullYear()) {
      dateOptions.year = "numeric";
    }
    lastSynced.textContent = "Last synced " +
      when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + ", " +
      when.toLocaleDateString(undefined, dateOptions);
    lastSynced.style.color = "var(--t3)";
  }

  // Notes, folders, trash and both kinds of deletion.
  const unsyncedTotal = unsyncedCount();
  toggleChip("chip-unsaved", unsavedEdits, "Unsaved content");
  renderUnsynced();
  toggleChip("chip-syncerr", !!lastSyncError, lastSyncError ? ERROR_LABELS[lastSyncError.kind] : null);

  renderBanner();
  renderTrashBanner();

  if (panelOpen) {
    if (!unsavedEdits && unsyncedTotal === 0 && !lastSyncError && !pullBanner) {
      closePanel();
    } else {
      renderDetail();
    }
  }
}

/**
 * The merge banner's text: when the repository's vault was saved, and how
 * many local notes it replaced, removed and added. The banner is only shown
 * when a merge really replaced or removed local content (what the snapshot
 * taken before the merge is for); a merge that only adds notes from the
 * repository takes the snapshot silently.
 *
 * Used by: this file (renderBanner), panel.js (renderDetail).
 * Uses: pullBanner (core.js).
 * Complexity: O(1).
 */
function bannerText() {
  return `Merged the repo vault (saved ${new Date(pullBanner.remoteSavedAt).toLocaleString()}): ` +
    `${pullBanner.replaced} local note(s) replaced by a newer remote version, ` +
    `${pullBanner.lost} removed, ${pullBanner.added} new from remote.`;
}

/**
 * Dismisses the merge banner and forgets it (not in a backup, which is
 * read-only, down to this one localStorage write).
 *
 * Used by: events.js (the banner's close button, on load), panel.js (restorePrev).
 * Uses: vaultStorageKey (core.js), renderStatus.
 * Complexity: O(1), plus renderStatus.
 */
function dismissBanner() {
  if (backupView) {
    return;
  }
  pullBanner = null;
  pullDiff = null;
  localStorage.removeItem(vaultStorageKey("pullBanner"));
  renderStatus();
}

// =================== Auxiliary functions ===================

/** Every sheet in the stack. Complexity: O(p). */
function sheetEls() {
  return [...$("sheets").querySelectorAll(".sheet")];
}

/** A sheet's editable body. Complexity: O(1). */
function bodyOf(sheet) {
  return sheet.querySelector(".sheet-body");
}

/** Whether a node is a design's frame (top or bottom), which stays on its page. Complexity: O(1). */
function isFrame(node) {
  return node && node.nodeType === 1 && node.dataset && (node.dataset.frame === "top" || node.dataset.frame === "bottom");
}

/**
 * Whether a node is pinned. A pinned item is out of the flow: moving it
 * changes nothing about the page's height, and it would land on the next
 * page with its old place, so it stays, like the frame. Complexity: O(1).
 */
function isFloat(node) {
  return node && node.nodeType === 1 && node.classList && node.classList.contains("floating");
}

/** The children of a page that flow: everything but the frame and pinned items. Complexity: O(c). */
function flowChildren(el) {
  return [...el.childNodes].filter(node => !isFrame(node) && !isFloat(node));
}

/** An element's layout height (0 for anything else). Complexity: O(1). */
function layoutH(node) {
  return node && node.nodeType === 1 ? node.offsetHeight : 0;
}

/** How much a sheet is scaled on screen (1 when it is not), to compare screen and layout units. Complexity: O(1). */
function sheetScale(el) {
  const height = el.offsetHeight;
  return height ? el.getBoundingClientRect().height / height : 1;
}

/**
 * The screen y content must stay above on this page, in viewport units
 * (what a Range measures in): the page's bottom less its margin and the
 * bottom frame. Complexity: O(c) in the page's children.
 */
function contentLimit(el) {
  const style = getComputedStyle(el);
  let foot = 0;
  for (const node of el.childNodes) {
    if (isFrame(node) && node.dataset.frame === "bottom") {
      foot += layoutH(node);
    }
  }
  const scale = sheetScale(el);
  return el.getBoundingClientRect().top + (pageBoxHeight(el) - parseFloat(style.paddingBottom) - foot) * scale;
}

/**
 * Cuts a text node at the line that crosses the page's bottom and returns
 * the rest as a new node (null when nothing fits or everything does). Typed
 * prose is one text node with no newlines (the browser wraps it), so cutting
 * on "\n" alone left a whole paragraph uncuttable. A binary search on a
 * Range finds the character where the text crosses the limit; the cut then
 * backs up to the nearest newline or space, so words stay whole.
 * Complexity: O(log n) layout measurements.
 */
function splitTextTail(el, tail) {
  const limit = contentLimit(el);
  const range = document.createRange();
  let lo = 0;
  let hi = tail.data.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    range.setStart(tail, 0);
    range.setEnd(tail, mid);
    if (range.getBoundingClientRect().bottom <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo <= 0 || lo >= tail.data.length) {
    return null;
  }
  const newline = tail.data.lastIndexOf("\n", lo);
  const space = tail.data.lastIndexOf(" ", lo);
  let cut = newline > 0 ? newline + 1 : (space > 0 ? space + 1 : lo);
  if (cut <= 0 || cut >= tail.data.length) {
    cut = lo;
  }
  const rest = document.createTextNode(tail.data.slice(cut));
  tail.data = tail.data.slice(0, cut);
  if (!tail.data) {
    tail.remove();
  }
  return rest;
}

/**
 * Splits inside a block too tall on its own (a centred run of pictures, a
 * long table, a 200-item list): without this the page just stayed
 * oversized, since only whole children were moved. A shallow copy of the
 * block leads the next page and the block's last child moves across, one per
 * pass, so the wrapper's alignment and a table's header survive on both
 * halves (a numbered list keeps counting). Returns false when there is
 * nothing to move. Complexity: O(1) per child moved.
 */
function splitBox(nextBody, box) {
  const tag = box.tagName;
  const rows = tag === "TABLE";
  const source = rows ? (box.querySelector("tbody") || box) : box;
  if (!source.lastChild) {
    return false;
  }
  let dest = flowChildren(nextBody)[0];
  if (!(dest && dest.nodeType === 1 && dest.tagName === tag && dest.dataset.split === "1")) {
    dest = box.cloneNode(false);
    dest.dataset.split = "1";
    if (rows) {
      const head = box.querySelector("thead");
      if (head) {
        dest.appendChild(head.cloneNode(true));
      }
      dest.appendChild(document.createElement("tbody"));
    }
    const at = flowStart(nextBody);
    if (at) {
      nextBody.insertBefore(dest, at);
    } else {
      nextBody.appendChild(dest);
    }
  }
  const sink = rows ? (dest.querySelector("tbody") || dest) : dest;
  sink.insertBefore(source.lastChild, sink.firstChild);
  if (tag === "OL") {
    dest.setAttribute("start", String((+box.getAttribute("start") || 1) + source.children.length));
  }
  // An empty husk: everything moved across.
  if (!source.firstChild) {
    box.remove();
  }
  return true;
}

/** How many children a block could still give up (a table: its rows). Complexity: O(1). */
function splitCount(box) {
  return box && box.nodeType === 1
    ? (box.tagName === "TABLE" ? (box.querySelector("tbody") || box).childNodes.length : box.childNodes.length) : 0;
}

/**
 * The page box's height (its min-height). Overflow is decided by the page
 * box, not by adding up children: summing heights is wrong for anything
 * inline (pictures side by side each added their full height, or nothing
 * before they loaded). The sheet grows past its height only when the
 * content really does not fit, which is exactly the question. Complexity: O(1).
 */
function pageBoxHeight(el) {
  const style = getComputedStyle(el);
  return parseFloat(style.minHeight) || 0;
}

/** Whether a page is taller than its page box. Complexity: O(1). */
function overflowing(el) {
  return layoutH(el) > pageBoxHeight(el) + 1;
}

/**
 * Where new content belongs in a framed page: after the top frame. It stops
 * at the bottom frame: a continuation page starts out holding nothing but
 * the frame, and falling through to the end put the text under the footer.
 * Complexity: O(c).
 */
function flowStart(el) {
  for (const node of el.childNodes) {
    if (isFrame(node)) {
      if (node.dataset.frame === "bottom") {
        return node;
      }
      continue;
    }
    return node;
  }
  return null;
}

/** Where flowing content ends: before the bottom frame, or null for the very end. Complexity: O(c). */
function flowEnd(el) {
  for (const node of el.childNodes) {
    if (isFrame(node) && node.dataset.frame === "bottom") {
      return node;
    }
  }
  return null;
}

/**
 * A new continuation page after a sheet: the same part and frame, with no
 * flowing content (pinned items are not copied either). It does not inherit
 * the current-page ring: two ringed sheets answering to the same index
 * made tab clicks land on the wrong one. Complexity: O(c).
 */
function makeContinuation(sheet) {
  const clone = sheet.cloneNode(true);
  const cloneBody = bodyOf(clone);
  clone.classList.remove("active");
  for (const node of [...cloneBody.childNodes]) {
    if (!isFrame(node)) {
      node.remove();
    }
  }
  const nameEl = clone.querySelector(".sheet-label .nm");
  const base = (sheet.querySelector(".sheet-label .nm").textContent || "Page").replace(/\s+\d+$/, "");
  if (nameEl) {
    nameEl.textContent = base + " " + (sheetEls().indexOf(sheet) + 2);
  }
  cloneBody.contentEditable = "true";
  sheet.after(clone);
  return clone;
}

/**
 * Renumbers the sheets and their "3 / 7" counters after any reflow, the
 * second screen included (skipping it there left continuation pages sharing
 * an index with the sheet they were copied from). Complexity: O(p).
 */
function renumberSheets() {
  const sheets = sheetEls();
  sheets.forEach((sheet, i) => {
    sheet.dataset.page = String(i);
    bodyOf(sheet).dataset.page = String(i);
    const counter = sheet.querySelector(".sheet-label .n");
    if (counter) {
      counter.textContent = (i + 1) + " / " + sheets.length;
    }
  });
}

/**
 * Shows or hides a chip, with its text and a count in a fixed-width span
 * (so 9 becoming 10 does not shove the next chip from under the pointer).
 * Complexity: O(1).
 */
function toggleChip(id, show, text, count) {
  const chip = $(id);
  chip.style.display = show ? "inline-block" : "none";
  if (text != null) {
    chip.textContent = text;
    if (count != null) {
      chip.appendChild(document.createTextNode(" ("));
      chip.appendChild(makeElement("span", "n", String(count)));
      chip.appendChild(document.createTextNode(")"));
    }
  }
}

/** Shows the merge banner while there is one. Complexity: O(1). */
function renderBanner() {
  const banner = $("pull-banner");
  if (!pullBanner) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  $("pull-banner-text").textContent = bannerText();
}

/** The amber banner over a note in the trash: when it was deleted, and the days it has left. Complexity: O(1). */
function renderTrashBanner() {
  const banner = $("trash-banner");
  if (!trashViewId || !vault.trash[trashViewId]) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  const deletedAt = vault.trash[trashViewId].deletedAt || 0;
  const daysLeft = Math.max(0, 30 - Math.floor((Date.now() - deletedAt) / 86400e3));
  $("trash-banner-text").textContent = "In trash, deleted " + relativeTime(deletedAt) +
    " - deleted permanently in " + daysLeft + " day" + (daysLeft === 1 ? "" : "s");
  $("trash-restore").disabled = syncing;
  $("trash-purge").disabled = syncing;
}
