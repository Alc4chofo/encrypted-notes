// notes: The attempt limit (brute-force guard).
"use strict";

// ---------- Brute-force guard ----------
// TEN tries, reset by any successful unlock; the tenth failure locks the vault
// for a month with no way back in. Enforced BEFORE the password is even tested.
//
// What this is and is not: the vault's real defence is that the ciphertext is
// useless without the password, and the only thing that slows an attacker who
// COPIES vault.enc elsewhere is the KDF cost (ITER below). This counter defeats
// the casual bypasses - clearing one store, opening a second copy of index.html
// - because it is written to two independent per-origin stores that a duplicate
// page in the same browser shares, and the most restrictive of them wins.
//
// It is deliberately NOT kept inside the vault: sealing needs the key, and at
// lockout time there is no key, so a locked-out state could never be written
// there. localStorage + IndexedDB are the only stores readable before auth.
const MAX_TRIES = 10;
const LOCK_MS = 30 * 864e5;        // "1 month"
const ATTEMPT_DELAY_MS = 3000;     // deliberate cost per attempt
const GUARD_LS = "authGuard", GUARD_IDB = "__authGuard__";
let guard = { fails: 0, lockedUntil: 0, seen: 0 };
let guardTimer = null, attemptBusy = false;

const numOr0 = x => (typeof x === "number" && isFinite(x) && x >= 0) ? x : 0;
function normGuard(g) {
  if (!g || typeof g !== "object") return null;
  return { fails: Math.min(numOr0(g.fails), MAX_TRIES), lockedUntil: numOr0(g.lockedUntil), seen: numOr0(g.seen) };
}
// Most restrictive wins, field by field: wiping ONE store cannot lower the
// count, and a duplicate page that only knows one store still gets the worst.
const worstGuard = (a, b) => !a ? b : !b ? a : {
  fails: Math.max(a.fails, b.fails),
  lockedUntil: Math.max(a.lockedUntil, b.lockedUntil),
  seen: Math.max(a.seen, b.seen),
};
async function loadGuard() {
  let g = null;
  try { g = worstGuard(g, normGuard(JSON.parse(localStorage.getItem(GUARD_LS)))); } catch {}
  try { const rec = await idbGet(GUARD_IDB); if (rec) g = worstGuard(g, normGuard(rec.bytes)); } catch {}
  guard = g || { fails: 0, lockedUntil: 0, seen: 0 };
  return guard;
}
async function saveGuard() {
  const now = Date.now();
  if (now > guard.seen) guard.seen = now;
  const copy = { ...guard };
  // Both stores, always: they are the redundancy. Failures are swallowed so a
  // full disk or a blocked store can never crash the lock screen.
  try { localStorage.setItem(GUARD_LS, JSON.stringify(copy)); } catch {}
  try { await idbPut(GUARD_IDB, copy); } catch {}
}
// Clock handling, honestly: a lockout is an absolute deadline, so a machine
// whose clock the attacker controls can jump PAST it. That buys 10 guesses per
// jump and is strictly slower than attacking a copied file offline, so it is
// not the weak link - the KDF cost is what matters there. What we can do
// cheaply: (1) stamp the deadline from the latest time ever observed, so
// setting the clock back before the tenth failure cannot shorten it, and
// (2) treat the clock jumping BACKWARDS while locked as tampering and keep the
// vault shut until it is consistent again.
const CLOCK_SKEW = 5 * 60000;
const guardNow = () => Math.max(Date.now(), guard.seen);
const clockTampered = () => guard.lockedUntil > 0 && Date.now() < guard.seen - CLOCK_SKEW;
const lockLeft = () => Math.max(0, guard.lockedUntil - Date.now());
const isLockedOut = () => lockLeft() > 0 || clockTampered();
const triesLeft = () => Math.max(0, MAX_TRIES - guard.fails);

function fmtLeft(ms) {
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${sec}s`;
  return m ? `${m}m ${sec}s` : `${sec}s`;
}
function renderGuard() {
  const box = $("guard-msg"), form = $("unlock-form");
  const locked = isLockedOut();
  box.classList.toggle("locked", locked);
  form.classList.toggle("locked-out", locked);
  form.classList.toggle("busy", attemptBusy && !locked);
  syncUnlockLabel();
  // Every control in the form goes dead while locked - and stays dead, because
  // renderGuard re-runs on a ticking timer.
  for (const el of form.querySelectorAll("input, button")) el.disabled = locked || attemptBusy;
  if (locked) {
    box.style.display = "block";
    box.innerHTML = "";
    box.appendChild(mk("div", "guard-title", "Vault locked"));
    box.appendChild(mk("div", null, lockLeft() > 0
      ? `${MAX_TRIES} incorrect attempts. This vault cannot be opened for ${fmtLeft(lockLeft())}.`
      : "The system clock moved backwards while this vault was locked. It stays locked until the clock is correct."));
    box.appendChild(mk("div", "guard-sub", "There is no way to shorten this."));
    if (!guardTimer) guardTimer = setInterval(renderGuard, 1000);
    return;
  }
  if (guardTimer) { clearInterval(guardTimer); guardTimer = null; }
  if (guard.fails > 0) {
    const left = triesLeft();
    box.style.display = "block";
    box.innerHTML = "";
    box.appendChild(mk("div", "guard-title", `${left} attempt${left === 1 ? "" : "s"} remaining`));
    box.appendChild(mk("div", null, left <= 3
      ? `After ${left} more incorrect attempt${left === 1 ? "" : "s"} the vault locks for 1 month.`
      : "The counter resets as soon as you unlock successfully."));
  } else box.style.display = "none";
}
// Counted ONLY for a real decrypt failure (see the unlock handler): a validation
// slip on the first-run form must never burn an attempt.
async function registerFailedAttempt() {
  guard.fails = Math.min(guard.fails + 1, MAX_TRIES);
  if (guard.fails >= MAX_TRIES) guard.lockedUntil = guardNow() + LOCK_MS;
  await saveGuard();
  renderGuard();
}
async function registerSuccess() {
  guard.fails = 0;
  guard.lockedUntil = 0;
  await saveGuard();
  renderGuard();
}
// Read once every script has loaded: the read is asynchronous and can finish
// between two scripts, and renderGuard uses the lock screen's code (lock.js).
document.addEventListener("DOMContentLoaded", () => loadGuard().then(renderGuard));
