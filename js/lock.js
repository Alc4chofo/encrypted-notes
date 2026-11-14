/*
 * lock.js - the lock screen: unlocking, making a vault, choosing another
 * one, the password-strength meter, and the background video.
 *
 * What happens to the password, step by step (all of it in the Unlock
 * handler at the end of this file):
 *   - Unlocking: openVault (core.js) derives the vault's key from the
 *     password with PBKDF2-SHA256, at the round count stored in the vault
 *     (1,200,000 now: about 0.6 s here, measured in Chrome 156), then
 *     decrypts it with AES-256-GCM (about 1 ms per 500 KB). A wrong password
 *     fails GCM's authentication check, which is how it is told apart. Every
 *     attempt also waits 3 seconds and counts against ten (guard.js); ten
 *     wrong ones lock the vault for 30 days.
 *   - Making a vault: a random 16-byte salt (crypto.getRandomValues), the
 *     key derived with PBKDF2 at 1,200,000 rounds, and the new vault sealed
 *     with AES-256-GCM by persistLocal.
 *   - An older vault (sealed with fewer rounds, such as the former 310,000,
 *     about 0.13 s) is re-keyed on unlock: a fresh salt, 1,200,000 rounds,
 *     sealed again; the pre-merge snapshot sealed at the weaker cost is
 *     deleted, since keeping it would defeat the upgrade.
 *   - Viewing a backup opens its sealed copy with the same password and
 *     writes nothing.
 *   - After unlocking, the password is kept in memory only (masterPassword),
 *     to open copies sealed under other salts (the repository's vault,
 *     snapshots), and the form's fields are emptied (hiding a field does not
 *     remove its value from the page).
 *
 * How long guessing takes: someone with a copy of vault.enc pays a full
 * PBKDF2 per guess (2 SHA-256 compressions per round, 2.4 million per
 * guess). The meter assumes 1,000 GPUs doing about 2e10 compressions a
 * second each, about 8.3 million guesses a second, searching half the space
 * on average: a 40-bit password falls in about 18 hours, 60 bits takes
 * about 2,200 years, 75 bits about 70 million years. On one ordinary
 * computer a guess costs about 0.6 s.
 *
 * Main functions: estimateBits, crackSeconds, renderPwMeter, setLockMode,
 * renderVaultLine, syncUnlockLabel, renderVaultList, closeVaultList,
 * syncLockBg, lockBgFile.
 * Auxiliary functions: formatCrackTime, showFileName, loadScript,
 * showLockBg, shakeLock.
 *
 * Complexity: unlocking is one PBKDF2 (about 0.6 s) and one decrypt, O(n) in
 * the vault; the meter is O(n) in the password.
 */
"use strict";

// ---------- State: password strength ----------

// Passwords so common they are tried first.
const COMMON_PASSWORDS = ["password", "passw0rd", "123456", "12345678", "123456789", "qwerty", "qwertyuiop", "letmein",
  "admin", "welcome", "iloveyou", "monkey", "dragon", "football", "baseball", "abc123", "111111", "sunshine",
  "princess", "master", "shadow", "superman", "trustno1", "contraseña", "contrasena", "secret", "notes"];

// ---------- Password strength (making a vault only) ----------

/**
 * A rough estimate of a password's strength in bits, deliberately
 * approximate (a nudge, not an audit), and on the safe side: it reads weaker
 * rather than stronger. It starts from the characters it draws from and its
 * length (a repeated character or a step, like aa, ab or 12, adds a quarter
 * of a character, not one), then lowers that for what crackers try first:
 *   - a common password, alone or padded with digits and symbols
 *     ("Password1!"): one guess from a short list;
 *   - one word with a short suffix: a 100,000-word dictionary (about 17
 *     bits), a capital, and about 3.3 bits per extra character;
 *   - leetspeak undone ("tr0ub4dor" is "troubador" to a cracker), the
 *     padding cut off first so "2024" or "!" stays padding;
 *   - a run of six or more letters that looks like a word (two vowels typed,
 *     or two once the swaps are undone with no capital after its first
 *     letter): about 17 bits, plus 1 for the swaps, 1 for a capital, and 4.5
 *     per other character;
 *   - three or more words split by spaces or dashes: words from a 7,776-word
 *     list, 12.9 bits each.
 * Known limit: two rules, not a dictionary; a random all-lowercase string
 * can read weaker than it is.
 *
 * Used by: this file (renderPwMeter).
 * Uses: COMMON_PASSWORDS.
 * Complexity: O(n) in the password.
 */
function estimateBits(password) {
  if (!password) {
    return 0;
  }
  let pool = 0;
  if (/[a-z]/.test(password)) {
    pool += 26;
  }
  if (/[A-Z]/.test(password)) {
    pool += 26;
  }
  if (/[0-9]/.test(password)) {
    pool += 10;
  }
  if (/[^a-zA-Z0-9]/.test(password)) {
    pool += 33;
  }
  let effective = 1;
  for (let i = 1; i < password.length; i++) {
    const step = password.charCodeAt(i) - password.charCodeAt(i - 1);
    effective += (step >= -1 && step <= 1) ? 0.25 : 1;
  }
  let bits = effective * Math.log2(pool);

  const lower = password.toLowerCase();
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (COMMON_PASSWORDS.includes(lower) || COMMON_PASSWORDS.includes(core)) {
    bits = Math.min(bits, 8 + (password.length - core.length) * 3.3);
  } else if (core.length >= 3 && core.length <= 12 && /^[a-zA-Z]+[^a-zA-Z]{0,6}$/.test(password)) {
    bits = Math.min(bits, 17 + (/[A-Z]/.test(password) ? 1 : 0) + (password.length - core.length) * 3.3);
  }

  const LEET = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
  const plain = lower.replace(/[013457@$!]/g, c => LEET[c]);
  const plainCore = lower.replace(/^[^a-z]+|[^a-z]+$/g, "").replace(/[013457@$!]/g, c => LEET[c]);
  if (COMMON_PASSWORDS.includes(plainCore)) {
    bits = Math.min(bits, 9 + (password.length - plainCore.length) * 3.3);
  }
  for (const match of plain.matchAll(/[a-z]{6,}/g)) {
    // The run as typed, so its own vowels and capitals can be checked.
    const typed = password.slice(match.index, match.index + match[0].length);
    const typedVowels = (typed.toLowerCase().match(/[aeiou]/g) || []).length;
    const plainVowels = (match[0].match(/[aeiou]/g) || []).length;
    // A random string like "xR4!nq8Zk2", whose swaps happen to spell
    // "xrainq", mixes case in the run, so it keeps its full score.
    if (typedVowels >= 2 || (plainVowels >= 2 && !/[A-Z]/.test(typed.slice(1)))) {
      bits = Math.min(bits, 17 + (plain !== lower ? 1 : 0) + (/[A-Z]/.test(password) ? 1 : 0) +
        (password.length - match[0].length) * 4.5);
    }
  }

  const parts = password.trim().split(/[\s\-_.]+/);
  if (parts.length >= 3 && parts.every(word => /^[a-zA-Z]{2,}$/.test(word))) {
    bits = Math.min(bits, parts.length * 12.9);
  }
  return bits;
}

/**
 * How long, in seconds, an attacker would take on average to guess a
 * password of that strength: every guess costs one PBKDF2 (2 SHA-256
 * compressions per round), against 1,000 GPUs at about 2e10 compressions a
 * second each, searching half the space.
 *
 * Used by: this file (renderPwMeter).
 * Uses: PBKDF2_ITERATIONS (core.js).
 * Complexity: O(1).
 */
function crackSeconds(bits) {
  const perGuess = 2 * PBKDF2_ITERATIONS;
  const guessesPerSec = 1000 * 2e10 / perGuess;
  return Math.pow(2, bits - 1) / guessesPerSec;
}

/**
 * The strength meter under the password while making a vault (hidden
 * otherwise, and while the field is empty): five bands by bits (very weak
 * under 36, weak, fair from 50, strong from 60, very strong from 75), a bar
 * full at 90 bits, and the time to crack it, worded so it always reads right.
 *
 * Used by: this file (typing a password, setLockMode).
 * Uses: estimateBits, crackSeconds, formatCrackTime.
 * Complexity: O(n) in the password.
 */
function renderPwMeter() {
  const box = $("pw-meter");
  const password = $("password").value;
  if ($("token-row").style.display !== "flex" || !password) {
    box.className = "";
    box.style.display = "none";
    return;
  }
  const bits = estimateBits(password);
  let level = "vweak";
  let label = "Very weak";
  if (bits >= 75) {
    level = "vstrong";
    label = "Very strong";
  } else if (bits >= 60) {
    level = "strong";
    label = "Strong";
  } else if (bits >= 50) {
    level = "fair";
    label = "Fair";
  } else if (bits >= 36) {
    level = "weak";
    label = "Weak";
  }
  box.className = level;
  box.style.display = "block";
  box.querySelector(".pw-fill").style.width = Math.min(100, Math.max(6, bits / 90 * 100)) + "%";
  box.querySelector(".pw-label").textContent = label;
  const seconds = crackSeconds(bits);
  const time = formatCrackTime(seconds);
  let line = `1,000 GPUs would crack it in about ${time} (rough estimate).`;
  if (seconds < 1) {
    line = "1,000 GPUs would crack it almost instantly (rough estimate).";
  } else if (time.startsWith("far longer")) {
    line = "1,000 GPUs would need far longer than the age of the universe (rough estimate).";
  }
  box.querySelector(".pw-time").textContent = line;
}

// ---------- On load: the meter follows the password ----------

$("password").addEventListener("input", renderPwMeter);

// ---------- State: the form ----------

// The vault the form opens without a file: the old top-level one comes in
// through index.html's own <script>; a vault in a folder is loaded below.
let autoVault = selectedVault && !selectedVault.dir ? legacyBlob : null;

// Whether the form is making a vault (it starts so when this device knows none).
let creatingVault = !selectedVault && !Object.keys(knownVaults()).length;

// ---------- The form ----------

/**
 * Sets what the lock screen is for: making a vault ("new"), unlocking this
 * device's copy of the chosen vault ("unlock"), unlocking a copy found in
 * its folder, such as a fresh clone ("found"), a chosen vault whose files
 * are missing ("missing"), or nothing chosen ("none"). The token row shows
 * only when making a vault.
 *
 * Used by: this file (on load, the buttons), settings.js (lockApp).
 * Uses: vaultStorageKey (core.js), renderVaultLine, renderPwMeter, syncUnlockLabel.
 * Complexity: O(1).
 */
function setLockMode() {
  const mode = creatingVault ? "new" : !selectedVault ? "none"
    : localStorage.getItem(vaultStorageKey("vault")) ? "unlock" : autoVault ? "found" : "missing";
  $("unlock-form").dataset.mode = mode;
  $("token-row").style.display = mode === "new" ? "flex" : "none";
  $("new-vault").setAttribute("aria-pressed", creatingVault ? "true" : "false");
  renderVaultLine();
  renderPwMeter();
  syncUnlockLabel();
}

/**
 * "Vault selected: Main - 4 Nov 2026, 19:14" above the form ("New vault" or
 * "No vault selected" otherwise). The name is the user's own, so it is never
 * translated.
 *
 * Used by: this file (setLockMode).
 * Uses: knownVaults and formatWhen (vaults.js), makeElement (sidebar.js).
 * Complexity: O(v) in the vaults known.
 */
function renderVaultLine() {
  const el = $("vault-line");
  el.textContent = "";
  if (creatingVault) {
    el.textContent = "New vault";
    return;
  }
  if (!selectedVault) {
    el.textContent = "No vault selected";
    return;
  }
  const at = Math.max((knownVaults()[selectedVault.name] || {}).at || 0, +window.__VAULT_AT__ || 0);
  const nameEl = makeElement("span", "vn", selectedVault.name);
  nameEl.setAttribute("translate", "no");
  el.append("Vault selected:", " ", nameEl);
  if (at) {
    el.append(" - " + formatWhen(at));
  }
}

/**
 * Makes the button say what pressing it will do: open a backup, create a
 * vault, restore from the file chosen, or unlock (and "...ing" while an
 * attempt runs).
 *
 * Used by: this file, guard.js (renderGuard), backups.js (choosing a backup, on load).
 * Uses: attemptBusy (guard.js), pendingBackupKind (backups.js).
 * Complexity: O(1).
 */
function syncUnlockLabel() {
  const label = $("unlock-label");
  if (!label) {
    return;
  }
  const mode = $("unlock-form").dataset.mode;
  const fromFile = $("restore-box").style.display !== "none" && $("vault-file").files.length > 0;
  const creating = mode === "new" && !pendingBackupKind;
  if (attemptBusy) {
    label.textContent = pendingBackupKind ? "Opening backup..." : creating ? "Creating vault..." : "Unlocking...";
  } else {
    label.textContent = pendingBackupKind ? `Open ${pendingBackupKind} backup` : creating ? "Create vault" :
      fromFile ? "Restore and unlock" : "Unlock";
  }
}

/**
 * The "Other vault" list: every other vault this device knows (those next to
 * index.html included), the most recent first, each with when it last
 * changed; choosing one reloads the page with it selected. At the end,
 * "From a file..." shows or hides the restore picker (and forgets a file
 * chosen there when it hides).
 *
 * Used by: this file (the Other vault button).
 * Uses: knownVaults, formatWhen and selectVault (vaults.js), makeElement
 * (sidebar.js), showFileName, syncUnlockLabel.
 * Complexity: O(v log v) in the vaults.
 */
function renderVaultList() {
  const box = $("vault-list");
  const known = knownVaults();
  box.textContent = "";
  const names = Object.keys(known).filter(name => !(selectedVault && name === selectedVault.name))
    .sort((a, b) => (known[b].at || 0) - (known[a].at || 0));
  for (const name of names) {
    const button = makeElement("button", "vault-pick");
    button.type = "button";
    const nameEl = makeElement("span", "vp-name", name);
    nameEl.setAttribute("translate", "no");
    button.append(nameEl, makeElement("span", "vp-at", known[name].at ? formatWhen(known[name].at) : ""));
    button.onclick = () => {
      selectVault(name, known[name].dir);
      location.reload();
    };
    box.appendChild(button);
  }
  if (!names.length) {
    box.appendChild(makeElement("small", null, "No other vaults found next to index.html."));
  }
  const fileButton = makeElement("button", "vault-file-btn", "From a file...");
  fileButton.type = "button";
  fileButton.onclick = () => {
    const restore = $("restore-box");
    const open = restore.style.display !== "none";
    restore.style.display = open ? "none" : "flex";
    if (open) {
      $("vault-file").value = "";
      showFileName();
    }
    syncUnlockLabel();
  };
  box.appendChild(fileButton);
}

/**
 * Closes the "Other vault" list, and "From a file..." with it, forgetting
 * the file chosen there: a hidden file would still be what Unlock opens.
 *
 * Used by: this file (the Other vault and New vault buttons).
 * Uses: showFileName, syncUnlockLabel.
 * Complexity: O(1).
 */
function closeVaultList() {
  $("vault-list").style.display = "none";
  $("other-vault").setAttribute("aria-expanded", "false");
  $("restore-box").style.display = "none";
  $("vault-file").value = "";
  showFileName();
  syncUnlockLabel();
}

// ---------- On load: the form's buttons and fields ----------

// "Other vault" opens or closes the list: what this device knows at once,
// then what the app folder holds (which asks for access the first time).
$("other-vault").onclick = async () => {
  if ($("vault-list").style.display !== "none") {
    closeVaultList();
    return;
  }
  $("vault-list").style.display = "flex";
  $("other-vault").setAttribute("aria-expanded", "true");
  if (creatingVault) {
    creatingVault = false;
    setLockMode();
  }
  renderVaultList();
  if (await scanVaults()) {
    renderVaultList();
  }
};

$("new-vault").onclick = () => {
  creatingVault = !creatingVault;
  closeVaultList();
  setLockMode();
  if (creatingVault) {
    $("vault-name").focus();
  }
};

// "Choose file" opens the hidden file input. A file chosen with no vault to
// restore it into becomes a new vault, named on the form.
$("file-pick").onclick = () => $("vault-file").click();
$("vault-file").addEventListener("change", () => {
  showFileName();
  if ($("vault-file").files.length && !selectedVault && !creatingVault) {
    creatingVault = true;
    setLockMode();
  }
  syncUnlockLabel();
});

// The language list, at the top centre: choosing one reloads the page in it.
for (const [code, name] of Object.entries(LANGS)) {
  $("lang").add(new Option(name, code, code === LANG, code === LANG));
}
$("lang").onchange = () => {
  localStorage.setItem("lang", $("lang").value);
  location.reload();
};

$("lock-version").textContent = "v" + APP_VERSION;
setLockMode();

// A vault in a folder: its vault.enc.js and backups, loaded by <script>,
// because a page opened from a file may load scripts beside it but not fetch
// them. Missing files just fail quietly, like the top-level ones in index.html.
if (selectedVault && selectedVault.dir) {
  window.__VAULT__ = window.__VAULT_AT__ = undefined;
  for (const kind of Object.values(BACKUP_KINDS)) {
    window[kind.varName] = undefined;
  }
  const folder = encodeURIComponent(selectedVault.dir) + "/";
  Promise.all([loadScript(folder + WRAPPER),
    ...Object.values(BACKUP_KINDS).map(kind => loadScript(folder + kind.file))]).then(() => {
    autoVault = window.__VAULT__ && typeof window.__VAULT__ === "object" ? JSON.stringify(window.__VAULT__) : null;
    setLockMode();
    refreshLockBackupRow();
  });
}

// A wrong guess costs one of the ten attempts: the form says when Caps Lock is on.
for (const id of ["password", "password2"]) {
  const caps = event => {
    $("caps-msg").hidden = !(event.getModifierState && event.getModifierState("CapsLock"));
  };
  $(id).addEventListener("keydown", caps);
  $(id).addEventListener("keyup", caps);
  $(id).addEventListener("blur", () => {
    $("caps-msg").hidden = true;
  });
}

// ---------- The background video ----------

// A video of the user's own behind the lock screen, when lock-background.mp4
// or lock-background.webm sits next to index.html. The app never syncs it
// (git can carry it in the user's own private repository; the public
// mirror's .gitignore refuses it), and it is only a picture, so it runs no
// code. It plays only while the lock screen shows, muted, and stays on its
// first frame when the system asks for reduced motion.
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Plays the background video while the lock screen shows (unless reduced
 * motion is asked for), and pauses it otherwise.
 *
 * Used by: this file (showLockBg, unlocking), settings.js (lockApp).
 * Uses: stillMotion.
 * Complexity: O(1).
 */
function syncLockBg() {
  const video = $("lock-bg");
  if (!video || !$("lock").classList.contains("has-bg")) {
    return;
  }
  if ($("lock").style.display !== "none" && !stillMotion.matches) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

/**
 * The background file the lock screen found and shows, or null: for its line in Settings.
 *
 * Used by: settings.js (openSettings).
 * Uses: nothing.
 * Complexity: O(1).
 */
function lockBgFile() {
  if (!$("lock").classList.contains("has-bg")) {
    return null;
  }
  return decodeURIComponent(($("lock-bg").currentSrc || "").split("/").pop()) || null;
}

// ---------- On load: the background, once its first frame is there ----------

$("lock-bg").addEventListener("loadeddata", showLockBg);
// A local file can finish loading before this script runs, and then the event is already gone.
if ($("lock-bg").readyState >= 2) {
  showLockBg();
}

// ---------- On load: unlocking ----------

// The Unlock (or Create vault, or Open backup) button. Before anything is
// awaited: a new vault's name is checked (no attempt is spent on it), and
// folder access is asked for, since it needs this very click (the app folder
// for a new vault, where its folder is made; permission to keep writing an
// existing vault's folder otherwise). Both guard stores are read again on
// every attempt, since another copy of this page may have spent attempts or
// started the lockout. The attempt then waits 3 seconds, and:
//   - a backup is opened read-only: no saving, no housekeeping, no
//     re-keying, no sync, nothing that touches the real vault or the
//     repository until "Convert" is pressed;
//   - otherwise the vault opened is, in order: this device's copy (unless a
//     file was chosen: an explicit file always wins), the file chosen, the
//     vault.enc.js found in the folder, ./vault.enc over http, or a brand
//     new vault (which needs a token, a matching confirmation and at least 8
//     characters: this password is the only key). None of these moves
//     savedAt, or a stale or restored vault would look newest and win the
//     next sync; a new vault keeps savedAt 0, so a same-password vault
//     already in the repository is pulled, not overwritten;
//   - a new vault becomes the selected one, with its own folder and media
//     folder next to index.html, and nothing of the previous vault;
//   - housekeeping (old tombstones, expired trash) and the re-keying of an
//     older vault, then the attachment key (it lives inside the vault, so
//     only once the live vault is settled);
//   - the app opens with every folder and the trash folded, the attempt
//     count is reset, and the old top-level vault is offered its move into a
//     folder, then any overdue backup.
// Only a real decrypt failure spends an attempt (a slip such as a
// mismatched confirmation does not); it empties the password field, shakes
// the card and says how many attempts are left.
$("unlock-form").onsubmit = async event => {
  event.preventDefault();
  if (attemptBusy) {
    return;
  }
  const lockMsg = (text, isError) => {
    $("lock-msg").style.color = isError ? "var(--bad)" : "var(--t3)";
    $("lock-msg").textContent = text;
  };
  const mode = $("unlock-form").dataset.mode;
  if (mode === "none" || mode === "missing") {
    return;
  }
  const creating = mode === "new" && !pendingBackupKind;
  const newName = creating ? $("vault-name").value.trim() : "";
  if (creating) {
    const why = vaultNameProblem(newName);
    if (why) {
      lockMsg(why, true);
      $("vault-name").focus();
      return;
    }
  }
  const appDir = creating ? notesDirHandle() : (selectedVault && selectedVault.dir ? askAppDirAccess() : null);
  await loadGuard();
  renderGuard();
  if (isLockedOut()) {
    return;
  }
  const password = $("password").value;
  if (!password) {
    return;
  }
  const stored = creating ? null : localStorage.getItem(vaultStorageKey("vault"));
  let restored = false;
  let decrypted = false;
  let refocus = false;
  attemptBusy = true;
  // It freezes the form; the button shows the attempt running.
  renderGuard();
  lockMsg("", false);
  await new Promise(resolve => setTimeout(resolve, ATTEMPT_DELAY_MS));
  try {
    // A backup, read-only.
    if (pendingBackupKind) {
      const wrapper = backupWrapper(pendingBackupKind);
      if (!wrapper) {
        lockMsg("Backup file not found next to index.html.", true);
        return;
      }
      ({ vault, key: vaultKey, salt: vaultSalt, iter: vaultKeyIterations } = await openVault(wrapper.data, password));
      decrypted = true;
      await registerSuccess();
      // In memory only: attachments can be decrypted for viewing.
      await loadMediaKey();
      masterPassword = password;
      $("password").value = "";
      $("password2").value = "";
      $("token").value = "";
      lockMsg("", true);
      $("lock").style.display = "none";
      syncLockBg();
      $("app").style.display = "flex";
      unsavedEdits = false;
      enterBackupView(pendingBackupKind, wrapper.at);
      renderList();
      renderStatus();
      renderAttachments();
      status("Viewing backup - read-only");
      return;
    }

    let needPersist = false;
    const picked = $("vault-file").files[0];
    if (stored && !picked) {
      ({ vault, key: vaultKey, salt: vaultSalt, iter: vaultKeyIterations } = await openVault(stored, password));
      decrypted = true;
    } else {
      let blobText = null;
      const file = picked;
      if (file) {
        blobText = await file.text();
      } else if (creating) {
        blobText = null;
      } else if (autoVault) {
        blobText = autoVault;
      } else {
        try {
          const res = await fetch(vaultPath(FILE));
          if (res.ok) {
            blobText = await res.text();
          }
        } catch {}
      }
      if (blobText) {
        ({ vault, key: vaultKey, salt: vaultSalt, iter: vaultKeyIterations } = await openVault(blobText, password));
        decrypted = true;
        restored = true;
        needPersist = true;
      } else {
        if (!creating) {
          lockMsg("This vault's files were not found next to index.html.", true);
          return;
        }
        if (!$("token").value.trim()) {
          lockMsg("Paste a token (new vault) or pick your vault.enc (restore).", true);
          return;
        }
        if ($("password2").value !== password) {
          lockMsg("The two passwords do not match.", true);
          return;
        }
        if (password.length < 8) {
          lockMsg("Use at least 8 characters: this password is the only key.", true);
          return;
        }
        vaultSalt = crypto.getRandomValues(new Uint8Array(16));
        vaultKey = await deriveKey(password, vaultSalt, PBKDF2_ITERATIONS);
        vaultKeyIterations = PBKDF2_ITERATIONS;
        // Through migrateVault like every vault opened, so a new one has every
        // map too (without pins, "Pin to top" once failed until the next unlock).
        vault = migrateVault({ v: 2, token: $("token").value.trim(), savedAt: 0,
          notes: {}, folders: {}, trash: {}, purged: {} });
        // A brand-new vault is not a failed guess.
        decrypted = true;
        needPersist = true;
      }
    }

    let noFolder = false;
    if (creating) {
      resetVaultState();
      selectVault(newName, newName);
      // Shown with this date until its first save (savedAt stays 0 for Sync).
      rememberVault(newName, newName, Date.now());
      const root = await appDir;
      try {
        await (await root.getDirectoryHandle(newName, { create: true })).getDirectoryHandle("media", { create: true });
      } catch {
        noFolder = true;
      }
      needPersist = true;
    }
    if (prunePurged()) {
      needPersist = true;
    }
    if (autoPurgeTrash()) {
      needPersist = true;
    }
    // Re-keying an older vault: a fresh 16-byte salt and the full round count.
    // The sealed blob keeps its { v: 1, iter, salt, iv, data } shape, only
    // iter changes, so any copy of the app can still open it.
    if (vaultKeyIterations < PBKDF2_ITERATIONS) {
      lockMsg("Upgrading encryption, one second...", false);
      // The message paints first.
      await new Promise(resolve => setTimeout(resolve, 30));
      vaultSalt = crypto.getRandomValues(new Uint8Array(16));
      vaultKey = await deriveKey(password, vaultSalt, PBKDF2_ITERATIONS);
      vaultKeyIterations = PBKDF2_ITERATIONS;
      needPersist = true;
      localStorage.removeItem(vaultStorageKey("vault.prev"));
      localStorage.removeItem(vaultStorageKey("vault.prevAt"));
    }
    await loadMediaKey();
    if (needPersist) {
      await persistLocal(false);
    }
    masterPassword = password;
    $("password").value = "";
    $("password2").value = "";
    $("token").value = "";
    lockMsg("", true);
    $("lock").style.display = "none";
    syncLockBg();
    $("app").style.display = "flex";
    unsavedEdits = false;
    collapsed = new Set(Object.keys(vault.folders));
    trashCollapsed = true;
    renderList();
    renderStatus();
    renderAttachments();
    renderBackupBar();
    await registerSuccess();
    if (selectedVault) {
      rememberVault(selectedVault.name, selectedVault.dir, vault.savedAt);
    }
    creatingVault = false;
    status(creating && noFolder ? "Vault created in this browser only: without access to the app folder, its folder could not be made"
      : stored ? "Unlocked" : restored ? "Vault restored, press Sync to connect" : "Vault created, use Sync to push it", noFolder);
    // Not awaited: each dialog owns its own clicks.
    (async () => {
      await offerVaultMove();
      await promptDueBackups();
    })();
  } catch {
    // The typed password goes: a failed unlock is exactly when someone walks
    // away. (The early returns above keep their fields on purpose: the user
    // is in the middle of the form.)
    $("password").value = "";
    // Focusing waits for finally: the field is still disabled here.
    refocus = true;
    if (!decrypted) {
      await registerFailedAttempt();
      shakeLock();
    }
    // renderGuard owns the screen now.
    if (isLockedOut()) {
      lockMsg("", true);
      return;
    }
    const left = triesLeft();
    lockMsg(`Wrong password (or corrupted vault). ${left} attempt${left === 1 ? "" : "s"} remaining.`, true);
  } finally {
    attemptBusy = false;
    renderGuard();
    if (refocus && !isLockedOut()) {
      $("password").focus();
    }
  }
};

// =================== Auxiliary functions ===================

/**
 * A number of seconds for the meter's sentence, to two significant figures
 * (plenty for an estimate this rough), in en-US so the decimal point matches
 * the English sentence: "45 seconds" up to "3.2 billion years", or "far
 * longer than the age of the universe". Complexity: O(1).
 */
function formatCrackTime(sec) {
  const round = x => Number(x.toPrecision(2)).toLocaleString("en-US");
  if (sec < 60) {
    return `${round(Math.max(sec, 1))} seconds`;
  }
  if (sec < 3600) {
    return `${round(sec / 60)} minutes`;
  }
  if (sec < 86400) {
    return `${round(sec / 3600)} hours`;
  }
  const years = sec / (365.25 * 86400);
  if (years < 1) {
    return `${round(sec / 86400)} days`;
  }
  if (years < 1e6) {
    return `${round(years)} years`;
  }
  if (years < 1e9) {
    return `${round(years / 1e6)} million years`;
  }
  if (years < 1e12) {
    return `${round(years / 1e9)} billion years`;
  }
  return "far longer than the age of the universe";
}

/** Shows the chosen file's name beside "Choose file" (the user's own name: never translated). Complexity: O(1). */
function showFileName() {
  const file = $("vault-file").files[0];
  const el = $("file-name");
  if (file) {
    el.setAttribute("translate", "no");
  } else {
    el.removeAttribute("translate");
  }
  el.textContent = file ? file.name : "No file chosen";
}

/** Loads a script beside index.html; resolves whether it loaded or not. Complexity: O(1). */
function loadScript(src) {
  return new Promise(resolve => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = el.onerror = () => {
      el.remove();
      resolve();
    };
    document.body.appendChild(el);
  });
}

/** Shows the background video once it has a frame, and starts it. Complexity: O(1). */
function showLockBg() {
  $("lock").classList.add("has-bg");
  syncLockBg();
}

/** One shake of the card for a wrong password. Complexity: O(1). */
function shakeLock() {
  const form = $("unlock-form");
  form.classList.remove("shake");
  // Reading the width restarts the animation.
  void form.offsetWidth;
  form.classList.add("shake");
  setTimeout(() => form.classList.remove("shake"), 500);
}
