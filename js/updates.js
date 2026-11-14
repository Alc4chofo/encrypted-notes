/*
 * updates.js - app updates offered through Sync.
 *
 * Sync also looks for a newer build of the app in the repository, so a
 * change made on one computer reaches the others. The app is the code that
 * holds the password, so it never replaces itself silently: the user sees
 * the new build, when it was committed, by whom and why, plus a warning when
 * the new files would stop taking the repository from config.js or no
 * longer refuse public repositories, and chooses. The notes sync either way.
 * Per device, in localStorage "appUpdate": the last commit looked at, its
 * build, and a declined commit (not asked again until the app changes;
 * Settings can always check by hand).
 *
 * A build is every file js/version.js lists in APP_FILES, all as of the
 * commit that last changed js/version.js (every app change bumps APP_BUILD
 * there). js/version.js is read as text with regexes and never run. config.js
 * is never part of a build: it holds the user's own repository.
 *
 * Integrity, not secrecy: each downloaded file is checked against the id git
 * gave it in that commit, a SHA-1 of the file (gitBlobId), which catches a
 * cut-off or garbled download. It cannot stop someone who can push to the
 * repository (they could push any file, and SHA-1 is no longer
 * collision-proof); that is what the user's own decision and the warnings
 * are for. Nothing here is encrypted: the app's files are public code.
 *
 * Main functions: appUpdateStep, manualAppUpdate, checkAppUpdate,
 * offerAppUpdate, fetchBuild, buildWarnings, filesOf, appFileAt, treeIds,
 * gitBlobId, appDirHandle, writeBuild, downloadBuild.
 * Auxiliary functions: buildParts, compareBuild, buildOf, loadAppMeta,
 * saveAppMeta, bytesToText, isAppDir.
 *
 * Complexity: a check is one request (two when version.js changed); an
 * update downloads every file of the build, O(b) in its bytes.
 */
"use strict";

// ---------- State ----------

// The file that lists the build.
const MANIFEST = "js/version.js";

// The only paths an update may write: index.html, and plain names in css/
// and js/. So a tampered list can never reach config.js, the vault or backup
// files, or anything outside the app's folder.
const APP_PATH = /^(index\.html|css\/[a-z0-9][a-z0-9-]*\.css|js\/[a-z0-9][a-z0-9-]*\.js)$/;

// The commit written this session (it runs from the next reload), and
// whether a check or an update is in progress.
let appUpdateWritten = null;
let appUpdateBusy = false;

// ---------- Checking for an update ----------

/**
 * The update step of a full Sync, after the notes have synced: offers a
 * newer build if there is one. It never fails the sync: a check that cannot
 * run (offline, rate limited) waits for the next.
 *
 * Used by: media-sync.js (runSync).
 * Uses: checkAppUpdate, offerAppUpdate.
 * Complexity: that of checkAppUpdate.
 */
async function appUpdateStep() {
  if (appUpdateBusy) {
    return;
  }
  appUpdateBusy = true;
  try {
    const update = await checkAppUpdate(false);
    if (update && vault) {
      await offerAppUpdate(update, false);
    }
  } catch {} finally {
    appUpdateBusy = false;
  }
}

/**
 * Settings > "Check now": also offers a build declined before, and says when
 * this copy is up to date or why the check failed.
 *
 * Used by: settings.js (openSettings).
 * Uses: status (pagination.js), checkAppUpdate, offerAppUpdate,
 * ERROR_EXPLANATIONS (pagination.js).
 * Complexity: that of checkAppUpdate.
 */
async function manualAppUpdate() {
  if (syncing || backupView || !vault || appUpdateBusy) {
    return;
  }
  appUpdateBusy = true;
  status("Checking the repo for a newer app...", false, true);
  try {
    const update = await checkAppUpdate(true);
    if (!update) {
      status(`This copy is up to date (build ${APP_BUILD})`);
      return;
    }
    await offerAppUpdate(update, true);
  } catch (error) {
    status("Could not check for an update: " + (error.guard ? ERROR_EXPLANATIONS[error.guard] : error.message), true);
  } finally {
    appUpdateBusy = false;
  }
}

/**
 * A newer build in the repository, as { build, commit }, or null. Only
 * js/version.js (one small file) is read, and only when its latest commit
 * is one this device has not looked at; the other files come when the update
 * is offered. A build declined, or already written this session, is not
 * offered again unless asked by hand.
 *
 * Used by: this file (appUpdateStep, manualAppUpdate).
 * Uses: ghApi (sync.js), loadAppMeta, appFileAt, buildOf, bytesToText,
 * saveAppMeta, compareBuild, APP_BUILD (version.js).
 * Complexity: one or two requests.
 */
async function checkAppUpdate(manual) {
  const list = await ghApi(`commits?path=${encodeURIComponent(MANIFEST)}&per_page=1`);
  // No js/version.js in the repository.
  if (!Array.isArray(list) || !list.length) {
    return null;
  }
  const commit = list[0];
  if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha || "")) {
    return null;
  }
  let meta = loadAppMeta();
  if (meta.commit !== commit.sha) {
    const bytes = await appFileAt(MANIFEST, commit.sha);
    if (bytes == null) {
      return null;
    }
    meta = { ...meta, commit: commit.sha, build: buildOf(bytesToText(bytes)) || "" };
    saveAppMeta(meta);
  }
  if (!meta.build || compareBuild(meta.build, APP_BUILD) <= 0) {
    return null;
  }
  if (!manual && (meta.declined === commit.sha || appUpdateWritten === commit.sha)) {
    return null;
  }
  return { build: meta.build, commit };
}

// ---------- Offering and installing ----------

/**
 * Offers a build and installs it on yes; returns whether the files were
 * replaced or downloaded. Only a complete, intact copy is ever offered (part
 * of one would leave nothing that opens). The question shows the build, the
 * commit's time, author and message, the warnings, and that it replaces the
 * app's files but never config.js, the notes or the backups; "Not now" is
 * remembered for that commit. On yes, the folder is asked for at once (the
 * picker and the permission prompt only open right after a click); the
 * files are written into it, or downloaded as a ZIP when that is not
 * possible (with a warning when only some of them were put in place). After
 * writing, a reload is offered (a pending save lands first).
 *
 * Used by: this file (appUpdateStep, manualAppUpdate).
 * Uses: status (pagination.js), fetchBuild, buildWarnings, showModal and
 * alertModal (modal.js), saveAppMeta, loadAppMeta, appDirHandle,
 * appFolderInfo (backups.js), writeBuild, downloadBuild, OWNER and REPO
 * (core.js), flushSave (pagination.js), persistChain (vault.js), t (i18n.js).
 * Complexity: O(b) in the build's bytes.
 */
async function offerAppUpdate(update, manual) {
  let files;
  if (manual) {
    status(`Fetching build ${update.build} to check it...`, false, true);
  }
  try {
    files = await fetchBuild(update);
  } catch (error) {
    status(`The app in the repo is not a complete copy (${error.message}), so it was not offered`, true);
    return false;
  }
  if (manual) {
    status("");
  }
  const info = update.commit.commit || {};
  const when = (info.committer && info.committer.date) || (info.author && info.author.date) || "";
  const who = (info.author && info.author.name) || (update.commit.author && update.commit.author.login) || "unknown";
  const msg = String(info.message || "").split("\n")[0].trim().slice(0, 160);
  const warn = buildWarnings(files);
  const committedAt = when
    ? new Date(when).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : t("on an unknown date");
  // The page translates a text only as a whole, and parts of this one come and
  // go (the message, the warnings), so each sentence is translated here.
  const body = t("There is a newer build of the app in {0}:", `${OWNER}/${REPO}`) + "\n" +
    t("build {0} (this copy is build {1}),", update.build, APP_BUILD) + "\n" +
    t("committed {0} by {1}", committedAt, who) + (msg ? `:\n"${msg}"` : ".") + "\n\n" +
    t("It replaces the app's {0} files: index.html and the css and js folders. config.js, your notes and your backups stay as they are.", files.size) + "\n\n" +
    (warn.length ? t("WARNING:") + " " + warn.map(line => t(line)).join(" ") + "\n\n" : "") +
    t("Only update if you made this change yourself: anyone who can write to the repo could have pushed it, and the app runs whatever these files contain. Your notes sync either way.");
  const choice = await showModal({
    title: warn.length ? "Update the app? Read the warning first" : "Update the app?",
    body,
    choices: [
      { id: "update", label: "Update the app", danger: warn.length > 0 },
      { id: "skip", label: "Not now" },
    ],
    defaultId: "skip",
  });
  if (choice !== "update") {
    saveAppMeta({ ...loadAppMeta(), declined: update.commit.sha });
    return false;
  }

  const dir = await appDirHandle();
  const app = appFolderInfo();
  const page = app ? app.file : "index.html";
  let how = "download";
  let placed = 0;
  if (dir) {
    try {
      await writeBuild(dir, files, page);
      how = "folder";
    } catch (error) {
      placed = error.placed || 0;
    }
  }
  const zip = how === "download" ? downloadBuild(files, page, update.build) : null;
  appUpdateWritten = update.commit.sha;
  saveAppMeta({ ...loadAppMeta(), declined: null });
  status(how === "folder" ? `App updated to build ${update.build}: reload to use it` : `Downloaded ${zip} (build ${update.build})`);
  if (how === "download") {
    await alertModal({
      title: placed ? "Update only partly written" : "Update downloaded",
      // Translated sentence by sentence, as the question above.
      body: (placed ? t("Only {0} of the {1} files could be put in place in \"{2}\", so the app there is now a mix of two builds: do not reload before the step below.", placed, files.size, dir.name) + "\n\n" : "") +
        (app
          ? t("{0} is in your downloads. Unpack it and copy everything in it ({1} and the css and js folders) over the app's folder, in:\n{2}\n\nreplacing the old files. config.js is not in it, so your settings stay. Then reload this page to use it.", zip, page, app.display)
          : t("{0} is in your downloads. Unpack it and copy everything in it ({1} and the css and js folders) over the app's folder, replacing the old files. config.js is not in it, so your settings stay. Then reload this page to use it.", zip, page)),
    });
  } else {
    const again = await showModal({
      title: "App updated",
      body: `The app in "${dir.name}" is now build ${update.build}. It takes effect when the page reloads, and the vault asks for your master password again.`,
      choices: [{ id: "reload", label: "Reload now" }, { id: "later", label: "Later" }],
      defaultId: "later",
    });
    if (again === "reload") {
      if (unsavedEdits) {
        flushSave();
      }
      // The save is a sealed write to localStorage: it lands first.
      await persistChain;
      location.reload();
    }
  }
  return true;
}

/**
 * Every file of a build as of its commit (path -> bytes), or a thrown reason
 * the status line can show. Each file is matched against its git blob id (a
 * cut-off or garbled download is caught) and checked as a working file of
 * its kind: a script must compile (it is compiled with new Function, never
 * run), index.html must be a whole page. Everything the new index.html loads
 * must be in the build (config.js and this device's vault and backup scripts
 * aside), or the page would run with an old or missing file. Six files are
 * fetched at a time.
 *
 * Used by: this file (offerAppUpdate).
 * Uses: appFileAt, filesOf, bytesToText, buildOf, treeIds, gitBlobId.
 * Complexity: O(b) in the build's bytes, one request per file.
 */
async function fetchBuild(update) {
  const sha = update.commit.sha;
  const manifest = await appFileAt(MANIFEST, sha);
  const paths = manifest && filesOf(bytesToText(manifest));
  if (!paths || buildOf(bytesToText(manifest)) !== update.build) {
    throw new Error("its js/version.js does not list the app's files");
  }
  const ids = await treeIds(sha, paths);
  const files = new Map();
  for (let i = 0; i < paths.length; i += 6) {
    const batch = paths.slice(i, i + 6);
    const got = await Promise.all(batch.map(path => (path === MANIFEST ? manifest : appFileAt(path, sha))));
    batch.forEach((path, k) => files.set(path, got[k]));
  }
  for (const [path, bytes] of files) {
    if (!bytes || !ids.has(path)) {
      throw new Error(`${path} is missing from it`);
    }
    if (await gitBlobId(bytes) !== ids.get(path)) {
      throw new Error(`${path} did not download intact`);
    }
    const text = bytesToText(bytes);
    if (path.endsWith(".js")) {
      try {
        new Function(text);
      } catch (error) {
        throw new Error(`${path} does not parse (${error.message})`);
      }
    } else if (path === "index.html" && (!/^\s*<!DOCTYPE html>/i.test(text) || !/<\/html>\s*$/i.test(text))) {
      throw new Error("its index.html is not a whole page");
    }
  }
  for (const match of bytesToText(files.get("index.html")).matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref) ||
      /^(config\.js|vault\.enc\.js|backup-(weekly|monthly)\.enc\.js)$/.test(ref)) {
      continue;
    }
    if (!files.has(ref)) {
      throw new Error(`its index.html loads ${ref}, which is not part of the build`);
    }
  }
  return files;
}

/**
 * The warnings for a build: the two things a tampered build would most want
 * to change, checked in its files. It no longer loads config.js (or reads
 * window.NOTES_CONFIG), or it no longer has ensurePrivateRepo.
 *
 * Used by: this file (offerAppUpdate).
 * Uses: bytesToText.
 * Complexity: O(b) in the build's scripts.
 */
function buildWarnings(files) {
  const js = [...files].filter(([path]) => path.endsWith(".js")).map(([, bytes]) => bytesToText(bytes)).join("\n");
  const warn = [];
  if (!/<script src="config\.js"><\/script>/.test(bytesToText(files.get("index.html"))) || !/\bwindow\.NOTES_CONFIG\b/.test(js)) {
    warn.push("It no longer takes the repo to sync with from your config.js.");
  }
  if (!/\bfunction ensurePrivateRepo\b/.test(js)) {
    warn.push("It no longer contains the check that refuses public repos.");
  }
  return warn;
}

// ---------- Reading a build ----------

/**
 * A version.js's APP_FILES, read as text and never run: the whole list, or
 * null when it holds anything but quoted names, is empty, has more than 200
 * or repeated entries, names a path an update may not write, or leaves out
 * index.html or version.js itself.
 *
 * Used by: this file (fetchBuild).
 * Uses: APP_PATH, MANIFEST.
 * Complexity: O(n) in the text.
 */
function filesOf(text) {
  const match = /\bconst APP_FILES = \[([^\]]*)\];/.exec(text || "");
  // Anything but quoted names.
  if (!match || /[^\s,]/.test(match[1].replace(/"[^"\\\n]*"/g, ""))) {
    return null;
  }
  const list = [...match[1].matchAll(/"([^"\\\n]*)"/g)].map(found => found[1]);
  if (!list.length || list.length > 200 || new Set(list).size !== list.length) {
    return null;
  }
  if (!list.every(path => APP_PATH.test(path)) || !list.includes("index.html") || !list.includes(MANIFEST)) {
    return null;
  }
  return list;
}

/**
 * One file as of one commit, as bytes (null when it is not there): what the
 * question describes is exactly what gets installed, and a cached older copy
 * can never stand in for it.
 *
 * Used by: this file (checkAppUpdate, fetchBuild).
 * Uses: ghRaw (sync.js).
 * Complexity: one request.
 */
async function appFileAt(path, sha) {
  const res = await ghRaw(`${path}?ref=${sha}`);
  return res.status === 404 ? null : new Uint8Array(await res.arrayBuffer());
}

/**
 * path -> blob id for the folders a build uses, at one commit: listed folder
 * by folder, so media/ and the rest of the repository are never listed.
 *
 * Used by: this file (fetchBuild).
 * Uses: ghApi (sync.js).
 * Complexity: one request per folder.
 */
async function treeIds(sha, paths) {
  const ids = new Map();
  const entries = tree => (tree && Array.isArray(tree.tree) ? tree.tree : []);
  const add = (tree, prefix) => {
    for (const entry of entries(tree)) {
      if (entry.type === "blob") {
        ids.set(prefix + entry.path, entry.sha);
      }
    }
  };
  const root = await ghApi(`git/trees/${sha}`);
  add(root, "");
  for (const dir of new Set(paths.filter(path => path.includes("/")).map(path => path.split("/")[0]))) {
    const entry = entries(root).find(item => item.type === "tree" && item.path === dir);
    if (entry && /^[0-9a-f]{40}$/.test(entry.sha)) {
      add(await ghApi(`git/trees/${entry.sha}`), dir + "/");
    }
  }
  return ids;
}

/**
 * The id git gives a file's content: SHA-1 of "blob <length>\0" and the
 * bytes, the blob id its commit's tree lists.
 *
 * Used by: this file (fetchBuild).
 * Uses: nothing.
 * Complexity: O(n) in the bytes.
 */
async function gitBlobId(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Writing a build ----------

/**
 * The folder this page was opened from, to write the new files into, or
 * null. Only a folder holding the running page and its js/version.js will
 * do (anywhere else the update would land beside nothing, and it is
 * downloaded instead). The remembered backup folder is used when it is that
 * folder; a different one chosen for backups is left as it is.
 *
 * Used by: this file (offerAppUpdate).
 * Uses: appFolderInfo and startInFor (backups.js), idbGet and idbPut
 * (vault.js), isAppDir, alertModal (modal.js).
 * Complexity: O(1), besides the picker.
 */
async function appDirHandle() {
  if (!("showDirectoryPicker" in window)) {
    return null;
  }
  const app = appFolderInfo();
  const page = app ? app.file : "index.html";
  let saved = null;
  try {
    const record = await idbGet("__notesDir__");
    saved = (record && record.bytes) || null;
  } catch {}
  try {
    if (saved && (await saved.queryPermission({ mode: "readwrite" }) === "granted" ||
        await saved.requestPermission({ mode: "readwrite" }) === "granted") && await isAppDir(saved, page)) {
      return saved;
    }
    const handle = await window.showDirectoryPicker({ id: "notes-folder", mode: "readwrite", startIn: startInFor(app) });
    if (!await isAppDir(handle, page)) {
      await alertModal({ title: "That is not the app's folder",
        body: `The app is ${page} and its css and js folders, in:\n${app ? app.display : "the folder you opened it from"}\n\n"${handle.name}" does not hold them, so the update is downloaded instead.` });
      return null;
    }
    if (!saved) {
      try {
        await idbPut("__notesDir__", handle);
      } catch {}
    }
    return handle;
  } catch {
    // Cancelled, or blocked on this origin.
    return null;
  }
}

/**
 * Writes a build into the app's folder. Every file is written to the side
 * first (a writable keeps what it is given in a swap file until it is
 * closed), and only when all of them are written are they put in place,
 * index.html last: a failure while writing leaves the old app exactly as it
 * was. A failure while putting them in place (rare: each is one rename)
 * says, in error.placed, how many made it.
 *
 * Used by: this file (offerAppUpdate).
 * Uses: nothing.
 * Complexity: O(b) in the build's bytes.
 */
async function writeBuild(dir, files, page) {
  const order = [...files.keys()].filter(path => path !== "index.html").concat("index.html");
  const open = [];
  try {
    for (const path of order) {
      const parts = path.split("/");
      let folder = dir;
      for (const sub of parts.slice(0, -1)) {
        folder = await folder.getDirectoryHandle(sub, { create: true });
      }
      const fileHandle = await folder.getFileHandle(path === "index.html" ? page : parts[parts.length - 1], { create: true });
      const writable = await fileHandle.createWritable();
      open.push(writable);
      await writable.write(files.get(path));
    }
  } catch (error) {
    for (const writable of open) {
      try {
        await writable.abort();
      } catch {}
    }
    error.placed = 0;
    throw error;
  }
  let placed = 0;
  try {
    for (const writable of open) {
      await writable.close();
      placed++;
    }
  } catch (error) {
    for (const writable of open.slice(placed + 1)) {
      try {
        await writable.abort();
      } catch {}
    }
    error.placed = placed;
    throw error;
  }
}

/**
 * Downloads the whole build as one ZIP, for a browser that cannot write to
 * the folder (or when writing failed): unpacked over the app's folder it is
 * the same update, and config.js is not in it. Not downloadPlain: that one
 * refuses once the vault is locked, and these files hold no note content.
 * Returns the ZIP's name.
 *
 * Used by: this file (offerAppUpdate).
 * Uses: zipBlob (zip.js).
 * Complexity: O(b) in the build's bytes.
 */
function downloadBuild(files, page, build) {
  const name = `notes-app-${build}.zip`;
  const url = URL.createObjectURL(zipBlob([...files].map(([path, bytes]) =>
    ({ name: path === "index.html" ? page : path, bytes }))));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}

// =================== Auxiliary functions ===================

/** A build ("2026-11-13.2") as [date, number]; ["0000-00-00", 0] when unreadable. Complexity: O(1). */
function buildParts(build) {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(String(build || ""));
  return match ? [match[1], +match[2]] : ["0000-00-00", 0];
}

/** Compares two builds: negative when a is older, 0 when equal, positive when newer. Complexity: O(1). */
function compareBuild(a, b) {
  const [dateA, numberA] = buildParts(a);
  const [dateB, numberB] = buildParts(b);
  return dateA < dateB ? -1 : dateA > dateB ? 1 : numberA - numberB;
}

/** The APP_BUILD a version.js declares, read with a regex (never run), or null. Complexity: O(n). */
function buildOf(text) {
  const match = /\bconst APP_BUILD = "(\d{4}-\d{2}-\d{2}\.\d+)"/.exec(text || "");
  return match ? match[1] : null;
}

/** What this device remembers about updates, or {}. Complexity: O(1). */
function loadAppMeta() {
  try {
    const meta = JSON.parse(localStorage.getItem("appUpdate"));
    if (meta && typeof meta === "object") {
      return meta;
    }
  } catch {}
  return {};
}

/** Remembers what this device knows about updates. Complexity: O(1). */
function saveAppMeta(meta) {
  try {
    localStorage.setItem("appUpdate", JSON.stringify(meta));
  } catch {}
}

/** UTF-8 bytes as text. Complexity: O(n). */
function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Whether a folder holds the running page and its js/version.js. Complexity: O(1). */
async function isAppDir(dir, page) {
  if (!await dirHasFile(dir, page)) {
    return false;
  }
  try {
    return await dirHasFile(await dir.getDirectoryHandle("js"), "version.js");
  } catch {
    return false;
  }
}
