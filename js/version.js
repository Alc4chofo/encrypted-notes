/*
 * version.js - which build these files are, and which files make up the app.
 *
 * Sync reads this file from the repo as text (updates.js) and offers the
 * build when it is newer, so its shape matters as much as its content: keep
 * `const APP_BUILD = "...";` on one line, and the APP_FILES list as one
 * quoted name per line with nothing else inside the brackets. Older copies
 * of the app read it the same way.
 *
 * Main functions: none, it only declares data.
 *
 * Complexity: none at run time.
 */
"use strict";

// Bumped with every change to any app file: "YYYY-MM-DD.N", N counting that
// day's builds from 1. Sync compares it with the repo's copy to offer updates.
const APP_BUILD = "2026-11-14.6";

// The version people see, at the bottom left of the lock screen. It changes
// only when the owner says which version a change is.
const APP_VERSION = "1.02.1";

// Every file an update installs, in the order index.html loads them: only
// index.html and files in css/ and js/. Never config.js, which holds your own
// repo and stays as you set it.
const APP_FILES = [
  "index.html",
  "css/base.css",
  "css/lock.css",
  "css/sidebar.css",
  "css/editor.css",
  "css/dialogs.css",
  "js/version.js",
  "js/i18n.js",
  "js/core.js",
  "js/vault.js",
  "js/sidebar.js",
  "js/content.js",
  "js/pdf.js",
  "js/designs.js",
  "js/toolbar.js",
  "js/tables.js",
  "js/format-menu.js",
  "js/atoms.js",
  "js/alignment.js",
  "js/censor.js",
  "js/media-layout.js",
  "js/split.js",
  "js/history.js",
  "js/lines.js",
  "js/pagination.js",
  "js/panel.js",
  "js/modal.js",
  "js/menu.js",
  "js/notes.js",
  "js/attachments.js",
  "js/events.js",
  "js/sync.js",
  "js/merge.js",
  "js/media-sync.js",
  "js/backups.js",
  "js/vaults.js",
  "js/zip.js",
  "js/updates.js",
  "js/settings.js",
  "js/guard.js",
  "js/lock.js",
  "js/help.js",
  "js/ambient.js"
];
