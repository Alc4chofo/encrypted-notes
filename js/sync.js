// notes: Sync with the private repo, and the guard that refuses public repos.
"use strict";

// ---------- Sync ----------
// Freeze edits while the vault is in flight: a save landing mid-sync would
// flip the pull-vs-push decision or get marked synced without being pushed.
// renderStatus keeps Save/Delete consistent via the `syncing` flag.
function setEditingEnabled(on) {
  $("title").disabled = !on;
  // A contenteditable <div> has no `disabled`. Editability is driven by applyReadonly
  // (which reads `syncing`), and pointer-events blocks internal media DnD; together a
  // keystroke or drag can never land mid-sync. `syncing` is already set before this call.
  $("editor").style.pointerEvents = $("sheets").style.pointerEvents = on ? "" : "none";
  $("new-note").disabled = $("new-folder").disabled = !on;
  applyReadonly();   // re-assert contentEditable for the trash/sync state (thaw restores it)
  if (!on) { closeMenu(); inlineEdit = null; }   // stale menus/inputs cannot commit mid-sync
}

async function ghError(res) {
  let msg = res.statusText || "";
  try { msg = (await res.json()).message || msg; } catch {}   // raw responses are not JSON
  const err = new Error(`GitHub ${res.status}: ${msg}`);
  err.status = res.status;
  return err;
}

// ---------- Repo guard ----------
// Sync may only ever talk to a PRIVATE repo of the user's own. Copies of the
// public mirror ship with placeholder owner/repo values in config.js, and a fork
// of a public repo is always public: syncing there would let anyone download the
// vault and attack the password offline. Both are refused before any request is sent.
// REPO_UNSET compares the two settings against the public mirror's placeholders, so a copy nobody configured is caught.
// It also catches values that cannot be a GitHub user and repo name (a pasted URL, a
// stray slash), so no request ever goes to a path nobody meant.
const REPO_UNSET = OWNER === "YOUR_GITHUB_USER" || REPO === "YOUR_PRIVATE_REPO" ||
  !/^[A-Za-z0-9-]{1,39}$/.test(OWNER) || !/^[A-Za-z0-9._-]{1,100}$/.test(REPO) || REPO === "." || REPO === "..";
// repoCheck holds { token, promise }: the visibility check is made once per token and reused for the session.
let repoCheck = null;
function ensurePrivateRepo() {
  // So first I check the placeholders, and if they are still there I refuse with kind "unset" and send nothing.
  if (REPO_UNSET) return Promise.reject(Object.assign(new Error("no repo set: edit owner and repo in config.js"), { guard: "unset" }));
  // If this same token was already checked, the stored answer is reused, so the extra request happens once.
  if (repoCheck && repoCheck.token === vault.token) return repoCheck.promise;
  // Otherwise I ask GitHub for the repo's own metadata, which carries the private flag.
  const promise = fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
    // Same token and media type as every other call, so GitHub applies exactly the same access rules.
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
  }).then(async res => {
    // A 401/404 means this token cannot see the repo; ghError keeps the status, so the usual "token rejected" help shows.
    if (!res.ok) throw await ghError(res);
    // Only an explicit private:true passes; public, or a missing field, is refused with kind "public".
    if ((await res.json()).private !== true)
      throw Object.assign(new Error(`${OWNER}/${REPO} is public, refusing to upload`), { guard: "public" });
  });
  // The answer is remembered against the token it was made with, so a new token gets a fresh check.
  repoCheck = { token: vault.token, promise };
  // A failed check is forgotten, so the next Sync asks again (say, after the repo was made private).
  promise.catch(() => { if (repoCheck && repoCheck.promise === promise) repoCheck = null; });
  // The caller awaits this: it resolves for a private repo and rejects otherwise.
  return promise;
}

async function gh(method, body, path = FILE) {
  // Nothing reaches the repo until the guard has confirmed it is set and private.
  await ensurePrivateRepo();
  const res = await fetch(API(path), {
    method,
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !(method === "GET" && res.status === 404)) throw await ghError(res);
  return res;
}

// Raw GET. The contents API's JSON media type returns content:"" for any file
// between 1MB and 100MB, so both a vault past 1MB and every real-world video
// attachment MUST come back through this path or they silently arrive empty.
// 404-tolerant like gh("GET"): a missing media file is a placeholder, not a failure.
async function ghRaw(path) {
  // Downloads go through the same guard as uploads, so an unset or public repo is never even read from.
  await ensurePrivateRepo();
  const res = await fetch(API(path), {
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok && res.status !== 404) throw await ghError(res);
  return res;
}
// A read-only call outside the contents API (the list of commits that touched a
// file, for app updates), behind the same guard as gh and ghRaw. Never answered
// from the browser cache: GitHub allows a minute of it, long enough to miss a
// push made just before a Sync.
async function ghApi(sub) {
  await ensurePrivateRepo();
  const res = await fetch(REPO_API(sub), {
    headers: { Authorization: `Bearer ${vault.token}`, Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!res.ok) throw await ghError(res);
  return res.json();
}

// Mirror the exact same ciphertext as vault.enc.js so a cloned repo can load
// it via script tag on the lock screen. Best-effort: a failure here only makes
// auto-detect stale on other machines, and their first Sync pulls the truth.
async function pushWrapper(sealed) {
  try {
    const r = await gh("GET", null, WRAPPER);
    const sha = r.status === 200 ? (await r.json()).sha : undefined;
    await gh("PUT", { message: "sync", content: btoa("window.__VAULT__ = " + sealed + ";"), sha }, WRAPPER);
  } catch {}
}
