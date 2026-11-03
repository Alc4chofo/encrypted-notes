// notes: Which build these files are, and which files make up the app.
"use strict";

// Sync compares APP_BUILD with the one in the repo's copy of this file and
// offers the newer build (see updates.js). Bump it with every change to any app
// file: "YYYY-MM-DD.N", N counting that day's builds from 1.
// APP_FILES is every file an update installs, in the order index.html loads
// them. The updater reads this list as text, so keep its shape: one quoted name
// per line, and only index.html and files in css/ and js/. Never config.js: that
// one holds your own repo and stays as you set it.
const APP_BUILD = "2026-11-03.5";
const APP_FILES = [
  "index.html",
  "css/base.css",
  "css/lock.css",
  "css/sidebar.css",
  "css/editor.css",
  "css/dialogs.css",
  "js/version.js",
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
  "js/zip.js",
  "js/updates.js",
  "js/settings.js",
  "js/guard.js",
  "js/lock.js"
];
