/*
 * ambient.js - the vertical lines of small oval marks in the margins beside
 * the writing column, drawn the way the lock screen's picture is, so the
 * inside of the app feels as calm as the lock screen.
 *
 * The lock screen's video is drawn in white oval marks on a grid, a
 * dot-matrix: the size of a mark says how bright that spot is, from a tiny
 * dot to a wide oval, and many marks lean a little. The side lines are built
 * the same way. A canvas (#ambient-lines) lies over the whole writing area,
 * under the editor and the sheets. Each margin gets a few vertical lines,
 * each a row of marks from top to bottom, strongest at the outer edge and
 * fading to nothing beside the text, so the text stays the brightest thing
 * on screen. Three things keep the lines from looking ruled:
 *   - every mark's size and lean come from a smooth noise field, so a line
 *     swells in one stretch, thins in the next and breaks where the field is
 *     low. Two copies of the field slide past each other, one up and one
 *     down, so the marks breathe in place and nothing travels or points;
 *   - each line sways a few pixels, slowly, on the same kind of field;
 *   - the marks near the pointer swell a little, filling the line in around
 *     it, and ease back when it leaves.
 * No lines are drawn in a margin under 72px (a narrow window, the second
 * screen), nothing runs while the app is locked or the tab is hidden, and
 * when the system asks for reduced motion one still frame is drawn instead.
 *
 * Main functions: startAmbientLines, stopAmbientLines, drawAmbientFrame.
 * Auxiliary functions: scheduleFrame, resizeCanvas, writingMargins,
 * layoutLines, markAt, swayAt, smoothNoise, followPointer, warmMark,
 * fillLine.
 *
 * Complexity: each frame is O(l * m), l lines of m marks: about 18 lines of
 * 43 marks in a wide window, about 1.5 ms. Frames come 7 times a second
 * while the lines are calm (about 1% of one processor core) and 30 times a
 * second only while marks near the pointer are swelling or easing back.
 */
"use strict";

// A margin narrower than this gets no lines: they would crowd the text.
const MIN_MARGIN = 72;

// The space kept clear between the lines and the text column.
const TEXT_CLEARANCE = 12;

// The space between two neighbouring lines, and between two marks of a line.
const LINE_GAP = 26;
const MARK_GAP = 14;

// The opacity of the outermost line; each line after it is fainter. This is
// the one number to change to make the lines fainter or stronger.
const LINE_OPACITY = 0.4;

// The marks take the app's warm white (--t1 in base.css), not pure white.
const LINE_COLOUR = "#e9e5de";

// A mark is an oval, longer along its line. MARK_DOT is its half-width and
// half-length at size 0 (a round dot); at size 1 it has grown by MARK_WIDTH
// across and MARK_LENGTH along, to 5.4px by 10.4px. Under MARK_GONE it is not
// drawn, which is what breaks a line. MARK_LEAN is the most it leans, in
// radians.
const MARK_DOT = 0.8;
const MARK_WIDTH = 1.9;
const MARK_LENGTH = 4.4;
const MARK_GONE = 0.08;
const MARK_LEAN = 0.45;

// The field the sizes come from: the size of its cells (100px across the
// lines, 166px along them, so a line changes a few times down its length)
// and how fast its two copies slide, in px per millisecond. A mark changes
// size by at most about a fifth in a second.
const FIELD_SCALE_X = 0.01;
const FIELD_SCALE_Y = 0.006;
const FIELD_DRIFT = 0.012;

// The sway: how far a line bends sideways, the size of that field's cells
// (50px across, 333px along) and how fast it changes, in cells per
// millisecond. It moves a mark about half a pixel a second.
const SWAY_X = 3;
const SWAY_SCALE_X = 0.02;
const SWAY_SCALE_Y = 0.003;
const SWAY_DRIFT = 0.00006;

// The pointer: how near it must be to warm a mark, how much size a fully
// warmed mark gains, and how much of the way a mark moves toward its warmth
// each frame (it swells and eases back in about half a second).
const POINTER_REACH = 130;
const POINTER_SWELL = 0.6;
const POINTER_EASE = 0.12;

// The time between two frames. Calm, the marks change far too slowly for
// more than 7 frames a second to show; marks warming under the pointer need
// 30 to move smoothly.
const CALM_FRAME_MS = 1000 / 7;
const LIVELY_FRAME_MS = 1000 / 30;

// The noise field's heights, 256 random values made once per page load.
const NOISE_HEIGHTS = Array.from({ length: 256 }, () => Math.random() * 2 - 1);

// The lines as laid out for the writing area's current size (see layoutLines),
// and the size they were laid out for.
let ambientLines = [];
let ambientLayoutKey = "";

// True from unlocking until locking.
let ambientRunning = false;

// The pending requestAnimationFrame id, 0 when none is pending.
let ambientFrame = 0;

// When the last frame was drawn, in requestAnimationFrame time.
let ambientLastDraw = 0;

// Whether a mark was still swelling or easing back in the last frame.
let ambientLively = false;

// The pointer: whether it is over the page, where it is in the window, and
// (worked out once a frame, see followPointer) where it is over the canvas.
const ambientPointer = { seen: false, clientX: 0, clientY: 0, x: 0, y: 0 };

// ---------- Starting and stopping ----------

/**
 * Starts the side lines when the app opens: the animation, or one still
 * frame when the system asks for reduced motion.
 *
 * Used by: lock.js (unlocking, and opening a backup), this file (when the
 * reduced-motion setting changes).
 * Uses: drawAmbientFrame, scheduleFrame, stillMotion (lock.js).
 * Complexity: O(1), plus the still frame it draws.
 */
function startAmbientLines() {
  ambientRunning = true;
  if (stillMotion.matches) {
    drawAmbientFrame(0);
    return;
  }
  if (!ambientFrame) {
    scheduleFrame();
  }
}

/**
 * Stops the side lines and clears the canvas, when the app locks.
 *
 * Used by: settings.js (lockApp), this file (when the reduced-motion setting
 * changes).
 * Uses: nothing.
 * Complexity: O(1).
 */
function stopAmbientLines() {
  ambientRunning = false;
  cancelAnimationFrame(ambientFrame);
  ambientFrame = 0;
  const canvas = $("ambient-lines");
  const context = canvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- Drawing ----------

/**
 * Draws one frame at a time in milliseconds. The lines are laid out again
 * when the writing area or its margins changed size; then each line is
 * filled mark by mark, as the field stands at that time and as the pointer
 * has warmed it. Drawing is clipped to the margins, so no mark ever crosses
 * into the text. With reduced motion the field is frozen at time 0 and the
 * pointer warms nothing.
 *
 * The canvas is wiped in its own pixels, before the scale is set. On a
 * screen scaled to 125% the scaled size can cover the last row of pixels
 * only in part; wiping just the scaled size left that row to build up,
 * frame after frame, into a white edge at the bottom.
 *
 * Used by: this file (the frame loop, the still frame, resizing).
 * Uses: resizeCanvas, writingMargins, layoutLines, followPointer, warmMark,
 * fillLine, stillMotion (lock.js).
 * Complexity: O(l * m), see the header.
 */
function drawAmbientFrame(time) {
  const canvas = $("ambient-lines");
  const context = canvas.getContext("2d");
  const { width, height, scale } = resizeCanvas(canvas);
  const margins = writingMargins(canvas);
  const layoutKey = [width, height, Math.round(margins.left), Math.round(margins.right)].join(" ");
  if (layoutKey !== ambientLayoutKey) {
    ambientLayoutKey = layoutKey;
    ambientLines = layoutLines(width, height, margins);
  }

  const still = stillMotion.matches;
  if (!still) {
    followPointer(canvas);
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.save();
  context.beginPath();
  context.rect(0, 0, margins.left - TEXT_CLEARANCE, height);
  context.rect(width - margins.right + TEXT_CLEARANCE, 0, margins.right - TEXT_CLEARANCE, height);
  context.clip();
  context.fillStyle = LINE_COLOUR;

  let lively = false;
  for (const line of ambientLines) {
    if (!still) {
      for (const point of line.points) {
        lively = warmMark(point, line.x) || lively;
      }
    }
    fillLine(context, line, still ? 0 : time);
  }
  context.restore();
  ambientLively = lively;
}

// ---------- On load: the pointer, pausing, resizing, reduced motion ----------

// Only where the pointer is; what it does to the marks is worked out once a frame.
window.addEventListener("pointermove", event => {
  ambientPointer.seen = true;
  ambientPointer.clientX = event.clientX;
  ambientPointer.clientY = event.clientY;
}, { passive: true });

// A pointer that left the window warms nothing.
document.documentElement.addEventListener("pointerleave", () => {
  ambientPointer.seen = false;
});

// A hidden tab draws nothing; the lines go on where they were when it shows again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(ambientFrame);
    ambientFrame = 0;
  } else if (ambientRunning && !stillMotion.matches && !ambientFrame) {
    scheduleFrame();
  }
});

// The animation follows the window's size by itself; the still frame is drawn again.
window.addEventListener("resize", () => {
  if (ambientRunning && stillMotion.matches) {
    drawAmbientFrame(0);
  }
});

// Turning reduced motion on or off while the app is open switches between the two.
stillMotion.addEventListener("change", () => {
  if (ambientRunning) {
    stopAmbientLines();
    startAmbientLines();
  }
});

// =================== Auxiliary functions ===================

/**
 * Asks for the next animation frame, and draws in it when a frame is due
 * (7 a second while calm, 30 while a mark is warming), then asks again, for
 * as long as the lines run and the tab shows. A frame counts as due a
 * little early (90% of the gap), since frame times jitter and it would
 * otherwise sometimes come one screen frame late.
 *
 * Complexity: O(1), plus the frame it draws.
 */
function scheduleFrame() {
  ambientFrame = requestAnimationFrame(time => {
    ambientFrame = 0;
    if (!ambientRunning || document.hidden) {
      return;
    }
    const frameGap = ambientLively ? LIVELY_FRAME_MS : CALM_FRAME_MS;
    if (time - ambientLastDraw >= frameGap * 0.9) {
      ambientLastDraw = time;
      drawAmbientFrame(time);
    }
    scheduleFrame();
  });
}

/**
 * Matches the canvas's pixels to its size on screen and the screen's pixel
 * density, so the marks stay sharp. Returns that size in CSS pixels and the
 * scale from CSS pixels to the canvas's own.
 *
 * Complexity: O(1); a resize clears the canvas.
 */
function resizeCanvas(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  return { width, height, scale };
}

/**
 * The width of the margin on each side of the writing column, in CSS
 * pixels: the editor's side padding for a single-page note, the space beside
 * the first sheet for a paged one, and none on the second screen.
 *
 * Complexity: O(1); it reads layout the browser has already done.
 */
function writingMargins(canvas) {
  if (document.body.classList.contains("split-edit")) {
    return { left: 0, right: 0 };
  }
  if (document.body.classList.contains("paged-view")) {
    const sheet = document.querySelector("#sheets .sheet");
    if (!sheet) {
      return { left: 0, right: 0 };
    }
    const area = canvas.getBoundingClientRect();
    const page = sheet.getBoundingClientRect();
    return { left: page.left - area.left, right: area.right - page.right };
  }
  const padding = parseFloat(getComputedStyle($("editor")).paddingLeft) || 0;
  return { left: padding, right: padding };
}

/**
 * Lays the lines out for a writing area of this size: in each margin of
 * MIN_MARGIN or more, one line every LINE_GAP from the outer edge inward,
 * stopping short of the text. Each line knows where it stands (x), how
 * opaque it is (LINE_OPACITY at the outer edge, falling evenly to nothing at
 * the text; a line under 0.04 is left out, it could not be seen) and the
 * places of its marks, one every MARK_GAP from above the top to below the
 * bottom, each with its warmth from the pointer (glow, 0 to 1).
 *
 * Complexity: O(l * m).
 */
function layoutLines(width, height, margins) {
  const lines = [];
  for (const side of [-1, 1]) {
    const margin = side < 0 ? margins.left : margins.right;
    if (margin < MIN_MARGIN) {
      continue;
    }
    // Room for the widest mark and the sway before the clearance.
    const reach = margin - TEXT_CLEARANCE - SWAY_X - MARK_DOT - MARK_LENGTH;

    for (let distance = LINE_GAP / 2; distance < reach; distance += LINE_GAP) {
      const alpha = LINE_OPACITY * (1 - distance / reach);
      if (alpha < 0.04) {
        break;
      }
      const points = [];
      for (let y = -MARK_GAP; y <= height + MARK_GAP; y += MARK_GAP) {
        points.push({ y, glow: 0 });
      }
      lines.push({ x: side < 0 ? distance : width - distance, alpha, points });
    }
  }
  return lines;
}

/**
 * The mark at (x, y) at a time in milliseconds: { size, lean }. The size (0
 * to 1) adds two copies of the noise field, one sliding up and one sliding
 * down, so it swells and shrinks where it is and no shape travels along the
 * line; about a tenth of the marks come out under MARK_GONE, the gaps. The
 * lean follows the difference of the two, so it changes as gently.
 *
 * Complexity: O(1).
 */
function markAt(x, y, time) {
  const across = x * FIELD_SCALE_X;
  const rising = smoothNoise(across + 7.3, (y + time * FIELD_DRIFT) * FIELD_SCALE_Y);
  const falling = smoothNoise(across + 91.7, (y - time * FIELD_DRIFT) * FIELD_SCALE_Y + 40.5);
  return {
    size: Math.max(0, Math.min(1, 0.5 + 0.6 * (rising + falling))),
    lean: MARK_LEAN * (rising - falling) / 2,
  };
}

/**
 * How far the sway carries the mark at rest at (x, y), at a time in
 * milliseconds: { dx, dy }. Sideways only, a few pixels, changing very
 * slowly, so a line is never quite straight and never still.
 *
 * Complexity: O(1).
 */
function swayAt(x, y, time) {
  return { dx: SWAY_X * smoothNoise(x * SWAY_SCALE_X + 500.5, y * SWAY_SCALE_Y + time * SWAY_DRIFT), dy: 0 };
}

/**
 * Smooth noise: a height from -1 to 1 for any point of the plane, random
 * from cell to cell but changing smoothly in between (the four corners of a
 * cell, each with its own random height, blended with an ease at both ends).
 * It is what makes the marks look grown and not ruled.
 *
 * Complexity: O(1).
 */
function smoothNoise(x, y) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const alongX = x - cellX;
  const alongY = y - cellY;
  const easeX = alongX * alongX * (3 - 2 * alongX);
  const easeY = alongY * alongY * (3 - 2 * alongY);
  const corner = (column, row) => NOISE_HEIGHTS[(column * 57 + row * 131) & 255];

  const top = corner(cellX, cellY) + (corner(cellX + 1, cellY) - corner(cellX, cellY)) * easeX;
  const bottom = corner(cellX, cellY + 1) + (corner(cellX + 1, cellY + 1) - corner(cellX, cellY + 1)) * easeX;
  return top + (bottom - top) * easeY;
}

/**
 * Works out, once a frame, where the pointer is over the canvas.
 *
 * Complexity: O(1); it reads layout the browser has already done.
 */
function followPointer(canvas) {
  if (!ambientPointer.seen) {
    return;
  }
  const area = canvas.getBoundingClientRect();
  ambientPointer.x = ambientPointer.clientX - area.left;
  ambientPointer.y = ambientPointer.clientY - area.top;
}

/**
 * Moves one mark of the line standing at x a step toward its warmth: 1
 * under the pointer, falling to 0 at POINTER_REACH (with the square of the
 * distance, so only the nearest marks swell much), and 0 when the pointer is
 * away. A step is POINTER_EASE of what is left, so a mark swells and eases
 * back softly. Returns whether the mark is still on its way (so the next
 * frame should come soon).
 *
 * Complexity: O(1).
 */
function warmMark(point, x) {
  let warmth = 0;
  if (ambientPointer.seen) {
    const distance = Math.hypot(x - ambientPointer.x, point.y - ambientPointer.y);
    if (distance < POINTER_REACH) {
      const nearness = 1 - distance / POINTER_REACH;
      warmth = nearness * nearness;
    }
  }
  const step = (warmth - point.glow) * POINTER_EASE;
  point.glow += step;
  return Math.abs(step) > 0.002;
}

/**
 * Fills one line: an oval for each of its marks that is large enough, as
 * big, as leaning and as far aside as the fields make it at this time, and
 * a little bigger where the pointer warmed it. All at the line's opacity.
 *
 * Complexity: O(m).
 */
function fillLine(context, line, time) {
  context.beginPath();
  for (const point of line.points) {
    const mark = markAt(line.x, point.y, time);
    const size = Math.min(1, mark.size + point.glow * POINTER_SWELL);
    if (size < MARK_GONE) {
      continue;
    }
    const x = line.x + swayAt(line.x, point.y, time).dx;
    const halfWidth = MARK_DOT + MARK_WIDTH * size;
    const halfLength = MARK_DOT + MARK_LENGTH * size;
    // An oval's outline starts at the end of its first radius: starting the
    // path there keeps each mark apart from the one before.
    context.moveTo(x + halfWidth * Math.cos(mark.lean), point.y + halfWidth * Math.sin(mark.lean));
    context.ellipse(x, point.y, halfWidth, halfLength, mark.lean, 0, Math.PI * 2);
  }
  context.globalAlpha = line.alpha;
  context.fill();
}
