/*
 * ambient.js - the faint dotted lines that drift in the margins beside the
 * writing column, so the inside of the app feels as calm as the lock screen.
 *
 * A canvas (#ambient-lines) lies over the whole writing area, under the
 * editor and the sheets. Each side gets ten short horizontal dotted lines,
 * spread down the height. Every line has its own slow drift outward, its own
 * dot spacing and faintness, and fades from the outer edge toward the text,
 * so the text stays the brightest thing on screen. Nothing is drawn in a
 * margin under 72px (a narrow window, the second screen), nothing runs while
 * the app is locked or the tab is hidden, and when the system asks for
 * reduced motion one still frame is drawn instead of an animation.
 *
 * Main functions: startAmbientLines, stopAmbientLines, drawAmbientFrame.
 * Auxiliary functions: scheduleFrame, resizeCanvas, writingMargins, makeLines.
 *
 * Complexity: each frame draws O(l * g / d) dots (l lines, g the margin
 * width, d the dot spacing), about 300 tiny rectangles in a wide window, at
 * most 30 times a second.
 */
"use strict";

// Ten lines a side, as in the approved mockup.
const LINES_PER_SIDE = 10;

// A margin narrower than this gets no lines: they would crowd the text.
const MIN_MARGIN = 72;

// The space kept clear between the last dot and the text column.
const TEXT_CLEARANCE = 12;

// At most 30 frames a second: smooth for something this slow, and half the work of 60.
const FRAME_MS = 1000 / 30;

// One entry per line (see makeLines), made on the first start.
let ambientLines = [];

// True from unlocking until locking.
let ambientRunning = false;

// The pending requestAnimationFrame id, 0 when none is pending.
let ambientFrame = 0;

// When the last frame was drawn, in requestAnimationFrame time.
let ambientLastDraw = 0;

// ---------- Starting and stopping ----------

/**
 * Starts the side lines when the app opens: the animation, or one still
 * frame when the system asks for reduced motion.
 *
 * Used by: lock.js (unlocking, and opening a backup), this file (when the
 * reduced-motion setting changes).
 * Uses: makeLines, drawAmbientFrame, scheduleFrame, stillMotion (lock.js).
 * Complexity: O(l) the first time, to make the lines; O(1) after that.
 */
function startAmbientLines() {
  if (!ambientLines.length) {
    ambientLines = makeLines();
  }
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
 * Draws one frame at a time in milliseconds: for each line, a row of dots
 * shifted outward by its speed, each dot fainter the closer it is to the
 * text (its opacity falls with the square of the distance from the outer
 * edge), with a 1.5px vertical sway so the rows never look ruled. A side is
 * skipped when its margin is under MIN_MARGIN.
 *
 * Used by: this file (the frame loop, the still frame, resizing).
 * Uses: resizeCanvas, writingMargins.
 * Complexity: O(l * g / d) dots, see the header.
 */
function drawAmbientFrame(time) {
  const canvas = $("ambient-lines");
  const context = canvas.getContext("2d");
  const { width, height } = resizeCanvas(canvas, context);
  const margins = writingMargins(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fff";

  for (const line of ambientLines) {
    const margin = line.side < 0 ? margins.left : margins.right;
    if (margin < MIN_MARGIN) {
      continue;
    }
    const reach = margin - TEXT_CLEARANCE;
    const offset = line.gap - ((time / 1000 * line.speed + line.phase) % line.gap);
    const rowY = 20 + line.row * (height - 40) / (LINES_PER_SIDE - 1) + line.jitter;
    const y = rowY + Math.sin(time / 5000 + line.phase) * 1.5;

    for (let x = offset - line.gap; x < reach; x += line.gap) {
      const fade = 1 - Math.max(0, x) / reach;
      context.globalAlpha = line.alpha * fade * fade;
      context.fillRect(line.side < 0 ? x : width - x - line.length, y, line.length, 1.2);
    }
  }
  context.globalAlpha = 1;
}

// ---------- On load: pausing, resizing, reduced motion ----------

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
 * density, so the dots stay sharp, and returns that size in CSS pixels.
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
 * Makes the lines, each with its own look: a row (spread evenly down the
 * height, give or take 8px), a speed of 2.5 to 7.5 px/s, a dot spacing of 6
 * to 12px, a dot length of 1.5 to 5px, an opacity of 0.06 to 0.16 at the
 * outer edge, and a phase so they never move in step.
 *
 * Complexity: O(l).
 */
function makeLines() {
  const lines = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < LINES_PER_SIDE; row++) {
      lines.push({
        side,
        row,
        jitter: (Math.random() - 0.5) * 16,
        speed: 2.5 + Math.random() * 5,
        gap: 6 + Math.random() * 6,
        length: 1.5 + Math.random() * 3.5,
        alpha: 0.06 + Math.random() * 0.1,
        phase: Math.random() * 100,
      });
    }
  }
  return lines;
}
