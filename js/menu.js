/*
 * menu.js - the app's own right-click menu, with submenus to any depth.
 *
 * It replaces the browser's menu only where the app has something better to
 * offer: note, folder and trash rows, attachments, and the editor's
 * formatting menu. Touch and long-press are out of scope for a desktop app
 * opened from a file. One menu exists at a time; submenus open on hover
 * (after a short pause, so the pointer can cross other rows) or on click.
 *
 * Main functions: openMenu, closeMenu, menuIsOpen, uiLayerOpen.
 * Auxiliary functions: buildMenuEl, placeMenu, menuDepthOf, closeSubsFrom,
 * openSub, closeSub, scheduleSubClose, inMenu, onMenuDown, onMenuScroll,
 * fadeOut.
 *
 * Complexity: building a menu is O(i) in its items; finding which open menu
 * holds a row is O(d) in the depth of open submenus.
 */
"use strict";

// ---------- State ----------

// The open menu: its root element, the deepest submenu, the stack of open
// submenus ({ el, row }), and the hover timers.
const menu = { root: null, sub: null, subs: [], openTimer: null, closeTimer: null };

// Where the last clicked row was, for a command that opens something beside it.
let lastMenuRowRect = null;

// ---------- Opening and closing ----------

/**
 * Opens a menu at a point, closing any menu already open. `items` is a list
 * of { label, onClick, submenu, disabled, danger, kbd, mark, checked,
 * dotColor, font }, or { sep: true }, { hint }, { swatches, current }. While a
 * backup is open nothing opens: every menu changes something.
 *
 * Used by: sidebar.js (note, folder and trash rows), attachments.js
 * (attachments), events.js (the editor's own menu), format-menu.js
 * (formatting), content.js (page tabs), history.js and toolbar.js (their
 * buttons' menus), media-layout.js (images in the text), tables.js (table cells).
 * Uses: closeMenu, buildMenuEl, placeMenu, onMenuDown, onMenuScroll.
 * Complexity: O(i) in the number of items.
 */
function openMenu(x, y, items) {
  if (backupView) {
    return;
  }
  closeMenu();
  menu.root = buildMenuEl(items, false);
  placeMenu(menu.root, x, y);
  document.addEventListener("mousedown", onMenuDown, true);
  window.addEventListener("scroll", onMenuScroll, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
}

/**
 * Closes the menu and every submenu, with a short fade.
 *
 * Used by: this file (a choice, a click outside, scrolling, resizing, leaving
 * the window), events.js (Escape), settings.js (Lock), sync.js (a sync starts).
 * Uses: closeSub, fadeOut, onMenuDown, onMenuScroll.
 * Complexity: O(d) in the open submenus.
 */
function closeMenu() {
  if (!menu.root) {
    return;
  }
  closeSub();
  fadeOut(menu.root);
  menu.root = null;
  document.removeEventListener("mousedown", onMenuDown, true);
  window.removeEventListener("scroll", onMenuScroll, true);
  window.removeEventListener("resize", closeMenu);
  window.removeEventListener("blur", closeMenu);
}

/**
 * Whether a menu is open.
 *
 * Used by: uiLayerOpen in this file, events.js (Escape closes the menu first).
 * Uses: nothing.
 * Complexity: O(1).
 */
function menuIsOpen() {
  return !!menu.root;
}

/**
 * Whether any layer sits over the app: a menu, a dialog or the lightbox.
 * While one does, the document-wide shortcuts (Ctrl+S, pasting and dropping
 * files) stand down.
 *
 * Used by: events.js (keyboard shortcuts), attachments.js (pasting and
 * dropping files), censor.js (copying).
 * Uses: menuIsOpen, modalIsOpen (modal.js).
 * Complexity: O(1).
 */
function uiLayerOpen() {
  return menuIsOpen() || modalIsOpen() ||
    (typeof window.isLightboxOpen === "function" && window.isLightboxOpen());
}

// =================== Auxiliary functions ===================

/**
 * Builds the element for one menu or submenu from its items. A click inside a
 * menu never takes the focus or the selection from the note, so formatting
 * commands act on exactly what was selected. Complexity: O(i) in its items.
 */
function buildMenuEl(items, isSub) {
  const el = makeElement("div", "ctxmenu" + (isSub ? " sub" : ""));
  el.addEventListener("mousedown", event => event.preventDefault());

  for (const item of items) {
    if (item.sep) {
      el.appendChild(makeElement("div", "ctxsep"));
      continue;
    }
    if (item.hint) {
      el.appendChild(makeElement("div", "ctxhint", item.hint));
      continue;
    }

    if (item.swatches) {
      const row = makeElement("div", "swatch-row");
      const none = makeElement("button", "swatch none" + (item.current ? "" : " sel"), "×");
      none.type = "button";
      none.title = "No color";
      none.onclick = () => {
        closeMenu();
        item.swatches(null);
      };
      row.appendChild(none);
      for (const color of COLORS) {
        const button = makeElement("button", "swatch" + (item.current === color ? " sel" : ""));
        button.type = "button";
        button.style.background = color;
        button.onclick = () => {
          closeMenu();
          item.swatches(color);
        };
        row.appendChild(button);
      }
      el.appendChild(row);
      continue;
    }

    const row = makeElement("div", "ctxitem" + (item.disabled ? " disabled" : "") + (item.danger ? " danger" : ""));
    if ("dotColor" in item) {
      const dot = makeElement("span", "color-dot");
      if (item.dotColor) {
        dot.style.background = item.dotColor;
      }
      row.appendChild(dot);
    }
    // mark: a leading tick column (true or false), so a menu of toggles lines up.
    if ("mark" in item) {
      row.appendChild(makeElement("span", "mark", item.mark ? "✓" : ""));
    }
    const label = makeElement("span", "lbl", item.label);
    if (item.font) {
      label.style.fontFamily = item.font;
    }
    row.appendChild(label);
    if (item.kbd) {
      row.appendChild(makeElement("span", "kbd", item.kbd));
    }
    if (item.submenu) {
      row.appendChild(makeElement("span", "arrow", "›"));
    } else if (item.checked) {
      row.appendChild(makeElement("span", "arrow", "✓"));
    }

    if (item.submenu) {
      const isOpen = () => {
        const depth = menuDepthOf(row);
        return depth >= 0 && menu.subs[depth] && menu.subs[depth].row === row;
      };
      row.addEventListener("mouseenter", () => {
        clearTimeout(menu.openTimer);
        clearTimeout(menu.closeTimer);
        if (item.disabled || isOpen()) {
          return;
        }
        // Hover intent: open after a short pause.
        menu.openTimer = setTimeout(() => openSub(row, item), 120);
      });
      row.addEventListener("mouseleave", () => {
        clearTimeout(menu.openTimer);
        // Only the levels below this row's menu.
        scheduleSubClose(menuDepthOf(row));
      });
      // A click toggles it at once, for trackpads.
      row.onclick = event => {
        event.stopPropagation();
        if (item.disabled) {
          return;
        }
        clearTimeout(menu.openTimer);
        const depth = menuDepthOf(row);
        if (isOpen()) {
          closeSubsFrom(depth);
        } else {
          openSub(row, item);
        }
      };
    } else {
      row.addEventListener("mouseenter", () => {
        clearTimeout(menu.openTimer);
        // Hovering a plain row closes only what this menu opened, never the menu itself.
        scheduleSubClose(menuDepthOf(row));
      });
      row.onclick = () => {
        if (item.disabled) {
          return;
        }
        lastMenuRowRect = row.getBoundingClientRect();
        closeMenu();
        if (item.onClick) {
          item.onClick();
        }
      };
    }
    el.appendChild(row);
  }
  return el;
}

/**
 * Measures a menu while hidden, then places it 2px from the pointer, flipping
 * to the other side when it would overflow and keeping 8px from every edge.
 * Complexity: O(1).
 */
function placeMenu(el, x, y) {
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  document.body.appendChild(el);

  const box = el.getBoundingClientRect();
  const margin = 8;
  let left = x + 2;
  let top = y + 2;
  if (left + box.width > innerWidth - margin) {
    left = x - box.width - 2;
  }
  if (top + box.height > innerHeight - margin) {
    top = y - box.height - 2;
  }
  el.style.left = Math.max(margin, Math.min(left, innerWidth - box.width - margin)) + "px";
  el.style.top = Math.max(margin, Math.min(top, innerHeight - box.height - margin)) + "px";
  el.style.visibility = "";
  requestAnimationFrame(() => el.classList.add("show"));
}

/**
 * Which open menu holds a node: 0 for the root menu, n for the nth submenu,
 * -1 for none. Submenus are a stack, not one slot: with one slot, opening a
 * second level closed the first, and a click inside the deeper menu counted
 * as outside and closed everything. Complexity: O(d) in the open submenus.
 */
function menuDepthOf(node) {
  if (menu.root && menu.root.contains(node)) {
    return 0;
  }
  for (let i = 0; i < menu.subs.length; i++) {
    if (menu.subs[i].el.contains(node)) {
      return i + 1;
    }
  }
  return -1;
}

/** Closes every submenu from a depth down (subs[d] is the child of the menu at depth d). Complexity: O(d). */
function closeSubsFrom(depth) {
  while (menu.subs.length > depth) {
    const sub = menu.subs.pop();
    if (sub.row) {
      sub.row.classList.remove("open");
    }
    fadeOut(sub.el);
  }
}

/**
 * Opens a row's submenu beside it (to the right, or to the left when there is
 * no room), replacing any submenu that row's menu already had open but
 * keeping the ones above it. Complexity: O(i) in its items.
 */
function openSub(row, item) {
  const depth = menuDepthOf(row);
  if (depth < 0) {
    return;
  }
  closeSubsFrom(depth);

  const el = buildMenuEl(item.submenu(), true);
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  document.body.appendChild(el);

  const box = el.getBoundingClientRect();
  const anchor = row.getBoundingClientRect();
  const margin = 8;
  let left = anchor.right - 2;
  if (left + box.width > innerWidth - margin) {
    left = anchor.left - box.width + 2;
  }
  el.style.left = Math.max(margin, Math.min(left, innerWidth - box.width - margin)) + "px";
  el.style.top = Math.max(margin, Math.min(anchor.top - 4, innerHeight - box.height - margin)) + "px";
  el.style.visibility = "";
  requestAnimationFrame(() => el.classList.add("show"));

  // Being inside any menu cancels a pending close, so moving deeper is safe.
  el.addEventListener("mouseenter", () => clearTimeout(menu.closeTimer));
  el.addEventListener("mouseleave", () => scheduleSubClose(menuDepthOf(el)));
  row.classList.add("open");
  menu.subs.push({ el, row });
  // The deepest one, for the scroll and outside-click checks.
  menu.sub = el;
}

/** Closes every submenu and cancels the hover timers. Complexity: O(d). */
function closeSub() {
  clearTimeout(menu.openTimer);
  clearTimeout(menu.closeTimer);
  closeSubsFrom(0);
  menu.sub = null;
}

/**
 * Closes the submenus below a depth after 300 ms, a grace period for moving
 * the pointer diagonally across other rows into a submenu. Complexity: O(1).
 */
function scheduleSubClose(depth) {
  clearTimeout(menu.closeTimer);
  const from = typeof depth === "number" && depth >= 0 ? depth : 0;
  menu.closeTimer = setTimeout(() => {
    closeSubsFrom(from);
    menu.sub = menu.subs.length ? menu.subs[menu.subs.length - 1].el : null;
  }, 300);
}

/** Whether an event happened inside the menu or any of its submenus. Complexity: O(d). */
function inMenu(event) {
  const path = event.composedPath ? event.composedPath() : [];
  return (menu.root && path.includes(menu.root)) || menu.subs.some(sub => path.includes(sub.el));
}

/** A press outside the menu closes it. Complexity: O(d). */
function onMenuDown(event) {
  if (!inMenu(event)) {
    closeMenu();
  }
}

/**
 * Scrolling outside the menu closes it (listened in the capture phase, since
 * scroll does not bubble); scrolling inside the menu is fine. Complexity: O(d).
 */
function onMenuScroll(event) {
  if (!inMenu(event)) {
    closeMenu();
  }
}

/** Fades an element out and removes it 140 ms later. Complexity: O(1). */
function fadeOut(el) {
  if (!el) {
    return;
  }
  el.classList.remove("show");
  el.classList.add("closing");
  setTimeout(() => el.remove(), 140);
}
