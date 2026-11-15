/*
 * background.js - a moving picture of your own behind the note, as the lock
 * screen has one: videos named app-background-1, app-background-2 and so on
 * (.webm or .mp4) next to index.html, one picked at random each time the app
 * is unlocked.
 *
 * The videos are looked for once, when the page loads, by number: 1, then 2,
 * and so on until one is missing (at most 9). At each unlock one of those
 * found is picked at random, never the one shown the time before when there
 * are others, and plays, muted and looping, behind the whole note area
 * (#app-bg in #main). The note then sits on a panel with an outline (css:
 * #main.has-bg), dark enough to read on and clear enough for the picture to
 * show through. Without any such video nothing changes.
 *
 * Like the lock screen's video: the app never syncs these files or sends
 * them anywhere (git can carry them in your own private repository), a
 * video is only a picture and runs no code, it is paused while the tab is
 * hidden, and it stays on one frame when the system asks for reduced motion.
 * Locking stops it and lets it go.
 *
 * Main functions: findAppBackgrounds, pickAppBackground, showAppBackground,
 * hideAppBackground, syncAppBackground.
 * Auxiliary functions: videoExists.
 *
 * Complexity: finding them is one small read per video (its header only);
 * picking is O(n) in the videos found. Playing costs what the browser's
 * video decoder costs, as on the lock screen.
 */
"use strict";

// The most numbered videos looked for (app-background-1 up to this), and the
// kinds tried for each number, in this order.
const APP_BACKGROUND_LIMIT = 9;
const APP_BACKGROUND_KINDS = ["webm", "mp4"];

// The videos found next to index.html, in number order (filled by findAppBackgrounds).
const appBackgrounds = [];

// The search under way or done, so it runs once.
let appBackgroundSearch = null;

// The video showing now, or shown last: the next pick is another one.
let appBackgroundShown = null;

// Ends the wait for a video that is still loading (see showAppBackground), when the app locks first.
let endBackgroundWait = null;

// ---------- Finding and picking ----------

/**
 * Looks for the background videos next to index.html, once: number 1, then
 * 2, and so on, stopping at the first number with no video (so they must be
 * numbered without a gap). Returns the list, also kept in appBackgrounds.
 *
 * Used by: this file (on load, showAppBackground).
 * Uses: videoExists.
 * Complexity: one header read per video found, and two failed reads at the
 * end (they show as "not found" lines in the console, like any missing file).
 */
function findAppBackgrounds() {
  if (!appBackgroundSearch) {
    appBackgroundSearch = (async () => {
      for (let number = 1; number <= APP_BACKGROUND_LIMIT; number++) {
        let found = null;
        for (const kind of APP_BACKGROUND_KINDS) {
          const file = `app-background-${number}.${kind}`;
          if (await videoExists(file)) {
            found = file;
            break;
          }
        }
        if (!found) {
          break;
        }
        appBackgrounds.push(found);
      }
      return appBackgrounds;
    })();
  }
  return appBackgroundSearch;
}

/**
 * Picks one of the videos found, at random: any of them but the one shown
 * the time before (when there is only one, that one). null when there are
 * none.
 *
 * Used by: this file (showAppBackground).
 * Uses: nothing.
 * Complexity: O(n) in the videos found.
 */
function pickAppBackground() {
  const others = appBackgrounds.filter(file => file !== appBackgroundShown);
  const choices = others.length ? others : appBackgrounds;
  return choices.length ? choices[Math.floor(Math.random() * choices.length)] : null;
}

// ---------- Showing and hiding ----------

/**
 * Shows a background behind the note when the app opens: picks a video,
 * loads it, and once it has a picture marks the note area (has-bg, which
 * fades the video in and gives the note its panel) and starts it. Returns
 * whether one is showing. It gives up quietly when there is no video, when
 * the one picked cannot be played, or when the app was locked again
 * meanwhile.
 *
 * Used by: lock.js (unlocking, and opening a backup).
 * Uses: findAppBackgrounds, pickAppBackground, syncAppBackground.
 * Complexity: O(n) to pick, plus loading the start of one video.
 */
async function showAppBackground() {
  await findAppBackgrounds();
  const file = pickAppBackground();
  const video = $("app-bg");
  if (!file || $("app").style.display === "none") {
    return false;
  }
  appBackgroundShown = file;
  video.src = file;
  const loaded = await new Promise(resolve => {
    endBackgroundWait = resolve;
    video.onloadeddata = () => resolve(true);
    video.onerror = () => resolve(false);
  });
  endBackgroundWait = null;
  if (!loaded || $("app").style.display === "none") {
    return false;
  }
  $("main").classList.add("has-bg");
  syncAppBackground();
  return true;
}

/**
 * Takes the background away when the app locks: a video still loading is
 * given up, the note area loses its panel, and the video is stopped and let
 * go, so nothing of it stays in memory behind the lock screen.
 *
 * Used by: settings.js (lockApp).
 * Uses: nothing.
 * Complexity: O(1).
 */
function hideAppBackground() {
  const video = $("app-bg");
  if (endBackgroundWait) {
    endBackgroundWait(false);
  }
  $("main").classList.remove("has-bg");
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/**
 * Plays the background while it shows, the tab is visible and the system
 * does not ask for reduced motion, and pauses it otherwise (it then stays
 * on the frame it had).
 *
 * Used by: this file (showAppBackground, and on load: when the tab is hidden
 * or shown, when the reduced-motion setting changes).
 * Uses: stillMotion (lock.js).
 * Complexity: O(1).
 */
function syncAppBackground() {
  const video = $("app-bg");
  if (!$("main").classList.contains("has-bg")) {
    return;
  }
  if (!document.hidden && !stillMotion.matches) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

// ---------- On load ----------

// Looked for straight away, so the list is ready by the time the app is unlocked.
findAppBackgrounds();

document.addEventListener("visibilitychange", syncAppBackground);
stillMotion.addEventListener("change", syncAppBackground);

// =================== Auxiliary functions ===================

/**
 * Whether a video with this name sits next to index.html and can be played:
 * only its header is read, by a video element that is never shown.
 *
 * Complexity: O(1), one small read.
 */
function videoExists(file) {
  return new Promise(resolve => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.onloadedmetadata = () => {
      probe.removeAttribute("src");
      probe.load();
      resolve(true);
    };
    probe.onerror = () => resolve(false);
    probe.src = file;
  });
}
