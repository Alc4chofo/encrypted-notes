/*
 * sync.js - talking to GitHub: the guard that refuses anything but a private
 * repository, the calls every sync makes, and freezing the editor while a
 * sync runs.
 *
 * What travels. Only encrypted bytes ever leave the browser: the vault is
 * sealed with AES-256-GCM (key from PBKDF2-SHA256, 1,200,000 rounds; vault.js)
 * before it is uploaded, and attachments are encrypted on their own
 * (media-sync.js). The token travels in the Authorization header, to
 * api.github.com only.
 *
 * Why private only. A copy of the public mirror ships with placeholder
 * owner and repo values in config.js, and a fork of a public repository is
 * always public. Syncing there would let anyone download the encrypted vault
 * and guess passwords offline, as fast as their hardware allows (here one
 * guess costs about 0.6 s of PBKDF2, but a GPU runs many at once, so a weak
 * password would fall). ensurePrivateRepo refuses both cases before any
 * request is sent, and every call below goes through it. It must never be
 * weakened.
 *
 * Main functions: ensurePrivateRepo, gh, ghRaw, ghApi, ghGit, pushWrapper,
 * setEditingEnabled.
 * Auxiliary functions: ghError.
 *
 * Complexity: each call is one request (the privacy check is made once per
 * token and reused); the time is the network's.
 */
"use strict";

// ---------- State ----------

// Whether this copy has no usable repository set: still the public mirror's
// placeholders, or values that cannot be a GitHub user and repository name
// (a pasted address, a stray slash), so no request ever goes to a path
// nobody meant.
const REPO_UNSET = OWNER === "YOUR_GITHUB_USER" || REPO === "YOUR_PRIVATE_REPO" ||
  !/^[A-Za-z0-9-]{1,39}$/.test(OWNER) || !/^[A-Za-z0-9._-]{1,100}$/.test(REPO) || REPO === "." || REPO === "..";

// The privacy check, made once per token and reused for the session: { token, promise }.
let repoCheck = null;

// ---------- The repository guard ----------

/**
 * Resolves (with the repository's metadata, which names its default branch)
 * only for a repository that is set and private; rejects otherwise, before
 * anything is uploaded or downloaded:
 *   1. Placeholders still there, or impossible names: refused with kind
 *      "unset", and nothing is sent at all.
 *   2. The same token already checked: the stored answer is reused, so the
 *      extra request happens once.
 *   3. Otherwise GitHub is asked for the repository's own metadata, with the
 *      same token and media type as every other call, so the same access
 *      rules apply. A 401 or 404 means the token cannot see it (the usual
 *      "token rejected" help shows); only an explicit private: true passes,
 *      and public, or a missing field, is refused with kind "public".
 * A failed check is forgotten, so the next Sync asks again (say, after the
 * repository was made private).
 *
 * Used by: this file (gh, ghRaw, ghApi, ghGit), vaults.js (moveRepoVaultOnce).
 * Uses: REPO_UNSET, ghError.
 * Complexity: one request per token.
 */
function ensurePrivateRepo() {
  if (REPO_UNSET) {
    return Promise.reject(Object.assign(new Error("no repo set: edit owner and repo in config.js"), { guard: "unset" }));
  }
  if (repoCheck && repoCheck.token === vault.token) {
    return repoCheck.promise;
  }
  const promise = fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
  }).then(async res => {
    if (!res.ok) {
      throw await ghError(res);
    }
    const info = await res.json();
    if (info.private !== true) {
      throw Object.assign(new Error(`${OWNER}/${REPO} is public, refusing to upload`), { guard: "public" });
    }
    return info;
  });
  repoCheck = { token: vault.token, promise };
  promise.catch(() => {
    if (repoCheck && repoCheck.promise === promise) {
      repoCheck = null;
    }
  });
  return promise;
}

// ---------- Calls to GitHub ----------

/**
 * A contents-API call (GET, PUT or DELETE) on a file of the vault (vault.enc
 * by default), after the guard. A GET of a missing file is not an error (the
 * caller sees the 404); anything else that fails throws with its status.
 *
 * Used by: this file (pushWrapper), media-sync.js (deleteRemoteMedia,
 * overwriteRemote, runSync, syncOnce, and putMediaFile), backups.js (updateBackup).
 * Uses: ensurePrivateRepo, contentsApiUrl and vaultPath (core.js), FILE (core.js), ghError.
 * Complexity: one request.
 */
async function gh(method, body, path = vaultPath(FILE)) {
  await ensurePrivateRepo();
  const res = await fetch(contentsApiUrl(path), {
    method,
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !(method === "GET" && res.status === 404)) {
    throw await ghError(res);
  }
  return res;
}

/**
 * A raw download of a file, after the guard. The contents API's JSON answer
 * holds an empty content for any file between 1 MB and 100 MB, so a vault
 * past 1 MB and every real video must come through here, or they arrive
 * silently empty. A missing file is not an error (a missing attachment is a
 * placeholder, not a failure).
 *
 * Used by: media-sync.js (getMedia, syncOnce), updates.js (appFileAt).
 * Uses: ensurePrivateRepo, contentsApiUrl (core.js), ghError.
 * Complexity: one request.
 */
async function ghRaw(path) {
  await ensurePrivateRepo();
  const res = await fetch(contentsApiUrl(path), {
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok && res.status !== 404) {
    throw await ghError(res);
  }
  return res;
}

/**
 * A read-only call outside the contents API (the commits that touched a
 * file, for app updates), after the guard. Never answered from the browser
 * cache: GitHub allows a minute of it, long enough to miss a push made just
 * before a Sync.
 *
 * Used by: updates.js (checkAppUpdate, treeIds).
 * Uses: ensurePrivateRepo, repoApiUrl (core.js), ghError.
 * Complexity: one request.
 */
async function ghApi(sub) {
  await ensurePrivateRepo();
  const res = await fetch(repoApiUrl(sub), {
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw await ghError(res);
  }
  return res.json();
}

/**
 * A call to the git database (trees, commits, refs), after the guard:
 * moving a vault's files into its folder is one commit that reuses every
 * file as it is.
 *
 * Used by: vaults.js (moveRepoVaultOnce).
 * Uses: ensurePrivateRepo, repoApiUrl (core.js), ghError.
 * Complexity: one request.
 */
async function ghGit(method, sub, body) {
  await ensurePrivateRepo();
  const res = await fetch(repoApiUrl(sub), {
    method,
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    throw await ghError(res);
  }
  return res.json();
}

/**
 * Uploads the same encrypted vault as vault.enc.js, so a cloned repository
 * can load it with a script tag on the lock screen. Best effort: a failure
 * only makes the lock screen's detection stale on other machines, and their
 * first Sync pulls the truth.
 *
 * Used by: media-sync.js (overwriteRemote, syncOnce).
 * Uses: gh, vaultPath and WRAPPER (core.js), vaultWrapper (vaults.js).
 * Complexity: two requests.
 */
async function pushWrapper(sealed) {
  try {
    const res = await gh("GET", null, vaultPath(WRAPPER));
    const sha = res.status === 200 ? (await res.json()).sha : undefined;
    await gh("PUT", { message: "sync", content: btoa(vaultWrapper(sealed, vault.savedAt)), sha }, vaultPath(WRAPPER));
  } catch {}
}

// ---------- Freezing the editor during a sync ----------

/**
 * Freezes (on false) or thaws (on true) editing while the vault is on its
 * way: a save landing in the middle of a sync could change whether it pulls
 * or pushes, or be marked synced without having been pushed. A
 * contenteditable <div> has no disabled, so applyReadonly (which reads
 * syncing, already set before this call) turns the text off and
 * pointer-events stops attachments being dragged; menus and inline inputs
 * left open are closed, so they cannot commit in the middle either.
 *
 * Used by: media-sync.js (overwriteRemote, runSync), vaults.js (offerVaultMove).
 * Uses: applyReadonly (pagination.js), closeMenu (menu.js), inlineEdit (core.js).
 * Complexity: O(p) in the sheets.
 */
function setEditingEnabled(on) {
  $("title").disabled = !on;
  $("editor").style.pointerEvents = $("sheets").style.pointerEvents = on ? "" : "none";
  $("new-note").disabled = $("new-folder").disabled = !on;
  applyReadonly();
  if (!on) {
    closeMenu();
    inlineEdit = null;
  }
}

// =================== Auxiliary functions ===================

/** A failed GitHub answer as an Error with its status (and GitHub's message, if it sent JSON). Complexity: O(1). */
async function ghError(res) {
  let msg = res.statusText || "";
  try {
    msg = (await res.json()).message || msg;
  } catch {}
  const err = new Error(`GitHub ${res.status}: ${msg}`);
  err.status = res.status;
  return err;
}
