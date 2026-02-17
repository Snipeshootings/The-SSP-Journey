// ==UserScript==
// @name         Dock Command (All-in-One Preview)
// @namespace    dock-command
// @version      0.4.0
// @description  Dock Command preview workbench (grid + grouped toolbox + lock/swap modes)
// @match        https://*/*
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/gridstack@11.2.0/dist/gridstack-all.js
// ==/UserScript==

(() => {
  "use strict";

  // ---------------------------
  // Config
  // ---------------------------
  const HOTKEY = { ctrl: true, shift: true, key: "D" };
  const Z = 2147483647;
  const APP_ID = "dc-root";
  const STATE_KEY = "dockcmd.preview.state.v2";

  // Tool catalog (id must be unique)
  const TOOLS = [
    { id: "flow", title: "Flow", desc: "Buckets + quick actions", alerts: 0, w: 12, h: 12 },
    { id: "atlas", title: "Atlas", desc: "Ops events + status feed", alerts: 1, w: 8, h: 10 },

    // Execution apps
    { id: "sortation", title: "Sortation", desc: "Sort center execution view", alerts: 0, w: 8, h: 10 },
    { id: "crossdock", title: "Crossdock", desc: "Crossdock console + proxies", alerts: 0, w: 8, h: 10 },

    // Data tools
    { id: "relay", title: "Relay", desc: "Canonical load truth", alerts: 2, w: 8, h: 10 },
    { id: "ssp", title: "SSP", desc: "Targets + shift config", alerts: 0, w: 7, h: 9 },
    { id: "yms", title: "YMS", desc: "Yard state + trailers", alerts: 1, w: 7, h: 9 },
    { id: "troubleshoot", title: "Troubleshoot", desc: "Blockers + exceptions", alerts: 3, w: 8, h: 9 },

    // People
    { id: "assoc_assign", title: "Associate Assignments", desc: "Assignments + move list", alerts: 0, w: 8, h: 10 },
    { id: "scheduling", title: "Scheduling", desc: "Shift coverage + staffing", alerts: 0, w: 8, h: 10 },
    { id: "engage", title: "Engage", desc: "Engagement + comms actions", alerts: 1, w: 7, h: 9 },

    // Comms
    { id: "slack", title: "Slack", desc: "Slack integration panel", alerts: 2, w: 7, h: 9 },
  ];

  // Toolbox groups (order matters)
  const GROUPS = [
    { id: "execution", title: "Execution", items: ["flow", "atlas", "sortation", "crossdock"] },
    { id: "data", title: "Data", items: ["relay", "ssp", "yms", "troubleshoot"] },
    { id: "people", title: "People", items: ["assoc_assign", "scheduling", "engage"] },
    { id: "comms", title: "Comms", items: ["slack"] },
  ];

  // ---------------------------
  // CSS
  // ---------------------------
  GM_addStyle(`
    @import url("https://cdn.jsdelivr.net/npm/gridstack@11.2.0/dist/gridstack.min.css");

    #${APP_ID} { position: fixed; inset: 0; z-index: ${Z}; display: none; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
    #${APP_ID}[data-open="true"] { display: block; }

    .dc-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.25); backdrop-filter: blur(2px); }
    .dc-shell { position: absolute; inset: 0; }

    .dc-topbar {
      position: absolute; top: 0; left: 0; right: 0; height: 56px;
      background: rgba(17,17,17,0.82); color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 16px; border-bottom: 1px solid rgba(255,255,255,0.12);
    }
    .dc-brand { display:flex; gap:10px; align-items:center; }
    .dc-logo { width: 36px; height: 36px; border-radius: 14px; background: #fff; color:#111; display:grid; place-items:center; font-weight: 900; }
    .dc-title { font-weight: 800; font-size: 14px; line-height: 1.1; }
    .dc-sub { font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 2px; }

    .dc-actions { display:flex; gap:10px; align-items:center; }
    .dc-btn {
      height: 36px; padding: 0 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.08); color: #fff; cursor: pointer;
    }
    .dc-btn:hover { background: rgba(255,255,255,0.14); }

    .dc-workspace {
      position: absolute; top: 56px; left: 0; right: 0; bottom: 0;
      padding: 14px 16px 16px 16px;
    }

    /* Grid overlay always on */
    .dc-grid-overlay {
      position: absolute; inset: 56px 0 0 0; pointer-events: none;
      background-image:
        repeating-linear-gradient(0deg, rgba(0,0,0,0.14) 0, rgba(0,0,0,0.14) 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(90deg, rgba(0,0,0,0.14) 0, rgba(0,0,0,0.14) 1px, transparent 1px, transparent 24px);
      opacity: 0.07;
      transition: opacity 160ms ease;
    }
    #${APP_ID}[data-edit="true"] .dc-grid-overlay { opacity: 0.22; }

    /* Grid container */
    .gridstack {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 18px;
      height: calc(100% - 0px);
    }
    .gridstack .grid-stack-item-content {
      background: rgba(255,255,255,0.86);
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.10);
    }

    /* Card */
    .dc-card-hd {
      height: 44px; display:flex; align-items:center; justify-content: space-between;
      padding: 0 12px; border-bottom: 1px solid rgba(0,0,0,0.06);
      background: rgba(255,255,255,0.9);
      cursor: move;
    }
    #${APP_ID}[data-locked="true"] .dc-card-hd { cursor: default; }
    .dc-card-title { font-weight: 800; font-size: 13px; color: #111; }
    .dc-card-sub { font-size: 11px; color: rgba(0,0,0,0.55); margin-top: 2px; max-width: 40ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
    .dc-card-meta { display:flex; gap: 8px; align-items:center; }
    .dc-pill { font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 10px; background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.75); }
    .dc-pill.warn { background: rgba(255,193,7,0.25); color: #7a4d00; }
    .dc-pill.danger { background: rgba(220,53,69,0.18); color: #7a0b18; }
    .dc-pill.ok { background: rgba(25,135,84,0.16); color: #0b4d2c; }
    .dc-x { width: 30px; height: 30px; border-radius: 12px; border: none; background: transparent; cursor: pointer; color: rgba(0,0,0,0.55); }
    .dc-x:hover { background: rgba(0,0,0,0.06); }

    .dc-card-bd { padding: 12px; }
    .dc-box { background: rgba(0,0,0,0.04); border-radius: 14px; padding: 10px; border: 1px solid rgba(0,0,0,0.06); }
    .dc-small { font-size: 11px; color: rgba(0,0,0,0.60); }
    .dc-strong { font-weight: 900; color: #111; }

    /* Toolbox (right, hover expand) */
    .dc-toolbox-wrap { position: absolute; top: 56px; right: 0; bottom: 0; width: 280px; }
    .dc-toolbox {
      position: absolute; top: 12px; right: 0; bottom: 12px;
      width: 280px; transform: translateX(calc(100% - 14px));
      transition: transform 160ms ease;
      background: rgba(17,17,17,0.86);
      border: 1px solid rgba(255,255,255,0.12);
      border-right: none;
      border-radius: 18px 0 0 18px;
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .dc-toolbox-wrap:hover .dc-toolbox { transform: translateX(0); }

    /* Handle pinned to screen edge */
    .dc-toolbox-handle {
      position: absolute;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      width: 14px; height: 96px;
      background: rgba(17,17,17,0.86);
      border: 1px solid rgba(255,255,255,0.12);
      border-right: none;
      border-radius: 12px 0 0 12px;
      display: grid; place-items: center;
      z-index: 2;
    }
    .dc-toolbox-handle:before { content: ""; width: 6px; height: 48px; border-radius: 999px; background: rgba(255,255,255,0.25); }

    .dc-toolbox-hd { height: 48px; display:flex; align-items:center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid rgba(255,255,255,0.12); color: #fff; }
    .dc-toolbox-hd .t { font-weight: 900; font-size: 13px; }
    .dc-toolbox-hd .settings { height: 34px; padding: 0 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; }
    .dc-toolbox-hd .settings:hover { background: rgba(255,255,255,0.14); }

    .dc-toolbox-body { padding: 10px; overflow:auto; flex: 1; }
    .dc-tool-hint { font-size: 11px; color: rgba(255,255,255,0.70); margin-bottom: 10px; padding: 0 2px; }

    /* Groups */
    .dc-group { border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05); border-radius: 16px; overflow: hidden; margin-bottom: 10px; }
    .dc-group-hd { display:flex; align-items:center; justify-content: space-between; padding: 10px 10px; cursor: pointer; user-select:none; }
    .dc-group-hd:hover { background: rgba(255,255,255,0.06); }
    .dc-group-title { font-weight: 900; font-size: 12px; color: rgba(255,255,255,0.92); }
    .dc-group-meta { font-size: 11px; color: rgba(255,255,255,0.60); display:flex; align-items:center; gap: 8px; }
    .dc-chevron { font-weight: 900; opacity: 0.8; }
    .dc-group-body { padding: 8px 8px 2px 8px; display: block; }
    .dc-group[data-open="false"] .dc-group-body { display: none; }

    .dc-tool {
      width: 100%; text-align: left; border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
      color: #fff;
      padding: 9px 10px;
      cursor: pointer;
      margin-bottom: 8px;
    }
    .dc-tool:hover { background: rgba(255,255,255,0.10); }
    .dc-tool .row { display:flex; justify-content: space-between; gap: 10px; }
    .dc-tool .name { font-weight: 900; font-size: 13px; }
    .dc-tool .desc { font-size: 11px; color: rgba(255,255,255,0.70); margin-top: 3px; }
    .dc-badge {
      font-size: 11px; font-weight: 900; padding: 4px 8px; border-radius: 12px;
      background: rgba(255,193,7,0.25); color: #ffd56a;
      border: 1px solid rgba(255,193,7,0.22);
      height: fit-content;
    }

    .dc-toolbox-ft { padding: 10px; border-top: 1px solid rgba(255,255,255,0.12); }
    .dc-lockrow { display:flex; justify-content: space-between; align-items:center; gap: 10px; }
    .dc-locklabel { color: rgba(255,255,255,0.88); font-size: 13px; font-weight: 800; }
    .dc-locksub { font-size: 11px; color: rgba(255,255,255,0.65); margin-top: 4px; }
    .dc-switch { width: 44px; height: 24px; padding: 3px; border-radius: 999px; background: #22c55e; cursor:pointer; display:flex; align-items:center; }
    .dc-switch[data-on="true"] { background: rgba(255,255,255,0.22); }
    .dc-knob { width: 18px; height: 18px; border-radius: 999px; background: #fff; transform: translateX(20px); transition: transform 120ms ease; }
    .dc-switch[data-on="true"] .dc-knob { transform: translateX(0px); }

    /* Settings placeholder modal */
    .dc-modal { position: absolute; inset: 0; display:none; }
    .dc-modal[data-open="true"] { display:block; }
    .dc-modal .bg { position:absolute; inset:0; background: rgba(0,0,0,0.45); }
    .dc-modal .panel {
      position: absolute; top: 0; right: 0; height: 100%; width: min(760px, 92vw);
      background: rgba(17,17,17,0.96); color:#fff;
      border-left: 1px solid rgba(255,255,255,0.12);
      padding: 14px;
    }
    .dc-modal .panel .hd { display:flex; justify-content: space-between; align-items:center; }
    .dc-modal .panel .hd .h { font-weight: 900; }
    .dc-modal .panel .close { height: 34px; padding: 0 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08); color:#fff; cursor:pointer; }
    .dc-modal .panel .close:hover { background: rgba(255,255,255,0.14); }
    .dc-modal .tabs { margin-top: 12px; display:flex; flex-wrap: wrap; gap: 8px; }
    .dc-modal .tab { font-size: 12px; font-weight: 800; padding: 7px 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); }
  `);

  // ---------------------------
  // State helpers
  // ---------------------------
  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function saveState(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
  }

  function defaultState() {
    // Group open/close defaults
    const groupOpen = {};
    for (const g of GROUPS) groupOpen[g.id] = true;

    return {
      open: false,
      locked: true,          // locked => execution mode
      active: "flow",        // full view tool in execution mode
      enabled: { flow: true }, // docked tools for edit mode
      layout: null,          // last edit layout (gridstack items)
      groupOpen,
    };
  }

  // ---------------------------
  // DOM boot
  // ---------------------------
  function ensureRoot() {
    let root = document.getElementById(APP_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = APP_ID;
    root.dataset.open = "false";
    root.dataset.locked = "true";
    root.dataset.edit = "false";
    root.innerHTML = `
      <div class="dc-backdrop"></div>
      <div class="dc-shell">
        <div class="dc-topbar">
          <div class="dc-brand">
            <div class="dc-logo">DC</div>
            <div>
              <div class="dc-title">Dock Command</div>
              <div class="dc-sub" id="dc-subline">Execution mode • viewing: FLOW</div>
            </div>
          </div>
          <div class="dc-actions">
            <button class="dc-btn" id="dc-settings-btn">Settings</button>
            <button class="dc-btn" id="dc-close-btn">Close</button>
          </div>
        </div>

        <div class="dc-grid-overlay"></div>

        <div class="dc-workspace">
          <div class="gridstack"></div>
        </div>

        <div class="dc-toolbox-wrap">
          <div class="dc-toolbox-handle"></div>
          <div class="dc-toolbox">
            <div class="dc-toolbox-hd">
              <div class="t">Toolbox</div>
              <button class="settings" id="dc-settings-btn-2">Settings</button>
            </div>
            <div class="dc-toolbox-body">
              <div class="dc-tool-hint" id="dc-tool-hint"></div>
              <div id="dc-tool-list"></div>
            </div>
            <div class="dc-toolbox-ft">
              <div class="dc-lockrow">
                <div>
                  <div class="dc-locklabel">Lock layout</div>
                  <div class="dc-locksub" id="dc-lock-sub"></div>
                </div>
                <div class="dc-switch" id="dc-lock-switch" data-on="true">
                  <div class="dc-knob"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="dc-modal" id="dc-settings-modal">
          <div class="bg" id="dc-settings-bg"></div>
          <div class="panel">
            <div class="hd">
              <div class="h">Dock Command Settings</div>
              <button class="close" id="dc-settings-close">Close</button>
            </div>
            <div class="tabs">
              ${["General","Shift Timings","Alerts","Calculations","Theme","Layout","Advanced"].map(t=>`<div class="tab">${t}</div>`).join("")}
            </div>
            <div style="margin-top:14px; font-size:12px; color: rgba(255,255,255,0.75);">
              Placeholder. Wire to your real settings model later.
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  // ---------------------------
  // Grid + cards
  // ---------------------------
  let grid = null;

  function toolById(id) {
    return TOOLS.find(t => t.id === id);
  }

  function cardHTML(toolId, canRemove) {
    const t = toolById(toolId);
    if (!t) return `<div class="grid-stack-item-content"><div style="padding:12px;">Unknown tool: ${toolId}</div></div>`;

    const badge = t.alerts > 0
      ? `<span class="dc-pill ${t.alerts>=3 ? "danger" : "warn"}">Alerts</span>`
      : `<span class="dc-pill ok">OK</span>`;

    const removeBtn = canRemove ? `<button class="dc-x" data-remove="${toolId}" title="Remove">✕</button>` : "";

    return `
      <div class="dc-card-hd">
        <div>
          <div class="dc-card-title">${t.title}</div>
          <div class="dc-card-sub">${t.desc}</div>
        </div>
        <div class="dc-card-meta">
          ${toolId === "flow" ? `<span class="dc-pill">Primary</span>` : badge}
          ${removeBtn}
        </div>
      </div>
      <div class="dc-card-bd">
        ${toolId === "flow" ? flowBody() : toolBody(t.title)}
      </div>
    `;
  }

  function flowBody() {
    return `
      <div class="dc-box">
        <div class="dc-strong">Flow Buckets</div>
        <div class="dc-small" style="margin-top:6px;">At-Risk: 3 • Approaching: 5 • Stable: 12</div>
      </div>
      <div style="height:10px;"></div>
      <div class="dc-box">
        <div class="dc-strong">Quick Action (next)</div>
        <div class="dc-small" style="margin-top:6px;">
          Call Drivers (±30m CPT) → VRID, Driver, Phone, Trailer, Location, TDRStatus
        </div>
      </div>
    `;
  }

  function toolBody(name) {
    if (name === "Crossdock") {
      return `
        <div class="dc-box">
          <div class="dc-strong">Crossdock Console</div>
          <div class="dc-small" style="margin-top:6px;">Proxy: NASC Dock Console Proxy • Status: Connected (mock)</div>
        </div>
        <div style="height:10px;"></div>
        <div class="dc-box" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
          <div class="dc-small">Latest</div>
          <div style="margin-top:6px; font-size:11px;">
            [OK] Loaded config…<br/>
            [OK] Listening for scans…<br/>
            [WARN] Stale relay snapshot: 00:01:12
          </div>
        </div>
      `;
    }

    if (name === "Atlas") {
      return `
        <div class="dc-box">
          <div class="dc-strong">Atlas Feed</div>
          <div class="dc-small" style="margin-top:6px;">Mock: site events, exceptions, notifications.</div>
        </div>
        <div style="height:10px;"></div>
        <div class="dc-box">
          <div class="dc-small">Last refresh</div>
          <div class="dc-strong" style="margin-top:3px;">00:00:09 ago</div>
        </div>
      `;
    }

    return `
      <div class="dc-box">
        <div class="dc-strong">${name} Panel</div>
        <div class="dc-small" style="margin-top:6px;">Placeholder widget for preview. Wire adapters later.</div>
      </div>
      <div style="height:10px;"></div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
        <div class="dc-box">
          <div class="dc-small">Last refresh</div>
          <div class="dc-strong" style="margin-top:3px;">00:00:12 ago</div>
        </div>
        <div class="dc-box">
          <div class="dc-small">Entities</div>
          <div class="dc-strong" style="margin-top:3px;">—</div>
        </div>
      </div>
    `;
  }

  function setSubline(root, state) {
    const el = root.querySelector("#dc-subline");
    el.textContent = state.locked
      ? `Execution mode • viewing: ${String(state.active).toUpperCase()}`
      : "Edit mode • drag/resize + dock widgets";
  }

  function setOverlayOpacity(root, state) {
    root.dataset.locked = state.locked ? "true" : "false";
    root.dataset.edit = state.locked ? "false" : "true";
  }

  function setLockUI(root, state) {
    const sw = root.querySelector("#dc-lock-switch");
    const sub = root.querySelector("#dc-lock-sub");
    sw.dataset.on = state.locked ? "true" : "false";
    sub.textContent = state.locked ? "Execution: swapping tools." : "Edit: drag/resize + dock tools.";
    const hint = root.querySelector("#dc-tool-hint");
    hint.textContent = state.locked
      ? "Execution mode: click a tool to swap the full view."
      : "Edit mode: click a tool to add it to the grid.";
  }

  function initGrid(root, state) {
    const el = root.querySelector(".gridstack");
    el.innerHTML = "";

    grid = GridStack.init(
      {
        column: 12,
        float: false,
        cellHeight: 24,
        margin: 10,
        disableDrag: state.locked,
        disableResize: state.locked,
        draggable: { handle: ".dc-card-hd" },
        resizable: { handles: "e, s, se" },
      },
      el
    );

    if (state.locked) mountFullView(state, root);
    else mountEditView(state, root);

    grid.on("change", () => {
      if (state.locked) return;
      const items = [];
      grid.engine.nodes.forEach(n => {
        if (!n.el) return;
        const id = n.el.getAttribute("gs-id");
        items.push({ id, x: n.x, y: n.y, w: n.w, h: n.h });
      });
      state.layout = items;
      saveState(state);
    });
  }

  function mountFullView(state, root) {
  grid.removeAll();

  const id = state.active || "flow";

  const el = grid.addWidget({ x: 0, y: 0, w: 12, h: 12 });
  el.setAttribute("gs-id", id);

  const contentEl = el.querySelector(".grid-stack-item-content");
  if (contentEl) contentEl.innerHTML = cardHTML(id, false);

  bindRemoveButtons(root, state);
}


  for (const it of items) {
  const canRemove = it.id !== "flow";

  const el = grid.addWidget({ x: it.x, y: it.y, w: it.w, h: it.h });
  el.setAttribute("gs-id", it.id);

  const contentEl = el.querySelector(".grid-stack-item-content");
  if (contentEl) contentEl.innerHTML = cardHTML(it.id, canRemove);
}
bindRemoveButtons(root, state);


  function bindRemoveButtons(root, state) {
    root.querySelectorAll("[data-remove]").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-remove");
        if (!id || id === "flow") return;

        delete state.enabled[id];

        const node = grid.engine.nodes.find(n => n.el && n.el.getAttribute("gs-id") === id);
        if (node) grid.removeWidget(node.el);

        if (state.layout) state.layout = state.layout.filter(x => x.id !== id);

        if (state.active === id) state.active = "flow";

        saveState(state);
        renderToolList(root, state);
      };
    });
  }

  // ---------------------------
  // Toolbox groups rendering
  // ---------------------------
  function renderToolList(root, state) {
    const list = root.querySelector("#dc-tool-list");
    list.innerHTML = "";

    for (const g of GROUPS) {
      const open = state.groupOpen?.[g.id] !== false;

      const group = document.createElement("div");
      group.className = "dc-group";
      group.dataset.group = g.id;
      group.dataset.open = open ? "true" : "false";

      const enabledCount = g.items.filter(id => state.enabled[id]).length;

      group.innerHTML = `
        <div class="dc-group-hd" data-group-toggle="${g.id}">
          <div class="dc-group-title">${g.title}</div>
          <div class="dc-group-meta">
            <span>${enabledCount}/${g.items.length}</span>
            <span class="dc-chevron">${open ? "▾" : "▸"}</span>
          </div>
        </div>
        <div class="dc-group-body"></div>
      `;

      const body = group.querySelector(".dc-group-body");

      for (const id of g.items) {
        const t = toolById(id);
        if (!t) continue;

        const badge = t.alerts > 0 ? `<div class="dc-badge">${t.alerts}</div>` : "";
        const enabled = !!state.enabled[t.id];
        const inEdit = !state.locked;
        const rightIcon = inEdit ? (enabled ? "🧱" : "＋") : "⤢";

        const btn = document.createElement("button");
        btn.className = "dc-tool";
        btn.dataset.tool = t.id;
        btn.innerHTML = `
          <div class="row">
            <div>
              <div class="name">${t.title}</div>
              <div class="desc">${t.desc}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              ${badge}
              <div style="font-weight:900; opacity:0.9;">${rightIcon}</div>
            </div>
          </div>
        `;
        body.appendChild(btn);
      }

      list.appendChild(group);
    }

    // Group toggle handler (event delegation)
    list.onclick = (e) => {
      const toggle = e.target.closest("[data-group-toggle]");
      if (toggle) {
        const gid = toggle.getAttribute("data-group-toggle");
        if (!state.groupOpen) state.groupOpen = {};
        state.groupOpen[gid] = !(state.groupOpen[gid] !== false); // toggle
        saveState(state);
        renderToolList(root, state);
        return;
      }

      const btn = e.target.closest(".dc-tool");
      if (!btn) return;
      const id = btn.dataset.tool;
      if (!id) return;

      if (state.locked) {
        swapTool(state, root, id);
      } else {
        addTool(state, root, id);
      }
    };
  }

  // ---------------------------
  // Mode actions
  // ---------------------------
  function swapTool(state, root, toolId) {
    state.active = toolId;
    saveState(state);
    setSubline(root, state);
    mountFullView(state, root);
  }

  const el = grid.addWidget({ x: 0, y: 999, w: Math.min(12, t.w), h: t.h });
el.setAttribute("gs-id", toolId);

const contentEl = el.querySelector(".grid-stack-item-content");
if (contentEl) contentEl.innerHTML = cardHTML(toolId, true);

  function toggleLock(state, root) {
    state.locked = !state.locked;

    // when unlocking: ensure active tool remains present in grid
    if (!state.locked && state.active && state.active !== "flow") {
      state.enabled[state.active] = true;
    }

    saveState(state);
    setSubline(root, state);
    setOverlayOpacity(root, state);
    setLockUI(root, state);

    // update grid drag/resize flags
    grid.setStatic(state.locked);

    if (state.locked) mountFullView(state, root);
    else mountEditView(state, root);

    renderToolList(root, state);
  }

  // ---------------------------
  // Settings modal
  // ---------------------------
  function openSettings(root, open) {
    const modal = root.querySelector("#dc-settings-modal");
    modal.dataset.open = open ? "true" : "false";
  }

  // ---------------------------
  // Main toggle
  // ---------------------------
  function open() {
    const root = ensureRoot();
    const state = loadState() || defaultState();
      // ---- state normalization (prevents toolbox from rendering empty) ----
if (!state.enabled || typeof state.enabled !== "object") state.enabled = { flow: true };
if (!state.enabled.flow) state.enabled.flow = true;

if (!state.groupOpen || typeof state.groupOpen !== "object") state.groupOpen = {};
for (const g of GROUPS) {
  if (typeof state.groupOpen[g.id] !== "boolean") state.groupOpen[g.id] = true;
}

if (!state.active || typeof state.active !== "string") state.active = "flow";


    root.dataset.open = "true";
    state.open = true;

    // Ensure groupOpen exists (migration)
    if (!state.groupOpen) {
      state.groupOpen = {};
      for (const g of GROUPS) state.groupOpen[g.id] = true;
    }

    setSubline(root, state);
    setOverlayOpacity(root, state);
    setLockUI(root, state);

    root.querySelector("#dc-close-btn").onclick = close;
    root.querySelector("#dc-settings-btn").onclick = () => openSettings(root, true);
    root.querySelector("#dc-settings-btn-2").onclick = () => openSettings(root, true);
    root.querySelector("#dc-settings-close").onclick = () => openSettings(root, false);
    root.querySelector("#dc-settings-bg").onclick = () => openSettings(root, false);

    root.querySelector("#dc-lock-switch").onclick = () => toggleLock(state, root);

    initGrid(root, state);
    renderToolList(root, state);
    saveState(state);
  }

  function close() {
    const root = ensureRoot();
    const state = loadState() || defaultState();
    root.dataset.open = "false";
    state.open = false;
    saveState(state);
  }

  function toggle() {
    const root = ensureRoot();
    const isOpen = root.dataset.open === "true";
    isOpen ? close() : open();
  }

  // Hotkey
  document.addEventListener("keydown", (e) => {
    const hit =
      (!!HOTKEY.ctrl === e.ctrlKey) &&
      (!!HOTKEY.shift === e.shiftKey) &&
      e.key.toUpperCase() === HOTKEY.key;
    if (!hit) return;
    e.preventDefault();
    toggle();
  });

  // Optional: auto-open with ?dockcmd=1
  if (new URLSearchParams(location.search).get("dockcmd") === "1") {
    open();
  }
})();
