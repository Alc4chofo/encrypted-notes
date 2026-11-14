/*
 * ambient.js - the thin vertical lines that sway in the margins beside the
 * writing column, like a curtain hanging in still air, so the inside of the
 * app feels as calm as the lock screen.
 *
 * A canvas (#ambient-lines) lies over the whole writing area, under the
 * editor and the sheets. Each margin gets a row of hairlines running from
 * top to bottom, brightest at the outer edge and fading to nothing beside
 * the text, so the text stays the brightest thing on screen. Two things move
 * them:
 *   - a slow sway. Every point of every line is carried a few pixels by a
 *     smooth noise field that drifts across the page, so neighbouring lines
 *     move together, like cloth, and nothing repeats or points anywhere;
 *   - the pointer. Moving it through a margin drags the lines near it a
 *     little, the way it is going; they swing back on a soft spring.
 * No lines are drawn in a margin under 72px (a narrow window, the second
 * screen), nothing runs while the app is locked or the tab is hidden, and
 * when the system asks for reduced motion one still frame is drawn instead.
 *
 * The idea (lines of points swayed by noise, dragged by the pointer and
 * sprung back) is the one in Antoine Wodniack's "Wavy Lines". This is
 * written from scratch for the margins, and much slower and fainter.
 *
 * Main functions: startAmbientLines, stopAmbientLines, drawAmbientFrame.
 * Auxiliary functions: scheduleFrame, resizeCanvas, writingMargins,
 * layoutLines, swayAt, smoothNoise, followPointer, pushPoint, strokeLine.
 *
 * Complexity: each frame is O(l * p), l lines of p points: about 36 lines of
 * 28 points in a wide window, at most 30 times a second.
 */
"use strict";

// A margin narrower than this gets no lines: they would crowd the text.
const MIN_MARGIN = 72;

// The space kept clear between the lines and the text column.
const TEXT_CLEARANCE = 12;

// The space between two neighbouring lines, and between two points of a line.
const LINE_GAP = 14;
const POINT_GAP = 28;

// The opacity of the outermost line; each line after it is fainter. This is
// the one number to change to make the lines fainter or stronger. On the
// near-black page 0.3 is a soft grey, far below the text's brightness.
const LINE_OPACITY = 0.3;

// The lines take the app's warm white (--t1 in base.css), not pure white.
const LINE_COLOUR = "#e9e5de";

// The sway: how far it carries a point sideways and along the line, how much
// the noise turns that direction, the size of the noise field's cells (400px
// by 555px, so a line bends only once or twice down its length) and how fast
// the field drifts, in px per millisecond. Together they move a point at
// most about 3px a second.
const SWAY_X = 9;
const SWAY_Y = 5;
const NOISE_TWIST = 6;
const NOISE_SCALE_X = 0.0025;
const NOISE_SCALE_Y = 0.0018;
const DRIFT_X = 0.012;
const DRIFT_Y = 0.005;

// The pointer: how near it must pass to move a point, how hard it drags, the
// most it can move one, and the spring that brings the point back (a low
// tension and a high friction: it returns in about a second and a half,
// without bouncing).
const POINTER_REACH = 140;
const POINTER_PULL = 0.014;
const MAX_PUSH = 28;
const SPRING_TENSION = 0.012;
const SPRING_FRICTION = 0.88;

// At most 30 frames a second: smooth for something this slow, and half the work of 60.
const FRAME_MS = 1000 / 30;

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

// The pointer: where it is in the window, then (worked out once a frame, see
// followPointer) where it is over the canvas, how fast it moves in px a
// frame, and which way.
const ambientPointer = { seen: false, clientX: 0, clientY: 0, x: 0, y: 0, speed: 0, angle: 0, placed: false };

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
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- Drawing ----------

/**
 * Draws one frame at a time in milliseconds. The lines are laid out again
 * when the writing area or its margins changed size; then every point is
 * moved by the pointer and its spring, and each line is drawn through its
 * points as they stand in the sway at that time. Drawing is clipped to the
 * margins, so no line ever crosses into the text. With reduced motion the
 * sway is frozen at time 0 and the pointer moves nothing.
 *
 * Used by: this file (the frame loop, the still frame, resizing).
 * Uses: resizeCanvas, writingMargins, layoutLines, followPointer, pushPoint,
 * strokeLine, stillMotion (lock.js).
 * Complexity: O(l * p), see the header.
 */
function drawAmbientFrame(time) {
  const canvas = $("ambient-lines");
  const context = canvas.getContext("2d");
  const { width, height } = resizeCanvas(canvas, context);
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

  context.clearRect(0, 0, width, height);
  context.save();
  context.beginPath();
  context.rect(0, 0, margins.left - TEXT_CLEARANCE, height);
  context.rect(width - margins.right + TEXT_CLEARANCE, 0, margins.right - TEXT_CLEARANCE, height);
  context.clip();
  context.strokeStyle = LINE_COLOUR;
  context.lineWidth = 1;

  for (const line of ambientLines) {
    if (!still) {
      for (const point of line.points) {
        pushPoint(point, line.x);
      }
    }
    strokeLine(context, line, still ? 0 : time);
  }
  context.restore();
}

// ---------- On load: the pointer, pausing, resizing, reduced motion ----------

// Only where the pointer is; what it does to the lines is worked out once a frame.
window.addEventListener("pointermove", event => {
  ambientPointer.seen = true;
  ambientPointer.clientX = event.clientX;
  ambientPointer.clientY = event.clientY;
}, { passive: true });

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
 * (30 a second), then asks again, for as long as the lines run and the tab
 * shows. A frame counts as due a little early (90% of FRAME_MS), since frame
 * times jitter and a 60 Hz screen would otherwise sometimes skip to 20 fps.
 *
 * Complexity: O(1), plus the frame it draws.
 */
function scheduleFrame() {
  ambientFrame = requestAnimationFrame(time => {
    ambientFrame = 0;
    if (!ambientRunning || document.hidden) {
      return;
    }
    if (time - ambientLastDraw >= FRAME_MS * 0.9) {
      ambientLastDraw = time;
      drawAmbientFrame(time);
    }
    scheduleFrame();
  });
}

/**
 * Matches the canvas's pixels to its size on screen and the screen's pixel
 * density, so the lines stay sharp, and returns that size in CSS pixels.
 *
 * Complexity: O(1); a resize clears the canvas.
 */
function resizeCanvas(canvas, context) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  return { width, height };
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
 * stopping short of the text by TEXT_CLEARANCE and the sway's reach. Each
 * line knows where it stands (x), how opaque it is (LINE_OPACITY at the
 * outer edge, falling evenly to nothing at the text; a line under 0.03 is
 * left out, it could not be seen) and its points, one every POINT_GAP from
 * above the top to below the bottom, each at rest on its spring.
 *
 * Complexity: O(l * p).
 */
function layoutLines(width, height, margins) {
  const lines = [];
  for (const side of [-1, 1]) {
    const margin = side < 0 ? margins.left : margins.right;
    if (margin < MIN_MARGIN) {
      continue;
    }
    const reach = margin - TEXT_CLEARANCE - SWAY_X;

    for (let distance = LINE_GAP / 2; distance < reach; distance += LINE_GAP) {
      const alpha = LINE_OPACITY * (1 - distance / reach);
      if (alpha < 0.03) {
        break;
      }
      const points = [];
      for (let y = -POINT_GAP; y <= height + POINT_GAP; y += POINT_GAP) {
        points.push({ y, pushX: 0, pushY: 0, speedX: 0, speedY: 0 });
      }
      lines.push({ x: side < 0 ? distance : width - distance, alpha, points });
    }
  }
  return lines;
}

/**
 * How far the sway carries the point at rest at (x, y), at a time in
 * milliseconds: { dx, dy }. The noise field gives a slowly changing angle
 * for that place, and the point sits that way on a flat ellipse (SWAY_X wide,
 * SWAY_Y tall) around its place, so it wanders without ever leaving it.
 *
 * Complexity: O(1).
 */
function swayAt(x, y, time) {
  const angle = NOISE_TWIST * smoothNoise((x + time * DRIFT_X) * NOISE_SCALE_X, (y + time * DRIFT_Y) * NOISE_SCALE_Y);
  return { dx: Math.cos(angle) * SWAY_X, dy: Math.sin(angle) * SWAY_Y };
}

/**
 * Smooth noise: a height from -1 to 1 for any point of the plane, random
 * from cell to cell but changing smoothly in between (the four corners of a
 * cell, each with its own random height, blended with an ease at both ends).
 * It is what makes the sway look like air and not like a machine.
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
 * Works out, once a frame, where the pointer is over the canvas, how fast it
 * is going (px a frame, smoothed, at most 40) and which way. A pointer that
 * stopped slows to nothing within a few frames, so it stops dragging.
 *
 * Complexity: O(1); it reads layout the browser has already done.
 */
function followPointer(canvas) {
  const pointer = ambientPointer;
  if (!pointer.seen) {
    return;
  }
  const area = canvas.getBoundingClientRect();
  const x = pointer.clientX - area.left;
  const y = pointer.clientY - area.top;
  if (!pointer.placed) {
    pointer.placed = true;
    pointer.x = x;
    pointer.y = y;
  }
  const movedX = x - pointer.x;
  const movedY = y - pointer.y;
  const moved = Math.hypot(movedX, movedY);
  pointer.speed = Math.min(40, pointer.speed + (moved - pointer.speed) * 0.3);
  if (moved > 0) {
    pointer.angle = Math.atan2(movedY, movedX);
  }
  pointer.x = x;
  pointer.y = y;
}

/**
 * Moves one point of the line standing at x for one frame: a pointer moving
 * within POINTER_REACH drags it the way the pointer goes (harder the nearer
 * and the faster), its spring pulls it back toward rest, and friction slows
 * it, so it settles without bouncing. It never strays more than MAX_PUSH.
 *
 * Complexity: O(1).
 */
function pushPoint(point, x) {
  const pointer = ambientPointer;
  if (pointer.speed > 0.05) {
    const distance = Math.hypot(x - pointer.x, point.y - pointer.y);
    if (distance < POINTER_REACH) {
      const pull = (1 - distance / POINTER_REACH) * pointer.speed * POINTER_PULL;
      point.speedX += Math.cos(pointer.angle) * pull;
      point.speedY += Math.sin(pointer.angle) * pull;
    }
  }
  point.speedX = (point.speedX - point.pushX * SPRING_TENSION) * SPRING_FRICTION;
  point.speedY = (point.speedY - point.pushY * SPRING_TENSION) * SPRING_FRICTION;
  point.pushX = Math.max(-MAX_PUSH, Math.min(MAX_PUSH, point.pushX + point.speedX));
  point.pushY = Math.max(-MAX_PUSH, Math.min(MAX_PUSH, point.pushY + point.speedY));
}

/**
 * Draws one line as a smooth curve through its points, each where the sway
 * (at this time) and the pointer have carried it, at the line's opacity.
 *
 * Complexity: O(p).
 */
function strokeLine(context, line, time) {
  let lastX = 0;
  let lastY = 0;
  context.beginPath();
  line.points.forEach((point, index) => {
    const sway = swayAt(line.x, point.y, time);
    const x = line.x + sway.dx + point.pushX;
    const y = point.y + sway.dy + point.pushY;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      // A curve through the midpoints, so the line has no corners.
      context.quadraticCurveTo(lastX, lastY, (lastX + x) / 2, (lastY + y) / 2);
    }
    lastX = x;
    lastY = y;
  });
  context.lineTo(lastX, lastY);
  context.globalAlpha = line.alpha;
  context.stroke();
}
