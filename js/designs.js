// notes: Presets and page designs, including import and export of design files.
"use strict";

// ---------- Presets ----------
// A preset is a saved note skeleton: title template + the page layout (names and
// bodies). Stored in the vault so it syncs and is encrypted like everything else.
// Applying one never touches attachments - only title/body/pages.
const vaultPresets = () => (vault && vault.presets && typeof vault.presets === "object") ? vault.presets : {};
function presetFromNote(n, name, kind) {
  const ps = notePages(n);
  return {
    name, kind: kind || "content", mtime: Date.now(),
    title: n.title || "",
    pages: ps ? ps.map(p => ({ name: p.name, body: p.body || "", bodyV: p.bodyV }))
              : [{ name: null, body: n.body || "", bodyV: n.bodyV }],   // name:null = single-page preset
    // The images and videos come along: the bodies reference media by id, so
    // without these entries an applied preset would render "not on this device"
    // even though the bytes are right there. Ids are shared, not copied - the
    // ciphertext is refcounted (see mediaReferenced).
    media: (n.media || []).map(m => ({ ...m })),
  };
}
async function savePresetFromCurrent() {
  if (syncing || backupView || !currentId || !vault.notes[currentId]) return;
  flushSave();
  const n = vault.notes[currentId];
  const name = await promptModal({ title: "Save as preset",
    placeholder: "Preset name", value: n.title || "", confirmLabel: "Save preset" });
  if (!name || syncing || !vault.notes[currentId]) return;
  if (!vault.presets) vault.presets = {};
  vault.presets[crypto.randomUUID()] = presetFromNote(vault.notes[currentId], name);
  persistSafe(); renderStatus();
  status(`Preset "${name}" saved`);
}
// Replaces the note's content with the preset's. Confirmed when it would
// overwrite something, because this is not undoable.
async function applyPreset(pid) {
  const p = vaultPresets()[pid];
  if (!p || syncing || backupView || !currentId || !vault.notes[currentId]) return;
  flushSave();
  const n = vault.notes[currentId];
  const hasContent = noteBodies(n).some(b => (b.body || "").trim().length) || (n.title || "").trim().length;
  if (hasContent && !await confirmModal({
    title: `Apply preset "${p.name}"?`,
    body: "The preset's title and pages replace this note's current content. Attachments are kept. Ctrl+Z undoes it.",
    confirmLabel: "Apply preset", destructive: true,
  })) return;
  if (syncing || !vault.notes[currentId]) return;
  historyMark(currentId);
  const pages = Array.isArray(p.pages) && p.pages.length ? p.pages : [{ name: null, body: "" }];
  if (p.title) n.title = p.title;
  // Adopt the preset's attachments (by id) so its images and videos resolve.
  // Existing entries win, and duplicates are skipped.
  if (Array.isArray(p.media) && p.media.length) {
    if (!Array.isArray(n.media)) n.media = [];
    const have = new Set(n.media.map(m => m.id));
    for (const m of p.media) if (!have.has(m.id)) { n.media.push({ ...m }); have.add(m.id); }
  }
  if (pages.length === 1 && pages[0].name === null) {   // single-page preset
    delete n.pages;
    n.body = pages[0].body || "";
    n.bodyV = pages[0].bodyV === 2 ? 2 : undefined;
    if (n.bodyV !== 2) delete n.bodyV;
  } else {
    n.pages = pages.map((pg, i) => newPageFrom(pg, i));
    delete n.bodyV;
  }
  n.mtime = Date.now();
  currentPage = 0;
  persistSafe();
  openNote(currentId);            // reload the editor from the new content
  status(`Preset "${p.name}" applied`);
}
const newPageFrom = (pg, i) => ({ id: crypto.randomUUID(),
  name: pg.name || "Page " + (i + 1), body: pg.body || "", bodyV: pg.bodyV === 2 ? 2 : undefined,
  ...(SECTIONS.includes(pg.section) && pg.section !== "body" ? { section: pg.section } : {}) });

// ---------- Design presets ----------
// A design IS a note that lives in the "Designs" folder, so it is edited exactly
// like any other paged note - in the sheet view, which renders the real A4 page
// with the print stylesheet. What you lay out is literally what the PDF shows.
// Applying one copies its pages (and their images) onto the target note.
const designFolderId = () => Object.keys(vault.folders)
  .find(fid => (vault.folders[fid].name || "").trim().toLowerCase() === "designs") || null;
const designNoteIds = () => {
  const fid = designFolderId();
  return fid ? Object.keys(vault.notes).filter(id => vault.notes[id].folderId === fid) : [];
};
// ---------- Design import / export ----------
// A design travels as a small JSON file: page names, their part (title/body/
// final) and their markup. Plain text on purpose - it is a layout, not vault
// content, so it can be shared, edited by hand and kept in version control.
const DESIGN_FILE_KIND = "notes-design";
// A design file is PLAINTEXT on disk, so censored text must not travel in it:
// the characters (and any picture under the mark) are destroyed here and only
// the bar is kept, as blank space of the same coarse length bucket the PDF
// uses, so even the exact length stays behind. (The vault copy is untouched -
// only the exported file loses them.)
function stripCensoredForExport(body) {
  const holder = document.createElement("div");
  holder.appendChild(sanitizeBodyFragment(String(body || "")));
  normalizeLines(holder);
  for (const el of [...holder.querySelectorAll('[data-censor="1"]')]) {
    if (!holder.contains(el)) continue;   // inside a mark already blanked
    const n = el.textContent.length + el.querySelectorAll(".inline-media").length;
    el.textContent = " ".repeat(censorLenBucket(n));
  }
  return canonicalBody(holder);
}
function exportDesign(id) {
  const n = vault && vault.notes[id];
  if (!n) return;
  if (id === currentId) flushSave();
  const doc = {
    kind: DESIGN_FILE_KIND, v: 1,
    name: n.title || "Untitled design",
    pages: (notePages(n) || [{ name: "Page 1", body: n.body || "", bodyV: n.bodyV }])
      .map(p => ({ name: p.name || "Page", section: pageSection(p), body: stripCensoredForExport(p.body) })),
  };
  downloadPlain(safeName(doc.name) + ".design.json", "application/json",
    new TextEncoder().encode(JSON.stringify(doc, null, 2)));
  status(`Exported "${doc.name}"`);
}
// Everything in the file is untrusted: every page body goes through the SAME
// sanitizer as a synced note before it is stored, so an imported design cannot
// smuggle script, event handlers or remote references into the vault.
function importDesignDoc(doc) {
  if (!doc || doc.kind !== DESIGN_FILE_KIND || !Array.isArray(doc.pages) || !doc.pages.length) return null;
  const name = String(doc.name || "Imported design").slice(0, 120);
  const pages = doc.pages.slice(0, 60).map((p, i) => {
    const holder = document.createElement("div");
    holder.appendChild(sanitizeBodyFragment(String(p.body || "")));
    const sec = SECTIONS.includes(p.section) ? p.section : "body";
    return { id: crypto.randomUUID(), name: String(p.name || "Page " + (i + 1)).slice(0, 60),
      body: canonicalBody(holder), bodyV: 2, ...(sec !== "body" ? { section: sec } : {}) };
  });
  sortPagesBySection(pages);
  return { name, pages };
}
function importDesign() {
  if (syncing || backupView) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,application/json";
  inp.style.cssText = "position:fixed;left:-9999px";
  document.body.appendChild(inp);
  inp.addEventListener("change", async () => {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (!file) return;
    let doc = null;
    try { doc = JSON.parse(await file.text()); } catch { status("That file is not a design (bad JSON)", true); return; }
    const built = importDesignDoc(doc);
    if (!built) { status("That file is not a notes design", true); return; }
    if (syncing || backupView || !vault) return;
    flushSave();
    const fid = designFolderId() || createFolder("Designs");
    const id = crypto.randomUUID();
    vault.notes[id] = { title: built.name, body: "", color: null, folderId: fid,
      mtime: Date.now(), media: [], pages: built.pages };
    { const o = topOrderOfGroup(fid); if (o !== undefined) vault.notes[id].order = o; }
    revealFolder(fid);
    persistSafe();
    openNote(id);
    renderList(); renderStatus();
    status(`Imported "${built.name}" - ${built.pages.length} page(s)`);
  });
  inp.click();
}

async function newDesign() {
  if (syncing || backupView) return;
  const name = await promptModal({ title: "New design", placeholder: "Design name",
    confirmLabel: "Create" });
  if (!name || syncing) return;
  flushSave();
  const fid = designFolderId() || createFolder("Designs");
  const id = crypto.randomUUID();
  vault.notes[id] = { title: name, body: "", color: null, folderId: fid, mtime: Date.now(), media: [],
    pages: [{ id: crypto.randomUUID(), name: "Page 1", body: "", bodyV: 2 }] };
  { const o = topOrderOfGroup(fid); if (o !== undefined) vault.notes[id].order = o; }
  revealFolder(fid);
  persistSafe();
  openNote(id);
  renderList(); renderStatus();
  status("Design created - lay the page out exactly as you want the PDF");
}
async function applyDesign(designId) {
  const src = vault.notes[designId];
  if (!src || syncing || backupView || !currentId || !vault.notes[currentId] || currentId === designId) return;
  flushSave();
  const n = vault.notes[currentId];
  if (!await confirmModal({
    title: `Apply design "${src.title || "(untitled)"}"?`,
    body: "The design's pages replace this note's content. Its images come with it, and this note's own attachments are kept. This cannot be undone.",
    confirmLabel: "Apply design", destructive: true,
  })) return;
  if (syncing || !vault.notes[currentId]) return;
  const ps = notePages(src) || [{ name: "Page 1", body: src.body || "", bodyV: src.bodyV }];
  n.pages = ps.map((p, i) => newPageFrom(p, i));
  delete n.bodyV;
  if (!Array.isArray(n.media)) n.media = [];
  const have = new Set(n.media.map(m => m.id));
  for (const m of (src.media || [])) if (!have.has(m.id)) { n.media.push({ ...m }); have.add(m.id); }
  n.mtime = Date.now();
  currentPage = 0;
  persistSafe();
  openNote(currentId);
  renderAttachments();
  status(`Design "${src.title}" applied`);
}
function designItems() {
  const ids = designNoteIds().sort((a, b) => byName(vault.notes[a].title || "", vault.notes[b].title || ""));
  // Import sits at the top of the tab; each design carries its own actions,
  // export included, rather than a separate "export a design" list.
  const items = [{ label: "Import design from a file...", disabled: syncing, onClick: importDesign }];
  if (ids.length) items.push({ sep: true });
  for (const id of ids) items.push({
    label: vault.notes[id].title || "(untitled)",
    submenu: () => [
      { label: "Apply to this note", disabled: syncing || !currentId || id === currentId,
        onClick: () => applyDesign(id) },
      { label: "Export as a file...", onClick: () => exportDesign(id) },
      { sep: true },
      { label: "Open to edit", onClick: () => openNote(id) },
    ],
  });
  if (!ids.length) items.push({ label: "No designs yet", disabled: true });
  items.push({ sep: true });
  items.push({ label: "New design...", disabled: syncing, onClick: newDesign });
  items.push({ label: "Save this note as a design", disabled: syncing || !currentId, onClick: async () => {
    if (!currentId || !vault.notes[currentId]) return;
    flushSave();
    const fid = designFolderId() || createFolder("Designs");
    duplicateNote(currentId);                      // the copy becomes the design
    vault.notes[currentId].folderId = fid;         // duplicateNote opened the copy
    toPaged(vault.notes[currentId]);
    vault.notes[currentId].mtime = Date.now();
    revealFolder(fid);
    persistSafe();
    openNote(currentId);
    renderList(); renderStatus();
    status("Saved as a design - edit it in the Designs folder");
  } });
  return items;
}

function presetItems() {
  const ids = Object.keys(vaultPresets()).sort((a, b) =>
    byName(vaultPresets()[a].name || "", vaultPresets()[b].name || ""));
  const items = ids.map(pid => ({
    label: vaultPresets()[pid].name || "(unnamed)",
    disabled: syncing || !currentId,
    onClick: () => applyPreset(pid),
  }));
  if (!items.length) items.push({ label: "No presets yet", disabled: true });
  items.push({ sep: true });
  items.push({ label: "Save this note as a preset...", disabled: syncing || !currentId, onClick: savePresetFromCurrent });
  if (ids.length) items.push({ label: "Delete a preset...", disabled: syncing, submenu: () => ids.map(pid => ({
    label: vaultPresets()[pid].name || "(unnamed)", danger: true, disabled: syncing,
    onClick: async () => {
      if (!await confirmModal({ title: `Delete preset "${vaultPresets()[pid].name}"?`,
        body: "Notes already created from it are not affected.", confirmLabel: "Delete", destructive: true })) return;
      delete vault.presets[pid];
      persistSafe(); renderStatus();
    },
  })) });
  return items;
}

// ---- Rich text allowlist ----
// Formatting is stored as markup, so the sanitizer has to accept a little more
// than text+media. It stays a strict allowlist: these tags, and a `style`
// rebuilt declaration by declaration in sanitizeStyle(). Anything else (script,
// event handlers, url(), position, background images) never survives, because
// the style string is REBUILT rather than copied.
// Declared HERE, above the toolbar wiring that reads them at load: a const used
// before its initializer throws and takes the rest of the script down with it.
const INLINE_FMT_TAGS = new Map([["B", "b"], ["STRONG", "b"], ["I", "i"], ["EM", "i"],
  ["U", "u"], ["S", "s"], ["STRIKE", "s"], ["SPAN", "span"]]);
const FONT_CHOICES = ["Default", "Georgia", "Times New Roman", "Arial", "Helvetica",
  "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Consolas"];
const FONT_ALLOW = new Set(FONT_CHOICES.slice(1).map(f => f.toLowerCase()));
const SIZE_CHOICES = ["8pt", "9pt", "10pt", "11pt", "12pt", "14pt", "16pt", "18pt", "20pt",
  "24pt", "28pt", "32pt", "40pt", "48pt", "60pt", "72pt", "96pt"];
const ALIGN_OK = new Set(["left", "center", "right"]);
// The toolbar's alignment buttons and the alignment each applies to a paragraph.
const ALIGN_CMDS = { justifyLeft: "left", justifyCenter: "center", justifyRight: "right", justifyFull: "justify" };
const LIST_TAGS = new Set(["UL", "OL", "LI"]);
const TABLE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH"]);
// Links: only schemes that cannot execute anything. javascript:, data: and
// blob: are rejected outright, so a pasted or synced note can never carry one.
function safeHref(href) {
  const h = String(href || "").trim();
  // Scheme allowlist first: javascript:, data: and blob: can execute.
  if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(h)) return null;
  // Then reject anything that could break out of the attribute or smuggle markup.
  if (/[\s"'<>`]/.test(h) || h.includes("\\")) return null;
  return h.slice(0, 2000);
}
// The document-editor palette: greys, then the pure hues, then five tint/shade
// rows of each hue. Ten columns, so it reads as a grid like any word processor.
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
// Custom colours you have picked, newest first. Hex strings only - no secrets,
// so plain localStorage is fine.
let customColors = [];
try { const c = JSON.parse(localStorage.getItem("customColors")); if (Array.isArray(c)) customColors = c.slice(0, 10); } catch {}
function rememberCustom(hex) {
  customColors = [hex, ...customColors.filter(c => c !== hex)].slice(0, 10);
  try { localStorage.setItem("customColors", JSON.stringify(customColors)); } catch {}
}
