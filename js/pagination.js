// notes: Paged notes: flowing text across A4 sheets.
"use strict";

// ---------- Pagination ----------
// A sheet IS a printed page, so text that no longer fits must move to the next
// page instead of making the sheet taller than A4 - otherwise the screen and
// the PDF disagree, which is the one thing the paged view promises.
// A design's frame (the data-frame blocks) is furniture: it stays put on every
// page and only the content between the frames flows.
const sheetEls = () => [...$("sheets").querySelectorAll(".sheet")];
const bodyOf = sh => sh.querySelector(".sheet-body");
const isFrame = n => n && n.nodeType === 1 && n.dataset && (n.dataset.frame === "top" || n.dataset.frame === "bottom");
// A pinned item is out of flow: moving it changes nothing about the page height
// and it would land on the next page still wearing its old coordinates. It is
// furniture, like the frame.
const isFloat = n => n && n.nodeType === 1 && n.classList && n.classList.contains("floating");
const flowChildren = el => [...el.childNodes].filter(n => !isFrame(n) && !isFloat(n));
// Room for content on one page: the page box minus its margins and minus
// whatever the frame occupies. Used to tell "too tall to EVER fit" from
// "does not fit right here".
// Every height used for pagination is a LAYOUT height (offsetHeight), never a
// painted one: the sheet may be visually scaled down to fit a narrow pane, and
// measuring the painted size would make a page look like it fits when it does
// not - one sheet then swallows the whole note.
const layoutH = n => n && n.nodeType === 1 ? n.offsetHeight : 0;
// How much the sheet is being shown at, so viewport coordinates can be compared
// with layout ones. 1 when it is not scaled.
function sheetScale(el) {
  const h = el.offsetHeight;
  return h ? el.getBoundingClientRect().height / h : 1;
}
function contentCapacity(el) {
  const cs = getComputedStyle(el);
  let frames = 0;
  for (const n of el.childNodes) if (isFrame(n)) frames += layoutH(n);
  return Math.max(80, pageBoxHeight(el) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - frames);
}
// The y coordinate content must stay above on this page, in VIEWPORT units,
// because that is what a Range measures in.
function contentLimit(el) {
  const cs = getComputedStyle(el);
  let foot = 0;
  for (const n of el.childNodes) if (isFrame(n) && n.dataset.frame === "bottom") foot += layoutH(n);
  const k = sheetScale(el);
  return el.getBoundingClientRect().top + (pageBoxHeight(el) - parseFloat(cs.paddingBottom) - foot) * k;
}
// Cut a text node at the line that crosses the page bottom. Typed prose is one
// text node with no newlines in it - wrapping is done by the browser - so
// splitting on "\n" alone left a whole paragraph unsplittable. Binary search on
// a Range finds the character where the text crosses the limit; the cut then
// backs up to the nearest newline or space so words stay whole.
function splitTextTail(el, tail) {
  const limit = contentLimit(el);
  const r = document.createRange();
  let lo = 0, hi = tail.data.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    r.setStart(tail, 0); r.setEnd(tail, mid);
    if (r.getBoundingClientRect().bottom <= limit) lo = mid; else hi = mid - 1;
  }
  if (lo <= 0 || lo >= tail.data.length) return null;   // nothing fits, or it all fits
  const nl = tail.data.lastIndexOf("\n", lo);
  const sp = tail.data.lastIndexOf(" ", lo);
  let cut = nl > 0 ? nl + 1 : (sp > 0 ? sp + 1 : lo);
  if (cut <= 0 || cut >= tail.data.length) cut = lo;
  const rest = document.createTextNode(tail.data.slice(cut));
  tail.data = tail.data.slice(0, cut);
  if (!tail.data) tail.remove();
  return rest;
}
// Split INTO a block that is too tall on its own - a centred run of images, a
// long table, a 200-item list. Without this the page just stayed oversized,
// because only top-level children were ever moved. A shallow clone of the block
// leads the next page and the block's last child moves across, one per pass, so
// the wrapper's alignment and a table's header survive on both halves.
function splitBox(nb, box) {
  const tag = box.tagName;
  const rows = tag === "TABLE";
  const src = rows ? (box.querySelector("tbody") || box) : box;
  if (!src.lastChild) return false;
  let dest = flowChildren(nb)[0];
  if (!(dest && dest.nodeType === 1 && dest.tagName === tag && dest.dataset.split === "1")) {
    dest = box.cloneNode(false);
    dest.dataset.split = "1";
    if (rows) {
      const head = box.querySelector("thead");
      if (head) dest.appendChild(head.cloneNode(true));
      dest.appendChild(document.createElement("tbody"));
    }
    const at = flowStart(nb);
    if (at) nb.insertBefore(dest, at); else nb.appendChild(dest);
  }
  const sink = rows ? (dest.querySelector("tbody") || dest) : dest;
  sink.insertBefore(src.lastChild, sink.firstChild);
  if (tag === "OL") dest.setAttribute("start", String((+box.getAttribute("start") || 1) + src.children.length));
  if (!src.firstChild) box.remove();      // husk: everything moved across
  return true;
}
// What can still be taken off a block. A block with one child is atomic here.
const splitCount = box => box && box.nodeType === 1
  ? (box.tagName === "TABLE" ? (box.querySelector("tbody") || box).childNodes.length : box.childNodes.length) : 0;
// Overflow is decided by the PAGE BOX, not by adding up the children. Summing
// child heights is wrong for anything inline: images sitting side by side each
// contribute their full height, so a row of pictures measured several times too
// tall (or, when they had not loaded yet, nothing at all). The sheet has a fixed
// page height and grows past it only when the content genuinely does not fit -
// which is exactly the question, and it is true for images, tables and text alike.
function pageBoxHeight(el) {
  const cs = getComputedStyle(el);
  return parseFloat(cs.minHeight) || 0;
}
const overflowing = el => layoutH(el) > pageBoxHeight(el) + 1;
// Where new content belongs inside a framed page: after the top frame.
function flowStart(el) {
  for (const n of el.childNodes) {
    // Stop at the bottom frame: a continuation page starts out holding nothing
    // but the frame, and falling through to "append at the end" put the text
    // UNDER the footer - the closing classification line printed above the
    // content it was supposed to close.
    if (isFrame(n)) { if (n.dataset.frame === "bottom") return n; continue; }
    return n;
  }
  return null;
}
// Where flow content ENDS: before the bottom frame, or at the very end.
const flowEnd = el => { for (const n of el.childNodes) if (isFrame(n) && n.dataset.frame === "bottom") return n; return null; };
// Build the next page for overflow: same section, same frame, empty flow.
function makeContinuation(sh) {
  const clone = sh.cloneNode(true);
  const cb = bodyOf(clone);
  // A clone inherits the ACTIVE ring and the page number of the sheet it came
  // from. Two ringed sheets and two sheets answering to the same index is what
  // "it went to pieces after a second" looks like: tab clicks land on the first
  // duplicate, and an attachment dropped on one writes over the other's page.
  clone.classList.remove("active");
  // Strip everything except the frame - floats included. flowChildren skips
  // floats, so using it here would leave the pinned items cloned onto the new
  // page as well.
  for (const n of [...cb.childNodes]) if (!isFrame(n)) n.remove();
  const nm = clone.querySelector(".sheet-label .nm");
  const base = (sh.querySelector(".sheet-label .nm").textContent || "Page").replace(/\s+\d+$/, "");
  if (nm) nm.textContent = base + " " + (sheetEls().indexOf(sh) + 2);
  cb.contentEditable = "true";
  sh.after(clone);
  return clone;
}
// Move trailing blocks off pages that overflow, and pull them back up when
// room appears again, so deleting text collapses the pages it created.
function repaginateDom() {
  let moved = false, bailed = false;
  // Work is bounded PER SHEET, never once for the whole document. A single
  // shared budget was the "one massive page" bug: moving a block costs a tick,
  // shedding a page costs one tick per block on it, so the cost grows with the
  // square of the document. Past about ten pages of formatted paragraphs the
  // budget ran out mid-sweep, the loop stopped visiting sheets at all, and the
  // last continuation kept everything - measured at 8444px against a 1123px
  // page box.
  // The deadline is only a freeze guard: real pagination of a 12-page document
  // measures ~0.5s, so anything tighter would abort correct work.
  const deadline = performance.now() + 2500;
  for (let i = 0; i < sheetEls().length; i++) {
    let sheets = sheetEls();
    const sh = sheets[i];
    if (!sh.classList.contains("sec-body")) continue;   // title/final pages are fixed
    const el = bodyOf(sh);
    // Enough ticks for every block on this sheet, plus every child that could be
    // split out of the tail block (a long table sheds one row at a time).
    const kids0 = flowChildren(el);
    let guard = 0;
    const budget = 60 + kids0.length + splitCount(kids0[kids0.length - 1]);
    // push down
    while (overflowing(el) && guard++ < budget) {
      if (sheetEls().length > 300) break;      // runaway guard: never spawn pages endlessly
      const kids = flowChildren(el);
      if (!kids.length) break;
      const solid = kids.filter(k => k.nodeType !== 3 || k.data.trim());
      const tail = kids[kids.length - 1];
      const cap = contentCapacity(el);
      // Margins count: a table is `margin: 6px 0`, so a block that measures just
      // inside the page still pushed it 12px over and the reflow gave up with
      // the page a hair too tall.
      const tooTall = n => {
        if (n.nodeType !== 1) return false;
        const cs = getComputedStyle(n);
        return layoutH(n) + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) > cap;
      };
      // Three ways to make room, in order of preference:
      //   last  - move a whole trailing block down
      //   into  - the page is ONE block that is too big: split inside it
      //   (neither) - genuinely atomic, e.g. one huge picture: leave it alone
      let last = null, into = null, lineRest = null, lineBox = null;
      if (tail.nodeType === 3 && tail.data.trim()) {
        last = splitTextTail(el, tail);          // typed prose: cut at the page bottom
        if (!last && kids.length > 1) last = tail;   // nothing of it fits here at all
      } else if (kids.length > 1 && !(solid.length === 1 && solid[0] === tail && tooTall(tail))) {
        last = tail;
      }
      if (!last) {
        // The page overflows and nothing can be moved off it, so the block
        // itself has to give. Whether it is "taller than a page" is beside the
        // point - it does not fit HERE, and anything with more than one child
        // can give one up.
        const box = tail.nodeType === 1 ? tail : (solid[0] && solid[0].nodeType === 1 ? solid[0] : null);
        // One line - a paragraph typed without Enter - longer than a whole page:
        // its text is cut where the page ends and the rest carries on at the top
        // of the next page as the same line (data-split), rejoined below when
        // room appears again.
        const t = box && isLineEl(box) ? box.lastChild : null;
        if (t && t.nodeType === 3 && t.data.trim() && (lineRest = splitTextTail(el, t))) lineBox = box;
        else if (box && splitCount(box) > 1) into = box;
        else break;
      }
      let next = sheetEls()[i + 1];
      if (!next || !next.classList.contains("sec-body") || !next.dataset.cont) {
        next = makeContinuation(sh);
        next.dataset.cont = "1";           // created by overflow: may be reabsorbed
      }
      const nb = bodyOf(next);
      if (into) {
        if (!splitBox(nb, into)) break;
      } else if (lineRest) {
        const head = flowChildren(nb)[0];
        if (head && isLineEl(head) && head.dataset.split === "1") head.insertBefore(lineRest, head.firstChild);
        else {
          const cont = lineBox.cloneNode(false);
          cont.dataset.split = "1";
          cont.appendChild(lineRest);
          const at = flowStart(nb);
          if (at) nb.insertBefore(cont, at); else nb.appendChild(cont);
        }
        nb.normalize();
      } else {
        const at = flowStart(nb);
        if (at) nb.insertBefore(last, at); else nb.appendChild(last);
        nb.normalize();                    // keep the moved lines as one text run
      }
      moved = true;
    }
    // Pull back UP: a page that has room again takes the next page's first
    // block back. Without this, anything pushed down early - images only gain
    // their height once they decrypt, so the first reflow is always pessimistic
    // - stayed down, leaving a nearly empty page with one picture or one video
    // card on it.
    // Every move is a TRIAL: if the page then overflows, the node goes straight
    // back where it came from. Nothing is ever split or copied here, so a block
    // cannot be duplicated or lost.
    let up = sheetEls()[i + 1];
    while (up && up.dataset.cont && guard++ < budget) {
      const ub = bodyOf(up);
      const first = flowChildren(ub)[0];
      if (!first) break;                       // empty: the remover below takes it
      // A block that had to be SPLIT across pages is left alone: pulling the
      // continuation half up would stack it under its own first half. A split
      // LINE is the exception: its rest rejoins the line it was cut from, when
      // the whole of it fits again.
      if (first.nodeType === 1 && first.dataset && first.dataset.split === "1") {
        const prev = flowChildren(el).slice(-1)[0];
        if (!(isLineEl(first) && prev && isLineEl(prev))) break;
        const moving = [...first.childNodes];
        for (const c of moving) prev.appendChild(c);
        if (overflowing(el)) { for (const c of moving) first.appendChild(c); break; }
        first.remove();
        prev.normalize();
        moved = true;
        if (!flowChildren(ub).some(x => x.nodeType !== 3 || x.data.trim())) { up.remove(); up = sheetEls()[i + 1]; }
        continue;
      }
      const home = first.nextSibling;          // exactly where to put it back
      const at = flowEnd(el);
      if (at) el.insertBefore(first, at); else el.appendChild(first);
      if (overflowing(el)) {
        // Too much to take whole. For text, keep the part that fits and hand
        // the remainder straight back - the node is TRUNCATED and its tail
        // re-inserted, never copied, so no word can end up on both pages.
        const rest = first.nodeType === 3 && first.data.trim() ? splitTextTail(el, first) : null;
        if (!rest || overflowing(el)) {
          if (rest) { first.data += rest.data; rest.remove(); }   // undo the cut
          if (first.isConnected) first.remove();
          ub.insertBefore(first, home);
          ub.normalize();
          break;
        }
        ub.insertBefore(rest, home);
        ub.normalize();
        el.normalize();
        moved = true;
        break;                                 // the page is full now
      }
      el.normalize(); ub.normalize();          // re-join text that was split
      moved = true;
      if (!flowChildren(ub).some(x => x.nodeType !== 3 || x.data.trim())) {
        up.remove();
        up = sheetEls()[i + 1];
      }
    }
    let next = sheetEls()[i + 1];
    while (next && next.dataset.cont && guard++ < budget) {
      const nb = bodyOf(next);
      // Floats count as content here even though they never flow, or a page
      // holding nothing but a pinned image would be deleted under it.
      const hasText = [...nb.childNodes].some(x => !isFrame(x) && (x.nodeType !== 3 || x.data.trim().length > 0));
      if (hasText) break;
      next.remove();
      moved = true;
      next = sheetEls()[i + 1];
    }
    // Checked once per sheet, so a sheet is never left half-processed.
    if (performance.now() > deadline) { bailed = true; break; }
  }
  // Out of time rather than out of work: come back and finish. Every early exit
  // used to be permanent - nothing re-ran the sweep, so an oversized sheet just
  // stayed on screen until the user happened to type.
  if (bailed) scheduleRepaginate();
  return moved;
}
// Rewrite the note's pages from the sheets after a reflow, keeping ids where the
// page still exists so nothing downstream is surprised.
function syncPagesFromDom() {
  const n = currentId && vault ? vault.notes[currentId] : null;
  if (!n || !isPaged(n)) return;
  const old = notePages(n) || [];
  n.pages = sheetEls().map((sh, i) => {
    // Identity comes from data-src, which never moves, NOT from data-page, which
    // is a view index that gets renumbered. Reading identity off the view index
    // made every page inherit its neighbour's id whenever a page was added or
    // removed - page identity flapping on each reflow, and forking on sync.
    const src = old[+(sh.dataset.src !== undefined ? sh.dataset.src : sh.dataset.page)] || {};
    const sec = sh.classList.contains("sec-title") ? "title" : sh.classList.contains("sec-final") ? "final" : "body";
    // `cont` has to survive into the saved page, or the marker is lost the next
    // time the sheets are rebuilt and the reflow can never reabsorb the page it
    // created - which is how a note ends up keeping a page holding one picture.
    const cont = !!(sh.dataset.cont || src.cont);
    return { id: sh.dataset.cont ? crypto.randomUUID() : (src.id || crypto.randomUUID()),
      name: (sh.querySelector(".sheet-label .nm") || {}).textContent || "Page " + (i + 1),
      body: getEditorBody(bodyOf(sh)), bodyV: 2,
      ...(cont ? { cont: true } : {}),
      ...(sec !== "body" ? { section: sec } : {}) };
  });
  renumberSheets();
  for (const sh of sheetEls()) sh.dataset.src = sh.dataset.page;   // identity re-based on the new list
}
// The view index and the "3 / 7" counter, refreshed after ANY reflow - split
// mode included, where the note itself is deliberately not written. Skipping it
// there left continuation pages sharing an index with the sheet they were cloned
// from, so the tabs, the active ring and every tab click pointed at the wrong
// page a second after the design landed.
function renumberSheets() {
  const sheets = sheetEls();
  sheets.forEach((sh, i) => {
    sh.dataset.page = String(i);
    bodyOf(sh).dataset.page = String(i);
    const c = sh.querySelector(".sheet-label .n");
    if (c) c.textContent = (i + 1) + " / " + sheets.length;
  });
}
// Reflow keeping the caret exactly where the user left it: a marker rides along
// with the moved nodes and is removed before anything is serialized.
let repagTimer = null;
function repaginate() {
  // Never while a sync is applying a merge: the sheets on screen are the
  // pre-merge ones, and committing them would write them back over the merged
  // note.
  if (!pagedView() || trashViewId || backupView || syncing || !currentId) return;
  const sel = window.getSelection();
  let marker = null;
  if (sel && sel.rangeCount && surfaceOfNode(sel.getRangeAt(0).startContainer)) {
    marker = document.createElement("span");
    marker.setAttribute("data-caret", "1");
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    r.insertNode(marker);
  }
  const moved = repaginateDom();
  if (marker && marker.isConnected) {
    const surf = surfaceOfNode(marker);
    const r2 = document.createRange();
    r2.setStartAfter(marker);
    r2.collapse(true);
    marker.remove();                       // gone BEFORE any serialization
    if (surf) {
      surf.focus();
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r2);
    }
  } else if (marker) marker.remove();
  if (moved) {
    // Committing the reflow from inside the second screen made the note GROW
    // pages, so it does not do that: the second screen only renumbers, and the
    // structure is written when you save. (The view/state divergence that
    // caused is handled by rebuilding from the sheets, not from n.pages -
    // see reloadNoteInPlace.)
    if (!splitMode) syncPagesFromDom(); else renumberSheets();
    for (const sh of sheetEls()) packAttachmentRuns(bodyOf(sh));
    renderPageTabs(); renderStatus();
  }
  // Margins are baked from each sheet's height, so they must be recomputed after
  // the pass that settles the layout - not only when something moved.
  fitSheets();
}
function scheduleRepaginate() {
  if (!pagedView()) return;
  clearTimeout(repagTimer);
  repagTimer = setTimeout(repaginate, 220);
}
function scrollToPage(i) {
  const sheet = $("sheets").querySelector('.sheet[data-page="' + i + '"]');
  if (sheet) sheet.scrollIntoView({ block: "start", behavior: "smooth" });
}
function markActiveSheet(i) {
  for (const s of $("sheets").querySelectorAll(".sheet")) s.classList.toggle("active", +s.dataset.page === i);
}
// Scrolling the stack keeps the tabs in step, so the two navigation methods
// never disagree about which page you are on.
$("sheets").addEventListener("scroll", () => {
  if (!pagedView()) return;
  const box = $("sheets").getBoundingClientRect();
  let best = 0, bestD = Infinity;
  for (const s of $("sheets").querySelectorAll(".sheet")) {
    const d = Math.abs(s.getBoundingClientRect().top - box.top - 8);
    if (d < bestD) { bestD = d; best = +s.dataset.page; }
  }
  if (best !== currentPage) { currentPage = best; markActiveSheet(best); renderPageTabs(); }
}, { passive: true });
// Typing in any sheet marks the note dirty through the same path as #editor.
$("sheets").addEventListener("input", e => {
  if (!e.target.classList || !e.target.classList.contains("sheet-body")) return;
  if (trashViewId || backupView || !currentId) return;
  if (statusIsError) status("");
  historyMarkTyping();
  if (!dirty) { dirty = true; renderList(); }
  if (!splitMode) { clearTimeout(saveTimer); saveTimer = setTimeout(saveCurrent, 400); }
  scheduleRepaginate();   // text that no longer fits moves to the next page
  renderStatus();
});
// A click inside a sheet makes it the current page for the tabs.
$("sheets").addEventListener("focusin", e => {
  const el = e.target.closest && e.target.closest(".sheet-body");
  if (!el) return;
  const i = +el.dataset.page;
  if (i !== currentPage) { currentPage = i; markActiveSheet(i); renderPageTabs(); }
});

// Backs every editor-clear site: cancels in-flight hydration and resets the baseline
// so the next opened note starts clean.
function clearEditor() {
  editorSeq++;
  $("editor").replaceChildren();
  editorPlainOrig = "";
  editorBaseline = "";
  updateEditorEmpty();
}

function openNote(id) {
  if (!vault.notes[id]) return;
  exitSplit(true);        // a frozen reference belongs to the note it was taken from
  revokeAllMediaUrls();   // decrypted media never outlives the note it was shown for
  trashViewId = null;     // leaving the read-only trash view
  currentId = id;
  currentPage = 0;
  histTypingMarked = false;   // each note keeps its own undo history
  structureDirty = false;     // pending-change tracking never crosses notes
  const n = vault.notes[id];
  $("title").value = n.title;
  // Paged notes open in the scrolling sheet view (what you see IS the PDF);
  // single-page notes keep the plain editor.
  if (isPaged(n)) renderSheets();
  else { document.body.classList.remove("paged-view"); $("sheets").innerHTML = "";
    const t = activeBody(n); setEditorBody(t.body, { bodyV: t.bodyV }); }
  renderPageTabs();
  // Opening a note programmatically must never leave it hidden in a collapsed folder.
  if (n.folderId) revealFolder(n.folderId);   // incl. collapsed ancestors
  applyReadonly();
  dirty = false;
  renderList();
  renderStatus();
  renderAttachments();
  renderHistoryButtons();
}

// Read-only preview of a trashed note. currentId stays null on purpose: nothing
// in the save path may ever write this buffer back into a live note.
function openTrash(id) {
  if (!vault.trash[id]) return;
  flushSave();            // commit the live note first, while currentId still points at it
  exitSplit(true);
  revokeAllMediaUrls();
  currentId = null;
  currentPage = 0;
  trashViewId = id;
  const d = vault.trash[id].data || {};
  $("title").value = d.title || "";
  // Branch on the SNAPSHOT's bodyV (a trash snapshot may be v1 plain or v2 HTML);
  // a paged snapshot shows its pages read-only in the same sheet view.
  if (isPaged(d)) renderSheets();
  else { document.body.classList.remove("paged-view"); $("sheets").innerHTML = "";
    const t = activeBody(d); setEditorBody(t.body || "", { bodyV: t.bodyV }); }
  renderPageTabs();
  applyReadonly();
  dirty = false;
  renderList();
  renderStatus();
  renderAttachments();   // trash snapshot media: download-only, no remove, no ingest
}

// contentEditable=false (not disabled) so trashed text stays selectable and copyable.
// Also the single source of truth for the editor's editability: it is off for a
// trash view OR while a sync is in flight (applyMerge calls this mid-sync), so a
// keystroke can never land during the merge and flip the pull-vs-push decision.
function applyReadonly() {
  const ro = !!trashViewId || !!backupView;
  $("title").readOnly = ro;
  const editable = (ro || syncing) ? "false" : "true";
  $("editor").contentEditable = editable;
  for (const el of $("sheets").querySelectorAll(".sheet-body")) el.contentEditable = editable;
  $("main").classList.toggle("readonly", ro);
}

// Returns true when it actually wrote to the vault.
function saveCurrent() {
  if (trashViewId || !currentId) { dirty = false; renderStatus(); return false; }
  const n = vault.notes[currentId];
  const title = $("title").value;
  // Paged note in the sheet view: every page is live, so save them all.
  if (pagedView() && isPaged(n)) {
    const snap = sheetsSnapshot();
    // The fast-path is VOID while a structural change is pending: reshaping the
    // note re-rendered the screen and re-took the baseline, so "nothing changed
    // since the baseline" was true while the note itself was never persisted -
    // and "Save edit" silently saved nothing.
    if (!structureDirty && n.title === title && snap === editorBaseline) {
      dirty = false; renderList(); renderStatus(); return false;
    }
    n.title = title;
    // Rebuild the page list from the sheets rather than writing body-by-body:
    // a reflow in split mode can have added sheets that n.pages knows nothing
    // about, and index-mapping would have dropped them on the floor.
    syncPagesFromDom();
    n.mtime = Date.now();
    persistLocal().catch(e => { dirty = true; status("Save failed: " + e.message, true); renderStatus(); });
    dirty = false;
    structureDirty = false;     // the pending structural change reached disk
    histTypingMarked = false;   // the next keystroke opens a new undo step
    editorBaseline = snap;
    renderList();
    renderStatus();
    return true;
  }
  const html = getEditorBody();
  // Compare against the load-time baseline, NOT n.body: for a v1 note getEditorBody()
  // is canonical HTML while n.body is plain, so they would never match and every
  // merely-opened old note would migrate + resync. The baseline is that same HTML.
  if (!structureDirty && n.title === title && html === editorBaseline) {
    dirty = false;
    renderList();
    renderStatus();
    return false;
  }
  n.title = title;
  // Writes land on the ACTIVE PAGE for a paged note, on the note itself
  // otherwise - the only difference between the two shapes at save time.
  const tgt = activeBody(n);
  // Migration is edit-triggered: a still-legacy body whose text is unchanged (and
  // has no inline media) stays plain with no bodyV, so renaming an old note never
  // rewrites its body or forks it against a not-yet-upgraded device. "Unchanged"
  // is judged against the load-time baseline: the page shows the text as lines,
  // so its textContent no longer carries the newlines to compare with.
  if (editorPlainOrig !== null && !editorHasInlineMedia() && html === editorBaseline) {
    // body unchanged; leave the body / bodyV as-is (only the title moved)
  } else {
    tgt.body = html;
    tgt.bodyV = 2;
    editorPlainOrig = null;
  }
  n.mtime = Date.now();
  persistLocal().catch(e => { dirty = true; status("Save failed: " + e.message, true); renderStatus(); });
  dirty = false;
  structureDirty = false;
  histTypingMarked = false;
  editorBaseline = html;
  renderList();
  renderStatus();
  return true;
}

function flushSave() { clearTimeout(saveTimer); saveCurrent(); }

function manualSave() {
  clearTimeout(saveTimer);
  const wrote = saveCurrent();
  if (wrote) status("Saved " + new Date().toLocaleTimeString());
  else if (statusIsError) status("");
}

// Transient messages: non-errors auto-clear after 4s; errors persist until the
// next keystroke, save, or sync attempt; sticky ("Syncing...") never auto-clears.
let statusTimer = null, statusIsError = false;
function status(msg, err, sticky) {
  clearTimeout(statusTimer);
  $("status").textContent = msg;
  $("status").style.color = err ? "var(--bad)" : "var(--t3)";
  statusIsError = !!err;
  if (msg && !err && !sticky) statusTimer = setTimeout(() => { $("status").textContent = ""; }, 4000);
}

const ERR_LABEL = {
  offline: "Sync failed: offline",
  auth: "Sync failed: token rejected",
  ratelimit: "Sync failed: rate limited",
  conflict: "Sync failed: remote changed",
  pwmismatch: "Sync blocked: remote password mismatch",
  // The two repo-guard refusals: this copy has no repo configured yet, or it points at a public one.
  unset: "Sync off: no repo set",
  public: "Sync blocked: repo is public",
  other: "Sync failed",
};
const ERR_EXPLAIN = {
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

function classifySyncError(e) {
  let kind = "other";
  // A repo-guard refusal already names its own kind ("unset" or "public"), so it wins over the generic checks.
  if (e.guard) kind = e.guard;
  else if (e instanceof TypeError || navigator.onLine === false) kind = "offline";
  else if (e.status === 401 || e.status === 404) kind = "auth";
  else if (e.status === 403 && /rate.?limit/i.test(e.message)) kind = "ratelimit";
  else if (e.status === 409) kind = "conflict";
  return { at: Date.now(), httpStatus: e.status || null, kind, raw: e.message };
}

// count goes in a fixed-width span so 9 -> 10 cannot shove the neighbouring
// chip out from under the cursor.
function toggleChip(id, show, text, count) {
  const c = $(id);
  c.style.display = show ? "inline-block" : "none";
  if (text != null) {
    c.textContent = text;
    if (count != null) {
      c.appendChild(document.createTextNode(" ("));
      c.appendChild(mk("span", "n", String(count)));
      c.appendChild(document.createTextNode(")"));
    }
  }
}

// Single writer for chips, Save/Delete buttons, Last synced, banner, and the
// open detail panel. Every state transition funnels through here.
function renderStatus() {
  if (!vault) return;
  const sb = $("save");
  sb.disabled = !dirty || syncing || !!trashViewId;
  sb.textContent = dirty ? "Save" : (currentId ? "Saved" : "Save");
  sb.style.minWidth = "62px";   // label swaps Save/Saved; do not resize the title input
  // Second screen compares against the open note: with none open it could only do nothing.
  $("split-btn").disabled = !splitMode && (!currentId || !!trashViewId || syncing);

  const ls = $("last-synced");
  if (syncMeta.lastSyncedAt == null) {
    ls.textContent = "Never synced";
    ls.style.color = "var(--warn)";
  } else {
    const d = new Date(syncMeta.lastSyncedAt);
    const dOpts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) dOpts.year = "numeric";
    ls.textContent = "Last synced " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + ", " +
      d.toLocaleDateString(undefined, dOpts);
    ls.style.color = "var(--t3)";
  }

  const unsyncedN = unsyncedCount();   // notes + folders + trash + both deletion kinds
  toggleChip("chip-unsaved", dirty, "Unsaved content");
  renderUnsynced();   // its own section in the sidebar, above the trash
  toggleChip("chip-syncerr", !!lastSyncError, lastSyncError ? ERR_LABEL[lastSyncError.kind] : null);

  renderBanner();
  renderTrashBanner();

  if (panelOpen) {
    if (!dirty && unsyncedN === 0 && !lastSyncError && !pullBanner) closePanel();
    else renderDetail();
  }
}

// Shown only when a merge actually replaced or removed local content (the case
// the pre-merge snapshot exists for); a merge that only ADOPTS remote notes
// takes the snapshot silently, since nothing local was overwritten.
function bannerText() {
  return `Merged the repo vault (saved ${new Date(pullBanner.remoteSavedAt).toLocaleString()}): ` +
    `${pullBanner.replaced} local note(s) replaced by a newer remote version, ` +
    `${pullBanner.lost} removed, ${pullBanner.added} new from remote.`;
}
function renderBanner() {
  const b = $("pull-banner");
  if (!pullBanner) { b.style.display = "none"; return; }
  b.style.display = "flex";
  $("pull-banner-text").textContent = bannerText();
}

// Amber banner over the read-only trash view.
function renderTrashBanner() {
  const b = $("trash-banner");
  if (!trashViewId || !vault.trash[trashViewId]) { b.style.display = "none"; return; }
  b.style.display = "flex";
  const delAt = vault.trash[trashViewId].deletedAt || 0;
  const daysLeft = Math.max(0, 30 - Math.floor((Date.now() - delAt) / 86400e3));
  $("trash-banner-text").textContent = "In trash, deleted " + relTime(delAt) +
    " - deleted permanently in " + daysLeft + " day" + (daysLeft === 1 ? "" : "s");
  $("trash-restore").disabled = syncing;
  $("trash-purge").disabled = syncing;
}

function dismissBanner() {
  if (backupView) return;   // read-only: not even this localStorage write
  pullBanner = null;
  pullDiff = null;
  localStorage.removeItem(vkey("pullBanner"));
  renderStatus();
}
