/*
 * modal.js - the app's dialogs, in place of the browser's confirm, alert and
 * prompt.
 *
 * Every dialog returns a promise and is awaited, so a sync that asks
 * something stays inside its try block, with `syncing` true and editing
 * frozen, until you answer. Only one dialog shows at a time: further requests
 * wait in a queue behind the open one. Escape is handled centrally in
 * events.js, which knows which layer is on top.
 *
 * Main functions: showModal, confirmModal, alertModal, promptModal, modalIsOpen.
 * Auxiliary functions: modalRaw, buildModal.
 *
 * Complexity: building a dialog is O(c) in its number of buttons; the queue
 * is O(1) per request.
 */
"use strict";

// ---------- State ----------

let modalOpenCount = 0;

// Cancels the open dialog (Escape calls it, from events.js).
let modalCancel = null;

// Requests run one after another: each waits for the previous dialog to close.
let modalQueue = Promise.resolve();

// ---------- Asking ----------

/**
 * Whether a dialog is on screen.
 *
 * Used by: events.js (keyboard shortcuts stand down), menu.js (uiLayerOpen).
 * Uses: nothing.
 * Complexity: O(1).
 */
function modalIsOpen() {
  return modalOpenCount > 0;
}

/**
 * Shows a dialog with any set of buttons and resolves with the id of the
 * button pressed, or null when it was cancelled. `opts`: title, body,
 * choices ([{ id, label, danger }]), defaultId.
 *
 * Used by: backups.js (whether to update an old backup), notes.js (deleting a
 * folder), split.js (unsaved changes when the second screen closes),
 * updates.js (offering an app update, and how installing it went).
 * Uses: modalRaw.
 * Complexity: O(c) in the number of buttons.
 */
async function showModal(opts) {
  return (await modalRaw(opts)).choice;
}

/**
 * Asks a yes-or-no question and resolves with true for the confirm button.
 * A destructive question (opts.destructive) shows its confirm button in red
 * and puts the focus on Cancel; a harmless one focuses the confirm button.
 *
 * Used by: attachments.js, backups.js, content.js, designs.js, history.js,
 * media-sync.js, merge.js, notes.js, panel.js, settings.js, sidebar.js and
 * vaults.js, before anything that deletes, replaces or cannot be undone
 * easily.
 * Uses: modalRaw.
 * Complexity: O(1).
 */
async function confirmModal(opts) {
  return (await modalRaw({
    ...opts,
    choices: [
      { id: "ok", label: opts.confirmLabel || "OK", danger: !!opts.destructive },
      { id: "cancel", label: opts.cancelLabel || "Cancel" },
    ],
    defaultId: opts.destructive ? "cancel" : "ok",
  })).choice === "ok";
}

/**
 * Shows a message with one OK button.
 *
 * Used by: attachments.js (a file that is too large), updates.js (a folder
 * that is not the app's).
 * Uses: modalRaw.
 * Complexity: O(1).
 */
async function alertModal(opts) {
  return modalRaw({ ...opts, choices: [{ id: "ok", label: opts.confirmLabel || "OK" }], defaultId: "ok" });
}

/**
 * Asks for a line of text. Resolves with the trimmed text, or null when it
 * was cancelled or left empty.
 *
 * Used by: content.js (renaming a page), designs.js (naming a design or a
 * preset), notes.js (naming a folder), tables.js (a table's size), toolbar.js
 * (a link's address).
 * Uses: modalRaw.
 * Complexity: O(1).
 */
async function promptModal(opts) {
  const result = await modalRaw({
    ...opts,
    input: true,
    choices: [{ id: "ok", label: opts.confirmLabel || "OK" }, { id: "cancel", label: "Cancel" }],
    defaultId: "ok",
  });
  return result.choice === "ok" && result.value.trim() ? result.value.trim() : null;
}

// =================== Auxiliary functions ===================

/**
 * Queues one dialog behind any that is open and resolves with
 * { choice, value } once it closes. A failed dialog never blocks the queue.
 * Complexity: O(1).
 */
function modalRaw(opts) {
  const run = () => new Promise(resolve => buildModal(opts, resolve));
  const shown = modalQueue.then(run, run);
  modalQueue = shown.then(() => {}, () => {});
  return shown;
}

/**
 * Builds a dialog, shows it, and keeps the keyboard inside it until it
 * closes: Tab cycles through its controls, Enter presses the focused (or the
 * default) button. On close it fades out, gives the focus back to where it
 * was, and calls resolve({ choice, value }). Complexity: O(c) in its buttons.
 */
function buildModal(opts, resolve) {
  modalOpenCount++;
  const previousFocus = document.activeElement;

  const back = makeElement("div", "modal-back");
  const card = makeElement("div", "modal");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  if (opts.title) {
    card.appendChild(makeElement("h3", null, opts.title));
  }
  if (opts.body) {
    card.appendChild(makeElement("p", null, opts.body));
  }

  let input = null;
  if (opts.input) {
    input = makeElement("input");
    input.type = "text";
    input.placeholder = opts.placeholder || "";
    input.value = opts.value || "";
    card.appendChild(input);
  }

  const choices = opts.choices || [{ id: "ok", label: "OK" }];
  const actions = makeElement("div", "modal-actions" + (choices.length > 2 ? " stack" : ""));
  let defaultButton = null;
  for (const choice of choices) {
    const button = makeElement("button", choice.danger ? "danger" : null, choice.label);
    button.type = "button";
    button.onclick = () => finish(choice.id);
    if (choice.id === opts.defaultId) {
      defaultButton = button;
    }
    actions.appendChild(button);
  }
  card.appendChild(actions);
  back.appendChild(card);
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add("show"));

  let done = false;
  function finish(choice) {
    if (done) {
      return;
    }
    done = true;
    modalOpenCount--;
    modalCancel = null;
    document.removeEventListener("keydown", onKey, true);
    back.classList.remove("show");
    // It stays mounted for the fade, with clicks passing through.
    back.classList.add("closing");
    setTimeout(() => back.remove(), 140);
    if (previousFocus && previousFocus.focus) {
      try {
        previousFocus.focus();
      } catch {}
    }
    resolve({ choice, value: input ? input.value : "" });
  }
  modalCancel = () => finish(null);

  // A click on the backdrop used to drop the focus onto <body>, which killed a
  // listener bound to the backdrop and let Tab walk into the app behind the
  // dialog. So the key handler lives on document (capture) while the dialog
  // is open, and the backdrop refuses to take the focus at all.
  back.tabIndex = -1;
  back.addEventListener("mousedown", event => {
    if (event.target === back) {
      event.preventDefault();
      (input || defaultButton || actions.firstChild).focus();
    }
  });

  const focusables = () => [...card.querySelectorAll("input, button")].filter(control => !control.disabled);
  function onKey(event) {
    if (event.key === "Tab") {
      const controls = focusables();
      if (!controls.length) {
        return;
      }
      event.preventDefault();
      const index = controls.indexOf(document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? controls.length - 1 : index - 1)
        : (index < 0 || index === controls.length - 1 ? 0 : index + 1);
      controls[next].focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = document.activeElement;
      if (active && active.tagName === "BUTTON" && card.contains(active)) {
        active.click();
      } else if (defaultButton) {
        defaultButton.click();
      }
    }
    // Escape falls through to the central handler, which decides which layer it closes.
  }
  document.addEventListener("keydown", onKey, true);
  (input || defaultButton || actions.firstChild).focus();
}
