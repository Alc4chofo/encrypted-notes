/*
 * designs.js - presets and page designs (including design files), the
 * formatting allowlist, and the colour palette.
 *
 * A preset is a saved note skeleton: a title and the pages (names and
 * bodies). Presets are stored in the vault, so they sync and are encrypted
 * like everything else. Applying one changes only the title and the pages;
 * attachments are kept.
 *
 * A design is a note in the "Designs" folder, so it is edited like any
 * other paged note, in the sheet view, which draws the real A4 page with the
 * print stylesheet: what is laid out is what the PDF shows. Applying one
 * wraps the note in it (designedPages, history.js): the note's own writing
 * goes where the design says {content}, never thrown away.
 *
 * A design travels as a small JSON file of page names, parts and markup. It
 * is plain text on purpose (a layout, not vault content), so it can be
 * shared, edited by hand and kept in version control. Because it is plain on
 * disk, censored text never goes into it, and everything in an imported file
 * is untrusted and goes through the same sanitiser as a synced note.
 *
 * The allowlist: formatting is stored as markup, so the sanitiser accepts a
 * little more than text and attachments, but it stays a strict list: these
 * tags, and a style rebuilt declaration by declaration (sanitizeStyle,
 * history.js). Script, event handlers, url(), position and background images
 * never survive, because the style is rebuilt rather than copied. Links
 * allow only schemes that cannot run anything.
 *
 * Main functions: savePresetFromCurrent, applyPreset, presetItems,
 * newDesign, applyDesign, designItems, exportDesign, importDesign,
 * importDesignDoc, stripCensoredForExport, safeHref, rememberCustom.
 * Auxiliary functions: vaultPresets, presetFromNote, newPageFrom,
 * designFolderId, designNoteIds.
 *
 * Complexity: applying a preset or a design is O(n) in the note's pages and
 * text; importing or exporting a design is O(n) in its markup.
 */
"use strict";

// ---------- State ----------

// What a design file says it is.
const DESIGN_FILE_KIND = "notes-design";

// ---------- Presets ----------

/**
 * Saves the open note as a preset, under a name asked for (the note's title
 * by default).
 *
 * Used by: this file (presetItems).
 * Uses: flushSave, renderStatus and status (pagination.js), promptModal
 * (modal.js), presetFromNote, persistSafe (vault.js).
 * Complexity: O(n) in the note.
 */
async function savePresetFromCurrent() {
  if (syncing || backupView || !currentId || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  const note = vault.notes[currentId];
  const name = await promptModal({ title: "Save as preset",
    placeholder: "Preset name", value: note.title || "", confirmLabel: "Save preset" });
  if (!name || syncing || !vault.notes[currentId]) {
    return;
  }
  if (!vault.presets) {
    vault.presets = {};
  }
  vault.presets[crypto.randomUUID()] = presetFromNote(vault.notes[currentId], name);
  persistSafe();
  renderStatus();
  status(`Preset "${name}" saved`);
}

/**
 * Replaces the open note's title and pages with a preset's, asking first
 * when the note has content. The preset's attachments join the note's (by
 * id; existing entries win, duplicates are skipped), so its pictures can be
 * shown. One undo step.
 *
 * Used by: this file (presetItems).
 * Uses: vaultPresets, flushSave, openNote and status (pagination.js),
 * noteBodies (content.js), confirmModal (modal.js), historyMark
 * (history.js), newPageFrom, persistSafe (vault.js).
 * Complexity: O(n) in the note and the preset.
 */
async function applyPreset(pid) {
  const preset = vaultPresets()[pid];
  if (!preset || syncing || backupView || !currentId || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  const note = vault.notes[currentId];
  const hasContent = noteBodies(note).some(entry => (entry.body || "").trim().length) ||
    (note.title || "").trim().length;
  if (hasContent && !await confirmModal({
    title: `Apply preset "${preset.name}"?`,
    body: "The preset's title and pages replace this note's current content. Attachments are kept. Ctrl+Z undoes it.",
    confirmLabel: "Apply preset", destructive: true,
  })) {
    return;
  }
  if (syncing || !vault.notes[currentId]) {
    return;
  }

  historyMark(currentId);
  const pages = Array.isArray(preset.pages) && preset.pages.length ? preset.pages : [{ name: null, body: "" }];
  if (preset.title) {
    note.title = preset.title;
  }
  if (Array.isArray(preset.media) && preset.media.length) {
    if (!Array.isArray(note.media)) {
      note.media = [];
    }
    const have = new Set(note.media.map(item => item.id));
    for (const item of preset.media) {
      if (!have.has(item.id)) {
        note.media.push({ ...item });
        have.add(item.id);
      }
    }
  }
  if (pages.length === 1 && pages[0].name === null) {
    // A one-page preset.
    delete note.pages;
    note.body = pages[0].body || "";
    note.bodyV = pages[0].bodyV === 2 ? 2 : undefined;
    if (note.bodyV !== 2) {
      delete note.bodyV;
    }
  } else {
    note.pages = pages.map((page, i) => newPageFrom(page, i));
    delete note.bodyV;
  }
  note.mtime = Date.now();
  currentPage = 0;
  persistSafe();
  // The editor loads the new content.
  openNote(currentId);
  status(`Preset "${preset.name}" applied`);
}

/**
 * The Presets menu: every preset (by name) to apply, "Save this note as a
 * preset...", and "Delete a preset..." (notes made from one are not affected).
 *
 * Used by: notes.js (noteMenu).
 * Uses: vaultPresets, compareByName (sidebar.js), applyPreset,
 * savePresetFromCurrent, confirmModal (modal.js), persistSafe (vault.js),
 * renderStatus (pagination.js).
 * Complexity: O(k log k) in the presets.
 */
function presetItems() {
  const ids = Object.keys(vaultPresets()).sort((a, b) =>
    compareByName(vaultPresets()[a].name || "", vaultPresets()[b].name || ""));
  const items = ids.map(pid => ({
    label: vaultPresets()[pid].name || "(unnamed)",
    disabled: syncing || !currentId,
    onClick: () => applyPreset(pid),
  }));
  if (!items.length) {
    items.push({ label: "No presets yet", disabled: true });
  }
  items.push({ sep: true });
  items.push({ label: "Save this note as a preset...", disabled: syncing || !currentId, onClick: savePresetFromCurrent });
  if (ids.length) {
    items.push({
      label: "Delete a preset...",
      disabled: syncing,
      submenu: () => ids.map(pid => ({
        label: vaultPresets()[pid].name || "(unnamed)",
        danger: true,
        disabled: syncing,
        onClick: async () => {
          if (!await confirmModal({ title: `Delete preset "${vaultPresets()[pid].name}"?`,
            body: "Notes already created from it are not affected.", confirmLabel: "Delete", destructive: true })) {
            return;
          }
          delete vault.presets[pid];
          persistSafe();
          renderStatus();
        },
      })),
    });
  }
  return items;
}

// ---------- Designs ----------

/**
 * Makes a new, empty one-page design in the Designs folder (made if there
 * is none), under a name asked for, and opens it.
 *
 * Used by: this file (designItems).
 * Uses: promptModal (modal.js), flushSave, openNote, renderStatus and status
 * (pagination.js), designFolderId, createFolder (notes.js), topOrderOfGroup,
 * revealFolder and renderList (sidebar.js), persistSafe (vault.js).
 * Complexity: O(n) over the folder's notes, for the order.
 */
async function newDesign() {
  if (syncing || backupView) {
    return;
  }
  const name = await promptModal({ title: "New design", placeholder: "Design name",
    confirmLabel: "Create" });
  if (!name || syncing) {
    return;
  }
  flushSave();
  const folderId = designFolderId() || createFolder("Designs");
  const id = crypto.randomUUID();
  vault.notes[id] = { title: name, body: "", color: null, folderId, mtime: Date.now(), media: [],
    pages: [{ id: crypto.randomUUID(), name: "Page 1", body: "", bodyV: 2 }] };
  // The new design goes to the top of the folder.
  {
    const order = topOrderOfGroup(folderId);
    if (order !== undefined) {
      vault.notes[id].order = order;
    }
  }
  revealFolder(folderId);
  persistSafe();
  openNote(id);
  renderList();
  renderStatus();
  status("Design created - lay the page out exactly as you want the PDF");
}

/**
 * Wraps the open note in a design, after asking: the note's writing goes
 * where the design has {content}, between its title and closing pages. The
 * design's pictures come with it and the note's own attachments are kept.
 * One undo step.
 *
 * Used by: this file (designItems).
 * Uses: flushSave, openNote and status (pagination.js), confirmModal
 * (modal.js), historyMark, designedPages and adoptDesignMedia (history.js),
 * persistSafe (vault.js), renderAttachments (attachments.js).
 * Complexity: O(n) in the note and the design.
 */
async function applyDesign(designId) {
  const design = vault.notes[designId];
  if (!design || syncing || backupView || !currentId || !vault.notes[currentId] || currentId === designId) {
    return;
  }
  flushSave();
  if (!await confirmModal({
    title: `Apply design "${design.title || "(untitled)"}"?`,
    body: "What this note says goes where the design has {content}, between its title and closing pages. Its images come with it, and this note's own attachments are kept. Ctrl+Z undoes it.",
    confirmLabel: "Apply design",
  })) {
    return;
  }
  const note = vault.notes[currentId];
  if (syncing || !note || !vault.notes[designId]) {
    return;
  }
  historyMark(currentId);
  note.pages = designedPages(note, design).pages;
  note.designId = designId;
  delete note.bodyV;
  adoptDesignMedia(note, design);
  note.mtime = Date.now();
  currentPage = 0;
  persistSafe();
  openNote(currentId);
  renderAttachments();
  status(`Design "${design.title}" applied`);
}

/**
 * The Designs menu: "Import design from a file..." at the top, then each
 * design (by name) with its own actions (apply to this note, export as a
 * file, open to edit), then "New design..." and "Save this note as a
 * design" (a copy of the note goes into the Designs folder, as pages).
 *
 * Used by: notes.js (noteMenu).
 * Uses: designNoteIds, compareByName, revealFolder and renderList
 * (sidebar.js), importDesign, applyDesign, exportDesign, openNote, flushSave,
 * renderStatus and status (pagination.js), newDesign, designFolderId,
 * createFolder (notes.js), duplicateNote and toPaged (content.js), persistSafe (vault.js).
 * Complexity: O(k log k) in the designs.
 */
function designItems() {
  const ids = designNoteIds().sort((a, b) =>
    compareByName(vault.notes[a].title || "", vault.notes[b].title || ""));
  const items = [{ label: "Import design from a file...", disabled: syncing, onClick: importDesign }];
  if (ids.length) {
    items.push({ sep: true });
  }
  for (const id of ids) {
    items.push({
      label: vault.notes[id].title || "(untitled)",
      submenu: () => [
        { label: "Apply to this note", disabled: syncing || !currentId || id === currentId,
          onClick: () => applyDesign(id) },
        { label: "Export as a file...", onClick: () => exportDesign(id) },
        { sep: true },
        { label: "Open to edit", onClick: () => openNote(id) },
      ],
    });
  }
  if (!ids.length) {
    items.push({ label: "No designs yet", disabled: true });
  }
  items.push({ sep: true });
  items.push({ label: "New design...", disabled: syncing, onClick: newDesign });
  items.push({
    label: "Save this note as a design",
    disabled: syncing || !currentId,
    onClick: async () => {
      if (!currentId || !vault.notes[currentId]) {
        return;
      }
      flushSave();
      const folderId = designFolderId() || createFolder("Designs");
      // The copy becomes the design: duplicateNote opens it.
      duplicateNote(currentId);
      vault.notes[currentId].folderId = folderId;
      toPaged(vault.notes[currentId]);
      vault.notes[currentId].mtime = Date.now();
      revealFolder(folderId);
      persistSafe();
      openNote(currentId);
      renderList();
      renderStatus();
      status("Saved as a design - edit it in the Designs folder");
    },
  });
  return items;
}

// ---------- Design files ----------

/**
 * Saves a design as a .design.json file: its name, and each page's name,
 * part and markup, with censored text destroyed (stripCensoredForExport).
 *
 * Used by: this file (designItems).
 * Uses: flushSave and status (pagination.js), notePages and pageSection
 * (content.js), stripCensoredForExport, downloadPlain (attachments.js), safeName (pdf.js).
 * Complexity: O(n) in the design's markup.
 */
function exportDesign(id) {
  const note = vault && vault.notes[id];
  if (!note) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }
  const design = {
    kind: DESIGN_FILE_KIND, v: 1,
    name: note.title || "Untitled design",
    pages: (notePages(note) || [{ name: "Page 1", body: note.body || "", bodyV: note.bodyV }])
      .map(page => ({ name: page.name || "Page", section: pageSection(page), body: stripCensoredForExport(page.body) })),
  };
  downloadPlain(safeName(design.name) + ".design.json", "application/json",
    new TextEncoder().encode(JSON.stringify(design, null, 2)));
  status(`Exported "${design.name}"`);
}

/**
 * Asks for a design file and adds it as a new design in the Designs folder
 * (made if there is none), then opens it. A file that is not JSON, or not a
 * design, is refused with a message.
 *
 * Used by: this file (designItems).
 * Uses: status, flushSave, openNote and renderStatus (pagination.js),
 * importDesignDoc, designFolderId, createFolder (notes.js), topOrderOfGroup,
 * revealFolder and renderList (sidebar.js), persistSafe (vault.js).
 * Complexity: O(n) in the file.
 */
function importDesign() {
  if (syncing || backupView) {
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.cssText = "position:fixed;left:-9999px";
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) {
      return;
    }
    let design = null;
    try {
      design = JSON.parse(await file.text());
    } catch {
      status("That file is not a design (bad JSON)", true);
      return;
    }
    const built = importDesignDoc(design);
    if (!built) {
      status("That file is not a notes design", true);
      return;
    }
    if (syncing || backupView || !vault) {
      return;
    }
    flushSave();
    const folderId = designFolderId() || createFolder("Designs");
    const id = crypto.randomUUID();
    vault.notes[id] = { title: built.name, body: "", color: null, folderId,
      mtime: Date.now(), media: [], pages: built.pages };
    // The imported design goes to the top of the folder.
    {
      const order = topOrderOfGroup(folderId);
      if (order !== undefined) {
        vault.notes[id].order = order;
      }
    }
    revealFolder(folderId);
    persistSafe();
    openNote(id);
    renderList();
    renderStatus();
    status(`Imported "${built.name}" - ${built.pages.length} page(s)`);
  });
  input.click();
}

/**
 * A design file's content as { name, pages }, or null when it is not a
 * design. Everything in it is untrusted: every page body goes through the
 * same sanitiser as a synced note before it is kept, so a design file cannot
 * bring script, event handlers or remote references into the vault. At most
 * 60 pages; names are cut to 120 and 60 characters.
 *
 * Used by: this file (importDesign).
 * Uses: sanitizeBodyFragment (history.js), canonicalBody (lines.js),
 * SECTIONS and sortPagesBySection (content.js).
 * Complexity: O(n) in the file's markup.
 */
function importDesignDoc(design) {
  if (!design || design.kind !== DESIGN_FILE_KIND || !Array.isArray(design.pages) || !design.pages.length) {
    return null;
  }
  const name = String(design.name || "Imported design").slice(0, 120);
  const pages = design.pages.slice(0, 60).map((page, i) => {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeBodyFragment(String(page.body || "")));
    const section = SECTIONS.includes(page.section) ? page.section : "body";
    return { id: crypto.randomUUID(), name: String(page.name || "Page " + (i + 1)).slice(0, 60),
      body: canonicalBody(holder), bodyV: 2, ...(section !== "body" ? { section } : {}) };
  });
  sortPagesBySection(pages);
  return { name, pages };
}

/**
 * A body with its censored text destroyed, for a design file (plain on
 * disk). Each mark keeps only blank space of the same coarse length bucket
 * the PDF uses, so even the exact length stays behind; a picture under a
 * mark goes too. The vault's copy is untouched.
 *
 * Used by: this file (exportDesign).
 * Uses: sanitizeBodyFragment (history.js), normalizeLines and canonicalBody
 * (lines.js), censorLenBucket (pdf.js).
 * Complexity: O(n) in the body.
 */
function stripCensoredForExport(body) {
  const holder = document.createElement("div");
  holder.appendChild(sanitizeBodyFragment(String(body || "")));
  normalizeLines(holder);
  for (const el of [...holder.querySelectorAll('[data-censor="1"]')]) {
    // Inside a mark already blanked.
    if (!holder.contains(el)) {
      continue;
    }
    const length = el.textContent.length + el.querySelectorAll(".inline-media").length;
    // Non-breaking spaces, which HTML never collapses, so the gap keeps its width.
    el.textContent = "\u00a0".repeat(censorLenBucket(length));
  }
  return canonicalBody(holder);
}

// ---------- The formatting allowlist ----------

// Declared here, before the toolbar wiring that reads them on load: a const
// used before its line has run throws, and takes the rest of the script down.
const INLINE_FMT_TAGS = new Map([["B", "b"], ["STRONG", "b"], ["I", "i"], ["EM", "i"],
  ["U", "u"], ["S", "s"], ["STRIKE", "s"], ["SPAN", "span"]]);
const FONT_CHOICES = ["Default", "Georgia", "Times New Roman", "Arial", "Helvetica",
  "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Consolas"];
const FONT_ALLOW = new Set(FONT_CHOICES.slice(1).map(font => font.toLowerCase()));
const SIZE_CHOICES = ["8pt", "9pt", "10pt", "11pt", "12pt", "14pt", "16pt", "18pt", "20pt",
  "24pt", "28pt", "32pt", "40pt", "48pt", "60pt", "72pt", "96pt"];
const ALIGN_OK = new Set(["left", "center", "right"]);

// The toolbar's alignment buttons and the alignment each gives a paragraph.
const ALIGN_CMDS = { justifyLeft: "left", justifyCenter: "center", justifyRight: "right", justifyFull: "justify" };

const LIST_TAGS = new Set(["UL", "OL", "LI"]);
const TABLE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH"]);

/**
 * A link address if it is safe to keep, else null. Only http, https, mailto
 * and tel are allowed: javascript:, data: and blob: can run something, so a
 * pasted or synced note can never carry one. Anything that could break out
 * of the attribute or bring in markup (spaces, quotes, < > `, backslashes)
 * is refused too, and the address is cut to 2000 characters.
 *
 * Used by: toolbar.js (the link button and Ctrl+click, on load), lines.js
 * (serializeBodyInto), history.js (sanitizeBodyInto).
 * Uses: nothing.
 * Complexity: O(n) in the address.
 */
function safeHref(href) {
  const text = String(href || "").trim();
  if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(text)) {
    return null;
  }
  if (/[\s"'<>`]/.test(text) || text.includes("\\")) {
    return null;
  }
  return text.slice(0, 2000);
}

// ---------- Colours ----------

// The palette, as in a word processor: greys, then the pure hues, then five
// rows of tints and shades of each. Ten columns.
const PALETTE_ROWS = [
  ["#000000","#434343","#666666","#999999","#b7b7b7","#cccccc","#d9d9d9","#efefef","#f3f3f3","#ffffff"],
  ["#980000","#ff0000","#ff9900","#ffff00","#00ff00","#00ffff","#4a86e8","#0000ff","#9900ff","#ff00ff"],
  ["#e6b8af","#f4cccc","#fce5cd","#fff2cc","#d9ead3","#d0e0e3","#c9daf8","#cfe2f3","#d9d2e9","#ead1dc"],
  ["#dd7e6b","#ea9999","#f9cb9c","#ffe599","#b6d7a8","#a2c4c9","#a4c2f4","#9fc5e8","#b4a7d6","#d5a6bd"],
  ["#cc4125","#e06666","#f6b26b","#ffd966","#93c47d","#76a5af","#6d9eeb","#6fa8dc","#8e7cc3","#c27ba0"],
  ["#a61c00","#cc0000","#e69138","#f1c232","#6aa84f","#45818e","#3c78d8","#3d85c6","#674ea7","#a64d79"],
  ["#85200c","#990000","#b45f06","#bf9000","#38761d","#134f5c","#1155cc","#0b5394","#351c75","#741b47"],
  ["#5b0f00","#660000","#783f04","#7f6000","#274e13","#0c343d","#1c4587","#073763","#20124d","#4c1130"],
];

// The custom colours picked, newest first, at most ten. Hex strings only (no
// secrets), so plain localStorage is fine.
let customColors = [];
try {
  const saved = JSON.parse(localStorage.getItem("customColors"));
  if (Array.isArray(saved)) {
    customColors = saved.slice(0, 10);
  }
} catch {}

/**
 * Puts a colour first among the custom colours (at most ten) and remembers them.
 *
 * Used by: toolbar.js (openColourEditor, "Use colour").
 * Uses: nothing.
 * Complexity: O(1) (ten colours at most).
 */
function rememberCustom(hex) {
  customColors = [hex, ...customColors.filter(colour => colour !== hex)].slice(0, 10);
  try {
    localStorage.setItem("customColors", JSON.stringify(customColors));
  } catch {}
}

// =================== Auxiliary functions ===================

/** The vault's presets, by id (an empty object when there are none). Complexity: O(1). */
function vaultPresets() {
  return (vault && vault.presets && typeof vault.presets === "object") ? vault.presets : {};
}

/**
 * A preset made from a note: its title, its pages (a one-page note gives one
 * page named null) and its attachment entries. The attachments come along
 * because the bodies name them by id: without the entries an applied preset
 * would show "not on this device" though the bytes are right there. Ids are
 * shared, not copied (mediaReferenced counts every user). Complexity: O(p).
 */
function presetFromNote(note, name, kind) {
  const pages = notePages(note);
  return {
    name, kind: kind || "content", mtime: Date.now(),
    title: note.title || "",
    pages: pages ? pages.map(page => ({ name: page.name, body: page.body || "", bodyV: page.bodyV }))
              : [{ name: null, body: note.body || "", bodyV: note.bodyV }],
    media: (note.media || []).map(item => ({ ...item })),
  };
}

/** A note page made from a preset's or design's page, with a fresh id. Also used by history.js. Complexity: O(1). */
function newPageFrom(page, i) {
  return { id: crypto.randomUUID(),
    name: page.name || "Page " + (i + 1), body: page.body || "", bodyV: page.bodyV === 2 ? 2 : undefined,
    ...(SECTIONS.includes(page.section) && page.section !== "body" ? { section: page.section } : {}) };
}

/** The id of the folder named "Designs" (any case), or null. Complexity: O(f) over the folders. */
function designFolderId() {
  return Object.keys(vault.folders)
    .find(folderId => (vault.folders[folderId].name || "").trim().toLowerCase() === "designs") || null;
}

/** The ids of the notes in the Designs folder. Also used by history.js. Complexity: O(n) over the notes. */
function designNoteIds() {
  const folderId = designFolderId();
  return folderId ? Object.keys(vault.notes).filter(id => vault.notes[id].folderId === folderId) : [];
}
