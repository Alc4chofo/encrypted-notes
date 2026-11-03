// notes: App updates offered through Sync.
"use strict";

// ---------- App updates ----------
// Sync also looks for a newer build of the app in the repo, so a change made on
// one computer reaches the others. The app is the code that holds the
// password, so it never replaces itself silently: the user sees the new build,
// when it was committed, by whom and why, plus a warning if the new files would
// stop taking the repo from config.js or no longer refuse public repos, and
// chooses. The notes sync either way. Per device, in localStorage "appUpdate":
// the last commit looked at, its build, and a declined commit (not asked again
// until the app changes; Settings can always check by hand).
//
// A build is every file js/version.js lists in APP_FILES, all as of the commit
// that last changed js/version.js (every app change bumps APP_BUILD there), and
// each checked against the id git gave it in that commit. config.js is never
// part of a build: it holds your own repo and stays as you set it.
const MANIFEST = "js/version.js";
const buildParts = b => { const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(String(b || "")); return m ? [m[1], +m[2]] : ["0000-00-00", 0]; };
function compareBuild(a, b) {
  const [da, na] = buildParts(a), [db, nb] = buildParts(b);
  return da < db ? -1 : da > db ? 1 : na - nb;
}
const buildOf = text => { const m = /\bconst APP_BUILD = "(\d{4}-\d{2}-\d{2}\.\d+)"/.exec(text || ""); return m ? m[1] : null; };
// The only paths an update may write: index.html, and plain names in css/ and
// js/. So a tampered list can never reach config.js, the vault or backup files,
// or anything outside the app's folder.
const APP_PATH = /^(index\.html|css\/[a-z0-9][a-z0-9-]*\.css|js\/[a-z0-9][a-z0-9-]*\.js)$/;
// APP_FILES, read as text and never run: the whole list, or null.
function filesOf(text) {
  const m = /\bconst APP_FILES = \[([^\]]*)\];/.exec(text || "");
  if (!m || /[^\s,]/.test(m[1].replace(/"[^"\\\n]*"/g, ""))) return null;   // anything but quoted names
  const list = [...m[1].matchAll(/"([^"\\\n]*)"/g)].map(x => x[1]);
  if (!list.length || list.length > 200 || new Set(list).size !== list.length) return null;
  if (!list.every(p => APP_PATH.test(p)) || !list.includes("index.html") || !list.includes(MANIFEST)) return null;
  return list;
}
function loadAppMeta() {
  try { const m = JSON.parse(localStorage.getItem("appUpdate")); if (m && typeof m === "object") return m; } catch {}
  return {};
}
function saveAppMeta(m) { try { localStorage.setItem("appUpdate", JSON.stringify(m)); } catch {} }
const utf8 = bytes => new TextDecoder().decode(bytes);
// One file as of one commit, as bytes: what the dialog describes is exactly
// what gets installed, and a cached copy of an older version can never stand in for it.
async function appFileAt(path, sha) {
  const res = await ghRaw(`${path}?ref=${sha}`);
  return res.status === 404 ? null : new Uint8Array(await res.arrayBuffer());
}
// A newer build in the repo, or null. Only js/version.js (one small file) is
// read here, and only when its latest commit is one this device has not looked
// at; the other files come down when the update is offered.
async function checkAppUpdate(manual) {
  const list = await ghApi(`commits?path=${encodeURIComponent(MANIFEST)}&per_page=1`);
  if (!Array.isArray(list) || !list.length) return null;          // no js/version.js in the repo
  const commit = list[0];
  if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha || "")) return null;
  let meta = loadAppMeta();
  if (meta.commit !== commit.sha) {
    const bytes = await appFileAt(MANIFEST, commit.sha);
    if (bytes == null) return null;
    meta = { ...meta, commit: commit.sha, build: buildOf(utf8(bytes)) || "" };
    saveAppMeta(meta);
  }
  if (!meta.build || compareBuild(meta.build, APP_BUILD) <= 0) return null;
  // Already written this session: it runs from the next reload.
  if (!manual && (meta.declined === commit.sha || appUpdateWritten === commit.sha)) return null;
  return { build: meta.build, commit };
}
// The id git gives a file's content: the blob id its commit's tree lists.
async function gitBlobId(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(b => b.toString(16).padStart(2, "0")).join("");
}
// path -> blob id for the folders a build uses, at one commit. Folder by
// folder, so media/ and the rest of the repo are never listed.
async function treeIds(sha, paths) {
  const ids = new Map();
  const entries = tree => (tree && Array.isArray(tree.tree) ? tree.tree : []);
  const add = (tree, prefix) => { for (const e of entries(tree)) if (e.type === "blob") ids.set(prefix + e.path, e.sha); };
  const root = await ghApi(`git/trees/${sha}`);
  add(root, "");
  for (const dir of new Set(paths.filter(p => p.includes("/")).map(p => p.split("/")[0]))) {
    const e = entries(root).find(x => x.type === "tree" && x.path === dir);
    if (e && /^[0-9a-f]{40}$/.test(e.sha)) add(await ghApi(`git/trees/${e.sha}`), dir + "/");
  }
  return ids;
}
// Every file of the build as of its commit (path -> bytes), each matched against
// its blob id, so a cut-off or garbled download is caught, and each checked as a
// working file of its kind. Throws with a reason the status line can show.
async function fetchBuild(u) {
  const sha = u.commit.sha;
  const manifest = await appFileAt(MANIFEST, sha);
  const paths = manifest && filesOf(utf8(manifest));
  if (!paths || buildOf(utf8(manifest)) !== u.build) throw new Error("its js/version.js does not list the app's files");
  const ids = await treeIds(sha, paths);
  const files = new Map();
  for (let i = 0; i < paths.length; i += 6) {                 // a few requests at a time
    const batch = paths.slice(i, i + 6);
    const got = await Promise.all(batch.map(p => (p === MANIFEST ? manifest : appFileAt(p, sha))));
    batch.forEach((p, k) => files.set(p, got[k]));
  }
  for (const [path, bytes] of files) {
    if (!bytes || !ids.has(path)) throw new Error(`${path} is missing from it`);
    if (await gitBlobId(bytes) !== ids.get(path)) throw new Error(`${path} did not download intact`);
    const text = utf8(bytes);
    if (path.endsWith(".js")) {
      // Compiled, never run: a script that does not parse would leave a page that does nothing.
      try { new Function(text); } catch (e) { throw new Error(`${path} does not parse (${e.message})`); }
    } else if (path === "index.html" && (!/^\s*<!DOCTYPE html>/i.test(text) || !/<\/html>\s*$/i.test(text))) {
      throw new Error("its index.html is not a whole page");
    }
  }
  // Everything the new page loads must come with it (config.js and this
  // device's own files aside), or it would run with an old or a missing file.
  for (const m of utf8(files.get("index.html")).matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref) || /^(config\.js|vault\.enc\.js|backup-(weekly|monthly)\.enc\.js)$/.test(ref)) continue;
    if (!files.has(ref)) throw new Error(`its index.html loads ${ref}, which is not part of the build`);
  }
  return files;
}
// The two things a tampered build would most want to change, checked in its files.
function buildWarnings(files) {
  const js = [...files].filter(([p]) => p.endsWith(".js")).map(([, b]) => utf8(b)).join("\n");
  const warn = [];
  if (!/<script src="config\.js"><\/script>/.test(utf8(files.get("index.html"))) || !/\bwindow\.NOTES_CONFIG\b/.test(js))
    warn.push("It no longer takes the repo to sync with from your config.js.");
  if (!/\bfunction ensurePrivateRepo\b/.test(js)) warn.push("It no longer contains the check that refuses public repos.");
  return warn;
}
let appUpdateWritten = null, appUpdateBusy = false;
// The folder this page was opened from, to write the new files into. Only a
// folder holding the running page and its js/version.js will do; anywhere else
// the update would land beside nothing, and it is downloaded instead. The
// remembered backup folder is used when it is that folder; a different one the
// user chose for backups is left as it is.
async function isAppDir(dir, page) {
  if (!await dirHasFile(dir, page)) return false;
  try { return await dirHasFile(await dir.getDirectoryHandle("js"), "version.js"); } catch { return false; }
}
async function appDirHandle() {
  if (!("showDirectoryPicker" in window)) return null;
  const app = appFolderInfo(), page = app ? app.file : "index.html";
  let saved = null;
  try { const rec = await idbGet("__notesDir__"); saved = (rec && rec.bytes) || null; } catch {}
  try {
    if (saved && (await saved.queryPermission({ mode: "readwrite" }) === "granted" ||
        await saved.requestPermission({ mode: "readwrite" }) === "granted") && await isAppDir(saved, page)) return saved;
    const handle = await window.showDirectoryPicker({ id: "notes-folder", mode: "readwrite", startIn: startInFor(app) });
    if (!await isAppDir(handle, page)) {
      await alertModal({ title: "That is not the app's folder",
        body: `The app is ${page} and its css and js folders, in:\n${app ? app.display : "the folder you opened it from"}\n\n"${handle.name}" does not hold them, so the update is downloaded instead.` });
      return null;
    }
    if (!saved) { try { await idbPut("__notesDir__", handle); } catch {} }
    return handle;
  } catch { return null; }   // cancelled, or blocked on this origin
}
// Writes the build into the app's folder. Every file is written to the side
// first (a writable keeps what it is given in a swap file until it is closed)
// and only when all of them are written are they put in place, index.html
// last: a failure while writing leaves the old app exactly as it was. A failure
// while putting them in place (rare: each is one rename) says how many made it.
async function writeBuild(dir, files, page) {
  const order = [...files.keys()].filter(p => p !== "index.html").concat("index.html");
  const open = [];
  try {
    for (const path of order) {
      const parts = path.split("/");
      let d = dir;
      for (const sub of parts.slice(0, -1)) d = await d.getDirectoryHandle(sub, { create: true });
      const fh = await d.getFileHandle(path === "index.html" ? page : parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      open.push(w);
      await w.write(files.get(path));
    }
  } catch (e) {
    for (const w of open) { try { await w.abort(); } catch {} }
    e.placed = 0;
    throw e;
  }
  let placed = 0;
  try {
    for (const w of open) { await w.close(); placed++; }
  } catch (e) {
    for (const w of open.slice(placed + 1)) { try { await w.abort(); } catch {} }
    e.placed = placed;
    throw e;
  }
}
// The whole build as one ZIP, for a browser that cannot write to the folder (or
// when writing failed): unpacked over the app's folder it is the same update,
// and config.js is not in it. Not downloadPlain: that one refuses once the vault
// is locked, and these files hold no note content.
function downloadBuild(files, page, build) {
  const name = `notes-app-${build}.zip`;
  const url = URL.createObjectURL(zipBlob([...files].map(([path, bytes]) => ({ name: path === "index.html" ? page : path, bytes }))));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
// Asks, and installs on yes. Returns true when the files were replaced or downloaded.
async function offerAppUpdate(u, manual) {
  // Only a complete, intact copy of the app is ever offered: part of one would
  // leave nothing that opens.
  let files;
  if (manual) status(`Fetching build ${u.build} to check it...`, false, true);
  try { files = await fetchBuild(u); } catch (e) {
    status(`The app in the repo is not a complete copy (${e.message}), so it was not offered`, true);
    return false;
  }
  if (manual) status("");
  const c = u.commit.commit || {};
  const when = (c.committer && c.committer.date) || (c.author && c.author.date) || "";
  const who = (c.author && c.author.name) || (u.commit.author && u.commit.author.login) || "unknown";
  const msg = String(c.message || "").split("\n")[0].trim().slice(0, 160);
  const warn = buildWarnings(files);
  const choice = await showModal({
    title: warn.length ? "Update the app? Read the warning first" : "Update the app?",
    body: `There is a newer build of the app in ${OWNER}/${REPO}:\n` +
      `build ${u.build} (this copy is build ${APP_BUILD}),\n` +
      `committed ${when ? new Date(when).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "on an unknown date"} by ${who}` + (msg ? `:\n"${msg}"` : ".") + "\n\n" +
      `It replaces the app's ${files.size} files: index.html and the css and js folders. config.js, your notes and your backups stay as they are.\n\n` +
      (warn.length ? "WARNING: " + warn.join(" ") + "\n\n" : "") +
      "Only update if you made this change yourself: anyone who can write to the repo could have pushed it, and the app runs whatever these files contain. Your notes sync either way.",
    choices: [
      { id: "update", label: "Update the app", danger: warn.length > 0 },
      { id: "skip", label: "Not now" },
    ],
    defaultId: "skip",
  });
  if (choice !== "update") {
    // Not asked again until the app changes; Settings can still install it.
    saveAppMeta({ ...loadAppMeta(), declined: u.commit.sha });
    return false;
  }
  // Straight away, while the click still counts as one: the folder picker and
  // the permission prompt only open under a fresh user action.
  const dir = await appDirHandle();
  const app = appFolderInfo(), page = app ? app.file : "index.html";
  let how = "download", placed = 0;
  if (dir) {
    try { await writeBuild(dir, files, page); how = "folder"; } catch (e) { placed = e.placed || 0; }
  }
  const zip = how === "download" ? downloadBuild(files, page, u.build) : null;
  appUpdateWritten = u.commit.sha;
  saveAppMeta({ ...loadAppMeta(), declined: null });
  status(how === "folder" ? `App updated to build ${u.build}: reload to use it` : `Downloaded ${zip} (build ${u.build})`);
  if (how === "download") {
    await alertModal({
      title: placed ? "Update only partly written" : "Update downloaded",
      body: (placed ? `Only ${placed} of the ${files.size} files could be put in place in "${dir.name}", so the app there is now a mix of two builds: do not reload before the step below.\n\n` : "") +
        `${zip} is in your downloads. Unpack it and copy everything in it (${page} and the css and js folders) over the app's folder` +
        (app ? `, in:\n${app.display}\n\n` : ", ") + "replacing the old files. config.js is not in it, so your settings stay. Then reload this page to use it.",
    });
  } else {
    const again = await showModal({
      title: "App updated",
      body: `The app in "${dir.name}" is now build ${u.build}. It takes effect when the page reloads, and the vault asks for your master password again.`,
      choices: [{ id: "reload", label: "Reload now" }, { id: "later", label: "Later" }],
      defaultId: "later",
    });
    if (again === "reload") {
      if (dirty) flushSave();
      // The save is a sealed write to localStorage; let it land first.
      await persistChain;
      location.reload();
    }
  }
  return true;
}
// The update step of a full Sync, run after the notes have synced. Never fails
// the sync: a check that cannot run (offline, rate limited) waits for the next.
async function appUpdateStep() {
  if (appUpdateBusy) return;
  appUpdateBusy = true;
  try {
    const u = await checkAppUpdate(false);
    if (u && vault) await offerAppUpdate(u, false);
  } catch {} finally { appUpdateBusy = false; }
}
// Settings > Check now: also offers a version declined before.
async function manualAppUpdate() {
  if (syncing || backupView || !vault || appUpdateBusy) return;
  appUpdateBusy = true;
  status("Checking the repo for a newer app...", false, true);
  try {
    const u = await checkAppUpdate(true);
    if (!u) { status(`This copy is up to date (build ${APP_BUILD})`); return; }
    await offerAppUpdate(u, true);
  } catch (e) {
    status("Could not check for an update: " + (e.guard ? ERR_EXPLAIN[e.guard] : e.message), true);
  } finally { appUpdateBusy = false; }
}
