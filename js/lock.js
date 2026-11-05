// notes: The lock screen: password strength, unlocking and its background.
"use strict";

// ---------- Password strength (first run only) ----------
// A rough entropy estimate, turned into a crack time with the same model as
// HOW-IT-WORKS.md section 7: every guess costs one PBKDF2 run of ITER
// iterations (2 SHA-256 compressions each), against an attacker with 1,000 GPUs
// doing ~2e10 compressions per second each, who on average searches half the
// space. Deliberately approximate: it is a nudge, not an audit.
const COMMON_PW = ["password", "passw0rd", "123456", "12345678", "123456789", "qwerty", "qwertyuiop", "letmein",
  "admin", "welcome", "iloveyou", "monkey", "dragon", "football", "baseball", "abc123", "111111", "sunshine",
  "princess", "master", "shadow", "superman", "trustno1", "contraseña", "contrasena", "secret", "notes"];
function estimateBits(pw) {
  if (!pw) return 0;
  // So first the character pool the password actually draws from.
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  // Effective length: a repeated character or a step (aa, ab, 12, ba) adds a quarter of a character, not one.
  let eff = 1;
  for (let i = 1; i < pw.length; i++) {
    const step = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
    eff += (step >= -1 && step <= 1) ? 0.25 : 1;
  }
  let bits = eff * Math.log2(pool);
  // A list password, alone or with digits/symbols around it ("Password1!"), is one guess from a short list.
  const lower = pw.toLowerCase();
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (COMMON_PW.includes(lower) || COMMON_PW.includes(core)) bits = Math.min(bits, 8 + (pw.length - core.length) * 3.3);
  // One word plus a short suffix: a ~100k-word dictionary (~17 bits), a capital, and ~3.3 bits per suffix character.
  else if (core.length >= 3 && core.length <= 12 && /^[a-zA-Z]+[^a-zA-Z]{0,6}$/.test(pw))
    bits = Math.min(bits, 17 + (/[A-Z]/.test(pw) ? 1 : 0) + (pw.length - core.length) * 3.3);
  // Leetspeak barely helps ("tr0ub4dor" is "troubador" to a cracker): undo the usual swaps first.
  const LEET = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
  const plain = lower.replace(/[013457@$!]/g, c => LEET[c]);
  // A swapped list password ("P@ssw0rd2024") is still a list password. The padding is cut off BEFORE
  // undoing the swaps, so a trailing "2024" or "!" is treated as padding and not read as letters.
  const plainCore = lower.replace(/^[^a-z]+|[^a-z]+$/g, "").replace(/[013457@$!]/g, c => LEET[c]);
  if (COMMON_PW.includes(plainCore)) bits = Math.min(bits, 9 + (pw.length - plainCore.length) * 3.3);
  // A run of 6+ letters after the swaps counts as one dictionary word (~17 bits, +1 for the swaps, +1 for a
  // capital, ~4.5 bits for each other character) when it looks like a word:
  for (const m of plain.matchAll(/[a-z]{6,}/g)) {
    // The run as typed, so its own vowels and capitals can be checked.
    const typed = pw.slice(m.index, m.index + m[0].length);
    // Real words have vowels: either typed ("tr0ub4dor") ...
    const typedVowels = (typed.toLowerCase().match(/[aeiou]/g) || []).length;
    // ... or only appearing once the swaps are undone ("dr4g0nfly").
    const plainVowels = (m[0].match(/[aeiou]/g) || []).length;
    // The second case also needs no capital after the first letter: a random string like "xR4!nq8Zk2",
    // whose swaps happen to spell "xrainq", mixes case mid-run, so it keeps its full random-string score.
    // ponytail: two-rule heuristic, not a dictionary; random all-lowercase strings can still undershoot,
    // which errs on the safe side (the meter says weaker, never stronger).
    if (typedVowels >= 2 || (plainVowels >= 2 && !/[A-Z]/.test(typed.slice(1)))) {
      bits = Math.min(bits, 17 + (plain !== lower ? 1 : 0) + (/[A-Z]/.test(pw) ? 1 : 0) + (pw.length - m[0].length) * 4.5);
    }
  }
  // Several words separated by spaces or dashes count as words from a 7,776-word list (12.9 bits each).
  const parts = pw.trim().split(/[\s\-_.]+/);
  if (parts.length >= 3 && parts.every(w => /^[a-zA-Z]{2,}$/.test(w))) bits = Math.min(bits, parts.length * 12.9);
  return bits;
}
function crackSeconds(bits) {
  // SHA-256 compressions per guess: two per PBKDF2 iteration.
  const perGuess = 2 * ITER;
  // 1,000 GPUs at ~2e10 compressions per second each.
  const guessesPerSec = 1000 * 2e10 / perGuess;
  // Half the space on average.
  return Math.pow(2, bits - 1) / guessesPerSec;
}
function fmtCrack(sec) {
  // Two significant figures are plenty for an estimate this rough; en-US so the
  // decimal point matches the English sentence instead of the browser's locale.
  const r = x => Number(x.toPrecision(2)).toLocaleString("en-US");
  if (sec < 60) return `${r(Math.max(sec, 1))} seconds`;
  if (sec < 3600) return `${r(sec / 60)} minutes`;
  if (sec < 86400) return `${r(sec / 3600)} hours`;
  const years = sec / (365.25 * 86400);
  if (years < 1) return `${r(sec / 86400)} days`;
  if (years < 1e6) return `${r(years)} years`;
  if (years < 1e9) return `${r(years / 1e6)} million years`;
  if (years < 1e12) return `${r(years / 1e9)} billion years`;
  return "far longer than the age of the universe";
}
function renderPwMeter() {
  const box = $("pw-meter"), pw = $("password").value;
  // So first: the meter only matters while creating a vault, and an empty field shows nothing.
  if ($("token-row").style.display !== "flex" || !pw) { box.className = ""; box.style.display = "none"; return; }
  const bits = estimateBits(pw);
  // Five bands by entropy; the class colours the bar and the label.
  let level = "vweak", label = "Very weak";
  if (bits >= 75) { level = "vstrong"; label = "Very strong"; }
  else if (bits >= 60) { level = "strong"; label = "Strong"; }
  else if (bits >= 50) { level = "fair"; label = "Fair"; }
  else if (bits >= 36) { level = "weak"; label = "Weak"; }
  box.className = level;
  box.style.display = "block";
  // The bar fills to 100% at 90 bits.
  box.querySelector(".pw-fill").style.width = Math.min(100, Math.max(6, bits / 90 * 100)) + "%";
  box.querySelector(".pw-label").textContent = label;
  const sec = crackSeconds(bits);
  const t = fmtCrack(sec);
  // Three phrasings so the sentence always reads right: almost instantly, beyond the universe's age, or "in about <time>".
  let line = `1,000 GPUs would crack it in about ${t} (rough estimate).`;
  if (sec < 1) line = "1,000 GPUs would crack it almost instantly (rough estimate).";
  else if (t.startsWith("far longer")) line = "1,000 GPUs would need far longer than the age of the universe (rough estimate).";
  box.querySelector(".pw-time").textContent = line;
}
$("password").addEventListener("input", renderPwMeter);

// ---------- Unlock ----------
// The vault the form opens: the old top-level one comes in through index.html's
// own <script>; a vault in a folder is loaded from its folder below.
let autoVault = vaultSel && !vaultSel.dir ? legacyBlob : null;
// No vault on this device at all yet: the form starts by making one.
let creatingVault = !vaultSel && !Object.keys(knownVaults()).length;
// The restore picker stays available even when a local vault exists: hiding it
// made a corrupted localStorage vault unrecoverable (correct password, no way
// in) and left the Backup button's own output unrestorable on the machine most
// likely to need it. It lives under "Other vault" now, as "From a file...".
// What the lock screen is for: unlocking this device's copy of the selected
// vault, unlocking a synced one found in its folder (a fresh clone), making a
// new one, or - with nothing to open - picking one.
function setLockMode() {
  const mode = creatingVault ? "new" : !vaultSel ? "none"
    : localStorage.getItem(vkey("vault")) ? "unlock" : autoVault ? "found" : "missing";
  $("unlock-form").dataset.mode = mode;
  $("token-row").style.display = mode === "new" ? "flex" : "none";
  $("new-vault").setAttribute("aria-pressed", creatingVault ? "true" : "false");
  renderVaultLine();
  renderPwMeter();
  syncUnlockLabel();
}
// "Vault selected: Main - 4 Nov 2026, 19:14". The name is the user's own: never translated.
function renderVaultLine() {
  const el = $("vault-line");
  el.textContent = "";
  if (creatingVault) { el.textContent = "New vault"; return; }
  if (!vaultSel) { el.textContent = "No vault selected"; return; }
  const at = Math.max((knownVaults()[vaultSel.name] || {}).at || 0, +window.__VAULT_AT__ || 0);
  const nm = mk("span", "vn", vaultSel.name);
  nm.setAttribute("translate", "no");
  el.append("Vault selected:", " ", nm);
  if (at) el.append(" - " + fmtWhen(at));
}
// The button says what pressing it will do.
function syncUnlockLabel() {
  const label = $("unlock-label");
  if (!label) return;
  const mode = $("unlock-form").dataset.mode;
  const fromFile = $("restore-box").style.display !== "none" && $("vault-file").files.length > 0;
  const creating = mode === "new" && !pendingBackupKind;
  if (attemptBusy) label.textContent = pendingBackupKind ? "Opening backup..." : creating ? "Creating vault..." : "Unlocking...";
  else label.textContent = pendingBackupKind ? `Open ${pendingBackupKind} backup` : creating ? "Create vault" :
    fromFile ? "Restore and unlock" : "Unlock";
}
// "Other vault": the vaults next to index.html (looked up in the app folder,
// which asks for access the first time) and the ones this device knows, each
// with when it last changed, plus restoring one from a file. Picking a vault
// reloads the page with it selected.
function renderVaultList() {
  const box = $("vault-list"), vs = knownVaults();
  box.textContent = "";
  const names = Object.keys(vs).filter(n => !(vaultSel && n === vaultSel.name))
    .sort((a, b) => (vs[b].at || 0) - (vs[a].at || 0));
  for (const n of names) {
    const b = mk("button", "vault-pick");
    b.type = "button";
    const nm = mk("span", "vp-name", n);
    nm.setAttribute("translate", "no");
    b.append(nm, mk("span", "vp-at", vs[n].at ? fmtWhen(vs[n].at) : ""));
    b.onclick = () => { selectVault(n, vs[n].dir); location.reload(); };
    box.appendChild(b);
  }
  if (!names.length) box.appendChild(mk("small", null, "No other vaults found next to index.html."));
  const f = mk("button", "vault-file-btn", "From a file...");
  f.type = "button";
  f.onclick = () => {
    const r = $("restore-box"), open = r.style.display !== "none";
    r.style.display = open ? "none" : "flex";
    if (open) { $("vault-file").value = ""; showFileName(); }
    syncUnlockLabel();
  };
  box.appendChild(f);
}
$("other-vault").onclick = async () => {
  const box = $("vault-list"), open = box.style.display !== "none";
  box.style.display = open ? "none" : "flex";
  $("other-vault").setAttribute("aria-expanded", open ? "false" : "true");
  if (open) return;
  if (creatingVault) { creatingVault = false; setLockMode(); }
  renderVaultList();                            // what this device knows, at once
  if (await scanVaults()) renderVaultList();    // and what the app folder holds
};
$("new-vault").onclick = () => {
  creatingVault = !creatingVault;
  $("vault-list").style.display = "none";
  $("other-vault").setAttribute("aria-expanded", "false");
  setLockMode();
  if (creatingVault) $("vault-name").focus();
};
// The hidden file input behind "Choose file", and the chosen file's name beside
// it. A file's name is the user's own: never translated.
$("file-pick").onclick = () => $("vault-file").click();
function showFileName() {
  const f = $("vault-file").files[0], el = $("file-name");
  if (f) el.setAttribute("translate", "no"); else el.removeAttribute("translate");
  el.textContent = f ? f.name : "No file chosen";
}
$("vault-file").addEventListener("change", () => {
  showFileName();
  // A file with no vault to restore it into becomes a new vault, named on the form.
  if ($("vault-file").files.length && !vaultSel && !creatingVault) { creatingVault = true; setLockMode(); }
  syncUnlockLabel();
});
// The language, at the top centre: picking one reloads the page in it.
for (const [code, name] of Object.entries(LANGS)) $("lang").add(new Option(name, code, code === LANG, code === LANG));
$("lang").onchange = () => { localStorage.setItem("lang", $("lang").value); location.reload(); };
$("lock-version").textContent = "v" + APP_VERSION;
setLockMode();
// A vault in a folder: its vault.enc.js and backups, by <script> because a page
// opened from a file may load scripts beside it but not fetch them. Missing
// files just fail quietly, like the top-level ones in index.html.
const loadScript = src => new Promise(res => {
  const el = document.createElement("script");
  el.src = src;
  el.onload = el.onerror = () => { el.remove(); res(); };
  document.body.appendChild(el);
});
if (vaultSel && vaultSel.dir) {
  window.__VAULT__ = window.__VAULT_AT__ = undefined;
  for (const k of Object.values(BACKUP_KINDS)) window[k.varName] = undefined;
  const d = encodeURIComponent(vaultSel.dir) + "/";
  Promise.all([loadScript(d + WRAPPER), ...Object.values(BACKUP_KINDS).map(k => loadScript(d + k.file))]).then(() => {
    autoVault = window.__VAULT__ && typeof window.__VAULT__ === "object" ? JSON.stringify(window.__VAULT__) : null;
    setLockMode();
    refreshLockBackupRow();
  });
}
// A wrong guess costs one of the ten attempts: say when Caps Lock is on.
for (const id of ["password", "password2"]) {
  const caps = e => { $("caps-msg").hidden = !(e.getModifierState && e.getModifierState("CapsLock")); };
  $(id).addEventListener("keydown", caps);
  $(id).addEventListener("keyup", caps);
  $(id).addEventListener("blur", () => { $("caps-msg").hidden = true; });
}
// ---------- Lock screen background ----------
// A video of your own behind the lock screen, when lock-background.mp4 or
// lock-background.webm sits next to index.html: the app never syncs it (git can
// carry it in your own private repo; the public mirror's .gitignore refuses it)
// and it is only a picture, so it can run no code. It plays only while the lock
// screen shows, muted, and stays on its first frame if the system asks for
// reduced motion.
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");
function syncLockBg() {
  const v = $("lock-bg");
  if (!v || !$("lock").classList.contains("has-bg")) return;
  if ($("lock").style.display !== "none" && !stillMotion.matches) v.play().catch(() => {});
  else v.pause();
}
function showLockBg() { $("lock").classList.add("has-bg"); syncLockBg(); }
// The file the lock screen found and shows, or null: for its line in Settings.
function lockBgFile() {
  if (!$("lock").classList.contains("has-bg")) return null;
  return decodeURIComponent(($("lock-bg").currentSrc || "").split("/").pop()) || null;
}
$("lock-bg").addEventListener("loadeddata", showLockBg);
// A local file can finish loading before this script runs, and then the event is already gone.
if ($("lock-bg").readyState >= 2) showLockBg();
// One shake of the card for a wrong password.
function shakeLock() {
  const f = $("unlock-form");
  f.classList.remove("shake");
  void f.offsetWidth;   // restart the animation
  f.classList.add("shake");
  setTimeout(() => f.classList.remove("shake"), 500);
}

$("unlock-form").onsubmit = async e => {
  e.preventDefault();
  if (attemptBusy) return;
  const lockMsg = (t, err) => {
    $("lock-msg").style.color = err ? "var(--bad)" : "var(--t3)";
    $("lock-msg").textContent = t;
  };
  const mode = $("unlock-form").dataset.mode;
  if (mode === "none" || mode === "missing") return;
  // A new vault needs a name that can be its folder; checked before anything else, as no attempt is spent on it.
  const creating = mode === "new" && !pendingBackupKind;
  const newName = creating ? $("vault-name").value.trim() : "";
  if (creating) {
    const why = vaultNameProblem(newName);
    if (why) { lockMsg(why, true); $("vault-name").focus(); return; }
  }
  // Folder access needs this very click, so it is asked for before anything is
  // awaited: the app folder for a new vault (its folder is made there), and
  // permission to keep writing an existing vault's folder otherwise.
  const appDir = creating ? notesDirHandle() : (vaultSel && vaultSel.dir ? askAppDirAccess() : null);
  // Re-read both stores on EVERY attempt: another copy of this page may have
  // burned attempts (or triggered the lockout) since this one loaded.
  await loadGuard();
  renderGuard();
  if (isLockedOut()) return;
  const pw = $("password").value;
  if (!pw) return;
  const stored = creating ? null : localStorage.getItem(vkey("vault"));
  let restored = false;
  // Only a genuine decrypt failure burns an attempt; a first-run validation
  // slip (mismatched confirm, missing token) must not.
  let decrypted = false, refocus = false;
  attemptBusy = true;
  renderGuard();                 // freezes the form; the button shows the attempt running
  lockMsg("", false);
  await new Promise(r => setTimeout(r, ATTEMPT_DELAY_MS));
  try {
    // ---- Backup view: open the CHOSEN backup blob read-only. No persist, no
    // housekeeping, no KDF upgrade, no sync - nothing may touch the real vault
    // or the repo until "Convert to the original file" is pressed.
    if (pendingBackupKind) {
      const w = backupWrapper(pendingBackupKind);
      if (!w) { lockMsg("Backup file not found next to index.html.", true); return; }
      ({ vault, key, salt, iter: iterUsed } = await openVault(w.data, pw));
      decrypted = true;
      await registerSuccess();
      await loadMediaKey();   // in-memory only: lets attachments decrypt for viewing
      masterPw = pw;
      $("password").value = ""; $("password2").value = ""; $("token").value = "";
      lockMsg("", true);
      $("lock").style.display = "none";
      syncLockBg();
      $("app").style.display = "flex";
      dirty = false;
      enterBackupView(pendingBackupKind, w.at);
      renderList();
      renderStatus();
      renderAttachments();
      status("Viewing backup - read-only");
      return;
    }
    // Every unlock-path write below is stamp=false: savedAt must never move
    // here or a stale/restored vault would look newest and win the next sync.
    let needPersist = false;
    // An explicitly picked file always wins over the local copy: that is the
    // whole point of "Restore from a file instead".
    const picked = $("vault-file").files[0];
    if (stored && !picked) {
      ({ vault, key, salt, iter: iterUsed } = await openVault(stored, pw));
      decrypted = true;
    } else {
      // Restore order: chosen vault file, then the vault.enc.js auto-loaded by
      // script tag from this folder, then ./vault.enc if the page is served
      // over http, then brand-new vault (needs a token).
      let blobText = null;
      const file = picked;
      if (file) blobText = await file.text();
      else if (creating) blobText = null;
      else if (autoVault) blobText = autoVault;
      else try {
        const r = await fetch(vpath(FILE));
        if (r.ok) blobText = await r.text();
      } catch {}
      if (blobText) {
        ({ vault, key, salt, iter: iterUsed } = await openVault(blobText, pw));
        decrypted = true;
        restored = true;
        // stamp=false: a restored clone may be stale; keeping its original
        // savedAt makes the first Sync pull the newer remote instead of
        // pushing old notes over it.
        needPersist = true;
      } else {
        if (!creating) { lockMsg("This vault's files were not found next to index.html.", true); return; }
        if (!$("token").value.trim()) {
          lockMsg("Paste a token (new vault) or pick your vault.enc (restore).", true);
          return;
        }
        // Creating a vault is the one irreversible moment: nothing can open it
        // again without this exact password.
        if ($("password2").value !== pw) {
          lockMsg("The two passwords do not match.", true);
          return;
        }
        if (pw.length < 8) {
          lockMsg("Use at least 8 characters: this password is the only key.", true);
          return;
        }
        salt = crypto.getRandomValues(new Uint8Array(16));
        key = await deriveKey(pw, salt, ITER);
        iterUsed = ITER;
        // Through migrateVault like every opened vault, so a brand-new one has
        // every map too: without pins, "Pin to top" threw until the next unlock.
        vault = migrateVault({ v: 2, token: $("token").value.trim(), savedAt: 0,
          notes: {}, folders: {}, trash: {}, purged: {} });
        decrypted = true;   // a brand-new vault is not a failed guess
        // stamp=false (savedAt stays 0): if a same-password remote already
        // exists, the first Sync must pull it, not push this empty vault over
        // it. The push path stamps savedAt itself when it actually pushes.
        needPersist = true;
      }
    }
    // A new vault (empty, or from the picked file) becomes the selected one, with
    // its own folder and media folder next to index.html - and nothing of the
    // vault this page had selected before.
    let noFolder = false;
    if (creating) {
      resetVaultState();
      selectVault(newName, newName);
      rememberVault(newName, newName, Date.now());   // shown as its date until the first save (savedAt stays 0 for Sync)
      const root = await appDir;
      try { await (await root.getDirectoryHandle(newName, { create: true })).getDirectoryHandle("media", { create: true }); }
      catch { noFolder = true; }
      needPersist = true;
    }
    // v2 housekeeping (openVault already migrated the vault shape in memory).
    if (prunePurged()) needPersist = true;
    if (autoPurgeTrash()) needPersist = true;
    // PBKDF2 upgrade: old blobs re-key to ITER iterations with a fresh 16-byte
    // salt. The outer blob keeps its {v:1, iter, salt, iv, data} shape; only
    // the iter value changes, so any copy of the app can still open it.
    if (iterUsed < ITER) {
      lockMsg("Upgrading encryption, one second...", false);
      await new Promise(r => setTimeout(r, 30));   // let the message paint
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(pw, salt, ITER);
      iterUsed = ITER;
      needPersist = true;
      // A pre-upgrade snapshot is a full copy of every note (and the token)
      // sealed at the weaker KDF. Keeping it would defeat the upgrade, so it
      // goes; the next merge writes a fresh one at the new strength.
      localStorage.removeItem(vkey("vault.prev"));
      localStorage.removeItem(vkey("vault.prevAt"));
    }
    // The media key lives inside the vault, so it must be imported after every
    // path above has settled on which vault object is live.
    await loadMediaKey();
    if (needPersist) await persistLocal(false);
    // The password lives in masterPw from here on (sync and snapshot restore
    // must decrypt blobs sealed under other salts/iters); drop both secrets
    // from the DOM (display:none does not remove a value from the document).
    masterPw = pw;
    $("password").value = "";
    $("password2").value = "";
    $("token").value = "";
    lockMsg("", true);
    $("lock").style.display = "none";
    syncLockBg();
    $("app").style.display = "flex";
    dirty = false;
    // Fresh open = everything folded: seed the collapse set with every folder id
    // so the whole tree renders collapsed, and fold the trash section too.
    collapsed = new Set(Object.keys(vault.folders));
    trashCollapsed = true;
    renderList();
    renderStatus();
    renderAttachments();
    renderBackupBar();
    await registerSuccess();   // a correct password wipes the attempt counter
    if (vaultSel) rememberVault(vaultSel.name, vaultSel.dir, vault.savedAt);
    creatingVault = false;
    status(creating && noFolder ? "Vault created in this browser only: without access to the app folder, its folder could not be made"
      : stored ? "Unlocked" : restored ? "Vault restored, press Sync to connect" : "Vault created, use Sync to push it", noFolder);
    // Fire-and-forget: each modal flow owns its own clicks. The old top-level
    // vault is offered its move into a folder first, then any overdue backup.
    (async () => { await offerVaultMove(); await promptDueBackups(); })();
  } catch {
    // Drop the typed password: a failed unlock is exactly when someone walks
    // away, and it would otherwise sit in a DOM input value indefinitely.
    // Validation early-returns above deliberately keep their fields (the user
    // is mid-flow and must retype otherwise).
    $("password").value = "";
    refocus = true;   // in finally: the field is still disabled here, and focus() would do nothing
    if (!decrypted) { await registerFailedAttempt(); shakeLock(); }
    if (isLockedOut()) { lockMsg("", true); return; }   // renderGuard owns the screen now
    const left = triesLeft();
    lockMsg(`Wrong password (or corrupted vault). ${left} attempt${left === 1 ? "" : "s"} remaining.`, true);
  } finally {
    attemptBusy = false;
    renderGuard();
    if (refocus && !isLockedOut()) $("password").focus();
  }
};
