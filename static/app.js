"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const State = {
  lists: [],
  currentId: localStorage.getItem("checklist.current") || null,
  user: localStorage.getItem("checklist.user") || null,
  filter: "all",            // all | mine | <name> | unassigned
  addAssignee: "",          // who the next new item is assigned to ("" = anyone)
  addQty: 1,                // quantity for the next new shopping item
  collapseDone: localStorage.getItem("checklist.collapseDone") === "1",
};

// Shopping mode is a per-list UI preference, stored locally per device.
function isShopMode(listId) { return localStorage.getItem("checklist.shop." + listId) === "1"; }
function setShopMode(listId, on) { localStorage.setItem("checklist.shop." + listId, on ? "1" : "0"); }

// The people filter is remembered per list, per device.
function loadFilter(listId) { return localStorage.getItem("checklist.filter." + listId) || "all"; }
function saveFilter(listId, val) { localStorage.setItem("checklist.filter." + listId, val); }

// Subtask collapse state, per item, per device. Expanded by default.
function isCollapsed(itemId) { return localStorage.getItem("checklist.collapse." + itemId) === "1"; }
function setCollapsed(itemId, on) { localStorage.setItem("checklist.collapse." + itemId, on ? "1" : "0"); }

// --- Tree helpers (one level deep) ---
function childrenOf(list, parentId) {
  return list.items
    .filter((i) => i.parent_id === parentId)
    .sort((a, b) => (a.position || 0) - (b.position || 0));
}
function hasChildren(list, itemId) { return list.items.some((i) => i.parent_id === itemId); }
// "Leaves" are the things you actually tick: childless top-level items + all children.
function leavesOf(list) { return list.items.filter((i) => !hasChildren(list, i.id)); }

const EMOJIS = ["📝","🏠","🛒","✅","🧹","🍳","🧺","💼","✈️","🎁","💪","📚","🐱","🌱","🔧","💡"];
const COLORS = ["indigo","emerald","rose","amber","sky","violet","slate"];
const AV_PALETTE = ["#4f46e5","#0f9d78","#e2445c","#e08a00","#2f8fd8","#8b5cf6","#d4428a"];

// Everyone the app knows about: the current user plus whoever appears in the
// data (as assignee, creator, or completer). No names are hard-coded.
function peopleList() {
  const seen = new Set();
  const out = [];
  const add = (n) => { if (n && !seen.has(n)) { seen.add(n); out.push(n); } };
  add(State.user);
  for (const l of State.lists) for (const it of l.items) {
    add(it.assignee); add(it.created_by); add(it.done_by);
  }
  return out;
}
function personColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_PALETTE[h % AV_PALETTE.length];
}
function avatarHTML(name, cls = "av") {
  if (!name) return `<span class="${cls}" style="background:var(--text-dim)">·</span>`;
  return `<span class="${cls}" style="background:${personColor(name)}">${esc(name[0].toUpperCase())}</span>`;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Base path the app is served under ("/" locally, "/<long-path>/" behind a proxy).
const BASE = (() => {
  let p = location.pathname;
  if (!p.endsWith("/")) p = p.replace(/[^/]*$/, "");
  return p || "/";
})();

function api(path, opts = {}) {
  const url = path.startsWith("/") ? BASE + path.slice(1) : path;
  let { method = "GET", headers, ...rest } = opts;
  headers = { "Content-Type": "application/json", ...(headers || {}) };
  // Tunnel PATCH/DELETE over POST so it works behind GET/HEAD/POST-only proxies.
  if (method === "PATCH" || method === "DELETE") {
    headers["X-HTTP-Method-Override"] = method;
    method = "POST";
  }
  return fetch(url, { method, headers, ...rest }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function currentList() {
  return State.lists.find((l) => l.id === State.currentId) || State.lists[0] || null;
}

// ---------------------------------------------------------------------------
// WebSocket live sync (with reconnect)
// ---------------------------------------------------------------------------
let ws = null;
let wsRetry = 0;

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}${BASE}ws`);
  ws.onopen = () => { wsRetry = 0; setConn(true); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") setState(msg.data);
    } catch (e) { /* ignore */ }
  };
  ws.onclose = () => {
    setConn(false);
    wsRetry = Math.min(wsRetry + 1, 6);
    setTimeout(connectWS, 400 * wsRetry);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function setConn(on) {
  const el = $("#conn");
  if (el) el.classList.toggle("off", !on);
}

function setState(data) {
  State.lists = data.lists || [];
  if (!State.lists.find((l) => l.id === State.currentId)) {
    State.currentId = State.lists[0] ? State.lists[0].id : null;
  }
  render();
}

function refresh() {
  return api("/api/state").then(setState).catch(() => {});
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  renderNav();
  renderMain();
  updateAssignBtn();
  updateQtyWidget();
}

function itemMatchesFilter(it) {
  const f = State.filter;
  if (f === "all") return true;
  if (f === "mine") return it.assignee && it.assignee === State.user;
  if (f === "unassigned") return !it.assignee;
  return it.assignee === f;
}

function renderFilterBar(list) {
  const bar = $("#filter-bar");
  bar.innerHTML = "";
  // People filters only make sense for task lists.
  if (!list || list.kind !== "tasks") { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const active = leavesOf(list).filter((i) => !i.done);
  const countFor = (pred) => active.filter(pred).length;

  const chips = [];
  chips.push({ key: "all", label: "All", count: active.length, plain: true });
  if (State.user) chips.push({ key: "mine", label: "Mine", count: countFor((i) => i.assignee === State.user), av: State.user });
  peopleList().forEach((p) => {
    if (p === State.user && State.filter !== p) { /* still show, Mine is separate */ }
    chips.push({ key: p, label: p, count: countFor((i) => i.assignee === p), av: p });
  });
  chips.push({ key: "unassigned", label: "Anyone", count: countFor((i) => !i.assignee), plain: true });

  chips.forEach((c) => {
    const b = document.createElement("button");
    b.className = "filter-chip" + (c.plain ? " plain" : "") + (State.filter === c.key ? " active" : "");
    b.innerHTML = (c.av ? avatarHTML(c.av, "av") : "") +
      `<span>${esc(c.label)}</span><span class="fc-count">${c.count}</span>`;
    b.onclick = () => { saveFilter(list.id, c.key); State.filter = c.key; render(); };
    bar.appendChild(b);
  });
}

function renderNav() {
  const nav = $("#list-nav");
  nav.innerHTML = "";
  State.lists.forEach((l) => {
    const open = leavesOf(l).filter((i) => !i.done).length;
    const btn = document.createElement("button");
    btn.className = "list-link" + (l.id === State.currentId ? " active" : "");
    btn.draggable = true;
    btn.dataset.id = l.id;
    btn.innerHTML = `<span class="ll-emoji">${esc(l.emoji)}</span>
      <span class="ll-name" dir="auto">${esc(l.name)}</span>
      <span class="ll-count">${open}</span>`;
    btn.onclick = () => selectList(l.id);
    attachListDrag(btn);
    nav.appendChild(btn);
  });
}

function renderMain() {
  const l = currentList();
  const nameEl = $("#list-name");
  const emojiEl = $("#list-emoji");
  const items = $("#items");
  items.innerHTML = "";

  if (!l) {
    nameEl.textContent = "No lists";
    emojiEl.textContent = "📋";
    $("#progress-wrap").classList.add("hidden");
    $("#empty-state").classList.remove("hidden");
    $("#empty-state").querySelector("p").textContent = "Create your first list to get started.";
    return;
  }

  State.currentId = l.id;
  document.documentElement.style.setProperty("--accent", colorVar(l.color));
  document.documentElement.style.setProperty("--accent-soft", colorSoft(l.color));
  nameEl.textContent = l.name;
  nameEl.dir = "auto";
  emojiEl.textContent = l.emoji;

  // ---- Type-driven UI ----
  const isShopping = l.kind === "shopping";
  const isTasks = l.kind === "tasks";
  const shopMode = isShopping && isShopMode(l.id);

  $("#assign-btn").classList.toggle("hidden", !isTasks);         // assignees: tasks only
  $("#qty-widget").classList.toggle("hidden", !isShopping);      // quantity: shopping only
  $("#shop-mode-btn").classList.toggle("hidden", !isShopping);   // shopping mode: shopping only
  $("#shop-mode-btn").classList.toggle("on", shopMode);
  $("#item-input").placeholder = isShopping
    ? "Add an item to buy…"
    : (isTasks ? "Add a task and press Enter…" : "Add an item and press Enter…");
  items.classList.toggle("shopping", shopMode);

  // Progress counts the leaves (what you actually tick), not container parents.
  const leaves = leavesOf(l);
  const total = leaves.length;
  const doneCount = leaves.filter((i) => i.done).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  $("#progress-wrap").classList.toggle("hidden", total === 0);
  $("#progress-fill").style.width = pct + "%";
  $("#progress-text").textContent = isShopping ? `${doneCount}/${total} bought` : `${doneCount}/${total}`;

  State.filter = loadFilter(l.id);
  renderFilterBar(l);

  // Only top-level items drive the sections. A parent matches the filter if it
  // or any of its children match (children render under it for context).
  const topMatches = (it) => {
    if (!isTasks) return true;
    if (itemMatchesFilter(it)) return true;
    return childrenOf(l, it.id).some(itemMatchesFilter);
  };
  const top = l.items.filter((i) => !i.parent_id && topMatches(i));
  const active = top.filter((i) => !i.done).sort((a, b) => (a.position || 0) - (b.position || 0));
  const done = top.filter((i) => i.done).sort((a, b) => (b.done_at || 0) - (a.done_at || 0));

  $("#empty-state").classList.toggle("hidden", top.length !== 0);
  if (top.length === 0) {
    $("#empty-state").querySelector("p").textContent =
      l.items.length === 0 ? "Nothing here yet. Add your first item above."
                           : "No items match this filter.";
  }

  active.forEach((it) => appendItemTree(items, it, l));

  if (done.length) {
    const divider = document.createElement("li");
    divider.className = "section-divider" + (State.collapseDone ? " collapsed" : "");
    divider.innerHTML = `<span class="chev">▾</span> ${isShopping ? "Bought" : "Completed"} · ${done.length}`;
    divider.onclick = () => {
      State.collapseDone = !State.collapseDone;
      localStorage.setItem("checklist.collapseDone", State.collapseDone ? "1" : "0");
      render();
    };
    items.appendChild(divider);
    if (!State.collapseDone) {
      done.forEach((it) => appendItemTree(items, it, l));
    }
  }
}

// Which parent currently has its inline "add subtask" input open (null = none).
let addSubtaskFor = null;

function appendItemTree(container, it, l) {
  container.appendChild(renderItem(it, l));
  const kids = childrenOf(l, it.id);
  const adding = addSubtaskFor === it.id;              // force-expand while adding
  if ((kids.length && !isCollapsed(it.id)) || adding) {
    kids.forEach((ch) => container.appendChild(renderItem(ch, l)));
    if (adding) container.appendChild(renderSubtaskInput(it, l));
  }
}

function renderSubtaskInput(parent, l) {
  const li = document.createElement("li");
  li.className = "item child subtask-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "subtask-input";
  input.dir = "auto";
  input.placeholder = "Add a subtask, Enter to save…";
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.value = "";
      api(`/api/lists/${l.id}/items`, {
        method: "POST",
        body: JSON.stringify({ text: v, by: State.user || "", parent_id: parent.id }),
      }).then(refresh).catch(() => toast("Could not add subtask"));
    } else if (e.key === "Escape") {
      addSubtaskFor = null;
      render();
    }
  };
  li.appendChild(input);
  setTimeout(() => input.focus(), 0);
  return li;
}

function renderItem(it, list) {
  const isShopping = list.kind === "shopping";
  const isTasks = list.kind === "tasks";
  const shopMode = isShopping && isShopMode(list.id);
  const isChild = !!it.parent_id;
  const kids = childrenOf(list, it.id);
  const isParentRow = kids.length > 0;
  const doneKids = kids.filter((k) => k.done).length;

  const li = document.createElement("li");
  li.className = "item" + (it.done ? " done" : "") + (isChild ? " child" : "") + (isParentRow ? " parent" : "");
  li.dataset.id = it.id;
  li.dataset.parent = it.parent_id || "root";
  li.draggable = !it.done && !shopMode;

  // Chevron to collapse/expand a parent; a spacer keeps leaf rows aligned.
  const chevron = document.createElement("span");
  chevron.className = "twisty";
  if (isParentRow) {
    chevron.textContent = "▾";
    chevron.classList.toggle("collapsed", isCollapsed(it.id));
    chevron.title = "Collapse / expand";
    chevron.onclick = (e) => { e.stopPropagation(); setCollapsed(it.id, !isCollapsed(it.id)); render(); };
  }

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = it.done ? "" : "⠿";
  grip.style.visibility = it.done ? "hidden" : "visible";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "check";
  cb.checked = it.done;
  // A parent's box is derived: checked when all children done, dash when some.
  if (isParentRow) cb.indeterminate = doneKids > 0 && doneKids < kids.length;
  cb.onchange = () => toggleItem(it, cb.checked);

  const body = document.createElement("div");
  body.className = "item-body";
  const text = document.createElement("div");
  text.className = "item-text";
  text.textContent = it.text;
  text.dir = "auto";
  if (!shopMode) {
    text.title = "Click to edit";
    text.onclick = () => editItemText(it, text);
  }
  body.appendChild(text);
  if (it.note) {
    const note = document.createElement("div");
    note.className = "item-note";
    note.textContent = it.note;
    note.dir = "auto";
    body.appendChild(note);
  }

  const meta = document.createElement("div");
  meta.className = "item-meta";
  if (isParentRow) {
    meta.insertAdjacentHTML("beforeend", `<span class="subprog">${doneKids}/${kids.length}</span>`);
  }
  // Assignee lives on the things you actually do (leaves), not container parents.
  if (isTasks && !isParentRow) {
    const chip = document.createElement("span");
    chip.className = "assignee-chip" + (it.assignee ? "" : " unassigned");
    chip.innerHTML = it.assignee
      ? `${avatarHTML(it.assignee, "av")}<span>${esc(it.assignee)}</span>`
      : `<span>+ assign</span>`;
    chip.title = "Assign to someone";
    chip.onclick = (e) => {
      e.stopPropagation();
      openPeoplePopover(chip, it.assignee, (name) => {
        api(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ assignee: name }) })
          .then(refresh).catch(() => toast("Could not assign"));
      });
    };
    meta.appendChild(chip);
  }
  // "+ subtask" on top-level items of task/general lists.
  if (!isShopping && !isChild) {
    const addSub = document.createElement("button");
    addSub.className = "add-sub";
    addSub.textContent = "＋ subtask";
    addSub.onclick = (e) => {
      e.stopPropagation();
      addSubtaskFor = it.id;
      setCollapsed(it.id, false);
      render();
    };
    meta.appendChild(addSub);
  }
  if (it.done && it.done_by) meta.insertAdjacentHTML("beforeend", `<span class="tag">✓ ${esc(it.done_by)}</span>`);
  else if (!isParentRow && it.created_by) meta.insertAdjacentHTML("beforeend", `<span class="tag">added by ${esc(it.created_by)}</span>`);
  if (meta.childNodes.length) body.appendChild(meta);

  li.append(chevron, grip, cb, body);

  // Quantity stepper for shopping lists
  if (isShopping) {
    const qty = document.createElement("div");
    qty.className = "item-qty";
    const minus = document.createElement("button"); minus.textContent = "−"; minus.setAttribute("aria-label", "Less");
    const val = document.createElement("span"); val.className = "q-val"; val.textContent = "×" + (it.qty || 1);
    const plus = document.createElement("button"); plus.textContent = "＋"; plus.setAttribute("aria-label", "More");
    minus.onclick = (e) => { e.stopPropagation(); changeQty(it, -1); };
    plus.onclick = (e) => { e.stopPropagation(); changeQty(it, +1); };
    qty.append(minus, val, plus);
    li.appendChild(qty);
  }

  const del = document.createElement("button");
  del.className = "item-del";
  del.textContent = "✕";
  del.title = "Delete";
  del.onclick = (e) => {
    e.stopPropagation();
    if (isParentRow && !confirm(`Delete "${it.text}" and its ${kids.length} subtask(s)?`)) return;
    deleteItem(it);
  };
  li.appendChild(del);

  if (shopMode) {
    // Whole row is one big tap target; checkbox is just an indicator.
    cb.style.pointerEvents = "none";
    li.onclick = () => toggleItem(it, !it.done);
  } else {
    attachItemDrag(li, list);
  }
  return li;
}

function changeQty(it, delta) {
  const next = Math.max(1, (it.qty || 1) + delta);
  if (next === (it.qty || 1)) return;
  api(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ qty: next }) })
    .then(refresh).catch(() => toast("Could not update quantity"));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
function selectList(id) {
  State.currentId = id;
  localStorage.setItem("checklist.current", id);
  closeSidebar();
  render();
}

function addItem() {
  const input = $("#item-input");
  const text = input.value.trim();
  const l = currentList();
  if (!text || !l) return;
  input.value = "";
  input.focus();
  const payload = { text, by: State.user || "" };
  if (l.kind === "tasks") payload.assignee = State.addAssignee || "";
  if (l.kind === "shopping") payload.qty = State.addQty || 1;
  api(`/api/lists/${l.id}/items`, {
    method: "POST",
    body: JSON.stringify(payload),
  }).then(() => {
    State.addQty = 1;
    updateQtyWidget();
    return refresh();
  }).catch(() => toast("Could not add item"));
}

function toggleItem(it, done) {
  api(`/api/items/${it.id}`, {
    method: "PATCH",
    body: JSON.stringify({ done, by: State.user || "" }),
  }).then(refresh).catch(() => toast("Could not update"));
}

function deleteItem(it) {
  api(`/api/items/${it.id}`, { method: "DELETE" }).then(refresh).catch(() => toast("Could not delete"));
}

function editItemText(it, el) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = it.text;
  input.dir = "auto";
  input.className = "inline-edit";
  input.style.cssText = "width:100%;font-size:15px;padding:4px 6px;border:1px solid var(--accent);border-radius:8px;background:var(--bg);color:var(--text);outline:none;";
  el.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const save = () => {
    const v = input.value.trim();
    if (v && v !== it.text) {
      api(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ text: v }) })
        .then(refresh).catch(() => toast("Could not save"));
    } else {
      render();
    }
  };
  input.onblur = save;
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.onblur = null; render(); }
  };
}

function clearCompleted() {
  const l = currentList();
  if (!l) return;
  api(`/api/lists/${l.id}/clear-completed`, { method: "POST" }).then(refresh).catch(() => {});
}

function deleteList() {
  const l = currentList();
  if (!l) return;
  if (!confirm(`Delete the list "${l.name}" and all its items?`)) return;
  api(`/api/lists/${l.id}`, { method: "DELETE" }).then(refresh).catch(() => {});
}

// ---------------------------------------------------------------------------
// Drag & drop — items
// ---------------------------------------------------------------------------
let dragEl = null;
function attachItemDrag(li, list) {
  li.addEventListener("dragstart", (e) => { dragEl = li; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    $$(".item").forEach((x) => x.classList.remove("drop-before"));
    // Reorder only within the same sibling scope (same parent, or top-level).
    const scope = li.dataset.parent;
    const order = $$(`#items .item[data-parent="${scope}"]:not(.done)`).map((x) => x.dataset.id);
    api(`/api/lists/${list.id}/items/reorder`, { method: "POST", body: JSON.stringify({ order }) })
      .then(refresh).catch(() => {});
    dragEl = null;
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragEl || dragEl === li) return;
    if (li.dataset.parent !== dragEl.dataset.parent) return;  // don't cross scopes
    const box = li.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;
    $$(".item").forEach((x) => x.classList.remove("drop-before"));
    if (before) { li.classList.add("drop-before"); li.parentNode.insertBefore(dragEl, li); }
    else { li.parentNode.insertBefore(dragEl, li.nextSibling); }
  });
}

// ---------------------------------------------------------------------------
// Drag & drop — lists
// ---------------------------------------------------------------------------
let dragList = null;
function attachListDrag(btn) {
  btn.addEventListener("dragstart", (e) => { dragList = btn; btn.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  btn.addEventListener("dragend", () => {
    btn.classList.remove("dragging");
    $$(".list-link").forEach((x) => x.classList.remove("drop-before"));
    const order = $$("#list-nav .list-link").map((x) => x.dataset.id);
    api("/api/lists/reorder", { method: "POST", body: JSON.stringify({ order }) }).then(refresh).catch(() => {});
    dragList = null;
  });
  btn.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragList || dragList === btn) return;
    const box = btn.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;
    if (before) btn.parentNode.insertBefore(dragList, btn);
    else btn.parentNode.insertBefore(dragList, btn.nextSibling);
  });
}

// ---------------------------------------------------------------------------
// List menu popover
// ---------------------------------------------------------------------------
function openListMenu() {
  const menu = $("#list-menu");
  const btn = $("#list-menu-btn");
  const r = btn.getBoundingClientRect();
  menu.classList.remove("hidden");
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
}
function closeListMenu() { $("#list-menu").classList.add("hidden"); }

// Reusable people picker popover. onPick receives the chosen name, or "" for unassigned.
let peoplePop = null;
function closePeoplePopover() { if (peoplePop) { peoplePop.remove(); peoplePop = null; } }
function openPeoplePopover(anchor, current, onPick) {
  closePeoplePopover();
  const pop = document.createElement("div");
  pop.className = "popover people-pop";
  const options = [{ name: "", label: "Anyone" }, ...peopleList().map((n) => ({ name: n, label: n }))];
  options.forEach((o) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="pp-row">${o.name ? avatarHTML(o.name, "av") : avatarHTML("", "av")}<span>${esc(o.label)}</span>${o.name === current ? " ✓" : ""}</span>`;
    b.onclick = (e) => { e.stopPropagation(); closePeoplePopover(); onPick(o.name); };
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - pop.offsetWidth - 8;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
  pop.style.left = Math.max(8, left) + "px";
  pop.style.top = Math.max(8, top) + "px";
  peoplePop = pop;
}

function updateQtyWidget() {
  const v = $("#qty-value");
  if (v) v.textContent = State.addQty;
}

function updateAssignBtn() {
  const name = State.addAssignee;
  const av = $("#assign-av");
  const label = $("#assign-label");
  if (av) {
    av.style.background = name ? personColor(name) : "var(--text-dim)";
    av.textContent = name ? name[0].toUpperCase() : "·";
  }
  if (label) label.textContent = name || "Anyone";
}

// ---------------------------------------------------------------------------
// Modal: create / edit list
// ---------------------------------------------------------------------------
function openListModal(existing) {
  const edit = !!existing;
  let sel = {
    name: existing ? existing.name : "",
    emoji: existing ? existing.emoji : "📝",
    color: existing ? existing.color : "indigo",
    kind: existing ? existing.kind : "generic",
  };
  const modal = $("#modal");
  modal.innerHTML = `
    <h2>${edit ? "Edit list" : "New list"}</h2>
    <label>Name</label>
    <input type="text" id="m-name" maxlength="80" placeholder="e.g. Groceries" value="${escAttr(sel.name)}" dir="auto" />
    <label>Icon</label>
    <div class="emoji-row" id="m-emoji">${EMOJIS.map((e) => `<button class="emoji-opt${e===sel.emoji?" sel":""}" data-e="${e}">${e}</button>`).join("")}</div>
    <label>Color</label>
    <div class="color-row" id="m-color">${COLORS.map((c) => `<button class="color-opt${c===sel.color?" sel":""}" data-c="${c}" style="background:${colorVar(c)}"></button>`).join("")}</div>
    <label>Type — this shapes how the list behaves</label>
    <div class="kind-row" id="m-kind">
      <button class="kind-opt${sel.kind==="tasks"?" sel":""}" data-k="tasks">✅ Tasks</button>
      <button class="kind-opt${sel.kind==="shopping"?" sel":""}" data-k="shopping">🛒 Shopping</button>
      <button class="kind-opt${sel.kind==="generic"?" sel":""}" data-k="generic">📝 General</button>
    </div>
    <div class="kind-hint" id="m-kind-hint"></div>
    <div class="modal-actions">
      <button class="btn-ghost" id="m-cancel">Cancel</button>
      <button class="primary" id="m-save">${edit ? "Save" : "Create"}</button>
    </div>`;
  $("#modal-backdrop").classList.remove("hidden");
  const nameInput = $("#m-name");
  nameInput.focus();

  modal.querySelector("#m-emoji").onclick = (e) => {
    const b = e.target.closest(".emoji-opt"); if (!b) return;
    sel.emoji = b.dataset.e;
    modal.querySelectorAll(".emoji-opt").forEach((x) => x.classList.toggle("sel", x === b));
  };
  modal.querySelector("#m-color").onclick = (e) => {
    const b = e.target.closest(".color-opt"); if (!b) return;
    sel.color = b.dataset.c;
    modal.querySelectorAll(".color-opt").forEach((x) => x.classList.toggle("sel", x === b));
  };
  const KIND_HINTS = {
    tasks: "Assign items to people, filter by who, and see who completed what.",
    shopping: "Add quantities (×2, ×3) and switch on Shopping Mode for big one-tap buying.",
    generic: "A plain checklist — just items you tick off. No people, no quantities.",
  };
  const kindHint = modal.querySelector("#m-kind-hint");
  const setKindHint = () => { kindHint.textContent = KIND_HINTS[sel.kind] || ""; };
  setKindHint();
  modal.querySelector("#m-kind").onclick = (e) => {
    const b = e.target.closest(".kind-opt"); if (!b) return;
    sel.kind = b.dataset.k;
    modal.querySelectorAll(".kind-opt").forEach((x) => x.classList.toggle("sel", x === b));
    setKindHint();
  };
  $("#m-cancel").onclick = closeModal;
  $("#m-save").onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const payload = { name, emoji: sel.emoji, color: sel.color, kind: sel.kind };
    const req = edit
      ? api(`/api/lists/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      : api("/api/lists", { method: "POST", body: JSON.stringify(payload) });
    req.then((res) => {
      closeModal();
      if (!edit && res && res.id) State.currentId = res.id;
      return refresh();
    }).catch(() => toast("Could not save list"));
  };
  nameInput.onkeydown = (e) => { if (e.key === "Enter") $("#m-save").click(); };
}

function closeModal() { $("#modal-backdrop").classList.add("hidden"); }

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
function openIdentityModal() {
  const modal = $("#modal");
  // Offer existing people (from the data) as quick picks; otherwise just type a name.
  const known = peopleList().filter((n) => n !== State.user);
  const quick = known.length
    ? `<div class="people-grid">${known.map((n) =>
        `<button class="person-opt" data-n="${escAttr(n)}"><span class="pa" style="background:${personColor(n)}">${esc(n[0].toUpperCase())}</span>${esc(n)}</button>`
      ).join("")}</div><label>Or enter a name</label>`
    : "";
  modal.innerHTML = `
    <h2>Who's using this?</h2>
    <p style="color:var(--text-dim);font-size:14px;margin:-8px 0 16px">So we can show who added and completed items.</p>
    ${quick}
    <input type="text" id="who-custom" maxlength="40" placeholder="Your name" dir="auto" />
    <div class="modal-actions">
      <button class="primary" id="who-save">Continue</button>
    </div>`;
  $("#modal-backdrop").classList.remove("hidden");
  const grid = modal.querySelector(".people-grid");
  if (grid) grid.onclick = (e) => {
    const b = e.target.closest(".person-opt"); if (!b) return;
    setUser(b.dataset.n);
  };
  $("#who-save").onclick = () => {
    const v = $("#who-custom").value.trim();
    if (v) setUser(v);
  };
  $("#who-custom").onkeydown = (e) => { if (e.key === "Enter") $("#who-save").click(); };
}

function setUser(name) {
  State.user = name;
  localStorage.setItem("checklist.user", name);
  closeModal();
  updateWho();
}

function updateWho() {
  $("#who-name").textContent = State.user || "Pick name";
  $("#who-avatar").textContent = State.user ? State.user[0].toUpperCase() : "?";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function colorVar(c) { return getComputedStyle(document.documentElement).getPropertyValue("--c-" + c).trim() || "#4f46e5"; }
function colorSoft(c) {
  const map = { indigo:"#eceafe", emerald:"#dcf5ee", rose:"#fde3e8", amber:"#fcefd6", sky:"#dceefb", violet:"#efe8fe", slate:"#e8ecf2" };
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    const dmap = { indigo:"#272152", emerald:"#123a30", rose:"#3d1b24", amber:"#3a2e12", sky:"#13304a", violet:"#2c1f4d", slate:"#222834" };
    return dmap[c] || "#272152";
  }
  return map[c] || "#eceafe";
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  if (!$("#sidebar-scrim")) {
    const s = document.createElement("div");
    s.id = "sidebar-scrim";
    s.onclick = closeSidebar;
    document.body.appendChild(s);
  }
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  const s = $("#sidebar-scrim");
  if (s) s.remove();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
// Optional, deployment-specific identity remapping. If a deployment renames a
// person, drop an identity-aliases.json next to the app ({"Old":"New"}) and
// devices still holding the old name self-heal on load. Absent by default.
function applyIdentityAliases() {
  fetch(BASE + "identity-aliases.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((map) => {
      if (map && State.user && map[State.user]) {
        State.user = map[State.user];
        localStorage.setItem("checklist.user", State.user);
        updateWho();
        render();
      }
    })
    .catch(() => {});
}

function init() {
  updateWho();
  applyIdentityAliases();
  $("#add-item-btn").onclick = addItem;
  $("#item-input").onkeydown = (e) => { if (e.key === "Enter") addItem(); };
  $("#add-list-btn").onclick = () => openListModal(null);
  $("#who-btn").onclick = openIdentityModal;
  $("#menu-btn").onclick = openSidebar;
  $("#assign-btn").onclick = (e) => {
    e.stopPropagation();
    openPeoplePopover($("#assign-btn"), State.addAssignee, (name) => {
      State.addAssignee = name;
      updateAssignBtn();
      $("#item-input").focus();
    });
  };
  $("#qty-minus").onclick = () => { State.addQty = Math.max(1, State.addQty - 1); updateQtyWidget(); $("#item-input").focus(); };
  $("#qty-plus").onclick = () => { State.addQty = Math.min(9999, State.addQty + 1); updateQtyWidget(); $("#item-input").focus(); };
  $("#shop-mode-btn").onclick = () => {
    const l = currentList();
    if (!l) return;
    setShopMode(l.id, !isShopMode(l.id));
    render();
  };

  $("#list-menu-btn").onclick = (e) => { e.stopPropagation(); openListMenu(); };
  $("#list-menu").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    closeListMenu();
    if (b.dataset.act === "edit") openListModal(currentList());
    if (b.dataset.act === "clear") clearCompleted();
    if (b.dataset.act === "delete") deleteList();
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#list-menu") && !e.target.closest("#list-menu-btn")) closeListMenu();
    if (!e.target.closest(".people-pop") && !e.target.closest(".assignee-chip") && !e.target.closest("#assign-btn")) closePeoplePopover();
  });
  $("#modal-backdrop").onclick = (e) => { if (e.target.id === "modal-backdrop" && State.user) closeModal(); };

  if (!State.user) openIdentityModal();

  refresh();
  connectWS();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(BASE + "sw.js?v=8").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
