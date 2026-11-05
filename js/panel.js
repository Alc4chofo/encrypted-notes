// notes: The status detail panel.
"use strict";

// ---------- Detail panel ----------
function chipsOpen(on) {
  for (const c of document.querySelectorAll(".chip")) c.classList.toggle("open", on);
}
function openPanel() { panelOpen = true; $("status-detail").classList.add("open"); chipsOpen(true); renderDetail(); }
function closePanel() { panelOpen = false; $("status-detail").classList.remove("open"); chipsOpen(false); }
function togglePanel() { panelOpen ? closePanel() : openPanel(); }

function renderDetail() {
  const p = $("status-detail");
  p.innerHTML = "";
  const sections = [];

  if (dirty && currentId) {
    const s = mk("div");
    s.appendChild(mk("div", "detail-head", "Unsaved"));
    const row = mk("div", "detail-row");
    const t = $("title").value;
    row.appendChild(mk("span", "t" + (t ? "" : " untitled"), t || "(untitled)"));
    row.appendChild(mk("span", "m", "editing now"));
    const b = mk("button", null, "Save now");
    b.onclick = manualSave;
    row.appendChild(b);
    s.appendChild(row);
    sections.push(s);
  }

  // Enumerates all five v2 signals: notes, folders, trash entries, and the two
  // kinds of pending deletion.
  const uids = unsyncedIds().sort((a, b) => vault.notes[b].mtime - vault.notes[a].mtime);
  const ufids = unsyncedFolderIds().sort((a, b) => byName(folderName(a), folderName(b)));
  const utids = unsyncedTrashIds().sort((a, b) => (vault.trash[b].deletedAt || 0) - (vault.trash[a].deletedAt || 0));
  const delIds = pendingNoteDeletions(), delFids = pendingFolderDeletions();
  const total = uids.length + ufids.length + utids.length + delIds.length + delFids.length;
  if (total) {
    const s = mk("div");
    s.appendChild(mk("div", "detail-head", `Unsynced (${total})`));
    for (const id of uids) {
      const n = vault.notes[id];
      const row = mk("div", "detail-row click");
      row.appendChild(mk("span", "t" + (n.title ? "" : " untitled"), n.title || "(untitled)"));
      if (!(id in syncMeta.noteMtimes)) row.appendChild(mk("span", "m", "(new)"));
      row.appendChild(mk("span", "m", relTime(n.mtime)));
      row.onclick = () => { flushSave(); closePanel(); openNote(id); };
      s.appendChild(row);
    }
    for (const fid of ufids) {
      const row = mk("div", "detail-row");
      row.appendChild(mk("span", "t", folderName(fid)));
      row.appendChild(mk("span", "m", fid in syncMeta.folderMtimes ? "folder" : "folder (new)"));
      s.appendChild(row);
    }
    for (const id of utids) {
      const d = vault.trash[id].data || {};
      const row = mk("div", "detail-row click");
      row.appendChild(mk("span", "t" + (d.title ? "" : " untitled"), d.title || "(untitled)"));
      row.appendChild(mk("span", "m", "in trash"));
      row.onclick = () => { closePanel(); openTrash(id); };
      s.appendChild(row);
    }
    if (delIds.length) {
      const known = delIds.filter(id => id in deletedTitles);
      for (const id of known) {
        const row = mk("div", "detail-row");
        row.appendChild(mk("span", "t" + (deletedTitles[id] === "(untitled)" ? " untitled" : ""), deletedTitles[id]));
        row.appendChild(mk("span", "m", "deleted"));
        s.appendChild(row);
      }
      if (delIds.length > known.length) s.appendChild(mk("div", "detail-note",
        `${delIds.length - known.length} deleted note(s) not yet synced (titles unavailable after reload)`));
    }
    if (delFids.length) s.appendChild(mk("div", "detail-note",
      `${delFids.length} deleted folder(s) not yet synced`));
    const foot = mk("div", "detail-row");
    const b = mk("button", null, "Sync now");
    b.onclick = () => { closePanel(); $("sync").onclick(); };
    foot.appendChild(b);
    s.appendChild(foot);
    sections.push(s);
  }

  if (lastSyncError) {
    const s = mk("div");
    s.appendChild(mk("div", "detail-head", "Sync error"));
    s.appendChild(mk("div", "detail-note",
      new Date(lastSyncError.at).toLocaleString() +
      (lastSyncError.httpStatus ? ` (HTTP ${lastSyncError.httpStatus})` : "")));
    s.appendChild(mk("div", "detail-note", ERR_EXPLAIN[lastSyncError.kind]));
    if (lastSyncError.raw) s.appendChild(mk("div", "detail-note", lastSyncError.raw));
    if (lastSyncError.kind === "auth") {
      const row = mk("div", "detail-row");
      const inp = mk("input");
      inp.type = "password";
      inp.placeholder = "New fine-grained token";
      const b = mk("button", null, "Apply");
      b.onclick = async () => {
        const t = inp.value.trim();
        if (!t || backupView) return;   // never rewrite a read-only snapshot's token
        vault.token = t;
        await persistLocal();
        // The typed token must not outlive its use: this input lives in
        // #status-detail, which closePanel only hides (it is wiped on lock too).
        inp.value = "";
        lastSyncError = null;
        closePanel();
        renderStatus();
        status("Token updated, press Sync");
      };
      row.appendChild(inp);
      row.appendChild(b);
      s.appendChild(row);
    }
    if (lastSyncError.kind === "pwmismatch") {
      const row = mk("div", "detail-row");
      const b = mk("button", "danger", "Overwrite remote with local vault");
      b.onclick = overwriteRemote;
      row.appendChild(b);
      s.appendChild(row);
    }
    sections.push(s);
  }

  if (pullBanner) {
    const s = mk("div");
    s.appendChild(mk("div", "detail-head", "Last merge"));
    s.appendChild(mk("div", "detail-note", bannerText()));
    if (pullDiff) {
      for (const t of pullDiff.lost) s.appendChild(mk("div", "detail-note", `removed by the merge: ${t}`));
      for (const t of pullDiff.replaced) s.appendChild(mk("div", "detail-note", `local "${t}" replaced by the remote version`));
      for (const t of pullDiff.added) s.appendChild(mk("div", "detail-note", `new from remote: ${t}`));
      for (const t of (pullDiff.conflicts || [])) s.appendChild(mk("div", "detail-note", `conflict, both versions kept: ${t}`));
    } else if (pullBanner.lost + pullBanner.replaced + pullBanner.added > 0) {
      s.appendChild(mk("div", "detail-note",
        `${pullBanner.lost} removed, ${pullBanner.replaced} replaced, ` +
        `${pullBanner.added} new from remote (titles unavailable after reload)`));
    }
    if (localStorage.getItem(vkey("vault.prev"))) {
      const row = mk("div", "detail-row");
      const at = new Date(+localStorage.getItem(vkey("vault.prevAt")) || 0);
      const b = mk("button", null, `Restore pre-merge vault (${at.toLocaleString()})`);
      b.onclick = restorePrev;
      row.appendChild(b);
      s.appendChild(row);
    }
    sections.push(s);
  }

  if (!sections.length) { closePanel(); return; }
  const close = mk("button", "detail-close", "Close");
  close.onclick = closePanel;
  sections[0].querySelector(".detail-head").appendChild(close);
  for (const s of sections) p.appendChild(s);
}

async function restorePrev() {
  // backupView: this swaps the viewed snapshot for the real pre-merge vault
  // behind an unchanged "read-only" banner, so a later Convert would seal the
  // wrong vault over localStorage.
  if (syncing || backupView) return;
  const prev = localStorage.getItem(vkey("vault.prev"));
  if (!prev) return;
  const at = new Date(+localStorage.getItem(vkey("vault.prevAt")) || 0).toLocaleString();
  const ok = await confirmModal({
    title: "Restore pre-merge vault?",
    body: `Replace the current vault with the pre-merge snapshot from ${at}? Everything the merge brought in from the repo will be removed locally until the next sync.`,
    confirmLabel: "Restore", destructive: true,
  });
  if (!ok || !localStorage.getItem(vkey("vault.prev"))) return;
  try {
    const opened = await openVault(prev, masterPw);
    const tok = vault.token;
    revokeAllMediaUrls();   // the whole vault (and its media set) is being replaced
    // Take ONLY the vault: adopting the snapshot's key/salt/iter would silently
    // downgrade every future seal to the snapshot's KDF and orphan media
    // encrypted under the live key. The restored vault is re-sealed under the
    // current key by the persistLocal below.
    vault = opened.vault;
    vault.token = vault.token || tok;
    await loadMediaKey();   // the snapshot carries its own vault.mediaKey
    currentId = null; trashViewId = null; applyReadonly();
    $("title").value = ""; clearEditor();
    renderAttachments();
    dirty = false;
    // stamp=false: the snapshot keeps its own savedAt, so the next Sync sees
    // the remote as newer and re-offers the pull instead of overwriting it.
    await persistLocal(false);
    // The remote still matches the sha recorded by the merge we just undid, so
    // the sha fast path would skip the merge entirely and blind-push this
    // rollback over everything. Force the next sync through a real merge.
    syncMeta.remoteSha = null;
    syncMeta.syncedSavedAt = 0;
    saveSyncMeta();
    dismissBanner();
    renderList();
    renderStatus();
    closePanel();
    status("Restored pre-pull vault");
  } catch { status("Could not decrypt snapshot with current password", true); }
}
