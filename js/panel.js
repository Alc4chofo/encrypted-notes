/*
 * panel.js - the detail panel above the status bar.
 *
 * It opens from the status bar's chips and the merge banner, and lists what
 * needs attention: the note with unsaved edits, everything not synced yet,
 * the last sync error (with a field for a new token, or "Overwrite remote"
 * when the repo's vault has another password), and what the last merge
 * changed, with the way back to the vault as it was before that merge.
 *
 * Main functions: openPanel, closePanel, togglePanel, renderDetail, restorePrev.
 * Auxiliary functions: chipsOpen.
 *
 * Complexity: drawing the panel is O(n + f + t) over notes, folders and trash
 * (sorted, so O(n log n)). Restoring the pre-merge vault derives a key once
 * (PBKDF2, about 0.6 s) and seals once (about 20 ms for 500 KB).
 */
"use strict";

// ---------- Opening and closing ----------

/**
 * Opens the panel and draws it.
 *
 * Used by: togglePanel in this file, events.js (the merge banner's Details).
 * Uses: chipsOpen, renderDetail.
 * Complexity: that of renderDetail.
 */
function openPanel() {
  panelOpen = true;
  $("status-detail").classList.add("open");
  chipsOpen(true);
  renderDetail();
}

/**
 * Hides the panel. What it showed stays in the page until it is drawn again,
 * which is why Lock wipes it separately.
 *
 * Used by: this file, events.js (Escape, a click outside), settings.js (Lock),
 * media-sync.js ("Overwrite remote"), pagination.js (nothing left to show).
 * Uses: chipsOpen.
 * Complexity: O(c) in the chips.
 */
function closePanel() {
  panelOpen = false;
  $("status-detail").classList.remove("open");
  chipsOpen(false);
}

/**
 * Opens the panel when closed, closes it when open.
 *
 * Used by: events.js (the Unsaved and Sync failed chips).
 * Uses: openPanel, closePanel.
 * Complexity: that of renderDetail when it opens.
 */
function togglePanel() {
  panelOpen ? closePanel() : openPanel();
}

// ---------- What the panel shows ----------

/**
 * Draws the panel's sections; with nothing to show it closes instead.
 *   - Unsaved: the note being edited, with "Save now".
 *   - Unsynced: all five kinds (notes, folders, trash entries, and deletions
 *     of notes and of folders), each note openable, with "Sync now".
 *   - Sync error: when and why. A rejected token gets a field for a new one
 *     (applied with one save; the typed token is cleared right after, since
 *     this panel is only hidden, not emptied, when it closes). A vault in the
 *     repo with another password gets "Overwrite remote with local vault".
 *   - Last merge: what it removed, replaced, added and kept twice, and
 *     "Restore pre-merge vault" while that snapshot exists.
 *
 * Used by: openPanel in this file, events.js (the merge banner's Details
 * while open), pagination.js (the status changes while it is open).
 * Uses: makeElement, relativeTime, folderName and compareByName (sidebar.js),
 * the unsynced lists (vault.js), flushSave, openNote, openTrash, manualSave,
 * renderStatus, status, bannerText and ERROR_EXPLANATIONS (pagination.js),
 * persistLocal (vault.js), overwriteRemote (media-sync.js), restorePrev,
 * vaultStorageKey (core.js).
 * Complexity: O(n log n + f log f + t log t) for the sorted lists.
 */
function renderDetail() {
  const panel = $("status-detail");
  panel.innerHTML = "";
  const sections = [];

  if (unsavedEdits && currentId) {
    const section = makeElement("div");
    section.appendChild(makeElement("div", "detail-head", "Unsaved"));
    const row = makeElement("div", "detail-row");
    const title = $("title").value;
    row.appendChild(makeElement("span", "t" + (title ? "" : " untitled"), title || "(untitled)"));
    row.appendChild(makeElement("span", "m", "editing now"));
    const button = makeElement("button", null, "Save now");
    button.onclick = manualSave;
    row.appendChild(button);
    section.appendChild(row);
    sections.push(section);
  }

  // All five kinds of unsynced change: notes, folders, trash entries, and the
  // two kinds of pending deletion.
  const noteIds = unsyncedIds().sort((a, b) => vault.notes[b].mtime - vault.notes[a].mtime);
  const folderIds = unsyncedFolderIds().sort((a, b) => compareByName(folderName(a), folderName(b)));
  const trashIds = unsyncedTrashIds().sort((a, b) => (vault.trash[b].deletedAt || 0) - (vault.trash[a].deletedAt || 0));
  const deletedNoteIds = pendingNoteDeletions();
  const deletedFolderIds = pendingFolderDeletions();
  const total = noteIds.length + folderIds.length + trashIds.length + deletedNoteIds.length + deletedFolderIds.length;

  if (total) {
    const section = makeElement("div");
    section.appendChild(makeElement("div", "detail-head", `Unsynced (${total})`));

    for (const id of noteIds) {
      const note = vault.notes[id];
      const row = makeElement("div", "detail-row click");
      row.appendChild(makeElement("span", "t" + (note.title ? "" : " untitled"), note.title || "(untitled)"));
      if (!(id in syncMeta.noteMtimes)) {
        row.appendChild(makeElement("span", "m", "(new)"));
      }
      row.appendChild(makeElement("span", "m", relativeTime(note.mtime)));
      row.onclick = () => {
        flushSave();
        closePanel();
        openNote(id);
      };
      section.appendChild(row);
    }

    for (const folderId of folderIds) {
      const row = makeElement("div", "detail-row");
      row.appendChild(makeElement("span", "t", folderName(folderId)));
      row.appendChild(makeElement("span", "m", folderId in syncMeta.folderMtimes ? "folder" : "folder (new)"));
      section.appendChild(row);
    }

    for (const id of trashIds) {
      const data = vault.trash[id].data || {};
      const row = makeElement("div", "detail-row click");
      row.appendChild(makeElement("span", "t" + (data.title ? "" : " untitled"), data.title || "(untitled)"));
      row.appendChild(makeElement("span", "m", "in trash"));
      row.onclick = () => {
        closePanel();
        openTrash(id);
      };
      section.appendChild(row);
    }

    if (deletedNoteIds.length) {
      const known = deletedNoteIds.filter(id => id in deletedTitles);
      for (const id of known) {
        const row = makeElement("div", "detail-row");
        row.appendChild(makeElement("span", "t" + (deletedTitles[id] === "(untitled)" ? " untitled" : ""), deletedTitles[id]));
        row.appendChild(makeElement("span", "m", "deleted"));
        section.appendChild(row);
      }
      if (deletedNoteIds.length > known.length) {
        section.appendChild(makeElement("div", "detail-note",
          `${deletedNoteIds.length - known.length} deleted note(s) not yet synced (titles unavailable after reload)`));
      }
    }
    if (deletedFolderIds.length) {
      section.appendChild(makeElement("div", "detail-note",
        `${deletedFolderIds.length} deleted folder(s) not yet synced`));
    }

    const foot = makeElement("div", "detail-row");
    const button = makeElement("button", null, "Sync now");
    button.onclick = () => {
      closePanel();
      $("sync").onclick();
    };
    foot.appendChild(button);
    section.appendChild(foot);
    sections.push(section);
  }

  if (lastSyncError) {
    const section = makeElement("div");
    section.appendChild(makeElement("div", "detail-head", "Sync error"));
    section.appendChild(makeElement("div", "detail-note",
      new Date(lastSyncError.at).toLocaleString() +
      (lastSyncError.httpStatus ? ` (HTTP ${lastSyncError.httpStatus})` : "")));
    section.appendChild(makeElement("div", "detail-note", ERROR_EXPLANATIONS[lastSyncError.kind]));
    if (lastSyncError.raw) {
      section.appendChild(makeElement("div", "detail-note", lastSyncError.raw));
    }

    if (lastSyncError.kind === "auth") {
      const row = makeElement("div", "detail-row");
      const input = makeElement("input");
      input.type = "password";
      input.placeholder = "New fine-grained token";
      const button = makeElement("button", null, "Apply");
      button.onclick = async () => {
        const token = input.value.trim();
        // Never rewrite the token of a backup being viewed.
        if (!token || backupView) {
          return;
        }
        vault.token = token;
        await persistLocal();
        // The typed token must not outlive its use: this field lives in the
        // panel, which closePanel only hides (Lock empties it too).
        input.value = "";
        lastSyncError = null;
        closePanel();
        renderStatus();
        status("Token updated, press Sync");
      };
      row.appendChild(input);
      row.appendChild(button);
      section.appendChild(row);
    }

    if (lastSyncError.kind === "pwmismatch") {
      const row = makeElement("div", "detail-row");
      const button = makeElement("button", "danger", "Overwrite remote with local vault");
      button.onclick = overwriteRemote;
      row.appendChild(button);
      section.appendChild(row);
    }
    sections.push(section);
  }

  if (pullBanner) {
    const section = makeElement("div");
    section.appendChild(makeElement("div", "detail-head", "Last merge"));
    section.appendChild(makeElement("div", "detail-note", bannerText()));
    if (pullDiff) {
      for (const title of pullDiff.lost) {
        section.appendChild(makeElement("div", "detail-note", `removed by the merge: ${title}`));
      }
      for (const title of pullDiff.replaced) {
        section.appendChild(makeElement("div", "detail-note", `local "${title}" replaced by the remote version`));
      }
      for (const title of pullDiff.added) {
        section.appendChild(makeElement("div", "detail-note", `new from remote: ${title}`));
      }
      for (const title of (pullDiff.conflicts || [])) {
        section.appendChild(makeElement("div", "detail-note", `conflict, both versions kept: ${title}`));
      }
    } else if (pullBanner.lost + pullBanner.replaced + pullBanner.added > 0) {
      section.appendChild(makeElement("div", "detail-note",
        `${pullBanner.lost} removed, ${pullBanner.replaced} replaced, ` +
        `${pullBanner.added} new from remote (titles unavailable after reload)`));
    }
    if (localStorage.getItem(vaultStorageKey("vault.prev"))) {
      const row = makeElement("div", "detail-row");
      const at = new Date(+localStorage.getItem(vaultStorageKey("vault.prevAt")) || 0);
      const button = makeElement("button", null, `Restore pre-merge vault (${at.toLocaleString()})`);
      button.onclick = restorePrev;
      row.appendChild(button);
      section.appendChild(row);
    }
    sections.push(section);
  }

  if (!sections.length) {
    closePanel();
    return;
  }
  const close = makeElement("button", "detail-close", "Close");
  close.onclick = closePanel;
  sections[0].querySelector(".detail-head").appendChild(close);
  for (const section of sections) {
    panel.appendChild(section);
  }
}

/**
 * Puts back the vault as it was before the last merge, after asking. The
 * snapshot is a sealed blob kept in localStorage by the merge; opening it
 * derives a key from its salt with the master password (PBKDF2, about 0.6 s).
 * Only the vault is taken, never the snapshot's key, salt or round count:
 * adopting those would quietly lower every later seal to the snapshot's
 * strength and strand attachments encrypted under the live key. The restored
 * vault is then sealed under the current key, keeping its own savedAt, so
 * the next Sync sees the repo as newer and offers its changes again instead
 * of overwriting them. Not while a backup is open: that would swap the viewed
 * backup for the real vault behind an unchanged "read-only" banner.
 *
 * Used by: renderDetail in this file ("Restore pre-merge vault").
 * Uses: vaultStorageKey (core.js), confirmModal (modal.js), openVault (core.js),
 * revokeAllMediaUrls, loadMediaKey and persistLocal (vault.js), applyReadonly,
 * clearEditor, dismissBanner, renderStatus and status (pagination.js),
 * renderAttachments (attachments.js), saveSyncMeta (core.js), renderList (sidebar.js).
 * Complexity: one key derivation (about 0.6 s at 1,200,000 rounds) and one
 * seal (O(n), about 20 ms for 500 KB).
 */
async function restorePrev() {
  if (syncing || backupView) {
    return;
  }
  const previous = localStorage.getItem(vaultStorageKey("vault.prev"));
  if (!previous) {
    return;
  }
  const at = new Date(+localStorage.getItem(vaultStorageKey("vault.prevAt")) || 0).toLocaleString();
  const ok = await confirmModal({
    title: "Restore pre-merge vault?",
    body: `Replace the current vault with the pre-merge snapshot from ${at}? Everything the merge brought in from the repo will be removed locally until the next sync.`,
    confirmLabel: "Restore",
    destructive: true,
  });
  if (!ok || !localStorage.getItem(vaultStorageKey("vault.prev"))) {
    return;
  }

  try {
    const opened = await openVault(previous, masterPassword);
    const token = vault.token;
    // The whole vault, and its set of attachments, is being replaced.
    revokeAllMediaUrls();
    vault = opened.vault;
    vault.token = vault.token || token;
    // The snapshot carries its own attachment key.
    await loadMediaKey();
    currentId = null;
    trashViewId = null;
    applyReadonly();
    $("title").value = "";
    clearEditor();
    renderAttachments();
    unsavedEdits = false;
    // stamp false: the snapshot keeps its own savedAt.
    await persistLocal(false);
    // The repo still matches the blob id recorded by the merge just undone, so
    // the "nothing changed" shortcut would skip the merge and push this
    // rollback over everything. The next sync must merge for real.
    syncMeta.remoteSha = null;
    syncMeta.syncedSavedAt = 0;
    saveSyncMeta();
    dismissBanner();
    renderList();
    renderStatus();
    closePanel();
    status("Restored pre-pull vault");
  } catch {
    status("Could not decrypt snapshot with current password", true);
  }
}

// =================== Auxiliary functions ===================

/** Marks every status-bar chip as open or closed, to match the panel. Complexity: O(c) in the chips. */
function chipsOpen(on) {
  for (const chip of document.querySelectorAll(".chip")) {
    chip.classList.toggle("open", on);
  }
}
