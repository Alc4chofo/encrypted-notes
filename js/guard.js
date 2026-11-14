/*
 * guard.js - the attempt limit on the lock screen.
 *
 * Ten wrong passwords in a row lock the vault for 30 days, with no way to
 * shorten it. Any successful unlock resets the count. The check runs before
 * the password is even tried, and each attempt also waits a fixed 3 seconds
 * (lock.js uses ATTEMPT_DELAY_MS).
 *
 * What this protects, honestly: the vault's real defence is that its
 * ciphertext is useless without the password, and the only thing that slows
 * someone who copies vault.enc elsewhere is the cost of deriving the key
 * (PBKDF2_ITERATIONS in core.js). This counter stops the casual ways around a
 * limit on this device: it is written to two independent stores
 * (localStorage and IndexedDB), a second copy of index.html in the same
 * browser shares both, and the stricter of the two always wins. It cannot
 * live inside the vault: sealing needs the key, and a locked-out device has
 * none.
 *
 * Main functions: loadGuard, saveGuard, isLockedOut, triesLeft, renderGuard,
 * registerFailedAttempt, registerSuccess.
 * Auxiliary functions: normalizeGuard, strictestGuard, numberOrZero,
 * guardNow, clockTampered, lockLeft, formatTimeLeft.
 *
 * Complexity: everything here is O(1), apart from one IndexedDB read when the
 * page loads and one write after each attempt.
 */
"use strict";

// ---------- Limits and state ----------

const MAX_TRIES = 10;

// 30 days, "1 month" on the lock screen.
const LOCK_MS = 30 * 864e5;

// The fixed wait before every attempt, so guessing by hand is slow too.
const ATTEMPT_DELAY_MS = 3000;

// Where the counter is kept: a localStorage key and an IndexedDB record id.
const GUARD_STORAGE_KEY = "authGuard";
const GUARD_DB_KEY = "__authGuard__";

// fails: wrong attempts in a row. lockedUntil: when a lockout ends (0 for
// none). seen: the latest time this device ever observed, which keeps a
// clock moved backwards from shortening anything.
let guard = { fails: 0, lockedUntil: 0, seen: 0 };
let guardTimer = null;
let attemptBusy = false;

// Clock handling, honestly: a lockout is an absolute deadline, so someone who
// controls the machine's clock can jump past it. That buys 10 guesses per
// jump, still far slower than attacking a copied file offline, so it is not
// the weak link. What the guard does cheaply: (1) it stamps the deadline from
// the latest time ever observed, so setting the clock back before the tenth
// failure cannot shorten it, and (2) it treats the clock jumping backwards
// while locked as tampering and keeps the vault shut until the clock is
// consistent again. This much backwards drift is forgiven.
const CLOCK_SKEW = 5 * 60000;

// ---------- Reading and writing the counter ----------

/**
 * Reads the counter from both stores and keeps the stricter value of each
 * field, so wiping one store cannot lower the count.
 *
 * Used by: this file (once every script has loaded), lock.js (the unlock form
 * reads it again before each attempt, in case another copy of the page counted one).
 * Uses: normalizeGuard, strictestGuard, idbGet (vault.js).
 * Complexity: O(1), one IndexedDB read.
 */
async function loadGuard() {
  let stored = null;

  try {
    stored = strictestGuard(stored, normalizeGuard(JSON.parse(localStorage.getItem(GUARD_STORAGE_KEY))));
  } catch {}

  try {
    const record = await idbGet(GUARD_DB_KEY);
    if (record) {
      stored = strictestGuard(stored, normalizeGuard(record.bytes));
    }
  } catch {}

  guard = stored || { fails: 0, lockedUntil: 0, seen: 0 };
  return guard;
}

/**
 * Writes the counter to both stores, always both: they are the redundancy.
 * Failures are swallowed, so a full disk or a blocked store can never crash
 * the lock screen.
 *
 * Used by: registerFailedAttempt and registerSuccess, in this file.
 * Uses: idbPut (vault.js).
 * Complexity: O(1), one IndexedDB write.
 */
async function saveGuard() {
  const now = Date.now();
  if (now > guard.seen) {
    guard.seen = now;
  }
  const copy = { ...guard };

  try {
    localStorage.setItem(GUARD_STORAGE_KEY, JSON.stringify(copy));
  } catch {}

  try {
    await idbPut(GUARD_DB_KEY, copy);
  } catch {}
}

// ---------- The state of the limit ----------

/**
 * True while the vault may not be opened: a lockout is running, or the clock
 * went backwards during one.
 *
 * Used by: renderGuard in this file, lock.js (the unlock form refuses to try).
 * Uses: lockLeft, clockTampered.
 * Complexity: O(1).
 */
function isLockedOut() {
  return lockLeft() > 0 || clockTampered();
}

/**
 * How many wrong passwords are left before the lockout.
 *
 * Used by: renderGuard in this file, lock.js (the message after a wrong password).
 * Uses: nothing.
 * Complexity: O(1).
 */
function triesLeft() {
  return Math.max(0, MAX_TRIES - guard.fails);
}

/**
 * Shows the state of the limit under the unlock form. While locked out every
 * control in the form is disabled and the countdown ticks every second;
 * after a wrong password it says how many attempts are left.
 *
 * Used by: this file (after loading the counter, and its own ticking timer),
 * lock.js (around every attempt).
 * Uses: isLockedOut, lockLeft, triesLeft, formatTimeLeft, syncUnlockLabel
 * (lock.js), makeElement (sidebar.js).
 * Complexity: O(1).
 */
function renderGuard() {
  const box = $("guard-msg");
  const form = $("unlock-form");
  const locked = isLockedOut();

  box.classList.toggle("locked", locked);
  form.classList.toggle("locked-out", locked);
  form.classList.toggle("busy", attemptBusy && !locked);
  syncUnlockLabel();

  // Every control goes dead while locked, and stays dead, because this
  // function runs again on a ticking timer.
  for (const control of form.querySelectorAll("input, button")) {
    control.disabled = locked || attemptBusy;
  }

  if (locked) {
    box.style.display = "block";
    box.innerHTML = "";
    box.appendChild(makeElement("div", "guard-title", "Vault locked"));
    box.appendChild(makeElement("div", null, lockLeft() > 0
      ? `${MAX_TRIES} incorrect attempts. This vault cannot be opened for ${formatTimeLeft(lockLeft())}.`
      : "The system clock moved backwards while this vault was locked. It stays locked until the clock is correct."));
    box.appendChild(makeElement("div", "guard-sub", "There is no way to shorten this."));
    if (!guardTimer) {
      guardTimer = setInterval(renderGuard, 1000);
    }
    return;
  }

  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }

  if (guard.fails > 0) {
    const left = triesLeft();
    box.style.display = "block";
    box.innerHTML = "";
    box.appendChild(makeElement("div", "guard-title", `${left} attempt${left === 1 ? "" : "s"} remaining`));
    box.appendChild(makeElement("div", null, left <= 3
      ? `After ${left} more incorrect attempt${left === 1 ? "" : "s"} the vault locks for 1 month.`
      : "The counter resets as soon as you unlock successfully."));
  } else {
    box.style.display = "none";
  }
}

// ---------- After an attempt ----------

/**
 * Counts one wrong password. The tenth starts the 30-day lockout, timed from
 * the latest moment this device has ever seen. It is called only after a real
 * decryption failure, never for a slip on the new-vault form.
 *
 * Used by: lock.js (the unlock form).
 * Uses: guardNow, saveGuard, renderGuard.
 * Complexity: O(1), one IndexedDB write.
 */
async function registerFailedAttempt() {
  guard.fails = Math.min(guard.fails + 1, MAX_TRIES);
  if (guard.fails >= MAX_TRIES) {
    guard.lockedUntil = guardNow() + LOCK_MS;
  }
  await saveGuard();
  renderGuard();
}

/**
 * Clears the count and any lockout after a successful unlock.
 *
 * Used by: lock.js (the unlock form).
 * Uses: saveGuard, renderGuard.
 * Complexity: O(1), one IndexedDB write.
 */
async function registerSuccess() {
  guard.fails = 0;
  guard.lockedUntil = 0;
  await saveGuard();
  renderGuard();
}

// ---------- On load ----------

// Read once every script has loaded: the read is asynchronous and could
// finish between two scripts, and renderGuard uses the lock screen's code.
document.addEventListener("DOMContentLoaded", () => loadGuard().then(renderGuard));

// =================== Auxiliary functions ===================

/** A stored counter brought to a safe shape, or null when it is not one. Complexity: O(1). */
function normalizeGuard(stored) {
  if (!stored || typeof stored !== "object") {
    return null;
  }
  return {
    fails: Math.min(numberOrZero(stored.fails), MAX_TRIES),
    lockedUntil: numberOrZero(stored.lockedUntil),
    seen: numberOrZero(stored.seen),
  };
}

/**
 * The stricter of two counters, field by field: wiping one store cannot lower
 * the count, and a second page that knows only one store still gets the worst.
 * Complexity: O(1).
 */
function strictestGuard(a, b) {
  return !a ? b : !b ? a : {
    fails: Math.max(a.fails, b.fails),
    lockedUntil: Math.max(a.lockedUntil, b.lockedUntil),
    seen: Math.max(a.seen, b.seen),
  };
}

/** A non-negative finite number, or 0 for anything else. Complexity: O(1). */
function numberOrZero(value) {
  return (typeof value === "number" && isFinite(value) && value >= 0) ? value : 0;
}

/** Now, but never earlier than the latest time this device has seen. Complexity: O(1). */
function guardNow() {
  return Math.max(Date.now(), guard.seen);
}

/** True when the clock went backwards (beyond CLOCK_SKEW) during a lockout. Complexity: O(1). */
function clockTampered() {
  return guard.lockedUntil > 0 && Date.now() < guard.seen - CLOCK_SKEW;
}

/** Milliseconds left in the lockout, 0 when there is none. Complexity: O(1). */
function lockLeft() {
  return Math.max(0, guard.lockedUntil - Date.now());
}

/** A duration as "2d 4h 10m", "4h 10m 5s", "10m 5s" or "5s". Complexity: O(1). */
function formatTimeLeft(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds % 86400 / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;

  if (days) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
