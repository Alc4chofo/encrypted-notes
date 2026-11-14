/*
 * toolbar.js - the formatting toolbar: bold and the other formats, font and
 * size, text colour and highlight (with a custom colour editor), and links.
 *
 * The formats go through document.execCommand. It is deprecated, but it is
 * still the only built-in way to edit a contenteditable selection in every
 * browser, and everything it produces goes through the sanitiser again when
 * the note is saved, so it cannot bring in anything the allowlist would not
 * accept anyway.
 *
 * The colour buttons open a palette: preset colours, a reset row, the
 * custom colours, and an editor for a new one. The editor is part of the
 * palette rather than the browser's colour dialog, which opened wherever
 * the browser put it (the corner of the screen) and closed on a click
 * outside it with no way to ask first. Saturation runs across the square and
 * brightness up it, the hue along the strip below, and the hex field takes
 * typing. Once anything has changed, leaving (a click outside the palette,
 * or Escape) asks first.
 *
 * Main functions: rememberSelection, restoreSelection, markFormatStep,
 * runFormat, markDirtyFromFormatting, syncFormatState, fontAt,
 * applyFontName, applyFontSize, applyColor, openPalette, renderPaletteGrid,
 * closePalette, paletteEscape, openColourEditor, askStopEditing.
 * Auxiliary functions: sameRange, syncFontLists, clearInlineProp,
 * showLastColour, paletteAway, placePalette, endColourEditor,
 * closeStopEditing, colourAtSelection, hsvToHex, hexToHsv, normalizeHex.
 *
 * Complexity: a format is O(n) in the selection (the browser's work);
 * showing the toolbar's state is O(b + depth) over its buttons; drawing the
 * palette is O(c) in the colours.
 */
"use strict";

// ---------- State ----------

// The selection in the note, remembered because a toolbar control taking the
// focus loses it.
let lastFormatRange = null;

// ---------- Formatting ----------

/**
 * Remembers the selection, if it is in the note's text, so a control that
 * takes the focus can put it back.
 *
 * Used by: this file (the toolbar buttons and lists), alignment.js
 * (applyAlignment), censor.js (clearFormatting, toggleCensor, and on load),
 * format-menu.js (the right-click, on load), tables.js (the table button, on load).
 * Uses: currentEditorRange (lines.js).
 * Complexity: O(p * depth).
 */
function rememberSelection() {
  const range = currentEditorRange();
  if (range) {
    lastFormatRange = range;
  }
}

/**
 * Puts the remembered selection back and returns the surface it is in, or
 * null. When the caret is still in the text, exactly where it was left
 * (toolbar buttons never take the focus), the selection is left alone:
 * setting it again, even to the same place, makes the browser drop the
 * formats waiting at the caret, so B then I typed italic only, and B then
 * Censor typed censored text that was not bold. Anything else gets the
 * remembered selection back, including the focus coming back from a dialog,
 * which puts the caret at the top of the note.
 *
 * Used by: this file, alignment.js (applyAlignment), censor.js
 * (clearFormatting, toggleCensor), format-menu.js (clipboardCommand),
 * tables.js (insertTable).
 * Uses: currentEditorRange and surfaceOfNode (lines.js), sameRange.
 * Complexity: O(p * depth).
 */
function restoreSelection() {
  const live = currentEditorRange();
  const liveSurface = live && surfaceOfNode(live.commonAncestorContainer);
  if (liveSurface && document.activeElement === liveSurface && lastFormatRange && sameRange(live, lastFormatRange)) {
    return liveSurface;
  }
  if (!lastFormatRange || !surfaceOfNode(lastFormatRange.commonAncestorContainer)) {
    return null;
  }
  const surface = surfaceOfNode(lastFormatRange.commonAncestorContainer);
  surface.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(lastFormatRange);
  return surface;
}

/**
 * Makes the next formatting change an undo step of its own: what is on
 * screen is saved and marked first, so Ctrl+Z takes back the formatting alone
 * and not the typing before it. In the second screen nothing is saved before
 * "Save edit", so there it stays part of the edit around it.
 *
 * Used by: this file, alignment.js (applyAlignment), censor.js (clearFormatting, toggleCensor).
 * Uses: flushSave (pagination.js), historyMark (history.js).
 * Complexity: O(n) in the note, to save it.
 */
function markFormatStep() {
  if (!currentId || splitMode || trashViewId || backupView || !vault || !vault.notes[currentId]) {
    return;
  }
  flushSave();
  historyMark(currentId);
}

/**
 * Runs one execCommand format (bold, italic, a font name...) on the
 * selection, as styled spans, never <font>. A format on a selection is an
 * undo step of its own; at a caret it waits there for what is typed next.
 *
 * Used by: this file (the toolbar buttons, applyFontName), format-menu.js
 * (formatMenuItems), censor.js (the keyboard shortcuts, on load).
 * Uses: restoreSelection, status (pagination.js), markFormatStep,
 * rememberSelection, markDirtyFromFormatting, syncFormatState.
 * Complexity: O(n) in the selection.
 */
function runFormat(cmd, value) {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Put the cursor in the text first", true);
    return;
  }
  if (!window.getSelection().isCollapsed) {
    markFormatStep();
  }
  try {
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(cmd, false, value);
  } catch {}
  rememberSelection();
  markDirtyFromFormatting();
  syncFormatState();
}

/**
 * Marks the note as changed after formatting, the way typing does (not every
 * browser fires an input event for a format), and saves it shortly. In split
 * view saving is explicit.
 *
 * Used by: this file, alignment.js (applyAlignment), censor.js
 * (clearFormatting, toggleCensor, and on load), tables.js (insertTable,
 * tableMenuItems), media-layout.js (mediaLayoutMenu, setColWidth,
 * setRowHeight, and on load), attachments.js (on load).
 * Uses: renderList (sidebar.js), saveCurrent and renderStatus (pagination.js), saveTimer (events.js).
 * Complexity: O(1), plus redrawing the list.
 */
function markDirtyFromFormatting() {
  if (trashViewId || backupView || !currentId) {
    return;
  }
  if (!unsavedEdits) {
    unsavedEdits = true;
    renderList();
  }
  if (!splitMode) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 400);
  }
  renderStatus();
}

/**
 * Makes the toolbar show what is at the caret: the formats in effect there
 * as pressed buttons, the paragraph's alignment, the censor state typing
 * would get, and the font and size of the text in the two lists.
 *
 * Used by: this file, alignment.js (applyAlignment, and Enter on load),
 * censor.js (clearFormatting, insertSegments, toggleCensor, and on load),
 * attachments.js (insertPlainText).
 * Uses: currentEditorRange and surfaceOfNode (lines.js), ALIGN_CMDS
 * (designs.js), caretAlign (alignment.js), censorStateAt (censor.js), syncFontLists.
 * Complexity: O(b + depth) over the toolbar's buttons.
 */
function syncFormatState() {
  const range = currentEditorRange();
  const surface = range ? surfaceOfNode(range.startContainer) : null;
  for (const button of $("fmt-bar").querySelectorAll("button[data-cmd]")) {
    const cmd = button.dataset.cmd;
    let on = false;
    if (ALIGN_CMDS[cmd]) {
      on = !!surface && caretAlign(range, surface) === ALIGN_CMDS[cmd];
    } else if (cmd !== "removeFormat") {
      try {
        on = !!surface && document.queryCommandState(cmd);
      } catch {}
    }
    button.classList.toggle("on", on);
    if (cmd !== "removeFormat") {
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  const censorOn = !!surface && censorStateAt(range, surface);
  $("fmt-censor").classList.toggle("on", censorOn);
  $("fmt-censor").setAttribute("aria-pressed", censorOn ? "true" : "false");
  syncFontLists(range, surface);
}

/**
 * The font and size of the text at the start of a range, as { fam, size }:
 * the first font of the list set on it, and its size in pt, or "Default" and
 * "" where it uses the page's own.
 *
 * Used by: this file (syncFontLists), format-menu.js (formatMenuItems).
 * Uses: FONT_CHOICES and SIZE_CHOICES (designs.js).
 * Complexity: O(depth).
 */
function fontAt(range, surface) {
  let family = "Default";
  let size = "";
  for (let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    el && el !== surface; el = el.parentElement) {
    if (family === "Default" && el.style && el.style.fontFamily) {
      const first = el.style.fontFamily.replace(/["']/g, "").split(",")[0].trim().toLowerCase();
      const hit = FONT_CHOICES.find(choice => choice.toLowerCase() === first);
      if (hit) {
        family = hit;
      }
    }
    if (!size && el.style && /^\d+(\.\d+)?pt$/.test(el.style.fontSize || "")) {
      size = el.style.fontSize;
    }
  }
  return { fam: family, size: SIZE_CHOICES.includes(size) ? size : "" };
}

/**
 * Sets the font of the selection. "Default" removes the font instead of
 * setting one, so the page keeps the print stylesheet's font (the one the PDF
 * uses), and the list then shows the font at the caret again, like a word
 * processor's.
 *
 * Used by: this file (the font list), format-menu.js (formatMenuItems).
 * Uses: runFormat.
 * Complexity: O(n) in the selection.
 */
function applyFontName(font) {
  runFormat("fontName", font === "Default" ? "inherit" : font);
}

/**
 * Sets the size of the selection, in pt (the unit the PDF uses).
 * execCommand's fontSize only knows the sizes 1 to 7, so it marks the
 * selection, and exactly what it marked is then given the real size. What it
 * marks carries a keyword size ("large"), which nothing else in a note ever
 * has: rewriting every sized span instead resized all the text sized earlier
 * and dropped its other styles, colour included.
 *
 * Used by: this file (the size list), format-menu.js (formatMenuItems).
 * Uses: syncFormatState, restoreSelection, status (pagination.js),
 * markFormatStep, rememberSelection, markDirtyFromFormatting.
 * Complexity: O(s) over the sized elements of the surface.
 */
function applyFontSize(value) {
  if (!value) {
    syncFormatState();
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Select some text first", true);
    syncFormatState();
    return;
  }
  markFormatStep();
  try {
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("fontSize", false, "4");
    for (const el of [...surface.querySelectorAll('[style*="font-size"], font[size]')]) {
      if (el.tagName === "FONT") {
        const span = document.createElement("span");
        span.style.fontSize = value;
        while (el.firstChild) {
          span.appendChild(el.firstChild);
        }
        el.replaceWith(span);
      } else if (/^[a-z-]+$/i.test(el.style.fontSize)) {
        el.style.fontSize = value;
      }
    }
  } catch {}
  rememberSelection();
  markDirtyFromFormatting();
  syncFormatState();
}

// ---------- On load: the format buttons and the font and size lists ----------

// mousedown is cancelled so the button never takes the selection away.
for (const button of $("fmt-bar").querySelectorAll("button[data-cmd]")) {
  button.addEventListener("mousedown", event => event.preventDefault());
  button.onclick = () => {
    const cmd = button.dataset.cmd;
    if (ALIGN_CMDS[cmd]) {
      applyAlignment(ALIGN_CMDS[cmd]);
    } else if (cmd === "removeFormat") {
      clearFormatting();
    } else {
      runFormat(cmd);
    }
  };
}

{
  const fontList = $("fmt-font");
  const sizeList = $("fmt-size");
  for (const font of FONT_CHOICES) {
    const option = document.createElement("option");
    option.value = font;
    option.textContent = font;
    fontList.appendChild(option);
  }
  const sizeDefault = document.createElement("option");
  sizeDefault.value = "";
  sizeDefault.textContent = "Size";
  sizeList.appendChild(sizeDefault);
  for (const size of SIZE_CHOICES) {
    const option = document.createElement("option");
    option.value = size;
    option.textContent = size;
    sizeList.appendChild(option);
  }
  fontList.addEventListener("mousedown", rememberSelection);
  sizeList.addEventListener("mousedown", rememberSelection);
  fontList.onchange = () => applyFontName(fontList.value);
  sizeList.onchange = () => applyFontSize(sizeList.value);
}

// ---------- Colour and highlight: state ----------

// The open palette, the shield under it while a custom colour has changes,
// and where it was asked to open.
let palettePop = null;
let paletteShield = null;
let paletteAt = { x: 0, y: 0 };

// The custom colour being edited: { kind, start, hex, h, s, v, changed, confirm, picking }.
let paletteEdit = null;

// The last colour applied of each kind: the bar under its toolbar button
// shows it, and a new custom colour starts from it when the selection has none.
const lastColour = { fore: null, back: null };

// ---------- Colour and highlight ----------

/**
 * Colours the selection's text (kind "fore") or highlights it ("back"). No
 * colour means the default: that property is removed from the selection,
 * which execCommand has no way to say. One undo step.
 *
 * Used by: this file (the palette's swatches and reset row, "Use colour").
 * Uses: clearInlineProp, status (pagination.js), showLastColour,
 * restoreSelection, markFormatStep, rememberSelection, markDirtyFromFormatting.
 * Complexity: O(n) in the selection.
 */
function applyColor(kind, hex) {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const prop = kind === "fore" ? "color" : "background-color";
  if (!hex) {
    if (!clearInlineProp(prop)) {
      status("Select some text first", true);
      return;
    }
    showLastColour(kind, null);
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Select some text first", true);
    return;
  }
  markFormatStep();
  try {
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(kind === "fore" ? "foreColor" : "hiliteColor", false, hex);
  } catch {}
  rememberSelection();
  markDirtyFromFormatting();
  showLastColour(kind, hex);
}

/**
 * Opens the colour palette for a kind ("fore" or "back"): below a toolbar
 * button, or beside a menu row when side is "right". A click outside it
 * closes it.
 *
 * Used by: this file (the colour buttons, on load), format-menu.js (formatMenuItems).
 * Uses: closePalette, makeElement (sidebar.js), renderPaletteGrid, paletteAway.
 * Complexity: O(c) in the colours.
 */
function openPalette(anchor, kind, side) {
  closePalette(true);
  const pop = makeElement("div", "palette-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", kind === "fore" ? "Text colour" : "Highlight");
  palettePop = pop;
  document.body.appendChild(pop);
  const box = anchor.getBoundingClientRect();
  paletteAt = side === "right" ? { x: box.right + 4, y: box.top - 12 } : { x: box.left, y: box.bottom + 4 };
  renderPaletteGrid(kind);
  setTimeout(() => document.addEventListener("mousedown", paletteAway, true), 0);
}

/**
 * Fills the palette with its colours: a reset row ("Default colour" or "No
 * highlight"), the preset grid, the custom colours and a "+" for a new one.
 * Nothing in it takes the selection away from the note.
 *
 * Used by: this file (openPalette, and "Back" in the colour editor).
 * Uses: endColourEditor, makeElement (sidebar.js), applyColor, closePalette,
 * PALETTE_ROWS and customColors (designs.js), openColourEditor, placePalette.
 * Complexity: O(c) in the colours.
 */
function renderPaletteGrid(kind) {
  const pop = palettePop;
  if (!pop) {
    return;
  }
  endColourEditor();
  pop.textContent = "";
  pop.classList.remove("editing");
  pop.appendChild(makeElement("div", "pal-head", kind === "fore" ? "Text colour" : "Highlight"));

  const reset = makeElement("button", "pal-reset", kind === "fore" ? "Default colour" : "No highlight");
  reset.type = "button";
  reset.onmousedown = event => event.preventDefault();
  reset.onclick = () => {
    applyColor(kind, null);
    closePalette(true);
  };
  pop.appendChild(reset);

  const swatch = hex => {
    const button = makeElement("button", "pal-swatch");
    button.type = "button";
    button.style.background = hex;
    button.title = hex;
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => {
      applyColor(kind, hex);
      closePalette(true);
    };
    return button;
  };
  const grid = makeElement("div", "pal-grid");
  for (const row of PALETTE_ROWS) {
    for (const hex of row) {
      grid.appendChild(swatch(hex));
    }
  }
  pop.appendChild(grid);

  pop.appendChild(makeElement("div", "pal-head", "Custom"));
  const custom = makeElement("div", "pal-grid custom");
  for (const hex of customColors) {
    custom.appendChild(swatch(hex));
  }
  const add = makeElement("button", "pal-swatch pal-add", "+");
  add.type = "button";
  add.title = "New custom colour...";
  add.onmousedown = event => event.preventDefault();
  add.onclick = () => openColourEditor(kind);
  custom.appendChild(add);
  pop.appendChild(custom);
  placePalette();
}

/**
 * Closes the palette and returns true, unless a custom colour has changes:
 * then it asks first and returns false. force closes it in any case.
 *
 * Used by: this file, settings.js (lockApp).
 * Uses: askStopEditing, endColourEditor, paletteAway.
 * Complexity: O(1).
 */
function closePalette(force) {
  if (!palettePop) {
    return true;
  }
  if (!force && paletteEdit && paletteEdit.changed) {
    askStopEditing();
    return false;
  }
  palettePop.remove();
  palettePop = null;
  endColourEditor();
  document.removeEventListener("mousedown", paletteAway, true);
  return true;
}

/**
 * Escape while the palette is open: the same as a click outside it. Inside
 * the "stop editing?" question it means Cancel, and while the eyedropper is
 * picking it does nothing (that Escape ends the pick).
 *
 * Used by: events.js (the Escape key, on load).
 * Uses: closeStopEditing, closePalette.
 * Complexity: O(1).
 */
function paletteEscape() {
  const state = paletteEdit;
  if (state && state.picking) {
    return;
  }
  if (state && state.confirm) {
    closeStopEditing();
    return;
  }
  closePalette();
}

// ---------- On load: the palette stays inside the window ----------

addEventListener("resize", () => placePalette());

// ---------- Custom colour editor ----------

// The eyedropper button's icon.
const EYEDROPPER_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.4 2.6a1.8 1.8 0 0 1 2.6 2.6L11.6 6.6 9 4z"/><path d="m8.2 3.4 4.4 4.4"/><path d="M9.6 5.6 3.6 11.6 3 13l1.4-.6 6-6"/></svg>';

/**
 * Turns the palette into the editor for a new custom colour, starting from
 * the colour the selection already has, else the last one used, else red or
 * yellow. The square is dragged with the pointer (captured, so a drag may
 * leave it) or moved with the arrow keys (Shift for bigger steps); the hue
 * strip and the hex field change the rest, and a typed colour is applied as
 * soon as it reads as one. Where the browser has one (Chrome, Edge), an
 * eyedropper picks a colour from the screen. The first change raises a
 * shield over the page, so a click outside asks before anything is lost; the
 * wheel still scrolls what is under it. "Back" returns to the palette
 * keeping nothing; "Use colour" saves it as a custom colour and applies it.
 *
 * Used by: this file (the palette's "+").
 * Uses: colourAtSelection, hexToHsv, hsvToHex, normalizeHex, makeElement
 * (sidebar.js), askStopEditing, renderPaletteGrid, rememberCustom
 * (designs.js), applyColor, closePalette, placePalette.
 * Complexity: O(1) per change.
 */
function openColourEditor(kind) {
  const pop = palettePop;
  if (!pop) {
    return;
  }
  const start = colourAtSelection(kind) || lastColour[kind] || (kind === "fore" ? "#cc0000" : "#ffd966");
  const state = { kind, start, hex: start, ...hexToHsv(start), changed: false, confirm: null, picking: false };
  paletteEdit = state;
  pop.textContent = "";
  pop.classList.add("editing");
  pop.appendChild(makeElement("div", "pal-head", kind === "fore" ? "New text colour" : "New highlight colour"));

  const square = makeElement("div", "cpk-sv");
  square.tabIndex = 0;
  square.setAttribute("role", "slider");
  square.setAttribute("aria-label", "Saturation and brightness (arrow keys)");
  const knob = makeElement("span", "cpk-knob");
  square.appendChild(knob);
  const hue = makeElement("input", "cpk-hue");
  hue.type = "range";
  hue.min = "0";
  hue.max = "360";
  hue.step = "1";
  hue.setAttribute("aria-label", "Hue");
  const row = makeElement("div", "cpk-row");
  const preview = makeElement("div", "cpk-prev");
  const before = makeElement("span");
  before.style.background = start;
  before.title = "Before: " + start;
  const after = makeElement("span");
  preview.append(before, after);
  const hexInput = makeElement("input", "cpk-hex");
  hexInput.type = "text";
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocomplete = "off";
  hexInput.setAttribute("aria-label", "Hex colour");
  row.append(preview, hexInput);
  const actions = makeElement("div", "cpk-actions");
  // "Back", not "Cancel": the question asked on leaving has a Cancel that means the opposite (keep editing).
  const back = makeElement("button", null, "Back");
  back.type = "button";
  back.title = "Back to the palette, keeping nothing";
  const use = makeElement("button", "primary", "Use colour");
  use.type = "button";
  actions.append(back, use);
  pop.append(square, hue, row, actions);

  // Repaints everything from state; from is the control being moved, which is left as it is.
  const paint = from => {
    square.style.background = "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), " +
      `hsl(${Math.round(state.h)}, 100%, 50%)`;
    knob.style.left = (state.s * 100) + "%";
    knob.style.top = ((1 - state.v) * 100) + "%";
    square.setAttribute("aria-valuetext", `saturation ${Math.round(state.s * 100)}%, brightness ${Math.round(state.v * 100)}%`);
    if (from !== "hue") {
      hue.value = String(Math.round(state.h));
    }
    if (from !== "hex") {
      hexInput.value = state.hex;
      hexInput.classList.remove("bad");
    }
    after.style.background = state.hex;
    after.title = "New: " + state.hex;
    use.disabled = false;
  };

  // The first change raises the shield.
  const touch = () => {
    if (state.changed) {
      return;
    }
    state.changed = true;
    paletteShield = makeElement("div", "palette-shield");
    paletteShield.addEventListener("mousedown", event => {
      event.preventDefault();
      if (!state.picking) {
        askStopEditing();
      }
    });
    paletteShield.addEventListener("contextmenu", event => event.preventDefault());
    paletteShield.addEventListener("wheel", event => {
      paletteShield.style.pointerEvents = "none";
      const under = document.elementFromPoint(event.clientX, event.clientY);
      paletteShield.style.pointerEvents = "";
      for (let el = under; el && el !== document.body; el = el.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.scrollHeight <= el.clientHeight) {
          continue;
        }
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
        el.scrollBy(event.deltaX * unit, event.deltaY * unit);
        event.preventDefault();
        return;
      }
    }, { passive: false });
    document.body.appendChild(paletteShield);
  };
  const fromHsv = () => {
    state.hex = hsvToHex(state.h, state.s, state.v);
  };
  const setHex = hex => {
    Object.assign(state, hexToHsv(hex));
    state.hex = hex;
  };

  // mousedown is cancelled so the note keeps its selection.
  square.addEventListener("mousedown", event => event.preventDefault());
  const squareAt = event => {
    const box = square.getBoundingClientRect();
    state.s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    state.v = 1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    fromHsv();
    touch();
    paint();
  };
  square.addEventListener("pointerdown", event => {
    if (event.button !== 0 || state.confirm) {
      return;
    }
    try {
      square.setPointerCapture(event.pointerId);
    } catch {}
    squareAt(event);
  });
  square.addEventListener("pointermove", event => {
    if (square.hasPointerCapture && square.hasPointerCapture(event.pointerId)) {
      squareAt(event);
    }
  });
  square.addEventListener("pointerup", event => {
    try {
      square.releasePointerCapture(event.pointerId);
    } catch {}
  });
  square.addEventListener("keydown", event => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }[event.key];
    if (!delta) {
      return;
    }
    event.preventDefault();
    state.s = Math.min(1, Math.max(0, state.s + delta[0]));
    state.v = Math.min(1, Math.max(0, state.v + delta[1]));
    fromHsv();
    touch();
    paint();
  });

  hue.addEventListener("input", () => {
    state.h = Number(hue.value) % 360;
    fromHsv();
    touch();
    paint("hue");
  });

  // "Use colour" waits while the typed text does not read as a colour.
  hexInput.addEventListener("input", () => {
    touch();
    const typed = normalizeHex(hexInput.value);
    hexInput.classList.toggle("bad", !typed);
    if (!typed) {
      use.disabled = true;
      return;
    }
    setHex(typed);
    paint("hex");
  });
  hexInput.addEventListener("blur", () => {
    if (normalizeHex(hexInput.value)) {
      hexInput.value = state.hex;
    }
  });
  hexInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!use.disabled) {
        use.click();
      }
    }
  });

  if ("EyeDropper" in window) {
    const drop = makeElement("button", "cpk-drop");
    drop.type = "button";
    drop.title = "Pick a colour from the screen";
    drop.innerHTML = EYEDROPPER_SVG;
    drop.onmousedown = event => event.preventDefault();
    drop.onclick = async () => {
      if (state.confirm) {
        return;
      }
      state.picking = true;
      try {
        const result = await new window.EyeDropper().open();
        const picked = normalizeHex(result && result.sRGBHex);
        if (picked && paletteEdit === state) {
          setHex(picked);
          touch();
          paint();
        }
      } catch {
        // Escape, or a click the browser did not count as a pick.
      } finally {
        // A moment later, so the Escape that ended the pick is not also taken as leaving the editor.
        setTimeout(() => {
          state.picking = false;
        }, 200);
      }
    };
    row.appendChild(drop);
  }

  for (const button of [back, use]) {
    button.onmousedown = event => event.preventDefault();
  }
  // Back is an explicit choice: to the palette, nothing kept, no question.
  back.onclick = () => renderPaletteGrid(kind);
  use.onclick = () => {
    if (use.disabled) {
      return;
    }
    const chosen = state.hex;
    rememberCustom(chosen);
    applyColor(kind, chosen);
    closePalette(true);
  };
  paint();
  placePalette();
}

/**
 * Asks "Are you sure you want to stop editing the custom colour?" over the
 * editor, which stays visible but out of reach until it is answered. Exit
 * closes the palette keeping nothing, as a click outside does when nothing
 * has changed; Cancel goes back to editing. Asking again only moves the
 * focus to it.
 *
 * Used by: this file (closePalette, and the shield in openColourEditor).
 * Uses: makeElement (sidebar.js), closeStopEditing, closePalette.
 * Complexity: O(1).
 */
function askStopEditing() {
  const state = paletteEdit;
  if (!state || !palettePop) {
    return;
  }
  if (state.confirm) {
    state.confirm.querySelector("button").focus({ preventScroll: true });
    return;
  }
  const box = makeElement("div", "cpk-confirm");
  box.setAttribute("role", "alertdialog");
  const question = makeElement("p", null, "Are you sure you want to stop editing the custom colour?");
  question.id = "cpk-question";
  box.setAttribute("aria-labelledby", question.id);
  const actions = makeElement("div", "cpk-actions");
  const cancel = makeElement("button", "primary", "Cancel");
  cancel.type = "button";
  const exit = makeElement("button", "danger", "Exit");
  exit.type = "button";
  for (const button of [cancel, exit]) {
    button.onmousedown = event => event.preventDefault();
  }
  cancel.onclick = closeStopEditing;
  exit.onclick = () => closePalette(true);
  actions.append(cancel, exit);
  box.append(question, actions);
  palettePop.appendChild(box);
  state.confirm = box;
  cancel.focus({ preventScroll: true });
}

// ---------- On load: the colour buttons and links ----------

for (const [id, kind] of [["fmt-color", "fore"], ["fmt-highlight", "back"]]) {
  const button = $(id);
  button.addEventListener("mousedown", event => {
    event.preventDefault();
    rememberSelection();
  });
  button.onclick = () => openPalette(button, kind);
}

$("fmt-link").addEventListener("mousedown", event => {
  event.preventDefault();
  rememberSelection();
});

// The link button links the selected text, after asking for the address.
// Only http, https, mailto and tel links are allowed (safeHref, designs.js).
// With the caret inside a link and nothing selected, it offers to open or
// remove that link instead.
$("fmt-link").onclick = async () => {
  if (trashViewId || backupView || syncing) {
    return;
  }
  const surface = restoreSelection();
  if (!surface) {
    status("Select the text to link first", true);
    return;
  }
  const selection = window.getSelection();
  const existing = (() => {
    const el = selection.anchorNode &&
      (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
    const link = el && el.closest && el.closest("a[href]");
    return link && surface.contains(link) ? link : null;
  })();

  if (existing && selection.isCollapsed) {
    const box = $("fmt-link").getBoundingClientRect();
    openMenu(box.left, box.bottom + 2, [
      { label: existing.getAttribute("href").slice(0, 48), disabled: true },
      { sep: true },
      { label: "Open link", onClick: () => window.open(existing.href, "_blank", "noopener,noreferrer") },
      {
        label: "Remove link",
        danger: true,
        onClick: () => {
          markFormatStep();
          while (existing.firstChild) {
            existing.parentNode.insertBefore(existing.firstChild, existing);
          }
          existing.remove();
          markDirtyFromFormatting();
        },
      },
    ]);
    return;
  }

  if (selection.isCollapsed) {
    status("Select the text to link first", true);
    return;
  }
  const url = await promptModal({ title: "Link", placeholder: "https://example.com",
    value: existing ? existing.getAttribute("href") : "", confirmLabel: "Apply" });
  if (!url) {
    return;
  }
  const safe = safeHref(url) || safeHref("https://" + url.replace(/^\/+/, ""));
  if (!safe) {
    status("Only http, https, mailto and tel links are allowed", true);
    return;
  }
  const surfaceAgain = restoreSelection();
  if (!surfaceAgain) {
    return;
  }
  markFormatStep();
  try {
    document.execCommand("createLink", false, safe);
  } catch {}
  // execCommand cannot set target and rel. The sanitiser adds them when the
  // note is loaded again; they are set now so the live editor behaves too.
  for (const link of surfaceAgain.querySelectorAll('a[href="' + CSS.escape(safe) + '"]')) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  markDirtyFromFormatting();
};

// Ctrl+click (Cmd+click on a Mac) opens a link from inside the editor; a
// plain click keeps editing, as in a word processor.
$("edit-wrap").addEventListener("click", event => {
  const link = event.target && event.target.closest && event.target.closest("a[href]");
  if (!link || !(event.ctrlKey || event.metaKey)) {
    return;
  }
  event.preventDefault();
  const safe = safeHref(link.getAttribute("href"));
  if (safe) {
    window.open(safe, "_blank", "noopener,noreferrer");
  }
});

// =================== Auxiliary functions ===================

/** Whether two ranges start and end at the same points. Complexity: O(1). */
function sameRange(a, b) {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

/**
 * Shows the font and size at the caret in the two lists ("Default" and
 * "Size" for the page's own), unless one of them is in use. Complexity: O(depth).
 */
function syncFontLists(range, surface) {
  const fontList = $("fmt-font");
  const sizeList = $("fmt-size");
  if (!surface || document.activeElement === fontList || document.activeElement === sizeList) {
    return;
  }
  const { fam: family, size } = fontAt(range, surface);
  fontList.value = family;
  sizeList.value = size;
}

/**
 * Removes one CSS property from every styled span the selection touches,
 * then unwraps the spans left carrying nothing. Returns false when there is
 * no selection in the note. Complexity: O(s) over the styled spans.
 */
function clearInlineProp(prop) {
  const surface = restoreSelection();
  if (!surface) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection.rangeCount) {
    return false;
  }
  markFormatStep();
  const range = selection.getRangeAt(0);
  for (const el of [...surface.querySelectorAll("span[style], font[color]")]) {
    if (!range.intersectsNode(el)) {
      continue;
    }
    el.style.removeProperty(prop);
    if (!el.getAttribute("style")) {
      while (el.firstChild) {
        el.parentNode.insertBefore(el.firstChild, el);
      }
      el.remove();
    }
  }
  surface.normalize();
  markDirtyFromFormatting();
  return true;
}

/** Shows the last colour used of a kind in the bar under its button. Complexity: O(1). */
function showLastColour(kind, hex) {
  lastColour[kind] = hex;
  const bar = $(kind === "fore" ? "color-bar" : "hl-bar");
  if (bar) {
    bar.style.background = hex || "";
  }
}

/**
 * A click outside the palette closes it, and goes on to whatever it was aimed
 * at. Once a custom colour has changes, the shield takes those clicks instead.
 * Complexity: O(1).
 */
function paletteAway(event) {
  if (!palettePop || palettePop.contains(event.target) || event.target === paletteShield) {
    return;
  }
  closePalette();
}

/** Keeps the palette inside the window, 8px from its edges, as its content changes size. Complexity: O(1). */
function placePalette() {
  const pop = palettePop;
  if (!pop) {
    return;
  }
  const margin = 8;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  pop.style.left = Math.round(Math.max(margin, Math.min(paletteAt.x, innerWidth - width - margin))) + "px";
  pop.style.top = Math.round(Math.max(margin, Math.min(paletteAt.y, innerHeight - height - margin))) + "px";
}

/** Leaves the colour editor: forgets its state and takes the shield away. Complexity: O(1). */
function endColourEditor() {
  paletteEdit = null;
  if (paletteShield) {
    paletteShield.remove();
    paletteShield = null;
  }
}

/** Takes the "stop editing?" question away (its Cancel). Complexity: O(1). */
function closeStopEditing() {
  const state = paletteEdit;
  if (!state || !state.confirm) {
    return;
  }
  state.confirm.remove();
  state.confirm = null;
}

/**
 * The colour the selected text already has, if one was set on it: not the
 * page's own ink, and never a censor bar's look. Complexity: O(depth).
 */
function colourAtSelection(kind) {
  const range = lastFormatRange;
  const el = range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
  const surface = el && surfaceOfNode(el);
  if (!surface) {
    return null;
  }
  const prop = kind === "fore" ? "color" : "backgroundColor";
  for (let node = el; node && node !== surface; node = node.parentElement) {
    if (isCensorEl(node) || !node.style || !node.style[prop]) {
      continue;
    }
    const colour = cssColorHex(node.style[prop]);
    if (colour && colour !== "transparent") {
      return normalizeHex(colour.slice(0, 7));
    }
  }
  return null;
}

/** A colour given as hue (0-360), saturation and brightness (0-1) as "#rrggbb". Complexity: O(1). */
function hsvToHex(h, s, v) {
  const channel = n => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return "#" + [channel(5), channel(3), channel(1)].map(x => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

/** A "#rrggbb" colour as { h, s, v }: hue 0-360, saturation and brightness 0-1. Complexity: O(1). */
function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255;
  const g = (n >> 8 & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}

/** "#abc", "abc", "#aabbcc" or "aabbcc" as "#aabbcc"; anything else null. Complexity: O(1). */
function normalizeHex(text) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text || "").trim());
  if (!match) {
    return null;
  }
  const digits = match[1].toLowerCase();
  return "#" + (digits.length === 3 ? digits.replace(/./g, c => c + c) : digits);
}
