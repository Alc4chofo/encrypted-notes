// notes: The merge engine.
"use strict";

// ---------- Merge engine ----------
// Key-order-independent structural equality. Never compare sealed bytes: a
// fresh random IV makes two seals of the same vault differ every time.
function stable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
// What "content differs" means for a note: everything except mtime.
// order is appended ONLY when it is a number, so a note that was never reordered
// hashes byte-identically on an upgraded and a not-yet-upgraded device (no mass-fork
// on the first cross-version sync). bodyV is intentionally NOT hashed: it always
// travels with an HTML body, and hashing the body string already covers content.
const noteKey = n => {
  if (!n) return "";
  const base = [n.title || "", n.body || "", n.color || null, n.folderId || null,
    (n.media || []).map(m => [m.id, m.mime, m.name, m.size])];
  if (typeof n.order === "number") base.push(n.order);
  return stable(base);
};
// noteKey WITHOUT order: lets the merge detect "the two versions differ ONLY in
// order" (the reorder-no-fork branch in mergeVaults).
const contentKey = n => n ? stable([n.title || "", n.body || "", n.color || null, n.folderId || null,
  (n.media || []).map(m => [m.id, m.mime, m.name, m.size])]) : "";
// Text+media only (no color/folder/order): a reorder racing a recolor or refile
// touches disjoint fields, so it must merge rather than fork a conflict copy.
const textKey = n => n ? stable([n.title || "", n.body || "",
  (n.media || []).map(m => [m.id, m.mime, m.name, m.size])]) : "";
const sameMediaSet = (a, b) =>
  stable((a.media || []).map(m => [m.id, m.mime, m.name, m.size])) ===
  stable((b.media || []).map(m => [m.id, m.mime, m.name, m.size]));
// Reorder-vs-reorder / seed-vs-seed on the same note: newer mtime wins, ties broken by
// the larger order. Symmetric across devices (argument order never matters), so two
// devices converge on one winner and no note ever forks a conflict copy over order alone.
// If orders also tie, the versions are noteKey-identical so the pick is immaterial.
const orderWinner = (a, b) => (a.mtime || 0) !== (b.mtime || 0)
  ? ((a.mtime || 0) > (b.mtime || 0) ? a : b)
  : ((a.order || 0) >= (b.order || 0) ? a : b);
// The order VALUE to carry forward: the winner's if it has one, else the other
// side's, so a seed (which stamped order) racing a newer body edit (which did
// not) keeps the seeded position instead of dropping to undefined and sorting
// the note to the bottom of its group.
const mergedOrder = (a, b) => {
  const w = orderWinner(a, b);
  return w.order !== undefined ? w.order : (a.order !== undefined ? a.order : b.order);
};
const pickMax = (a, b) => (a == null ? (b == null ? null : b) : (b == null ? a : Math.max(a, b)));
const setOrDel = (map, k, v) => { if (v == null) delete map[k]; else map[k] = v; };
function countDiff(a, b) {
  let n = 0;
  for (const k in a) if (!(k in b) || stable(a[k]) !== stable(b[k])) n++;
  for (const k in b) if (!(k in a)) n++;
  return n;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// UTC with fixed month names on purpose: both devices must format the LOSER's
// mtime byte-identically or their conflict copies differ in title, get detected
// as a new conflict on the next sync, and fork forever.
function conflictStamp(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Deterministic on both devices: the argument order never affects the outcome.
// Winner = newer mtime, ties broken by the larger SHA-256(title+" "+body) hex.
// The copy id is derived (never crypto.randomUUID) so both devices mint the
// same id and the union dedupes instead of forking twice.
async function resolveConflict(id, a, b) {
  const am = a.mtime || 0, bm = b.mtime || 0;
  let winner, loser;
  if (am !== bm) { winner = am > bm ? a : b; loser = am > bm ? b : a; }
  else {
    // Hash the SAME key the divergence was detected with (noteKey covers color
    // and folderId too), or two versions differing only in color would hash
    // equal, be declared identical, and one side's change would vanish.
    const ha = await sha256Hex(noteKey(a));
    const hb = await sha256Hex(noteKey(b));
    if (ha === hb) return { winner: am >= bm ? a : b, copy: null, cid: null };
    winner = ha > hb ? a : b;
    loser = ha > hb ? b : a;
  }
  const cid = "c-" + (await sha256Hex(id + ":" + (loser.mtime || 0) + ":" + (winner.mtime || 0))).slice(0, 16);
  // Body, media, folderId, color and mtime are the loser's, UNCHANGED; only the
  // title gains the suffix, stamped from the loser's mtime (never Date.now()).
  const copy = { ...loser, media: (loser.media || []).map(m => ({ ...m })) };
  copy.title = (loser.title || "") + " (conflict " + conflictStamp(loser.mtime || 0) + ")";
  return { winner, loser, copy, cid };
}

// Scope: null = everything (syncAll). Otherwise { ids, folders } where ids
// covers the note/trash/purged keyspace (note ids AND the media ids they
// reference, which share that keyspace) and folders covers folder ids.
function scopeAddNote(scope, v, id) {
  scope.ids.add(id);
  const n = v.notes[id];
  if (n) for (const m of (n.media || [])) scope.ids.add(m.id);
  const t = v.trash[id];
  if (t && t.data) for (const m of (t.data.media || [])) scope.ids.add(m.id);
}
function scopeForNote(id) {
  const s = { ids: new Set(), folders: new Set(), label: "note" };
  scopeAddNote(s, vault, id);
  return s;
}
function scopeForFolder(fid) {
  // Scope covers the whole subtree: syncing a parent without its children would
  // push a vault where the child folders look locally deleted.
  const sub = new Set([fid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const id in vault.folders) if (!sub.has(id) && sub.has(parentOf(id))) { sub.add(id); grew = true; }
  }
  const s = { ids: new Set(), folders: sub, label: "folder", folderScan: sub };
  for (const id in vault.notes) if (sub.has(vault.notes[id].folderId)) scopeAddNote(s, vault, id);
  for (const id in vault.trash) {
    const d = vault.trash[id].data;
    if (d && sub.has(d.folderId)) scopeAddNote(s, vault, id);
  }
  return s;
}
// A per-note sync of a note the remote has trashed/purged, or whose remote copy
// carries extra attachments, must see those ids or it resurrects the note and
// leaves half the media behind.
function augmentScope(scope, remote) {
  for (const id of [...scope.ids]) scopeAddNote(scope, remote, id);
  if (scope.folderScan) {
    const sub = scope.folderScan;   // Set of subtree folder ids (same Set as scope.folders)
    // The remote may hold subfolders this device has never seen (created or
    // re-parented elsewhere): grow the subtree along remote parentId links to a
    // fixpoint, or a scoped folder sync silently skips them and their notes.
    for (let grew = true; grew;) {
      grew = false;
      for (const id in remote.folders) {
        const p = remote.folders[id].parentId;
        if (!sub.has(id) && p && sub.has(p)) { sub.add(id); grew = true; }
      }
    }
    for (const id in remote.notes) if (sub.has(remote.notes[id].folderId)) scopeAddNote(scope, remote, id);
    for (const id in remote.trash) {
      const d = remote.trash[id].data;
      if (d && sub.has(d.folderId)) scopeAddNote(scope, remote, id);
    }
    for (const id of [...scope.ids]) scopeAddNote(scope, vault, id);
  }
}

// True when the remote holds anything OUTSIDE the scope that this device has
// not seen. If so the scoped PUT must not record remoteSha, or the sha fast
// path would mask those changes forever.
function computeOutOfScopeDiverged(local, remote, scope) {
  const inN = id => scope.ids.has(id), inF = id => scope.folders.has(id);
  for (const id in remote.notes) if (!inN(id) && syncMeta.noteMtimes[id] !== remote.notes[id].mtime) return true;
  for (const id in local.notes) if (!inN(id) && !remote.notes[id]) return true;
  for (const id in remote.trash) if (!inN(id) && syncMeta.trashSeen[id] !== remote.trash[id].deletedAt) return true;
  for (const id in local.trash) if (!inN(id) && !remote.trash[id]) return true;
  for (const id in remote.folders) if (!inF(id) && syncMeta.folderMtimes[id] !== remote.folders[id].mtime) return true;
  for (const id in local.folders) if (!inF(id) && !remote.folders[id]) return true;
  for (const id in remote.purged) if (!inN(id) && !inF(id) && !(id in local.purged)) return true;
  for (const id in local.purged) if (!inN(id) && !inF(id) && !(id in remote.purged)) return true;
  return false;
}

// Merges local against remote and returns BOTH results:
//   info.local  = the maps the local vault must take
//   info.pushed = the blob to PUT (the remote vault with only in-scope entries
//                 replaced; implementers must never rebuild it from the local
//                 vault, or a scoped sync would wipe everything else remotely)
// For syncAll the scope covers every id, so the two agree everywhere.
async function mergeVaults(local, remote, scope, exclude) {
  const lN = { ...local.notes }, lF = { ...local.folders }, lT = { ...local.trash }, lP = { ...local.purged };
  const rN = { ...remote.notes }, rF = { ...remote.folders }, rT = { ...remote.trash }, rP = { ...remote.purged };
  const info = { lost: [], replaced: [], added: [], conflicts: [], risky: [], newIds: [],
    resurrectedMedia: [], outOfScopeDiverged: false };

  const folderIds = new Set([...Object.keys(local.folders), ...Object.keys(remote.folders)]);
  let ids;
  if (scope) ids = new Set(scope.ids);
  else {
    ids = new Set([...Object.keys(local.notes), ...Object.keys(remote.notes),
      ...Object.keys(local.trash), ...Object.keys(remote.trash),
      ...Object.keys(local.purged), ...Object.keys(remote.purged)]);
    for (const f of folderIds) ids.delete(f);   // folder ids are resolved in the folder pass
  }
  const fids = scope ? new Set(scope.folders) : folderIds;

  for (const id of ids) {
    if (exclude && exclude.has(id)) continue;   // stale-device guard: leave both sides alone
    const ln = local.notes[id], rn = remote.notes[id];
    const lt = local.trash[id], rt = remote.trash[id];
    const base = syncMeta.noteMtimes[id];
    let pg = pickMax(local.purged[id], remote.purged[id]);
    let live = null, copy = null, cid = null;

    if (ln && rn) {
      if (noteKey(ln) === noteKey(rn)) {
        live = (rn.mtime || 0) > (ln.mtime || 0) ? rn : ln;      // same content, keep the newer stamp
      } else if (base === undefined) {
        // Missing base (restored backup, second device's first sync, wiped
        // localStorage): plain newer-mtime-wins, never a conflict copy, or one
        // copy per note would explode out of every restore. vault.prev is the
        // safety net for this path.
        live = (rn.mtime || 0) > (ln.mtime || 0) ? rn : ln;
      } else if (contentKey(ln) === contentKey(rn)) {
        // The two versions differ ONLY in order (a reorder on one/both devices, or a
        // one-time seed): pick a single deterministic winner instead of forking, so the
        // devices converge and no note is lost.
        live = orderWinner(ln, rn);
      } else if (textKey(ln) === textKey(rn)) {
        // Same text/media, different order AND different color-or-folder: a reorder
        // racing a recolor/refile is not a real conflict either. Newer mtime carries
        // its color/folder; the surviving note takes the order winner's position.
        const w = (rn.mtime || 0) > (ln.mtime || 0) ? rn : ln;
        live = { ...w, order: mergedOrder(ln, rn) };
      } else if (((ln.mtime || 0) > base && (rn.mtime || 0) > base) || (ln.mtime || 0) === (rn.mtime || 0)) {
        // A reorder racing a body/title edit is still non-overlapping: merge the
        // newer text with the order winner's position instead of forking a copy.
        if ((ln.folderId || null) === (rn.folderId || null) && sameMediaSet(ln, rn) &&
            (ln.mtime || 0) !== (rn.mtime || 0)) {
          const w = (rn.mtime || 0) > (ln.mtime || 0) ? rn : ln;
          live = { ...w, order: mergedOrder(ln, rn) };
        } else {
          const r = await resolveConflict(id, ln, rn);          // true conflict: keep both
          live = r.winner;
          copy = r.copy;
          cid = r.cid;
        }
      } else {
        live = (rn.mtime || 0) > (ln.mtime || 0) ? rn : ln;
      }
    } else live = ln || rn || null;

    // Trash: union by id, newer deletedAt wins.
    let tr = (lt && rt) ? ((rt.deletedAt || 0) > (lt.deletedAt || 0) ? rt : lt) : (lt || rt || null);

    // Trash vs live, and clean up the loser on BOTH sides so it cannot come back.
    if (live && tr) {
      const mt = live.mtime || 0, dt = tr.deletedAt || 0;
      if (mt > dt) tr = null;
      else {
        // Keep whichever note object is newer INSIDE the trash entry, so a
        // divergent live edit is preserved rather than dropped.
        const inner = (tr.data && (tr.data.mtime || 0) >= mt) ? tr.data : live;
        tr = { data: inner, deletedAt: dt };
        live = null;
        copy = null; cid = null;   // no point forking a note that is in the bin
      }
    }

    // One tombstone rule, self-cleaning: a survivor deletes its own tombstone so
    // it cannot be re-killed on a later sync or on a third device (this is what
    // makes "restore from trash" beat a remote permanent delete).
    if (pg != null) {
      if (live) { if (pg >= (live.mtime || 0)) live = null; else pg = null; }
      else if (tr) { if (pg >= (tr.deletedAt || 0)) tr = null; else pg = null; }
    }

    setOrDel(lN, id, live); setOrDel(lT, id, tr); setOrDel(lP, id, pg);
    setOrDel(rN, id, live); setOrDel(rT, id, tr); setOrDel(rP, id, pg);
    if (copy && cid) {
      if (!local.notes[cid]) lN[cid] = copy;
      if (!remote.notes[cid]) rN[cid] = copy;
      info.conflicts.push(copy.title);
      info.newIds.push(cid);   // a scoped sync must record its base too, or it shows a false dot
    }

    // Local-facing diff, and the "risky" list the confirm dialog is built from.
    const t = n => (n && n.title) || "(untitled)";
    if (ln && !live && !tr) info.lost.push(t(ln));
    else if (ln && live && noteKey(live) !== noteKey(ln)) info.replaced.push(t(ln));
    else if (!ln && live) info.added.push(t(live));
    if (ln && !copy) {
      const wasUnsynced = !(id in syncMeta.noteMtimes) || (ln.mtime || 0) > syncMeta.noteMtimes[id];
      const keptInTrash = tr && tr.data && noteKey(tr.data) === noteKey(ln);
      if (wasUnsynced && !keptInTrash && (!live || noteKey(live) !== noteKey(ln))) info.risky.push(t(ln));
    }
  }

  for (const fid of fids) {
    if (exclude && exclude.has(fid)) continue;
    const lf = local.folders[fid], rf = remote.folders[fid];
    let pg = pickMax(local.purged[fid], remote.purged[fid]);
    let f = (lf && rf) ? ((rf.mtime || 0) > (lf.mtime || 0) ? rf : lf) : (lf || rf || null);
    if (pg != null && f) { if (pg >= (f.mtime || 0)) f = null; else pg = null; }
    setOrDel(lF, fid, f); setOrDel(lP, fid, pg);
    setOrDel(rF, fid, f); setOrDel(rP, fid, pg);
  }

  // A tombstoned media id that something still references (a conflict copy
  // shares media ids with its original) loses its tombstone: no-data-loss means
  // the reference wins over the delete.
  const refs = new Set();
  const addRefs = (N, T) => {
    for (const k in N) for (const m of (N[k].media || [])) refs.add(m.id);
    for (const k in T) { const d = T[k].data; if (d) for (const m of (d.media || [])) refs.add(m.id); }
  };
  addRefs(lN, lT); addRefs(rN, rT);
  // Scoped syncs only clear tombstones for ids they own, or a per-note sync
  // would mutate the pushed blob outside its scope.
  const inScope = id => !exclude || !exclude.has(id);
  for (const id in lP) if (refs.has(id) && inScope(id)) { delete lP[id]; info.resurrectedMedia.push(id); }
  for (const id in rP) if (refs.has(id) && inScope(id)) { delete rP[id]; info.resurrectedMedia.push(id); }

  // token: local wins, remote fills in (a vault restored from a token-less
  // backup re-acquires the token instead of pushing an empty one over it).
  const token = local.token || remote.token || null;

  // Media key ring: both sides converge on the same primary (smallest b64) and
  // keep every demoted key, so attachments sealed under either remain readable.
  const keySet = new Set([...(local.mediaKeysOld || []), ...(remote.mediaKeysOld || [])]);
  if (local.mediaKey) keySet.add(local.mediaKey);
  if (remote.mediaKey) keySet.add(remote.mediaKey);
  const allKeys = [...keySet].sort();
  // NOT named mk: that is the global DOM element helper, and shadowing it here
  // would make any future element built inside this function throw.
  const mkey = allKeys[0] || null;
  const mkOld = allKeys.slice(1);

  info.mediaKey = mkey;
  info.mediaKeysOld = mkOld;
  // Presets: per-id last-write-wins, union of both sides. They must be listed
  // explicitly - info.local is built field by field, so anything omitted here is
  // dropped from this device on the next sync.
  const presets = {};
  for (const pid of new Set([...Object.keys(local.presets || {}), ...Object.keys(remote.presets || {})])) {
    const lp = (local.presets || {})[pid], rp = (remote.presets || {})[pid];
    presets[pid] = (lp && rp) ? ((rp.mtime || 0) > (lp.mtime || 0) ? rp : lp) : (lp || rp);
  }

  // Pins: per note id the newer change (pin OR unpin, by its `at`) wins, union of
  // both sides. Listed explicitly for the same reason as presets, and independent
  // of the notes themselves, so a pin never decides which version of a note survives.
  const pins = {};
  for (const id of new Set([...Object.keys(local.pins || {}), ...Object.keys(remote.pins || {})])) {
    const lp = (local.pins || {})[id], rp = (remote.pins || {})[id];
    // So if both sides have a record, the later one wins; with one record, that one is taken as is.
    if (lp && rp) pins[id] = (rp.at || 0) > (lp.at || 0) ? rp : lp;
    else pins[id] = lp || rp;
  }

  info.local = { notes: lN, folders: lF, trash: lT, purged: lP, presets, pins, token, mediaKey: mkey, mediaKeysOld: mkOld };
  info.pushed = { ...remote, v: 2, notes: rN, folders: rF, trash: rT, purged: rP, presets, pins, token,
    mediaKey: mkey, mediaKeysOld: mkOld };

  // "Changed nothing remotely" must be computable per id, never from bytes.
  const keyRingDiff = a => (a.mediaKey || null) !== mkey ||
    (a.mediaKeysOld || []).length !== mkOld.length;
  info.remoteChanged = countDiff(rN, remote.notes) + countDiff(rF, remote.folders) +
    countDiff(rT, remote.trash) + countDiff(rP, remote.purged) > 0 ||
    // A pin-only change on this device must still be pushed, so pins count as a remote change too.
    countDiff(pins, remote.pins || {}) > 0 ||
    (remote.token || null) !== token || keyRingDiff(remote);
  info.localDelta = countDiff(lN, local.notes) + countDiff(lF, local.folders) + countDiff(lT, local.trash);
  info.localChanged = info.localDelta > 0 || countDiff(lP, local.purged) > 0 ||
    // And a pin made on another device must be applied here.
    countDiff(pins, local.pins || {}) > 0 ||
    (local.token || null) !== token || keyRingDiff(local);
  if (scope) info.outOfScopeDiverged = computeOutOfScopeDiverged(local, remote, scope);
  return info;
}

// A device offline longer than the tombstone-prune window would resurrect
// permanently-deleted notes (their local copies look only-local because the
// tombstones are gone). Ask once per run; skipped ids stay untouched locally
// and are excluded from the PUT.
async function staleDeviceExclusions(remote, scope) {
  const t = syncMeta.lastSyncedAt;
  if (t == null || Date.now() - t < 90 * 86400e3) return null;
  const cand = Object.keys(vault.notes).filter(id =>
    (!scope || scope.ids.has(id)) && !remote.notes[id] && !remote.trash[id] && !(id in remote.purged));
  if (!cand.length) return null;
  const go = await confirmModal({
    title: "Push old local notes?",
    body: `${cand.length} note(s) on this device were deleted from the vault more than 90 days ago ` +
      `OR were never synced. Push them back into the repo?`,
    confirmLabel: "Push them", cancelLabel: "Skip them",
  });
  return go ? null : new Set(cand);
}

// Applies the merge to the live app state. Ordering matters: snapshot, apply +
// persist, PUT, and only then advance syncMeta. A crash between apply and
// syncMeta is safe - noteMtimes was not advanced, so everything still reads as
// unsynced and the next sync re-merges to the same result (idempotent).
async function applyMerge(info, remote) {
  // Snapshot guard. Refresh vault.prev when this merge is destructive (it drops
  // or replaces local notes) as well as when this device has unsynced work: a
  // pure-pull that deletes notes via remote tombstones is exactly the case the
  // Restore button is for, and it used to be handed a stale snapshot.
  // snapshotTakenThisRun keeps a 409 retry from overwriting the genuine
  // pre-merge state with the already-merged vault from the first attempt.
  if (!snapshotTakenThisRun &&
      (anyUnsynced() || info.lost.length || info.replaced.length || !localStorage.getItem(vkey("vault.prev")))) {
    localStorage.setItem(vkey("vault.prev"), await sealVault());
    localStorage.setItem(vkey("vault.prevAt"), String(vault.savedAt || 0));
    snapshotTakenThisRun = true;
  }
  revokeAllMediaUrls();   // every decrypted-media URL belongs to the pre-merge vault
  vault.notes = info.local.notes;
  vault.folders = info.local.folders;
  vault.trash = info.local.trash;
  vault.purged = info.local.purged;
  vault.presets = info.local.presets || vault.presets || {};
  // Adopt the merged pins, keeping the current map if a merge somehow produced none.
  vault.pins = info.local.pins || vault.pins || {};
  vault.token = info.local.token || vault.token;
  vault.v = 2;
  // Adopt the merged key ring before anything tries to decrypt pulled media.
  if (info.local.mediaKey) {
    vault.mediaKey = info.local.mediaKey;
    vault.mediaKeysOld = info.local.mediaKeysOld;
    await loadMediaKey();
  }
  // The open buffer may now be stale (or gone): re-seat it, or the next
  // keystroke would write the pre-merge text back with a fresh mtime.
  // Re-seated by its MERGED shape, the way openNote does it: a note turned into
  // pages on another device, shown here in the single-page editor from its old
  // body, had that stale body saved over its first page by the next keystroke.
  const reseat = n => {
    if (isPaged(n)) {
      currentPage = Math.min(currentPage, Math.max(0, notePages(n).length - 1));
      renderSheets();
      editorBaseline = sheetsSnapshot();
    } else {
      document.body.classList.remove("paged-view");
      $("sheets").innerHTML = "";
      currentPage = 0;
      setEditorBody(n.body, { bodyV: n.bodyV });
    }
    renderPageTabs();
  };
  if (currentId && !vault.notes[currentId]) {
    currentId = null;
    $("title").value = ""; clearEditor();
    document.body.classList.remove("paged-view"); $("sheets").innerHTML = ""; renderPageTabs();
  } else if (currentId) {
    $("title").value = vault.notes[currentId].title;
    reseat(vault.notes[currentId]);
  }
  if (trashViewId && !vault.trash[trashViewId]) {
    trashViewId = null;
    $("title").value = ""; clearEditor();
    document.body.classList.remove("paged-view"); $("sheets").innerHTML = ""; renderPageTabs();
  } else if (trashViewId) {
    const d = vault.trash[trashViewId].data || {};
    $("title").value = d.title || "";
    reseat(d);
  }
  applyReadonly();
  dirty = false;
  await persistLocal();
  if (info.lost.length || info.replaced.length) {
    pullDiff = { lost: info.lost, replaced: info.replaced, added: info.added, conflicts: info.conflicts };
    pullBanner = { at: Date.now(), remoteSavedAt: remote.savedAt || 0,
      lost: info.lost.length, replaced: info.replaced.length, added: info.added.length };
    localStorage.setItem(vkey("pullBanner"), JSON.stringify(pullBanner));
  }
  renderList();
  renderStatus();
  renderAttachments();
}
