// notes: The context menu.
"use strict";

// ---------- Context menu (custom, one submenu level) ----------
// Right-click only: a touch / long-press fallback is out of scope for a
// desktop file:// app. Native menus are suppressed on note rows, folder rows,
// trash rows and attachments, nowhere else.
// subs is the open submenu stack, so menus can nest to any depth.
const menu = { root: null, sub: null, subs: [], openTimer: null, closeTimer: null };
function menuIsOpen() { return !!menu.root; }
// Any overlay layer swallows the document-level shortcuts (Ctrl+S, paste, drop).
function uiLayerOpen() {
  return menuIsOpen() || modalIsOpen() ||
    (typeof window.isLightboxOpen === "function" && window.isLightboxOpen());
}

function fadeOut(el) {
  if (!el) return;
  el.classList.remove("show");
  el.classList.add("closing");
  setTimeout(() => el.remove(), 140);
}

// Where the last clicked row was, for a command that opens something beside it.
let lastMenuRowRect = null;
function buildMenuEl(items, isSub) {
  const el = mk("div", "ctxmenu" + (isSub ? " sub" : ""));
  // A click in a menu never takes the focus or the selection from the note:
  // the formatting commands act on exactly what was selected.
  el.addEventListener("mousedown", e => e.preventDefault());
  for (const it of items) {
    if (it.sep) { el.appendChild(mk("div", "ctxsep")); continue; }
    if (it.hint) { el.appendChild(mk("div", "ctxhint", it.hint)); continue; }
    if (it.swatches) {
      const row = mk("div", "swatch-row");
      const none = mk("button", "swatch none" + (it.current ? "" : " sel"), "×");
      none.type = "button";
      none.title = "No color";
      none.onclick = () => { closeMenu(); it.swatches(null); };
      row.appendChild(none);
      for (const c of COLORS) {
        const b = mk("button", "swatch" + (it.current === c ? " sel" : ""));
        b.type = "button";
        b.style.background = c;
        b.onclick = () => { closeMenu(); it.swatches(c); };
        row.appendChild(b);
      }
      el.appendChild(row);
      continue;
    }
    const row = mk("div", "ctxitem" + (it.disabled ? " disabled" : "") + (it.danger ? " danger" : ""));
    if ("dotColor" in it) {
      const d = mk("span", "color-dot");
      if (it.dotColor) d.style.background = it.dotColor;
      row.appendChild(d);
    }
    // mark: a leading tick column (true/false), so a menu of toggles lines up.
    if ("mark" in it) row.appendChild(mk("span", "mark", it.mark ? "✓" : ""));
    const lbl = mk("span", "lbl", it.label);
    if (it.font) lbl.style.fontFamily = it.font;
    row.appendChild(lbl);
    if (it.kbd) row.appendChild(mk("span", "kbd", it.kbd));
    if (it.submenu) row.appendChild(mk("span", "arrow", "›"));
    else if (it.checked) row.appendChild(mk("span", "arrow", "✓"));
    if (it.submenu) {
      const isOpen = () => { const d = menuDepthOf(row); return d >= 0 && menu.subs[d] && menu.subs[d].row === row; };
      row.addEventListener("mouseenter", () => {
        clearTimeout(menu.openTimer);
        clearTimeout(menu.closeTimer);
        if (it.disabled || isOpen()) return;
        menu.openTimer = setTimeout(() => openSub(row, it), 120);   // hover intent
      });
      row.addEventListener("mouseleave", () => {
        clearTimeout(menu.openTimer);
        scheduleSubClose(menuDepthOf(row));   // only levels BELOW this row's menu
      });
      row.onclick = e => {   // click toggles immediately (trackpad affordance)
        e.stopPropagation();
        if (it.disabled) return;
        clearTimeout(menu.openTimer);
        const d = menuDepthOf(row);
        if (isOpen()) closeSubsFrom(d); else openSub(row, it);
      };
    } else {
      row.addEventListener("mouseenter", () => {
        clearTimeout(menu.openTimer);
        // Hovering a plain row closes only what this menu opened, never itself.
        scheduleSubClose(menuDepthOf(row));
      });
      row.onclick = () => {
        if (it.disabled) return;
        lastMenuRowRect = row.getBoundingClientRect();
        closeMenu();
        if (it.onClick) it.onClick();
      };
    }
    el.appendChild(row);
  }
  return el;
}

// Measure hidden, then place: cursor +2px, flipping on overflow, clamped 8px.
function placeMenu(el, x, y) {
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  document.body.appendChild(el);
  const r = el.getBoundingClientRect(), M = 8;
  let left = x + 2, top = y + 2;
  if (left + r.width > innerWidth - M) left = x - r.width - 2;
  if (top + r.height > innerHeight - M) top = y - r.height - 2;
  el.style.left = Math.max(M, Math.min(left, innerWidth - r.width - M)) + "px";
  el.style.top = Math.max(M, Math.min(top, innerHeight - r.height - M)) + "px";
  el.style.visibility = "";
  requestAnimationFrame(() => el.classList.add("show"));
}

// Submenus are a STACK, not a single slot: a submenu can open its own submenu.
// (With one slot, opening a second level closed the first, and a click inside
// the deeper menu counted as "outside the menu" and dismissed everything.)
// Which open menu contains this node: 0 = the root menu, n = subs[n-1].
function menuDepthOf(node) {
  if (menu.root && menu.root.contains(node)) return 0;
  for (let i = 0; i < menu.subs.length; i++) if (menu.subs[i].el.contains(node)) return i + 1;
  return -1;
}
// Close every submenu from this depth down (subs[d] is the child of the menu at depth d).
function closeSubsFrom(d) {
  while (menu.subs.length > d) {
    const s = menu.subs.pop();
    if (s.row) s.row.classList.remove("open");
    fadeOut(s.el);
  }
}
function openSub(row, it) {
  const d = menuDepthOf(row);
  if (d < 0) return;
  closeSubsFrom(d);            // drop this level's previous child, keep the ancestors
  const el = buildMenuEl(it.submenu(), true);
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  document.body.appendChild(el);
  const r = el.getBoundingClientRect(), a = row.getBoundingClientRect(), M = 8;
  let left = a.right - 2;
  if (left + r.width > innerWidth - M) left = a.left - r.width + 2;   // flip to the left side
  el.style.left = Math.max(M, Math.min(left, innerWidth - r.width - M)) + "px";
  el.style.top = Math.max(M, Math.min(a.top - 4, innerHeight - r.height - M)) + "px";
  el.style.visibility = "";
  requestAnimationFrame(() => el.classList.add("show"));
  // Being inside any menu cancels a pending close, so travelling deeper is safe.
  el.addEventListener("mouseenter", () => clearTimeout(menu.closeTimer));
  el.addEventListener("mouseleave", () => scheduleSubClose(menuDepthOf(el)));
  row.classList.add("open");
  menu.subs.push({ el, row });
  menu.sub = el;               // the deepest one, for the scroll/outside checks
}

function closeSub() {
  clearTimeout(menu.openTimer);
  clearTimeout(menu.closeTimer);
  closeSubsFrom(0);
  menu.sub = null;
}

// Grace period for diagonal travel across the row below the parent.
function scheduleSubClose(depth) {
  clearTimeout(menu.closeTimer);
  const d = typeof depth === "number" && depth >= 0 ? depth : 0;
  menu.closeTimer = setTimeout(() => {
    closeSubsFrom(d);
    menu.sub = menu.subs.length ? menu.subs[menu.subs.length - 1].el : null;
  }, 300);
}

function inMenu(e) {
  const p = e.composedPath ? e.composedPath() : [];
  return (menu.root && p.includes(menu.root)) || menu.subs.some(s => p.includes(s.el));
}
const onMenuDown = e => { if (!inMenu(e)) closeMenu(); };
// capture: scroll does not bubble. Scrolling inside the menu itself is fine.
const onMenuScroll = e => { if (!inMenu(e)) closeMenu(); };

// Only one menu exists at a time: opening one closes the previous.
function openMenu(x, y, items) {
  if (backupView) return;   // view-only: every context menu is a mutation surface
  closeMenu();
  menu.root = buildMenuEl(items, false);
  placeMenu(menu.root, x, y);
  document.addEventListener("mousedown", onMenuDown, true);
  window.addEventListener("scroll", onMenuScroll, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
}

function closeMenu() {
  if (!menu.root) return;
  closeSub();
  fadeOut(menu.root);
  menu.root = null;
  document.removeEventListener("mousedown", onMenuDown, true);
  window.removeEventListener("scroll", onMenuScroll, true);
  window.removeEventListener("resize", closeMenu);
  window.removeEventListener("blur", closeMenu);
}
