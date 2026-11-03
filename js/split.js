// notes: The second screen (split edit).
"use strict";

// ---------- Second screen (split edit) ----------
// Left = the version as it was when you entered (a frozen reference you can read
// and copy from), right = the live editor. "Save edit" commits the right side
// only; the left deliberately does NOT follow, so a long rewrite always has the
// original beside it. It refreshes when you leave and come back.
let splitMode = false;
let splitRef = null;   // { pages, label } captured on entry, never written back
let splitSnapshot = null;   // the whole note as it was on entry, for "cancel the changes"

function renderPrevPane() {
  const head = $("prev-head"), box = $("prev-body");
  box.innerHTML = "";
  if (!splitRef) { head.textContent = "Previous"; return; }
  const pages = splitRef.pages || [];
  head.textContent = "Previous" + (pages.length > 1 ? ` - ${pages.length} pages` : splitRef.label ? " - " + splitRef.label : "");
  // A paged note keeps its page format here: the reference is the same stack of
  // sheets you are editing, scrollable, not just the page you happen to be on.
  pages.forEach((p, i) => {
    let host = box;
    if (splitRef.paged) {
      const sheet = mk("div", "sheet prev-sheet");
      const label = mk("div", "sheet-label");
      label.appendChild(mk("span", "nm", p.name || "Page " + (i + 1)));
      label.appendChild(mk("span", "n", (i + 1) + " / " + pages.length));
      sheet.appendChild(label);
      host = mk("div", "sheet-body");
      sheet.appendChild(host);
      box.appendChild(sheet);
    }
    host.appendChild(bodyFragment(p.body, p.bodyV));
  });
  // Not draggable here: these wrappers belong to a frozen snapshot, and the
  // editor's reposition handler would try to move a node that is not in it.
  box.querySelectorAll("span.inline-media").forEach(sp => { sp.draggable = false; });
  hydratePrevMedia();
}
// Paints the reference pane's attachments through the SAME decrypt FIFO, URL
// cache and generation guard as the editor, so an image decrypts once and both
// panes share it. Videos/PDFs/files stay click-to-open tiles.
function hydratePrevMedia() {
  const wraps = [...$("prev-body").querySelectorAll("span.inline-media")];
  if (!wraps.length || !vault) return;
  const gen = editorSeq;             // a note switch or a lock invalidates these too
  const n = currentId ? vault.notes[currentId] : null;
  const metaFor = mid => ((n && n.media) || []).find(m => m.id === mid) || null;
  idbKeys().then(keys => {
    if (gen !== editorSeq || !vault) return;
    const have = new Set(keys);
    for (const w of wraps) {
      if (!w.isConnected) continue;
      const mid = w.getAttribute("data-mid"), kind = w.getAttribute("data-kind");
      const meta = metaFor(mid);
      if (meta) applyInlineSize(w, meta.w, meta.h);
      if (!have.has(mid) || !meta) { setInlineState(w, "missing"); continue; }
      if (kind !== "image") {
        setInlineState(w, kind);
        w.onclick = () => openInlineMedia(w, mid, meta, kind);
        continue;
      }
      if (!isRenderableImage(meta.mime)) { setInlineState(w, "blocked"); continue; }
      queueInlineImage(gen, w, mid, meta.mime, meta);
    }
  }).catch(() => { for (const w of wraps) if (w.isConnected) setInlineState(w, "missing"); });
}
function splitLabel(n) {
  const ps = notePages(n);
  return ps ? (ps[Math.min(currentPage, ps.length - 1)].name || "page") : "";
}
function enterSplit() {
  if (splitMode || syncing || backupView || trashViewId || !currentId || !vault.notes[currentId]) return;
  flushSave();                       // the reference is the SAVED text, not a half-typed buffer
  const n = vault.notes[currentId];
  if (!n) return;
  // Capture EVERY page, so the reference scrolls through the whole document
  // instead of freezing on one page.
  splitRef = { paged: isPaged(n), pages: noteBodies(n).map(b => ({ ...b })), label: splitLabel(n) };
  // A full snapshot of the note as it was on entry. "Cancel the changes" puts
  // this back wholesale, which is what makes the structural buttons below
  // (format switch, apply design) safely undoable and not just the typing.
  splitSnapshot = JSON.parse(JSON.stringify({ title: n.title || "", body: n.body || "", bodyV: n.bodyV,
    pages: n.pages || null, media: n.media || [], designId: n.designId || null }));
  splitMode = true;
  document.body.classList.add("split-edit");
  renderPrevPane();
  fitSheets();                       // the pane just got narrower; the PAGE did not
  updateSplitButtons();
  renderStatus();
  status("Second screen on - autosave is paused, use Save edit (the left pane stays frozen)");
}
async function exitSplit(force) {
  if (!splitMode) return true;
  // Forced exits are teardown (note switch, trash view, lock), never a discard:
  // autosave is paused in this mode, so commit the buffer or it is simply lost.
  if (force && dirty && currentId && vault && !backupView) flushSave();
  if (!force && dirty && currentId) {
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
    if (choice === "stay") return false;
    if (choice === "save") flushSave();
    else if (choice === "discard") restoreSplitSnapshot();
  }
  splitMode = false;
  splitRef = null;
  splitSnapshot = null;
  document.body.classList.remove("split-edit");
  $("prev-body").innerHTML = "";
  fitSheets();                       // full width again: show the page bigger
  renderStatus();
  return true;
}
// Reload the open note into the editor WITHOUT going through openNote(), which
// force-exits the second screen (and with it the snapshot these buttons depend
// on). Same repaint, no teardown.
