/*
 * pdf.js - the built-in PDF writer, and exporting a note: as a PDF, as a
 * folder holding the PDF and its files, or through the browser's print dialog.
 *
 * The writer builds the PDF bytes in the page instead of going through the
 * print dialog. That is what makes "export a folder with the PDF and its
 * files" possible at all: the print dialog hands the file to the browser and
 * never gives the bytes back. No library: just the PDF object model, the
 * base-14 fonts (no embedding needed) and CompressionStream for pictures.
 *
 * Two ways of laying a note out:
 *   - A paged note is laid out by the browser, on an A4 sheet with the sheet
 *     CSS: that is the page it was designed on. Laying it out again with the
 *     writer's own rules never quite agreed with it (table cells in another
 *     font and padding, header cells no longer centred, lines wrapping at
 *     other words), so each page is rendered off screen with the same CSS and
 *     every word, cell, picture and bar is copied to the PDF at the spot and
 *     size the browser gave it (drawSheetPage). Only the glyphs are the PDF's
 *     own, each word stretched (Tz) to the width the browser measured, so even
 *     a font the PDF lacks keeps the sheet's line breaks and positions.
 *   - A one-page note flows: its title, then its text wrapped against real
 *     font metrics (collectRuns, then buildNotePdf's line drawing).
 *
 * Decryption. Only the pictures the note shows are read from IndexedDB and
 * decrypted, with AES-256-GCM (decryptMedia, vault.js, about 3 ms per MB),
 * for as long as the PDF is being built; a folder export also decrypts each
 * attached file to write it next to the PDF. A picture under a censor mark is
 * never even decrypted. The PDF itself is a plain, unencrypted file, so
 * censored text is destroyed in it, never hidden: a bar sized by a coarse
 * bucket of the length takes its place. The PDF carries no /Info metadata,
 * and a JPEG carrying any metadata is drawn again instead of copied.
 *
 * Main functions: buildNotePdf, drawSheetPage, collectRuns, cellTokens,
 * pdfImage, jpegHasMetadata, pdfDoc, censorLenBucket, censorSplitMediaIds,
 * exportNoteInternal, pickExportDir, sidecarAttachments, sidecarNames,
 * safeName, exportNotePdf.
 * Auxiliary functions: imgName, mediaBox, pdfFontFor, textWidth, pdfEscape,
 * latin1Bytes, deflate, censorBarW, hexToRgb, jpegFrame, cssRgb, rgbOp,
 * inkLum, roundRectPath, ascentShare, textPieces, visibleMediaIds.
 *
 * Complexity: building a PDF is O(n) in the note's content, plus one decrypt
 * and one picture encode per picture, O(size); copying a sheet measures each
 * character's box once, O(c) layout reads per page.
 */
"use strict";

// ---------- State ----------

// A4 in points, and the same margins as the sheets.
const PT_PER_MM = 72 / 25.4;
const PAGE_W = 210 * PT_PER_MM;
const PAGE_H = 297 * PT_PER_MM;
const MARGIN_X = 16 * PT_PER_MM;
const MARGIN_Y = 18 * PT_PER_MM;

// An attachment card: 24pt tall (the sheet's 32px) with a 6pt gutter, two to
// a row. The font sizes match the chip the sheet draws (11px and 8px), so both
// work out nearly the same card width and fit the same number per row.
const CARD_H = 24;
const CARD_GAP = 6;
const CARD_TEXT_PT = 8.5;
const CARD_LABEL_PT = 6.5;

// Widths (per 1000 units) of ASCII 32 to 126 in the base-14 fonts used. Real
// AFM numbers: without them word wrapping would drift from what the page shows.
const W_HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_HELV_B = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const W_TIMES = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];
const W_TIMES_B = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
];

// PDF strings are Latin-1 here (base-14 fonts have no Unicode map). A few
// characters do exist in WinAnsiEncoding but sit outside Latin-1 in Unicode,
// most importantly the bullet, which lists need: these are their bytes.
const WINANSI = { "•": "\x95", "–": "\x96", "—": "\x97", "‘": "\x91",
  "’": "\x92", "“": "\x93", "”": "\x94", "…": "\x85", "€": "\x80" };

// Each font's baseline share, by CSS font string (see ascentShare).
const ascentShares = new Map();

// ---------- Building a note's PDF ----------

/**
 * Builds a note's PDF and returns its bytes (null if the vault locked
 * meanwhile). In order:
 *   1. Every picture the note shows outside a censor mark is read from
 *      IndexedDB, decrypted with AES-256-GCM (decryptMedia, about 3 ms per
 *      MB) and turned into an image object (pdfImage). A censored picture is
 *      never decrypted: an earlier scan of every reference decrypted it and
 *      shipped it as an object never drawn, but carvable out of the file.
 *   2. A paged note: each page is rendered off screen with the sheet CSS, its
 *      attachments given the boxes they have on screen, and copied onto a PDF
 *      page (drawSheetPage). No title or page names are added, which pushed
 *      designed covers onto a second sheet.
 *      A one-page note: its title, then its blocks (collectRuns) drawn line
 *      by line, wrapped against real font metrics, with tables, pictures,
 *      attachment cards and censor bars as the sheet lays them out.
 *   3. Pinned pictures go on last, above the text, as in the editor.
 *   4. A page whose content ran past its box is shrunk evenly to fit rather
 *      than losing what ran off the paper.
 *   5. The file is assembled: fonts, only the pictures some page draws (any
 *      other would be an orphan object of decrypted bytes), pages with their
 *      resources and links, and a catalog with no /Info dictionary at all.
 * With options.linkFiles (a folder export), attachment cards link to the
 * files written next to the PDF.
 *
 * Used by: this file (exportNoteInternal).
 * Uses: pdfDoc, sidecarNames, noteBodies, isPaged (content.js),
 * visibleMediaIds, idbGet, decryptMedia, idbKeys and isRenderableImage
 * (vault.js), pdfImage, pdfFontFor, textWidth, pdfEscape, imgName,
 * hexToRgb, censorBarW, mediaBox, formatSize (attachments.js),
 * bodyFragment, applyInlineSize and setInlineState (lines.js),
 * drawSheetPage, collectRuns, latin1Bytes.
 * Complexity: O(n) in the note, plus O(size) per picture.
 */
async function buildNotePdf(note, options) {
  options = options || {};
  const doc = pdfDoc();
  // The header is written first, so every offset recorded is already final.
  // (Adding it afterwards meant rewriting the xref table, and the round trip
  // that needed silently corrupted every byte from 0x80 to 0x9F: bullets, and
  // any compressed picture data that held them.)
  doc.push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  // { ops, uses, annots, minY, box } per page.
  const pages = [];
  // Base-14 font name -> object number.
  const fontObjs = new Map();
  // Media id -> { obj, w, h, img }.
  const imgObjs = new Map();
  let page = null;
  let y = 0;
  // Pinned pictures, drawn after the text of their page.
  const floats = [];
  const usableW = PAGE_W - 2 * MARGIN_X;
  // Attachments can only be reached when the export writes them next to the
  // PDF, so only a folder export gets clickable cards.
  const linkNames = options.linkFiles ? sidecarNames(note) : null;

  // box: the area the page's content belongs in (the text area here, the
  // whole paper for a copied sheet).
  const newPage = () => {
    page = { ops: [], uses: new Set(), annots: [], minY: PAGE_H - MARGIN_Y,
      box: { x0: MARGIN_X, top: PAGE_H - MARGIN_Y, bottom: MARGIN_Y } };
    pages.push(page);
    y = PAGE_H - MARGIN_Y;
  };
  // How deep this page's content really reached: a picture or table row
  // taller than a page, or a footer, can run past the margin, and the page is
  // shrunk at assembly rather than silently cut off the paper.
  const sink = () => {
    if (page && y < page.minY) {
      page.minY = y;
    }
  };
  const need = height => {
    if (y - height < MARGIN_Y) {
      newPage();
    }
  };
  const fontRef = font => {
    if (!fontObjs.has(font.name)) {
      fontObjs.set(font.name, doc.reserve());
    }
    return "F" + [...fontObjs.keys()].indexOf(font.name);
  };

  // 1. The pictures, decrypted once.
  const wanted = new Set();
  for (const entry of noteBodies(note)) {
    if (entry.bodyV === 2) {
      for (const mid of visibleMediaIds(entry.body)) {
        wanted.add(mid);
      }
    }
  }
  for (const mid of wanted) {
    const meta = (note.media || []).find(item => item.id === mid);
    if (!meta || !isRenderableImage(meta.mime)) {
      continue;
    }
    try {
      const record = await idbGet(mid);
      if (!record) {
        continue;
      }
      const plain = await decryptMedia(mid, record.bytes);
      // Locked during the export.
      if (!vault) {
        return null;
      }
      const image = await pdfImage(plain, meta.mime);
      if (!image) {
        continue;
      }
      const number = doc.reserve();
      imgObjs.set(mid, { obj: number, w: image.w, h: image.h, img: image });
    } catch {}
  }
  const metaFor = mid => (note.media || []).find(item => item.id === mid) || null;

  // A line box is an ascent above the baseline and a descent below it. The
  // baseline sits at the bottom of the box, because a picture is drawn upward
  // from it: anchoring it 0.85 of a text size below the top made a 180pt
  // picture reach 170pt above its own line, over the paragraph before it.
  const lineAscent = (maxSize, maxImgH) => Math.max(maxSize * 0.85, maxImgH);
  // 0.85 + 0.7 = the sheet's line height of 1.55.
  const lineDescent = maxSize => maxSize * 0.7;

  // Draws one line of items (words, pictures, cards, censor bars) and moves y down.
  const drawLine = (items, align, lineW, lineH, maxSize, ascent, wrapped) => {
    let x = MARGIN_X;
    if (align === "center") {
      x += (usableW - lineW) / 2;
    } else if (align === "right") {
      x += usableW - lineW;
    }
    // Justified: a line the paragraph wrapped from (never its last) is spread
    // to the full width by widening its spaces, as the sheet does. Trailing
    // spaces do not count.
    let gap = 0;
    if (align === "justify" && wrapped) {
      let end = items.length;
      while (end > 0 && items[end - 1].t === "text" && !/\S/.test(items[end - 1].s)) {
        end--;
      }
      const body = items.slice(0, end);
      const spaces = body.filter(item => item.t === "text" && !/\S/.test(item.s)).length;
      const width = body.reduce((sum, item) => sum + item.w, 0);
      if (spaces && width < usableW) {
        gap = (usableW - width) / spaces;
      }
    }
    const base = y - (ascent === undefined ? maxSize * 0.85 : ascent);

    for (const item of items) {
      if (gap && item.t === "text" && !/\S/.test(item.s)) {
        item.w += gap;
      }
      if (item.t === "img") {
        // It sits on the line's baseline, like an inline-block on the sheet.
        // The picture is claimed here, not where it was queued: a line is
        // queued on one page and drawn after need() may have started the next,
        // and a Do on a name missing from the page's resources draws nothing.
        page.uses.add("img:" + item.mid);
        page.ops.push(`q ${item.w.toFixed(2)} 0 0 ${item.h.toFixed(2)} ${x.toFixed(2)} ${base.toFixed(2)} cm /Im${
          imgName(item.mid)} Do Q`);
        x += item.w;
        continue;
      }
      if (item.t === "card") {
        const top = base + item.h;
        // The gutter is inside the slot.
        const cardW = item.w - CARD_GAP;
        page.ops.push(`0.96 0.96 0.96 rg ${x.toFixed(2)} ${base.toFixed(2)} ${cardW.toFixed(2)} ${item.h} re f`);
        page.ops.push(`0.55 0.55 0.55 RG 2 w ${x.toFixed(2)} ${base.toFixed(2)} m ${x.toFixed(2)} ${top.toFixed(2)} l S`);
        const boldFont = pdfFontFor("Helvetica", true, false);
        page.uses.add(boldFont.name);
        page.ops.push(`BT 0.25 0.25 0.25 rg /${fontRef(boldFont)} ${CARD_LABEL_PT} Tf ${(x + 6).toFixed(2)} ${
          (top - 9).toFixed(2)} Td (${pdfEscape(item.label)}) Tj ET`);
        const plainFont = pdfFontFor("Helvetica", false, false);
        page.uses.add(plainFont.name);
        // A long filename is cut to the card instead of running into the next one.
        let shown = item.text;
        while (shown.length > 4 && textWidth(shown, plainFont, CARD_TEXT_PT) > cardW - 12) {
          shown = shown.slice(0, -2);
        }
        if (shown !== item.text) {
          shown = shown.slice(0, -1) + "…";
        }
        page.ops.push(`BT ${item.uri ? "0.13 0.33 0.72" : "0.1 0.1 0.1"} rg /${fontRef(plainFont)} ${CARD_TEXT_PT} Tf ` +
          `${(x + 6).toFixed(2)} ${(top - 19).toFixed(2)} Td (${pdfEscape(shown)}) Tj ET`);
        if (item.uri) {
          const shownW = textWidth(shown, plainFont, CARD_TEXT_PT);
          page.ops.push(`0.13 0.33 0.72 RG 0.6 w ${(x + 6).toFixed(2)} ${(top - 20.5).toFixed(2)} m ` +
            `${(x + 6 + shownW).toFixed(2)} ${(top - 20.5).toFixed(2)} l S`);
          // The whole card is the link, not just its text.
          page.annots.push({ rect: [x, base, x + cardW, top], uri: item.uri });
        }
        x += item.w;
        continue;
      }
      if (item.t === "censor") {
        page.ops.push(`0 0 0 rg ${x.toFixed(2)} ${(base - item.size * 0.22).toFixed(2)} ${item.w.toFixed(2)} ${
          (item.size * 1.05).toFixed(2)} re f`);
        x += item.w;
        continue;
      }

      let [r, g, b] = hexToRgb(item.color || "#000000");
      if (item.bg) {
        // The highlight goes first, so the text sits on it (the same box a
        // censor bar uses).
        const [hr, hg, hb] = hexToRgb(item.bg);
        page.ops.push(`${hr.toFixed(3)} ${hg.toFixed(3)} ${hb.toFixed(3)} rg ${x.toFixed(2)} ${
          (base - item.size * 0.22).toFixed(2)} ` +
          `${item.w.toFixed(2)} ${(item.size * 1.05).toFixed(2)} re f`);
        // Text that cannot be read on its highlight (dark ink on a black
        // highlight is the classic one) would look censored in the PDF while
        // every character stayed in the file, ready to be copied out. It is
        // printed readable instead: only Censor removes text.
        const lum = (x1, x2, x3) => 0.2126 * x1 + 0.7152 * x2 + 0.0722 * x3;
        const textLum = lum(r, g, b);
        const highlightLum = lum(hr, hg, hb);
        if (Math.abs(textLum - highlightLum) < 0.35) {
          [r, g, b] = highlightLum < 0.5 ? [1, 1, 1] : [0, 0, 0];
        }
      }
      const ref = fontRef(item.font);
      page.uses.add(item.font.name);
      page.ops.push(`BT ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /${ref} ${item.size} Tf ` +
        `${x.toFixed(2)} ${base.toFixed(2)} Td (${pdfEscape(item.s)}) Tj ET`);
      if (item.under) {
        page.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${(item.size * 0.06).toFixed(2)} w ` +
          `${x.toFixed(2)} ${(base - item.size * 0.13).toFixed(2)} m ${(x + item.w).toFixed(2)} ${
            (base - item.size * 0.13).toFixed(2)} l S`);
      }
      if (item.strike) {
        page.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${(item.size * 0.06).toFixed(2)} w ` +
          `${x.toFixed(2)} ${(base + item.size * 0.28).toFixed(2)} m ${(x + item.w).toFixed(2)} ${
            (base + item.size * 0.28).toFixed(2)} l S`);
      }
      x += item.w;
    }
    y -= lineH;
    sink();
  };

  // Draws one block (a line of the note, a table, a frame line) of a one-page note.
  const renderBlock = block => {
    const line = [];
    let lineW = 0;
    let maxSize = 12;
    let maxImgH = 0;
    // Whether this block put anything on the page yet. A block holding only a
    // table or a pinned item must not also cost an empty line: an empty line
    // before and after every table printed two blank lines the sheet does not have.
    let drew = false;
    const isPinnedItem = item => (item.t === "media" || item.t === "table") && item.fx !== null && item.fx !== undefined;

    // wrapped: the line ends because the next thing did not fit (so a
    // justified paragraph spreads it), not because the paragraph ended.
    const flush = wrapped => {
      if (!line.length) {
        return;
      }
      drew = true;
      // A line is as tall as its tallest thing: pictures share the line with
      // text, as on the sheet. Text only, this is the sheet's 1.55, so the same
      // number of lines lands on each page.
      const ascent = lineAscent(maxSize, maxImgH);
      // A row of pictures with no text is exactly as tall as the pictures, as
      // the browser makes it: adding a text descent made every picture row 8pt
      // taller than the sheet's, which pushed the footer into the last lines.
      const textOnLine = line.some(item => item.t !== "img");
      const lineH = ascent + (maxImgH && !textOnLine ? 0 : lineDescent(maxSize));
      // A frame line belongs to the page it is on: it never opens a page of its
      // own. If the flow has run past the bottom margin it is pulled back to the
      // paper's edge only (pulling it up to the margin printed the footer
      // straight through the last lines).
      if (block.frame) {
        if (y - lineH < 12) {
          y = 12 + lineH;
        }
      } else {
        need(lineH);
      }
      drawLine(line.slice(), block.align, lineW, lineH, maxSize, ascent, wrapped === true);
      line.length = 0;
      lineW = 0;
      maxSize = 12;
      maxImgH = 0;
    };

    for (const item of block.items) {
      if (item.t === "table") {
        flush();
        // Columns as the handles set them (or equal), cells wrapped to their
        // column, each row as tall as its tallest cell; a row that does not fit
        // starts a page. A pinned table is drawn at its own spot and never moves
        // the text: the flow position is kept and put back afterwards.
        const pinned = item.fx !== null && item.fx !== undefined;
        const savedY = y;
        let originX = MARGIN_X;
        let tableW = usableW;
        if (pinned) {
          originX = PAGE_W * item.fx / 100;
          y = PAGE_H - PAGE_H * item.fy / 100;
          tableW = Math.min(usableW, PAGE_W - originX);
        }
        const cols = Math.max(1, ...item.rows.map(row => row.length));
        const setPx = (item.colPx || []).slice(0, cols);
        while (setPx.length < cols) {
          setPx.push(0);
        }
        const totalPx = setPx.reduce((sum, value) => sum + value, 0);
        // As on screen: a narrow table prints narrow, and is only shrunk when its
        // columns would overflow the text width (always spreading it to the full
        // width made a 451px table print edge to edge).
        const filled = setPx.map(value => value || (totalPx > 0 ? totalPx / cols : 0));
        // CSS px to pt.
        const sumPt = filled.reduce((sum, value) => sum + value, 0) * 0.75;
        const target = totalPx > 0 ? Math.min(sumPt, tableW) : tableW;
        const colWs = totalPx > 0
          ? filled.map(value => value * target / filled.reduce((sum, each) => sum + each, 0))
          : setPx.map(() => tableW / cols);
        const colX = [];
        colWs.reduce((acc, width, i) => {
          colX[i] = acc;
          return acc + width;
        }, 0);
        const pad = 4;
        const fontSize = 10.5;

        item.rows.forEach((row, rowIndex) => {
          const fonts = row.map(cell => pdfFontFor("Helvetica", cell.header, false));
          // Each cell is wrapped first, into lines of pieces (words or censor
          // bars), so the row's height is known before drawing, and a censored
          // cell draws a bar: its characters never reach the file.
          const wrapped = row.map((cell, colIndex) => {
            const maxW = (colWs[colIndex] || tableW / cols) - 2 * pad;
            const lines = [[]];
            let width = 0;
            const put = (piece, pieceW) => {
              if (width + pieceW > maxW && width > 0) {
                lines.push([]);
                width = 0;
              }
              lines[lines.length - 1].push(piece);
              width += pieceW;
            };
            for (const token of (cell.tokens || [])) {
              if (token.censor) {
                const barW = censorBarW(token.len, fontSize);
                put({ censor: true, w: barW }, barW);
                continue;
              }
              for (const word of String(token.s).split(/(\s+)/)) {
                if (!word) {
                  continue;
                }
                put({ s: word }, textWidth(word, fonts[colIndex], fontSize));
              }
            }
            return lines;
          });
          // As tall as the content needs, or as the row handle made it (px to pt).
          const wantedH = (item.rowPx || [])[rowIndex] ? (item.rowPx[rowIndex] * 0.75) : 0;
          const rowH = Math.max(Math.max(...wrapped.map(lines => lines.length)) * (fontSize * 1.3) + 2 * pad, wantedH);
          // A pinned table keeps its page: it never moves to another.
          if (!pinned) {
            need(rowH);
          }
          const top = y;
          row.forEach((cell, colIndex) => {
            const cellW = colWs[colIndex] || tableW / cols;
            const x = originX + (colX[colIndex] || 0);
            if (cell.header) {
              page.ops.push(`0.93 0.93 0.93 rg ${x.toFixed(2)} ${(top - rowH).toFixed(2)} ${cellW.toFixed(2)} ${rowH.toFixed(2)} re f`);
            }
            page.ops.push(`0.53 0.53 0.53 RG 0.75 w ${x.toFixed(2)} ${(top - rowH).toFixed(2)} ${cellW.toFixed(2)} ${rowH.toFixed(2)} re S`);
            const ref = fontRef(fonts[colIndex]);
            page.uses.add(fonts[colIndex].name);
            wrapped[colIndex].forEach((cellLine, lineIndex) => {
              const lineW = cellLine.reduce((sum, piece) =>
                sum + (piece.censor ? piece.w : textWidth(piece.s, fonts[colIndex], fontSize)), 0);
              let textX = x + pad;
              if (cell.align === "center") {
                textX = x + (cellW - lineW) / 2;
              } else if (cell.align === "right") {
                textX = x + cellW - pad - lineW;
              }
              const textY = top - pad - fontSize * 0.85 - lineIndex * (fontSize * 1.3);
              for (const piece of cellLine) {
                if (piece.censor) {
                  page.ops.push(`0 0 0 rg ${textX.toFixed(2)} ${(textY - fontSize * 0.22).toFixed(2)} ${
                    piece.w.toFixed(2)} ${(fontSize * 1.05).toFixed(2)} re f`);
                  textX += piece.w;
                  continue;
                }
                page.ops.push(`BT 0 0 0 rg /${ref} ${fontSize} Tf ${textX.toFixed(2)} ${textY.toFixed(2)} Td (${
                  pdfEscape(piece.s)}) Tj ET`);
                textX += textWidth(piece.s, fonts[colIndex], fontSize);
              }
            });
          });
          y = top - rowH;
        });
        if (pinned) {
          // The flow carries on as if the table were not there.
          y = savedY;
        } else {
          y -= 8;
          sink();
          drew = true;
        }
        continue;
      }

      if (item.t === "media") {
        const pinnedRecord = imgObjs.get(item.mid);
        // Pinned: drawn at its own spot and taken out of the flow, so the text
        // around it is unaffected, exactly as on screen.
        if (item.fx !== null && item.fx !== undefined && pinnedRecord) {
          const size = mediaBox(pinnedRecord, item);
          const w = Math.min(size.w, PAGE_W);
          const h = size.h * (w / size.w);
          const x = PAGE_W * item.fx / 100;
          const yTop = PAGE_H - PAGE_H * item.fy / 100;
          floats.push({ mid: item.mid, x, y: yTop - h, w, h, page: pages.length - 1 });
          continue;
        }
        const record = pinnedRecord;
        if (record) {
          const size = mediaBox(record, item);
          const w = Math.min(size.w, usableW);
          const h = size.h * (w / size.w);
          if (item.align) {
            // A picture aligned by hand has a line of its own, as on screen.
            flush();
            need(h + 8);
            let x = MARGIN_X;
            if (item.align === "center") {
              x += (usableW - w) / 2;
            } else if (item.align === "right") {
              x += usableW - w;
            }
            page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(y - h).toFixed(2)} cm /Im${imgName(item.mid)} Do Q`);
            page.uses.add("img:" + item.mid);
            y -= h + 8;
            sink();
            drew = true;
            continue;
          }
          // Otherwise it flows in the line like any inline thing, so a row of
          // pictures prints as a row, like the sheet and on as many pages. The
          // picture is claimed by drawLine, on the page the line really lands on.
          if (lineW + w > usableW && lineW > 0) {
            flush(true);
          }
          line.push({ t: "img", mid: item.mid, w, h });
          lineW += w;
          if (h > maxImgH) {
            maxImgH = h;
          }
          continue;
        }
        // A video, a document or a missing picture: a reference card. It flows
        // in the line like a picture, two across the text column (a full-width
        // card each threw away half of every page). The line only breaks if one
        // is pending: an unconditional break spent an empty line on every card,
        // and a run of attachments then paginated differently from the sheet.
        {
          const label = { video: "VIDEO", pdf: "PDF", text: "TEXT", file: "FILE" }[item.kind] || "ATTACHMENT";
          const name = (item.meta && item.meta.name) || "not on this device";
          const size = item.meta && item.meta.size ? "  (" + formatSize(item.meta.size) + ")" : "";
          const target = linkNames && linkNames.get(item.mid);
          // The slot is as wide as the chip the sheet shows (one label per kind,
          // never the filename: sizing by filename wrapped into far more card
          // rows than the sheet). The filename still prints, cut to the slot, and
          // stays the link's target in full.
          const plainFont = pdfFontFor("Helvetica", false, false);
          const chipLabel = { video: "Play video", pdf: "Open PDF", text: "View text", file: "Download file" }[item.kind] ||
            "Download file";
          // A 14px glyph, a 6px gap and 10px padding each side (in pt), and the label at about 9pt.
          const w = Math.min(usableW, 30 + textWidth(chipLabel, plainFont, 9) + CARD_GAP);
          if (lineW + w > usableW + 0.5 && lineW > 0) {
            flush(true);
          }
          line.push({ t: "card", label, text: name + size, w, h: CARD_H,
            uri: target ? "files/" + encodeURIComponent(target) : null });
          lineW += w;
          if (CARD_H > maxImgH) {
            maxImgH = CARD_H;
          }
        }
        continue;
      }

      if (item.t === "censor") {
        // The width comes from the shared bucket rule, and it drives the wrap
        // test and the line width too, or aligned lines would drift off the margin.
        const size = item.size || 12;
        const w = censorBarW(item.len, size);
        if (lineW + w > usableW && lineW > 0) {
          flush(true);
        }
        line.push({ t: "censor", w, size });
        lineW += w;
        if (size > maxSize) {
          maxSize = size;
        }
        continue;
      }

      const font = pdfFontFor(item.family, item.bold, item.italic);
      const size = item.size || 12;
      // Word wrap against the real font metrics.
      for (const word of item.s.split(/(\s+)/)) {
        if (!word) {
          continue;
        }
        const w = textWidth(word, font, size);
        if (lineW + w > usableW && lineW > 0 && /\S/.test(word)) {
          flush(true);
        }
        line.push({ t: "text", s: word, font, size, w,
          color: item.color, bg: item.bg, under: item.under, strike: item.strike });
        lineW += w;
        if (size > maxSize) {
          maxSize = size;
        }
      }
    }
    flush();
    // An empty line costs a real line, the sheet's 1.55 (charging less fitted
    // more on a page than the screen did). A block of nothing but pinned items
    // is out of the flow and costs nothing.
    if (!drew && !(block.items.length && block.items.every(isPinnedItem))) {
      y -= 12 * 1.55;
      sink();
    }
  };

  // 2. The pages.
  const bodies = noteBodies(note);
  if (isPaged(note)) {
    const have = new Set(await idbKeys().catch(() => []));
    const host = document.createElement("div");
    host.className = "sheet";
    host.style.cssText = "position:fixed;left:-10000px;top:0;transform:none;visibility:hidden;pointer-events:none";
    const sheet = host.appendChild(document.createElement("div"));
    sheet.className = "sheet-body";
    // Editable like the live sheets: contenteditable changes how spaces wrap.
    sheet.contentEditable = "true";
    sheet.spellcheck = false;
    document.body.appendChild(host);
    try {
      for (const entry of bodies) {
        sheet.replaceChildren(bodyFragment(entry.body, entry.bodyV));
        // Every attachment gets the box hydrateInlineMedia gives it on screen.
        // A decoded picture's box is left empty: the picture is drawn into it.
        for (const wrapper of sheet.querySelectorAll("span.inline-media")) {
          const mid = wrapper.getAttribute("data-mid");
          const kind = wrapper.getAttribute("data-kind");
          const meta = metaFor(mid);
          const record = imgObjs.get(mid);
          if (meta || record) {
            applyInlineSize(wrapper, (meta && meta.w) || (record && record.w),
              (meta && meta.h) || (record && record.h));
          }
          if (kind === "image" && record) {
            wrapper.replaceChildren();
          } else {
            setInlineState(wrapper, !meta || !have.has(mid) ? "missing" : kind === "image" ? "corrupt" : kind);
          }
        }
        newPage();
        drawSheetPage(sheet, page, { fontRef, imgObjs, metaFor, linkNames });
      }
    } finally {
      host.remove();
    }
  } else {
    newPage();
    // A one-page note gets its title, its only identifier.
    const font = pdfFontFor("", true, false);
    const ref = fontRef(font);
    page.uses.add(font.name);
    const title = (note.title || "Untitled").trim() || "Untitled";
    page.ops.push(`BT 0 0 0 rg /${ref} 20 Tf ${MARGIN_X} ${(y - 20).toFixed(2)} Td (${pdfEscape(title)}) Tj ET`);
    y -= 34;
    const holder = document.createElement("div");
    holder.appendChild(bodyFragment(bodies[0].body, bodies[0].bodyV));
    for (const block of collectRuns(holder, metaFor)) {
      renderBlock(block);
    }
  }

  // 3. Pinned pictures, above the text.
  for (const pinned of floats) {
    const onPage = pages[pinned.page] || pages[pages.length - 1];
    if (!onPage) {
      continue;
    }
    onPage.ops.push(`q ${pinned.w.toFixed(2)} 0 0 ${pinned.h.toFixed(2)} ${pinned.x.toFixed(2)} ${
      pinned.y.toFixed(2)} cm /Im${imgName(pinned.mid)} Do Q`);
    onPage.uses.add("img:" + pinned.mid);
  }

  // 4. A page whose content ran past the bottom of its box is shrunk evenly
  // to fit, from the box's top left: slightly smaller type on that one page
  // beats rows below the margin, or off the paper entirely.
  for (const each of pages) {
    const area = each.box;
    if (!(each.minY < area.bottom - 0.5)) {
      continue;
    }
    const shrink = (area.top - area.bottom) / (area.top - each.minY);
    const dx = area.x0 * (1 - shrink);
    const dy = area.top * (1 - shrink);
    each.ops.unshift(`q ${shrink.toFixed(4)} 0 0 ${shrink.toFixed(4)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm`);
    each.ops.push("Q");
    for (const annot of each.annots) {
      annot.rect = annot.rect.map((value, i) => i % 2 === 0 ? value * shrink + dx : value * shrink + dy);
    }
  }

  // 5. The file.
  const fontNames = [...fontObjs.keys()];
  fontNames.forEach((name, i) => doc.write(fontObjs.get(name),
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
  for (const [mid, record] of imgObjs) {
    if (!pages.some(each => each.uses.has("img:" + mid))) {
      continue;
    }
    const image = record.img;
    doc.stream(record.obj, `/Type /XObject /Subtype /Image /Width ${record.w} /Height ${record.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8${image.filter ? " /Filter " + image.filter : ""}`, image.data);
  }
  const pageObjs = pages.map(() => doc.reserve());
  const pagesObj = doc.reserve();
  pages.forEach((each, i) => {
    const contentN = doc.obj();
    const body = each.ops.join("\n");
    doc.stream(contentN, "", latin1Bytes(body));
    const fontRes = fontNames.map((name, k) => `/F${k} ${fontObjs.get(name)} 0 R`).join(" ");
    const imgRes = [...imgObjs.entries()].filter(([mid]) => each.uses.has("img:" + mid))
      .map(([mid, record]) => `/Im${imgName(mid)} ${record.obj} 0 R`).join(" ");
    // Links use a relative address, so the viewer resolves it against the
    // PDF's own place: the files/ folder next to it.
    const annotRefs = (each.annots || []).map(annot => {
      const number = doc.obj();
      doc.write(number, `<< /Type /Annot /Subtype /Link /Rect [${annot.rect.map(value => value.toFixed(2)).join(" ")}] ` +
        `/Border [0 0 0] /F 4 /A << /S /URI /URI (${pdfEscape(annot.uri)}) >> >>`);
      return number + " 0 R";
    });
    doc.write(pageObjs[i], `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] ` +
      `/Resources << /Font << ${fontRes} >>${imgRes ? " /XObject << " + imgRes + " >>" : ""} >> /Contents ${contentN} 0 R` +
      `${annotRefs.length ? " /Annots [" + annotRefs.join(" ") + "]" : ""} >>`);
  });
  doc.write(pagesObj, `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjs.map(number => number + " 0 R").join(" ")}] >>`);
  const catalog = doc.obj();
  // No /Info dictionary at all: no title, author, producer or creation date.
  doc.write(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  return doc.finish(catalog);
}

/**
 * Copies one laid-out sheet body onto a PDF page, everything at the spot and
 * size the browser gave it: backgrounds and borders, highlights, each word
 * (in a base-14 font, stretched to the measured width, its underline or
 * strike-through), list markers (not in the DOM, so drawn where the browser
 * puts them), tables (cell fills first, then every border, since a collapsed
 * border is shared), pictures (filling their box as object-fit: cover does),
 * the reference tile of any other attachment (its kind and name, linked to
 * the file in a folder export), and censor bars. Only a censor mark's own
 * boxes are read, one per line it wraps onto: its characters never reach
 * the PDF, and a picture under it is a black box. Pinned items are drawn
 * last, above the text, as on the sheet. env carries the writer's helpers:
 * fontRef, imgObjs, metaFor and linkNames.
 *
 * Used by: this file (buildNotePdf).
 * Uses: roundRectPath, rgbOp, cssRgb, inkLum, pdfFontFor, textWidth,
 * pdfEscape, ascentShare, textPieces, imgName, formatSize (attachments.js).
 * Complexity: O(c) layout reads in the page's characters.
 */
function drawSheetPage(root, page, env) {
  const box = root.getBoundingClientRect();
  // CSS px to pt (0.75 at 210 mm), and screen coordinates to page coordinates.
  const scale = PAGE_W / box.width;
  const X = cx => (cx - box.left) * scale;
  const Y = cy => PAGE_H - (cy - box.top) * scale;
  const num = value => value.toFixed(2);
  const pxOf = value => parseFloat(value) || 0;
  const ops = page.ops;
  const black = [0, 0, 0];
  const makeRect = (left, top, width, height) =>
    ({ left, top, width, height, right: left + width, bottom: top + height });
  // A client rect as a PDF path, inset by inset px, its corners rounded by radius px.
  const path = (area, inset, radius) => roundRectPath(X(area.left + inset), Y(area.bottom - inset),
    (area.width - 2 * inset) * scale, (area.height - 2 * inset) * scale, Math.max(0, radius - inset) * scale);
  const fill = (area, colour, radius) => {
    if (area.width > 0 && area.height > 0) {
      ops.push(`${rgbOp(colour, "rg")} ${path(area, 0, radius || 0)} f`);
    }
  };
  // Every text object sets its own Tz: it is graphics state, so it would carry over.
  const putText = (font, size, ink, x, y, s, tz) => {
    page.uses.add(font.name);
    ops.push(`BT ${rgbOp(ink, "rg")} /${env.fontRef(font)} ${num(size)} Tf ${(tz || 100).toFixed(1)} Tz ` +
      `${num(x)} ${num(y)} Td (${pdfEscape(s)}) Tj ET`);
  };
  const fontOf = style => pdfFontFor(style.fontFamily, parseInt(style.fontWeight, 10) >= 600, style.fontStyle !== "normal");

  // A box's background and border as the sheet paints them: an even border
  // is stroked round the corners, an uneven one edge by edge.
  const paintBox = (el, area) => {
    const style = getComputedStyle(el);
    const radius = pxOf(style.borderTopLeftRadius);
    const background = cssRgb(style.backgroundColor);
    if (background) {
      fill(area, background, radius);
    }
    const [top, right, bottom, left] = ["Top", "Right", "Bottom", "Left"].map(side => ({
      w: style[`border${side}Style`] === "none" ? 0 : pxOf(style[`border${side}Width`]),
      c: cssRgb(style[`border${side}Color`]),
    }));
    if ([right, bottom, left].every(edge => edge.w === top.w && String(edge.c) === String(top.c)) &&
      top.w > 0 && top.c) {
      ops.push(`${rgbOp(top.c, "RG")} ${num(top.w * scale)} w ${path(area, top.w / 2, radius)} S`);
      return;
    }
    if (top.w && top.c) {
      fill(makeRect(area.left, area.top, area.width, top.w), top.c);
    }
    if (bottom.w && bottom.c) {
      fill(makeRect(area.left, area.bottom - bottom.w, area.width, bottom.w), bottom.c);
    }
    if (left.w && left.c) {
      fill(makeRect(area.left, area.top, left.w, area.height), left.c);
    }
    if (right.w && right.c) {
      fill(makeRect(area.right - right.w, area.top, right.w, area.height), right.c);
    }
  };

  // A text node's words. Ink that cannot be read on its own highlight prints
  // readable, as in the flow writer: only Censor removes text, a dark
  // highlight never does. A decoration runs under the whole line of text,
  // the spaces in it included.
  const drawText = textNode => {
    if (!/\S/.test(textNode.data)) {
      return;
    }
    const el = textNode.parentElement;
    const style = getComputedStyle(el);
    const fontPx = pxOf(style.fontSize);
    let ink = cssRgb(style.color);
    if (!ink || !(fontPx > 0)) {
      return;
    }
    let paper = null;
    for (let ancestor = el; ancestor && ancestor !== root && !paper; ancestor = ancestor.parentElement) {
      paper = cssRgb(getComputedStyle(ancestor).backgroundColor);
    }
    if (paper && Math.abs(inkLum(ink) - inkLum(paper)) < 0.35) {
      ink = inkLum(paper) < 0.5 ? [1, 1, 1] : black;
    }
    let under = false;
    let strike = false;
    for (let ancestor = el; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      const decoration = getComputedStyle(ancestor).textDecorationLine;
      if (decoration.includes("underline")) {
        under = true;
      }
      if (decoration.includes("line-through")) {
        strike = true;
      }
    }
    const font = fontOf(style);
    const size = fontPx * scale;
    const share = ascentShare(style);
    const lines = new Map();
    for (const piece of textPieces(textNode)) {
      const base = piece.top + piece.h * share;
      const natural = textWidth(piece.s, font, size);
      putText(font, size, ink, X(piece.left), Y(base), piece.s,
        natural > 0 ? 100 * (piece.right - piece.left) * scale / natural : 100);
      const key = Math.round(base * 4);
      const line = lines.get(key);
      if (line) {
        line.right = piece.right;
      } else {
        lines.set(key, { left: piece.left, right: piece.right, base });
      }
    }
    const lineWidth = num(Math.max(1, fontPx * 0.05) * scale);
    for (const line of lines.values()) {
      for (const [on, dy] of [[under, 0.12], [strike, -0.28]]) {
        if (on) {
          ops.push(`${rgbOp(ink, "RG")} ${lineWidth} w ${num(X(line.left))} ${num(Y(line.base + fontPx * dy))} m ` +
            `${num(X(line.right))} ${num(Y(line.base + fontPx * dy))} l S`);
        }
      }
    }
  };

  // A censor mark: one black bar per box it was drawn in, and a black box per picture under it.
  const drawBars = el => {
    const radius = pxOf(getComputedStyle(el).borderTopLeftRadius);
    for (const area of el.getClientRects()) {
      fill(area, black, radius);
    }
    for (const media of el.querySelectorAll(".inline-media")) {
      fill(media.getBoundingClientRect(), black, pxOf(getComputedStyle(media).borderTopLeftRadius));
    }
  };

  // An attachment. A picture fills the box inside its border as the sheet's
  // object-fit: cover does: scaled to cover it, centred, the rest cut off by
  // the corners. Anything else is the reference tile the sheet shows, with the
  // file's kind and name instead of "Play video": a PDF cannot play or open it.
  const drawMedia = wrapper => {
    const area = wrapper.getBoundingClientRect();
    if (!(area.width > 0 && area.height > 0)) {
      return;
    }
    const style = getComputedStyle(wrapper);
    const border = pxOf(style.borderTopWidth);
    const radius = pxOf(style.borderTopLeftRadius);
    const mid = wrapper.getAttribute("data-mid");
    const kind = wrapper.getAttribute("data-kind");
    const record = env.imgObjs.get(mid);
    if (kind === "image" && record) {
      const innerW = (area.width - 2 * border) * scale;
      const innerH = (area.height - 2 * border) * scale;
      const cover = Math.max(innerW / record.w, innerH / record.h);
      const drawW = record.w * cover;
      const drawH = record.h * cover;
      page.uses.add("img:" + mid);
      ops.push(`q ${path(area, border, radius)} W n ${num(drawW)} 0 0 ${num(drawH)} ${
        num(X(area.left + border) + (innerW - drawW) / 2)} ` +
        `${num(Y(area.bottom - border) + (innerH - drawH) / 2)} cm /Im${imgName(mid)} Do Q`);
      const borderColor = cssRgb(style.borderTopColor);
      if (border > 0 && borderColor) {
        ops.push(`${rgbOp(borderColor, "RG")} ${num(border * scale)} w ${path(area, border / 2, radius)} S`);
      }
      return;
    }
    paintBox(wrapper, area);
    const chip = wrapper.querySelector(".inline-ph");
    const chipArea = chip ? chip.getBoundingClientRect() : area;
    if (chip) {
      paintBox(chip, chipArea);
    }
    const meta = env.metaFor(mid);
    const label = { video: "VIDEO", pdf: "PDF", text: "TEXT", file: "FILE" }[kind] || "ATTACHMENT";
    const name = ((meta && meta.name) || "not on this device") + (meta && meta.size ? "  (" + formatSize(meta.size) + ")" : "");
    const target = env.linkNames && env.linkNames.get(mid);
    const boldFont = pdfFontFor("Helvetica", true, false);
    const plainFont = pdfFontFor("Helvetica", false, false);
    const x = X(chipArea.left) + 6;
    const top = Y(chipArea.top);
    putText(boldFont, CARD_LABEL_PT, [0.25, 0.25, 0.25], x, top - 9, label);
    // A long filename is cut to the tile instead of running out of it.
    let shown = name;
    while (shown.length > 4 && textWidth(shown, plainFont, CARD_TEXT_PT) > chipArea.width * scale - 12) {
      shown = shown.slice(0, -2);
    }
    if (shown !== name) {
      shown = shown.slice(0, -1) + "…";
    }
    const ink = target ? [0.13, 0.33, 0.72] : [0.1, 0.1, 0.1];
    putText(plainFont, CARD_TEXT_PT, ink, x, top - 19, shown);
    if (target) {
      ops.push(`${rgbOp(ink, "RG")} 0.6 w ${num(x)} ${num(top - 20.5)} m ${
        num(x + textWidth(shown, plainFont, CARD_TEXT_PT))} ${num(top - 20.5)} l S`);
      // The whole tile is the link, not just its text.
      page.annots.push({ rect: [X(area.left), Y(area.bottom), X(area.right), Y(area.top)],
        uri: "files/" + encodeURIComponent(target) });
    }
  };

  // A table: cell fills first, then every border (a collapsed border is
  // shared, and the next cell's fill must not paint over half of it).
  const drawTable = table => {
    const background = cssRgb(getComputedStyle(table).backgroundColor);
    if (background) {
      fill(table.getBoundingClientRect(), background, 0);
    }
    const cells = [...table.querySelectorAll("td, th")].filter(cell => cell.closest("table") === table);
    for (const cell of cells) {
      const cellBackground = cssRgb(getComputedStyle(cell).backgroundColor);
      if (cellBackground) {
        fill(cell.getBoundingClientRect(), cellBackground, 0);
      }
    }
    for (const cell of cells) {
      const style = getComputedStyle(cell);
      const border = pxOf(style.borderTopWidth);
      const borderColor = cssRgb(style.borderTopColor);
      if (border > 0 && borderColor) {
        ops.push(`${rgbOp(borderColor, "RG")} ${num(border * scale)} w ${path(cell.getBoundingClientRect(), 0, 0)} S`);
      }
    }
  };

  // A list item's marker, "•" or "N.", in the item's own font, right before
  // its first word (where the browser puts the ::marker, which is not in the DOM).
  const drawMarker = item => {
    const style = getComputedStyle(item);
    if (style.display !== "list-item" || style.listStyleType === "none") {
      return;
    }
    let label = "•";
    if (/decimal/.test(style.listStyleType)) {
      const list = item.parentElement;
      label = ((parseInt(list.getAttribute("start"), 10) || 1) +
        [...list.children].filter(child => child.tagName === "LI").indexOf(item)) + ".";
    }
    const font = fontOf(style);
    const size = pxOf(style.fontSize) * scale;
    const area = item.getBoundingClientRect();
    let first = null;
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && !first; node = walker.nextNode()) {
      if (node.parentElement.closest('[data-censor="1"], .inline-media')) {
        continue;
      }
      const piece = textPieces(node)[0];
      if (piece) {
        first = { left: piece.left, base: piece.top + piece.h * ascentShare(getComputedStyle(node.parentElement)) };
      }
    }
    const base = first ? first.base : area.top + pxOf(style.fontSize) * 1.1;
    const x = first && !/^(left|start)$/.test(style.textAlign)
      ? X(first.left) - textWidth(label + " ", font, size) : X(area.left + pxOf(style.paddingLeft));
    putText(font, size, cssRgb(style.color) || black, x, Y(base), label);
  };

  // Everything under the page, in order; pinned items (above the text, at
  // z-index 2) wait until the end.
  const floats = [];
  const draw = (node, inFloat) => {
    if (node.nodeType === 3) {
      drawText(node);
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    if (!inFloat && node.classList.contains("floating")) {
      floats.push(node);
      return;
    }
    if (node.getAttribute("data-censor") === "1") {
      drawBars(node);
      return;
    }
    if (node.classList.contains("inline-media")) {
      drawMedia(node);
      return;
    }
    if (node.tagName === "TABLE") {
      drawTable(node);
    } else if (!/^(TBODY|THEAD|TFOOT|TR|TD|TH)$/.test(node.tagName)) {
      // A highlight, or a line with a background: one box per line it covers.
      const background = cssRgb(getComputedStyle(node).backgroundColor);
      if (background) {
        for (const area of node.getClientRects()) {
          fill(area, background, 0);
        }
      }
      if (node.tagName === "LI") {
        drawMarker(node);
      }
    }
    for (const child of node.childNodes) {
      draw(child, inFloat);
    }
  };
  for (const node of root.childNodes) {
    draw(node, false);
  }
  for (const node of floats) {
    draw(node, true);
  }

  // Content the sheet could not paginate (a block taller than a page) runs
  // past the paper; the assembly then shrinks the page to fit rather than lose it.
  page.box = { x0: 0, top: PAGE_H, bottom: 0 };
  page.minY = PAGE_H - (box.height - pxOf(getComputedStyle(root).paddingBottom)) * scale;
}

/**
 * Walks a sanitised one-page body into blocks of styled items, for the flow
 * writer: { align, frame, items }, where an item is a piece of text (with
 * its bold, italic, underline, strike, font, size, colour and highlight), a
 * censor mark (only its length, never its characters: carrying the string
 * and measuring it made the bar's width an exact glyph-metric oracle of the
 * hidden text), an attachment, or a table (cells as tokens, column widths
 * and row heights as the handles set them). A line with no alignment of its
 * own takes its container's, as CSS inherits it. A design's frame line is
 * marked, so it can never open a page of its own (a footer that did not
 * quite fit once printed alone on the next sheet, three times over). Lists
 * get "•  " or "N.  ", each list counting from 1; links print underlined in
 * the link colour.
 *
 * Used by: this file (buildNotePdf).
 * Uses: mediaLayout (history.js), cellTokens, EDITOR_BLOCK_TAGS (history.js).
 * Complexity: O(n) in the body.
 */
function collectRuns(root, mediaFor) {
  const blocks = [];
  let current = { align: "left", items: [] };
  const pushBlock = () => {
    blocks.push(current);
    current = { align: current.align, items: [], frame: current.frame };
  };
  const walk = (node, format) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const parts = child.data.split("\n");
        parts.forEach((part, i) => {
          if (i) {
            pushBlock();
          }
          if (part) {
            current.items.push({ t: "text", s: part, ...format });
          }
        });
      } else if (child.nodeType !== 1) {
        continue;
      } else if (child.tagName === "BR") {
        pushBlock();
      } else if (child.getAttribute && child.getAttribute("data-censor") === "1") {
        current.items.push({ t: "censor", len: (child.textContent || "").length, ...format });
      } else if (child.classList && child.classList.contains("inline-media")) {
        const mid = child.getAttribute("data-mid");
        const kind = child.getAttribute("data-kind");
        const layout = mediaLayout(child);
        current.items.push({ t: "media", mid, kind, meta: mediaFor(mid), w: layout.w, align: layout.align,
          fx: layout.fx, fy: layout.fy });
      } else if (child.tagName === "TABLE") {
        if (current.items.length) {
          pushBlock();
        }
        // Tables are laid out by the writer, so they travel as one item with
        // their cells' tokens.
        const rows = [...child.querySelectorAll("tr")].map(tr =>
          [...tr.children].map(td => ({
            tokens: cellTokens(td),
            header: td.tagName === "TH",
            align: (/text-align:\s*(center|right)/.exec(td.getAttribute("style") || "") || [])[1] || "left",
          })));
        const tableLayout = mediaLayout(child);
        const firstRow = child.querySelector("tr");
        const colPx = firstRow ? [...firstRow.children].map(cell =>
          parseInt((/width:\s*(\d+)px/.exec(cell.getAttribute("style") || "") || [])[1] || "", 10) || 0) : [];
        const rowPx = [...child.querySelectorAll("tr")].map(tr =>
          parseInt((/height:\s*(\d+)px/.exec((tr.children[0] || {}).getAttribute
            ? tr.children[0].getAttribute("style") || "" : "") || [])[1] || "", 10) || 0);
        if (rows.length) {
          blocks.push({ align: "left",
            items: [{ t: "table", rows, fx: tableLayout.fx, fy: tableLayout.fy, colPx, rowPx, ...format }] });
        }
      } else if (EDITOR_BLOCK_TAGS.has(child.tagName) || child.tagName === "LI") {
        if (current.items.length) {
          pushBlock();
        }
        const style = child.getAttribute ? (child.getAttribute("style") || "") : "";
        const align = /text-align:\s*(left|center|right|justify)/.exec(style);
        const previousAlign = current.align;
        const previousFrame = current.frame;
        if (child.dataset && child.dataset.frame) {
          current.frame = child.dataset.frame;
        }
        current.align = align ? align[1] : previousAlign;
        if (child.tagName === "LI") {
          const marker = format.olIndex ? format.olIndex + ".  " : "•  ";
          current.items.push({ t: "text", s: marker, ...format });
          if (format.ol) {
            format.olIndex++;
          }
        }
        const before = blocks.length;
        walk(child, format);
        // A line prints as a line even when empty, and the <br> ending it (an
        // empty line's placeholder) adds none of its own; a block that only
        // held other blocks (a frame of lines) adds nothing either.
        if (current.items.length || (blocks.length === before && child.firstChild)) {
          pushBlock();
        }
        current.align = previousAlign;
        current.frame = previousFrame;
      } else if (child.tagName === "UL" || child.tagName === "OL") {
        if (current.items.length) {
          pushBlock();
        }
        const isOl = child.tagName === "OL";
        walk(child, { ...format, ol: isOl, olIndex: isOl ? 1 : 0 });
      } else if (child.tagName === "A") {
        walk(child, { ...format, under: true, color: "#1a4f8a" });
      } else {
        const tag = child.tagName;
        const style = child.getAttribute ? (child.getAttribute("style") || "") : "";
        const family = /font-family:\s*([^;]+)/.exec(style);
        const size = /font-size:\s*(\d+(?:\.\d+)?)(pt|px)/.exec(style);
        // Anchored to the start of a declaration: unanchored, "color:" also
        // matched inside "background-color:", and highlighted text printed in
        // its highlight colour.
        const color = /(?:^|;)\s*color:\s*(#[0-9a-f]{3,8})/i.exec(style);
        const background = /background-color:\s*(#[0-9a-f]{3,8})/i.exec(style);
        const next = {
          bold: format.bold || tag === "B" || tag === "STRONG" || /font-weight:\s*(bold|[6-9]00)/.test(style),
          italic: format.italic || tag === "I" || tag === "EM" || /font-style:\s*italic/.test(style),
          under: format.under || tag === "U" || /text-decoration:\s*underline/.test(style),
          strike: format.strike || tag === "S" || tag === "STRIKE" || /line-through/.test(style),
          family: family ? family[1].trim() : format.family,
          size: size ? +size[1] * (size[2] === "px" ? 0.75 : 1) : format.size,
          color: color ? color[1] : format.color,
          bg: background ? background[1] : format.bg,
        };
        // text-align on a piece of text does nothing on the sheet, so nothing here either.
        walk(child, next);
      }
    }
  };
  walk(root, { bold: false, italic: false, under: false, strike: false, family: "", size: 12, color: "#000000", bg: null });
  if (current.items.length) {
    blocks.push(current);
  }
  return blocks;
}

/**
 * A table cell as drawable tokens: { s } for text, or { censor, len } for a
 * censored run. Cells are read as tokens, not textContent: a censored span
 * in a table must lose its characters exactly like one in a paragraph, and
 * textContent would have copied the secret straight into the PDF.
 *
 * Used by: this file (collectRuns).
 * Uses: nothing.
 * Complexity: O(n) in the cell.
 */
function cellTokens(td) {
  const out = [];
  const walk = (node, censored) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.data.replace(/\s+/g, " ");
        if (!text) {
          continue;
        }
        if (censored) {
          out.push({ censor: true, len: text.length });
        } else {
          out.push({ s: text });
        }
      } else if (child.nodeType === 1) {
        walk(child, censored || (child.getAttribute && child.getAttribute("data-censor") === "1"));
      }
    }
  };
  walk(td, false);
  return out;
}

// ---------- Pictures in a PDF ----------

/**
 * A picture as a PDF image, { w, h, filter, data }, or null when it cannot
 * be decoded. A JPEG is passed through untouched (DCTDecode) only when it is
 * a plain 3-component JPEG whose own frame size matches what was decoded,
 * and carries no metadata: a rotated photo, a CMYK or greyscale JPEG, or
 * anything unreadable goes through the canvas instead (declaring the wrong
 * size or colour space left the viewer painting the rest black), and so
 * does one with metadata, since the scrub on adding can fail silently and
 * copying would then ship EXIF and GPS inside the PDF. Through the canvas, a
 * picture is flattened onto white and deflated as raw RGB: pixels only.
 *
 * Used by: this file (buildNotePdf).
 * Uses: baseMimeType (vault.js), jpegFrame, jpegHasMetadata, deflate.
 * Complexity: O(w * h) in the picture's pixels.
 */
async function pdfImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) {
    return null;
  }
  // The size is read first: close() (and emptying the canvas) resets it to 0,
  // which once produced /Width 0 and NaN placement.
  const width = bitmap.width;
  const height = bitmap.height;
  if (!(width > 0 && height > 0)) {
    bitmap.close && bitmap.close();
    return null;
  }
  if (baseMimeType(mime) === "image/jpeg") {
    const frame = jpegFrame(bytes);
    if (frame && frame.comps === 3 && frame.w === width && frame.h === height && !jpegHasMetadata(bytes)) {
      bitmap.close && bitmap.close();
      return { w: width, h: height, filter: "/DCTDecode", data: new Uint8Array(bytes) };
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  // Transparency is flattened onto white.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close && bitmap.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4) {
    rgb[j++] = pixels[i];
    rgb[j++] = pixels[i + 1];
    rgb[j++] = pixels[i + 2];
  }
  canvas.width = canvas.height = 0;
  const packed = await deflate(rgb);
  return { w: width, h: height, filter: packed ? "/FlateDecode" : null, data: packed || rgb };
}

/**
 * Whether a JPEG carries anything beyond pixels: EXIF, XMP or ICC (APP1 to
 * APP15), a comment, or an APP0 that is not plain JFIF. Anything it cannot
 * read counts as carrying metadata, since it is not ours to vouch for.
 *
 * Used by: this file (pdfImage).
 * Uses: nothing.
 * Complexity: O(n) in the bytes before the scan.
 */
function jpegHasMetadata(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return true;
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
      continue;
    }
    // The scan was reached: clean.
    if (marker === 0xD9 || marker === 0xDA) {
      return false;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) {
      return true;
    }
    // APP1 to APP15: EXIF, XMP, ICC...
    if (marker >= 0xE1 && marker <= 0xEF) {
      return true;
    }
    // A comment.
    if (marker === 0xFE) {
      return true;
    }
    // APP0 must be bare JFIF.
    if (marker === 0xE0) {
      const tag = String.fromCharCode(bytes[i + 4] || 0, bytes[i + 5] || 0, bytes[i + 6] || 0, bytes[i + 7] || 0);
      if (tag !== "JFIF") {
        return true;
      }
    }
    i += 2 + len;
  }
  // The scan was never reached.
  return true;
}

// ---------- The PDF file ----------

/**
 * A minimal PDF writer: objects are appended, then an xref table is written.
 * Streams carry raw bytes, so picture data never goes through a string. It
 * offers push (bytes or a Latin-1 string), obj (a new object at the end),
 * reserve and place (a number now, its object later: pages need their
 * children's numbers), write (an object), stream (an object with a stream)
 * and finish (the xref table and trailer, and the whole file's bytes).
 *
 * Used by: this file (buildNotePdf).
 * Uses: latin1Bytes.
 * Complexity: O(b) in the file's bytes.
 */
function pdfDoc() {
  // The file's pieces, in order: strings and byte arrays.
  const chunks = [];
  // Object number -> byte offset.
  const offsets = [0];
  let len = 0;
  const push = chunk => {
    const bytes = typeof chunk === "string" ? latin1Bytes(chunk) : chunk;
    chunks.push(bytes);
    len += bytes.length;
  };
  const obj = () => {
    offsets.push(len);
    return offsets.length - 1;
  };
  return {
    push,
    obj,
    get len() {
      return len;
    },
    reserve() {
      offsets.push(-1);
      return offsets.length - 1;
    },
    place(n) {
      offsets[n] = len;
    },
    write(n, body) {
      offsets[n] = len;
      push(n + " 0 obj\n" + body + "\nendobj\n");
    },
    stream(n, dict, data) {
      offsets[n] = len;
      push(n + " 0 obj\n<< " + dict + " /Length " + data.length + " >>\nstream\n");
      push(data);
      push("\nendstream\nendobj\n");
    },
    finish(rootN) {
      const xref = len;
      let s = "xref\n0 " + offsets.length + "\n0000000000 65535 f \n";
      for (let i = 1; i < offsets.length; i++) {
        s += String(Math.max(0, offsets[i])).padStart(10, "0") + " 00000 n \n";
      }
      s += "trailer\n<< /Size " + offsets.length + " /Root " + rootN + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
      push(s);
      const out = new Uint8Array(len);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
  };
}

// ---------- Censoring in exports ----------

/**
 * The one rule every censor bar is sized by, wherever it is drawn: a coarse
 * bucket of the character count (steps of 4, from 4 to 24). All an export
 * can reveal about a censored run is which of six buckets its length fell
 * into: never its glyph widths, never its exact count.
 *
 * Used by: this file (censorBarW, exportNotePdf), censor.js (plainLines),
 * designs.js (stripCensoredForExport).
 * Uses: nothing.
 * Complexity: O(1).
 */
function censorLenBucket(len) {
  return Math.min(24, Math.max(4, Math.ceil((+len || 1) / 4) * 4));
}

/**
 * The media ids a body shows outside censored text, and those whose only
 * references are censored: { visible, censored }. Exports use these, never
 * the plain list of references: a censored reference is a redaction, and
 * exporting the bytes it points at would defeat it.
 *
 * Used by: this file (visibleMediaIds, sidecarAttachments).
 * Uses: sanitizeBodyFragment (history.js).
 * Complexity: O(n) in the body.
 */
function censorSplitMediaIds(body) {
  const holder = document.createElement("div");
  holder.appendChild(sanitizeBodyFragment(String(body || "")));
  const visible = new Set();
  const censored = new Set();
  for (const el of holder.querySelectorAll(".inline-media")) {
    const mid = el.getAttribute("data-mid");
    if (!mid) {
      continue;
    }
    (el.closest('[data-censor="1"]') ? censored : visible).add(mid);
  }
  return { visible, censored };
}

// ---------- Exporting ----------

/**
 * Exports a note with the built-in writer: as a single PDF download, or
 * (mode "folder") as a folder holding <note>.pdf and files/ with every
 * attachment the PDF only references, each decrypted (AES-256-GCM) to be
 * written. The folder is asked for first: the picker only opens during the
 * click's short-lived permission, and building the PDF first meant that on
 * any note with many pictures the picker never appeared. When no folder can
 * be had, the PDF is downloaded on its own and the status line says why.
 *
 * Used by: notes.js (noteMenu).
 * Uses: flushSave and status (pagination.js), safeName, pickExportDir,
 * buildNotePdf, downloadPlain (attachments.js), sidecarAttachments,
 * sidecarNames, idbGet and decryptMedia (vault.js).
 * Complexity: that of buildNotePdf, plus O(size) per attached file.
 */
async function exportNoteInternal(id, mode) {
  const note = vault && vault.notes[id];
  if (!note || syncing) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }
  const base = safeName(note.title || "Untitled");
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
  try {
    bytes = await buildNotePdf(note, { linkFiles: mode === "folder" && !!dir });
  } catch (error) {
    status("PDF failed: " + error.message, true);
    return;
  }
  if (!bytes) {
    status("");
    return;
  }
  if (mode !== "folder") {
    downloadPlain(base + ".pdf", "application/pdf", bytes);
    status(`Exported ${base}.pdf`);
    return;
  }
  if (!dir) {
    downloadPlain(base + ".pdf", "application/pdf", bytes);
    status("No folder chosen - the PDF was downloaded on its own", true);
    return;
  }

  try {
    const noteDir = await dir.getDirectoryHandle(base, { create: true });
    const writeFile = async (handle, name, data, type) => {
      const fileHandle = await handle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(new Blob([data], { type: type || "application/octet-stream" }));
      await writable.close();
    };
    await writeFile(noteDir, base + ".pdf", bytes, "application/pdf");
    const extras = sidecarAttachments(note);
    let wrote = 0;
    let missing = 0;
    if (extras.length) {
      const filesDir = await noteDir.getDirectoryHandle("files", { create: true });
      // The same names the PDF links to.
      const names = sidecarNames(note);
      for (const meta of extras) {
        status(`Writing ${meta.name || "attachment"}...`, false, true);
        let record = null;
        try {
          record = await idbGet(meta.id);
        } catch {}
        if (!record) {
          missing++;
          continue;
        }
        let plain;
        try {
          plain = await decryptMedia(meta.id, record.bytes);
        } catch {
          missing++;
          continue;
        }
        // Locked during the export.
        if (!vault) {
          return;
        }
        await writeFile(filesDir, names.get(meta.id) || safeName(meta.name || meta.id), plain, meta.mime);
        wrote++;
      }
    }
    status(`Exported to ${base}/ - ${base}.pdf` +
      (wrote ? ` and files/ (${wrote} file${wrote === 1 ? "" : "s"})` : "") +
      (missing ? `, ${missing} not on this device` : ""));
  } catch (error) {
    status("Could not write the folder: " + error.message, true);
  }
}

/**
 * Asks for a folder to export into, as { dir, why }: dir when one was
 * granted; why is "cancelled", "unsupported" or an error name otherwise (a
 * bare null once hid the difference between closing the dialog and the
 * dialog never opening). It never reuses the vault folder's handle: exports
 * go wherever the user wants, never by default into the notes folder.
 *
 * Used by: this file (exportNoteInternal).
 * Uses: nothing.
 * Complexity: O(1).
 */
async function pickExportDir() {
  if (!("showDirectoryPicker" in window)) {
    return { dir: null, why: "unsupported" };
  }
  try {
    return { dir: await window.showDirectoryPicker({ id: "notes-export", mode: "readwrite", startIn: "documents" }), why: null };
  } catch (error) {
    return { dir: null, why: error && error.name === "AbortError" ? "cancelled" : ((error && error.name) || "error") };
  }
}

/**
 * The attachments that travel next to the PDF in files/ (videos, documents,
 * text files: pictures are in the page). One never placed in the text still
 * travels (it sits in the strip, uncensored); one whose only references are
 * censored does not: the folder export once wrote its decrypted bytes under
 * its real name right next to a PDF showing a black bar.
 *
 * Used by: this file (exportNoteInternal, sidecarNames).
 * Uses: noteBodies (content.js), censorSplitMediaIds, kindForMime (vault.js).
 * Complexity: O(n) in the note.
 */
function sidecarAttachments(note) {
  const visible = new Set();
  const censored = new Set();
  for (const entry of noteBodies(note)) {
    if (entry.bodyV === 2) {
      const split = censorSplitMediaIds(entry.body);
      for (const id of split.visible) {
        visible.add(id);
      }
      for (const id of split.censored) {
        censored.add(id);
      }
    }
  }
  return (note.media || []).filter(meta => kindForMime(meta.mime) !== "image" &&
    (visible.has(meta.id) || !censored.has(meta.id)));
}

/**
 * The name each attachment gets inside files/ (a second "a.pdf" becomes
 * "a-2.pdf"). The PDF links to these and the export writes them, so both
 * must agree, or the links point at nothing.
 *
 * Used by: this file (buildNotePdf, exportNoteInternal).
 * Uses: sidecarAttachments, safeName.
 * Complexity: O(m) in the attachments.
 */
function sidecarNames(note) {
  const used = new Set();
  const out = new Map();
  for (const meta of sidecarAttachments(note)) {
    let name = safeName(meta.name || meta.id);
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let k = 2;
      while (used.has(stem + "-" + k + ext)) {
        k++;
      }
      name = stem + "-" + k + ext;
    }
    used.add(name);
    out.set(meta.id, name);
  }
  return out;
}

/**
 * A file name safe on Windows too: no path or reserved characters, no
 * control characters, at most 80 characters, no trailing dot or space (both
 * refused by getFileHandle, which aborted a folder export half way), and a
 * reserved DOS name (CON, NUL, COM1...) gets a "_" in front.
 *
 * Used by: this file (exportNoteInternal, sidecarNames), designs.js (exportDesign).
 * Uses: nothing.
 * Complexity: O(n) in the name.
 */
function safeName(s) {
  let name = String(s || "note").replace(/[\\/:*?"<>|]/g, "-").replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 80).replace(/[. ]+$/, "") || "note";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name.split(".")[0])) {
    name = "_" + name;
  }
  return name;
}

/**
 * Exports a note through the browser's own print-to-PDF ("Save as PDF"): no
 * library, nothing loaded from elsewhere. The note is written into an
 * about:blank iframe of the same origin, so nothing leaves the page and the
 * print CSS cannot touch the app's own layout. Pictures shown outside
 * censored text are decrypted (AES-256-GCM) once into data: addresses, since
 * a blob: address owned by this document would not reach the print. Each
 * page goes through the same sanitiser and line packing as the sheets; then
 * censored text is destroyed (each mark becomes an empty box sized by the
 * coarse bucket, so the layout still looks right while the characters never
 * reach the file: a black background over live text would still be
 * selectable and searchable), pictures become <img>, and other attachments
 * a labelled card (kind, name, size). The document's title is empty, so
 * nothing about the note reaches the PDF's metadata (the browser still
 * writes its own Producer and CreationDate, which a page cannot change).
 *
 * Used by: notes.js (noteMenu).
 * Uses: flushSave and status (pagination.js), noteBodies and isPaged
 * (content.js), visibleMediaIds, isRenderableImage, idbGet and decryptMedia
 * (vault.js), bodyFragment (lines.js), censorLenBucket, mediaLayout
 * (history.js), formatSize (attachments.js).
 * Complexity: O(n) in the note, plus O(size) per picture.
 */
async function exportNotePdf(id) {
  const note = vault && vault.notes[id];
  if (!note || syncing) {
    return;
  }
  if (id === currentId) {
    flushSave();
  }
  status("Preparing PDF...", false, true);
  const esc = s => String(s).replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

  const wanted = new Set();
  for (const entry of noteBodies(note)) {
    if (entry.bodyV === 2) {
      for (const mid of visibleMediaIds(entry.body)) {
        wanted.add(mid);
      }
    }
  }
  const dataUrls = new Map();
  for (const mid of wanted) {
    const meta = (note.media || []).find(item => item.id === mid);
    // Only pictures can be drawn on a page.
    if (!meta || !isRenderableImage(meta.mime)) {
      continue;
    }
    try {
      const record = await idbGet(mid);
      if (!record) {
        continue;
      }
      const plain = await decryptMedia(mid, record.bytes);
      // Locked during the export.
      if (!vault) {
        return;
      }
      dataUrls.set(mid, await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(new Blob([plain], { type: meta.mime }));
      }));
    } catch {}
  }

  const pageHtml = entry => {
    if (entry.bodyV !== 2) {
      return "<div class=\"pg-text\">" + esc(entry.body || "") + "</div>";
    }
    const holder = document.createElement("div");
    holder.appendChild(bodyFragment(entry.body, 2));
    holder.querySelectorAll("[data-censor]").forEach(mark => {
      const box = document.createElement("span");
      box.className = "censor-box";
      box.style.width = (censorLenBucket((mark.textContent || "").length) * 0.5) + "em";
      box.setAttribute("aria-label", "redacted");
      // The original text goes with the mark.
      mark.replaceWith(box);
    });
    holder.querySelectorAll("span.inline-media").forEach(wrapper => {
      const mid = wrapper.getAttribute("data-mid");
      const kind = wrapper.getAttribute("data-kind");
      const meta = (note.media || []).find(item => item.id === mid);
      const url = dataUrls.get(mid);
      const layout = mediaLayout(wrapper);
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        if (layout.w) {
          img.style.width = layout.w + "px";
        }
        if (layout.align) {
          img.style.display = "block";
          img.style.marginLeft = layout.align === "left" ? "0" : "auto";
          img.style.marginRight = layout.align === "right" ? "0" : "auto";
        }
        wrapper.replaceWith(img);
      } else {
        // A span, not a div: a block card owns the whole row, so a run of
        // attachments printed one per line with most of the page empty.
        const box = document.createElement("span");
        box.className = "att-box" + (layout.align ? " a-" + layout.align : "");
        const label = { video: "Video", pdf: "PDF", text: "Text file", file: "File" }[kind] || "Attachment";
        const name = (meta && meta.name) || "not on this device";
        const size = meta && meta.size ? " &middot; " + formatSize(meta.size) : "";
        box.innerHTML = `<span class="att-kind">${esc(label)}</span><span class="att-name">${esc(name)}</span>` +
          `<span class="att-size">${size}</span>`;
        wrapper.replaceWith(box);
      }
    });
    return holder.innerHTML;
  };

  const bodies = noteBodies(note);
  const paged = isPaged(note);
  const sections = bodies.map((entry, i) => {
    // Each page of a paged note starts on a new sheet; a one-page note flows.
    const head = paged ? `<h2 class="pg-head">${esc(entry.name || "Page " + (i + 1))}</h2>` : "";
    return `<section class="pg${i && paged ? " brk" : ""}">${head}${pageHtml(entry)}</section>`;
  }).join("");
  const title = (note.title || "Untitled").trim() || "Untitled";
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
  // Layout and the decoded pictures settle first, or the first print can come out blank.
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    const images = [...frame.contentDocument.images];
    await Promise.all(images.map(image => image.complete ? null : new Promise(resolve => {
      image.onload = image.onerror = resolve;
    })));
    frame.contentWindow.focus();
    frame.contentWindow.print();
    status("Choose \"Save as PDF\" in the print dialog");
  } catch (error) {
    status("Could not open the print dialog: " + error.message, true);
  }
  // The dialog is modal in every current browser, so by now it has been closed.
  setTimeout(() => frame.remove(), 1000);
}

// =================== Auxiliary functions ===================

/**
 * The PDF name for a piece of media: the whole id, letters and digits only
 * (two ids sharing their first 8 characters once drew each other's picture).
 * Complexity: O(n).
 */
function imgName(mid) {
  return String(mid).replace(/[^A-Za-z0-9]/g, "");
}

/**
 * The printed size of an inline picture in points, matching the sheet: an
 * untouched picture fits inside 320x240 CSS px, a resized one has the width
 * it was given (getting this wrong made the PDF paginate differently from
 * the screen). It is never bigger than a page (the sheet clamps the same
 * way, and the 6pt keeps its line inside the page instead of one point over,
 * which would bounce it to a page of its own forever). Complexity: O(1).
 */
function mediaBox(record, item) {
  let w;
  let h;
  if (item && item.w) {
    w = item.w;
    h = item.w * record.h / record.w;
  } else {
    const s = Math.min(320 / record.w, 240 / record.h, 1);
    w = record.w * s;
    h = record.h * s;
  }
  // CSS px to pt.
  w *= 0.75;
  h *= 0.75;
  const s2 = Math.min(1, (PAGE_W - 2 * MARGIN_X) / w, (PAGE_H - 2 * MARGIN_Y - 6) / h);
  return { w: w * s2, h: h * s2 };
}

/** The base-14 font (and its widths) a UI font maps to: Times, Courier or Helvetica. Complexity: O(1). */
function pdfFontFor(family, bold, italic) {
  const lower = (family || "").toLowerCase();
  let base = "Helvetica";
  let widths = bold ? W_HELV_B : W_HELV;
  if (/georgia|times|serif/.test(lower) || !lower) {
    base = "Times";
    widths = bold ? W_TIMES_B : W_TIMES;
  }
  if (/courier|consolas|mono/.test(lower)) {
    return { name: "Courier" + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""), fixed: 600 };
  }
  if (base === "Times") {
    const suffix = bold && italic ? "-BoldItalic" : bold ? "-Bold" : italic ? "-Italic" : "-Roman";
    return { name: "Times" + suffix, widths };
  }
  const suffix = bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "";
  return { name: "Helvetica" + suffix, widths };
}

/** A string's width in points in a font at a size, from its AFM widths. Complexity: O(n). */
function textWidth(str, font, size) {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const i = code - 32;
    width += font.fixed ? font.fixed : (i >= 0 && i < font.widths.length ? font.widths[i] : 500);
  }
  return width * size / 1000;
}

/**
 * A string for a PDF text literal: the WinAnsi extras become their bytes,
 * anything else outside Latin-1 becomes "?" (rather than corrupting the
 * file), and backslashes and brackets are escaped. Complexity: O(n).
 */
function pdfEscape(s) {
  return String(s)
    .replace(/[•–—‘’“”…€]/g, c => WINANSI[c])
    .replace(/[^\x20-\x7E\x80-\xFF]/g, "?")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * A string as bytes, one per character. Content streams are bytes, not
 * UTF-8: with WinAnsiEncoding a bullet is the single byte 0x95 and "ñ" is
 * 0xF1, and UTF-8 would emit two bytes and two wrong glyphs. Complexity: O(n).
 */
function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 255;
  }
  return out;
}

/** Bytes deflated with CompressionStream, or null where the browser has none. Complexity: O(n). */
async function deflate(bytes) {
  if (typeof CompressionStream !== "function") {
    return null;
  }
  const compressor = new CompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(compressor);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A censor bar's width in points: the length bucket times half the font size. Complexity: O(1). */
function censorBarW(len, size) {
  return censorLenBucket(len) * (size || 12) * 0.5;
}

/** "#rgb" or "#rrggbb" as [r, g, b], each 0 to 1. Complexity: O(1). */
function hexToRgb(hex) {
  const digits = hex.replace("#", "");
  const full = digits.length === 3 ? digits.split("").map(c => c + c).join("") : digits.slice(0, 6);
  const value = parseInt(full, 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

/**
 * What a JPEG itself says it is, from its SOF marker: { w, h, comps,
 * progressive }, or null. The browser's ImageBitmap is no substitute: it
 * applies the EXIF orientation, so a rotated phone photo reports 4032x3024
 * while the data in the file is 3024x4032. Complexity: O(n) up to the frame.
 */
function jpegFrame(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return null;
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    // Padding: the next marker is found again.
    if (bytes[i] !== 0xFF) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
      continue;
    }
    // The scan was reached with no frame header.
    if (marker === 0xD9 || marker === 0xDA) {
      return null;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) {
      return null;
    }
    // SOF0 to SOF15, except the DHT, JPG and DAC markers that share the range.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (i + 9 >= bytes.length) {
        return null;
      }
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8],
        comps: bytes[i + 9], progressive: marker === 0xC2 };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * A computed CSS colour as PDF rgb (0 to 1), or null when fully transparent.
 * The writer has no transparency, so a see-through colour is mixed onto the
 * white paper. Complexity: O(1).
 */
function cssRgb(value) {
  const match = /rgba?\(([^)]*)\)/.exec(value || "");
  if (!match) {
    return null;
  }
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (!(alpha > 0)) {
    return null;
  }
  return [0, 1, 2].map(i => parts[i] / 255 * alpha + 1 - alpha);
}

/** A colour as a PDF colour operator (rg to fill, RG to stroke). Complexity: O(1). */
function rgbOp(colour, op) {
  return colour.map(value => value.toFixed(3)).join(" ") + " " + op;
}

/** A colour's luminance (0 to 1). Complexity: O(1). */
function inkLum(colour) {
  return 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
}

/**
 * A rectangle with rounded corners as a PDF path; (x, y) is its bottom-left
 * corner, and each corner a quarter circle drawn as a Bezier curve.
 * Complexity: O(1).
 */
function roundRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const f = value => value.toFixed(2);
  if (r < 0.05) {
    return `${f(x)} ${f(y)} ${f(w)} ${f(h)} re`;
  }
  // The Bezier handle of a quarter circle.
  const c = r * 0.4477;
  const x1 = x + w;
  const y1 = y + h;
  return `${f(x + r)} ${f(y)} m ${f(x1 - r)} ${f(y)} l ${f(x1 - c)} ${f(y)} ${f(x1)} ${f(y + c)} ${f(x1)} ${f(y + r)} c ` +
    `${f(x1)} ${f(y1 - r)} l ${f(x1)} ${f(y1 - c)} ${f(x1 - c)} ${f(y1)} ${f(x1 - r)} ${f(y1)} c ` +
    `${f(x + r)} ${f(y1)} l ${f(x + c)} ${f(y1)} ${f(x)} ${f(y1 - c)} ${f(x)} ${f(y1 - r)} c ` +
    `${f(x)} ${f(y + r)} l ${f(x)} ${f(y + c)} ${f(x + c)} ${f(y)} ${f(x + r)} ${f(y)} c h`;
}

/**
 * Where the baseline sits in a text box, as a share of its height: the
 * font's ascent over ascent plus descent (cached per font). A Range reports
 * the box a run of text was drawn in; this turns it into the baseline the
 * PDF draws on. Complexity: O(1).
 */
function ascentShare(style) {
  const font = `${style.fontStyle} ${style.fontWeight} 100px ${style.fontFamily}`;
  if (!ascentShares.has(font)) {
    const context = document.createElement("canvas").getContext("2d");
    context.font = font;
    const metrics = context.measureText("Hg");
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    ascentShares.set(font, ascent > 0 && descent >= 0 ? ascent / (ascent + descent) : 0.8);
  }
  return ascentShares.get(font);
}

/**
 * The visible pieces of a text node: runs of non-space characters side by
 * side on one line, each with the box the browser drew it in. Spaces only
 * separate them, so a justified line keeps its stretched gaps.
 * Complexity: O(n) layout reads in the characters.
 */
function textPieces(textNode) {
  const range = document.createRange();
  const text = textNode.data;
  const out = [];
  let current = null;
  for (let i = 0; i < text.length;) {
    const n = text.codePointAt(i) > 0xFFFF ? 2 : 1;
    const ch = text.slice(i, i + n);
    let box = null;
    if (/\S/.test(ch)) {
      range.setStart(textNode, i);
      range.setEnd(textNode, i + n);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          box = rect;
          break;
        }
      }
    }
    i += n;
    if (!box) {
      current = null;
      continue;
    }
    if (current && Math.abs(box.top - current.top) < 0.5 && Math.abs(box.left - current.right) < 0.75) {
      current.s += ch;
      current.right = box.right;
    } else {
      out.push(current = { s: ch, left: box.left, right: box.right, top: box.top, h: box.height });
    }
  }
  return out;
}

/** The media ids a body shows outside censored text. Complexity: O(n). */
function visibleMediaIds(body) {
  return censorSplitMediaIds(body).visible;
}
