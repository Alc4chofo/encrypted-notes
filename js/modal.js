// notes: Dialogs (in place of confirm and alert).
"use strict";

// ---------- Modal (replaces window.confirm / window.alert in app flows) ----------
// showModal(opts) -> Promise<choiceId|null>. Awaited everywhere, so a sync that
// opens one stays inside its try block with `syncing` true and editing frozen.
// One modal at a time: further requests queue behind the open one.
let modalOpenCount = 0;
let modalCancel = null;          // cancels the open modal (Esc, handled centrally)
let modalQueue = Promise.resolve();
function modalIsOpen() { return modalOpenCount > 0; }

function modalRaw(opts) {
  const run = () => new Promise(resolve => buildModal(opts, resolve));
  const p = modalQueue.then(run, run);
  modalQueue = p.then(() => {}, () => {});
  return p;
}
async function showModal(opts) { return (await modalRaw(opts)).choice; }
async function confirmModal(opts) {
  return (await modalRaw({
    ...opts,
    choices: [
      { id: "ok", label: opts.confirmLabel || "OK", danger: !!opts.destructive },
      { id: "cancel", label: opts.cancelLabel || "Cancel" },
    ],
    // Destructive dialogs default to Cancel; harmless ones to the confirm button.
    defaultId: opts.destructive ? "cancel" : "ok",
  })).choice === "ok";
}
async function alertModal(opts) {
  return modalRaw({ ...opts, choices: [{ id: "ok", label: opts.confirmLabel || "OK" }], defaultId: "ok" });
}
async function promptModal(opts) {
  const r = await modalRaw({
    ...opts, input: true,
    choices: [{ id: "ok", label: opts.confirmLabel || "OK" }, { id: "cancel", label: "Cancel" }],
    defaultId: "ok",
  });
  return r.choice === "ok" && r.value.trim() ? r.value.trim() : null;
}

function buildModal(opts, resolve) {
  modalOpenCount++;
  const prevFocus = document.activeElement;
  const back = mk("div", "modal-back");
  const card = mk("div", "modal");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  if (opts.title) card.appendChild(mk("h3", null, opts.title));
  if (opts.body) card.appendChild(mk("p", null, opts.body));
  let inp = null;
  if (opts.input) {
    inp = mk("input");
    inp.type = "text";
    inp.placeholder = opts.placeholder || "";
    inp.value = opts.value || "";
    card.appendChild(inp);
  }
  const choices = opts.choices || [{ id: "ok", label: "OK" }];
  const actions = mk("div", "modal-actions" + (choices.length > 2 ? " stack" : ""));
  let defaultBtn = null;
  for (const c of choices) {
    const b = mk("button", c.danger ? "danger" : null, c.label);
    b.type = "button";
    b.onclick = () => finish(c.id);
    if (c.id === opts.defaultId) defaultBtn = b;
    actions.appendChild(b);
  }
  card.appendChild(actions);
  back.appendChild(card);
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add("show"));

  let done = false;
  function finish(choice) {
    if (done) return;
    done = true;
    modalOpenCount--;
    modalCancel = null;
    document.removeEventListener("keydown", onKey, true);
    back.classList.remove("show");
    back.classList.add("closing");   // stays mounted for the fade, click-through disabled
    setTimeout(() => back.remove(), 140);
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch {} }
    resolve({ choice, value: inp ? inp.value : "" });
  }
  modalCancel = () => finish(null);

  // A backdrop click used to drop focus onto <body>, which killed a listener
  // bound to `back` and let Tab walk into the app behind the dialog. The
  // handler lives on document (capture) for the modal's lifetime instead, and
  // the backdrop refuses to take focus at all.
  back.tabIndex = -1;
  back.addEventListener("mousedown", e => {
    if (e.target === back) { e.preventDefault(); (inp || defaultBtn || actions.firstChild).focus(); }
  });

  const focusables = () => [...card.querySelectorAll("input, button")].filter(e => !e.disabled);
  function onKey(e) {
    if (e.key === "Tab") {
      const f = focusables();
      if (!f.length) return;
      e.preventDefault();
      const i = f.indexOf(document.activeElement);
      const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
      f[n].focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = document.activeElement;
      if (a && a.tagName === "BUTTON" && card.contains(a)) a.click();
      else if (defaultBtn) defaultBtn.click();
    }
    // Escape falls through to the central handler, which owns layer precedence.
  }
  document.addEventListener("keydown", onKey, true);
  (inp || defaultBtn || actions.firstChild).focus();
}
