// notes: The built-in PDF writer and the note export.
"use strict";

// ---------- Internal PDF writer ----------
// Builds the PDF bytes in-page instead of going through the browser's print
// dialog. That is what makes "export a folder with the PDF + its files" possible
// at all: the print dialog hands the file to the browser and never gives us the
// bytes. No library - just the PDF object model, the base-14 fonts (no embedding
// needed) and CompressionStream for image data.
const PT_PER_MM = 72 / 25.4;
const PAGE_W = 210 * PT_PER_MM, PAGE_H = 297 * PT_PER_MM;   // A4
const MARGIN_X = 16 * PT_PER_MM, MARGIN_Y = 18 * PT_PER_MM; // same margins as the sheets
// The printed size of an inline picture, in points, mirroring exactly what the
// sheet shows: an untouched image is contained inside 320x240 CSS px (the
// .inline-media img rule), a resized one fills the width it was given. Getting
// this wrong makes the PDF paginate differently from the screen - capping only
// the width let a tall image print 900pt high and spill onto a second page.
// The XObject name for a piece of media. The whole id, not a prefix: two ids
// sharing their first 8 characters would have collided and drawn each other's
// picture.
const imgName = mid => String(mid).replace(/[^A-Za-z0-9]/g, "");
// An attachment card: 24pt tall (the sheet's 32px) with a 6pt gutter, two to a row.
// Font sizes chosen to match the chip the sheet draws (11px / 8px), so both
// sides compute nearly the same card width and fit the same number per row.
const CARD_H = 24, CARD_GAP = 6, CARD_TEXT_PT = 8.5, CARD_LABEL_PT = 6.5;
function mediaBox(rec, item) {
  let w, h;
  if (item && item.w) { w = item.w; h = item.w * rec.h / rec.w; }
  else { const s = Math.min(320 / rec.w, 240 / rec.h, 1); w = rec.w * s; h = rec.h * s; }
  w *= 0.75; h *= 0.75;                  // CSS px -> pt
  // A picture never spans pages, so it can never be bigger than one. The sheet
  // clamps the same way (applyMediaLayout), and the -6 keeps the line it sits
  // on inside the page instead of one point over, which would bounce it to a
  // page of its own forever.
  const s2 = Math.min(1, (PAGE_W - 2 * MARGIN_X) / w, (PAGE_H - 2 * MARGIN_Y - 6) / h);
  return { w: w * s2, h: h * s2 };
}
// Widths (per 1000 units) for ASCII 32..126 in the base-14 fonts we use. Real
// AFM numbers: without them word wrapping would drift from what the page shows.
const W_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const W_TIMES = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
const W_TIMES_B = [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520];
// Which base-14 font each UI font maps to, and the widths that go with it.
function pdfFontFor(family, bold, italic) {
  const f = (family || "").toLowerCase();
  let base = "Helvetica", widths = bold ? W_HELV_B : W_HELV;
  if (/georgia|times|serif/.test(f) || !f) { base = "Times"; widths = bold ? W_TIMES_B : W_TIMES; }
  if (/courier|consolas|mono/.test(f)) return { name: "Courier" + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""), fixed: 600 };
  if (base === "Times") {
    const suffix = bold && italic ? "-BoldItalic" : bold ? "-Bold" : italic ? "-Italic" : "-Roman";
    return { name: "Times" + suffix, widths };
  }
  const suffix = bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "";
  return { name: "Helvetica" + suffix, widths };
}
function textWidth(str, font, size) {
  let w = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    const i = c - 32;
    w += font.fixed ? font.fixed : (i >= 0 && i < font.widths.length ? font.widths[i] : 500);
  }
  return w * size / 1000;
}
// PDF strings are Latin-1 here (base-14 fonts have no Unicode cmap); anything
// outside that range degrades to '?' rather than corrupting the file.
// A few characters that DO exist in WinAnsiEncoding but sit outside Latin-1 in
// Unicode - most importantly the bullet, which lists need.
const WINANSI = { "•": "\x95", "–": "\x96", "—": "\x97", "‘": "\x91",
  "’": "\x92", "“": "\x93", "”": "\x94", "…": "\x85", "€": "\x80" };
const pdfEscape = s => String(s)
  .replace(/[•–—‘’“”…€]/g, c => WINANSI[c])
  .replace(/[^\x20-\x7E\x80-\xFF]/g, "?")
  .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Content streams are BYTES, not UTF-8 text: with WinAnsiEncoding a bullet is
// the single byte 0x95 and "ñ" is 0xF1. Encoding them as UTF-8 would emit two
// bytes and the reader would draw two wrong glyphs.
const latin1Bytes = s => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
};

async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  const cs = new CompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal writer: objects are appended, then an xref table is emitted. Streams
// carry raw bytes, so image data never goes through a string.
function pdfDoc() {
  const chunks = [];        // (string | Uint8Array)[]
  const offsets = [0];      // object number -> byte offset
  let len = 0;
  const push = c => { const b = typeof c === "string" ? latin1Bytes(c) : c; chunks.push(b); len += b.length; };
  const obj = () => { offsets.push(len); return offsets.length - 1; };
  return {
    push, obj, get len() { return len; },
    // Reserve a number now, fill it in later (pages need their kids' numbers).
    reserve() { offsets.push(-1); return offsets.length - 1; },
    place(n) { offsets[n] = len; },
    write(n, body) { offsets[n] = len; push(n + " 0 obj\n" + body + "\nendobj\n"); },
    stream(n, dict, data) {
      offsets[n] = len;
      push(n + " 0 obj\n<< " + dict + " /Length " + data.length + " >>\nstream\n");
      push(data);
      push("\nendstream\nendobj\n");
    },
    finish(rootN) {
      const xref = len;
      let s = "xref\n0 " + offsets.length + "\n0000000000 65535 f \n";
      for (let i = 1; i < offsets.length; i++) s += String(Math.max(0, offsets[i])).padStart(10, "0") + " 00000 n \n";
      s += "trailer\n<< /Size " + offsets.length + " /Root " + rootN + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
      push(s);
      const out = new Uint8Array(len);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    },
  };
}

// Walk a sanitized page fragment into styled runs. A run is a piece of text (or
// an image / attachment card / redaction) with everything needed to draw it.
function collectRuns(root, mediaFor) {
  const blocks = [];
  let cur = { align: "left", items: [] };
  const pushBlock = () => { blocks.push(cur); cur = { align: cur.align, items: [], frame: cur.frame }; };
  const walk = (node, st) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const parts = child.data.split("\n");
        parts.forEach((p, i) => {
          if (i) pushBlock();
          if (p) cur.items.push({ t: "text", s: p, ...st });
        });
      } else if (child.nodeType !== 1) continue;
      else if (child.tagName === "BR") pushBlock();
      else if (child.getAttribute && child.getAttribute("data-censor") === "1") {
        // Only a COUNT leaves this branch, never the characters. Carrying the
        // string and measuring it made the bar's width an exact glyph-metric
        // oracle of the hidden text - enough to distinguish candidate words.
        cur.items.push({ t: "censor", len: (child.textContent || "").length, ...st });
      } else if (child.classList && child.classList.contains("inline-media")) {
        const mid = child.getAttribute("data-mid"), kind = child.getAttribute("data-kind");
        const lay = mediaLayout(child);
        cur.items.push({ t: "media", mid, kind, meta: mediaFor(mid), w: lay.w, align: lay.align,
          fx: lay.fx, fy: lay.fy });
      } else if (child.tagName === "TABLE") {
        if (cur.items.length) pushBlock();
        // Tables are laid out by the renderer, so they travel as one item
        // carrying their cell text.
        const rows = [...child.querySelectorAll("tr")].map(tr =>
          [...tr.children].map(td => ({
            // Cells are read as TOKENS, not textContent: a censored span inside a
            // table must lose its characters exactly like one in a paragraph.
            // textContent would have copied the secret straight into the PDF.
            tokens: cellTokens(td),
            header: td.tagName === "TH",
            align: (/text-align:\s*(center|right)/.exec(td.getAttribute("style") || "") || [])[1] || "left",
          })));
        const tl = mediaLayout(child);
        // Carry the column widths and row heights the handles set, so the PDF
        // has the same proportions as the page on screen.
        const firstRow = child.querySelector("tr");
        const colPx = firstRow ? [...firstRow.children].map(c =>
          parseInt((/width:\s*(\d+)px/.exec(c.getAttribute("style") || "") || [])[1] || "", 10) || 0) : [];
        const rowPx = [...child.querySelectorAll("tr")].map(tr =>
          parseInt((/height:\s*(\d+)px/.exec((tr.children[0] || {}).getAttribute
            ? tr.children[0].getAttribute("style") || "" : "") || [])[1] || "", 10) || 0);
        if (rows.length) blocks.push({ align: "left",
          items: [{ t: "table", rows, fx: tl.fx, fy: tl.fy, colPx, rowPx, ...st }] });
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName) || child.tagName === "LI") {
        if (cur.items.length) pushBlock();
        const style = child.getAttribute ? (child.getAttribute("style") || "") : "";
        const al = /text-align:\s*(left|center|right|justify)/.exec(style);
        const prev = cur.align, prevFrame = cur.frame;
        // A design's header/footer is furniture belonging to THIS page, marked
        // so it can never open a page of its own - a footer that did not quite
        // fit used to print alone on the next sheet, three times over.
        if (child.dataset && child.dataset.frame) cur.frame = child.dataset.frame;
        // A line with no alignment of its own takes its container's, exactly as
        // CSS inherits it: the lines of a centred frame print centred.
        cur.align = al ? al[1] : prev;
        // Numbered lists count; bullet lists get the bullet.
        if (child.tagName === "LI") {
          const marker = st.olIndex ? st.olIndex + ".  " : "•  ";
          cur.items.push({ t: "text", s: marker, ...st });
          if (st.ol) st.olIndex++;
        }
        const before = blocks.length;
        walk(child, st);
        // A line prints as a line even when it is empty, and a <br> that ends it
        // (the placeholder an empty line holds) adds none of its own; a block
        // that only held other blocks (a frame of lines) adds nothing either.
        if (cur.items.length || (blocks.length === before && child.firstChild)) pushBlock();
        cur.align = prev;
        cur.frame = prevFrame;
      } else if (child.tagName === "UL" || child.tagName === "OL") {
        if (cur.items.length) pushBlock();
        // A counter that lives for this list only, so nested/sequential lists
        // each start at 1.
        const isOl = child.tagName === "OL";
        walk(child, { ...st, ol: isOl, olIndex: isOl ? 1 : 0 });
      } else if (child.tagName === "A") {
        // Links print in the link colour and underlined; the URL itself stays
        // readable in the note.
        walk(child, { ...st, under: true, color: "#1a4f8a" });
      } else {
        const tag = child.tagName;
        const style = child.getAttribute ? (child.getAttribute("style") || "") : "";
        const fam = /font-family:\s*([^;]+)/.exec(style);
        const size = /font-size:\s*(\d+(?:\.\d+)?)(pt|px)/.exec(style);
        // Anchored to the start of a declaration: unanchored, "color:" also
        // matched inside "background-color:", and highlighted text printed in
        // its highlight colour.
        const col = /(?:^|;)\s*color:\s*(#[0-9a-f]{3,8})/i.exec(style);
        const bg = /background-color:\s*(#[0-9a-f]{3,8})/i.exec(style);
        const next = {
          bold: st.bold || tag === "B" || tag === "STRONG" || /font-weight:\s*(bold|[6-9]00)/.test(style),
          italic: st.italic || tag === "I" || tag === "EM" || /font-style:\s*italic/.test(style),
          under: st.under || tag === "U" || /text-decoration:\s*underline/.test(style),
          strike: st.strike || tag === "S" || tag === "STRIKE" || /line-through/.test(style),
          family: fam ? fam[1].trim() : st.family,
          size: size ? +size[1] * (size[2] === "px" ? 0.75 : 1) : st.size,
          color: col ? col[1] : st.color,
          bg: bg ? bg[1] : st.bg,
        };
        // (text-align on a piece of text does nothing on the sheet, so it does
        // nothing here either.)
        walk(child, next);
      }
    }
  };
  walk(root, { bold: false, italic: false, under: false, strike: false, family: "", size: 12, color: "#000000", bg: null });
  if (cur.items.length) blocks.push(cur);
  return blocks;
}
// Flatten a table cell into drawable tokens, keeping redactions opaque: the
// censored text never leaves this function, only its measured width.
function cellTokens(td) {
  const out = [];
  const walk = (node, censored) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const s = c.data.replace(/\s+/g, " ");
        if (!s) continue;
        if (censored) out.push({ censor: true, len: s.length });
        else out.push({ s });
      } else if (c.nodeType === 1) {
        walk(c, censored || (c.getAttribute && c.getAttribute("data-censor") === "1"));
      }
    }
  };
  walk(td, false);
  return out;
}
// The one rule every redaction bar is sized by, everywhere it is drawn: a
// coarse BUCKET of the character count (steps of 4, capped at 24), scaled by
// the font size. What an artifact can reveal about a censored run is at most
// which of seven buckets its length fell into - never its glyph widths, never
// its exact count.
const censorLenBucket = len => Math.min(24, Math.max(4, Math.ceil((+len || 1) / 4) * 4));
const censorBarW = (len, size) => censorLenBucket(len) * (size || 12) * 0.5;
const hexToRgb = h => {
  const s = h.replace("#", "");
  const n = s.length === 3 ? s.split("").map(c => c + c).join("") : s.slice(0, 6);
  const v = parseInt(n, 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
};

// Decode an image to something a PDF can carry: JPEG passes through untouched
// (DCTDecode), everything else is drawn to a canvas and deflated as raw RGB.
// What the JPEG itself says it is, read from its SOF marker: the frame size and
// the number of colour components. The browser's ImageBitmap is NOT a substitute
// - it applies EXIF orientation, so a rotated phone photo reports 4032x3024
// while the data in the file is 3024x4032.
function jpegFrame(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }              // resync on padding
    const m = bytes[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m === 0xD9 || m === 0xDA) return null;             // hit the scan, no frame header
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      if (i + 9 >= bytes.length) return null;
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8],
        comps: bytes[i + 9], progressive: m === 0xC2 };
    }
    i += 2 + len;
  }
  return null;
}
// True when a JPEG carries anything beyond pixels: EXIF/XMP/ICC (APP1-APP15),
// comments, or an APP0 that is not plain JFIF.
function jpegHasMetadata(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return true;   // not ours to vouch for
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const m = bytes[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m === 0xD9 || m === 0xDA) return false;      // reached the scan: clean
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return true;
    if (m >= 0xE1 && m <= 0xEF) return true;         // APP1..15: EXIF, XMP, ICC...
    if (m === 0xFE) return true;                     // COM
    if (m === 0xE0) {                                // APP0 must be bare JFIF
      const tag = String.fromCharCode(bytes[i+4]||0, bytes[i+5]||0, bytes[i+6]||0, bytes[i+7]||0);
      if (tag !== "JFIF") return true;
    }
    i += 2 + len;
  }
  return true;                                       // never reached the scan
}
async function pdfImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return null;
  // Read the dimensions FIRST: close() (and zeroing the canvas) resets them to
  // 0, which silently produced /Width 0 and NaN placement maths.
  const W = bmp.width, H = bmp.height;
  if (!(W > 0 && H > 0)) { bmp.close && bmp.close(); return null; }
  if (mimeBase(mime) === "image/jpeg") {
    const f = jpegFrame(bytes);
    // Pass the file through untouched ONLY when it is a plain 3-component JPEG
    // whose own frame size matches what was decoded. A rotated photo, a CMYK or
    // greyscale JPEG, or anything unparseable goes down the canvas path instead:
    // declaring the wrong size or colour space left the viewer decoding short and
    // painting the rest of the picture solid black.
    // AND only when it carries no metadata segments. Ingest scrubs EXIF, but
    // that scrub fails SILENTLY (a decode error returns the original file), and
    // pass-through would then ship EXIF/GPS verbatim inside the PDF. The export
    // boundary enforces the invariant itself: any APPn beyond a bare JFIF APP0,
    // or a comment, forces the canvas re-encode, which keeps pixels only.
    if (f && f.comps === 3 && f.w === W && f.h === H && !jpegHasMetadata(bytes)) {
      bmp.close && bmp.close();
      return { w: W, h: H, filter: "/DCTDecode", data: new Uint8Array(bytes) };
    }
  }
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);   // flatten alpha onto white
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  const img = ctx.getImageData(0, 0, W, H).data;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < img.length; i += 4) { rgb[j++] = img[i]; rgb[j++] = img[i + 1]; rgb[j++] = img[i + 2]; }
  c.width = c.height = 0;
  const packed = await deflate(rgb);
  return { w: W, h: H, filter: packed ? "/FlateDecode" : null, data: packed || rgb };
}

// Lay a note out and produce the PDF bytes.
async function buildNotePdf(n, opts) {
  opts = opts || {};
  const doc = pdfDoc();
  // The header is the first thing written, so every recorded offset is already
  // absolute. (Prefixing it afterwards meant rewriting the xref table, and the
  // decode/encode round-trip that needed silently corrupted every byte in
  // 0x80-0x9F - bullets, and any compressed image data that used them.)
  doc.push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const pages = [];              // { content: string[], images: {name, obj}[] }
  const fontObjs = new Map();    // base-14 name -> object number
  const imgObjs = new Map();     // media id -> { obj, dims }
  let page = null, y = 0;
  const floats = [];             // pinned images, drawn after the text of their page
  const usableW = PAGE_W - 2 * MARGIN_X;
  // Attachments are only reachable when the export writes them next to the PDF,
  // so only a folder export gets clickable reference cards.
  const linkNames = opts.linkFiles ? sidecarNames(n) : null;
  const newPage = () => { page = { ops: [], uses: new Set(), annots: [], minY: PAGE_H - MARGIN_Y }; pages.push(page); y = PAGE_H - MARGIN_Y; };
  // How deep this page's flow actually reached: under strictPage nothing breaks,
  // so a browser/writer metric disagreement pushes content past the margin, and
  // the page is rescaled at assembly rather than silently clipped off the paper.
  const sink = () => { if (page && y < page.minY) page.minY = y; };
  // A paged note has already been laid out on screen, one sheet per A4 page, and
  // the sheets are the authority. So while a paged note is drawn, a page break
  // is FORBIDDEN: if the writer's metrics disagree with the browser's by a line,
  // the answer is to keep that line on its page, not to open an extra page and
  // put the rest of the document out of step with what the user is looking at.
  let strictPage = false;
  const need = h => { if (!strictPage && y - h < MARGIN_Y) newPage(); };
  const fontRef = f => {
    if (!fontObjs.has(f.name)) fontObjs.set(f.name, doc.reserve());
    return "F" + [...fontObjs.keys()].indexOf(f.name);
  };
  // Pre-decrypt every image this note references OUTSIDE a censored region.
  // A censored image must never even be decrypted for export: bodyMediaIds on
  // the raw string saw every reference, so a censored picture was decrypted,
  // registered, and shipped in the file as an orphan object - never drawn, but
  // byte-identical and carvable by anyone holding the PDF.
  const wanted = new Set();
  for (const b of noteBodies(n)) if (b.bodyV === 2) for (const mid of visibleMediaIds(b.body)) wanted.add(mid);
  for (const mid of wanted) {
    const meta = (n.media || []).find(m => m.id === mid);
    if (!meta || !isRenderableImage(meta.mime)) continue;
    try {
      const rec = await idbGet(mid);
      if (!rec) continue;
      const plain = await decryptMedia(mid, rec.bytes);
      if (!vault) return null;                       // locked mid-export
      const im = await pdfImage(plain, meta.mime);
      if (!im) continue;
      const num = doc.reserve();
      imgObjs.set(mid, { obj: num, w: im.w, h: im.h, img: im });
    } catch {}
  }
  const metaFor = mid => (n.media || []).find(m => m.id === mid) || null;

  // A line box is an ascent above the baseline and a descent below it. The
  // baseline has to sit at the bottom of the box, because an image is drawn
  // UPWARD from it: anchoring it 0.85 of a TEXT size below the top meant a
  // 180pt picture reached 170pt above its own line, over the paragraph before
  // it and off the top of the page.
  const lineAscent = (maxSize, maxImgH) => Math.max(maxSize * 0.85, maxImgH);
  const lineDescent = maxSize => maxSize * 0.7;   // 0.85 + 0.7 = the sheet's 1.55
  const drawLine = (items, align, lineW, lineH, maxSize, ascent, wrapped) => {
    let x = MARGIN_X;
    if (align === "center") x += (usableW - lineW) / 2;
    else if (align === "right") x += usableW - lineW;
    // Justified: a line the paragraph wrapped from (never its last) is spread to
    // the full width by widening its spaces, as the sheet does. Trailing spaces
    // do not count.
    let gap = 0;
    if (align === "justify" && wrapped) {
      let end = items.length;
      while (end > 0 && items[end - 1].t === "text" && !/\S/.test(items[end - 1].s)) end--;
      const body = items.slice(0, end);
      const spaces = body.filter(it => it.t === "text" && !/\S/.test(it.s)).length;
      const w = body.reduce((a, it) => a + it.w, 0);
      if (spaces && w < usableW) gap = (usableW - w) / spaces;
    }
    const base = y - (ascent === undefined ? maxSize * 0.85 : ascent);
    for (const it of items) {
      if (gap && it.t === "text" && !/\S/.test(it.s)) it.w += gap;
      if (it.t === "img") {
        // Sits on the line's baseline, like an inline-block on the sheet.
        // Claim the XObject HERE, not where the image was queued: a line is
        // queued against one page and drawn after need() may have started the
        // next one. Registering it early left the new page's /Resources without
        // the name it invokes, and a Do on an undefined name draws NOTHING -
        // the picture vanished and left an almost empty page behind.
        page.uses.add("img:" + it.mid);
        page.ops.push(`q ${it.w.toFixed(2)} 0 0 ${it.h.toFixed(2)} ${x.toFixed(2)} ${base.toFixed(2)} cm /Im${imgName(it.mid)} Do Q`);
        x += it.w;
        continue;
      }
      if (it.t === "card") {
        const top = base + it.h;
        const cw = it.w - CARD_GAP;          // the gutter lives inside the slot
        page.ops.push(`0.96 0.96 0.96 rg ${x.toFixed(2)} ${base.toFixed(2)} ${cw.toFixed(2)} ${it.h} re f`);
        page.ops.push(`0.55 0.55 0.55 RG 2 w ${x.toFixed(2)} ${base.toFixed(2)} m ${x.toFixed(2)} ${top.toFixed(2)} l S`);
        const fb = pdfFontFor("Helvetica", true, false);
        page.uses.add(fb.name);
        page.ops.push(`BT 0.25 0.25 0.25 rg /${fontRef(fb)} ${CARD_LABEL_PT} Tf ${(x + 6).toFixed(2)} ${(top - 9).toFixed(2)} Td (${pdfEscape(it.label)}) Tj ET`);
        const fn = pdfFontFor("Helvetica", false, false);
        page.uses.add(fn.name);
        // Clip a long filename to the card instead of letting it run into its
        // neighbour.
        let txt = it.text;
        while (txt.length > 4 && textWidth(txt, fn, CARD_TEXT_PT) > cw - 12) txt = txt.slice(0, -2);
        if (txt !== it.text) txt = txt.slice(0, -1) + "…";
        page.ops.push(`BT ${it.uri ? "0.13 0.33 0.72" : "0.1 0.1 0.1"} rg /${fontRef(fn)} ${CARD_TEXT_PT} Tf ` +
          `${(x + 6).toFixed(2)} ${(top - 19).toFixed(2)} Td (${pdfEscape(txt)}) Tj ET`);
        if (it.uri) {
          const tw = textWidth(txt, fn, CARD_TEXT_PT);
          page.ops.push(`0.13 0.33 0.72 RG 0.6 w ${(x + 6).toFixed(2)} ${(top - 20.5).toFixed(2)} m ` +
            `${(x + 6 + tw).toFixed(2)} ${(top - 20.5).toFixed(2)} l S`);
          // The whole card is the hit area, not just the text.
          page.annots.push({ rect: [x, base, x + cw, top], uri: it.uri });
        }
        x += it.w;
        continue;
      }
      if (it.t === "censor") {
        page.ops.push(`0 0 0 rg ${x.toFixed(2)} ${(base - it.size * 0.22).toFixed(2)} ${it.w.toFixed(2)} ${(it.size * 1.05).toFixed(2)} re f`);
        x += it.w;
        continue;
      }
      let [r, g, b] = hexToRgb(it.color || "#000000");
      if (it.bg) {
        // The highlight, drawn first so the text sits on it (the same box a
        // redaction bar uses).
        const [hr, hg, hb] = hexToRgb(it.bg);
        page.ops.push(`${hr.toFixed(3)} ${hg.toFixed(3)} ${hb.toFixed(3)} rg ${x.toFixed(2)} ${(base - it.size * 0.22).toFixed(2)} ` +
          `${it.w.toFixed(2)} ${(it.size * 1.05).toFixed(2)} re f`);
        // Text that cannot be read against its highlight (dark ink on a black
        // highlight is the classic one) would look redacted in the PDF while
        // every character stayed in the file, ready to be copied out. It is
        // printed readable instead; only Censor removes text.
        const lum = (x1, x2, x3) => 0.2126 * x1 + 0.7152 * x2 + 0.0722 * x3;
        const lt = lum(r, g, b), lb = lum(hr, hg, hb);
        if (Math.abs(lt - lb) < 0.35) [r, g, b] = lb < 0.5 ? [1, 1, 1] : [0, 0, 0];
      }
      const ref = fontRef(it.font);
      page.uses.add(it.font.name);
      page.ops.push(`BT ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /${ref} ${it.size} Tf ` +
        `${x.toFixed(2)} ${base.toFixed(2)} Td (${pdfEscape(it.s)}) Tj ET`);
      if (it.under) page.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${(it.size * 0.06).toFixed(2)} w ` +
        `${x.toFixed(2)} ${(base - it.size * 0.13).toFixed(2)} m ${(x + it.w).toFixed(2)} ${(base - it.size * 0.13).toFixed(2)} l S`);
      if (it.strike) page.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${(it.size * 0.06).toFixed(2)} w ` +
        `${x.toFixed(2)} ${(base + it.size * 0.28).toFixed(2)} m ${(x + it.w).toFixed(2)} ${(base + it.size * 0.28).toFixed(2)} l S`);
      x += it.w;
    }
    y -= lineH;
    sink();
  };

  const renderBlock = blk => {
    const line = [];
    let lineW = 0, maxSize = 12, maxImgH = 0;
    // Whether this block put anything on the page yet. A block that only holds a
    // table or a pinned item must not also cost an empty line: flushing an empty
    // line before and after every table printed two blank lines around each one
    // that the sheet does not have.
    let drew = false;
    const isPinnedItem = it => (it.t === "media" || it.t === "table") && it.fx !== null && it.fx !== undefined;
    // wrapped: the line ends because the next thing did not fit (so a justified
    // paragraph spreads it), not because the paragraph ended.
    const flush = wrapped => {
      if (!line.length) return;
      drew = true;
      // A line is as tall as its tallest thing: images share the line with text
      // exactly as they do on the sheet, instead of each taking a line of its own.
      // Text-only, this is 0.85 + 0.7 = the sheet's 1.55 line-height, so the
      // same number of lines lands on each page.
      const asc = lineAscent(maxSize, maxImgH);
      // A row of pictures with no text on it is exactly as tall as the pictures -
      // that is what the browser gives it. Adding a text descent underneath made
      // every image row 8pt taller than the sheet's, which is what pushed the
      // footer through the last lines of the page.
      const textOnLine = line.some(it => it.t !== "img");
      const lh = asc + (maxImgH && !textOnLine ? 0 : lineDescent(maxSize));
      // The frame belongs to the page it is on: it draws where the flow is,
      // rather than opening a page for itself. If the flow has run past the
      // bottom margin it is pulled back inside, so a footer prints ON the page
      // instead of hanging off the edge.
      // Only the paper edge is a hard stop: pulling it up to the text margin
      // would print the footer straight through the last lines of the page.
      if (blk.frame) { if (y - lh < 12) y = 12 + lh; }
      else need(lh);
      drawLine(line.slice(), blk.align, lineW, lh, maxSize, asc, wrapped === true);
      line.length = 0; lineW = 0; maxSize = 12; maxImgH = 0;
    };
    for (const item of blk.items) {
      if (item.t === "table") {
        flush();
        // Equal columns across the text width, cells wrapped to their column and
        // the row grown to its tallest cell. Rows that do not fit start a page.
        const pinned = item.fx !== null && item.fx !== undefined;
        // A pinned table is drawn at its own spot and never disturbs the text:
        // save the flow position, draw from the pinned origin, then restore.
        const savedY = y;
        let originX = MARGIN_X, tableW = usableW;
        if (pinned) {
          originX = PAGE_W * item.fx / 100;
          y = PAGE_H - PAGE_H * item.fy / 100;
          tableW = Math.min(usableW, PAGE_W - originX);
        }
        const cols = Math.max(1, ...item.rows.map(r => r.length));
        // Column widths: whatever the handles set, scaled to the available
        // width; equal columns when nothing was set.
        const px = (item.colPx || []).slice(0, cols);
        while (px.length < cols) px.push(0);
        const totalPx = px.reduce((a, b) => a + b, 0);
        // Match the screen: a narrow table prints narrow. Only stretch when the
        // columns would overflow the text width. (Always normalising to the full
        // width made a 451px on-screen table print edge to edge.)
        const filled = px.map(v => v || (totalPx > 0 ? totalPx / cols : 0));
        const sumPt = filled.reduce((a, b) => a + b, 0) * 0.75;   // css px -> pt
        const target = totalPx > 0 ? Math.min(sumPt, tableW) : tableW;
        const colWs = totalPx > 0
          ? filled.map(v => v * target / filled.reduce((a, b) => a + b, 0))
          : px.map(() => tableW / cols);
        const colX = [];
        colWs.reduce((acc, w, i) => { colX[i] = acc; return acc + w; }, 0);
        const pad = 4, fsize = 10.5;
        item.rows.forEach((row, ri) => {
          const fonts = row.map(c => pdfFontFor("Helvetica", c.header, false));
          // Wrap each cell first so the row height is known before drawing.
          // Wrap into lines of ITEMS (text or redaction bars), so a censored
          // cell draws a bar and its characters never reach the file.
          const wrapped = row.map((c, ci) => {
            const maxW = (colWs[ci] || tableW / cols) - 2 * pad;
            const lines = [[]];
            let w = 0;
            const put = (item, iw) => {
              if (w + iw > maxW && w > 0) { lines.push([]); w = 0; }
              lines[lines.length - 1].push(item);
              w += iw;
            };
            for (const tok of (c.tokens || [])) {
              if (tok.censor) { const cw = censorBarW(tok.len, fsize); put({ censor: true, w: cw }, cw); continue; }
              for (const word of String(tok.s).split(/(\s+)/)) {
                if (!word) continue;
                put({ s: word }, textWidth(word, fonts[ci], fsize));
              }
            }
            return lines;
          });
          // The row is as tall as its content needs, or as tall as the row
          // handle made it - whichever is greater.
          const wanted = (item.rowPx || [])[ri] ? (item.rowPx[ri] * 0.75) : 0;   // px -> pt
          const rowH = Math.max(Math.max(...wrapped.map(l => l.length)) * (fsize * 1.3) + 2 * pad, wanted);
          if (!pinned) need(rowH);   // a pinned table keeps its page, it never reflows
          const top = y;
          row.forEach((c, ci) => {
            const cw = colWs[ci] || tableW / cols;
            const x = originX + (colX[ci] || 0);
            if (c.header) page.ops.push(`0.93 0.93 0.93 rg ${x.toFixed(2)} ${(top - rowH).toFixed(2)} ${cw.toFixed(2)} ${rowH.toFixed(2)} re f`);
            page.ops.push(`0.53 0.53 0.53 RG 0.75 w ${x.toFixed(2)} ${(top - rowH).toFixed(2)} ${cw.toFixed(2)} ${rowH.toFixed(2)} re S`);
            const ref = fontRef(fonts[ci]); page.uses.add(fonts[ci].name);
            wrapped[ci].forEach((ln, li) => {
              const lw = ln.reduce((a, it) => a + (it.censor ? it.w : textWidth(it.s, fonts[ci], fsize)), 0);
              let tx = x + pad;
              if (c.align === "center") tx = x + (cw - lw) / 2;
              else if (c.align === "right") tx = x + cw - pad - lw;
              const ty = top - pad - fsize * 0.85 - li * (fsize * 1.3);
              for (const it of ln) {
                if (it.censor) {
                  page.ops.push(`0 0 0 rg ${tx.toFixed(2)} ${(ty - fsize * 0.22).toFixed(2)} ${it.w.toFixed(2)} ${(fsize * 1.05).toFixed(2)} re f`);
                  tx += it.w;
                  continue;
                }
                page.ops.push(`BT 0 0 0 rg /${ref} ${fsize} Tf ${tx.toFixed(2)} ${ty.toFixed(2)} Td (${pdfEscape(it.s)}) Tj ET`);
                tx += textWidth(it.s, fonts[ci], fsize);
              }
            });
          });
          y = top - rowH;
        });
        if (pinned) y = savedY;    // the flow carries on as if the table were not there
        else { y -= 8; sink(); drew = true; }
        continue;
      }
      if (item.t === "media") {
        const rec0 = imgObjs.get(item.mid);
        // Freely placed: drawn at its own spot on the page and taken out of the
        // flow entirely, so the text around it is unaffected - exactly what is
        // on screen.
        if (item.fx !== null && item.fx !== undefined && rec0) {
          const fb = mediaBox(rec0, item);
          const w = Math.min(fb.w, PAGE_W);
          const h = fb.h * (w / fb.w);
          const x = PAGE_W * item.fx / 100;
          const yTop = PAGE_H - PAGE_H * item.fy / 100;
          floats.push({ mid: item.mid, x, y: yTop - h, w, h, page: pages.length - 1 });
          continue;
        }
        const rec = rec0;
        if (rec) {
          const box = mediaBox(rec, item);
          const w = Math.min(box.w, usableW);
          const h = box.h * (w / box.w);
          if (item.align) {
            // Explicitly aligned images keep a line to themselves, as on screen.
            flush();
            need(h + 8);
            let x = MARGIN_X;
            if (item.align === "center") x += (usableW - w) / 2;
            else if (item.align === "right") x += usableW - w;
            page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(y - h).toFixed(2)} cm /Im${imgName(item.mid)} Do Q`);
            page.uses.add("img:" + item.mid);
            y -= h + 8;
            sink();
            drew = true;
            continue;
          }
          // Otherwise it flows in the line like any other inline thing, so a row
          // of pictures prints as a row - matching the sheet, and therefore the
          // same number of pages.
          if (lineW + w > usableW && lineW > 0) flush(true);
          line.push({ t: "img", mid: item.mid, w, h });
          lineW += w;
          if (h > maxImgH) maxImgH = h;
          // NOT page.uses.add here - drawLine claims it on whatever page the
          // line actually lands on.
          continue;
        }
        // Only break the line if one is pending: an unconditional flush spent an
        // empty 14pt line on every card, so the PDF ran out of page before the
        // sheet did and a run of attachments paginated differently.
        {
          // Video / document / missing image: a reference card. It FLOWS in the
          // line like a picture does, two across the text column, because a
          // full-width card each threw away half of every page.
          const label = { video: "VIDEO", pdf: "PDF", text: "TEXT", file: "FILE" }[item.kind] || "ATTACHMENT";
          const name = (item.meta && item.meta.name) || "not on this device";
          const size = item.meta && item.meta.size ? "  (" + fmtSize(item.meta.size) + ")" : "";
          const target = linkNames && linkNames.get(item.mid);
          // The slot is as wide as the CHIP the sheet shows - a constant per
          // kind ("Open PDF", "Play video"...), never the filename. Sizing by
          // filename made the PDF wrap into far more card rows than the sheet,
          // and under strictPage the overflow was drawn below the margin and
          // clipped off the paper. The filename still prints, truncated into
          // the slot, and stays the link target in full.
          const fTxt = pdfFontFor("Helvetica", false, false);
          const chipLabel = { video: "Play video", pdf: "Open PDF", text: "View text", file: "Download file" }[item.kind] || "Download file";
          // 14px glyph + 6px gap + 2x10px padding (in pt) + the label at ~9pt.
          const w = Math.min(usableW, 30 + textWidth(chipLabel, fTxt, 9) + CARD_GAP);
          if (lineW + w > usableW + 0.5 && lineW > 0) flush(true);
          line.push({ t: "card", label, text: name + size, w, h: CARD_H,
            uri: target ? "files/" + encodeURIComponent(target) : null });
          lineW += w;
          if (CARD_H > maxImgH) maxImgH = CARD_H;
        }
        continue;
      }
      if (item.t === "censor") {
        // Width from the shared bucket rule - the quantized value drives the
        // wrap test and lineW too, or aligned lines would drift off the margin.
        const size = item.size || 12;
        const w = censorBarW(item.len, size);
        if (lineW + w > usableW && lineW > 0) flush(true);
        line.push({ t: "censor", w, size });
        lineW += w;
        if (size > maxSize) maxSize = size;
        continue;
      }
      const font = pdfFontFor(item.family, item.bold, item.italic);
      const size = item.size || 12;
      // Word wrap against the real font metrics.
      for (const word of item.s.split(/(\s+)/)) {
        if (!word) continue;
        const w = textWidth(word, font, size);
        if (lineW + w > usableW && lineW > 0 && /\S/.test(word)) flush(true);
        line.push({ t: "text", s: word, font, size, w, color: item.color, bg: item.bg, under: item.under, strike: item.strike });
        lineW += w;
        if (size > maxSize) maxSize = size;
      }
    }
    flush();
    // An empty line costs a real line, the same 1.55 the sheet gives it:
    // charging less here fitted more per page than the screen did. A block of
    // nothing but pinned items is out of the flow and costs nothing.
    if (!drew && !(blk.items.length && blk.items.every(isPinnedItem))) { y -= 12 * 1.55; sink(); }
  };

  const bodies = noteBodies(n);
  const paged = isPaged(n);
  newPage();
  // A PAGED note is a laid-out document: what is on the sheet is the whole page,
  // so no app chrome is added. (Printing the note title and page names on top
  // pushed designed covers onto a second sheet and did not match the screen.)
  // A single-page note still gets its title, which is its only identifier.
  if (!paged) {
    const f = pdfFontFor("", true, false);
    const ref = fontRef(f); page.uses.add(f.name);
    const t = (n.title || "Untitled").trim() || "Untitled";
    page.ops.push(`BT 0 0 0 rg /${ref} 20 Tf ${MARGIN_X} ${(y - 20).toFixed(2)} Td (${pdfEscape(t)}) Tj ET`);
    y -= 34;
  }
  strictPage = paged;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (paged && i > 0) newPage();                 // one sheet per page, as on screen
    const holder = document.createElement("div");
    // The same lines the sheet shows, so both lay out (and paginate) alike.
    holder.appendChild(bodyFragment(b.body, b.bodyV));
    for (const blk of collectRuns(holder, metaFor)) renderBlock(blk);
  }

  // Pinned images go on last so they sit above the text, matching the editor.
  for (const f of floats) {
    const p = pages[f.page] || pages[pages.length - 1];
    if (!p) continue;
    p.ops.push(`q ${f.w.toFixed(2)} 0 0 ${f.h.toFixed(2)} ${f.x.toFixed(2)} ${f.y.toFixed(2)} cm /Im${imgName(f.mid)} Do Q`);
    p.uses.add("img:" + f.mid);
  }

  // ---- assemble ----
  // Any page whose flow ran past the bottom margin is uniformly rescaled to fit,
  // anchored at the top-left of the text area. Slightly smaller type on that one
  // page beats the old behaviour: rows drawn below the margin, and past ~51pt of
  // overrun OFF the paper entirely - the export was silently missing content.
  for (const p of pages) {
    if (!(p.minY < MARGIN_Y - 0.5)) continue;
    const T = PAGE_H - MARGIN_Y;
    const s = (PAGE_H - 2 * MARGIN_Y) / (T - p.minY);
    const dx = MARGIN_X * (1 - s), dy = T * (1 - s);
    p.ops.unshift(`q ${s.toFixed(4)} 0 0 ${s.toFixed(4)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm`);
    p.ops.push("Q");
    for (const a of p.annots) a.rect = a.rect.map((v, i) => i % 2 === 0 ? v * s + dx : v * s + dy);
  }
  const fontNames = [...fontObjs.keys()];
  fontNames.forEach((nm, i) => doc.write(fontObjs.get(nm),
    `<< /Type /Font /Subtype /Type1 /BaseFont /${nm} /Encoding /WinAnsiEncoding >>`));
  for (const [mid, rec] of imgObjs) {
    // Only images some page actually DRAWS are written. Anything else would be
    // an orphan object carrying decrypted image bytes - invisible in a viewer,
    // trivially carved out of the file.
    if (!pages.some(p => p.uses.has("img:" + mid))) continue;
    const im = rec.img;
    doc.stream(rec.obj, `/Type /XObject /Subtype /Image /Width ${rec.w} /Height ${rec.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8${im.filter ? " /Filter " + im.filter : ""}`, im.data);
  }
  const pageObjs = pages.map(() => doc.reserve());
  const pagesObj = doc.reserve();
  pages.forEach((p, i) => {
    const contentN = doc.obj();
    const body = p.ops.join("\n");
    doc.stream(contentN, "", latin1Bytes(body));
    const fontRes = fontNames.map((nm, k) => `/F${k} ${fontObjs.get(nm)} 0 R`).join(" ");
    const imgRes = [...imgObjs.entries()].filter(([mid]) => p.uses.has("img:" + mid))
      .map(([mid, rec]) => `/Im${imgName(mid)} ${rec.obj} 0 R`).join(" ");
    // Link annotations: a relative URI, so the viewer resolves it against the
    // PDF's own location - i.e. the files/ folder sitting next to it.
    const annotRefs = (p.annots || []).map(a => {
      const num = doc.obj();
      doc.write(num, `<< /Type /Annot /Subtype /Link /Rect [${a.rect.map(v => v.toFixed(2)).join(" ")}] ` +
        `/Border [0 0 0] /F 4 /A << /S /URI /URI (${pdfEscape(a.uri)}) >> >>`);
      return num + " 0 R";
    });
    doc.write(pageObjs[i], `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] ` +
      `/Resources << /Font << ${fontRes} >>${imgRes ? " /XObject << " + imgRes + " >>" : ""} >> /Contents ${contentN} 0 R` +
      `${annotRefs.length ? " /Annots [" + annotRefs.join(" ") + "]" : ""} >>`);
  });
  doc.write(pagesObj, `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjs.map(o => o + " 0 R").join(" ")}] >>`);
  const catalog = doc.obj();
  // No /Info dictionary at all: no title, author, producer or creation date.
  doc.write(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  return doc.finish(catalog);
}

// ---------- Export a note to PDF ----------
// Rendered through the browser's own print-to-PDF: no library, no CDN (the app
// must stay a single offline file). The note is written into a same-origin
// about:blank iframe, so nothing leaves the page and the print CSS cannot touch
// the app's own layout. Inline images are decrypted to data: URLs first, since a
// blob: URL owned by this document would not survive into the print context.
// Media ids referenced by a body OUTSIDE censored regions, and the ids whose
// only references are censored. Export paths must use these, never the raw
// reference scan: a censored reference is a redaction, and exporting the bytes
// it points at defeats it.
function censorSplitMediaIds(body) {
  const holder = document.createElement("div");
  holder.appendChild(sanitizeBodyFragment(String(body || "")));
  const visible = new Set(), censored = new Set();
  for (const el of holder.querySelectorAll(".inline-media")) {
    const mid = el.getAttribute("data-mid");
    if (!mid) continue;
    (el.closest('[data-censor="1"]') ? censored : visible).add(mid);
  }
  return { visible, censored };
}
const visibleMediaIds = body => censorSplitMediaIds(body).visible;
// Attachments that cannot live inside the page (videos, documents, text files):
// they travel next to the PDF in files/.
function sidecarAttachments(n) {
  const visible = new Set(), censored = new Set();
  for (const b of noteBodies(n)) if (b.bodyV === 2) {
    const s = censorSplitMediaIds(b.body);
    for (const id of s.visible) visible.add(id);
    for (const id of s.censored) censored.add(id);
  }
  // An attachment never referenced inline still travels (it sits in the strip,
  // uncensored). One whose ONLY references are censored does NOT: the folder
  // export used to write its decrypted bytes under its real filename right next
  // to a PDF showing a black bar.
  return (n.media || []).filter(m => kindForMime(m.mime) !== "image" &&
    (visible.has(m.id) || !censored.has(m.id)));
}
// Filesystem-safe on Windows too: no path/reserved characters, no trailing dot
// or space (both refused by getFileHandle, which aborted a folder export half
// way through), and reserved DOS basenames (CON, NUL, COM1...) prefixed.
function safeName(s) {
  let nm = String(s || "note").replace(/[\\/:*?"<>|]/g, "-").replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 80).replace(/[. ]+$/, "") || "note";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(nm.split(".")[0])) nm = "_" + nm;
  return nm;
}
// The name each attachment will have inside files/. The PDF links to these, and
// the export writes them, so both have to agree on the de-duplication or the
// links point at nothing.
function sidecarNames(n) {
  const used = new Set(), out = new Map();
  for (const m of sidecarAttachments(n)) {
    let nm = safeName(m.name || m.id);
    if (used.has(nm)) {
      const dot = nm.lastIndexOf(".");
      const stem = dot > 0 ? nm.slice(0, dot) : nm, ext = dot > 0 ? nm.slice(dot) : "";
      let k = 2; while (used.has(stem + "-" + k + ext)) k++;
      nm = stem + "-" + k + ext;
    }
    used.add(nm);
    out.set(m.id, nm);
  }
  return out;
}

// The internal writer, wired to the two outputs: a single PDF, or a folder
// holding <note>.pdf plus files/ with everything the PDF only references.
async function exportNoteInternal(id, mode) {
  const n = vault && vault.notes[id];
  if (!n || syncing) return;
  if (id === currentId) flushSave();
  const base = safeName(n.title || "Untitled");
  // Folder mode asks for the destination FIRST. The picker only opens under the
  // click's transient activation, which expires in a few seconds - building the
  // PDF first meant that on any media-heavy note the picker threw without ever
  // appearing, and the export "fell back" to a lone download every time.
  let dir = null;
  if (mode === "folder") {
    const pick = await pickExportDir();
    dir = pick.dir;
    if (!dir && pick.why !== "cancelled") {
      status(pick.why === "unsupported"
        ? "This browser cannot write into folders - exporting the PDF on its own"
        : "The folder picker failed (" + pick.why + ") - exporting the PDF on its own", true);
    }
  }
  status("Building PDF...", false, true);
  let bytes;
  try { bytes = await buildNotePdf(n, { linkFiles: mode === "folder" && !!dir }); }
  catch (e) { status("PDF failed: " + e.message, true); return; }
  if (!bytes) { status(""); return; }
  if (mode !== "folder") {
    downloadPlain(base + ".pdf", "application/pdf", bytes);
    status(`Exported ${base}.pdf`);
    return;
  }
  // Folder mode: the PDF alone at the root, every referenced file inside files/.
  if (!dir) { downloadPlain(base + ".pdf", "application/pdf", bytes);
    status("No folder chosen - the PDF was downloaded on its own", true); return; }
  try {
    const noteDir = await dir.getDirectoryHandle(base, { create: true });
    const writeFile = async (handle, name, data, type) => {
      const fh = await handle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([data], { type: type || "application/octet-stream" }));
      await w.close();
    };
    await writeFile(noteDir, base + ".pdf", bytes, "application/pdf");
    const extras = sidecarAttachments(n);
    let wrote = 0, missing = 0;
    if (extras.length) {
      const filesDir = await noteDir.getDirectoryHandle("files", { create: true });
      const names = sidecarNames(n);      // the same names the PDF links to
      for (const m of extras) {
        status(`Writing ${m.name || "attachment"}...`, false, true);
        let rec = null;
        try { rec = await idbGet(m.id); } catch {}
        if (!rec) { missing++; continue; }
        let plain;
        try { plain = await decryptMedia(m.id, rec.bytes); } catch { missing++; continue; }
        if (!vault) return;                       // locked mid-export
        await writeFile(filesDir, names.get(m.id) || safeName(m.name || m.id), plain, m.mime);
        wrote++;
      }
    }
    status(`Exported to ${base}/ - ${base}.pdf` +
      (wrote ? ` and files/ (${wrote} file${wrote === 1 ? "" : "s"})` : "") +
      (missing ? `, ${missing} not on this device` : ""));
  } catch (e) {
    status("Could not write the folder: " + e.message, true);
  }
}
// A destination picker that does NOT reuse the vault folder handle: exports go
// wherever you want, and must never default to writing into the notes folder.
// Returns { dir, why }: dir when a folder was granted; why = "cancelled" |
// "unsupported" | an error name otherwise. The old bare-null return hid the
// difference between the user closing the dialog and the dialog never opening.
async function pickExportDir() {
  if (!("showDirectoryPicker" in window)) return { dir: null, why: "unsupported" };
  try {
    return { dir: await window.showDirectoryPicker({ id: "notes-export", mode: "readwrite", startIn: "documents" }), why: null };
  } catch (e) {
    return { dir: null, why: e && e.name === "AbortError" ? "cancelled" : ((e && e.name) || "error") };
  }
}

async function exportNotePdf(id) {
  const n = vault && vault.notes[id];
  if (!n || syncing) return;
  if (id === currentId) flushSave();
  status("Preparing PDF...", false, true);
  const esc = s => String(s).replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  // Decrypt each referenced image ONCE into a data: URL - only those outside a
  // censored run: a censored picture is never even decrypted for an export.
  const wanted = new Set();
  for (const b of noteBodies(n)) if (b.bodyV === 2) for (const mid of visibleMediaIds(b.body)) wanted.add(mid);
  const dataUrls = new Map();
  for (const mid of wanted) {
    const meta = (n.media || []).find(m => m.id === mid);
    if (!meta || !isRenderableImage(meta.mime)) continue;   // only images can be drawn on a page
    try {
      const rec = await idbGet(mid);
      if (!rec) continue;
      const plain = await decryptMedia(mid, rec.bytes);
      if (!vault) return;                                    // locked mid-export
      dataUrls.set(mid, await new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res(null);
        fr.readAsDataURL(new Blob([plain], { type: meta.mime }));
      }));
    } catch {}
  }
  // Re-serialize each page through the SAME sanitizer the editor uses, then swap
  // inline-media spans for <img> (images) or a labelled box (everything else).
  const pageHtml = b => {
    if (b.bodyV !== 2) return "<div class=\"pg-text\">" + esc(b.body || "") + "</div>";
    const holder = document.createElement("div");
    // Same packing and lines as the sheets and the native writer: this was the
    // one render path that skipped it, so attachment-only lines stayed
    // block-level here and printed one per row.
    holder.appendChild(bodyFragment(b.body, 2));
    // CENSORED TEXT IS DESTROYED HERE, not hidden. A black background over live
    // text would still be selectable, copyable and searchable in the PDF; the
    // characters must never reach the file. Each span becomes an empty box
    // sized from the character count, so the layout still looks right.
    holder.querySelectorAll("[data-censor]").forEach(sp => {
      const box = document.createElement("span");
      box.className = "censor-box";
      // The same coarse bucket rule as the native writer: never the exact count.
      box.style.width = (censorLenBucket((sp.textContent || "").length) * 0.5) + "em";
      box.setAttribute("aria-label", "redacted");
      sp.replaceWith(box);   // the original text node is dropped with the span
    });
    holder.querySelectorAll("span.inline-media").forEach(sp => {
      const mid = sp.getAttribute("data-mid"), kind = sp.getAttribute("data-kind");
      const meta = (n.media || []).find(m => m.id === mid);
      const url = dataUrls.get(mid);
      const lay = mediaLayout(sp);
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        if (lay.w) img.style.width = lay.w + "px";
        if (lay.align) { img.style.display = "block"; img.style.marginLeft = lay.align === "left" ? "0" : "auto";
          img.style.marginRight = lay.align === "right" ? "0" : "auto"; }
        sp.replaceWith(img);
      } else {
        // Videos, PDFs, documents: a PDF page cannot play or embed them, so they
        // print as a labelled card carrying the filename, kind and size - the
        // information you need to match the file to the note.
        // A SPAN, not a div: a block-level card owns the whole row, so a run of
        // attachments printed one per line with most of the page empty.
        const box = document.createElement("span");
        box.className = "att-box" + (lay.align ? " a-" + lay.align : "");
        const label = { video: "Video", pdf: "PDF", text: "Text file", file: "File" }[kind] || "Attachment";
        const name = (meta && meta.name) || "not on this device";
        const size = meta && meta.size ? " &middot; " + fmtSize(meta.size) : "";
        box.innerHTML = `<span class="att-kind">${esc(label)}</span><span class="att-name">${esc(name)}</span>` +
          `<span class="att-size">${size}</span>`;
        sp.replaceWith(box);
      }
    });
    return holder.innerHTML;
  };
  const bodies = noteBodies(n);
  const paged = isPaged(n);
  const sections = bodies.map((b, i) => {
    // Each page of a paged note starts on a new sheet; a single-page note flows.
    const head = paged ? `<h2 class="pg-head">${esc(b.name || "Page " + (i + 1))}</h2>` : "";
    return `<section class="pg${i && paged ? " brk" : ""}">${head}${pageHtml(b)}</section>`;
  }).join("");
  const title = (n.title || "Untitled").trim() || "Untitled";
  // METADATA: a browser writes the document title into the PDF's Title field and
  // will print header/footer lines (title, URL, date) unless they are turned off.
  // An EMPTY title means nothing about this note reaches the file's metadata; the
  // title still appears as the heading on page 1, where you can see it.
  // Note: the Producer/Creator ("Chromium") and CreationDate fields are written
  // by the browser's own PDF writer and cannot be changed from a page.
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title></title><style>
    @page { margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #111;
      font: 12pt/1.55 ui-serif, Georgia, "Times New Roman", serif; }
    h1 { font-size: 20pt; margin: 0 0 4pt; }
    .meta { color: #666; font-size: 9pt; margin-bottom: 14pt;
      border-bottom: 1px solid #ddd; padding-bottom: 8pt; }
    .pg { break-inside: auto; white-space: pre-wrap; overflow-wrap: break-word; }
    .pg.brk { break-before: page; padding-top: 4pt; }
    .pg-head { font-size: 13pt; margin: 0 0 6pt; color: #333;
      border-left: 3px solid #bbb; padding-left: 8pt; }
    .pg-text { white-space: pre-wrap; word-wrap: break-word; }
    section > div { white-space: pre-wrap; word-wrap: break-word; }
    img { max-width: 100%; height: auto; break-inside: avoid; margin: 6pt 0; }
    b, strong { font-weight: 700; } i, em { font-style: italic; }
    u { text-decoration: underline; } s { text-decoration: line-through; }
    ul, ol { list-style-position: inside; padding-left: 0; margin: 4pt 0 4pt 12pt; }
    table { border-collapse: collapse; margin: 6pt 0; width: 100%; break-inside: avoid; }
    td, th { border: 0.75pt solid #888; padding: 4pt 6pt; vertical-align: top; font-size: 10.5pt; }
    th { background: #eee; font-weight: 700; }
    a { color: #1a4f8a; text-decoration: underline; }
    /* Redactions: a filled rectangle with no text behind it. */
    .censor-box { display: inline-block; height: 1em; vertical-align: -0.15em;
      background: #000; border-radius: 1pt; }
    /* inline-flex, so a run of attachments packs across the row and wraps -
       block-level cards printed one per line and wasted the rest of the page. */
    .att-box { display: inline-flex; vertical-align: top; align-items: baseline; gap: 6pt;
      break-inside: avoid; max-width: 100%;
      border: 1pt solid #bbb; border-left: 3pt solid #888; border-radius: 2pt;
      padding: 5pt 8pt; margin: 3pt 6pt 3pt 0; font-size: 9.5pt; color: #333; background: #f7f7f7; }
    .att-box .att-kind { font-size: 7.5pt; letter-spacing: .08em; text-transform: uppercase;
      color: #fff; background: #777; padding: 1pt 4pt; border-radius: 2pt; }
    .att-box .att-name { font-weight: 600; overflow-wrap: anywhere; }
    .att-box .att-size { color: #777; }
    /* An explicitly aligned card still owns its line - that is what aligning it means. */
    .att-box.a-center { display: flex; margin-left: auto; margin-right: auto; max-width: 70%; }
    .att-box.a-right { display: flex; margin-left: auto; }
    .att-box.a-left { display: flex; margin-right: auto; }
  </style></head><body>
    <h1>${esc(title)}</h1>
    ${sections}
  </body></html>`;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:210mm;height:297mm;opacity:0;pointer-events:none;border:0;";
  document.body.appendChild(frame);
  frame.contentDocument.open();
  frame.contentDocument.write(doc);
  frame.contentDocument.close();
  status("");
  // Let layout and the decoded images settle, or the first print can come out blank.
  await new Promise(r => setTimeout(r, 250));
  try {
    const imgs = [...frame.contentDocument.images];
    await Promise.all(imgs.map(im => im.complete ? null : new Promise(r => { im.onload = im.onerror = r; })));
    frame.contentWindow.focus();
    frame.contentWindow.print();     // the browser's print dialog -> "Save as PDF"
    status("Choose \"Save as PDF\" in the print dialog");
  } catch (e) {
    status("Could not open the print dialog: " + e.message, true);
  }
  // The dialog is modal in every current browser, so by here it has been closed.
  setTimeout(() => frame.remove(), 1000);
}
