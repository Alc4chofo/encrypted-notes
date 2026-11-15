/*
 * setup.js - getting a repository ready: the app as a ZIP for a new private
 * repository, and the app's own files put into the repository it syncs to.
 *
 * Every vault of one copy of the app syncs to the repository config.js
 * names, each in a folder of its own: a second vault needs no repository and
 * no change to config.js. For a vault in a repository of its own, "Set up a
 * new repository..." (under the new-vault form) asks for a GitHub user name
 * and a repository name and gives the whole app as one ZIP: index.html, the
 * css and js folders, the videos, a config.js already naming that
 * repository, and a short "Start here" with the steps. Unzipped anywhere, it
 * is a copy of the app ready for that repository.
 *
 * Other devices clone the app from the repository, and app updates come
 * from it, so the repository should hold the app too. When a Sync finds no
 * js/version.js there, it offers to put the app's files in (updates.js asks;
 * this file uploads), in one commit, behind the same private-repo guard as
 * every other request.
 *
 * The app's files are read with fetch() when the page is served, and from
 * the app's folder (File System Access, Chrome and Edge) when it is opened
 * from a file, where fetch() is blocked. The token help beside the token
 * field shows the first-time steps only while config.js names no repository.
 *
 * Main functions: downloadSetupZip, putAppInRepo, readAppFiles.
 * Auxiliary functions: appFileFrom, setupConfigText, startHereText, saveFile.
 *
 * Complexity: O(b) in the app's bytes (about 30 MB with the videos), read
 * once; putting the app in the repository is one upload per file and three
 * more requests.
 */
"use strict";

// The ways a GitHub user name and a repository name may be written (as sync.js checks config.js).
const SETUP_OWNER = /^[A-Za-z0-9-]{1,39}$/;
const SETUP_REPO = /^[A-Za-z0-9._-]{1,100}$/;

// ---------- The app as a ZIP for a new repository ----------

/**
 * "Download the app (.zip)": checks the two names, reads the app's files,
 * and saves one ZIP named after the repository, holding a folder of the same
 * name with the whole app, a config.js naming the repository and the steps
 * in "Start here.txt". Says on the lock screen what went wrong, if anything.
 *
 * Used by: this file (the button, and Enter in its two fields, on load).
 * Uses: readAppFiles, setupConfigText, startHereText, zipBlob (zip.js), saveFile.
 * Complexity: O(b) in the app's bytes.
 */
async function downloadSetupZip() {
  const owner = $("setup-owner").value.trim();
  const repo = $("setup-repo").value.trim();
  const say = (text, isError) => {
    $("lock-msg").style.color = isError ? "var(--bad)" : "var(--t3)";
    $("lock-msg").textContent = text;
  };
  if (!SETUP_OWNER.test(owner)) {
    say("Use your GitHub user name: letters, digits and dashes.", true);
    $("setup-owner").focus();
    return;
  }
  if (!SETUP_REPO.test(repo) || repo === "." || repo === "..") {
    say("Use the repository's name: letters, digits, dots, dashes and underscores.", true);
    $("setup-repo").focus();
    return;
  }
  say("Reading the app's files...", false);
  const files = await readAppFiles();
  if (!files) {
    say("Choose the app's own folder, the one with index.html, so its files can be read.", true);
    return;
  }
  files.delete("config.js");
  const entries = [...files].map(([path, bytes]) => ({ name: repo + "/" + path, bytes }));
  entries.push({ name: repo + "/config.js", bytes: textToBytes(setupConfigText(owner, repo)) });
  entries.push({ name: repo + "/" + t("Start here") + ".txt", bytes: textToBytes(startHereText(owner, repo)) });
  saveFile(zipBlob(entries), repo + ".zip");
  say(`${repo}.zip is in your downloads.`, false);
}

// ---------- The app in the repository it syncs to ----------

/**
 * Puts the app's own files into the repository, as one commit on the
 * default branch: index.html, config.js, the css and js folders and the
 * videos, each uploaded once. It tries again (after 1.5 s, then 3 s) when the
 * branch moved in between. Returns how many files went in.
 *
 * Used by: updates.js (when a Sync finds no app in the repository, and
 * Settings > Check now).
 * Uses: ensurePrivateRepo and ghGit (sync.js), readAppFiles, toBase64 (core.js).
 * Complexity: one upload per file, plus five requests.
 */
async function putAppInRepo() {
  const files = await readAppFiles();
  if (!files) {
    throw new Error("the app's files could not be read");
  }
  const blobs = [];
  for (const [path, bytes] of files) {
    const blob = await ghGit("POST", "git/blobs", { content: toBase64(bytes), encoding: "base64" });
    blobs.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const branch = (await ensurePrivateRepo()).default_branch || "main";
      const head = (await ghGit("GET", "git/ref/heads/" + encodeURIComponent(branch))).object.sha;
      const commit = await ghGit("GET", "git/commits/" + head);
      const tree = await ghGit("POST", "git/trees", { base_tree: commit.tree.sha, tree: blobs });
      const newCommit = await ghGit("POST", "git/commits", { message: "The app", tree: tree.sha, parents: [head] });
      await ghGit("PATCH", "git/refs/heads/" + encodeURIComponent(branch), { sha: newCommit.sha });
      return blobs.length;
    } catch (error) {
      if (!(error.status === 422 || error instanceof TypeError) || attempt >= 2) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

/**
 * The app's own files as a Map of path to bytes: every file in APP_FILES,
 * config.js, the lock screen's video and the backgrounds found next to
 * index.html. Read with fetch() when the page is served; from the app's
 * folder when it is opened from a file (asking for the folder if needed).
 * null when they cannot be read (no folder given, or not the app's).
 *
 * Used by: this file (downloadSetupZip, putAppInRepo).
 * Uses: APP_FILES (version.js), appBackgrounds and findAppBackgrounds
 * (background.js), notesDirHandle (backups.js), lockBgFile (lock.js),
 * appFileFrom.
 * Complexity: O(b) in their bytes.
 */
async function readAppFiles() {
  let folder = null;
  if (location.protocol === "file:") {
    folder = await notesDirHandle();
    if (!folder || !await appFileFrom(folder, "js/version.js").catch(() => null)) {
      return null;
    }
  }
  await findAppBackgrounds();
  const paths = [...APP_FILES, "config.js", ...appBackgrounds];
  const lockVideo = lockBgFile();
  if (lockVideo) {
    paths.push(lockVideo);
  }
  const files = new Map();
  for (const path of paths) {
    files.set(path, await appFileFrom(folder, path));
  }
  return files;
}

// ---------- On load ----------

$("setup-repo-btn").onclick = () => {
  const box = $("repo-setup");
  const open = box.style.display === "none";
  box.style.display = open ? "flex" : "none";
  $("setup-repo-btn").setAttribute("aria-expanded", String(open));
  if (open && !$("setup-owner").value && !REPO_UNSET) {
    $("setup-owner").value = OWNER;
  }
  if (open) {
    $("setup-owner").focus();
  }
};
$("setup-download").onclick = downloadSetupZip;
for (const field of [$("setup-owner"), $("setup-repo")]) {
  field.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      // Inside the unlock form, Enter would otherwise submit it.
      event.preventDefault();
      downloadSetupZip();
    }
  });
}

// The token help: the first-time steps while config.js names no repository;
// once it does, a word on the repository every vault already shares.
for (const step of document.querySelectorAll("#token-help .th-setup")) {
  step.hidden = !REPO_UNSET;
}
for (const step of document.querySelectorAll("#token-help .th-shared")) {
  step.hidden = REPO_UNSET;
}
$("th-repo").textContent = OWNER + "/" + REPO;

// =================== Auxiliary functions ===================

/** One of the app's files as bytes, from its folder, or fetched when there is none. Complexity: O(size). */
async function appFileFrom(folder, path) {
  if (!folder) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(path + " could not be read");
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  const parts = path.split("/");
  let dir = folder;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part);
  }
  const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** The config.js of a copy for this repository, as the app's own one reads. Complexity: O(1). */
function setupConfigText(owner, repo) {
  return "// notes: Your settings, the one file of the app you edit.\n" +
    "//\n" +
    "// The private GitHub repository this copy syncs to: the names only, not a link.\n" +
    "// Sync refuses any repository GitHub does not report as private. App updates\n" +
    "// never replace this file.\n" +
    `window.NOTES_CONFIG = { owner: ${JSON.stringify(owner)}, repo: ${JSON.stringify(repo)} };\n`;
}

/** The steps in "Start here.txt", in the app's language. Complexity: O(1). */
function startHereText(owner, repo) {
  return [
    t("notes, ready for {0}", `github.com/${owner}/${repo}`),
    "",
    "1. " + t("On GitHub, create the repository {0} and make it Private: {1}", repo, "https://github.com/new"),
    "2. " + t("Unzip this folder wherever you like and open index.html in Chrome or Edge."),
    "3. " + t("Choose a master password, paste a fine-grained token for {0} (Contents: Read and write; Expiration: No expiration) and press Create vault.", repo),
    "4. " + t("Press Sync. The first Sync offers to put the app's files in the repository too, so other devices can clone it and get updates from it."),
    "",
  ].join("\r\n");
}

/** Hands a file to the browser's downloads. Complexity: O(1). */
function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
