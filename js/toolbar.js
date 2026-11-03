// notes: The formatting toolbar, colours, highlights, links and the custom colour editor.
"use strict";

// ---------- Formatting toolbar ----------
// execCommand is deprecated but it is still the only built-in that edits a
// contenteditable selection across browsers, and everything it produces is run
// back through the sanitizer on save, so it cannot introduce anything the
// allowlist would not accept anyway.
let lastFmtRange = null;   // the selection is lost when a toolbar control takes focus
function rememberSelection() {
  const r = currentEditorRange();
  if (r) lastFmtRange = r;
}
const sameRange = (a, b) => a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer && a.endOffset === b.endOffset;
function restoreSelection() {
  // Still in the text, exactly where it was left (toolbar buttons never take
  // focus): leave the selection as it is. Setting it again, even to the same
  // place, makes the browser drop the formats waiting at the caret, so B then
  // I typed italic only, and B then Censor typed censored text that was not
  // bold. Anything else gets the remembered selection back, including focus
  // returning from a dialog, which puts the caret at the top of the note.
  const live = currentEditorRange();
  const liveSurf = live && surfaceOfNode(live.commonAncestorContainer);
  if (liveSurf && document.activeElement === liveSurf && lastFmtRange && sameRange(live, lastFmtRange)) return liveSurf;
  if (!lastFmtRange || !surfaceOfNode(lastFmtRange.commonAncestorContainer)) return null;
  const surf = surfaceOfNode(lastFmtRange.commonAncestorContainer);
  surf.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(lastFmtRange);
  return surf;
}
// Each formatting change is an undo step of its own: what is on screen is
// committed and marked first, so Ctrl+Z takes back the formatting alone rather
// than the typing before it too. (In the second screen nothing is committed
// before Save edit, so there it stays part of the edit around it.)
function markFormatStep() {
  if (!currentId || splitMode || trashViewId || backupView || !vault || !vault.notes[currentId]) return;
  flushSave();
  historyMark(currentId);
}
function runFmt(cmd, value) {
  if (trashViewId || backupView || syncing) return;
  const surf = restoreSelection();
  if (!surf) { status("Put the cursor in the text first", true); return; }
  if (!window.getSelection().isCollapsed) markFormatStep();
  try {
    document.execCommand("styleWithCSS", false, true);   // spans with style, never <font>
    document.execCommand(cmd, false, value);
  } catch {}
  rememberSelection();
  markDirtyFromFormatting();
  syncFmtState();
}
// Formatting fires no 'input' event in every browser, so mark the buffer dirty
// through the same path typing uses.
function markDirtyFromFormatting() {
  if (trashViewId || backupView || !currentId) return;
  if (!dirty) { dirty = true; renderList(); }
  if (!splitMode) { clearTimeout(saveTimer); saveTimer = setTimeout(saveCurrent, 400); }
  renderStatus();
}
// The toolbar mirrors the caret: pressed buttons for the formats in effect
// there, the paragraph's alignment, the censor state typing would get, and the
// font and size of the text at the caret in the two lists.
function syncFmtState() {
  const r = currentEditorRange();
  const surf = r ? surfaceOfNode(r.startContainer) : null;
  for (const b of $("fmt-bar").querySelectorAll("button[data-cmd]")) {
    const cmd = b.dataset.cmd;
    let on = false;
    if (ALIGN_CMDS[cmd]) on = !!surf && caretAlign(r, surf) === ALIGN_CMDS[cmd];
    else if (cmd !== "removeFormat") { try { on = !!surf && document.queryCommandState(cmd); } catch {} }
    b.classList.toggle("on", on);
    if (cmd !== "removeFormat") b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const censorOn = !!surf && censorStateAt(r, surf);
  $("fmt-censor").classList.toggle("on", censorOn);
  $("fmt-censor").setAttribute("aria-pressed", censorOn ? "true" : "false");
  syncFontLists(r, surf);
}
// The font and size lists show what the text at the caret uses ("Default" and
// "Size" when it uses the page's own).
function syncFontLists(r, surf) {
  const fsel = $("fmt-font"), ssel = $("fmt-size");
  if (!surf || document.activeElement === fsel || document.activeElement === ssel) return;
  const { fam, size } = fontAt(r, surf);
  fsel.value = fam;
  ssel.value = size;
}
// The font and size of the text at the start of a range: "Default" and "" for the page's own.
function fontAt(r, surf) {
  let fam = "Default", size = "";
  for (let n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement; n && n !== surf; n = n.parentElement) {
    if (fam === "Default" && n.style && n.style.fontFamily) {
      const f = n.style.fontFamily.replace(/["']/g, "").split(",")[0].trim().toLowerCase();
      const hit = FONT_CHOICES.find(c => c.toLowerCase() === f);
      if (hit) fam = hit;
    }
    if (!size && n.style && /^\d+(\.\d+)?pt$/.test(n.style.fontSize || "")) size = n.style.fontSize;
  }
  return { fam, size: SIZE_CHOICES.includes(size) ? size : "" };
}
// Font and size, for the toolbar lists and the right-click menu alike.
function applyFontName(f) {
  // "Default" removes the family instead of setting one, so the page keeps the
  // print stylesheet's font (what the PDF uses). The list then shows the font
  // at the caret again (syncFmtState), like a word processor's.
  runFmt("fontName", f === "Default" ? "inherit" : f);
}
function applyFontSize(v) {
  if (!v) { syncFmtState(); return; }
  const surf = restoreSelection();
  if (!surf) { status("Select some text first", true); syncFmtState(); return; }
  markFormatStep();
  // execCommand's fontSize only speaks 1-7; let it mark the selection, then
  // turn exactly what it marked into the real pt value (the one the PDF uses).
  // What it marks carries a keyword size ("large"), which nothing else in a
  // note ever has: rewriting every sized span instead resized all text sized
  // earlier and dropped its other styles, colour included.
  try {
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("fontSize", false, "4");
    for (const el of [...surf.querySelectorAll('[style*="font-size"], font[size]')]) {
      if (el.tagName === "FONT") {
        const span = document.createElement("span");
        span.style.fontSize = v;
        while (el.firstChild) span.appendChild(el.firstChild);
        el.replaceWith(span);
      } else if (/^[a-z-]+$/i.test(el.style.fontSize)) el.style.fontSize = v;
    }
  } catch {}
  rememberSelection();
  markDirtyFromFormatting();
  syncFmtState();
}
for (const b of $("fmt-bar").querySelectorAll("button[data-cmd]")) {
  b.addEventListener("mousedown", e => e.preventDefault());   // keep the selection
  b.onclick = () => {
    const cmd = b.dataset.cmd;
    if (ALIGN_CMDS[cmd]) applyAlignment(ALIGN_CMDS[cmd]);
    else if (cmd === "removeFormat") clearFormatting();
    else runFmt(cmd);
  };
}
{
  const fsel = $("fmt-font"), ssel = $("fmt-size");
  for (const f of FONT_CHOICES) { const o = document.createElement("option"); o.value = f; o.textContent = f; fsel.appendChild(o); }
  const szDefault = document.createElement("option");
  szDefault.value = ""; szDefault.textContent = "Size";
  ssel.appendChild(szDefault);
  for (const s of SIZE_CHOICES) { const o = document.createElement("option"); o.value = s; o.textContent = s; ssel.appendChild(o); }
  fsel.addEventListener("mousedown", rememberSelection);
  ssel.addEventListener("mousedown", rememberSelection);
  fsel.onchange = () => applyFontName(fsel.value);
  ssel.onchange = () => applyFontSize(ssel.value);
}
// ---------- Colour, highlight, links, tables ----------
// Removes ONE css property from every styled span the selection touches, then
// unwraps spans left carrying nothing. This is what "Default" / "None" do -
// execCommand has no way to express "remove this property".
function clearInlineProp(prop) {
  const surf = restoreSelection();
  if (!surf) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  markFormatStep();
  const r = sel.getRangeAt(0);
  for (const el of [...surf.querySelectorAll("span[style], font[color]")]) {
    if (!r.intersectsNode(el)) continue;
    el.style.removeProperty(prop);
    if (!el.getAttribute("style")) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }
  }
  surf.normalize();
  markDirtyFromFormatting();
  return true;
}
function applyColor(kind, hex) {
  if (trashViewId || backupView || syncing) return;
  const prop = kind === "fore" ? "color" : "background-color";
  if (!hex) {
    if (!clearInlineProp(prop)) { status("Select some text first", true); return; }
    showLastColour(kind, null);
    return;
  }
  const surf = restoreSelection();
  if (!surf) { status("Select some text first", true); return; }
  markFormatStep();
  try {
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(kind === "fore" ? "foreColor" : "hiliteColor", false, hex);
  } catch {}
  rememberSelection();
  markDirtyFromFormatting();
  showLastColour(kind, hex);
}
// The bar under the colour and highlight buttons shows the last one used.
function showLastColour(kind, hex) {
  lastColour[kind] = hex;
  const bar = $(kind === "fore" ? "color-bar" : "hl-bar");
  if (bar) bar.style.background = hex || "";
}
// A real palette popup: the preset grid, a reset row, the custom colours, and
// a custom colour editor of its own (below).
let palettePop = null, paletteShield = null, paletteAt = { x: 0, y: 0 };
let palEdit = null;   // the custom colour being edited: { kind, start, hex, h, s, v, changed, confirm, picking }
// The last colour applied of each kind: the bar under the toolbar button shows
// it, and a new custom colour starts from it when the selection has none.
const lastColour = { fore: null, back: null };
function closePalette(force) {
  if (!palettePop) return true;
  // A custom colour with changes is never dropped by a stray click or Escape.
  if (!force && palEdit && palEdit.changed) { askStopEditing(); return false; }
  palettePop.remove();
  palettePop = null;
  endColourEditor();
  document.removeEventListener("mousedown", paletteAway, true);
  return true;
}
// A click outside the palette closes it and goes on to whatever it was aimed
// at. Once a custom colour has changes, the shield under the palette takes
// those clicks instead (askStopEditing).
function paletteAway(e) {
  if (!palettePop || palettePop.contains(e.target) || e.target === paletteShield) return;
  closePalette();
}
// Escape: the same as a click outside, and inside the question it means Cancel.
function paletteEscape() {
  const st = palEdit;
  if (st && st.picking) return;
  if (st && st.confirm) { closeStopEditing(); return; }
  closePalette();
}
// Kept inside the window as its content changes size.
function placePalette() {
  const pop = palettePop;
  if (!pop) return;
  const M = 8, w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.round(Math.max(M, Math.min(paletteAt.x, innerWidth - w - M))) + "px";
  pop.style.top = Math.round(Math.max(M, Math.min(paletteAt.y, innerHeight - h - M))) + "px";
}
addEventListener("resize", () => placePalette());
// side "right" opens it beside the anchor (a menu row), otherwise below it (a toolbar button).
function openPalette(anchor, kind, side) {
  closePalette(true);
  const pop = mk("div", "palette-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", kind === "fore" ? "Text colour" : "Highlight");
  palettePop = pop;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  paletteAt = side === "right" ? { x: r.right + 4, y: r.top - 12 } : { x: r.left, y: r.bottom + 4 };
  renderPaletteGrid(kind);
  setTimeout(() => document.addEventListener("mousedown", paletteAway, true), 0);
}
function renderPaletteGrid(kind) {
  const pop = palettePop;
  if (!pop) return;
  endColourEditor();
  pop.textContent = "";
  pop.classList.remove("editing");
  pop.appendChild(mk("div", "pal-head", kind === "fore" ? "Text colour" : "Highlight"));
  const reset = mk("button", "pal-reset", kind === "fore" ? "Default colour" : "No highlight");
  reset.type = "button";
  reset.onmousedown = e => e.preventDefault();
  reset.onclick = () => { applyColor(kind, null); closePalette(true); };
  pop.appendChild(reset);
  const swatch = hex => {
    const b = mk("button", "pal-swatch");
    b.type = "button";
    b.style.background = hex;
    b.title = hex;
    b.onmousedown = e => e.preventDefault();   // never lose the selection
    b.onclick = () => { applyColor(kind, hex); closePalette(true); };
    return b;
  };
  const grid = mk("div", "pal-grid");
  for (const row of PALETTE_ROWS) for (const hex of row) grid.appendChild(swatch(hex));
  pop.appendChild(grid);
  pop.appendChild(mk("div", "pal-head", "Custom"));
  const custom = mk("div", "pal-grid custom");
  for (const hex of customColors) custom.appendChild(swatch(hex));
  const add = mk("button", "pal-swatch pal-add", "+");
  add.type = "button";
  add.title = "New custom colour...";
  add.onmousedown = e => e.preventDefault();
  add.onclick = () => openColourEditor(kind);
  custom.appendChild(add);
  pop.appendChild(custom);
  placePalette();
}

// ---------- Custom colour editor ----------
// Built into the palette rather than handed to the browser's colour dialog:
// that dialog opened wherever the browser put it (the corner of the screen),
// and a click outside it closed it with no way to ask first. Saturation runs
// across the square and brightness up it, the hue along the strip below; the
// hex field takes typing. Any change counts: leaving with one, by a click
// outside the palette or Escape, asks first (askStopEditing).
function hsvToHex(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return "#" + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}
function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
// "#abc", "abc", "#aabbcc" or "aabbcc" as "#aabbcc"; anything else null.
function normHex(t) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(t || "").trim());
  if (!m) return null;
  const x = m[1].toLowerCase();
  return "#" + (x.length === 3 ? x.replace(/./g, c => c + c) : x);
}
// The colour the selected text already has, if one was set on it (not the
// page's own ink, and never a censor bar's look).
function colourAtSelection(kind) {
  const r = lastFmtRange;
  const el = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
  const surf = el && surfaceOfNode(el);
  if (!surf) return null;
  const prop = kind === "fore" ? "color" : "backgroundColor";
  for (let n = el; n && n !== surf; n = n.parentElement) {
    if (isCensorEl(n) || !n.style || !n.style[prop]) continue;
    const c = cssColorHex(n.style[prop]);
    if (c && c !== "transparent") return normHex(c.slice(0, 7));
  }
  return null;
}
const EYEDROPPER_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.4 2.6a1.8 1.8 0 0 1 2.6 2.6L11.6 6.6 9 4z"/><path d="m8.2 3.4 4.4 4.4"/><path d="M9.6 5.6 3.6 11.6 3 13l1.4-.6 6-6"/></svg>';
function endColourEditor() {
  palEdit = null;
  if (paletteShield) { paletteShield.remove(); paletteShield = null; }
}
function openColourEditor(kind) {
  const pop = palettePop;
  if (!pop) return;
  const start = colourAtSelection(kind) || lastColour[kind] || (kind === "fore" ? "#cc0000" : "#ffd966");
  const st = { kind, start, hex: start, ...hexToHsv(start), changed: false, confirm: null, picking: false };
  palEdit = st;
  pop.textContent = "";
  pop.classList.add("editing");
  pop.appendChild(mk("div", "pal-head", kind === "fore" ? "New text colour" : "New highlight colour"));
  const sv = mk("div", "cpk-sv");
  sv.tabIndex = 0;
  sv.setAttribute("role", "slider");
  sv.setAttribute("aria-label", "Saturation and brightness (arrow keys)");
  const knob = mk("span", "cpk-knob");
  sv.appendChild(knob);
  const hue = mk("input", "cpk-hue");
  hue.type = "range";
  hue.min = "0";
  hue.max = "360";
  hue.step = "1";
  hue.setAttribute("aria-label", "Hue");
  const row = mk("div", "cpk-row");
  const prev = mk("div", "cpk-prev");
  const was = mk("span");
  was.style.background = start;
  was.title = "Before: " + start;
  const now = mk("span");
  prev.append(was, now);
  const hexIn = mk("input", "cpk-hex");
  hexIn.type = "text";
  hexIn.maxLength = 7;
  hexIn.spellcheck = false;
  hexIn.autocomplete = "off";
  hexIn.setAttribute("aria-label", "Hex colour");
  row.append(prev, hexIn);
  const acts = mk("div", "cpk-actions");
  // "Back", not "Cancel": the question below has a Cancel that means the opposite (keep editing).
  const back = mk("button", null, "Back");
  back.type = "button";
  back.title = "Back to the palette, keeping nothing";
  const use = mk("button", "primary", "Use colour");
  use.type = "button";
  acts.append(back, use);
  pop.append(sv, hue, row, acts);

  // Repaint everything from st; `from` is the control being moved, left as it is.
  const paint = from => {
    sv.style.background = "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), " +
      `hsl(${Math.round(st.h)}, 100%, 50%)`;
    knob.style.left = (st.s * 100) + "%";
    knob.style.top = ((1 - st.v) * 100) + "%";
    sv.setAttribute("aria-valuetext", `saturation ${Math.round(st.s * 100)}%, brightness ${Math.round(st.v * 100)}%`);
    if (from !== "hue") hue.value = String(Math.round(st.h));
    if (from !== "hex") { hexIn.value = st.hex; hexIn.classList.remove("bad"); }
    now.style.background = st.hex;
    now.title = "New: " + st.hex;
    use.disabled = false;
  };
  // The first change raises the shield: from then on a click outside the
  // palette asks before anything is lost.
  const touch = () => {
    if (st.changed) return;
    st.changed = true;
    paletteShield = mk("div", "palette-shield");
    paletteShield.addEventListener("mousedown", e => { e.preventDefault(); if (!st.picking) askStopEditing(); });
    paletteShield.addEventListener("contextmenu", e => e.preventDefault());
    // The wheel still scrolls whatever is under the shield (the note, the list).
    paletteShield.addEventListener("wheel", e => {
      paletteShield.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      paletteShield.style.pointerEvents = "";
      for (let n = under; n && n !== document.body; n = n.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY) || n.scrollHeight <= n.clientHeight) continue;
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? n.clientHeight : 1;
        n.scrollBy(e.deltaX * k, e.deltaY * k);
        e.preventDefault();
        return;
      }
    }, { passive: false });
    document.body.appendChild(paletteShield);
  };
  const fromHsv = () => { st.hex = hsvToHex(st.h, st.s, st.v); };
  const setHex = hx => { Object.assign(st, hexToHsv(hx)); st.hex = hx; };

  // The square: drag with the pointer, or the arrow keys once it has focus
  // (Shift for bigger steps). mousedown is cancelled so the note keeps its
  // selection; the pointer is captured so a drag may leave the square.
  sv.addEventListener("mousedown", e => e.preventDefault());
  const svAt = e => {
    const b = sv.getBoundingClientRect();
    st.s = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    st.v = 1 - Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
    fromHsv();
    touch();
    paint();
  };
  sv.addEventListener("pointerdown", e => {
    if (e.button !== 0 || st.confirm) return;
    try { sv.setPointerCapture(e.pointerId); } catch {}
    svAt(e);
  });
  sv.addEventListener("pointermove", e => { if (sv.hasPointerCapture && sv.hasPointerCapture(e.pointerId)) svAt(e); });
  sv.addEventListener("pointerup", e => { try { sv.releasePointerCapture(e.pointerId); } catch {} });
  sv.addEventListener("keydown", e => {
    const k = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-k, 0], ArrowRight: [k, 0], ArrowUp: [0, k], ArrowDown: [0, -k] }[e.key];
    if (!d) return;
    e.preventDefault();
    st.s = Math.min(1, Math.max(0, st.s + d[0]));
    st.v = Math.min(1, Math.max(0, st.v + d[1]));
    fromHsv();
    touch();
    paint();
  });
  hue.addEventListener("input", () => { st.h = Number(hue.value) % 360; fromHsv(); touch(); paint("hue"); });
  // Typing: applied as soon as it reads as a colour; "Use colour" waits while it does not.
  hexIn.addEventListener("input", () => {
    touch();
    const hx = normHex(hexIn.value);
    hexIn.classList.toggle("bad", !hx);
    if (!hx) { use.disabled = true; return; }
    setHex(hx);
    paint("hex");
  });
  hexIn.addEventListener("blur", () => { if (normHex(hexIn.value)) hexIn.value = st.hex; });
  hexIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); if (!use.disabled) use.click(); } });
  // The eyedropper the browser's dialog had, where the browser offers it (Chrome, Edge).
  if ("EyeDropper" in window) {
    const drop = mk("button", "cpk-drop");
    drop.type = "button";
    drop.title = "Pick a colour from the screen";
    drop.innerHTML = EYEDROPPER_SVG;
    drop.onmousedown = e => e.preventDefault();
    drop.onclick = async () => {
      if (st.confirm) return;
      st.picking = true;
      try {
        const res = await new window.EyeDropper().open();
        const hx = normHex(res && res.sRGBHex);
        if (hx && palEdit === st) { setHex(hx); touch(); paint(); }
      } catch {}   // Escape, or a click the browser did not count as a pick
      // A moment later, so the Escape that ended the pick is not also taken as leaving the editor.
      finally { setTimeout(() => { st.picking = false; }, 200); }
    };
    row.appendChild(drop);
  }
  for (const b of [back, use]) b.onmousedown = e => e.preventDefault();
  // Back is an explicit choice: to the palette, nothing kept, no question.
  back.onclick = () => renderPaletteGrid(kind);
  use.onclick = () => {
    if (use.disabled) return;
    const hx = st.hex;
    rememberCustom(hx);
    applyColor(kind, hx);
    closePalette(true);
  };
  paint();
  placePalette();
}
// "Are you sure you want to stop editing the custom colour?", asked over the
// editor, which stays visible but out of reach until it is answered. Exit
// closes the palette and keeps nothing, exactly as a click outside does when
// nothing was changed; Cancel goes back to editing.
function askStopEditing() {
  const st = palEdit;
  if (!st || !palettePop) return;
  if (st.confirm) { st.confirm.querySelector("button").focus({ preventScroll: true }); return; }
  const box = mk("div", "cpk-confirm");
  box.setAttribute("role", "alertdialog");
  const q = mk("p", null, "Are you sure you want to stop editing the custom colour?");
  q.id = "cpk-question";
  box.setAttribute("aria-labelledby", q.id);
  const acts = mk("div", "cpk-actions");
  const cancel = mk("button", "primary", "Cancel");
  cancel.type = "button";
  const exit = mk("button", "danger", "Exit");
  exit.type = "button";
  for (const b of [cancel, exit]) b.onmousedown = e => e.preventDefault();
  cancel.onclick = closeStopEditing;
  exit.onclick = () => closePalette(true);
  acts.append(cancel, exit);
  box.append(q, acts);
  palettePop.appendChild(box);
  st.confirm = box;
  cancel.focus({ preventScroll: true });
}
function closeStopEditing() {
  const st = palEdit;
  if (!st || !st.confirm) return;
  st.confirm.remove();
  st.confirm = null;
}
for (const [id, kind] of [["fmt-color", "fore"], ["fmt-highlight", "back"]]) {
  const btn = $(id);
  btn.addEventListener("mousedown", e => { e.preventDefault(); rememberSelection(); });
  btn.onclick = () => openPalette(btn, kind);
}
// Links
$("fmt-link").addEventListener("mousedown", e => { e.preventDefault(); rememberSelection(); });
$("fmt-link").onclick = async () => {
  if (trashViewId || backupView || syncing) return;
  const surf = restoreSelection();
  if (!surf) { status("Select the text to link first", true); return; }
  const sel = window.getSelection();
  const existing = (() => {
    const c = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const a = c && c.closest && c.closest("a[href]");
    return a && surf.contains(a) ? a : null;
  })();
  if (existing && sel.isCollapsed) {
    // Caret inside a link and nothing selected: offer to edit or remove it.
    const r = $("fmt-link").getBoundingClientRect();
    openMenu(r.left, r.bottom + 2, [
      { label: existing.getAttribute("href").slice(0, 48), disabled: true },
      { sep: true },
      { label: "Open link", onClick: () => window.open(existing.href, "_blank", "noopener,noreferrer") },
      { label: "Remove link", danger: true, onClick: () => {
        markFormatStep();
        while (existing.firstChild) existing.parentNode.insertBefore(existing.firstChild, existing);
        existing.remove();
        markDirtyFromFormatting();
      } },
    ]);
    return;
  }
  if (sel.isCollapsed) { status("Select the text to link first", true); return; }
  const url = await promptModal({ title: "Link", placeholder: "https://example.com",
    value: existing ? existing.getAttribute("href") : "", confirmLabel: "Apply" });
  if (!url) return;
  const safe = safeHref(url) || safeHref("https://" + url.replace(/^\/+/, ""));
  if (!safe) { status("Only http, https, mailto and tel links are allowed", true); return; }
  const surf2 = restoreSelection();
  if (!surf2) return;
  markFormatStep();
  try { document.execCommand("createLink", false, safe); } catch {}
  // execCommand cannot set target/rel; the sanitizer adds them on the way back
  // in, but set them now so the live editor behaves too.
  for (const a of surf2.querySelectorAll('a[href="' + CSS.escape(safe) + '"]')) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  markDirtyFromFormatting();
};
// Ctrl/Cmd+click opens a link from inside the editor (a plain click keeps
// editing, exactly like a word processor).
$("edit-wrap").addEventListener("click", e => {
  const a = e.target && e.target.closest && e.target.closest("a[href]");
  if (!a || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const safe = safeHref(a.getAttribute("href"));
  if (safe) window.open(safe, "_blank", "noopener,noreferrer");
});
