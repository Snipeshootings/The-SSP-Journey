// ==UserScript==
// @name         SSP Util
// @namespace    https://deicide.internal/ssp-util-2
// @version 1.6.72
// ===============================
// VERSION HISTORY
// ===============================
//
// 1.5.x – Merge + Planning Foundation
// - Introduced merge panel with capacity logic
// - Added Current Units (CU) pulling per lane
// - Implemented inbound VRID awareness
// - Initial planning panel + shift bucketing logic
// - Container bucket renderer (Loaded / Staged / etc.)
//
// 1.6.x – Relay Integration + Stability
// - Relay integration improvements (track/map, meta badges, auth capture)
// - Inbound + CU caching by lane and widened prefetch for visible VRIDs
// - Merge utilization standardized:
//     (Loaded + Current + WeightedInbound) / Capacity
// - Planning persistence improvements (avoid overwriting SSP lane labels)
// - Performance + reliability hardening (guards, syntax fixes, handler restores)
// - Duplicate/legacy cleanup groundwork
//
// 1.7.x – UI & Execution Enhancements
// - Grid-based dockable UI foundation (toolbox/widgets)
// - Resize + layout lock behavior
// - Merge panel inbound summaries + disruptions attention blocks
// - Atlas widget scaffolding
//
// ===============================


// NOTE v1.6.49: Fix CU anchor vrId mapping (anchor.vrid vs vrId) so Current Units populate again.
// NOTE v1.5.94: CU_OB now pulls inFacility (SSP typo) instead of notArrived to avoid upstream containers.
// @description  CPT utilization + Action/Lane Panels + IB4CPT export + Planning Panel (execution dashboard + staffing to cutoff)
// @match        https://trans-logistics.amazon.com/ssp/*
// @match        https://www.amazonlogistics.com/ssp/dock/*
// @match        https://track.relay.amazon.dev/*
// @downloadURL  https://axzile.corp.amazon.com/-/carthamus/download_script/ssp-util-8.user.js
// @updateURL    https://axzile.corp.amazon.com/-/carthamus/download_script/ssp-util-8.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js
// @connect      track.relay.amazon.dev
// @connect      trans-logistics.amazon.com
// @run-at       document-end
// ==/UserScript==

// -------- Global helpers (must be visible to all modules) --------
/**
 * Format a numeric unit value for UI display (round to 0.1; drop trailing .0).
 */
function fmtUnits(u) {
  const n = Math.round((Number(u) || 0) * 10) / 10;
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * SSP UI host guard.
 *
 * UI widgets should render on both SSP host variants:
 * - trans-logistics.amazon.com
 * - www.amazonlogistics.com / amazonlogistics.com
 */
function isSspHost() {
  const host = String((location && location.hostname) || "").toLowerCase();
  return (
    host.includes("trans-logistics.amazon.com") ||
    host === "www.amazonlogistics.com" ||
    host === "amazonlogistics.com" ||
    host.endsWith(".amazonlogistics.com")
  );
}

/* ================================
 * Network Throttling / Caching
 * - Prevents service throttling (429) by serializing + slowing requests
 * - Caches GET lookups (driver/load) for a short TTL
 * ================================ */
const SSP_NET = {
  maxRps: 12,                  // higher throughput; backoff still applies on 429
  maxConcurrent: 4,           // allow limited parallelism
  jitterMs: 0,                // no artificial delay
  backoffBaseMs: 2000,         // exponential backoff on 429
  backoffMaxMs: 60000,         // cap backoff
  cacheTtlMs: 10 * 60 * 1000,  // 10 minutes
};

/* ================================
 * Diagnostics (DEV-only)
 * - Enable temporarily while pruning legacy branches.
 * ================================ */
const DEV_DIAG = false;
const __sspDiag = { used: Object.create(null) };
const __sspSeen = { equip: new Set() };
/**
 * DEV-only: increment a usage counter for a code path (helps prune legacy branches).
 */
function __sspMarkUsed(key){ if(!DEV_DIAG) return; __sspDiag.used[key] = (__sspDiag.used[key]||0)+1; }
/**
 * DEV-only: dump aggregated diagnostic counters to the console.
 */
function __sspDumpDiag(){ if(!DEV_DIAG) return; try{ console.debug("[SSP Util] DIAG.used", __sspDiag.used); }catch(e){} }
/**
 * DEV-only: log current URL query params for debugging host/page differences.
 */
function __sspLogUrlParamsOnce(tag="boot"){
  if(!DEV_DIAG) return;
  try{
    const u = new URL(location.href);
    console.debug(`[SSP Util][${tag}] url params`, Object.fromEntries(u.searchParams.entries()));
  }catch(e){
    console.debug(`[SSP Util][${tag}] url params error`, e);
  }
}
/**
 * DEV-only: log newly-seen equipment types (useful when normalizing trailer types).
 */
function __sspTrackEquip(raw){
  if(!DEV_DIAG) return;
  const k = String(raw||"").trim().toUpperCase();
  if(!k || __sspSeen.equip.has(k)) return;
  __sspSeen.equip.add(k);
  console.debug("[SSP Util] new equipmentType:", k);
}

const __sspCache = new Map();  // key -> {ts, value}
const __sspQueue = [];

/**
 * Enqueue a network job into the global throttled queue (priority-aware).
 */
function __sspEnqueue(task, priority=0) {
  // priority: 2=high,1=normal,0=low
  if (priority >= 2) __sspQueue.unshift(task);
  else if (priority <= 0) __sspQueue.push(task);
  else {
    // insert after any high-priority tasks already queued
    let i = 0;
    while (i < __sspQueue.length && __sspQueue[i]?.__prio === 2) i++;
    __sspQueue.splice(i, 0, task);
  }
}
let __sspInFlight = 0;
let __sspNextAt = 0;
let __sspBackoffUntil = 0;

/**
 * Monotonic-ish wallclock helper used by cache + backoff logic.
 */
function __sspNow() { return Date.now(); }
/**
 * Promise-based sleep helper used by the request scheduler/backoff.
 */
function __sspSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Read from the in-memory TTL cache used to dedupe repeated API calls.
 */
function __sspCacheGet(key) {
  const hit = __sspCache.get(key);
  if (!hit) return null;
  if ((__sspNow() - hit.ts) > SSP_NET.cacheTtlMs) { __sspCache.delete(key); return null; }
  return hit.value;
}
/**
 * Write to the in-memory TTL cache used to dedupe repeated API calls.
 */
function __sspCacheSet(key, value) {
  __sspCache.set(key, { ts: __sspNow(), value });
}

async function __sspDrainQueue() {
  if (__sspInFlight >= SSP_NET.maxConcurrent) return;
  if (!__sspQueue.length) return;

  const now = __sspNow();
  if (now < __sspBackoffUntil) {
    setTimeout(__sspDrainQueue, Math.max(50, __sspBackoffUntil - now));
    return;
  }

  const minInterval = Math.max(1, Math.floor(1000 / Math.max(SSP_NET.maxRps, 0.01)));
  const jitter = Math.floor(Math.random() * SSP_NET.jitterMs);
  const readyAt = Math.max(__sspNextAt, now) + jitter;
  const wait = Math.max(0, readyAt - now);
  if (wait > 0) {
    setTimeout(__sspDrainQueue, wait);
    return;
  }

  const job = __sspQueue.shift();
  __sspInFlight++;
  __sspNextAt = __sspNow() + minInterval;

  try {
    const res = await job.fn();
    job.resolve(res);
  } catch (e) {
    // Backoff on 429 / throttling signals
    const msg = (e && e.message) ? String(e.message) : "";
    const status = e && (e.status || e.code || e.httpStatus);
    if (status === 429 || msg.includes("429")) {
      const current = Math.max(SSP_NET.backoffBaseMs, __sspBackoffUntil - __sspNow());
      const next = Math.min(SSP_NET.backoffMaxMs, current ? current * 2 : SSP_NET.backoffBaseMs);
      __sspBackoffUntil = __sspNow() + next;
      console.warn("[SSP Util] Throttled (429). Backing off for", next, "ms");
    }
    job.reject(e);
  } finally {
    __sspInFlight--;
    setTimeout(__sspDrainQueue, 0);
  }
}

/**
 * Public enqueue wrapper used by feature modules (adds metadata and returns a promise).
 */
function sspEnqueue(fn, priority=1) {
  return new Promise((resolve, reject) => {
    __sspEnqueue(Object.assign({ fn, resolve, reject }, { __prio: priority }), priority);
    __sspDrainQueue();
  });
}

/** Queue + rate-limit wrapper around fetch() */
async function sspFetch(...args) {
  // Optional trailing priority number: sspFetch(url, opts, 2)
  let priority = 1;
  if (typeof args[args.length-1] === 'number') priority = args.pop();

  const url = args[0];
  const opts = (args[1] || {});
  const isStr = (typeof url === 'string');
  const isTL = isStr && url.startsWith('https://trans-logistics.amazon.com/');
  const onTL = (location && location.hostname && location.hostname.includes('trans-logistics.amazon.com'));

  // Use GM_xmlhttpRequest for cross-origin TL fetches to avoid CORS failures when running on amazonlogistics.com.
  if (isTL && !onTL && typeof GM_xmlhttpRequest === 'function') {
    return sspEnqueue(() => gmFetch(url, opts), priority);
  }

  return sspEnqueue(() => fetch(...args), priority);
}

/**
 * Fetch wrapper that uses window.fetch when same-origin, otherwise GM_xmlhttpRequest for CORS endpoints.
 */
function gmFetch(url, opts) {
  return new Promise((resolve, reject) => {
    try {
      const method = (opts && opts.method) ? String(opts.method).toUpperCase() : 'GET';
      const headers = (opts && opts.headers) ? opts.headers : {};
      const data = (opts && opts.body != null) ? opts.body : undefined;

      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        anonymous: false,
        withCredentials: true,
        onload: (resp) => {
          const status = resp.status || 0;
          const respText = (resp.responseText != null) ? resp.responseText : '';
          const out = {
            ok: status >= 200 && status < 300,
            status,
            url,
            _text: respText,
            text: async () => respText,
            json: async () => JSON.parse(respText || 'null'),
            clone: () => out
          };
          resolve(out);
        },
        onerror: (e) => reject(e),
        ontimeout: (e) => reject(e)
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** GET JSON with throttle + TTL cache */
async function sspCachedGetJson(cacheKey, url, fetchOpts) {
  const hit = __sspCacheGet(cacheKey);
  if (hit !== null && hit !== undefined) return hit;

  const res = await sspFetch(url, fetchOpts);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  __sspCacheSet(cacheKey, data);
  return data;
}




const toMs = (v) => (v ? new Date(v).getTime() : 0);

const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Parse SSP date-time strings like "12-Jan-26 05:00" into epoch ms.
// Returns 0 when parsing fails.
/**
 * Parse SSP date/time strings into a JS timestamp (ms). Accepts ISO and common SSP formats.
 */
function parseSspDateTime(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  // Try native parse first (works for ISO and some locale formats)
  const native = Date.parse(s);
  if (!Number.isNaN(native)) return native;

  // Expected: DD-MMM-YY HH:MM
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return 0;

  const dd = Number(m[1]);
  const monStr = m[2].toLowerCase();
  const yy = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);

  const monMap = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const mon = monMap[monStr];
  if (mon === undefined) return 0;

  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  return new Date(yyyy, mon, dd, hh, mm, 0, 0).getTime();
}

// Determine outbound load base type for the Loads dropdown.
// Rule (LDJ5): route contains "DDU" => ddu; route contains "CYC" => amzl; else other.
// IMPORTANT: equipment splitting (26/53 strict-only) is handled at the load-group level elsewhere.
/**
 * Derive normalized outbound load type label from SSP/FMC payload (CART/CYC/etc).
 */
function getOutboundLoadType(load) {
  const routeRaw = (
    load?.route ??
    load?.lane ??
    load?.sortRoute ??
    load?.sort_route ??
    load?.sortRouteName ??
    load?.laneName ??
    load?.routeName ??
    load?.sortAndRoute ??
    load?.sort_and_route ??
    ""
  );
  const route = String(routeRaw || "").toUpperCase();

  if (route.includes("DDU")) return "ddu";
  if (route.includes("CYC")) return "amzl";
  return "other";
}

/**
 * Extract the canonical loadGroupId from a load record (handles schema variants).
 */
function getLoadGroupId(load) {
  try {
    const v =
      load?.loadGroupId ??
      (Array.isArray(load?.loadGroupIds) ? load.loadGroupIds[0] : load?.loadGroupIds) ??
      load?.loadGroup ??
      "";
    return String(v || "").trim();
  } catch (_) {
    return "";
  }
}

/**
 * Compute an equipment signature for a load group (used to infer capacity/unit conversions).
 */
function buildLoadGroupEquipSig(loads) {
  const map = new Map(); // lgId -> {has26:boolean, has53:boolean}
  for (const l of (loads || [])) {
    const lgid = getLoadGroupId(l);
    if (!lgid) continue;

    const equipRaw = String(
      l?.equipmentType ??
        l?.equip ??
        l?.equipment ??
        l?.trailerEquipmentType ??
        l?.trailer?.equipmentType ??
        l?.vehicle?.equipmentType ??
        ""
    );
    const e = normalizeEquipmentType(equipRaw);
    const short = (e && e.short) ? String(e.short) : "";

    let rec = map.get(lgid);
    if (!rec) rec = { has26: false, has53: false };
    if (short === "26") rec.has26 = true;
    if (short === "53") rec.has53 = true;
    map.set(lgid, rec);
  }
  return map;
}

function getOutboundEquipmentTypeRaw(load) {
  return String(
    load?.equipmentType ??
      load?.equip ??
      load?.equipment ??
      load?.trailerEquipmentType ??
      load?.trailerEquipment?.trailer?.equipmentType ??
      load?.trailer?.equipmentType ??
      load?.vehicle?.equipmentType ??
      ""
  );
}

function getFilteredOutboundLoadsForMode(modeInput, options = {}) {
  const mode = normalizeObLoadType(modeInput || "all");
  const srcLoads = Array.isArray(options.loads)
    ? options.loads
    : (Array.isArray(STATE?.outboundLoads) ? STATE.outboundLoads : []);

  const basePredicate =
    (typeof options.basePredicate === "function")
      ? options.basePredicate
      : (() => true);

  const prefilteredLoads = srcLoads.filter((l) => {
    try { return !!basePredicate(l); } catch (_) { return false; }
  });

  const lgEquipSig =
    (mode === "amzl53" || mode === "amzl26")
      ? buildLoadGroupEquipSig(prefilteredLoads.filter((l) => getOutboundLoadType(l) === "amzl"))
      : null;

  const modeFiltered = prefilteredLoads.filter((l) => {
    if (mode === "all") return true;

    const t = getOutboundLoadType(l);
    if (mode === "ddu") return t === "ddu";
    if (mode === "amzl_all") return t === "amzl";

    if (mode === "amzl53" || mode === "amzl26") {
      if (t !== "amzl") return false;
      const lgid = getLoadGroupId(l);
      if (!lgid || !lgEquipSig) return false;
      const sig = lgEquipSig.get(lgid);
      if (!sig) return false;
      const only53 = !!sig.has53 && !sig.has26;
      const only26 = !!sig.has26 && !sig.has53;
      return mode === "amzl53" ? only53 : only26;
    }

    return true;
  });

  const equipmentPredicate = (typeof options.equipmentPredicate === "function") ? options.equipmentPredicate : null;
  const equipmentFiltered = equipmentPredicate
    ? modeFiltered.filter((l) => {
        try {
          const e = normalizeEquipmentType(getOutboundEquipmentTypeRaw(l));
          return !!equipmentPredicate(e, l);
        } catch (_) {
          return false;
        }
      })
    : modeFiltered;

  try {
    STATE._modeFilterDebugLogged = STATE._modeFilterDebugLogged || {};
    const debugModeKey = String(mode || "all");
    if (!STATE._modeFilterDebugLogged[debugModeKey]) {
      console.debug("[SSP Util] mode filter parity", {
        mode,
        debugKey: String(options.debugKey || "default"),
        total: srcLoads.length,
        baseFiltered: prefilteredLoads.length,
        modeFiltered: modeFiltered.length,
        equipmentFiltered: equipmentFiltered.length,
      });
      STATE._modeFilterDebugLogged[debugModeKey] = true;
    }
  } catch (_) {}

  return equipmentFiltered;
}

// Normalize legacy/label-based load-type filters to internal values.
/**
 * Normalize outbound lane/load type tokens for matching/grouping (case/spacing-safe).
 */
function normalizeObLoadType(v) {
  const raw = String(v || "all").trim();
  const low = raw.toLowerCase();

  if (!raw) return "all";
  if (low === "all" || low === "all loads") return "all";

  if (low.includes("outboundamzl") && low.includes("(all)")) return "amzl_all";
  if (low.includes("outboundamzl") && low.includes("(53")) return "amzl53";
  if (low.includes("outboundamzl") && low.includes("(26")) return "amzl26";
  if (low.includes("outboundamzl")) return "amzl_all";

  if (low === "amzl" || low === "amzl_all" || low === "amzlall") return "amzl_all";
  if (low === "amzl53" || low === "53" || low.includes(" 53")) return "amzl53";
  if (low === "amzl26" || low === "26" || low.includes(" 26")) return "amzl26";

  if (low === "ddu" || low.includes("outboundddu")) return "ddu";
  return raw;
}

  // Extract IB4CPT groups from unknown shapes (Array | Map | Object | nested)
  function extractIb4Groups(raw) {
    try {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (raw instanceof Map) return Array.from(raw.values());
      if (typeof raw === "object") {
        // common nesting keys
        for (const k of ["groups","data","items","rows","values","ib4cpt","payload","result"]) {
          if (raw[k]) {
            const got = extractIb4Groups(raw[k]);
            if (got && got.length) return got;
          }
        }
        // if values look like group objects, use them
        const vals = Object.values(raw);
        if (vals.length && vals.some(v => v && typeof v === "object")) return vals;
      }
    } catch (e) {}
    return [];
  }


  // Try to discover a lane-like string inside an unknown IB4CPT group object.
  // AMZL lanes commonly look like "LDJ5->DAB8-CYC1".
  function findLaneLike(obj) {
    try {
      if (!obj || typeof obj !== "object") return "";
      const direct = String(obj.lane || obj.route || obj.outboundLane || obj.destinationLane || obj.shipLane || "").trim();
      if (direct.includes("->")) return direct;

      // Scan shallow fields for a short string containing "->"
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== "string") continue;
        const s = v.trim();
        if (s.includes("->") && s.length <= 60) return s;
      }

      // Scan nested common holders
      for (const k of ["loadGroup", "group", "laneInfo", "destination", "metadata"]) {
        const nested = obj[k];
        if (nested && typeof nested === "object") {
          const s = findLaneLike(nested);
          if (s) return s;
        }
      }
    } catch (_) {}
    return "";
  }

  // Build a units map using the same IB4CPT CDT-based container counts used by the merge logic.
  // Produces:
  //   laneKey::cptMs -> units
  //   *::cptMs       -> units (CPT-only fallback)
  function buildIbLaneCptUnits(cdtObj) {
    const out = {};
    try {
      if (!cdtObj || typeof cdtObj !== "object") return out;

      const add = (key, n) => {
        if (!key) return;
        out[key] = (out[key] || 0) + (Number(n) || 0);
      };

      const vals = Object.values(cdtObj);
      for (const groups of vals) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          const cptMs = toMs(g?.criticalPullTime);
          if (!cptMs) continue;

          // IMPORTANT:
          // IB4CPT CDT-based counts include both TOTAL and IN-TRAILER counts.
          // For "remaining eligible" (not yet on any outbound trailer), we use unLoadedCount.
          const remaining = Number(g?.loadGroupCountStruct?.unLoadedCount?.C || 0);
          if (!remaining) continue;

          const lane = findLaneLike(g);
          if (lane) add(lane + "::" + String(cptMs), remaining);

          // CPT-only fallback bucket
          add("*::" + String(cptMs), remaining);
        }
      }
    } catch (_) {}
    return out;
  }


  // Produces:
  //   laneKey::cptMs -> [loadGroupId, ...]
  function buildIbLaneCptLoadGroups(cdtObj) {
    const tmp = {};
    try {
      if (!cdtObj || typeof cdtObj !== "object") return {};
      const vals = Object.values(cdtObj);
      for (const groups of vals) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          const cptMs = toMs(g?.criticalPullTime);
          if (!cptMs) continue;
          const lane = findLaneLike(g);
          if (!lane) continue;
          const lg = String(g?.loadGroupId || g?.loadGroupCountStruct?.loadGroupId || "").trim();
          if (!lg) continue;
          const key = String(lane).trim().toUpperCase().replace(/\s+/g,"").replace(/[|]/g,"").replace(/→/g,"->") + "::" + String(cptMs);
          if (!tmp[key]) tmp[key] = new Set();
          tmp[key].add(lg);
        }
      }
      const out = {};
      for (const k of Object.keys(tmp)) out[k] = Array.from(tmp[k]);
      return out;
    } catch (e) { return {}; }
  }


  function buildIbLaneCptStats(cdtObj) {
    // key lane::cptMs -> { totalC, inTrailerC, unloadedC, totalP, inTrailerP, unloadedP, loadGroupIds:[...] }
    const out = {};
    try {
      if (!cdtObj || typeof cdtObj !== "object") return out;
      const vals = Object.values(cdtObj);
      for (const groups of vals) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          const cptMs = toMs(g?.criticalPullTime);
          if (!cptMs) continue;
          const lane = findLaneLike(g);
          if (!lane) continue;
          const key = String(lane).trim().toUpperCase().replace(/\s+/g,"").replace(/[|]/g,"").replace(/→/g,"->") + "::" + String(cptMs);
          const s = out[key] || (out[key] = { totalC:0,inTrailerC:0,unloadedC:0,totalP:0,inTrailerP:0,unloadedP:0, loadGroupIds: new Set(), _seenLG: new Set() });
          const lg = String(g?.loadGroupId || g?.loadGroupCountStruct?.loadGroupId || "").trim();
          if (lg) {
          if (s._seenLG.has(lg)) return;
          s._seenLG.add(lg);
          s.loadGroupIds.add(lg);
        }
          const t = g?.loadGroupCountStruct || {};
          s.totalC += Number(t?.totalCount?.C || 0);
          s.inTrailerC += Number(t?.inTrailerCount?.C || 0);
          s.unloadedC += Number(t?.unLoadedCount?.C || 0);
          s.totalP += Number(t?.totalCount?.P || 0);
          s.inTrailerP += Number(t?.inTrailerCount?.P || 0);
          s.unloadedP += Number(t?.unLoadedCount?.P || 0);
        }
      }
      for (const k of Object.keys(out)) {
        out[k].loadGroupIds = Array.from(out[k].loadGroupIds || []);
        delete out[k]._seenLG;
      }
      return out;
    } catch (e) { return out; }
  }

/**
 * Index inbound loads by planId for fast lookup during planning/IB4CPT export.
 */
function buildIbByPlanId(inboundLoads) {
    const m = new Map();
    try {
      for (const l of (inboundLoads || [])) {
        const pid = String(l?.planId || "").trim();
        if (!pid) continue;
        m.set(pid, l);
      }
    } catch {}
    return m;
  }

  function collectInboundPlanIdsFromContainerTree(tree) {
    const planIds = new Set();
    let cartCount = 0;
    try {
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        const c = node.container || node?.containerNode || node?.data?.container || null;
        const nodePid = String(node?.inboundLoadId || node?.inboundLoadGroupId || node?.planId || node?.loadId || "").trim();
        if (nodePid) planIds.add(nodePid);
        if (c && typeof c === "object") {
          const pid = String(c?.inboundLoadId || c?.inboundLoadGroupId || c?.planId || "").trim();
          if (pid) planIds.add(pid);
          if (String(c?.contType || "").toUpperCase() === "CART") cartCount += 1;
        }
        const kids = node.childNodes || node.children || null;
        if (Array.isArray(kids)) for (const k of kids) walk(k);
      };
      walk(tree);
    } catch {}
    return { planIds: Array.from(planIds), cartCount };
  }



// Safe CPT label formatting

// CPT urgency state helpers

// Inject CPT urgency CSS safely (no inline <style> in JS)
(function injectCptCss() {
  if (document.getElementById('ssp-util-cpt-css')) return;
  const style = document.createElement('style');
  style.id = 'ssp-util-cpt-css';
  style.textContent = `
    .cpt-ok { color: #1f9d55; font-weight: 600; }
    .cpt-warning { color: #f59e0b; font-weight: 600; }
    .cpt-critical {
      color: #dc2626;
      font-weight: 700;
      animation: cptFlash 1s infinite;
    }
    @keyframes cptFlash {
      0% { opacity: 1; }
      50% { opacity: 0.3; }
      100% { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
})();

/**
 * Classify a CPT timestamp relative to now (past/soon/future) for coloring and sorting.
 */
function getCptState(cptMs, nowMs = Date.now()) {
  if (!cptMs) return 'cpt-ok';
  const diffMin = (cptMs - nowMs) / 60000;
  if (diffMin <= 15 && diffMin >= 0) return 'cpt-critical';
  if (diffMin <= 60 && diffMin > 15) return 'cpt-warning';
  return 'cpt-ok';
}

/**
 * Render CPT timestamp into a compact label for lane headers (local time).
 */
function fmtCptLabel(cptMs) {
  const cls = getCptState(cptMs);
  if (!cptMs) return `<span class="cpt-ok">CPT</span>`;
  return `<span class="${cls}">CPT ${fmtTime(cptMs)}</span>`;
}

/**
 * Humanize a delta in minutes/seconds to +/-HH:MM style for ETAs and variance.
 */
function formatDelta(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v === 0) return "0";
    return v > 0 ? `+${v}` : `${v}`;
  }

/**
 * Read the latest cached loadGroup status snapshot (avoids refetch storms).
 */
function getLatestLoadGroupStatusCache(loadGroupId, status) {
  try {
    const lg = String(loadGroupId || '').trim();
    const st = String(status || '').trim();
    if (!lg || !st) return null;
    const cache = (STATE && STATE.loadGroupContainerCache) ? STATE.loadGroupContainerCache : null;
    if (!cache) return null;
    const prefix = `${lg}::${st}::`;
    let best = null;
    for (const k of Object.keys(cache)) {
      if (!k.startsWith(prefix)) continue;
      const v = cache[k];
      if (!v || !v.ts) continue;
      if (!best || v.ts > best.ts) best = v;
    }
    return best;
  } catch (_) { return null; }
}






/* ============================
   OPS DAY WINDOW (07:00 → next day 07:00)
   ============================ */
/**
 * Return the current operational window boundaries (shift/ops) used for bucketing and KPIs.
 */
function getOpsWindow(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const start = new Date(now);
  start.setHours(7, 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
  // =====================================================
  // Inbound Dock Mgmt Route Averages (Completed Loads)
  // - Used to estimate containers/packages for scheduled loads that are still unmanifested upstream (0 cntrs)
  // - Refresh cadence: once per day (manual force refresh supported)
  // =====================================================
  const IB_AVG = {
    storageKey: () => `ssp2_ibRouteAvg_v1:${String(STATE.nodeId||"").trim() || "UNKNOWN"}`,
    maxAgeMs: 24 * 60 * 60 * 1000,
    lookbackDays: 14,
  };

  function _ibAvgLoadFromStorage() {
    try {
      const raw = localStorage.getItem(IB_AVG.storageKey());
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (!obj.ts || (Date.now() - obj.ts) > (IB_AVG.maxAgeMs * 7)) return null; // hard expire after 7 days
      return obj;
    } catch { return null; }
  }

  function _ibAvgSaveToStorage(obj) {
    try {
      localStorage.setItem(IB_AVG.storageKey(), JSON.stringify(obj));
    } catch {}
  }

  function _ibAvgGet(route, equipShortName) {
    try {
      const cache = STATE.ibRouteAvg || _ibAvgLoadFromStorage();
      if (!cache || !cache.routes) return null;
      const r = cache.routes[String(route||"").trim()];
      if (!r) return null;

      // Prefer exact equipment bucket, fall back to "__all"
      const eKey = String(equipShortName||"").trim() || "__all";
      return r[eKey] || r.__all || null;
    } catch { return null; }
  }

  function _ibAvgIsStale() {
    const cache = STATE.ibRouteAvg || _ibAvgLoadFromStorage();
    if (!cache || !cache.ts) return true;
    return (Date.now() - cache.ts) > IB_AVG.maxAgeMs;
  }

  async function refreshInboundRouteAverages({ force=false } = {}) {
    try {
      if (!force && !_ibAvgIsStale()) return STATE.ibRouteAvg || _ibAvgLoadFromStorage();

      const nodeId = String(STATE.nodeId||"").trim();
      if (!nodeId) return null;

      // 1) Pull completed loads for lookback window
      const now = Date.now();
      const endDate = now;
      const startDate = now - (IB_AVG.lookbackDays * 24 * 60 * 60 * 1000);

      const viewResp = await postFetch(
        "/ssp/dock/hrz/ib/fetchdata?",
        {
          entity: "getInboundDockView",
          nodeId,
          startDate,
          endDate,
          loadCategories: "inboundCompleted",
          shippingPurposeType: "TRANSSHIPMENT,NON-TRANSSHIPMENT,SHIP_WITH_AMAZON",
        },
        "IB getInboundDockView (avg)",
        { priority: 0 }
      );

      const view = getAaData(viewResp, "IB getInboundDockView (avg)") || {};
      const loads = Array.isArray(view?.loads) ? view.loads
                  : Array.isArray(view?.inboundLoads) ? view.inboundLoads
                  : Array.isArray(view?.data) ? view.data
                  : Array.isArray(view?.rows) ? view.rows
                  : [];

      // Build id -> meta map (route/equip)
      const idMeta = new Map();
      for (const row of loads) {
        const id = row?.inboundLoadId || row?.loadId || row?.id;
        if (!id) continue;
        const sortRoute = row?.sortRoute || row?.route || row?.sortroute || row?.sort_route;
        const equip = row?.equipment || row?.equipmentType || row?.equipment_type;
        idMeta.set(String(id), {
          sortRoute: String(sortRoute||"").trim(),
          equipShort: equipShort(equip),
        });
      }

      const inboundLoadIds = Array.from(idMeta.keys());
      if (!inboundLoadIds.length) {
        const empty = { ts: Date.now(), nodeId, routes: {} };
        STATE.ibRouteAvg = empty;
        _ibAvgSaveToStorage(empty);
        return empty;
      }

      // 2) Bulk container count for those loads
      const ccResp = await postFetch(
        "/ssp/dock/hrz/ib/fetchdata?",
        { entity: "getInboundContainerCount", inboundLoadIds: inboundLoadIds.join(","), nodeId },
        "IB getInboundContainerCount (avg)",
        { priority: 0, cacheTtlMs: 5 * 60 * 1000 }
      );
      const cc = getAaData(ccResp, "IB getInboundContainerCount (avg)") || {};
      const ccMap = cc?.inboundContainerCount || cc?.data || cc;

      // 3) Aggregate averages: route -> equipShort -> {avgC, avgP, n}
      const agg = {};
      function push(route, equipS, c, p) {
        if (!route) return;
        agg[route] = agg[route] || {};
        const bucket = agg[route][equipS] = agg[route][equipS] || { n: 0, sumC: 0, sumP: 0 };
        bucket.n += 1;
        bucket.sumC += (Number(c) || 0);
        bucket.sumP += (Number(p) || 0);
      }

      for (const id of inboundLoadIds) {
        const meta = idMeta.get(String(id)) || {};
        const route = meta.sortRoute || "";
        if (!route) continue;

        const rec = ccMap?.[id] || ccMap?.[String(id)] || null;
        const total = rec?.totalCount || rec?.total || rec?.totalcount || null;
        const c = total?.C ?? total?.c ?? rec?.totalContainers ?? rec?.containers ?? rec?.C ?? rec?.c ?? 0;
        const p = total?.P ?? total?.p ?? rec?.totalPackages ?? rec?.packages ?? rec?.P ?? rec?.p ?? 0;
        const equipS = meta.equipShort || "__all";

        // Include only loads with nonzero containers to avoid poisoning averages with unmanifested data
        if ((Number(c) || 0) > 0) {
          push(route, equipS, c, p);
          push(route, "__all", c, p);
        }
      }

      const routesOut = {};
      for (const [route, byEquip] of Object.entries(agg)) {
        routesOut[route] = {};
        for (const [equipS, b] of Object.entries(byEquip)) {
          const n = b.n || 0;
          if (!n) continue;
          routesOut[route][equipS] = {
            n,
            avgC: (b.sumC / n),
            avgP: (b.sumP / n),
          };
        }
      }

      const result = { ts: Date.now(), nodeId, routes: routesOut, lookbackDays: IB_AVG.lookbackDays };
      STATE.ibRouteAvg = result;
      _ibAvgSaveToStorage(result);
      return result;
    } catch (e) {
      setLastError("refreshInboundRouteAverages", e);
      return null;
    }
  }

  // =====================================================
  // CSV-Based Inbound Estimation (from 2-week historical export)
  // - Allows importing two-week SSP inbound export CSV for better statistical estimates
  // - Calculates averages by route, load type, and equipment
  // - Feeds estimates into planning panel headcount, merge panel, and inbound units
  // =====================================================
  const IB_CSV_EST = {
    storageKey: () => `ssp2_ibCsvEstimates_v1:${String(STATE.nodeId||"").trim() || "UNKNOWN"}`,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  };

  function _ibCsvEstLoadFromStorage() {
    try {
      const raw = localStorage.getItem(IB_CSV_EST.storageKey());
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (!obj.ts || (Date.now() - obj.ts) > IB_CSV_EST.maxAgeMs) return null;
      return obj;
    } catch { return null; }
  }

  function _ibCsvEstSaveToStorage(obj) {
    try {
      localStorage.setItem(IB_CSV_EST.storageKey(), JSON.stringify(obj));
    } catch {}
  }

  /**
   * Parse CSV data from inbound SSP export.
   * Expected columns: Priority, Ranking, Load Type, Status, Sort/Route, VR ID, 
   *   Total Packages, Total Containers, Equipment, Carrier, etc.
   */
  function parseInboundCsvData(csvText) {
    try {
      const lines = csvText.trim().split(/\r?\n/);
      if (!lines.length) return [];

      // Parse header line
      const header = lines[0].split(',').map(h => h.trim().toLowerCase());
      const rows = [];

      // Parse data rows
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Basic CSV parsing (handle quoted fields)
        const cols = [];
        let current = '';
        let inQuotes = false;
        for (let j = 0; j < line.length; j++) {
          const ch = line[j];
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === ',' && !inQuotes) {
            cols.push(current.trim().replace(/^"+|"+$/g, ''));
            current = '';
          } else {
            current += ch;
          }
        }
        cols.push(current.trim().replace(/^"+|"+$/g, ''));

        // Map to object using header
        const row = {};
        for (let j = 0; j < header.length && j < cols.length; j++) {
          row[header[j]] = cols[j];
        }
        rows.push(row);
      }

      return rows;
    } catch (e) {
      console.error("[SSP Util] CSV parse error:", e);
      return [];
    }
  }

  /**
   * Process inbound CSV rows and calculate statistics grouped by route, load type, and equipment.
   * Returns object indexed as: route::loadType::equipment -> { avgC, avgP, n, stdDevC, stdDevP }
   */
  function buildCsvEstimates(csvRows) {
    try {
      const stats = {}; // route::loadType::equipment -> { samples: [...], n: count }
      const globalStats = {}; // route -> { samples: [...], n: count }

      for (const row of csvRows) {
        // Extract key fields with flexible column name matching
        const totalC = Number(
          row['total containers'] || 
          row['totalcontainers'] || 
          row['total_containers'] || 
          row['containers'] || 
          0
        );
        const totalP = Number(
          row['total packages'] || 
          row['totalpackages'] || 
          row['total_packages'] || 
          row['packages'] || 
          0
        );

        // Skip unmanifested loads (these will be the ones we need to estimate)
        // Only include manifested loads (with actual counts) for statistics
        if (totalC === 0 || totalP === 0) continue;

        const sortRoute = String(
          row['sort/route'] || 
          row['sort route'] || 
          row['sortroute'] || 
          row['route'] || 
          ''
        ).trim();

        const loadType = String(
          row['load type'] || 
          row['loadtype'] || 
          row['type'] || 
          '__all'
        ).trim();

        const equipment = String(
          row['equipment'] || 
          row['equipment type'] || 
          row['equipmenttype'] || 
          '__all'
        ).trim();

        const equipShort = equipment.match(/\d{2}/) ? equipment.match(/\d{2}/)[0] : '__all';

        if (!sortRoute) continue;

        // Aggregate by route::loadType::equipment
        const key = `${sortRoute}::${loadType}::${equipShort}`;
        if (!stats[key]) stats[key] = { samples: [], n: 0 };
        stats[key].samples.push({ c: totalC, p: totalP });
        stats[key].n += 1;

        // Also aggregate by route only (fallback)
        if (!globalStats[sortRoute]) globalStats[sortRoute] = { samples: [], n: 0 };
        globalStats[sortRoute].samples.push({ c: totalC, p: totalP });
        globalStats[sortRoute].n += 1;
      }

      // Calculate averages and standard deviations
      const result = {};
      for (const [key, data] of Object.entries(stats)) {
        if (!data.samples.length) continue;
        const cs = data.samples.map(s => s.c);
        const ps = data.samples.map(s => s.p);
        const avgC = cs.reduce((a, b) => a + b, 0) / cs.length;
        const avgP = ps.reduce((a, b) => a + b, 0) / ps.length;

        const varC = cs.reduce((sum, c) => sum + Math.pow(c - avgC, 2), 0) / cs.length;
        const varP = ps.reduce((sum, p) => sum + Math.pow(p - avgP, 2), 0) / ps.length;
        const stdDevC = Math.sqrt(varC);
        const stdDevP = Math.sqrt(varP);

        result[key] = { n: data.n, avgC, avgP, stdDevC, stdDevP };
      }

      // Add global fallbacks
      for (const [route, data] of Object.entries(globalStats)) {
        if (!data.samples.length) continue;
        const cs = data.samples.map(s => s.c);
        const ps = data.samples.map(s => s.p);
        const avgC = cs.reduce((a, b) => a + b, 0) / cs.length;
        const avgP = ps.reduce((a, b) => a + b, 0) / ps.length;

        const varC = cs.reduce((sum, c) => sum + Math.pow(c - avgC, 2), 0) / cs.length;
        const varP = ps.reduce((sum, p) => sum + Math.pow(p - avgP, 2), 0) / ps.length;
        const stdDevC = Math.sqrt(varC);
        const stdDevP = Math.sqrt(varP);

        const globalKey = `${route}::__all::__all`;
        result[globalKey] = { n: data.n, avgC, avgP, stdDevC, stdDevP };
      }

      return result;
    } catch (e) {
      console.error("[SSP Util] buildCsvEstimates error:", e);
      return {};
    }
  }

  /**
   * Import CSV data: parse, calculate statistics, and store.
   */
  function importInboundCsvEstimates(csvText) {
    try {
      const rows = parseInboundCsvData(csvText);
      if (!rows.length) {
        console.warn("[SSP Util] No valid rows in CSV");
        return null;
      }

      const estimates = buildCsvEstimates(rows);
      const result = {
        ts: Date.now(),
        nodeId: String(STATE.nodeId || '').trim(),
        estimates: estimates,
        rowsProcessed: rows.length,
        uniqueRoutes: new Set(rows.map(r => r['sort/route'] || r['route'] || '').filter(r => r)).size,
      };

      STATE.ibCsvEstimates = result;
      _ibCsvEstSaveToStorage(result);
      console.log("[SSP Util] Inbound CSV estimates imported", {
        rowsProcessed: rows.length,
        estimatesBuckets: Object.keys(estimates).length,
      });
      return result;
    } catch (e) {
      console.error("[SSP Util] importInboundCsvEstimates error:", e);
      return null;
    }
  }

  // Expose a global alias for manual testing from the browser console.
  // Provide both plural and singular names to avoid ReferenceErrors when called interactively.
  try {
    if (typeof window !== 'undefined') {
      window.importInboundCsvEstimates = importInboundCsvEstimates;
      window.importInboundCsvEstimate = importInboundCsvEstimates; // legacy/single-name alias
    }
  } catch (_) {}

  /**
   * Get estimate for a load using CSV-based statistics (with fallback to route averages).
   * Lookup order: route::loadType::equipment -> route::__all::equipment -> route::__all::__all
   */
  function _ibCsvEstGet(sortRoute, loadType, equipment) {
    try {
      const cache = STATE.ibCsvEstimates || _ibCsvEstLoadFromStorage();
      if (!cache || !cache.estimates) return null;

      const est = cache.estimates;
      const equipShort = equipment && equipment.match(/\d{2}/) ? equipment.match(/\d{2}/)[0] : '__all';
      const lt = (loadType || '__all').trim();
      const sr = (sortRoute || '').trim();

      if (!sr) return null;

      // Try specific combination first
      const key1 = `${sr}::${lt}::${equipShort}`;
      if (est[key1]) return est[key1];

      // Fall back to route::__all::equipment
      const key2 = `${sr}::__all::${equipShort}`;
      if (est[key2]) return est[key2];

      // Fall back to route::__all::__all
      const key3 = `${sr}::__all::__all`;
      if (est[key3]) return est[key3];

      return null;
    } catch { return null; }
  }

  // Estimate for an inbound row. Returns { estC, estP, source } or null
  function estimateInboundIfUnmanifested({ sortRoute, totalContainers, totalPackages, equipmentType, loadType }) {
    const c = Number(totalContainers) || 0;
    const p = Number(totalPackages) || 0;
    if (c > 0 || p > 0) return null; // already manifested

    // Try CSV-based estimates first (higher priority)
    const csvEst = _ibCsvEstGet(sortRoute, loadType, equipmentType);
    if (csvEst && csvEst.n > 0) {
      return {
        estC: Math.round((csvEst.avgC || 0) * 10) / 10,
        estP: Math.round(csvEst.avgP || 0),
        source: `csv_${csvEst.n}`,
      };
    }

    // Fall back to route averages from dock view
    const avg = _ibAvgGet(sortRoute, equipShort(equipmentType));
    if (!avg) return null;
    return {
      estC: Math.round((avg.avgC || 0) * 10) / 10,
      estP: Math.round(avg.avgP || 0),
      source: `avg_${avg.n || 0}`,
    };
  }

}

  // =====================================================
  // CSV / Download Helpers
  // =====================================================
  function downloadTextFile(filename, content, mime = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function toCsv(rows, headers) {
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      const needs = /[",\n]/.test(s);
      const out = s.replace(/"/g, '""');
      return needs ? `"${out}"` : out;
    };
    const head = headers.join(",");
    const body = rows.map((r) => headers.map((h) => esc(r[h])).join(",")).join("\n");
    return head + "\n" + body + "\n";
  }




(function () {
  "use strict";

  // =====================================================
  // Track Relay Auth Tap (cross-tab)
  //
  // Relay's Track APIs (track.relay.amazon.dev) require an Authorization: Bearer token.
  // The Relay SPA already obtains and uses that token. Userscripts often fail to send it
  // (or can't due to SameSite/cookie constraints), resulting in 401s.
  //
  // Fix:
  //  - Inject a tap into the page (where the Relay SPA runs) to capture the Authorization header.
  //  - Relay the token back to the userscript via window.postMessage.
  //  - Persist it into Tampermonkey storage (GM_setValue) so it works across tabs/domains.
  //
  // Security note:
  //  - We NEVER log the token.
  //  - We store only the "Bearer ..." string + timestamp, and we reject expired JWTs.
  // =====================================================

  const SSP_TRACK_AUTH_KEY = "SSP_TRACK_AUTH_V1";

  function _sspParseJwtExpSeconds(bearer) {
    try {
      const s = String(bearer || "");
      const tok = s.startsWith("Bearer ") ? s.slice(7) : s;
      const parts = tok.split(".");
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      // pad base64
      const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
      const jsonStr = atob(b64 + pad);
      const obj = JSON.parse(jsonStr);
      if (!obj || typeof obj.exp !== "number") return null;
      return obj.exp;
    } catch { return null; }
  }

  function _sspIsBearerValid(bearer) {
    try {
      if (!bearer) return false;
      const s = String(bearer);
      if (!s.startsWith("Bearer ")) return false;
      const exp = _sspParseJwtExpSeconds(s);
      if (!exp) return true; // if we can't parse exp, don't block; still try.
      const now = Math.floor(Date.now() / 1000);
      return exp > (now + 60); // require at least 60s of validity
    } catch { return false; }
  }

  function _sspPersistTrackAuth(bearer) {
    try {
      if (!_sspIsBearerValid(bearer)) return;
      if (typeof GM_setValue === "function") {
        GM_setValue(SSP_TRACK_AUTH_KEY, JSON.stringify({
          bearer: String(bearer),
          savedAt: Date.now()
        }));
      }
    } catch {}
  }

  function _sspLoadTrackAuthFromStore() {
    try {
      if (typeof GM_getValue !== "function") return null;
      const raw = GM_getValue(SSP_TRACK_AUTH_KEY, "");
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const bearer = obj && obj.bearer;
      if (!_sspIsBearerValid(bearer)) return null;
      return String(bearer);
    } catch { return null; }
  }

  function _sspInstallTrackAuthTap() {
    try {
      // Listen for page-context token capture.
      window.addEventListener("message", (ev) => {
        try {
          const d = ev && ev.data;
          if (!d || d.__SSP_TRACK_AUTH__ !== true) return;
          const bearer = d.bearer;
          if (!_sspIsBearerValid(bearer)) return;
          // Set in unsafeWindow too (same tab convenience)
          try { if (typeof unsafeWindow !== "undefined") unsafeWindow.__SSP_TRACK_AUTH__ = String(bearer); } catch {}
          _sspPersistTrackAuth(bearer);
        } catch {}
      }, false);

      // Inject tap into page context (so we can see the SPA's Authorization header).
      // This works on track.relay.amazon.dev pages where the Relay UI makes the request.
      const code = `(function(){
        try{
          if (window.__SSP_TRACK_AUTH_TAP_INSTALLED__) return;
          window.__SSP_TRACK_AUTH_TAP_INSTALLED__ = true;

          const publish = (bearer) => {
            try{
              if (!bearer || typeof bearer !== 'string') return;
              if (!bearer.startsWith('Bearer ')) return;
              // store on window for same-tab reads
              window.__SSP_TRACK_AUTH__ = bearer;
              // send to userscript for cross-tab persistence
              window.postMessage({ __SSP_TRACK_AUTH__: true, bearer }, '*');
            }catch(e){}
          };

          // Tap fetch
          const _fetch = window.fetch;
          if (typeof _fetch === 'function') {
            window.fetch = function(input, init){
              try{
                const h = (init && init.headers) || (input && input.headers);
                let auth = null;
                if (h && typeof h.get === 'function') auth = h.get('authorization') || h.get('Authorization');
                else if (h && typeof h === 'object') auth = h.authorization || h.Authorization;
                if (auth) publish(String(auth));
              }catch(e){}
              return _fetch.apply(this, arguments);
            };
          }

          // Tap XHR
          const X = window.XMLHttpRequest;
          if (X && X.prototype) {
            const _open = X.prototype.open;
            const _set = X.prototype.setRequestHeader;
            X.prototype.open = function(){
              this.__sspAuth = null;
              return _open.apply(this, arguments);
            };
            X.prototype.setRequestHeader = function(k,v){
              try{
                if (String(k).toLowerCase() === 'authorization') this.__sspAuth = String(v);
              }catch(e){}
              return _set.apply(this, arguments);
            };
            const _send = X.prototype.send;
            X.prototype.send = function(){
              try{
                if (this.__sspAuth) publish(this.__sspAuth);
              }catch(e){}
              return _send.apply(this, arguments);
            };
          }
        }catch(e){}
      })();`;

      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch {}
  }

  function _sspGetTrackAuthHeader() {
    // Prefer same-tab captured token, fallback to persisted GM storage.
    try {
      let v = null;
      try { if (typeof unsafeWindow !== "undefined") v = unsafeWindow.__SSP_TRACK_AUTH__; } catch {}
      if (_sspIsBearerValid(v)) return String(v);
      const stored = _sspLoadTrackAuthFromStore();
      if (_sspIsBearerValid(stored)) return String(stored);
      return null;
    } catch { return null; }
  }

  // Install auth tap ASAP (on all matched pages).
  _sspInstallTrackAuthTap();

(function _ssp2InjectButtonCss(){
  try {
    if (document.getElementById("ssp2-style-btn")) return;
    const st = document.createElement("style");
    st.id = "ssp2-style-btn";
    st.textContent = `
      #ssp2-panel button, #ssp2-planpanel button {
        padding:6px 10px;
        border-radius:10px;
        border:1px solid #d1d5db;
        background:#fff;
        font-weight:900;
        cursor:pointer;
      }
      #ssp2-panel button:hover, #ssp2-planpanel button:hover { filter: brightness(0.98); }
    `;
    document.head.appendChild(st);
  } catch {}
})();


  /* =====================================================
     DEFAULT CONFIG + SETTINGS (persisted)
  ====================================================== */
  const DEFAULT_SETTINGS = {
    refreshSeconds: 30,

    overlayOn: true,
    actionableOnly: false,

    // Prefetch OB container details for visible VRIDs (can cause slow panel load if SSP is rate-limiting)
    prefetchObDetails: false,


    // Show Merge Panel debug details (why eligible IB/units are missing)
    mergeDebug: false,

    // Outbound load type filter for the "Loads" dropdown
    obLoadType: "all", // all | amzl_all | amzl53 | amzl26 | ddu

    // Keyword highlights (applied to SSP tables)
    highlights: [],

    // IB CSV alert timing (framework only; logic to be wired next)
    ibCptBufferMinutes: 45,
    ibAlertLeadMinMinutes: 15,
    ibAlertLeadMaxMinutes: 25,

    // Merge thresholds (utilization ratio requiredPerLoad / capacity)
    mergeSoon: 0.37,
    mergeNow: 0.68,

// Capacity / merge decision model (lane-level)
capHardWarnPct: 0.90,      // "in-facility" threshold that enables MERGE NOW logic
capMergeSoonPct: 0.85,     // projected fullness threshold to say MERGE SOON
capMergeNowPct: 1.00,      // projected fullness threshold to say MERGE NOW
capRiskPct: 1.00,          // hard fullness threshold to say RISK (overflow)
mergeInboundWeight: 0.35,  // weight applied to "scheduled/in-transit" inbound volume
adhocOverageUnits: 8,      // units over capacity that triggers ADHOC recommendation
cancelLeadMinutes: 120,    // suggest CANCEL only when >= this many minutes before CPT
cancelShowHorizonMinutes: 360, // don't suggest CANCEL earlier than this far out (data can be sparse)
cancelMinObservedUnits: 6,   // require at least this many observed units (facility+upstream) unless very close to CPT

    // Equipment capacities (CART unit capacity)
    cap53ftCarts: 36,
    cap26ftCarts: 18,

    capCubeCarts: 15, // CUBE_TRUCK default (adjust in Settings)

    // Weighted unit factors ("units" are handling units; carts=1.0 baseline)
    // PALLET/GAYLORD are treated as 1.5 units; BAG treated as 0.25 units.
    palletUnits: 1.5,
    gaylordUnits: 1.5,
    bagUnits: 0.25,

    // Color coding
    colorOk: "#16a34a",
    colorSoon: "#f59e0b",
    colorNow: "#dc2626",

    // Diagnostics (SSP Util 2.0): lightweight entity tracing + export
    diagEnabled: false,
    diagConsole: false,
    diagCapturePayload: false, // if false: store payload keys only
    diagFailuresOnly: false,
    diagMaxEvents: 250,
    diagMaxChars: 15000,

    // Slack notifications
    slackWebhookUrl: "",
    slackEnabled: false,

  };

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  const SETTINGS_KEY = "ssp2:settings";
  const UI_PREFS_KEY = "ssp2:prefs";

  let SETTINGS = { ...DEFAULT_SETTINGS, ...(lsGet(SETTINGS_KEY, {}) || {}) };
  const CONFIG = SETTINGS; // alias for backward compatibility
  // UI prefs (header/panel hide state)
  const UI_PREFS = {
    headerHidden: false,
    panelHidden: false,
    ...(lsGet(UI_PREFS_KEY, {}) || {}),
  };

  function persistSettings() {
    lsSet(SETTINGS_KEY, SETTINGS);
  }
  function persistPrefs() {
    lsSet(UI_PREFS_KEY, UI_PREFS);
  }

  /* =====================================================
     SLACK NOTIFICATIONS MODULE
  ====================================================== */
  const SLACK_CONFIG = {
    storageKey: "ssp2:slack-config",
  };
  function getSlackConfig() {
    try {
      return lsGet(SLACK_CONFIG.storageKey, { webhookUrl: "", workflowUrl: "", enabled: false, useWorkflow: false });
    } catch {
      return { webhookUrl: "", workflowUrl: "", enabled: false, useWorkflow: false };
    }
  }

  function setSlackConfig(config) {
    try {
      const safe = {
        webhookUrl: String(config.webhookUrl || "").trim(),
        workflowUrl: String(config.workflowUrl || "").trim(),
        enabled: !!config.enabled,
        useWorkflow: !!config.useWorkflow,
      };
      lsSet(SLACK_CONFIG.storageKey, safe);
      SETTINGS.slackWebhookUrl = safe.webhookUrl || "";
      SETTINGS.slackWorkflowUrl = safe.workflowUrl || "";
      SETTINGS.slackEnabled = !!safe.enabled;
      persistSettings();
    } catch {}
  }

  async function sendSlackMessage(message, extras) {
    try {
      const config = getSlackConfig();
      const payload = Object.assign({ text: message, mrkdwn: true, username: "SSP Util Bot", icon_emoji: ":robot_face:" }, (extras || {}));

      // Choose destination: workflow trigger vs incoming webhook
      const useWorkflow = !!config.useWorkflow;
      const url = useWorkflow ? config.workflowUrl : config.webhookUrl;
      if (!url) {
        console.warn("[SSP Util] Slack endpoint not configured");
        return false;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("[SSP Util] Slack message failed:", res.status, res.statusText);
        return false;
      }

      console.log("[SSP Util] Slack message sent successfully");
      return true;
    } catch (e) {
      console.error("[SSP Util] Slack send error:", e);
      return false;
    }
  }

  function showSlackConfigModal() {
    const config = getSlackConfig();
    const modalId = "ssp-slack-config-modal-" + Math.random().toString(16).slice(2);
    const modal = document.createElement("div");
    modal.id = modalId;
    modal.style.cssText = `
      position:fixed;
      top:50%;
      left:50%;
      transform:translate(-50%, -50%);
      z-index:999999;
      width:90%;
      max-width:500px;
      background:#fff;
      border:2px solid #333;
      border-radius:12px;
      padding:20px;
      box-shadow:0 10px 40px rgba(0,0,0,0.3);
      font-family:Arial,sans-serif;
      font-size:13px;
    `;

    modal.innerHTML = `
      <div style="font-weight:900;font-size:16px;margin-bottom:15px">Slack Notification Configuration</div>
      <div style="margin-bottom:12px;">
        <div style="font-weight:700;margin-bottom:6px">Delivery method</div>
        <label style="display:inline-flex;align-items:center;gap:8px;margin-right:12px;">
          <input type="radio" name="slack-method" value="webhook" ${!config.useWorkflow ? 'checked' : ''}> Incoming Webhook
        </label>
        <label style="display:inline-flex;align-items:center;gap:8px;">
          <input type="radio" name="slack-method" value="workflow" ${config.useWorkflow ? 'checked' : ''}> Workflow trigger
        </label>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;margin-bottom:6px;font-weight:700">Incoming Webhook URL:</label>
        <input type="password" id="slack-webhook-input" placeholder="https://hooks.slack.com/services/..." 
          value="${config.webhookUrl || ''}" 
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;font-size:12px;">
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;margin-bottom:6px;font-weight:700">Workflow Trigger URL:</label>
        <input type="password" id="slack-workflow-input" placeholder="https://hooks.workflow.slack.com/..." 
          value="${config.workflowUrl || ''}"
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;font-size:12px;">
      </div>
      <div style="margin-bottom:15px;display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="slack-enabled-check" ${config.enabled ? "checked" : ""} style="cursor:pointer;">
        <label for="slack-enabled-check" style="cursor:pointer;font-weight:700">Enable Slack notifications</label>
      </div>
      <div style="color:#666;margin-bottom:15px;font-size:12px;">
        <div style="margin-bottom:8px;"><strong>How to get a webhook or workflow trigger URL:</strong></div>
        <ol style="margin:0;padding-left:20px;">
          <li>Go to <a href="https://api.slack.com/apps" target="_blank" style="color:#0066cc;text-decoration:underline;">api.slack.com/apps</a></li>
          <li>Create a new app for your workspace (or use an existing app)</li>
          <li>For simple posting: enable "Incoming Webhooks" and create a webhook URL</li>
          <li>For Workflow trigger: open Workflow Builder → Create workflow → Add "Webhook" trigger and copy the trigger URL</li>
          <li>Paste the appropriate URL into the matching field above</li>
        </ol>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:15px;">
        <button id="slack-test-btn" style="padding:8px 14px;border-radius:6px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-weight:700;">Test Message</button>
        <button id="slack-save-btn" style="padding:8px 14px;border-radius:6px;border:1px solid #333;background:#333;color:#fff;cursor:pointer;font-weight:700;">Save</button>
        <button id="slack-cancel-btn" style="padding:8px 14px;border-radius:6px;border:1px solid #d1d5db;background:#f3f4f6;cursor:pointer;font-weight:700;">Cancel</button>
      </div>
    `;

    document.body.appendChild(modal);

    const closeModal = () => {
      try { modal.remove(); } catch {}
    };

    const input = document.getElementById("slack-webhook-input");
    const workflowInput = document.getElementById("slack-workflow-input");
    const checkbox = document.getElementById("slack-enabled-check");
    const methodRadios = Array.from(modal.querySelectorAll('input[name="slack-method"]'));
    const testBtn = document.getElementById("slack-test-btn");
    const saveBtn = document.getElementById("slack-save-btn");
    const cancelBtn = document.getElementById("slack-cancel-btn");

    testBtn.addEventListener("click", async () => {
      const method = methodRadios.find(r => r.checked)?.value || 'webhook';
      const url = method === 'workflow' ? workflowInput.value.trim() : input.value.trim();
      if (!url) { alert("Please enter a URL for the selected delivery method"); return; }
      testBtn.disabled = true; testBtn.textContent = "Sending...";
      try {
        const payload = { text: "🧪 *SSP Util* – Test message from dashboard configuration", mrkdwn: true };
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (res.ok) alert("✅ Test message sent to Slack!"); else alert(`❌ Failed: ${res.status} ${res.statusText}`);
      } catch (e) { alert(`❌ Error: ${String(e && e.message ? e.message : e)}`); }
      finally { testBtn.disabled = false; testBtn.textContent = "Test Message"; }
    });

    saveBtn.addEventListener("click", () => {
      const webhook = input.value.trim(); const workflow = workflowInput.value.trim(); const enabled = checkbox.checked;
      const method = methodRadios.find(r => r.checked)?.value || 'webhook'; const useWorkflow = method === 'workflow';
      setSlackConfig({ webhookUrl: webhook, workflowUrl: workflow, enabled, useWorkflow });
      alert("✅ Slack configuration saved!"); closeModal();
    });

    cancelBtn.addEventListener("click", closeModal);

    // Close on background click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
  }

  /* =====================================================
     STATE
  ====================================================== */
  const STATE = {
    mergePanelRunId: 0,

    nodeId: null,
    inboundLoads: [],
    inboundLoadsWindow: [],
    inboundLoadsAll: [],
    ib4cpt: {},
    ib4cptGroups: [],
    inboundEligibleMap: {},
    outboundLoads: [],
    cptUtilization: {},
    bulkSelection: new Set(),

    // Inbound contributors (Lane::CPT) cache for inline display
    ibContribByLaneCpt: {},
    ibContribTsByLaneCpt: {},
    ibContribInflight: new Set(),
    ibContribQueue: [],
    ibContribWorkerRunning: false,

    overlayStats: { scanned: 0, matched: 0 },
    mergeStats: { ok: 0, soon: 0, now: 0 },

    relayConnectivity: { state: "unknown", checkedAt: 0, via: "none", message: "" },
    relayConnectivityInflight: null,

    running: false,
    lastError: null,
    lastErrorDetail: null,
    lastRun: null,
  };

  // ===== Diagnostics step collector (mpSteps) =====
  // Used for Merge Panel / fetch troubleshooting. Must be safe in both TM isolated world and page context.
  var mpSteps = (window.__SSP_UTIL_MP_STEPS = window.__SSP_UTIL_MP_STEPS || []);
  try { window.mpSteps = mpSteps; } catch (e) {}
  try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.mpSteps = mpSteps; } catch (e) {}

  window.__SSP_UTIL_STEP = window.__SSP_UTIL_STEP || function(step, extra) {
    try { mpSteps.push({ ts: Date.now(), step: String(step || ''), extra: extra || null }); } catch (e) {}
    return null;
  };

  // Local + page aliases (some inline debug paths call _step/mpStep directly)
  var _step = function(type, payload) {
    try { return window.__SSP_UTIL_STEP(type, payload); } catch (e) { return null; }
  };
  try { window._step = _step; window.mpStep = _step; } catch (e) {}
  try { if (typeof unsafeWindow !== 'undefined') { unsafeWindow._step = _step; unsafeWindow.mpStep = _step; } } catch (e) {}
  window.STATE = STATE;
  // Extra aliases so STATE is reachable from DevTools even if other scripts shadow globals.
  window.SSP_STATE = STATE;
  window.__SSP_UTIL_STATE__ = STATE;
  try { Object.defineProperty(window, "STATE", { value: STATE, writable: true, configurable: true }); } catch (_) {}



  // Phase 2 (v1.4.x): Loaded unit counts per VRID captured from OB fetchdata (getOutboundLoadContainerDetails)
  // and proactively requested for visible VRIDs (automation).
  STATE.vridLoadedUnits = STATE.vridLoadedUnits || {};

  // Phase 2: capture the actual container identifiers seen by getOutboundLoadContainerDetails.
  // This supports the Merge Panel "Current Units" verification view ("which containers are being seen").
  STATE.vridContainerIds = STATE.vridContainerIds || {}; // vrid -> string[]

  // Phase 2: richer container metadata (label + package count) from OB tree.
  STATE.vridContainersMeta = STATE.vridContainersMeta || {}; // vrid -> {id,label,pkgCount}[]


  // Phase 2: Upstream container details by loadGroupId (lane + CPT).
  // This uses entity=getContainerDetailsForLoadGroupId which returns a ROOT_NODE tree where:
  // - root.container.contType === 'LOAD' with container.lane populated (inbound lane)
  // - childNodes contain CART nodes (contType === 'CART') representing carts/containers.
  STATE.loadGroupContainerCache = STATE.loadGroupContainerCache || {}; // loadGroupId -> {ts, byInboundLane, loads}


  // Cache exact OB request payloads observed from native SSP calls (debug/fallback).
  STATE.lastObPayloadByVrid = STATE.lastObPayloadByVrid || {}; // vrid -> payload
  STATE.vridContainersMeta = STATE.vridContainersMeta || {};
  // CPT Container Details breakdown (containers by status) captured from OB fetchdata when available.
  STATE.vridCptContainersByStatus = STATE.vridCptContainersByStatus || {}; // vrid -> {status: containersCount}
window.__SSP_DIAG = window.__SSP_DIAG || {
  runId: 0,
  lastRefreshRunId: 0,
  lastRefreshTs: 0,
  events: [],
  lastError: null,
};
  function initOutboundContainerCoordinator() {
  if (STATE.outboundContainerCoordinatorInit) return;

  STATE.outboundContainerCache = STATE.outboundContainerCache || {};
  STATE.outboundContainerInflight = STATE.outboundContainerInflight || new Map();

  STATE.outboundContainerCoordinatorInit = true;
}

  function extractContainerIdsFromObTree(nodes) {
    // Traverse OB container tree and pull identifiers for non-trailer, non-package container nodes.
    // Field names are inconsistent across SSP versions, so be permissive.
    const ids = [];
    const seen = new Set();
    const stack = Array.isArray(nodes) ? [...nodes] : [];

    const norm = (v) => String(v ?? "").trim();

    while (stack.length) {
      const n = stack.pop();
      const c = n?.container || n?.cont || n || {};

      const ctRaw =
        c?.contType ||
        c?.containerType ||
        c?.type ||
        n?.contType ||
        n?.containerType ||
        n?.type ||
        c?.contTypeName ||
        c?.containerTypeName ||
        "";

      const ct = norm(ctRaw).toUpperCase();

      const idRaw =
        c?.containerId ||
        c?.containerID ||
        c?.contId ||
        c?.contID ||
        c?.id ||
        c?.scannableId ||
        c?.scannableID ||
        c?.licensePlate ||
        c?.containerCode ||
        n?.containerId ||
        n?.id ||
        "";

      const id = norm(idRaw);

      // Count only "unit" containers (carts/pallets/etc.), not the trailer or packages.
      if (id && ct !== "TRAILER" && ct !== "PACKAGE") {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }

      const kids = n?.childNodes || n?.children || n?.childs || c?.childNodes || c?.children;
      if (Array.isArray(kids) && kids.length) stack.push(...kids);
    }

    return ids;
  }


/**
 * Walk outbound tree nodes and extract container counts by status for a lane group.
 */
function extractContainersMetaFromObTree(nodes) {
  // Traverse OB container tree and return distinct container nodes with:
  // - id: best-effort container identifier
  // - label: display label (falls back to id)
  // - pkgCount: number of childNodes under the container (packages)
  const out = [];
  const seen = new Set();
  const stack = Array.isArray(nodes) ? [...nodes] : [];

  const norm = (v) => String(v ?? "").trim();

  while (stack.length) {
    const n = stack.pop();
    const c = n?.container || n?.cont || n || {};

    const ctRaw =
      c?.contType ||
      c?.containerType ||
      c?.type ||
      n?.contType ||
      n?.containerType ||
      n?.type ||
      c?.contTypeName ||
      c?.containerTypeName ||
      "";

    const ct = norm(ctRaw).toUpperCase();

    const idRaw =
      c?.containerId ||
      c?.containerID ||
      c?.contId ||
      c?.contID ||
      c?.id ||
      c?.scannableId ||
      c?.scannableID ||
      c?.licensePlate ||
      c?.containerCode ||
      n?.containerId ||
      n?.id ||
      "";

    const id = norm(idRaw);

    const labelRaw =
      c?.label ||
      c?.containerLabel ||
      c?.contLabel ||
      c?.displayId ||
      c?.displayID ||
      c?.scannableId ||
      c?.licensePlate ||
      idRaw ||
      "";

    const label = norm(labelRaw) || id;

    const kids = n?.childNodes || n?.children || n?.childs || c?.childNodes || c?.children;
    const pkgCount = Array.isArray(kids) ? kids.length : 0;

    if (id && ct !== "TRAILER" && ct !== "PACKAGE") {
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, label, pkgCount });
      }
    }

    if (Array.isArray(kids) && kids.length) stack.push(...kids);
  }

  return out;
}


  function countUnitsFromObTree(nodes) {
    // Treat "units" as distinct non-trailer, non-package container nodes.
    // If type fields are missing, fall back to counting nodes that have a container identifier.
    let count = 0;
    const seen = new Set();
    const stack = Array.isArray(nodes) ? [...nodes] : [];

    const norm = (v) => String(v ?? "").trim();

    while (stack.length) {
      const n = stack.pop();
      const c = n?.container || n?.cont || n || {};

      const ctRaw =
        c?.contType ||
        c?.containerType ||
        c?.type ||
        n?.contType ||
        n?.containerType ||
        n?.type ||
        c?.contTypeName ||
        c?.containerTypeName ||
        "";

      const ct = norm(ctRaw).toUpperCase();

      const idRaw =
        c?.containerId ||
        c?.containerID ||
        c?.contId ||
        c?.contID ||
        c?.id ||
        c?.scannableId ||
        c?.scannableID ||
        c?.licensePlate ||
        c?.containerCode ||
        n?.containerId ||
        n?.id ||
        "";

      const id = norm(idRaw);

      const isUnit = (ct && ct !== "TRAILER" && ct !== "PACKAGE") || (!ct && !!id);

      if (isUnit) {
        const key = id || JSON.stringify([ct, n?.idx ?? "", n?.seq ?? ""]);
        if (!seen.has(key)) {
          seen.add(key);
          count += 1;
        }
      }

      const kids = n?.childNodes || n?.children || n?.childs || c?.childNodes || c?.children;
      if (Array.isArray(kids) && kids.length) stack.push(...kids);
    }
    return count;
  }

  function countCartsFromTree(nodes) {
    let carts = 0;
    const cartIds = [];
    const walk = (n) => {
      if (!n) return;
      const c = n.container || n.cont || {};
      const ct = String(c.contType || c.containerType || c.type || "").toUpperCase();
      if (ct === "CART") {
        carts += 1;
        if (c.containerId) cartIds.push(String(c.containerId));
      }
      const kids = n.childNodes || n.children || [];
      if (Array.isArray(kids)) for (const k of kids) walk(k);
    };
    if (Array.isArray(nodes)) for (const n of nodes) walk(n);
    return { carts, cartIds };
  }


  // Canonical weighted handling-units formula used everywhere in SSP Util
  // (not package count): CART=1.0, PALLET=1.5, GAYLORD=1.5, BAG=0.25, CAGE=1.0;
  // non-physical nodes (e.g., PACKAGE/LOAD/TRAILER/areas) are explicitly excluded (0 units).
  const UNIT_WEIGHTS_BY_CONTTYPE = Object.freeze({
    CART: 1.0,
    PALLET: 1.5,
    GAYLORD: 1.5,
    BAG: 0.25,
    CAGE: 1.0,
  });
  const DEFAULT_UNIT_WEIGHT = 1.0;

  function getUnitWeight(contType) {
    const k = String(contType || "").toUpperCase().trim();
    if (!k) return DEFAULT_UNIT_WEIGHT;

    // Non-physical nodes that often appear in SSP container trees.
    // These must NOT contribute to handling-unit math.
    // The container-details tree can include PACKAGE leaves representing contents.
    if (
      k === 'PACKAGE' ||
      k === 'GENERAL_AREA' ||
      k === 'STACKING_AREA' ||
      k === 'STAGING_AREA' ||
      k === 'SORTER' ||
      k === 'DOCK_DOOR' ||
      k === 'TRAILER' ||
      k === 'LOAD'
    ) return 0;
    // Prefer persisted settings when present (keeps math consistent across panels).
    if (k === 'PALLET') return Number(SETTINGS.palletUnits) || UNIT_WEIGHTS_BY_CONTTYPE.PALLET;
    if (k === 'GAYLORD') return Number(SETTINGS.gaylordUnits) || UNIT_WEIGHTS_BY_CONTTYPE.GAYLORD;
    if (k === 'BAG') return Number(SETTINGS.bagUnits) || UNIT_WEIGHTS_BY_CONTTYPE.BAG;
    return (UNIT_WEIGHTS_BY_CONTTYPE[k] != null) ? UNIT_WEIGHTS_BY_CONTTYPE[k] : DEFAULT_UNIT_WEIGHT;
  }

  // Alias used by downstream panel logic.
  function unitsForContainerType(contType) {
    return getUnitWeight(contType);
  }
  // Back-compat alias (some panel paths still reference this older helper name).
  function unitsForBucket(contType) {
    return unitsForContainerType(contType);
  }


  function countUnitsFromTree(nodes) {
    let units = 0;
    let containers = 0;
    const byType = {};
    const walk = (n) => {
      if (!n) return;
      const c = n.container || n.cont || {};
      const ct = String(c.contType || c.containerType || c.type || "").toUpperCase().trim();
      // IMPORTANT: Only treat *physical containers* as Units.
      // We intentionally ignore package/item nodes that may appear in the tree.
      // Authoritative physical container types for sizing (prevents PACKAGE/PKG inflation).
      // NOTE: Some containerDetails trees include PACKAGE nodes for the contents of a CART.
      // We ignore those and only count *physical containers*.
      if (ct && ct !== "LOAD" && (UNIT_WEIGHTS_BY_CONTTYPE[ct] != null || ct === 'CAGE' || ct === 'TOTE')) {
        containers += 1;
        units += getUnitWeight(ct);
        byType[ct] = (byType[ct] || 0) + 1;
      }
      const kids = n.childNodes || n.children || [];
      if (Array.isArray(kids)) for (const k of kids) walk(k);
    };
    if (Array.isArray(nodes)) for (const n of nodes) walk(n);
    return { units, containers, byType };
  }

  function fmtTypeBreakdown(byType) {
    const entries = Object.entries(byType || {});
    if (!entries.length) return "";
    // CART first, then by count desc.
    entries.sort((a, b) => {
      const ak = a[0], bk = b[0];
      if (ak === "CART" && bk !== "CART") return -1;
      if (bk === "CART" && ak !== "CART") return 1;
      return (b[1] || 0) - (a[1] || 0);
    });
    return entries.map(([k, v]) => `${k}: ${v}`).join(" | ");
  }
async function resolveOutboundContainers({
  vrid,
  planId,
  status = "Loaded",
  label = "OB_CTR",
  force = false,
  ttlMs = 5 * 60 * 1000
}) {
  initOutboundContainerCoordinator();

  const v = String(vrid || "").trim();
  const p = String(planId || "").trim();
  if (!v || !p) return null;

  const cacheKey = `${STATE.nodeId}::${p}::${v}::${status}`;
  const now = Date.now();

  // ---- Cache hit
  const cached = STATE.outboundContainerCache[cacheKey];
  if (!force && cached && cached.ts && (now - cached.ts) < ttlMs) {
    return cached.data;
  }

  // ---- Inflight dedupe
  if (STATE.outboundContainerInflight.has(cacheKey)) {
    return STATE.outboundContainerInflight.get(cacheKey);
  }

  // ---- Create inflight promise
  const inflightPromise = (async () => {
    const payload = {
      entity: "getOutboundLoadContainerDetails",
      nodeId: STATE.nodeId,
      vrId: v,
      planId: p,
      status
    };

    let resp;
    try {
      resp = await postFetch(
        "/ssp/dock/hrz/ob/fetchdata?",
        payload,
        "OB",
        { priority: 3 }
      );

      __sspRecordPull(label, payload, resp, {
        via: "resolveOutboundContainers",
        note: "coordinator fetch"
      });

      // ---- Parse containers (SSP is inconsistent here)
      const containers =
        resp?.ret?.containers ||
        resp?.ret?.containerDetails ||
        resp?.containers ||
        [];

      const normalized = {
        vrid: v,
        planId: p,
        status,
        containers,
        raw: resp
      };

      STATE.outboundContainerCache[cacheKey] = {
        ts: Date.now(),
        data: normalized
      };

      return normalized;
    } catch (err) {
      console.error("[SSP UTIL] OB coordinator failed", err);
      return null;
    } finally {
      STATE.outboundContainerInflight.delete(cacheKey);
    }
  })();

  STATE.outboundContainerInflight.set(cacheKey, inflightPromise);
  return inflightPromise;
}
async function fetchCurrentUnitsCoordinator({ lg, laneTxt }) {
  if (!lg) return null;

  // Ensure CU state
  STATE.currentUnitsCache = STATE.currentUnitsCache || {};
  STATE.currentUnitsInflight = STATE.currentUnitsInflight || new Set();
  STATE.currentUnitsDebugByLg = STATE.currentUnitsDebugByLg || {};

  const laneNorm = normalizeStackFilterToken(String(laneTxt || '').split('->').pop() || '');

  const __cuDbg = {
    ts: Date.now(),
    nodeId: String(STATE.nodeId || ''),
    lg: String(lg || ''),
    laneTxt: String(laneTxt || ''),
    laneNorm,
    key: null,
    steps: []
  };

  const _step = (name, extra) => {
    const rec = { t: Date.now(), name, ...(extra || {}) };
    __cuDbg.steps.push(rec);
    try { _cuLog(name, rec); } catch (_) {}
  };

  _step('start', { laneNorm });

  const key = `CU:${String(STATE.nodeId || '')}:${String(lg || '')}:${laneNorm}`;
  __cuDbg.key = key;
  STATE.currentUnitsDebugByLg[String(lg)] = __cuDbg;
  _step('key', { key });

  const now = Date.now();

  // ---- Cache (3 min TTL)
  const cached = STATE.currentUnitsCache[key];
  if (cached && cached.ts && (now - cached.ts) < 3 * 60 * 1000) {
    _step('cache_hit', { ageMs: now - cached.ts, cachedUnits: cached.units, cachedMeta: (cached.meta || []).length, rootsCount: cached.rootsCount });
    return cached;
  }
  _step('cache_miss');

  // ---- Inflight guard (do NOT return null; UI would fall back to raw CU)
  if (STATE.currentUnitsInflight.has(key)) {
    _step('inflight_skip');
    return {
      ts: now,
      key,
      lg,
      lane: laneNorm,
      anchor: (STATE.laneAnchorByLg && STATE.laneAnchorByLg[lg]) || null,
      units: 0,
      byType: { CART: 0, PALLET: 0, GAYLORD: 0, BAG: 0, CAGE: 0 },
      meta: [],
      rootsCount: 0,
      loading: true
    };
  }
  STATE.currentUnitsInflight.add(key);
  _step('inflight_add');

  try {
    // 1) Resolve outbound anchor (planId + vrId)
    STATE.laneAnchorByLg = STATE.laneAnchorByLg || {};
    let anchor = STATE.laneAnchorByLg[lg] || null;
    _step('anchor_cached', { has: !!anchor, anchor });

    // Validate cached anchor against current outboundLoadsAll (if available)
    if (anchor && anchor.planId) {
      const pid = String(anchor.planId || '').trim();
      const obAll = (STATE.outboundLoadsAll || []);
      if (obAll.length) {
        const ok = obAll.some(l =>
          String(l.loadGroupId || '').trim() === String(lg).trim() &&
          String(l.planId || '').trim() === pid
        );
        if (!ok) {
          _step('anchor_invalidated', { pid, reason: 'not_found_in_outboundLoadsAll' });
          anchor = null;
        } else {
          _step('anchor_valid', { pid });
        }
      } else {
        _step('anchor_validation_skipped', { pid, reason: 'outboundLoadsAll_empty' });
      }
    }

    if (!anchor) {
      anchor = resolveObAnchorForLg(lg, laneTxt);
      _step('anchor_resolved', { anchor });
      if (anchor) STATE.laneAnchorByLg[lg] = anchor;
    }

    if (!anchor || !anchor.planId) {
      _step('anchor_missing', { anchor });
      const empty = {
        ts: now,
        key,
        lg,
        lane: laneNorm,
        anchor: anchor || null,
        units: 0,
        byType: { CART: 0, PALLET: 0, GAYLORD: 0, BAG: 0, CAGE: 0 },
        meta: [],
        rootsCount: 0,
        error: 'NO_ANCHOR'
      };
      STATE.currentUnitsCache[key] = empty;
      return empty;
    }

    // 2) Fetch CU tree (authoritative)
    const payload = {
      entity: 'getContainerDetailsForLoadGroupId',
      nodeId: STATE.nodeId,
      loadGroupId: String(lg),
      planId: String(anchor.planId),
      vrId: String(anchor.vrId || anchor.vrid || ''),
      // SSP typo is REQUIRED
      status: 'inFaciltiy',
      trailerId: ''
    };
  // v1.5.97: SSP sites are inconsistent; primary is 'inFacility', fallback is legacy typo 'inFacility'.
// We try both; if ROOT_NODE is empty we treat it as "0 in-facility containers" instead of an error.
const _tryStatuses = ['inFaciltiy','inFacility'];
let resp = null;
let roots = [];
let usedStatus = null;

_step('postFetch_prepare', { endpoint: '/ssp/dock/hrz/ob/fetchdata?', payload });

for (const st of _tryStatuses) {
  usedStatus = st;
  const p = Object.assign({}, payload, { status: st });
  resp = await postFetch('/ssp/dock/hrz/ob/fetchdata?', p, 'CU_OB', { priority: 2 });
  __sspRecordPull('CU_OB', p, resp, { via: 'fetchCurrentUnitsCoordinator', note: `CU tree (${st})` });

  roots = getObRootNodes(resp);
  _step('roots_extracted_try', { status: st, rootsCount: Array.isArray(roots) ? roots.length : -1 });

  // If we got any nodes, stop. If 0, try the fallback status.
  if (Array.isArray(roots) && roots.length) break;
}

_step('roots_extracted', { rootsCount: Array.isArray(roots) ? roots.length : -1, usedStatus });
    _step('roots_extracted', { rootsCount: Array.isArray(roots) ? roots.length : -1 });

    if (!Array.isArray(roots) || !roots.length) {
      const empty = {
        ts: now,
        key,
        lg,
        lane: laneNorm,
        anchor,
        units: 0,
        byType: { CART: 0, PALLET: 0, GAYLORD: 0, BAG: 0, CAGE: 0 },
        meta: [],
        rootsCount: 0,
        error: null
      };
      _step('no_roots');
      STATE.currentUnitsCache[key] = empty;
      return empty;
    }

    // 3) Meta-first traversal, then filter to this lane + loadGroup.
    const metaAll = extractContainersMetaWithLocationFromObRoots(roots) || [];
    _step('meta_extracted', { metaAll: metaAll.length });

    const lgNorm = String(lg || '').trim();
    const tok = String(laneNorm || '').trim();
    const isCt = (t) => (t === 'CART' || t === 'PALLET' || t === 'GAYLORD' || t === 'BAG' || t === 'CAGE');

    const meta = metaAll.filter(m => {
      if (!m) return false;
      if (String(m.outboundLoadGroupId || '').trim() !== lgNorm) return false;
      const t = String(m.contType || '').toUpperCase();
      if (!isCt(t)) return false;

      if (String(m.bucket || '') === 'Loaded') return false;

      const sf = normalizeStackFilterToken(String(m.stackFilter || ''));
      // If token provided:
      // - if stackFilter exists, it must match token
      // - if stackFilter missing, allow (SSP omits it on some nodes)
      if (tok && sf && !laneTokenMatchesStackFilter(sf, tok)) return false;
      return true;
    });

    const pkgAllCount = metaAll.reduce((s, m) => s + (Number(m && m.pkgCount) || 0), 0);
    const pkgCount = meta.reduce((s, m) => s + (Number(m && m.pkgCount) || 0), 0);
    const bucketCounts = meta.reduce((acc, m) => {
      const b = String((m && m.bucket) || 'Unknown');
      acc[b] = (acc[b] || 0) + 1;
      return acc;
    }, {});
    _step('meta_filtered', { meta: meta.length, pkgCount, bucketCounts });

    const byType = { CART: 0, PALLET: 0, GAYLORD: 0, BAG: 0, CAGE: 0 };
    let units = 0;
    for (const m of meta) {
      const t = String(m.contType || '').toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(byType, t)) continue;
      byType[t] += 1;
      units += unitsForContainerType(t);
    }
    _step('aggregate_done', { units, byType, bucketCounts, pkgCount, rootsCount: roots.length });

    const result = {
      ts: now,
      key,
      lg,
      lane: laneNorm,
      anchor,
      units,
      byType,
      meta,
      // Diagnostics
      metaAllCount: metaAll.length,
      metaCount: meta.length,
      pkgAllCount,
      pkgCount,
      bucketCounts,
      rootsCount: roots.length
    };

    STATE.currentUnitsCache[key] = result;
    return result;

  } catch (e) {
    _step('error', { error: String(e && e.message ? e.message : e) });
    const fail = {
      ts: now,
      key,
      lg,
      lane: laneNorm,
      anchor: (STATE.laneAnchorByLg && STATE.laneAnchorByLg[lg]) || null,
      units: 0,
      byType: { CART: 0, PALLET: 0, GAYLORD: 0, BAG: 0, CAGE: 0 },
      meta: [],
      rootsCount: 0,
      error: String(e && e.message ? e.message : e)
    };
    STATE.currentUnitsCache[key] = fail;
    return fail;
  } finally {
    STATE.currentUnitsInflight.delete(key);
  }
}
  function summarizeLoadGroupRoots(roots) {
    // Returns:
    // {
    //   totalUnitsAll, totalContainersAll,
    //   totalUnitsCart, totalContainersCart,
    //   byInboundLane: { lane: { loadCount, unitCount, containerCount, byType, loads:[{id, units, containers, byType}] } }
    // }
    const byInboundLane = {};
    let totalUnitsAll = 0;
    let totalContainersAll = 0;
    let totalUnitsCart = 0;
    let totalContainersCart = 0;

    const isCartLane = (laneStr) => /CART/i.test(String(laneStr || ""));

    const arr = Array.isArray(roots) ? roots : [];
    for (const r of arr) {
      const c = r?.container || r?.cont || {};
      const lane = String(c.lane || c.stackFilter || "UNKNOWN");
      const loadId = String(
        c.containerId || c.inboundLoadId || c.outboundLoadGroupId || c.outboundLoadId || c.id || "UNKNOWN"
      );

      const kids = r?.childNodes || r?.children || [];
      const { units, containers, byType } = countUnitsFromTree(kids);

      if (!byInboundLane[lane]) {
        byInboundLane[lane] = { loadCount: 0, unitCount: 0, containerCount: 0, byType: {}, loads: [] };
      }
      byInboundLane[lane].loadCount += 1;
      byInboundLane[lane].unitCount += units;
      byInboundLane[lane].containerCount += containers;
      for (const [t, n] of Object.entries(byType || {})) {
        byInboundLane[lane].byType[t] = (byInboundLane[lane].byType[t] || 0) + (n || 0);
      }
      byInboundLane[lane].loads.push({ id: loadId, units, containers, byType });

      totalUnitsAll += units;
      totalContainersAll += containers;

      if (isCartLane(lane)) {
        totalUnitsCart += units;
        totalContainersCart += containers;
      }
    }

    return { totalUnitsAll, totalContainersAll, totalUnitsCart, totalContainersCart, byInboundLane };
  }

/**
 * Normalize SSP/FMC outbound response into a stable array of root nodes.
 */
function getObRootNodes(resp) {
    // SSP OB container details response shapes vary by view/version.
    // Prefer ROOT_NODE, but fall back to common alternates or aaData-as-array.
    const aa = resp?.ret?.aaData;
    if (!aa) return [];

    // Common container-tree fields
    const candidates = [
      aa?.ROOT_NODE,
      aa?.rootNode,
      aa?.rootNodes,
      aa?.tree,
      aa?.nodes,
      aa?.data,
    ];

    for (const c of candidates) {
      if (Array.isArray(c)) return c;
      if (c && Array.isArray(c?.ROOT_NODE)) return c.ROOT_NODE;
      if (c && Array.isArray(c?.nodes)) return c.nodes;
    }

    if (Array.isArray(aa)) return aa;

    // Sometimes aaData is a stringified JSON blob
    if (typeof aa === "string") {
      try {
        const j = JSON.parse(aa);
        return getObRootNodes({ ret: { aaData: j } });
      } catch {}
    }

    return [];
  }
    function getInboundContribForLane(loadGroupId, laneTokenNorm) {
  const out = [];
  const prefix = `${loadGroupId}::notArrived::`;
  const cache = STATE.loadGroupContainerCache || {};

  for (const [k, entry] of Object.entries(cache)) {
    if (!k.startsWith(prefix)) continue;
    const vrid = k.slice(prefix.length);
    const roots = entry?.roots || [];
    const contrib = summarizeRootsForLane(roots, laneTokenNorm); // your walker

    if (contrib.units > 0 || contrib.containers > 0) {
      out.push({ vrid, ...contrib });
    }
  }
  out.sort((a,b) => (b.units - a.units));
  return out;
}
/**
 * Summarize root nodes into lane-level aggregates (capacity, loaded/current/inbound, etc.).
 */
function summarizeRootsForLane(roots, laneTokenNorm) {
  const out = {
    vrids: new Set(),
    byStatus: {
      inFacility: 0,
      notArrived: 0,
    },
    samples: new Map(), // vrid -> { count, exampleContainers[] }
  };

  if (!Array.isArray(roots)) return out;

  const stack = [...roots];

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    const c = node.container || null;
    const kids = node.childNodes || [];

    if (Array.isArray(kids)) {
      for (const k of kids) stack.push(k);
    }

    if (!c) continue;

    // Must belong to this outbound lane
    const lg = String(c.outboundLoadGroupId || "").trim();
    if (!lg) continue;

    // stackFilter or label usually contains lane token (DYN7-CYC1 etc)
    const laneHit =
      (c.stackFilter && c.stackFilter.includes(laneTokenNorm)) ||
      (c.label && c.label.includes(laneTokenNorm));

    if (!laneHit) continue;

    // Inbound attribution
    const vrid = String(c.inboundLoadId || "").trim();
    if (!vrid) continue;

    out.vrids.add(vrid);

    // Status bucket
    const isInFacility =
      c.contType === "CART" ||
      c.contType === "PALLET" ||
      c.contType === "GAYLORD" ||
      c.contType === "BAG";

    if (isInFacility) out.byStatus.inFacility++;
    else out.byStatus.notArrived++;

    // Samples
    if (!out.samples.has(vrid)) {
      out.samples.set(vrid, {
        count: 0,
        exampleContainers: [],
      });
    }

    const s = out.samples.get(vrid);
    s.count++;
    if (s.exampleContainers.length < 3) {
      s.exampleContainers.push(c.label || c.containerId);
    }
  }

  return out;
}


  STATE.vridDetails = STATE.vridDetails || {
    requested: new Set(),
    inflight: new Set(),
    queue: [],
    workerRunning: false,
    lastTick: 0,
  };
    STATE.driverIdByVrid = STATE.driverIdByVrid || new Map();        // vrid -> driverId
    STATE.carrierNameByVrid = STATE.carrierNameByVrid || new Map();  // vrid -> carrierName
    // Some FMC payloads include driver contact without a driverId (or the id is only present after check-in)
    STATE.driverNameByVrid = STATE.driverNameByVrid || new Map();    // vrid -> driver name
    STATE.driverPhoneByVrid = STATE.driverPhoneByVrid || new Map();  // vrid -> driver phone

    STATE.driverKeyByVrid = STATE.driverKeyByVrid || new Map();      // vrid -> relay driver ARN/key
async function fetchFmcExecutionMetaByIds(vrids) {
  const ids = (vrids || []).map(String).map(s => s.trim()).filter(Boolean);
  if (!ids.length) return null;

  const payload = {
    searchIds: ids,
    searchByIds: true,
    page: 0,
    pageSize: 200,
    bookmarkedSavedSearch: false,
    executionViewModePreference: "vrs"
  };

  const res = await sspFetch("https://trans-logistics.amazon.com/fmc/search/execution/by-id", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/plain, */*"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(`FMC by-id failed: ${res.status}`);
  return res.json();
}

/**
 * Build driver lookup maps from FMC search results for fast driver popovers.
 */
function hydrateDriverMapsFromFmcSearch(json) {
  const records = json?.data?.records || json?.returnedObject?.records || json?.records || [];
  for (const r of records) {
    const vrid = String(r?.vehicleRunId || r?.vrid || "").trim();
    if (!vrid) continue;

    const carrierName = r?.carrierName || r?.carrier || r?.carrierDisplayName || "";
    if (carrierName) STATE.carrierNameByVrid.set(vrid, carrierName);

    // Driver identification can surface under different shapes depending on view/state.
    // We capture both id and contact, even if id is absent (e.g., not checked in yet).
    const firstAssigned = Array.isArray(r?.assignedDrivers) ? r.assignedDrivers[0] : null;
    const driverId =
      firstAssigned?.assetId ||
      firstAssigned?.id ||
      r?.assignedDriverId ||
      r?.driverId ||
      r?.driver?.assetId ||
      r?.driver?.id ||
      r?.driverAssetId ||
      "";

    if (driverId) STATE.driverIdByVrid.set(vrid, String(driverId));


    const driverKey =
      extractRelayDriverKey(firstAssigned?.assetId) ||
      extractRelayDriverKey(firstAssigned?.id) ||
      extractRelayDriverKey(r?.driverAssetId) ||
      extractRelayDriverKey(r?.driverId) ||
      extractRelayDriverKey(r?.assignedDriverId) ||
      extractRelayDriverKey(r?.driver) ||
      extractRelayDriverKey(r);
    if (driverKey) STATE.driverKeyByVrid.set(vrid, String(driverKey));
    const driverName =
      r?.driverName ||
      firstAssigned?.name ||
      firstAssigned?.fullName ||
      r?.driver?.name ||
      r?.driver?.fullName ||
      "";
    const driverPhone =
      r?.driverPhone ||
      r?.driverPhoneNumber ||
      firstAssigned?.phone ||
      firstAssigned?.phoneNumber ||
      r?.driver?.phone ||
      r?.driver?.phoneNumber ||
      "";

    if (driverName) STATE.driverNameByVrid.set(vrid, String(driverName));
    if (driverPhone) STATE.driverPhoneByVrid.set(vrid, String(driverPhone));
  }
}



  // OB fetchdata expects a non-empty status; SSP will return ok=false if omitted.
  // Normalize whatever the load row provides into one of the common SSP status tokens.
  function normalizeObStatus(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return 'inFacility';

    // Common SSP/Atlas variants
    if (s.includes('DEPART')) return 'departed';
    if (s.includes('LOAD')) return 'loaded';
    if (s.includes('FACILITY') || s.includes('IN_FACILITY')) return 'inFacility';
    if (s.includes('AT_DOCK')) return 'atDock';
    if (s.includes('AT_YARD')) return 'atYard';
    if (s.includes('TRANSIT') || s.includes('IN_TRANSIT')) return 'inTransit';

    // Older strings we used elsewhere
    // Fall back to a safe default that keeps the endpoint happy.
    return 'inFacility';
  }

  // Treat these statuses as final/non-actionable for ops (exclude from capacity + Action Panel).
  function isObFinalStatus(raw) {
    const s = String(raw || "").trim().toUpperCase();
    return (
      s.includes("DEPART") ||
      s.includes("CANCEL") ||
      s.includes("COMPLETED") ||
      s === "COMPLETE"
    );
  }


  // Stack filters / lane tokens show up in SSP with inconsistent spacing/casing and occasional unicode arrows.
  // Normalize to an uppercase, delimiter-stable token so we can reliably compare lane identifiers.
  function normalizeStackFilterToken(raw) {
    return String(raw ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '')
      .replace(/[|]/g, '')
      .replace(/→/g, '->')
      .replace(/—/g, '-')
      .replace(/–/g, '-')
      .replace(/−/g, '-')
      .replace(/_/g, '')
      .replace(/\u00A0/g, '');
  }

  // Lane token matching helper:
  // SSP stackFilter often uses "CYCLE" where lane text uses "CYC" (e.g., DYN7-CYCLE1-SMALL vs DYN7-CYC1).
  // This matcher is tolerant of CYC/CYCLE differences and suffixes like -SMALL/-LARGE.
  function laneTokenMatchesStackFilter(stackFilterNorm, laneTokenNorm) {
    const tok = String(laneTokenNorm || '').trim();
    if (!tok) return true;

    const hay = String(stackFilterNorm || '').trim();
    if (!hay) return false;

    // Direct match first
    if (hay.includes(tok)) return true;

    // Parse token like ROUTE-(CYC|CYCLE)N (cycle is optional)
    const m = tok.match(/^([A-Z0-9]+)(?:-(?:CYC|CYCLE)\s*([0-9]+))?/i);
    if (!m) return false;

    const route = String(m[1] || '').toUpperCase();
    const cycN = String(m[2] || '');

    if (route && !hay.includes(route)) return false;

    if (cycN) {
      // Accept both spellings and common separators
      const ok =
        hay.includes(`CYC${cycN}`) ||
        hay.includes(`CYCLE${cycN}`) ||
        hay.includes(`CYC-${cycN}`) ||
        hay.includes(`CYCLE-${cycN}`);
      if (!ok) return false;
    }

    return true;
  }

    function esc(s){
        return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
  function buildObContainerDetailsPayload(vrid) {
    const idx = (STATE.vridIndex && STATE.vridIndex[vrid]) || null;
    if (!idx) {
      // Fallback: if SSP already requested OB details for this VRID, reuse that exact payload (includes trailerId, planId, etc.)
      const cached = STATE.lastObPayloadByVrid && STATE.lastObPayloadByVrid[vrid];
      if (cached) {
        const cp = Object.assign({}, cached);
        if (!cp.status) cp.status = normalizeObStatus(idx?.loadStatus || idx?.status || idx?.loadState || '');
        return cp;
      }
      return null;
    }

    const payload = { entity: "getOutboundLoadContainerDetails", nodeId: STATE.nodeId, vrId: vrid, status: normalizeObStatus(idx.loadStatus || idx.status || idx.loadState || '') };

    // These fields materially improve response correctness; include them only when known.
    if (idx.loadGroupId) payload.loadGroupId = idx.loadGroupId;
    if (idx.planId) payload.planId = idx.planId;
    if (idx.trailerId) payload.trailerId = idx.trailerId;
    if (idx.trailerNumber) payload.trailerNumber = idx.trailerNumber;

    // TrailerId is required by SSP; without it the request will fail.
    if (!payload.trailerId) return null;

    return payload;
  }

  async function fetchOutboundContainerDetails(vrid) {
    const payload = buildObContainerDetailsPayload(vrid);
    if (!payload) return null;
    try {
      const r = await postFetch("/ssp/dock/hrz/ob/fetchdata?", payload, "OB", {priority:0});
      const roots = getObRootNodes(r);
      if (Array.isArray(roots)) {
        const loadedUnits = countUnitsFromObTree(roots);
        STATE.vridLoadedUnits[vrid] = loadedUnits || 0;

        // Capture container IDs for verification.
        const ids = extractContainerIdsFromObTree(roots);
        if (ids && ids.length) STATE.vridContainerIds[vrid] = ids;

        const meta = extractContainersMetaFromObTree(roots);
        if (meta && meta.length) STATE.vridContainersMeta[vrid] = meta;
      }
      STATE.vridObResp[vrid] = r;
      return r;
    } catch (_) {
      return null;
    }
  }
/**
 * Extract per-CPT container totals by status from outbound response payload.
 */
function extractCptContainersByStatusFromObResp(resp) {
  // Best-effort extraction of "CPT Container Details" (containers column) by status.
  // Response shapes vary; we look for arrays of row-objects that resemble:
  // { name/status/label: "In Facility", containers: 11, packages: 302 }
  const out = {};
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const normKey = (s) => String(s || "").trim();

  const maybeConsumeRows = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return false;

    let hits = 0;
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      const c =
        r.containers ?? r.containerCount ?? r.container_count ?? r.contCount ?? r.cont ??
        r.Containers ?? r.CONTAINERS;
      const name =
        r.status ?? r.name ?? r.label ?? r.key ?? r.state ?? r.type ??
        r.Status ?? r.Name ?? r.Label;

      const cn = toNum(c);
      if (cn !== null && name) hits++;
    }
    if (!hits) return false;

    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      const name =
        r.status ?? r.name ?? r.label ?? r.key ?? r.state ?? r.type ??
        r.Status ?? r.Name ?? r.Label;
      const c =
        r.containers ?? r.containerCount ?? r.container_count ?? r.contCount ?? r.cont ??
        r.Containers ?? r.CONTAINERS;
      const cn = toNum(c);
      if (!name || cn === null) continue;
      const k = normKey(name);
      if (!k) continue;
      out[k] = (out[k] || 0) + cn;
    }
    return Object.keys(out).length > 0;
  };

  const stack = [resp];
  let depth = 0;

  while (stack.length && depth < 2000) {
    depth++;
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      if (cur.length < 200 && maybeConsumeRows(cur)) break;
      for (const v of cur) stack.push(v);
      continue;
    }

    if (typeof cur === "object") {
      const direct =
        cur.cptContainerDetails || cur.cpt_container_details || cur.CPT_CONTAINER_DETAILS || cur.cptDetails;
      if (direct && Array.isArray(direct) && maybeConsumeRows(direct)) break;

      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }

  return out;
}

// ==== CU Diagnostics helpers (1.5.48)
/**
 * Whether CU diagnostics logging is enabled (used to keep console noise controllable).
 */
function _cuDiagEnabled() {
  try { return !!(STATE && STATE.settings && STATE.settings.mergeDebug); } catch (e) { return false; }
}
/**
 * Conditional logger for Current Units (CU) pipeline; emits stepwise debug snapshots.
 */
function _cuLog(step, data) {
  if (!_cuDiagEnabled()) return;
  try {
    console.log('[SSP UTIL][CU]', step, data || '');
  } catch (e) {}
}



// Debug helper: fetch and dump the raw OB container-details payload for a VRID.
// This is used when Loaded=0 but the lane is actively loading, to adapt parsers to new SSP shapes.

  // Fetch container-tree details for a loadGroup at a specific status.
  // status:
  //   - "inFacility" or "inFacility" (OB endpoint expects the historical typo "inFacility")
  //   - "notArrived" (upstream / in-yard / on-door)
  // Fetch container-tree details for a loadGroup at a specific status.
  // status:
  //   - 'inFacility' or 'inFacility' (OB endpoint expects the historical typo 'inFacility')
  //   - 'notArrived' (upstream / in-yard / on-door)
  async function fetchContainerDetailsForLoadGroupId(loadGroupId, idx, status) {
    const lg = String(loadGroupId || '').trim();
    if (!lg) return null;

    // Normalize status for the OB endpoint.
    // NOTE: SSP OB endpoint historically expects the typo "inFaciltiy".
    // We accept either spelling from callers, but always send the typo to SSP.
    let st = String(status || '').trim();
    if (!st) st = 'inFaciltiy';
    if (st === 'inFacility') st = 'inFaciltiy';
    if (st === 'inFaciltiy') st = 'inFaciltiy';
    if (st.toLowerCase() === 'infacility') st = 'inFaciltiy';

    STATE.loadGroupContainerCache = STATE.loadGroupContainerCache || {};
    // In-flight map so concurrent callers await the same promise (prevents null returns / race conditions).
    STATE.loadGroupContainerInflight = STATE.loadGroupContainerInflight || new Map();

        // Normalize identity inputs for stable caching/dedupe.
    const planKey = String(idx?.planId || idx?.planid || '').trim();
    const vrKey = String(idx?.vrid || idx?.vrId || idx || '').trim();
    const trailerKey = String(idx?.trailerId || idx?.trailerid || '').trim();
    const cacheKey = `${lg}::${st}::${planKey}::${vrKey}`;
    const now = Date.now();
    const cache = STATE.loadGroupContainerCache[cacheKey];
    if (cache && cache.ts && (now - cache.ts) < (5 * 60 * 1000)) return cache; // 5 min TTL

    // If already fetching this key, await the existing promise rather than returning null.
    const inflight = STATE.loadGroupContainerInflight.get(cacheKey);
    if (inflight) {
      try { return await inflight; } catch (_) { return null; }
    }

    // idx comes from STATE.vridIndex[vrid] (has planId/trailerId) or lane context.
    const payload = {
      entity: 'getContainerDetailsForLoadGroupId',
      nodeId: STATE.nodeId,
      loadGroupId: lg,
      planId: String(idx?.planId || ''),
      vrId: String(idx?.vrid || idx?.vrId || ''),
      status: st,
      trailerId: String(idx?.trailerId || ''),
    };

    const p = (async () => {
      try {
        const r = await postFetch('/ssp/dock/hrz/ob/fetchdata?', payload, 'LG', { priority: 1 });
        const roots = getObRootNodes(r);
        const summary = summarizeLoadGroupRoots(roots);

        // We treat "Units" as physical handling units (CART/GAYLORD/PALLET/BAG/etc), not package count.
        // Use the filtered CART-lane totals for consistency with the lane view.
        const out = {
          ts: Date.now(),
          status: st,
          roots,
          payload,
          respOk: !!r?.ok,
          respMessage: String(r?.message || ''),
          ...summary,
          totalUnits: Number(summary?.totalUnitsCart || 0),
          totalContainers: Number(summary?.totalContainersCart || 0),
        };

        STATE.loadGroupContainerCache[cacheKey] = out;

// Also store a simplified cache entry keyed only by loadGroupId + normalized status.
// The Action Panel precompute uses these simple keys (e.g., `${lg}::inFacility`, `${lg}::notArrived`).
try {
  const stSimple = (st === 'inFacility') ? 'inFacility' : st;
  const simpleKey = `${lg}::${stSimple}`;
  const prev = STATE.loadGroupContainerCache[simpleKey];
  if (!prev || !prev.ts || prev.ts <= out.ts) STATE.loadGroupContainerCache[simpleKey] = out;
} catch (_) {}

        // If this pull was triggered by the Action Panel precompute, force a lightweight re-render
        // so "Current" / "Inbound" hydrate immediately instead of waiting for the next timed refresh.
        try {
          clearTimeout(STATE.__apHydrateT);
          STATE.__apHydrateT = setTimeout(() => {
            try { if (typeof renderPanel === 'function') renderPanel(); } catch (_) {}
          }, 50);
        } catch (_) {}

        return out;
      } catch (_) {
        return null;
      } finally {
        try { STATE.loadGroupContainerInflight.delete(cacheKey); } catch (_) {}
      }
    })();

    STATE.loadGroupContainerInflight.set(cacheKey, p);
    return await p;
  }

async function dumpObPayloadForVrid(vrid) {
  const v = String(vrid || "").trim();
  if (!v) return;

  const payload = buildObContainerDetailsPayload(v);
  if (!payload) {
    console.warn("[SSP UTIL][OB DUMP] Missing OB payload inputs for VRID:", v, { nodeId: STATE.nodeId, index: STATE.vridIndex?.[v] });
    return;
  }

  console.groupCollapsed(`[SSP UTIL][OB DUMP] ${v}`);
  try {
    const r = await postFetch("/ssp/dock/hrz/ob/fetchdata?", payload, "OB", {priority:0});
    // Store for copy/paste without scrolling the console.
    window.__SSP_UTIL_LAST_OB_DUMP__ = { vrid: v, ts: Date.now(), payloadSent: payload, response: r };
    console.log("payloadSent:", payload);
    console.log("response(ret):", r);
    try {
      const roots = getObRootNodes(r);
      console.log("parsedRootNodesCount:", Array.isArray(roots) ? roots.length : 0);
    } catch (e) {
      console.warn("getObRootNodes parse failed:", e);
    }
    console.log("window.__SSP_UTIL_LAST_OB_DUMP__ set (copy from DevTools).");
  } catch (e) {
    console.error("[SSP UTIL][OB DUMP] request failed:", e);
  } finally {
    console.groupEnd();
  }
}
  // Proactively request OB container details for visible VRIDs so "Loaded / Capacity" is accurate immediately.
  // Throttled to avoid hammering SSP.
  function ensureVridDetailsRequested(vrid) {
    if (!vrid) return;
    if (!STATE.mergePanelOpen && !STATE.dockOppsOpen && !SETTINGS.prefetchObDetails) return;
    if (STATE.vridLoadedUnits && Number.isFinite(STATE.vridLoadedUnits[vrid])) return; // already have a value
    const d = STATE.vridDetails;
    if (d.requested.has(vrid) || d.inflight.has(vrid)) return;

    d.requested.add(vrid);
    d.queue.push(vrid);

    if (!d.workerRunning) {
      d.workerRunning = true;
      void (async function worker() {
        try {
          // concurrency=1 with a short delay is safest for SSP; increase later if needed.
          while (d.queue.length) {
            const next = d.queue.shift();
            if (!next) continue;
            if (d.inflight.has(next)) continue;

            d.inflight.add(next);
            await fetchOutboundContainerDetails(next);
            d.inflight.delete(next);

            // throttle
            await new Promise(r => setTimeout(r, 180));
          }
        } finally {
          d.workerRunning = false;
        }
      })();
    }
  }


  /* =====================================================
     LOGGING / UTILS
  ====================================================== */
  const log = (...a) => console.log("[SSP UTIL]", ...a);

  // Debug guard: referenced in Merge Panel debug payloads
  function dbgEmptyAa(v) {
    return (v === undefined) ? null : v;
  }
function __diagTrunc(s, max) {
  if (s == null) return s;
  s = String(s);
  return s.length > max ? (s.slice(0, max) + "…(truncated)") : s;
}

function __diagSafePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  // Never persist large lists; keys-only unless enabled
  const keys = Object.keys(payload);
  const safe = {};
  // Always allow these for debugging anchor issues
  for (const k of ["entity", "nodeId", "view", "loadGroupId", "planId", "vrid", "status", "trailerId", "loadIds"]) {
    if (payload[k] != null) safe[k] = payload[k];
  }
  return { keys, safe };
}

function __diagPush(ev) {
  const S = SETTINGS; // your persisted settings object
  if (!S?.diagEnabled) return;

  if (S.diagFailuresOnly && ev.ok === true && ev.status === 200) return;

  const store = window.__SSP_DIAG;
  store.events.push(ev);

  const max = Math.max(50, Number(S.diagMaxEvents || 250));
  if (store.events.length > max) store.events.splice(0, store.events.length - max);

  if (S.diagConsole) {
    console.log(`[SSP Util DIAG] ${ev.area}/${ev.entity} ${ev.status} ${ev.ms}ms`, ev);
  }
}

// =====================================================
// DEBUG / VERBOSE LOGGING (dev mode)
// Toggle booleans as needed while developing.
// =====================================================
const DEBUG = {
  enabled: true,
  cpt: true,
  laneGroups: true,
  laneGroupsFull: true, // logs every group + every vrid in it
  loadLoop: false,      // very noisy: logs each outbound load while building CPT map
  clickActions: true,
};

/**
 * Structured debug logger (namespaced) used across modules.
 */
function dlog(section, payload) {
  if (!DEBUG.enabled) return;
  try {
    console.log(`[SSP UTIL][${section}]`, payload);
  } catch {
    console.log("[SSP UTIL][DBG]", section);
  }
}

/**
 * Console group helper for readable debug output blocks.
 */
function dgroup(title, fn) {
  if (!DEBUG.enabled) return;
  try {
    console.groupCollapsed(title);
    fn();
  } catch (_) {
    // ignore
  } finally {
    try { console.groupEnd(); } catch {}
  }
}

  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === "number") return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };

  // =====================================================
  // OPS DAY WINDOW (07:00 -> next day 07:00 local)
  // =====================================================
  function getOpsWindow(nowMs = Date.now()) {
    const now = new Date(nowMs);
    const start = new Date(now);
    start.setHours(7, 0, 0, 0);
    if (now < start) start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  function fmtLocal(ms) {
    try {
      return new Date(ms).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return String(ms);
    }
  }

  // Centralize the effective query windows we use for inbound/outbound.
  // - Ops window is 07:00 -> next day 07:00 local.
  // - We apply a 3-hour lookback for both IB/OB.
  // - IB also uses the same end boundary.
  function getQueryWindows(nowMs = Date.now()) {
    const { startMs, endMs } = getOpsWindow(nowMs);
    const lookbackMs = 3 * 60 * 60 * 1000;
    const ibStart = nowMs - lookbackMs;
    const ibEnd = endMs;
    const obStart = nowMs - lookbackMs;
    const obEnd = endMs;
    return { opsStart: startMs, opsEnd: endMs, ibStart, ibEnd, obStart, obEnd };
  }

  // Best-effort: extract inbound load IDs (planIds) referenced by an IB4CPT group object.
  function extractInboundIdsFromIbGroup(g) {
    const out = new Set();
    try {
      if (!g || typeof g !== 'object') return [];
      const pushAny = (v) => {
        if (!v) return;
        if (Array.isArray(v)) {
          v.forEach(pushAny);
          return;
        }
        if (typeof v === 'string') {
          // Sometimes comma-separated
          v.split(',').map(s => s.trim()).filter(Boolean).forEach(s => out.add(s));
          return;
        }
        if (typeof v === 'number') {
          out.add(String(v));
          return;
        }
        if (typeof v === 'object') {
          // common shapes: {inboundLoadId}, {loadId}, {planId}
          const cand = v.inboundLoadId || v.loadId || v.planId || v.id;
          if (cand) pushAny(cand);
        }
      };

      const directKeys = [
        'inboundLoadIds', 'inboundLoadIdList', 'inboundIds', 'loadIds', 'planIds',
        'inboundLoads', 'loads', 'loadList', 'inboundLoadList'
      ];
      for (const k of directKeys) {
        if (g[k]) pushAny(g[k]);
      }
      // Scan shallow fields for arrays that look like IDs
      for (const [k, v] of Object.entries(g)) {
        if (out.size >= 200) break;
        if (Array.isArray(v) && v.length && v.length <= 300) {
          // If it is an array of primitives/objects with id-ish fields
          pushAny(v);
        }
      }
    } catch (_) {}
    return Array.from(out);
  }



  /* =====================================================
     LINK HELPERS (TT / RELAY / FMC)
     - Defined here to avoid "not defined" runtime errors.
  ====================================================== */
  function buildTTUrl(nodeId, vrid) {
    const nid = nodeId || STATE.nodeId || document.querySelector("select")?.value || "";
    const id = String(vrid || "");
    return `https://trans-logistics.amazon.com/sortcenter/tantei?nodeId=${encodeURIComponent(String(nid))}&searchType=Container&searchId=${encodeURIComponent(id)}`;
  }

  function buildRelayUrl(vrid) {
    const id = String(vrid || "");
    // Conservative: open Relay "view" page with VR context + query set to VRID
    return `https://track.relay.amazon.dev/view/NA:VR:${encodeURIComponent(id)}?q=${encodeURIComponent(id)}`;
  }

  function buildFmcUrl(vrid) {
    const id = String(vrid || "");
    return `https://trans-logistics.amazon.com/fmc/execution/search/${encodeURIComponent(id)}`;
  }
    function ensurePhoneIconStyle() {
  if (document.getElementById("ssp-phone-style")) return;
  const style = document.createElement("style");
  style.id = "ssp-phone-style";
  style.textContent = `
    .icon-phone {
      width: 22px;
      height: 18px;
      margin-left: -1px;
      margin-bottom: -6px;
      background: transparent url(https://m.media-amazon.com/images/G/01/Help/pg-gacd-phone._V324592851_.png) no-repeat center;
      background-size: 30px;
      display: inline-block;
      vertical-align: middle;
    }
    .icon-phone-pointer { cursor: pointer; }
  `;
  document.head.appendChild(style);
}

/**
 * UI helper: add a clickable phone icon next to a VRID cell when driver contact exists.
 */
function injectPhoneIconIntoVridCell(vridCell, vrid) {
  if (!vridCell || !vrid) return;
  ensurePhoneIconStyle();

  const v = String(vrid || "").trim();
  if (!v) return;

  const bind = (iconEl) => {
    if (!iconEl) return;
    iconEl.classList.add("icon-phone", "icon-phone-pointer");
    iconEl.title = iconEl.title || "Driver / Carrier info";
    iconEl.style.marginLeft = iconEl.style.marginLeft || "6px";

    // Prevent duplicate bindings across refresh cycles / script reloads
    if (iconEl.dataset && iconEl.dataset.sspPhoneBound === "1") return;
    if (iconEl.dataset) iconEl.dataset.sspPhoneBound = "1";

    iconEl.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      showPhoneTooltip(iconEl, v);
    });
  };

  // If an icon already exists (e.g., from a prior userscript load), re-bind it.
  const existing = vridCell.querySelector(".icon-phone");
  if (existing) {
    bind(existing);
    return;
  }

  // Otherwise create one.
  const icon = document.createElement("span");
  bind(icon);
  vridCell.appendChild(icon);
}


/** Driver / phone popover helpers.
 *  NOTE: Do NOT call showPhoneTooltip() from here.
 *  v1.4.29 introduced a recursion loop:
 *    showPhoneTooltip() -> showDriverPopover() -> showPhoneTooltip() ...
 *  This wrapper is deliberately one-way.
 */
/**
 * Render and position the driver info popover anchored to a UI element.
 */
function showDriverPopover(anchorEl, html) {
  try {
    if (typeof showSspUtilPopover === "function") {
      return showSspUtilPopover(anchorEl, html);
    }

    // Last-resort minimal fallback so clicks never throw.
    const pop = document.createElement("div");
    pop.style.position = "absolute";
    pop.style.zIndex = "9999";
    pop.style.background = "#111";
    pop.style.color = "#fff";
    pop.style.border = "1px solid #333";
    pop.style.borderRadius = "6px";
    pop.style.padding = "8px 10px";
    pop.style.fontSize = "12px";
    pop.innerHTML = String(html || "No driver info");

    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.left = `${r.left + window.scrollX}px`;
    pop.style.top  = `${r.bottom + window.scrollY + 6}px`;

    const cleanup = () => {
      try { pop.remove(); } catch(e){}
      document.removeEventListener("click", cleanup, true);
    };
    setTimeout(() => document.addEventListener("click", cleanup, true), 0);
  } catch (e) {
    console.error("showDriverPopover fallback failed", e);
  }
}

/**
 * Close and cleanup the driver info popover UI.
 */
function closeDriverPopover() {
  try {
    if (typeof closeSspUtilPopover === "function") return closeSspUtilPopover();
  } catch {}
}

// Your carrier cell contains "AVXLX" plus broker tag.
// This extracts the leading SCAC token safely.

// Extract SCAC from arbitrary text blobs (e.g., "DD182 | AZNG V524925" or "AZNG GV2200559")
function extractScacFromAnyText(text) {
  const raw = String(text || "").toUpperCase();
  if (!raw) return "";
  // Prefer patterns like "| SCAC " in lane cards
  let m = raw.match(/\|\s*([A-Z0-9]{4})\b/);
  if (m && m[1]) return m[1];
  // Fallback: first 4-char token that looks like a SCAC
  m = raw.match(/\b([A-Z0-9]{4})\b/);
  return m && m[1] ? m[1] : "";
}

function extractScacFromCarrierCellText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const token = raw.split(/\s+/)[0] || "";
  return token.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}


// Extract Relay driver key/ARN from arbitrary objects/strings.
// Example: "amzn1.relay.dv1.T-6F2K0sKz6qdHLAqlx"
/**
 * Extract a Relay driver identifier/ARN from mixed payload shapes (string/object).
 */
function extractRelayDriverKey(val) {
  const scan = (x) => {
    if (!x) return "";
    if (typeof x === "string") {
      const m = x.match(/amzn1\.relay\.dv\d?\.[A-Za-z0-9\-_.:]+/i);
      return m ? m[0] : "";
    }
    if (Array.isArray(x)) {
      for (const it of x) {
        const r = scan(it);
        if (r) STATE.vridObResp[vrid] = r;
      return r;
      }
      return "";
    }
    if (typeof x === "object") {
      for (const k of Object.keys(x)) {
        const r = scan(x[k]);
        if (r) STATE.vridObResp[vrid] = r;
      return r;
      }
    }
    return "";
  };
  return scan(val);
}

async function fetchDriverDetail(scac, driverId) {
  const s = String(scac || "").trim();
  const d = String(driverId || "").trim();
  if (!s || !d) return null;

  const url = `https://trans-logistics.amazon.com/fmc/driver/detail/${encodeURIComponent(s)}/${encodeURIComponent(d)}`;
  const cacheKey = `driverDetail:${s}:${d}`;
  return sspCachedGetJson(cacheKey, url, {
    method: "GET",
    credentials: "include",
    headers: { "accept": "application/json, text/plain, */*" }
  });
}

  /* =====================================================
     PHONE TOOLTIP + BARCODE TOOLING (v1.4.20)
     - Phone tooltip is always available (not dependent on driver check-in icon)
     - Barcode generated from Location cell attached-load image resourceId
  ====================================================== */

  let __sspUtilPopover = null;

  function closeSspUtilPopover() {
    if (__sspUtilPopover) {
      __sspUtilPopover.remove();
      __sspUtilPopover = null;
    }
  }

  function showSspUtilPopover(anchorEl, html) {
    closeSspUtilPopover();

    const rect = anchorEl.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "ssp-util-popover";
    box.style.cssText = [
      "position:fixed",
      "z-index:999999",
      "min-width:240px",
      "max-width:420px",
      "padding:10px 12px",
      "border:1px solid rgba(0,0,0,0.18)",
      "border-radius:12px",
      "background:#ffffff",
      "box-shadow:0 10px 30px rgba(0,0,0,.18)",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial",
      "font-size:12px",
      "line-height:1.35"
    ].join(";");

    // Position near the anchor
    const top = Math.min(window.innerHeight - 20, rect.bottom + 8);
    const left = Math.min(window.innerWidth - 20, rect.left);
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;

    box.innerHTML = html;
    document.body.appendChild(box);
    __sspUtilPopover = box;

    // close on outside click
    setTimeout(() => {
      const onDoc = (e) => {
        if (!box.contains(e.target) && e.target !== anchorEl) {
          document.removeEventListener("mousedown", onDoc, true);
          closeSspUtilPopover();
        }
      };
      document.addEventListener("mousedown", onDoc, true);
    }, 0);
  }

  function formatPhoneNumber(phone) {
    if (!phone) return "";
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits.startsWith("1")) {
      return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
    }
    return String(phone);
  }

  async function fetchFmcExecutionLoad(vrid) {
    const id = String(vrid || "").trim();
    if (!id) throw new Error("Missing VRID");
    const url = `https://trans-logistics.amazon.com/fmc/api/v2/execution/load/${encodeURIComponent(id)}`;
    const cacheKey = `fmcLoad:${id}`;
    const json = await sspCachedGetJson(cacheKey, url, {
      method: "GET",
      credentials: "include",
      headers: { "accept": "application/json, text/plain, */*" }
    });
    return json?.returnedObject || json;
  }

  async function showPhoneTooltip(anchorEl, vrid) {
  const v = String(vrid || "").trim();
  if (!v) return;

  // Carrier/SCAC: attempt multiple sources (table carrier col, lane card text, cached trailer number, FMC load API)
  let scac = "";
  let fmcLoad = null;

  // 1) Try the dashboard table "Carrier" column if present.
  try {
    const row = anchorEl.closest("tr");
    const table = row && row.closest("table");
    const carrierIdx = table ? getColIndexByHeaderText(table, "Carrier") : -1;
    const tds = row ? Array.from(row.querySelectorAll("td")) : [];
    const carrierText = (carrierIdx >= 0 && tds[carrierIdx]) ? tds[carrierIdx].textContent : "";
    scac = extractScacFromCarrierCellText(carrierText);
  } catch {}

  // 2) Try cached index trailerNumber (e.g., "AZNG GV2200559")
  if (!scac) {
    try {
      const tn = STATE.vridIndex?.[v]?.trailerNumber || "";
      scac = extractScacFromCarrierCellText(tn);
    } catch {}
  }

  // 3) Try lane card text around the clicked icon (e.g., "DD182 | AZNG V524925")
  if (!scac) {
    try {
      const card = anchorEl.closest(".ssp-util-vrid-card") || anchorEl.closest(".ssp-util-lane") || anchorEl.closest("div");
      const t = card ? (card.textContent || "") : "";
      scac = extractScacFromAnyText(t);
    } catch {}
  }

  // 4) Fallback: FMC load API (often contains carrier scac + sometimes driver contact)
  if (!scac) {
    try {
      fmcLoad = await fetchFmcExecutionLoad(v);
      scac =
        String(fmcLoad?.carrierScac || fmcLoad?.carrierSCAC || fmcLoad?.carrier?.scac || fmcLoad?.carrier?.scacCode || "").toUpperCase().trim();
      scac = scac ? scac.replace(/[^A-Z0-9]/g, "") : "";
    } catch {}
  }


  showDriverPopover(anchorEl, `
    <div style="font-weight:900;margin-bottom:6px">Driver / Carrier</div>
    <div style="color:#6b7280">VRID:</div><div style="font-weight:800">${v}</div>
    <div style="margin-top:8px">Loading...</div>
  `);

  try {
    // 1) Ensure we have driverId (from bulk prefetch cache)
    let driverId = STATE.driverIdByVrid.get(v) || "";

    // If not present, do a single-ID FMC lookup as fallback
    if (!driverId) {
      const json = await fetchFmcExecutionMetaByIds([v]);
      hydrateDriverMapsFromFmcSearch(json);
      driverId = STATE.driverIdByVrid.get(v) || "";
    }

    // If we still don't have driver assignment, fetch FMC load (cached) even if SCAC was already available.
    // Driver identity may be a Relay ARN (amzn1.relay.dv...) and not a numeric id (id can be null).
    if (!fmcLoad && (!driverId || !STATE.driverKeyByVrid.get(v))) {
      try { fmcLoad = await fetchFmcExecutionLoad(v); } catch {}
      if (!scac && fmcLoad) {
        try {
          scac = String(fmcLoad?.carrierScac || fmcLoad?.carrierSCAC || fmcLoad?.carrier?.scac || fmcLoad?.carrier?.scacCode || "").toUpperCase().trim();
          scac = scac ? scac.replace(/[^A-Z0-9]/g, "") : "";
        } catch {}
      }
    }

    // Prefer Relay driver key/ARN when available.
    let driverKey = STATE.driverKeyByVrid.get(v) || "";
    if (!driverKey && fmcLoad) {
      const k =
        extractRelayDriverKey(fmcLoad?.driverAssetId) ||
        extractRelayDriverKey(fmcLoad?.driver?.assetId) ||
        extractRelayDriverKey(fmcLoad?.driverId) ||
        extractRelayDriverKey(fmcLoad?.driver) ||
        extractRelayDriverKey(fmcLoad);
      if (k) {
        driverKey = String(k);
        STATE.driverKeyByVrid.set(v, driverKey);
      }
    }

    // Fallback: some FMC load payloads include a driver id (sometimes the same Relay ARN).
    if (!driverId && fmcLoad) {
      const d = fmcLoad?.driverId || fmcLoad?.driver?.id || fmcLoad?.driver?.assetId || "";
      if (d) driverId = String(d);
    }

    const driverLookupKey = driverKey || driverId || "";

    const carrierName = STATE.carrierNameByVrid.get(v) || scac || "N/A";

    // Driver contact can be present even when a driverId is not (e.g., pre-checkin assignment).
    const nameFromMaps = STATE.driverNameByVrid.get(v) || "";
    const phoneFromMaps = STATE.driverPhoneByVrid.get(v) || "";
    const nameFromLoad = fmcLoad?.driverName || fmcLoad?.driver?.name || fmcLoad?.driver?.fullName || "";
    const phoneFromLoad = fmcLoad?.driverPhone || fmcLoad?.driverPhoneNumber || fmcLoad?.driver?.phone || fmcLoad?.driver?.phoneNumber || "";

    const bestName = nameFromMaps || nameFromLoad || "";
    const bestPhone = phoneFromMaps || phoneFromLoad || "";

    if ((!driverLookupKey || !scac) && (bestName || bestPhone)) {
      const name = bestName || "N/A";
      const phone = bestPhone ? formatPhoneNumber(bestPhone) : "N/A";
      showDriverPopover(anchorEl, `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-weight:900">Driver / Carrier</div>
          <button id="ssp-close-driver" style="border:0;background:#f3f4f6;border-radius:8px;padding:4px 8px;cursor:pointer;font-weight:800">Close</button>
        </div>
        <div style="margin-top:8px">
          <div><span style="color:#6b7280">VRID:</span> <b>${v}</b></div>
          <div><span style="color:#6b7280">Carrier:</span> <b>${carrierName}</b></div>
          <div><span style="color:#6b7280">Driver:</span> <b>${name}</b></div>
          <div><span style="color:#6b7280">Phone:</span> <b>${phone}</b></div>
        </div>
      `);
      document.getElementById("ssp-close-driver")?.addEventListener("click", closeDriverPopover);
      return;
    }

    if (!driverLookupKey || !scac) {
      showDriverPopover(anchorEl, `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-weight:900">Driver / Carrier</div>
          <button id="ssp-close-driver" style="border:0;background:#f3f4f6;border-radius:8px;padding:4px 8px;cursor:pointer;font-weight:800">Close</button>
        </div>
        <div style="margin-top:8px">
          <div><span style="color:#6b7280">VRID:</span> <b>${v}</b></div>
          <div><span style="color:#6b7280">Carrier:</span> <b>${carrierName}</b></div>
          <div style="margin-top:8px;font-weight:800">No driver assigned / checked in.</div>
        </div>
      `);
      document.getElementById("ssp-close-driver")?.addEventListener("click", closeDriverPopover);
      return;
    }

    // 2) Fetch driver detail (name + phone)
    const detail = await fetchDriverDetail(scac, driverLookupKey);

    const dObj = detail?.returnedObj || detail?.returnedObject || detail?.returned_obj || detail;
    const name = dObj?.fullName || dObj?.name || dObj?.driverName || bestName || "N/A";
    const phoneRaw = dObj?.phone || dObj?.phoneNumber || dObj?.mobile || dObj?.cell || bestPhone || "";
    const phone = phoneRaw ? formatPhoneNumber(phoneRaw) : "N/A";

    showDriverPopover(anchorEl, `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="font-weight:900">Driver / Carrier</div>
        <button id="ssp-close-driver" style="border:0;background:#f3f4f6;border-radius:8px;padding:4px 8px;cursor:pointer;font-weight:800">Close</button>
      </div>
      <div style="margin-top:8px">
        <div><span style="color:#6b7280">VRID:</span> <b>${v}</b></div>
        <div><span style="color:#6b7280">Carrier:</span> <b>${carrierName}</b></div>
        <div><span style="color:#6b7280">Driver:</span> <b>${name}</b></div>
        <div style="display:flex;align-items:center;gap:8px">
          <div><span style="color:#6b7280">Phone:</span> <b>${phone}</b></div>
          ${phone !== "N/A" ? `<button id="ssp-copy-phone" style="border:0;background:#eef2ff;border-radius:8px;padding:4px 8px;cursor:pointer;font-weight:800">Copy</button>` : ``}
        </div>
      </div>
    `);

    document.getElementById("ssp-close-driver")?.addEventListener("click", closeDriverPopover);
    const copyBtn = document.getElementById("ssp-copy-phone");
    if (copyBtn && phone !== "N/A") {
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(phone); } catch {}
      });
    }
  } catch (e) {
    console.error("showPhoneTooltip failed", e);
    showDriverPopover(anchorEl, `
      <div style="font-weight:900;margin-bottom:6px">Driver / Carrier</div>
      <div>Unable to load driver details.</div>
    `);
  }
}

  // Barcode support (CODE128) via JsBarcode; if blocked, show resourceId only.
  let __sspUtilJsBarcodeLoading = null;
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find(s => s.src === src);
      if (existing) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }
  async function ensureJsBarcode() {
    if (window.JsBarcode) return true;
    if (!__sspUtilJsBarcodeLoading) {
      __sspUtilJsBarcodeLoading = loadScriptOnce("https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js")
        .then(() => true)
        .catch(() => false);
    }
    return __sspUtilJsBarcodeLoading;
  }

  function extractResourceIdFromLocationImg(imgEl) {
    if (!imgEl) return "";
    const src = imgEl.getAttribute("src") || "";
    const m1 = src.match(/[?&]resourceId=([^&]+)/i);
    if (m1) return decodeURIComponent(m1[1]);
    const m2 = src.match(/[?&]id=([^&]+)/i);
    if (m2) return decodeURIComponent(m2[1]);
    const m3 = src.match(/\/resource\/([^/?#]+)/i);
    if (m3) return decodeURIComponent(m3[1]);
    const tail = src.split("/").pop() || "";
    return decodeURIComponent((tail.split("?")[0] || "").trim());
  }

  function showBarcodePopover(anchorEl, resourceId) {
    const rid = String(resourceId || "").trim();
    if (!rid) {
      showSspUtilPopover(anchorEl, `<div style="font-weight:900;margin-bottom:6px">Barcode</div><div>No resource ID found.</div>`);
      return;
    }

    const svgId = `ssp-util-barcode-${Math.random().toString(16).slice(2)}`;
    const wrapId = `ssp-util-barcode-wrap-${Math.random().toString(16).slice(2)}`;

    showSspUtilPopover(anchorEl, `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="font-weight:950">Attached Load Resource</div>
        <button id="ssp-util-close" style="border:0;background:#f3f4f6;border-radius:8px;padding:4px 8px;cursor:pointer;font-weight:900">Close</button>
      </div>
      <div style="margin-top:8px;font-weight:900;word-break:break-all">${rid}</div>
      <div id="${wrapId}" style="margin-top:10px;border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff;display:inline-block;max-width:92vw;overflow-x:auto;overflow-y:hidden;">
        <svg id="${svgId}" style="display:block;"></svg>
      </div>
    `);

    const closeBtn = document.getElementById("ssp-util-close");
    if (closeBtn) closeBtn.onclick = () => closeSspUtilPopover();

    (async () => {
      const ok = await ensureJsBarcode();
      if (!ok) return; // fall back to displaying the id only
      const svg = document.getElementById(svgId);
      const wrap = document.getElementById(wrapId);
      if (!svg || !wrap) return;

      try {
        window.JsBarcode(svg, rid, { format: "CODE128", displayValue: true });

        // Fit wrapper to barcode width (no clipping). If wider than viewport, allow horizontal scroll.
        // NOTE: getBBox() requires the SVG to have rendered content.
        try {
          const bb = svg.getBBox();
          const desired = Math.ceil((bb?.width || 0) + 20); // padding + borders
          const max = Math.floor(Math.min(window.innerWidth * 0.92, 980));
          if (desired > 0) {
            wrap.style.width = Math.min(desired, max) + "px";
            wrap.style.maxWidth = max + "px";
            wrap.style.overflowX = desired > max ? "auto" : "hidden";
          }
        } catch (_) {
          // ignore sizing issues; wrapper is already scroll-safe
        }
      } catch (e) {
        console.error("JsBarcode render failed", e);
      }
    })();
  }


  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function equipShort(equipmentTypeRaw) {
    const e = normalizeEquipmentType(equipmentTypeRaw);
    return e?.short ?? "—";
  }

  function safePreview(obj) {
    try {
      if (obj == null || typeof obj !== "object") return obj;
      const keys = Object.keys(obj);
      const preview = { __keys: keys.slice(0, 30) };
      for (const k of keys.slice(0, 12)) preview[k] = obj[k];
      return preview;
    } catch {
      return { __preview: "unavailable" };
    }
  }

  function setLastError(context, err, extra) {
    const ts = new Date().toLocaleString();
    const msg = err?.message || String(err);
    STATE.lastError = `${ts}\n${context}\n${msg}`;
    STATE.lastErrorDetail = { ts, context, msg, extra };
    console.error("[SSP UTIL ERROR]", context, err, extra || "");
  }


  /* =====================================================
     KEYWORD HIGHLIGHTS
  ====================================================== */

function ensureHighlightStyleOverrides() {
  if (document.getElementById("ssp2-hl-style")) return;
  const style = document.createElement("style");
  style.id = "ssp2-hl-style";
  style.textContent = `
    /* Force text-only highlight even if SSP applies aggressive cell styles */
    .ssp-hl { display:inline !important; width:auto !important; }
  `;
  document.head.appendChild(style);
}

  function normalizeHighlights(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const m of raw) {
      if (!m) continue;
      const keyword = String(m.keyword || "").trim();
      const color = String(m.color || "").trim();
      if (!keyword || !color) continue;
      const hex = color.startsWith("#") ? color : ("#" + color);
      if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) continue;
      out.push({ keyword, color: hex });
    }
    return out;
  }

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function pickTextColor(bgHex) {
    try {
      const { r, g, b } = hexToRgb(bgHex);
      // relative luminance (sRGB)
      const srgb = [r, g, b].map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      const L = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
      return L < 0.5 ? "#ffffff" : "#111827";
    } catch {
      return "#111827";
    }
  }

  function getContrastingTextColor(hexColor) {
    // supports #RGB or #RRGGBB
    let hex = (hexColor || "").trim();
    if (!hex.startsWith("#")) return "#000";

    hex = hex.slice(1);
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");

   const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

   // perceived luminance
   const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.6 ? "#000" : "#fff";
  }



  function clearHighlightStyles(root) {
  const cells = root.querySelectorAll("td, th");
  cells.forEach((c) => {
    if (c.dataset.ssp2HlText === "1") {
      try {
        c.style.removeProperty("color");
        c.style.removeProperty("font-weight");
        c.style.removeProperty("text-decoration");
      } catch {
        c.style.color = "";
        c.style.fontWeight = "";
        c.style.textDecoration = "";
      }
      delete c.dataset.ssp2HlText;
    }
  });
}


function getCandidateCells() {
  // Broad selectors to catch SSP/Dock Console grid/table cells
  return Array.from(document.querySelectorAll(
    "td, th, div[role='gridcell'], div[role='cell'], div[role='columnheader'], .cell, .table-cell"
  ));
}

function applyHighlights() {
  const rules = Array.isArray(SETTINGS.highlights)
    ? SETTINGS.highlights
    : [];

  if (!rules.length) return;

  // Limit scope to main dashboard table when possible
  const table =
    document.querySelector("table#dashboard") ||
    document.querySelector("table.dataTable");

  const root = table?.querySelector("tbody") || document;
  const cells = Array.from(root.querySelectorAll("td, th"));

  for (const cell of cells) {
    const text = (cell.innerText || "").trim();
    if (!text) continue;

    // Clear previous SSP Util highlight (idempotent)
    if (cell.dataset.ssp2Hl === "1") {
      cell.style.removeProperty("color");
      cell.style.removeProperty("font-weight");
      delete cell.dataset.ssp2Hl;
    }

    // First keyword match wins
    for (const rule of rules) {
      const keyword = String(rule?.keyword || "").trim();
      const color = String(rule?.color || "").trim();
      if (!keyword || !color) continue;

      if (text.toLowerCase().includes(keyword.toLowerCase())) {
        cell.dataset.ssp2Hl = "1";
        cell.style.setProperty("color", color, "important");
        cell.style.setProperty("font-weight", "900", "important");
        break;
      }
    }
  }
}




/* =====================================================
     FETCHDATA (hardened)
  ====================================================== */
  async function postFetch(endpoint, payload, label, opts={}) {
    log(`${label} fetchdata`, payload);// --- Lightweight in-memory cache (prevents duplicate notArrived calls between Action Panel + Merge Panel)
// Keyed by entity + loadGroupId + planId + status. TTL default 30s (safe for rapid UI interactions).
try {
  STATE._fetchCache = STATE._fetchCache || {};
  if (payload && payload.entity === 'getContainerDetailsForLoadGroupId') {
    const st = String(payload.status || '');
    const lg = String(payload.loadGroupId || '');
    const pid = String(payload.planId || '');
    const key = `GCD:${st}:${lg}:${pid}`;
    const now = Date.now();
    const ttl = Number(opts.cacheTtlMs || 30000);
    const hit = STATE._fetchCache[key];
    if (hit && hit.ts && (now - hit.ts) < ttl && hit.data) return hit.data;
  }
} catch (_) {}


    // Guard: never call fetchdata with empty nodeId; SSP returns ok=false ("account name should not be null or empty").
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'nodeId') && !payload.nodeId) {
      setLastError(`${label}: missing nodeId`, new Error('nodeId is empty'), { endpoint, payload });
      return null;
    }
    const t0 = performance.now();
    const area = endpoint.includes("/ib/") ? "ib" : (endpoint.includes("/ob/") ? "ob" : "na");
    const entity = (payload && payload.entity) ? String(payload.entity) : "(unknown)";
    const res = await sspFetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload),

    }, (opts.priority===undefined?1:opts.priority));

    // Harden: sspFetch may return non-Fetch shapes in some environments; don't assume Response.status/text.
    const status =
      (res && typeof res.status === "number") ? res.status :
      (res && typeof res.httpStatus === "number") ? res.httpStatus :
      (res && res.xhr && typeof res.xhr.status === "number") ? res.xhr.status :
      0;

    const text = (res && typeof res.text === "function") ? await res.text() : "";
    let data;

    try {
      data = JSON.parse(text);
    } catch (e) {
      setLastError(`${label}: Non-JSON response`, e, {
        endpoint,
        payload,
        status,
        snippet: String(text || "").slice(0, 500),
      });
      try {
        const ev = {
          ts: Date.now(),
          runId: window.__SSP_DIAG.runId,
          area,
          entity,
          ms: Math.round(performance.now() - t0),
          status,
          ok: false,
          payload: SETTINGS.diagCapturePayload ? __diagSafePayload(payload) : { keys: Object.keys(payload || {}) },
          note: "non-json",
        };
        window.__SSP_DIAG.lastError = ev;
        __diagPush(ev);
      } catch (_) {}
      return null;
    }


    // v1.5.17: capture fetchdata payload/response for troubleshooting (no wrappers)
    try {
      const DBG = (window.__SSP_DEBUG = window.__SSP_DEBUG || {});
      const ent = payload && payload.entity;
      const st  = payload && String(payload.status || "");
      if (ent === "getContainerDetailsForLoadGroupId" && st === "inFacility") DBG.CU_OB = { ts: Date.now(), endpoint, label, payload, resp: data };
      else if (ent === "getContainerDetailsForLoadGroupId" && st === "notArrived") DBG.IB_NOTARRIVED = { ts: Date.now(), endpoint, label, payload, resp: data };
      else if (ent === "getEligibleContainerCountsForLoads") DBG.ELIG_COUNTS = { ts: Date.now(), endpoint, label, payload, resp: data };
    } catch (_) {}

    if (data?.ok === false) {
      setLastError(`${label}: ok=false`, new Error(data?.message || "ok=false"), {
        endpoint,
        payload,
        status,
        preview: safePreview(data),
      });
      try {
        const ev = {
          ts: Date.now(),
          runId: window.__SSP_DIAG.runId,
          area,
          entity,
          ms: Math.round(performance.now() - t0),
          status,
          ok: false,
          payload: SETTINGS.diagCapturePayload ? __diagSafePayload(payload) : { keys: Object.keys(payload || {}) },
          note: "ok-false",
        };
        window.__SSP_DIAG.lastError = ev;
        __diagPush(ev);
      } catch (_) {}
    }

    // v1.5.17: capture raw fetchdata payload/response for troubleshooting (no wrappers)
    try {
      if (payload && payload.entity === 'getContainerDetailsForLoadGroupId') {
        const st = String(payload.status || '');
        if (st === 'inFacility') __sspRecordPull('CU_OB', payload, data, { via: label, endpoint });
        else if (st === 'notArrived') __sspRecordPull('IB_NOTARRIVED', payload, data, { via: label, endpoint });
      }
    } catch (_) {}


    // Diagnostics: record successful entity calls (and ok=false already captured above)
    try {
      if (data?.ok !== false) {
        __diagPush({
          ts: Date.now(),
          runId: window.__SSP_DIAG.runId,
          area,
          entity,
          ms: Math.round(performance.now() - t0),
          status,
          ok: true,
          payload: SETTINGS.diagCapturePayload ? __diagSafePayload(payload) : { keys: Object.keys(payload || {}) },
          note: "ok",
        });
      }
    } catch (_) {}

// --- Cache store for getContainerDetailsForLoadGroupId
try {
  if (payload && payload.entity === 'getContainerDetailsForLoadGroupId') {
    const st = String(payload.status || '');
    const lg = String(payload.loadGroupId || '');
    const pid = String(payload.planId || '');
    const key = `GCD:${st}:${lg}:${pid}`;
    STATE._fetchCache = STATE._fetchCache || {};
    const cur = STATE._fetchCache[key] || {};
    STATE._fetchCache[key] = { ts: Date.now(), data, inflight: null };
  }
} catch (_) {}

return data;
  }

  function getAaData(resp, label) {
    const aa = resp?.ret?.aaData;
    if (Array.isArray(aa)) return aa;
    setLastError(`${label}: Missing ret.aaData`, new Error("ret.aaData is undefined"), {
      preview: safePreview(resp),
    });
    return [];
  }

/* =====================================================
   INBOUND (single superset pull + eligibility filter)
====================================================== */

  async function ensureInboundReady(force=false) {
    try {
      if (!force) {
        const hasMap = (STATE.ibByPlanId && typeof STATE.ibByPlanId.get === "function");
        const hasLoads = Array.isArray(STATE.inboundLoadsAll) && STATE.inboundLoadsAll.length;
        if (hasMap && hasLoads) return true;
      }
      if (STATE._ibLoading) return await STATE._ibLoading;
      STATE._ibLoading = (async () => {
        try { await loadInbound(); } catch (_) {}
        return true;
      })();
      return await STATE._ibLoading;
    } finally {
      if (STATE._ibLoading && STATE.ibByPlanId && typeof STATE.ibByPlanId.get === "function") {
        // allow future forced refreshes, but avoid re-fetch loops
        STATE._ibLoading = null;
      }
    }
  }

async function loadInbound() {
  const { startMs, endMs } = getOpsWindow(Date.now());     // endMs should be your 07:00 cut
  const ibLookbackMs = 3 * 60 * 60 * 1000;
  const ibStart = startMs - ibLookbackMs;
  const ibEnd = endMs;                                    // treat as 07:00 cutoff anchor

  // Refresh inbound route averages (daily) in background
  try { refreshInboundRouteAverages({ force:false }); } catch (_) {}


  // Single generalized pull
  const resp = await postFetch(
    "/ssp/dock/hrz/ib/fetchdata?",
    {
      entity: "getInboundDockView",
      nodeId: STATE.nodeId,
      startDate: ibStart,
      endDate: ibEnd,
      loadCategories: "inboundScheduled,inboundArrived,inboundCompleted",
      shippingPurposeType: "TRANSSHIPMENT,NON-TRANSSHIPMENT,SHIP_WITH_AMAZON",
    },
    "IB",
    { priority: 2 }
  );

  const aa = getAaData(resp, "IB getInboundDockView (superset)");

  // --- helpers ---
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

  // "14-Jan-26 04:09" -> epoch ms (local) or null
  function parseInboundTs(s) {
    if (!s || typeof s !== "string") return null;
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;

    const dd = Number(m[1]);
    const mon = MONTHS[m[2].toLowerCase()];
    const yy = Number(m[3]);
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    if (!Number.isFinite(dd) || mon == null || !Number.isFinite(yy) || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;

    return new Date(2000 + yy, mon, dd, hh, mm, 0, 0).getTime();
  }

  function normStatus(l) {
    return String(l?.status || "").trim().toUpperCase();
  }

  // Based on your screenshots: READY_FOR_UNLOAD, UNLOADING_IN_PROGRESS, COMPLETED
  const PRESENT_STATUSES = new Set(["READY_FOR_UNLOAD", "UNLOADING_IN_PROGRESS", "COMPLETED"]);

  function isPresentInFacility(l) {
    const st = normStatus(l);
    if (PRESENT_STATUSES.has(st)) return true;

    // Defensive: if actualArrivalTime exists, treat as present even if status is weird
    return !!l?.actualArrivalTime && parseInboundTs(l.actualArrivalTime) != null;
  }

  function isEligibleInbound(l) {
    // Always include if physically present
    if (isPresentInFacility(l)) return true;

    // Otherwise scheduled-only must respect the 07:00 cutoff
    // (If it isn't present, and it is scheduled after ibEnd, it MUST NOT appear.)
    const st = normStatus(l);
    if (st !== "SCHEDULED") return false;

    const schedMs = parseInboundTs(l?.scheduledArrivalTime);
    return schedMs != null && schedMs <= ibEnd;
  }

  function deriveIbLocation(resources) {
    try {
      const arr = Array.isArray(resources) ? resources : (resources ? [resources] : []);
      if (!arr.length) return '';

      const norm = (s) => String(s || '').trim();
      // Prefer dock door, then parking slip/spot, then yard.
      const door = arr.find(r => String(r?.resType || '').toUpperCase().includes('DOCK'));
      if (door) return `DOOR ${norm(door.label || door.resLabel || door.dockDoor || door.resId || '')}`.trim();

      const park = arr.find(r => {
        const t = String(r?.resType || '').toUpperCase();
        return t.includes('PARK') || t.includes('SLIP');
      });
      if (park) return `PARK ${norm(park.label || park.resLabel || park.parkingSlip || park.parkingSpot || park.resId || '')}`.trim();

      const yard = arr.find(r => String(r?.resType || '').toUpperCase().includes('YARD'));
      if (yard) return `YARD ${norm(yard.label || yard.resLabel || yard.resId || '')}`.trim();

      return '';
    } catch {
      return '';
    }
  }

  // Build + filter (CART + CYC)
  const loads = aa
    .map(e => {
      const l = e?.load;
      if (!l) return null;
      const resources = e?.resource || e?.resources || l?.resource || l?.resources || null;
      if (resources && !l._resources) l._resources = resources;
      if (!l._sspLocation) l._sspLocation = deriveIbLocation(resources);
      return l;
    })
    .filter(Boolean)
    .filter(l => { const r=String(l?.route||"" ); return r.includes("CART") || r.includes("CYC"); })
    .filter(isEligibleInbound);

  // De-dupe (prefer planId as primary key)
  const seen = new Set();
  const deduped = [];
  for (const l of loads) {
    const k = l.planId || l.vrId || JSON.stringify([l.route, l.scheduledArrivalTime, l.order]);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(l);
  }

  STATE.inboundLoadsAll = deduped;
    STATE.inboundLoads = deduped;


      // Planning: also fetch inboundContainerCount in one bulk call (cached) for accurate Cntrs Left / Pkgs hover
      try {
        const __planIds = (STATE.inboundLoads || []).map(l => String(l?.planId || "").trim()).filter(Boolean);
        if (__planIds.length) ensurePlanningInboundContainerCount(__planIds);
      } catch (e) {}
STATE.ibByPlanId = buildIbByPlanId(STATE.inboundLoadsAll);
  STATE.inboundLoadsAll = deduped;

  // Display/shift-planning window count: last 3h → ops cutoff (07:00) plus anything physically present.
  const nowMs = Date.now();
  const windowStartMs = nowMs - ibLookbackMs;
  STATE.inboundLoadsWindow = deduped.filter(l => {
    // Window count should mirror the operational planning horizon:
    // only loads whose (actualArrivalTime OR scheduledArrivalTime) falls within
    // [now - lookback, ibEnd]. Do NOT auto-include "present in facility" outside the window.
    const windowStartMs = nowMs - ibLookbackMs;
    const schedMs = parseInboundTs(l?.scheduledArrivalTime);
    const actualMs = parseInboundTs(l?.actualArrivalTime);
    const t = (actualMs != null) ? actualMs : schedMs;
    if (t == null) return false;
    if (normStatus(l) === 'COMPLETED') return false;
    return t >= windowStartMs && t <= ibEnd;
  });

  log("Inbound eligible CART loads (cached):", STATE.inboundLoads.length, " | window:", STATE.inboundLoadsWindow.length);
// Optional: store planId set for container pulls so Merge Panel can't be polluted
  STATE.inboundPlanIds = new Set(STATE.inboundLoads.map(l => String(l.planId)).filter(Boolean));
}
    async function loadIB4CPT() {
    const planIds = STATE.inboundLoads.map(l => l?.planId).filter(Boolean);

// Pull per-inbound-load eligible container counts (used for Merge Panel inbound VRID list).
// This returns a map of inboundLoadId(planId) -> eligible container count.
try {
  const rElig = await postFetch(
    "/ssp/dock/hrz/ib/fetchdata?",
    {
      entity: "getEligibleContainerCountsForLoads",
      nodeId: STATE.nodeId,
      loadIds: planIds.join(","),
    }, "IB", {priority:2}
  );
  const eligMap = rElig?.ret?.eligibleContainerCountMap || {};
  STATE.inboundEligibleMap = eligMap && typeof eligMap === "object" ? eligMap : {};
} catch (e) {
  STATE.inboundEligibleMap = {};
}


    if (!planIds.length) {
      log("IB4CPT skipped: no inbound planIds");
      STATE.ib4cpt = {};
      STATE.ib4cptGroups = [];
      return;
    }

    const r = await postFetch(
      "/ssp/dock/hrz/ib/fetchdata?",
      {
        entity: "getCDTBasedContainerCount",
        nodeId: STATE.nodeId,
        inboundLoadIds: planIds.join(","),
      }, "IB", {priority:2}
    );

    const cdt = r?.ret?.inboundCDTContainerCount;
    if (!cdt || typeof cdt !== "object") {
      setLastError("IB getCDTBasedContainerCount: Missing inboundCDTContainerCount", new Error("inboundCDTContainerCount missing"), {
        preview: safePreview(r),
      });
      STATE.ib4cpt = {};
      STATE.ib4cptGroups = [];
      return;
    }

    STATE.ib4cpt = cdt;
    STATE.ib4cptGroups = extractIb4Groups(cdt);

    // Phase 2: compute lane/CPT unit totals from IB4CPT (same basis as merge logic)
    STATE.ibLaneCptUnits = buildIbLaneCptUnits(cdt);

    // Lane+CPT -> loadGroupIds mapping (for merge panel inbound attribution)
    STATE.ibLaneCptLoadGroups = buildIbLaneCptLoadGroups(cdt);
    STATE.ibLaneCptStats = buildIbLaneCptStats(cdt);

    log("IB4CPT groups:", STATE.ib4cptGroups.length);
}

  /* =====================================================
     OUTBOUND
  ====================================================== */
  async function loadOutbound() {
    const { startMs, endMs } = getOpsWindow(Date.now());
    const obLookbackMs = 3 * 60 * 60 * 1000;
    const obStart = startMs - obLookbackMs;
    const obEnd = endMs;

    const r = await postFetch(
      "/ssp/dock/hrz/ob/fetchdata?",
      {
        entity: "getOutboundDockView",
        nodeId: STATE.nodeId,
        startDate: obStart,
        endDate: obEnd,
        loadCategories: "outboundScheduled,outboundInProgress,outboundReadyToDepart,outboundDeparted,outboundCancelled",
        shippingPurposeType: "TRANSSHIPMENT,NON-TRANSSHIPMENT,SHIP_WITH_AMAZON",
      },
      "OB", {priority:2}
    );

    const aa = getAaData(r, "OB getOutboundDockView");
    const obAll = aa
      .map(e => {
        const load = e?.load || {};
        const trailer = e?.trailer || {};
        const resources = e?.resource || e?.resources || [];
        const doorRes = Array.isArray(resources)
          ? resources.find(r => String(r?.resType || "").toUpperCase().includes("DOCK_DOOR"))
          : null;

        return {
  ...load,
  trailerId: trailer?.trailerId || trailer?.trailerID || load?.trailerId || load?.trailerID || "",
  trailerNumber: trailer?.trailerNumber || trailer?.trailerNumber || load?.trailerNumber || "",
  dockDoor: doorRes?.label || "",
  dockResType: doorRes?.resType || "",
  dockTdrStatus: doorRes?.tdrStatus || "",

  // Barcode source of truth: resId from getOutboundDockView -> resource.resId
  dockResId:
    doorRes?.resId ||
    doorRes?.resID ||
    (Array.isArray(resources) ? (resources[0]?.resId || resources[0]?.resID || "") : ""),
};

      })
      .filter(e => e && e.vrId);

    STATE.outboundLoadsAll = obAll;
    STATE.outboundLoads = obAll.filter(l => !isObFinalStatus(l?.loadStatus ?? l?.status ?? ""));

    log("Outbound loads:", STATE.outboundLoads.length, "(active)", "| total:", STATE.outboundLoadsAll.length);
      // Fast lookup for barcode button: VRID -> resourceId (resId)
STATE.vridToResId = new Map(
  (STATE.outboundLoads || []).map(x => [obVrid(x), String(x.dockResId || "")])
);

  }


// Helpers to read outbound fields robustly (field names vary by view/env)
function obPlanId(l){
  return String(l?.planId || l?.planID || l?.plan_id || l?.planIdentifier || '').trim();
}
function obLoadGroupId(l){
  return String(l?.loadGroupId || l?.loadGroupID || l?.load_group_id || '').trim();
}
function obVrid(l){
  return String(l?.vrId || l?.vrID || l?.vrid || '').trim();
}
function obRoute(l){
  return String(l?.route || l?.lane || l?.routeName || '').trim();
}

// Resolve an OB anchor (planId+vrId) for a given outbound loadGroupId.
// IMPORTANT: getContainerDetailsForLoadGroupId requires a planId that belongs to the SAME outbound loadGroupId.
function resolveObAnchorForLg(loadGroupId, laneTxt) {
  const lg = String(loadGroupId || '').trim();
  if (!lg) return null;
  const wantLane = String(laneTxt || '').trim();

  const candidates = (STATE.outboundLoadsAll || []).filter(l => {
    if (!l) return false;
    const lLg = obLoadGroupId(l);
    if (lLg !== lg) return false;
    const st = String(l.loadStatus ?? l.status ?? '').trim();
    if (isObFinalStatus(st)) return false;
    const pid = obPlanId(l);
    const vr = obVrid(l);
    if (!pid || !vr) return false;
    if (wantLane) {
      const r = obRoute(l);
      if (r && r !== wantLane) return false;
    }
    return true;
  });

  if (!candidates.length) return null;

  // Prefer last load for CPT if flagged; otherwise prefer latest cutoff/CPT time.
  let best = null;
  let bestScore = -1;
  for (const l of candidates) {
    const isLast = !!l.lastLoadForCptFlag;
    const t = toMs(l.processingCutOffTime || l.criticalPullTime || l.order || l.scheduledDepartureTime) || 0;
    const score = (isLast ? 10**13 : 0) + t;
    if (!best || score > bestScore) {
      best = l;
      bestScore = score;
    }
  }

  return best ? { planId: obPlanId(best), vrId: obVrid(best), vrid: obVrid(best) } : null;
}


/** Extract VRID text from a dock-view table row. */
function getVridFromRow(row) {
  if (!row) return null;

  // 1) Prefer obvious link text (most stable when the VRID is a clickable anchor)
  const a = row.querySelector('a[href*="vrid"], a[href*="VRID"], a[href*="routeId"], a[href*="executionId"], a[href*="loadId"], a[href*="shipmentId"]');
  if (a) {
    const t = (a.textContent || "").trim();
    if (t) return t;

    const href = a.getAttribute("href") || "";
    const m = href.match(/(?:vrid|routeId|executionId|loadId|shipmentId)=([^&#]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }

  // 2) Fallback: scan cell text for an ID-looking token
  const tds = row.querySelectorAll("td");
  for (const td of tds) {
    const txt = (td.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt) continue;

    // Common formats: "VRID12345", "ABCD123456", or "1234567890" (avoid tiny numerics)
    const token = txt.split(" ")[0];
    if (/^[A-Za-z0-9]{5,}$/.test(token) && !/^\d{1,4}$/.test(token)) {
      return token;
    }
  }

  return null;
}

// Backward-compat for any DOM onclick attributes from earlier builds
try { if (typeof window !== "undefined") window.GetVridFromRow = getVridFromRow; } catch (e) {}

async function prefetchDriverIdsForVisibleVrids() {
  // FMC endpoints are not CORS-accessible from amazonlogistics.com; only run on trans-logistics.
  if (!String(location.hostname||"").includes("trans-logistics.amazon.com")) return;
  const rows = document.querySelectorAll("table tbody tr");
  const vrids = [];
  rows.forEach(r => {
    const v = getVridFromRow(r);
    if (v) vrids.push(String(v));
  });

  // Only fetch for VRIDs we don't already know
  const unknown = vrids.filter(v => !STATE.driverIdByVrid.has(v));
  if (!unknown.length) return;

  try {
    const json = await fetchFmcExecutionMetaByIds(unknown);
    hydrateDriverMapsFromFmcSearch(json);
  } catch (e) {
    console.error("prefetchDriverIdsForVisibleVrids failed", e);
  }
}


// Debounced/cooldown driver prefetch scheduler.
// IMPORTANT: Do NOT run prefetch on every network request; SSP does many fetches and this can spam by-id.
let __ssp2_driverPrefetchTimer = null;
let __ssp2_lastDriverPrefetchAt = 0;
function scheduleDriverPrefetch(reason = "") {
  const now = Date.now();
  const MIN_INTERVAL_MS = 15000; // keep FMC by-id traffic reasonable
  const DEBOUNCE_MS = 750;

  // Always allow the first run; thereafter enforce cooldown.
  if (__ssp2_lastDriverPrefetchAt && (now - __ssp2_lastDriverPrefetchAt) < MIN_INTERVAL_MS) return;

  if (__ssp2_driverPrefetchTimer) return;
  __ssp2_driverPrefetchTimer = setTimeout(async () => {
    __ssp2_driverPrefetchTimer = null;
    __ssp2_lastDriverPrefetchAt = Date.now();
    try { await prefetchDriverIdsForVisibleVrids(); } catch (e) {}
  }, DEBOUNCE_MS);
}

/* =====================================================
     EQUIPMENT MAPPING + UTILIZATION
  ====================================================== */

  // Canonical equipmentType enums observed in SSP payloads (HAR-verified).
  // Keep this mapping small and explicit; avoid lane-string inference.
  const EQUIPMENT_MAP = {
    FIFTY_THREE_FOOT_TRUCK: { key: "FIFTY_THREE_FOOT_TRUCK", short: "53", label: "53'", capSettingKey: "cap53ftCarts" },
    FIFTY_THREE_FOOT_CONTAINER: { key: "FIFTY_THREE_FOOT_CONTAINER", short: "53", label: "53'", capSettingKey: "cap53ftCarts" },
    TWENTY_SIX_FOOT_BOX_TRUCK: { key: "TWENTY_SIX_FOOT_BOX_TRUCK", short: "26", label: "26'", capSettingKey: "cap26ftCarts" },
    // Optional; not present in the provided HARs but commonly referenced.
    CUBE_TRUCK: { key: "CUBE_TRUCK", short: "CUBE", label: "Cube", capSettingKey: "capCubeCarts" },
  };

  function normalizeEquipmentType(equipmentTypeRaw) {
    const raw = String(equipmentTypeRaw || "").trim();
    if (!raw) return null;
    const u = raw.toUpperCase();
    __sspTrackEquip(u);

    if (EQUIPMENT_MAP[u]) {
      __sspMarkUsed(`equip:exact:${u}`);
      return { ...EQUIPMENT_MAP[u] };
    }

    // Minimal fallback (avoid regex jungles)
    if (u.includes("FIFTY") && u.includes("THREE")) {
      __sspMarkUsed("equip:fallback:53");
      return { ...EQUIPMENT_MAP.FIFTY_THREE_FOOT_TRUCK, key: u };
    }
    if (u.includes("TWENTY") && u.includes("SIX")) {
      __sspMarkUsed("equip:fallback:26");
      return { ...EQUIPMENT_MAP.TWENTY_SIX_FOOT_BOX_TRUCK, key: u };
    }

    // Numeric/abbrev fallbacks (common in SSP/Trans-Logistics payloads)
    // Examples: "53_FT", "53FT", "AMZL_53_FT_TRAILER", "TWENTY_SIX_FT", "26_FT_BOX_TRUCK"
    if (/(^|[^0-9])53([^0-9]|$)/.test(u) || u.includes("53FT") || u.includes("53_FT") || u.includes("53-FT") || u.includes("FIFTYTHREE") || u.includes("FIFTY_THREE")) {
      __sspMarkUsed("equip:fallback:53num");
      return { ...EQUIPMENT_MAP.FIFTY_THREE_FOOT_TRUCK, key: u };
    }
    if (/(^|[^0-9])26([^0-9]|$)/.test(u) || u.includes("26FT") || u.includes("26_FT") || u.includes("26-FT") || u.includes("TWENTYSIX") || u.includes("TWENTY_SIX")) {
      __sspMarkUsed("equip:fallback:26num");
      return { ...EQUIPMENT_MAP.TWENTY_SIX_FOOT_BOX_TRUCK, key: u };
    }
    if (u.includes("CUBE")) {
      __sspMarkUsed("equip:fallback:cube");
      return { ...EQUIPMENT_MAP.CUBE_TRUCK, key: u };
    }

    // Heuristic fallbacks (names vary across UIs)
    if (u.includes("BOX_TRUCK") || (u.includes("BOX") && !u.includes("TRAILER"))) {
      __sspMarkUsed("equip:fallback:box");
      return { ...EQUIPMENT_MAP.TWENTY_SIX_FOOT_BOX_TRUCK, key: u };
    }
    if (u.includes("TRAILER") || u.includes("DRYVAN") || u.includes("DRY_VAN") || u.includes("SEMI")) {
      __sspMarkUsed("equip:fallback:trailer");
      return { ...EQUIPMENT_MAP.FIFTY_THREE_FOOT_TRUCK, key: u };
    }

    __sspMarkUsed("equip:unknown");
    return { key: u, short: "UNK", label: u, capSettingKey: null };
  }

  function mapEquipCapacity(equipmentTypeRaw) {
    const e = normalizeEquipmentType(equipmentTypeRaw);
    if (!e) {
      return { equip: "UNKNOWN", cap: Number(SETTINGS.cap53ftCarts) || 36 };
    }

    // Capacity source of truth remains SETTINGS (so you can tune without code changes)
    const capKey = e.capSettingKey;
    let cap = null;
    if (capKey && Object.prototype.hasOwnProperty.call(SETTINGS, capKey)) {
      cap = Number(SETTINGS[capKey]);
    }

    // Hard defaults only if setting missing/invalid
    if (!Number.isFinite(cap) || cap <= 0) {
      if (e.short === "26") cap = 18;
      else if (e.short === "CUBE") cap = 10;
      else cap = 36; // 53'
    }

    return { equip: e.key, cap };
  }

  function computeCPTUtilization() {
    const map = {};
    // Index loads by VRID for quick per-row lookup (capacity/equipment/CPT/lane)
    STATE.vridIndex = {};

    STATE.mergeStats = { load: 0, soon: 0, now: 0, risk: 0, adhoc: 0, cancel: 0, ok: 0 };

    const mode = normalizeObLoadType(SETTINGS.obLoadType || "all");
    const rawOutbound = Array.isArray(STATE.outboundLoads) ? STATE.outboundLoads : [];
    const filteredOutbound = getFilteredOutboundLoadsForMode(mode, {
      loads: rawOutbound,
      debugKey: "merge-group-building",
    });

    // OB: remaining loads per CPT, capacity per equipment
    for (const load of filteredOutbound) {
      const cptMs = toMs(load?.criticalPullTime);
      if (!cptMs) continue;

      const equipRaw = (load?.equipmentType || load?.trailerEquipment?.trailer?.equipmentType || load?.trailer?.equipmentType || load?.vehicle?.equipmentType || "");
      const { equip, cap } = mapEquipCapacity(equipRaw);

      const laneDbg = String(load?.lane || load?.route || "").trim();
      const vridDbg = String(load?.vrId || load?.vrid || "").trim();

      if (vridDbg) {
        STATE.vridIndex[vridDbg] = {
          vrid: vridDbg,
          lane: laneDbg,
          cptMs,
          sdtMs: parseSspDateTime(load?.scheduledDepartureTime || load?.scheduleDepartureTime || load?.scheduledDepartTime || load?.scheduleDepartTime || load?.departureTime || ""),
          equip,
          capacity: cap,
          status: String((load?.loadStatus ?? load?.status ?? "")),
          location: String(load?.location || ""),
          // Identifiers used by getOutboundLoadContainerDetails (when present)
          loadGroupId: load?.loadGroupId || load?.loadGroupID || load?.groupId || load?.groupID || "",
          planId: load?.planId || load?.planID || "",
          trailerId: load?.trailerId || load?.trailerID || load?.trailer?.trailerId || load?.trailer?.id || "",
          trailerNumber: load?.trailerNumber || load?.trailer?.trailerNumber || "",
          dockDoor: String(load?.dockDoor || ""),
          dockTdrStatus: String(load?.dockTdrStatus || ""),
        };
      }

      if (DEBUG.loadLoop) {
        dlog("OB_LOAD", {
          lane: laneDbg || "—",
          vrid: vridDbg || "—",
          cpt: fmtTime(cptMs),
          equipRaw,
          equip,
          cap,
          status: String((load?.loadStatus ?? load?.status ?? "")),
        });
      }

      if (!map[cptMs]) {
        map[cptMs] = {
          cptMs,
          equip,
          capacity: cap,
          inboundCarts: 0,
          totalCarts: 0,
          inFacilityCarts: 0,
          loadedCarts: 0,
          upstreamCarts: 0,
          remainingLoads: 0,
          requiredPerLoad: 0,
          utilization: 0,
          mergeState: "ok",
          lanes: new Set(),
          vrids: new Set(),
        };
      }

      // Keep the highest-capacity equipment for this CPT (prevents one 26' row from downgrading the whole CPT).
      if (cap > (map[cptMs].capacity || 0)) {
        map[cptMs].capacity = cap;
        map[cptMs].equip = equip;
      }

      // Capture context for debugging + UI (lane/VRID samples per CPT)
      try {
        const lane = String(load?.lane || load?.route || "").trim();
        const vrid = String(load?.vrId || load?.vrid || "").trim();
        if (lane) map[cptMs].lanes?.add(lane);
        if (vrid) map[cptMs].vrids?.add(vrid);
      } catch (_) {}

      const status = String((load?.loadStatus ?? load?.status ?? "")).toUpperCase();
      if (status !== "DEPARTED") map[cptMs].remainingLoads++;
    }

    // IB4CPT: counts only (no container list by design)
    // Include only inbound loads expected by/before CPT for the lane+CPT group.
    Object.entries(STATE.ib4cpt || {}).forEach(([inboundLoadId, groups]) => {
      if (!Array.isArray(groups)) return;

      const ibLoad = (STATE.ibByPlanId && typeof STATE.ibByPlanId.get === "function")
        ? STATE.ibByPlanId.get(String(inboundLoadId || "").trim())
        : null;
      const ibExpectedMs = ibLoad
        ? (
            parseSspDateTime(ibLoad?.scheduledArrivalTime) ||
            parseSspDateTime(ibLoad?.estimatedArrivalTime) ||
            parseSspDateTime(ibLoad?.actualArrivalTime) ||
            0
          )
        : 0;

      groups.forEach(g => {
        const cptMs = toMs(g?.criticalPullTime);
        if (!cptMs) return;
        if (ibExpectedMs && ibExpectedMs > cptMs) return;

        if (!map[cptMs]) {
          // if IB has CPT not present in OB yet, still track it with 53' default capacity
          map[cptMs] = {
            cptMs,
            equip: "UNKNOWN",
            capacity: Number(SETTINGS.cap53ftCarts) || 36,
            inboundCarts: 0,
          totalCarts: 0,
          inFacilityCarts: 0,
          loadedCarts: 0,
          upstreamCarts: 0,
          remainingLoads: 0,
            requiredPerLoad: 0,
            utilization: 0,
            mergeState: "ok",
          };
        }

        const totalC = Number(g?.loadGroupCountStruct?.totalCount?.C || 0);
        const unloadedC = Number(g?.loadGroupCountStruct?.unLoadedCount?.C || 0);
        if (totalC) {
          const upstream = Math.max(0, totalC - unloadedC);
          map[cptMs].inboundCarts += totalC;
          map[cptMs].totalCarts += totalC;
          map[cptMs].inFacilityCarts += unloadedC;
          map[cptMs].upstreamCarts += upstream;
        }
      });
    });

    
// Sum loaded units per CPT from OB VRID loaded-unit cache (getOutboundLoadContainerDetails)
try {
  Object.keys(map).forEach(k => {
    const cptMs = Number(k);
    const cpt = map[cptMs];
    if (!cpt) return;
    let loaded = 0;
    const vrids = cpt.vrids && cpt.vrids.size ? Array.from(cpt.vrids) : [];
    for (const vrid of vrids) {
      const vinfo = STATE.vridIndex?.[vrid] || null;
      const status = String(vinfo?.status || "").toUpperCase();
      const sdtMs = Number(vinfo?.sdtMs || 0);
      if (status.includes("DEPART")) continue;
      if (sdtMs && Date.now() > sdtMs) continue;
      loaded += Number((STATE.vridLoadedUnits && STATE.vridLoadedUnits[vrid]) || 0);
    }
    cpt.loadedCarts = loaded;
  });
} catch (_) {}

// classify (lane-level capacity states)
// Model:
// - facility (inFacilityCarts): loaded + current + ready/yard/unloading
// - upstream (upstreamCarts): in-transit/scheduled
// - total capacity = remainingLoads * capacityPerLoad (capacity is carts per trailer)
// - projected fullness = (facility + w*upstream) / capTotal
const hardWarn = Number(SETTINGS.capHardWarnPct ?? 0.90);
const soonPct  = Number(SETTINGS.capMergeSoonPct ?? 0.85);
const nowPct   = Number(SETTINGS.capMergeNowPct ?? 1.00);
const riskPct  = Number(SETTINGS.capRiskPct ?? 1.00);

const baseWRaw = Number(SETTINGS.mergeInboundWeight);
const baseW = Number.isFinite(baseWRaw) ? Math.max(0, Math.min(baseWRaw, 0.50)) : 0.35;

const adhocOver = Math.max(0, Number(SETTINGS.adhocOverageUnits ?? 8));
const cancelLeadMin = Math.max(0, Number(SETTINGS.cancelLeadMinutes ?? 120));
const cancelHorizonMin = Math.max(0, Number(SETTINGS.cancelShowHorizonMinutes ?? 360));
const cancelMinObserved = Math.max(0, Number(SETTINGS.cancelMinObservedUnits ?? 6));

// reset merge/capacity rollups
STATE.mergeStats = { load: 0, soon: 0, now: 0, risk: 0, adhoc: 0, cancel: 0, ok: 0 };
STATE.mergeDetail = [];


// === Compute loaded units per CPT from VRID-level loaded units ===
// Lane card "Loaded" already comes from STATE.vridLoadedUnits; the capacity-state math must use the same source,
// otherwise CANCEL/MERGE decisions will be wrong.
for (const cpt of Object.values(map)) {
  try {
    let sumLoaded = 0;
    const vs = cpt?.vrids ? Array.from(cpt.vrids) : [];
    for (const vrid of vs) {
      const vinfo = STATE.vridIndex?.[vrid] || null;
      const status = String(vinfo?.status || "").toUpperCase();
      const sdtMs = Number(vinfo?.sdtMs || 0);
      if (status.includes("DEPART")) continue;
      if (sdtMs && Date.now() > sdtMs) continue;
      const n = Number(STATE.vridLoadedUnits?.[vrid] || 0);
      if (Number.isFinite(n)) sumLoaded += n;
    }
    cpt.loadedCarts = sumLoaded;
  } catch (_) {
    cpt.loadedCarts = Number(cpt.loadedCarts || 0);
  }
}

Object.values(map).forEach(cpt => {
  const loads = Math.max(1, Number(cpt.remainingLoads || 0));
  const capPer = Math.max(1, Number(cpt.capacity || 0)); // carts per trailer
  const capTotal = loads * capPer;

  const loaded = Number(cpt.loadedCarts || 0);
  const facility = loaded + Number(cpt.inFacilityCarts || 0);
  const upstream = Number(cpt.upstreamCarts || 0);

  const minsToCpt = Number.isFinite(Number(cpt.cptMs))
    ? Math.round((Number(cpt.cptMs) - Date.now()) / 60000)
    : NaN;

  // Time-to-CPT weighting: scheduled/in-transit inbound becomes more "real" as CPT approaches.
  let inboundW = baseW;
  if (Number.isFinite(minsToCpt)) {
    if (minsToCpt > 180) inboundW = Math.min(inboundW, 0.15);
    else if (minsToCpt > 90) inboundW = Math.min(inboundW, 0.25);
    else if (minsToCpt > 45) inboundW = Math.min(inboundW, baseW); // typically 0.35
    else inboundW = Math.max(inboundW, 0.50);
  }

  const projUnits = (facility + inboundW * upstream);
  const hardPct = capTotal ? (facility / capTotal) : 0;
  const projPct = capTotal ? (projUnits / capTotal) : 0;

  const overage = Math.max(0, projUnits - capTotal);

  // For cancellation: if projected volume fits in fewer loads and we're within a reasonable planning horizon,
  // recommend canceling extra loads (respect ops cancellation lead time) — but avoid early false positives when
  // data is sparse (e.g., upstream feeds not populated yet).
  const neededLoadsRaw = Math.ceil(projUnits / capPer);
  const neededLoads = (projUnits <= 0.01) ? 0 : Math.max(1, neededLoadsRaw);
  const cancelLoads = Math.max(0, loads - neededLoads);


  cpt.capTotal = capTotal;
  cpt.hardPct = hardPct;
  cpt.projPct = projPct;
  cpt.overage = overage;
  cpt.neededLoads = neededLoads;
  cpt.cancelLoads = cancelLoads;
  cpt.minsToCpt = minsToCpt;

  // State ladder:
  // CANCEL > ADHOC > RISK > MERGE NOW > MERGE SOON > LOAD
  let st = "load";

  if (cancelLoads > 0 && Number.isFinite(minsToCpt) && minsToCpt >= cancelLeadMin && minsToCpt <= cancelHorizonMin) {
    const observedUnits = facility + upstream;
    // Require some observed signal unless we are close to CPT.
    if (observedUnits >= cancelMinObserved || minsToCpt <= 90) st = "cancel";
  }

  // ADHOC trigger is overage-based; even if merge is possible, this calls attention early.
  if (overage >= adhocOver) {
    st = "adhoc";
  }

  // RISK if hard facility alone exceeds capacity (or projected is far beyond capacity).
  if (hardPct >= riskPct || projPct >= (riskPct + 0.10)) {
    st = "risk";
  }

  // MERGE NOW: facility is already tight AND projected crosses full capacity.
  if (hardPct >= hardWarn && projPct >= nowPct) {
    st = "now";
  } else if (projPct >= soonPct) {
    if (st === "load") st = "soon";
  }

  cpt.mergeState = st;

  STATE.mergeStats[cpt.mergeState] = (STATE.mergeStats[cpt.mergeState] || 0) + 1;

  const cptPayload = {
    cpt: fmtTime(cpt.cptMs),
    cptMs: cpt.cptMs,
    equip: cpt.equip,
    capacityPerLoad: capPer,
    loads,
    capTotal,
    loadedCarts: loaded,
    currentCarts: Number(cpt.inFacilityCarts || 0),
    inFacilityCarts: facility,
    upstreamCarts: upstream,
    inboundWeight: inboundW,
    hardPct: (hardPct * 100).toFixed(1) + "%",
    projPct: (projPct * 100).toFixed(1) + "%",
    overage: Number(overage.toFixed(1)),
    neededLoads,
    cancelLoads,
    minsToCpt,
    mergeState: st,
  };
  STATE.mergeDetail = STATE.mergeDetail || [];
  STATE.mergeDetail.push(cptPayload);

  // Optional: full dump for deep debugging (comment out if too noisy)
  if (DEBUG.enabled && DEBUG.cpt && DEBUG.laneGroupsFull) {
    dgroup(`[SSP UTIL][CPT_UTIL FULL] ${cptPayload.cpt}`, () => {
      console.log("payload:", cptPayload);
      console.log("lanes:", Array.from(cpt.lanes || []));
      console.log("vrids:", Array.from(cpt.vrids || []));
    });
  }
});

STATE.cptUtilization = map;
  }

  /* =====================================================
     OVERLAY
  ====================================================== */
  function removeOverlays() {
    document.querySelectorAll(".ssp2-overlay").forEach(el => el.remove());
    document.querySelectorAll(".ssp-row-actions").forEach(el => el.remove());
    document.querySelectorAll(".ssp2-locui").forEach(el => el.remove());
  }

  function findRowVrid(txt) {
    return txt.match(/\b[A-Z0-9]{8,20}\b/)?.[0] || null;
  }

  function getHeaderTextIndexMap(table) {
    // Build a logical column index map that accounts for colSpan
    const row =
      table.querySelector("thead tr:last-child") ||
      table.querySelector("thead tr");
    const cells = row ? Array.from(row.querySelectorAll("th, td")) : [];
    const out = [];
    let logical = 0;

    for (const cell of cells) {
      const txt = (cell.innerText || "").trim().toLowerCase().replace(/\s+/g, " ");
      const span = Math.max(1, Number(cell.colSpan || 1));
      for (let i = 0; i < span; i++) out.push({ logical, text: txt });
      logical += span;
    }
    return out;
  }

  function getColIndexByHeaderText(table, headerText) {
    const want = String(headerText || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!want) return -1;

    // Prefer colspan-aware mapping
    const map = getHeaderTextIndexMap(table);
    for (let i = 0; i < map.length; i++) {
      const got = map[i].text || "";
      if (!got) continue;

      // Exact match, substring match, or "normalized" match
      if (got === want) return i;
      if (got.includes(want) || want.includes(got)) return i;

      const gn = got.replace(/[^a-z0-9]+/g, "");
      const wn = want.replace(/[^a-z0-9]+/g, "");
      if (gn && wn && (gn === wn || gn.includes(wn) || wn.includes(gn))) return i;
    }

    // Fallback: legacy header scan
    const ths = Array.from(table.querySelectorAll("thead th, thead td"));
    for (let i = 0; i < ths.length; i++) {
      const got = (ths[i].innerText || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (got === want || got.includes(want)) return i;
    }
    return -1;
  }

  /* ======================================
   * Phone Icon Binding (independent of overlays)
   * ====================================== */

  function getBestDashboardTable() {
    // Fast path (historical selectors)
    let t = document.querySelector("table#dashboard") || document.querySelector("table.dataTable");
    if (t) return t;

    // Robust fallback: find any table whose header includes "VR Id"
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      try {
        if (getColIndexByHeaderText(table, "VR Id") >= 0) return table;
      } catch {}
    }
    return null;
  }

  function bindPhoneIconsOnDashboard() {
    const table = getBestDashboardTable();
    const tbody = table && table.querySelector("tbody");
    if (!table || !tbody) return;

    const vridIdx = getColIndexByHeaderText(table, "VR Id");
    if (vridIdx < 0) return;

    for (const row of Array.from(tbody.querySelectorAll("tr"))) {
      try {
        const txt = row.innerText || "";
        const vrid = findRowVrid(txt);
        if (!vrid) continue;

        const tds = Array.from(row.querySelectorAll("td"));
        if (tds[vridIdx]) injectPhoneIconIntoVridCell(tds[vridIdx], vrid);
      } catch {}
    }
  }

  function debounce(fn, waitMs) {
    let t = null;
    return function(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), waitMs);
    };
  }

  function ensurePhoneIconObserver() {
    if (window.__ssp2_phoneObsInstalled) return;
    window.__ssp2_phoneObsInstalled = true;

    const debouncedBind = debounce(() => {
      try { bindPhoneIconsOnDashboard(); } catch {}
    try { scheduleDriverPrefetch('renderOverlays'); } catch {}
    }, 250);

    const obs = new MutationObserver(() => debouncedBind());
    obs.observe(document.body, { childList: true, subtree: true });

    // Initial bind
    debouncedBind();
  }





  function renderOverlays() {
    try {
    removeOverlays();

    // Phone icon binding must remain functional even when overlays are disabled.
    try { bindPhoneIconsOnDashboard(); } catch {}
    try { scheduleDriverPrefetch('renderOverlays'); } catch {}

    if (!SETTINGS.overlayOn) return;

    STATE.overlayStats = { scanned: 0, matched: 0 };
    STATE.groupAgg = {};
    STATE.vridUnits = {};
    // Do NOT reset vridLoadedUnits here; it is populated asynchronously via fetch hooks and proactive requests.

    // Hook network calls to capture loaded unit counts from getOutboundLoadContainerDetails.
    // This is more reliable than scraping table headers, which vary by view.
    (function hookFetchOnce() {
      if (window.__ssp2_fetchHooked) return;
      window.__ssp2_fetchHooked = true;

      const origFetch = window.fetch;
      if (typeof origFetch !== "function") return;

      window.fetch = async function(input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const isObFetch = url.includes("/ssp/dock/hrz/ob/fetchdata");
        let entity = null;
        let vrId = null;

        try {
          const body = init && typeof init.body === "string" ? init.body : "";
          if (isObFetch && body) {
            const params = new URLSearchParams(body);
            entity = params.get("entity");
            vrId = params.get("vrId") || params.get("vrID") || params.get("vrid");
            if (entity === "getOutboundLoadContainerDetails" && vrId) {
              try {
                STATE.lastObPayloadByVrid = STATE.lastObPayloadByVrid || {};
                const obj = {};
                for (const [k,v] of params.entries()) obj[k] = v;
                STATE.lastObPayloadByVrid[vrId] = obj;
              } catch {}
            }
          }
        } catch (e) {}

        const res = await origFetch.apply(this, arguments);

        try {
          if (isObFetch && entity === "getOutboundLoadContainerDetails" && vrId) {
            const clone = res.clone();
            const txt = await clone.text();
            const clean = (txt || "").trim();
            if (clean.startsWith("{")) {
              const data = JSON.parse(clean);
              const roots = getObRootNodes(data);
              if (Array.isArray(roots)) {
                // Count "units" as top-level containers (typically CART/PALLET) on the trailer.
                const loadedUnits = countUnitsFromObTree(roots);

                STATE.vridLoadedUnits = STATE.vridLoadedUnits || {};
                STATE.vridLoadedUnits[vrId] = loadedUnits || 0;

                // Capture container IDs for verification in Merge Panel.
                const ids = extractContainerIdsFromObTree(roots);
                if (ids && ids.length) {
                  STATE.vridContainerIds = STATE.vridContainerIds || {};
                  STATE.vridContainerIds[vrId] = ids;
                }

                const meta = extractContainersMetaFromObTree(roots);
                if (meta && meta.length) {
                  STATE.vridContainersMeta = STATE.vridContainersMeta || {};
                  STATE.vridContainersMeta[vrId] = meta;
                }
                }

            }
          }
        } catch (e) {
          // Do not fail the page if parsing breaks.
        }

        return res;
      };
    })();
    try {
  const byStatus = extractCptContainersByStatusFromObResp(resp);
  if (byStatus && Object.keys(byStatus).length) {
    STATE.vridCptContainersByStatus[vrid] = byStatus;
  }
} catch (_) {}



    const colors = {
      ok: SETTINGS.colorOk,
      soon: SETTINGS.colorSoon,
      now: SETTINGS.colorNow,
    };

    // Only render inside the main SSP load table to avoid duplicates
    const table = document.querySelector("table#dashboard") || document.querySelector("table.dataTable");
    const tbody = table && table.querySelector("tbody");
    if (!table || !tbody) {
      log("Overlay skipped: dashboard table not found");
      return;
    }

    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.forEach(r => { delete r.dataset.ssp2Rendered; });
    const locationIdx = getColIndexByHeaderText(table, "Location");
    const vridIdx = getColIndexByHeaderText(table, "VR Id");
    let availableIdx = getColIndexByHeaderText(table, "Available");
let loadedIdx = getColIndexByHeaderText(table, "Loaded");
let inboundIdx = getColIndexByHeaderText(table, "Inbound");

// Fallbacks: some SSP views label these columns differently (e.g., "Avail", "Loaded Units", "Inbound Units").
// Prefer header-map regex matches over hard-coded positions.
const __hmap = getHeaderTextIndexMap(table).map(o => (o.text || "").toLowerCase());
const __findIdx = (re) => {
  for (let i = 0; i < __hmap.length; i++) if (re.test(__hmap[i])) return i;
  return -1;
};
if (availableIdx < 0) availableIdx = __findIdx(/avail/);
if (loadedIdx < 0) loadedIdx = __findIdx(/load/);
if (inboundIdx < 0) inboundIdx = __findIdx(/inbound|arriv/);

    rows.forEach(row => {
      STATE.overlayStats.scanned++;

      const txt = row.innerText || "";
      const vrid = findRowVrid(txt);
      if (!vrid) return;

      // Automation: proactively fetch container details so loaded counts are accurate without waiting for SSP UI calls.
      ensureVridDetailsRequested(vrid);

      const tds = Array.from(row.querySelectorAll("td"));
      if (!tds.length) return;
        // Phone icon belongs in the VR Id column (always present; not dependent on driver check-in icon)
try {
  if (vridIdx >= 0 && tds[vridIdx]) injectPhoneIconIntoVridCell(tds[vridIdx], vrid);
} catch {}


      const n = (idx) => {
        if (idx == null || idx < 0 || idx >= tds.length) return 0;
        const v = (tds[idx].innerText || "").replace(/,/g, "").trim();
        const num = Number(v);
        return Number.isFinite(num) ? num : 0;
      };
      const loadedFromApi = Number(STATE.vridLoadedUnits?.[vrid]);
      const loadedUnits = Number.isFinite(loadedFromApi) && loadedFromApi > 0 ? loadedFromApi : n(loadedIdx);
      try {
        // Fallback: seed loaded units from the table until OB fetchdata fills STATE.vridLoadedUnits.
        STATE.vridLoadedUnits = STATE.vridLoadedUnits || {};
        if (!Number.isFinite(Number(STATE.vridLoadedUnits[vrid])) || Number(STATE.vridLoadedUnits[vrid]) === 0) {
          const lu0 = Number(loadedUnits || 0);
          if (lu0 > 0) STATE.vridLoadedUnits[vrid] = lu0;
        }
      } catch (_) {}

      // "Current" = what's physically here (in-facility) for this VRID/lane.
      // "Inbound" = upstream/notArrived (yard/road/door/etc). Do NOT mix inbound into current.
      const inboundUnits = n(inboundIdx);
      const currentUnits = n(availableIdx) + loadedUnits;

      // Save per-VRID Current Units so the right panel can display it
      if (STATE.vridUnits) STATE.vridUnits[vrid] = currentUnits;
      (STATE.vridInboundUnits ||= {})[vrid] = inboundUnits;

      // Capacity per VRID from indexed outbound load data; fallback to 0 if unknown
      const vinfo = (STATE.vridIndex && STATE.vridIndex[vrid]) || null;
      const capUnits = Number(vinfo?.capacity || 0);
      const laneKey = (vinfo?.lane || "—");
      const cptKeyMs = Number(vinfo?.cptMs || 0);
      const gkey = laneKey + "::" + String(cptKeyMs);

      // Aggregate for the lane/CPT group so the panel can show Current vs Capacity
      if (!STATE.groupAgg[gkey]) STATE.groupAgg[gkey] = { currentUnits: 0, inboundUnits: 0, vrids: new Set(), inboundVrids: new Set() };
      STATE.groupAgg[gkey].currentUnits += currentUnits;
      STATE.groupAgg[gkey].inboundUnits += inboundUnits;
      try { STATE.groupAgg[gkey].vrids.add(vrid); } catch (_) {}
      if ((Number(inboundUnits) || 0) > 0) { try { STATE.groupAgg[gkey].inboundVrids.add(vrid); } catch (_) {} }


      // Anchor UI in the Location column (preferred), then VR Id, then first cell
      let targetCell = null;
      if (locationIdx >= 0 && tds[locationIdx]) targetCell = tds[locationIdx];
      else if (vridIdx >= 0 && tds[vridIdx]) targetCell = tds[vridIdx];
      else targetCell = tds[0];

      if (!targetCell) return;

      // De-dupe: if already rendered for this row this pass, skip
      if (row.dataset.ssp2Rendered === "1") return;
      row.dataset.ssp2Rendered = "1";

      STATE.overlayStats.matched++;

      // Shared UI wrapper that lives inside the target cell (prevents overlap)
      let locUI = targetCell.querySelector(".ssp2-locui");
      if (!locUI) {
        locUI = document.createElement("span");
        locUI.className = "ssp2-locui";
        locUI.style.cssText = `
          display:inline-flex;
          align-items:center;
          gap:8px;
          margin-right:8px;
          vertical-align:middle;
          white-space:nowrap;
        `;
        // Prepend so the Location text remains visible after the controls
        targetCell.prepend(locUI);
      } else {
        // Clean on re-render
        locUI.innerHTML = "";
      }

      // Selection pill (uses native SSP row checkbox — no second checkbox)
      const overlay = document.createElement("span");
      overlay.className = "ssp2-overlay";
      overlay.style.cssText = `
        display:inline-flex;
        gap:8px;
        align-items:center;
        background:rgba(255,255,255,.97);
        padding:4px 10px;
        border-radius:999px;
        border:2px solid ${colors.ok};
        font-weight:800;
        box-shadow:0 2px 8px rgba(0,0,0,.12);
        user-select:none;
        cursor:pointer;
      `;

      // Native SSP checkbox (typically in the first column)
      const nativeCb = row.querySelector("input[type='checkbox']");
      const isChecked = nativeCb ? !!nativeCb.checked : STATE.bulkSelection.has(vrid);

      const tag = document.createElement("span");
      tag.textContent = isChecked ? "Selected" : "Select";

      // Click pill toggles the native checkbox, which drives bulkSelection
      overlay.onclick = (e) => {
        e.stopPropagation();
        if (nativeCb) {
          nativeCb.click(); // triggers change event + keeps SSP behavior consistent
        } else {
          // fallback (should be rare): toggle internal selection only
          if (STATE.bulkSelection.has(vrid)) STATE.bulkSelection.delete(vrid);
          else STATE.bulkSelection.add(vrid);
          renderPanel();
          renderOverlays();
      applyHighlights();
        }
      };

      overlay.append(tag);

      const utilBadge = document.createElement("span");
      utilBadge.className = "ssp2-utilbadge";
      utilBadge.style.cssText = `
        font-weight:900;
        font-size:12px;
        padding:2px 8px;
        border-radius:999px;
        border:1px solid #d1d5db;
        background:#ffffff;
        color:#111827;
        white-space:nowrap;
      `;
      utilBadge.textContent = capUnits > 0 ? `${currentUnits} / ${capUnits}` : `${currentUnits} / —`;
      overlay.append(utilBadge);

      // Keep internal selection synced to native checkbox changes (only bind once)
      if (nativeCb && nativeCb.dataset.ssp2Bind !== "1") {
        nativeCb.dataset.ssp2Bind = "1";
        nativeCb.addEventListener("change", () => {
          if (nativeCb.checked) STATE.bulkSelection.add(vrid);
          else STATE.bulkSelection.delete(vrid);
          renderPanel();
          // update pill text/color without full repaint
          try {
            const pill = row.querySelector(".ssp2-overlay span");
            if (pill) pill.textContent = nativeCb.checked ? "Selected" : "Select";
          } catch {}
        }, { passive: true });
      }

      // Action buttons (inline, part of row flow)
      const makeBtn = (label, url) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = "padding:2px 8px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;";
        b.onclick = (e) => { e.stopPropagation(); window.open(url, "_blank", "noopener"); };
        return b;
      };

      const btnTT = makeBtn("TT", buildTTUrl(STATE.nodeId, vrid));
      const btnRelay = makeBtn("Relay", buildRelayUrl(vrid));
      const btnFMC = makeBtn("FMC", buildFmcUrl(vrid));

      // Mount
      locUI.appendChild(overlay);

      // Visual state
      if (nativeCb && nativeCb.checked) {
        overlay.style.borderColor = colors.now;
      }
      // Keep the wrapper for compatibility with any existing CSS/logic
      const actionWrap = document.createElement("span");
      actionWrap.className = "ssp-row-actions";
      actionWrap.style.cssText = `
        display:inline-flex;
        gap:6px;
        align-items:center;
        white-space:nowrap;
        vertical-align:middle;
      `;
      // Persistent phone tooltip (not dependent on driver check-in icon)
      const btnPhone = document.createElement("button");
      btnPhone.textContent = "Phone";
      btnPhone.style.cssText = "padding:2px 8px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;";
      btnPhone.onclick = (e) => { e.stopPropagation(); showPhoneTooltip(btnPhone, vrid); };

      // Barcode for attached load (Location cell image resourceId)
      const btnBarcode = document.createElement("button");
      btnBarcode.textContent = "BC";
      btnBarcode.style.cssText = "padding:2px 8px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;";
      btnBarcode.title = "Barcode (resource ID)";
     btnBarcode.onclick = (e) => {
  e.stopPropagation();
  const rid = String(STATE.vridToResId?.get(String(vrid)) || "");
  showBarcodePopover(btnBarcode, rid);
};


      // Only show barcode button if we have resId from getOutboundDockView resources
try {
  const rid = String(STATE.vridToResId?.get(String(vrid)) || "");
  if (!rid) btnBarcode.style.display = "none";
} catch { btnBarcode.style.display = "none"; }


      actionWrap.append(btnTT, btnRelay, btnFMC, btnBarcode);
      locUI.appendChild(actionWrap);
    });

    log("Overlay stats", STATE.overlayStats);
    } catch (e) { console.warn('[SSP Util] renderOverlays failed:', e); STATE.lastOverlayError = String(e && e.message ? e.message : e); }
  }

  /* =====================================================
     ACTION PANEL (movable)
  ====================================================== */
  

  // Shared Export: IB4CPT (used by Action Panel + Planning Panel)
  async function exportIB4CPT() {
    // Always prefer the already-normalized IB4CPT lane/CPT structures.
    // These are the same structures the Action Panel uses for inbound attribution.
    const stats = (STATE.ibLaneCptStats && typeof STATE.ibLaneCptStats === "object") ? STATE.ibLaneCptStats : {};
    const lgMap = (STATE.ibLaneCptLoadGroups && typeof STATE.ibLaneCptLoadGroups === "object") ? STATE.ibLaneCptLoadGroups : {};

    const loads = (Array.isArray(STATE.inboundLoadsAll) && STATE.inboundLoadsAll.length)
      ? STATE.inboundLoadsAll
      : (Array.isArray(STATE.inboundLoads) ? STATE.inboundLoads : []);

    // Ensure eligible map exists (best-effort). If it's empty, compute it on-demand.
    let elig = (STATE.inboundEligibleMap && typeof STATE.inboundEligibleMap === "object") ? STATE.inboundEligibleMap : {};
    const planIds = Array.from(new Set(loads.map(l => String(l?.planId || "").trim()).filter(Boolean)));
    const hasElig = elig && Object.keys(elig).length;
    if (!hasElig && planIds.length) {
      try {
        const rElig = await postFetch(
          "/ssp/dock/hrz/ib/fetchdata?",
          { entity: "getEligibleContainerCountsForLoads", nodeId: STATE.nodeId, loadIds: planIds.join(",") },
          "IB",
          { priority: 2 }
        );
        const eligMap = rElig?.ret?.eligibleContainerCountMap || {};
        STATE.inboundEligibleMap = (eligMap && typeof eligMap === "object") ? eligMap : {};
        elig = STATE.inboundEligibleMap;
      } catch (e) {
        // keep elig empty; exports will still include raw container hierarchy when available
        elig = {};
        STATE.inboundEligibleMap = {};
      }
    }

    // DETAIL BY LOAD (existing export, but make elig lookup robust)
    const detailRows = loads.map(l => {
      const planId = String(l?.planId || "").trim();
      const vrid = String(l?.vrId || l?.vrid || "").trim();
      const keyA = planId;
      const keyB = planId.toLowerCase();
      const keyC = planId.toUpperCase();
      const eligVal = (elig && (elig[keyA] != null || elig[keyB] != null || elig[keyC] != null))
        ? Number(elig[keyA] ?? elig[keyB] ?? elig[keyC])
        : "";
      return {
        planId,
        vrid,
        route: l?.route || l?.lane || "",
        status: l?.status || l?.loadStatus || "",
        location: l?.location || "",
        scheduledArrivalTime: l?.scheduledArrivalTime || "",
        estimatedArrivalTime: l?.estimatedArrivalTime || "",
        actualArrivalTime: l?.actualArrivalTime || "",
        equipmentType: l?.equipmentType || l?.trailerEquipmentType || "",
        eligibleContainers: eligVal,
      };
    });

    const detailHeaders = [
      "planId","vrid","route","status","location",
      "scheduledArrivalTime","estimatedArrivalTime","actualArrivalTime",
      "equipmentType","eligibleContainers"
    ];

    downloadTextFile(
      `IB4CPT_DETAIL_BY_LOAD_${STATE.nodeId || "NODE"}_${new Date().toISOString().slice(0,10)}.csv`,
      toCsv(detailRows, detailHeaders),
      "text/csv;charset=utf-8"
    );

    // SUMMARY (lane + CPT rollups). Build from ibLaneCptStats so it always matches the panel.
    const summaryRows = Object.entries(stats).map(([k, v]) => {
      const parts = String(k).split("::");
      const lane = parts[0] || "";
      const cptMs = Number(parts[1] || 0) || 0;
      const cpt = cptMs ? fmtTime(cptMs) : "";
      const lgs = Array.isArray(v?.loadGroupIds) ? v.loadGroupIds : (lgMap[k] ? Array.from(lgMap[k]) : []);
      return {
        lane,
        cpt,
        cptMs,
        loadGroupCount: lgs.length,
        expected: Number(v?.totalC ?? v?.expected ?? 0),
        inTransit: Number(v?.inTrailerC ?? v?.inTransit ?? 0),
        atYard: Number(v?.unloadedC ?? v?.atYard ?? 0),
        atDock: Number(v?.atDock ?? 0),
        inFacility: Number(v?.inFacility ?? 0),
        loaded: Number(v?.loaded ?? 0),
        departed: Number(v?.departed ?? 0),
        loadGroupIds: lgs.join(" "),
      };
    });

    const summaryHeaders = [
      "lane","cpt","cptMs","loadGroupCount",
      "expected","inTransit","atYard","atDock","inFacility","loaded","departed",
      "loadGroupIds"
    ];

    downloadTextFile(
      `IB4CPT_SUMMARY_${STATE.nodeId || "NODE"}_${new Date().toISOString().slice(0,10)}.csv`,
      toCsv(summaryRows, summaryHeaders),
      "text/csv;charset=utf-8"
    );

    // Dump eligible map so you can see exactly what SSP returned (raw truth).
    const eligRows = Object.entries(elig || {}).map(([planId, cnt]) => ({ planId, eligibleContainers: Number(cnt) }));
    downloadTextFile(
      `IB4CPT_ELIG_MAP_${STATE.nodeId || "NODE"}_${new Date().toISOString().slice(0,10)}.csv`,
      toCsv(eligRows, ["planId","eligibleContainers"]),
      "text/csv;charset=utf-8"
    );

    // CONTAINERS (one row per container for ELIGIBLE inbound loads).
    // Best-effort: pull inbound container hierarchy by VRID. This is the only way to get container IDs, not just counts.
    const eligSet = new Set(
      Object.entries(elig || {})
        .filter(([_, cnt]) => Number(cnt) > 0)
        .map(([pid]) => String(pid).trim())
        .filter(Boolean)
    );

    const eligLoads = loads.filter(l => {
      const pid = String(l?.planId || "").trim();
      return eligSet.size ? eligSet.has(pid) : true; // if elig map empty, include all so we still see raw pulls
    });

    const tryEntities = [
      "getContainerHierarchyForVrid",
      "getContainerHierarchy",
      "getContainerHierarchyForLoad",
      "getContainerDetailsForVrid",
      "getContainerDetails"
    ];

    const flattenHierarchy = (nodes, outRows, ctx, parentId, depth) => {
      if (!nodes || !nodes.length) return;
      for (const n of nodes) {
        const c = n?.container || n?.data || n;
        const containerId = String(c?.containerId || c?.id || "").trim();
        outRows.push({
          cpt: ctx.cpt || "",
          lane: ctx.lane || "",
          planId: ctx.planId || "",
          vrid: ctx.vrid || "",
          status: ctx.status || "",
          containerId,
          contType: c?.contType || c?.containerType || c?.type || "",
          stackFilter: c?.stackFilter || c?.stackingFilter || "",
          label: c?.label || "",
          contentQuantity: (c?.contentQuantity != null ? Number(c.contentQuantity) : ""),
          inboundLocation: c?.inboundLocationId || c?.inboundLocation || "",
          parentContainerId: parentId || "",
          depth: Number(depth || 0),
        });
        const kids = n?.childNodes || n?.children || c?.childNodes || [];
        if (kids && kids.length) flattenHierarchy(kids, outRows, ctx, containerId || parentId || "", Number(depth || 0) + 1);
      }
    };

    const containerRows = [];
    for (const l of eligLoads) {
      const planId = String(l?.planId || "").trim();
      const vrid = String(l?.vrId || l?.vrid || "").trim();
      const ctx = {
        planId,
        vrid,
        status: l?.status || "",
        lane: l?.route || l?.lane || "",
        cpt: "",
      };

      // Best-effort IB fetch to get container hierarchy
      let got = null;
      for (const ent of tryEntities) {
        try {
          const rH = await postFetch(
            "/ssp/dock/hrz/ib/fetchdata?",
            { entity: ent, nodeId: STATE.nodeId, vrId: vrid, vrid: vrid, planId: planId, loadId: planId, inboundLoadId: planId },
            "IB",
            { priority: 1 }
          );
          if (rH && (rH.ok || rH?.ret || rH?.ret?.aaData)) {
            got = rH;
            break;
          }
        } catch (e) {}
      }

      // If no hierarchy could be fetched, still emit a row so you can see what we tried.
      if (!got) {
        containerRows.push({
          cpt: ctx.cpt,
          lane: ctx.lane,
          planId: ctx.planId,
          vrid: ctx.vrid,
          status: ctx.status,
          containerId: "",
          contType: "",
          stackFilter: "",
          label: "",
          contentQuantity: "",
          inboundLocation: "",
          parentContainerId: "",
          depth: 0,
        });
        continue;
      }

      const roots = got?.ret?.aaData?.ROOT_NODE || got?.ret?.aaData?.rootNode || got?.ret?.aaData || got?.ret || got;
      const nodes = Array.isArray(roots) ? roots : (roots && roots.childNodes ? [roots] : []);
      if (nodes && nodes.length) {
        flattenHierarchy(nodes, containerRows, ctx, "", 0);
      }
    }

    const containerHeaders = [
      "cpt","lane","planId","vrid","status",
      "containerId","contType","stackFilter","label","contentQuantity","inboundLocation",
      "parentContainerId","depth"
    ];

    downloadTextFile(
      `IB4CPT_CONTAINERS_${STATE.nodeId || "NODE"}_${new Date().toISOString().slice(0,10)}.csv`,
      toCsv(containerRows, containerHeaders),
      "text/csv;charset=utf-8"
    );
  }
function ensurePanel() {
    // UI should render on supported SSP hosts only (not Relay pages).
    if (!isSspHost()) return;
    if (document.getElementById("ssp2-panel")) return;

    const p = document.createElement("div");
    p.id = "ssp2-panel";
    p.style.cssText = `
      position:fixed;top:90px;right:24px;
      width:720px;height:640px;min-width:520px;min-height:420px;
      max-width:calc(100vw - 40px);max-height:calc(100vh - 120px);
      background:#fff;border:1px solid #ccc;border-radius:10px;
      box-shadow:0 4px 14px rgba(0,0,0,.2);
      font-family:Arial;font-size:12px;z-index:99999;
      resize: both; overflow: auto; display:${UI_PREFS.panelHidden ? "none" : "flex"}; flex-direction: column;
    `;

    p.innerHTML = `
      <div id="ssp2-panelhdr" style="padding:10px;font-weight:800;background:#f3f3f3;cursor:move;border-radius:10px 10px 0 0">
        SSP Util 1.6.71 — Action Panel
      </div>
      <div style="padding:10px;flex:1;min-height:0;display:flex;flex-direction:column">
        <div id="ssp2-status" style="white-space:pre-wrap"></div>

        <div id="ssp2-signal-widget" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="ssp2-open-disruptions" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;">Disruptions</button>
          <button id="ssp2-disruptions-ob" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Late: …</button>
          <button id="ssp2-disruptions-ib" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Issues: …</button>

          <span style="width:1px;height:18px;background:#e5e7eb;display:inline-block;margin:0 2px;"></span>

          <button id="ssp2-cap-all" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">All</button>

          <button id="ssp2-cap-cancel" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Cancel</button>
          <button id="ssp2-cap-adhoc" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Adhoc</button>
          <button id="ssp2-cap-risk" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Risk</button>
          <button id="ssp2-cap-now" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Merge Now</button>
          <button id="ssp2-cap-soon" style="cursor:pointer;padding:5px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;display:none;">Merge Soon</button>
        </div>

        <div id="ssp2-list" style="margin-top:10px;flex:1;min-height:0;overflow:auto;border-top:1px solid #e5e7eb;padding-top:10px;"></div>

        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
          <button id="bulk-tt">Bulk TT</button>
          <button id="bulk-relay">Bulk Relay</button>
          <button id="bulk-fmc">Bulk FMC</button>
          <span id="bulk-count" style="margin-left:auto;font-weight:800"></span>
        </div>

        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          <button id="refresh-now">Refresh Now</button>
          <button id="show-error">Last Error</button>
          <button id="csv-ib">CSV XD Graph</button>
          <button id="csv-ib4">CSV IB4CPT</button>
          <button id="csv-import-est">📊 Import 2wk CSV</button>
          <button id="slack-config-btn" style="margin-left:auto;">📤 Slack</button>
        </div>

        <div id="csv-import-container" style="margin-top:8px;display:none;flex-direction:column;gap:8px;padding:8px;background:#f9f9f9;border:1px solid #e5e7eb;border-radius:6px">
          <textarea id="csv-import-textarea" placeholder="Paste CSV data here (2-week SSP inbound export)" style="width:100%;height:120px;padding:6px;font-family:monospace;font-size:11px;border:1px solid #ccc;border-radius:4px;resize:vertical"></textarea>
          <div style="display:flex;gap:6px">
            <button id="csv-import-paste" style="flex:1">Import CSV</button>
            <button id="csv-import-cancel" style="flex:1">Cancel</button>
          </div>
          <div id="csv-import-status" style="font-size:11px;color:#666;white-space:nowrap"></div>
        </div>

        <div style="margin-top:8px;color:#555">
          Overlay: <span id="ov-stat"></span> | Last: <span id="last-stat">—</span> | Est: <span id="csv-est-stat">—</span>
        </div>
      </div>
    `;

    document.body.appendChild(p);

    // Global disruptions buttons (Action Panel)
    const openDis = document.getElementById("ssp2-open-disruptions");
    const obBtn = document.getElementById("ssp2-disruptions-ob");
    const ibBtn = document.getElementById("ssp2-disruptions-ib");

    const _openDisruptionsWithPreset = (preset) => {
      try {
        // Preset the modal filter before opening (top buttons should behave as "show me OB", "show me IB", etc.)
        if (preset) STATE.__disruptFilter = preset;
        if (typeof openDisruptionsPanel === "function") openDisruptionsPanel("__ALL__", 0);
      } catch (_) {}
    };

    if (openDis) openDis.onclick = () => _openDisruptionsWithPreset({ ob: true, ib: true });
    if (obBtn) obBtn.onclick = () => _openDisruptionsWithPreset({ ob: true, ib: false });
    if (ibBtn) ibBtn.onclick = () => _openDisruptionsWithPreset({ ob: false, ib: true });

    // CSV exports
    const csvIb = document.getElementById("csv-ib");
    if (csvIb) csvIb.onclick = () => {
      const rows = (STATE.inboundLoads || []).map((l) => ({
        planId: l?.planId || "",
        vrId: l?.vrId || "",
        route: l?.route || l?.lane || "",
        scac: l?.carrierScac || l?.scac || "",
        scheduledArrivalTime: l?.scheduledArrivalTime || "",
        estimatedArrivalTime: l?.estimatedArrivalTime || "",
        status: l?.status || "",
        equipmentType: l?.equipmentType || l?.trailerEquipmentType || "",
        location: l?.location || "",
      }));
      const headers = ["planId","vrId","route","scac","scheduledArrivalTime","estimatedArrivalTime","status","equipmentType","location"];
      const csv = toCsv(rows, headers);
      downloadTextFile(`IB_CART_${STATE.nodeId || "NODE"}_${new Date().toISOString().slice(0,10)}.csv`, csv, "text/csv;charset=utf-8");
    };
    // CSV buttons are moved into the Planning Panel. Keep logic here (for reuse) but hide from Action Panel UI.
    if (csvIb) csvIb.style.display = "none";

    const csvIb4 = document.getElementById("csv-ib4");
    if (csvIb4) csvIb4.onclick = exportIB4CPT;

    // CSV buttons are moved into the Planning Panel. Keep logic here (for reuse) but hide from Action Panel UI.
    if (csvIb4) csvIb4.style.display = "none";

    // Slack notifications button
    const slackConfigBtn = document.getElementById("slack-config-btn");
    if (slackConfigBtn) {
      slackConfigBtn.onclick = () => {
        showSlackConfigModal();
      };
    }

    // CSV Import Estimation Handler
    const csvImportBtn = document.getElementById("csv-import-est");
    const csvImportContainer = document.getElementById("csv-import-container");
    const csvImportTextarea = document.getElementById("csv-import-textarea");
    const csvImportPaste = document.getElementById("csv-import-paste");
    const csvImportCancel = document.getElementById("csv-import-cancel");
    const csvImportStatus = document.getElementById("csv-import-status");
    const csvEstStat = document.getElementById("csv-est-stat");

    if (csvImportBtn) {
      csvImportBtn.onclick = () => {
        if (csvImportContainer.style.display === "none") {
          csvImportContainer.style.display = "flex";
          csvImportTextarea.focus();
        } else {
          csvImportContainer.style.display = "none";
        }
      };
    }

    if (csvImportCancel) {
      csvImportCancel.onclick = () => {
        csvImportContainer.style.display = "none";
        csvImportTextarea.value = "";
        csvImportStatus.textContent = "";
      };
    }

    if (csvImportPaste) {
      csvImportPaste.onclick = () => {
        try {
          const csvText = csvImportTextarea.value.trim();
          if (!csvText) {
            csvImportStatus.textContent = "❌ Paste CSV data first";
            return;
          }

          csvImportStatus.textContent = "⏳ Processing...";
          
          // Call the import function (defined in IB_CSV_EST section)
          const result = importInboundCsvEstimates(csvText);
          
          if (result) {
            csvImportStatus.textContent = `✅ Imported ${result.rowsProcessed} rows, ${result.estimatesBuckets || Object.keys(result.estimates || {}).length} estimate buckets`;
            csvEstStat.textContent = `CSV loaded`;
            setTimeout(() => {
              csvImportContainer.style.display = "none";
              csvImportTextarea.value = "";
              csvImportStatus.textContent = "";
            }, 2000);
          } else {
            csvImportStatus.textContent = "❌ Import failed. Check console.";
          }
        } catch (e) {
          csvImportStatus.textContent = `❌ Error: ${String(e).substring(0, 40)}`;
          console.error("[SSP Util] CSV import error:", e);
        }
      };
    }

    // Display current CSV estimate status on load
    try {
      const existing = STATE.ibCsvEstimates || _ibCsvEstLoadFromStorage();
      if (existing && existing.estimates && Object.keys(existing.estimates).length > 0) {
        csvEstStat.textContent = `CSV loaded (${Object.keys(existing.estimates).length} buckets)`;
      }
    } catch (_) {}

    // Drag
    const hdr = p.querySelector("#ssp2-panelhdr");
    let drag = false, ox = 0, oy = 0;
    hdr.onmousedown = (e) => { drag = true; ox = e.clientX - p.offsetLeft; oy = e.clientY - p.offsetTop; };
    document.onmouseup = () => (drag = false);
    document.onmousemove = (e) => {
      if (!drag) return;
      p.style.left = (e.clientX - ox) + "px";
      p.style.top = (e.clientY - oy) + "px";
      p.style.right = "auto";
    };

    const joinVridsForUrl = (ids) => (ids || []).map(String).map(s => s.trim()).filter(Boolean).join(",");

    const bulkOpenSingle = (urlBuilder) => {
      const ids = Array.from(STATE.bulkSelection || []);
      if (!ids.length) return alert("Select at least 1 VRID.");
      const url = urlBuilder(ids);
      window.open(url, "_blank", "noopener");
    };

    const buildBulkRelayUrl = (vrids) => {
      const joined = joinVridsForUrl(vrids);
      const anchor = vrids && vrids.length ? String(vrids[0]).trim() : "";
      return `https://track.relay.amazon.dev/view/NA:VR:${encodeURIComponent(anchor)}?q=${encodeURIComponent(joined)}`;
    };

    const buildBulkTTUrl = (nodeId, vrids) => {
      const nid = nodeId || STATE.nodeId || "";
      const joined = joinVridsForUrl(vrids);
      return `https://trans-logistics.amazon.com/sortcenter/tantei?nodeId=${encodeURIComponent(String(nid))}&searchType=Container&searchId=${encodeURIComponent(joined)}`;
    };

    async function fetchBulkTTJson(vrids) {
      const ids = (vrids || []).map(String).map(s => s.trim()).filter(Boolean);
      if (!ids.length) throw new Error("No VRIDs provided.");

      const payload = {
        searchIds: ids,
        searchByIds: true,
        page: 0,
        pageSize: 100,
        bookmarkedSavedSearch: false,
        dashboardPreferences: "{\"length\":100,\"order\":[[12,\"asc\"]],\"search\":{\"search\":\"\",\"smart\":true,\"regex\":false,\"caseInsensitive\":true},\"columns\":[]}",
        executionViewModePreference: "vrs",
        originalCriteria: `{\"searchIds\":${JSON.stringify(ids)},\"pageSize\":100}`
      };

      const res = await sspFetch("https://trans-logistics.amazon.com/fmc/search/execution/by-id", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/plain, */*"
        },
        body: JSON.stringify(payload)
      });

      const json = await res.json();
      return json;
    }

    function downloadJson(filename, obj) {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    p.querySelector("#bulk-relay").onclick = () => bulkOpenSingle(buildBulkRelayUrl);

    p.querySelector("#bulk-fmc").onclick = async () => {
      const ids = Array.from(STATE.bulkSelection || []);
      if (!ids.length) return alert("Select at least 1 VRID.");

      
// FMC supports true bulk search via POST /fmc/search/execution/by-id
// NOTE: FMC expects dashboardPreferences + originalCriteria to behave like UI bulk search.
const url = "https://trans-logistics.amazon.com/fmc/search/execution/by-id";
const payload = {
  searchIds: ids,
  searchByIds: true,
  page: 0,
  pageSize: 100,
  bookmarkedSavedSearch: false,
  executionViewModePreference: "vrs",
  dashboardPreferences: JSON.stringify({
          length: 100,
          order: [[12, "asc"]],
          search: { search: "", smart: true, regex: false, caseInsensitive: true },
          columns: Array(30).fill().map(() => ({
              visible: true,
              search: { search: "", smart: true, regex: false, caseInsensitive: true }
            })),
            childTable: { hiddenColumns: ["estimatedArrival", "estimatedDelay"], shownColumns: [] },
            columnNames: []
        }),
  originalCriteria: JSON.stringify({ searchIds: ids, pageSize: 100 })
};
console.log("VRIDs sent to FMC:", ids);
console.log("POST payload:", payload);
      try {const res = await sspFetch(url, {
  method: "POST",
  credentials: "include",
  headers: {
    "content-type": "application/json",
    "accept": "application/json, text/plain, */*"
  },
  body: JSON.stringify(payload)
});
if (!res.ok) throw new Error(`Bulk FMC by-id failed: ${res.status}`);

const r = await res.json().catch(() => null);

const suggested =
  r?.suggestedUrl ||
  r?.returnedObject?.suggestedUrl ||
  r?.data?.suggestedUrl ||
  "";

// Always copy VRIDs (useful even if FMC navigation fails)
try { await navigator.clipboard.writeText(ids.join(",")); } catch (_) {}

if (suggested) {
  window.open("https://trans-logistics.amazon.com" + suggested, "_blank", "noopener");
} else {
  window.open("https://trans-logistics.amazon.com/fmc/search/execution", "_blank", "noopener");
}

if (r) STATE._lastBulkFmc = { at: Date.now(), ids, resp: r };
    } catch (e) {
        console.warn("Bulk FMC failed", e);
        alert("Bulk FMC failed. Opened FMC search and copied VRIDs to clipboard.");
        //try { await navigator.clipboard.writeText(ids.join(", ")); } catch (_) {}
        //window.open("https://trans-logistics.amazon.com/fmc/search/execution", "_blank", "noopener");
      }
    };

    p.querySelector("#bulk-tt").onclick = async () => {
      const ids = Array.from(STATE.bulkSelection || []);
      if (!ids.length) return alert("Select at least 1 VRID.");

      // 1) Open TT once (with joined ids)
      window.open(buildBulkTTUrl(STATE.nodeId, ids), "_blank", "noopener");

      // 2) Optional: Fetch TT JSON and download (useful for deeper triage)
      if (confirm("Download FMC execution JSON for the selected VRIDs?")) {
        try {
          const json = await fetchBulkTTJson(ids);
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          downloadJson(`bulk_tt_${STATE.nodeId || "NODE"}_${ts}.json`, json);
        } catch (e) {
          console.error("Bulk TT JSON fetch failed", e);
          alert("Bulk TT JSON fetch failed. Check console.");
        }
      }
    };

    p.querySelector("#refresh-now").onclick = () => run(true);

    p.querySelector("#show-error").onclick = () => {
      if (!STATE.lastError) return alert("No errors captured.");
      alert(`Last fetchdata error\n\n${STATE.lastError}`);
      log("Last error detail", STATE.lastErrorDetail);
    };
  }



  // --- Helpers: Extract VRID from OB container LOAD nodes (fields vary)
  function _extractKnownVridFromLoadContainer(c, knownSet) {
    try {
      const candidates = [];
      const push = (v) => { const s = String(v || '').trim(); if (s) candidates.push(s); };
      push(c?.containerId);
      push(c?.vrId);
      push(c?.vrID);
      push(c?.label);
      push(c?.containerLabel);
      // Sometimes label contains "Load: <VRID>" or other prefix/suffix
      for (const s of candidates.slice()) {
        const m = s.match(/([A-Z0-9]{8,})/i);
        if (m) candidates.push(m[1]);
      }

      // Prefer exact matches against known inbound VRIDs
      if (knownSet && knownSet.size) {
        for (const s of candidates) {
          if (knownSet.has(s)) return s;
        }
        // Also try normalized (trim)
        for (const s of candidates) {
          const t = String(s).trim();
          if (knownSet.has(t)) return t;
        }
      }
      // Fall back to first candidate if nothing matched
      return candidates[0] || "";
    } catch (_) { return ""; }
  }

  // --- Current Units prefetch (no-click Lane Panel support) ---
  function _cuGroupKey(laneKey, cptMs) {
    return String(laneKey || "—").trim() + "::" + String(Number(cptMs || 0));
  }

  function _isCuFresh(groupKey, maxAgeMs) {
    try {
      const ts = Number(STATE.cuTsByGroupKey?.[groupKey] || 0);
      return !!ts && (Date.now() - ts) <= (Number(maxAgeMs || 0) || 0);
    } catch (_) { return false; }
  }

  function _enqueueCuForGroup(g) {
    try {
      if (!g) return;
      const groupKey = _cuGroupKey(g.lane, g.cptMs);
      if (_isCuFresh(groupKey, 3 * 60 * 1000)) return;

      STATE.cuInflightByGroupKey = STATE.cuInflightByGroupKey || new Set();
      STATE.cuQueue = STATE.cuQueue || [];
      STATE.cuWorkerRunning = !!STATE.cuWorkerRunning;
      STATE.cuByGroupKey = STATE.cuByGroupKey || {};
      STATE.cuTsByGroupKey = STATE.cuTsByGroupKey || {};

      if (STATE.cuInflightByGroupKey.has(groupKey)) return;

      const lg = Array.isArray(g.loadGroupIds) ? String(g.loadGroupIds[0] || '').trim() : '';
      if (!lg) return;

      STATE.cuQueue.push({ groupKey, lg, laneTxt: String(g.lane || '') });

      if (!STATE.cuWorkerRunning) {
        STATE.cuWorkerRunning = true;
        void (async function cuWorker() {
          try {
            while (STATE.cuQueue.length) {
              const job = STATE.cuQueue.shift();
              if (!job || !job.groupKey || !job.lg) continue;
              if (STATE.cuInflightByGroupKey.has(job.groupKey)) continue;

              STATE.cuInflightByGroupKey.add(job.groupKey);
              try {
                const data = await fetchCurrentUnitsCoordinator({ lg: job.lg, laneTxt: job.laneTxt });
                if (data && !data.loading && !data.error) {
                  STATE.cuByGroupKey[job.groupKey] = data;
                  STATE.cuTsByGroupKey[job.groupKey] = Date.now();
                }
              } catch (_) {}
              finally { try { STATE.cuInflightByGroupKey.delete(job.groupKey); } catch (_) {} }

              await sleep(250);
            }
          } finally {
            STATE.cuWorkerRunning = false;
          }
        })();
      }
    } catch (_) {}
  }

  function _prefetchCuForGroups(groups) {
    try {
      const arr = Array.isArray(groups) ? groups : [];
      for (const g of arr) _enqueueCuForGroup(g);
    } catch (_) {}
  }

// --- Inbound contributors prefetch (no-click Lane Panel support) ---
  function _ibContribKey(laneKey, cptMs) {
    const laneNorm = String(laneKey || "—").trim();
    return laneNorm + "::" + String(Number(cptMs || 0));
  }

  function _isIbContribFresh(lgKey, maxAgeMs) {
    try {
      const ts = Number(STATE.ibContribTsByLaneCpt?.[lgKey] || 0);
      return !!ts && (Date.now() - ts) <= (Number(maxAgeMs || 0) || 0);
    } catch (_) { return false; }
  }

  function _enqueueIbContrib(laneKey, cptMs) {
    try {
      const lgKey = _ibContribKey(laneKey, cptMs);
      if (STATE.ibContribInflight.has(lgKey)) return;
      // If we already have something reasonably fresh, don't refetch.
      if (_isIbContribFresh(lgKey, 5 * 60 * 1000)) return;

      STATE.ibContribQueue.push({ laneKey: String(laneKey || "—"), cptMs: Number(cptMs || 0), lgKey });
      if (!STATE.ibContribWorkerRunning) {
        STATE.ibContribWorkerRunning = true;
        void (async function worker() {
          try {
            while (STATE.ibContribQueue.length) {
              const job = STATE.ibContribQueue.shift();
              if (!job || !job.lgKey) continue;
              if (STATE.ibContribInflight.has(job.lgKey)) continue;

              STATE.ibContribInflight.add(job.lgKey);
              try { await _fetchIbContribForLane(job.laneKey, job.cptMs, job.lgKey); }
              catch (_) {}
              finally { try { STATE.ibContribInflight.delete(job.lgKey); } catch (_) {} }

              // gentle throttle to avoid SSP rate-limits
              await sleep(250);
            }
          } finally {
            STATE.ibContribWorkerRunning = false;
          }
        })();
      }
    } catch (_) {}
  }

  function _prefetchIbContribForGroups(groups) {
    try {
      const arr = Array.isArray(groups) ? groups : [];
      for (const g of arr) {
        const lane = (g && g.lane) ? g.lane : "—";
        const cpt = (g && g.cptMs) ? g.cptMs : 0;
        _enqueueIbContrib(lane, cpt);
      }
    } catch (_) {}
  }

  async function _fetchIbContribForLane(laneKey, cptMs, lgKey) {
    // Determine loadGroupIds for this Lane::CPT (same source used by Merge Panel).
    const key = String(laneKey || "—") + "::" + String(Number(cptMs || 0));
    const lgIds = (STATE.ibLaneCptLoadGroups && STATE.ibLaneCptLoadGroups[key]) ? STATE.ibLaneCptLoadGroups[key] : [];
    if (!Array.isArray(lgIds) || !lgIds.length) {
      STATE.ibContribByLaneCpt[lgKey] = [];
      STATE.ibContribTsByLaneCpt[lgKey] = Date.now();
      return;
    }

    // Build inbound index by VRID from ops-window cache (prevents orphan VRIDs).
    const ibByVrid = new Map();
    try {
      for (const l of (STATE.inboundLoadsAll || [])) {
        const vr = String(l?.vrid || l?.vrId || l?.containerId || "").trim();
        if (!vr) continue;
        ibByVrid.set(vr, l);
      }
    } catch (_) {}

    const __knownIbVrids = new Set(ibByVrid.keys());

    const mergeByVrid = new Map(); // vrid -> rowAgg
    for (const lgRaw of lgIds) {
      const lg = String(lgRaw || "").trim();
      if (!lg) continue;

      // Anchor resolution (planId + vrId) is required by OB endpoint.
      STATE.laneAnchorByLg = STATE.laneAnchorByLg || {};
      let anchor = STATE.laneAnchorByLg[lg] || null;

      if (!anchor) {
        try {
          anchor = resolveObAnchorForLg(lg, String(laneKey || ""));
          if (anchor) STATE.laneAnchorByLg[lg] = anchor;
        } catch (_) {}
      }

      if (!anchor || !anchor.planId) continue;

      const payload = {
        entity: 'getContainerDetailsForLoadGroupId',
        nodeId: STATE.nodeId,
        loadGroupId: lg,
        planId: String(anchor.planId),
        vrId: String(anchor.vrid || ''),
        status: 'notArrived',
        trailerId: '',
      };

      let resp = null;
      try {
        resp = await postFetch('/ssp/dock/hrz/ob/fetchdata?', payload, 'OB', { priority: 3 });
      } catch (_) { resp = null; }
      const roots = getObRootNodes(resp);
      if (!Array.isArray(roots) || !roots.length) continue;

      const countPhysicalUnder = (node, out) => {
        const c = node?.container || {};
        const t = String(c?.contType || '').toUpperCase();
        if (t && t !== 'LOAD') {
          out.containers += 1;
          if (t === 'CART') out.byType.CART += 1;
          else if (t === 'PALLET') out.byType.PALLET += 1;
          else if (t === 'GAYLORD') out.byType.GAYLORD += 1;
          // units estimate: use weights consistent with Merge Panel
          const wt = (t === 'PALLET') ? (Number(SETTINGS.palletUnits) || 1.5)
                   : (t === 'GAYLORD') ? (Number(SETTINGS.gaylordUnits) || 1.5)
                   : 1;
          out.units += wt;
          try {
            const lbl = String(c?.label || c?.containerLabel || '').trim();
            if (lbl) out.labels.push(lbl);
          } catch (_) {}
        }
        const kids = node?.childNodes || [];
        if (Array.isArray(kids)) for (const k of kids) countPhysicalUnder(k, out);
      };

      // Attribute physical containers to inbound VRIDs by using OB "LOAD" nodes.
// For status=notArrived, LOAD nodes represent inbound VRIDs feeding this outbound loadGroup.
// The LOAD.containerId is the inbound VRID; its childNodes are the physical containers (CART/GAYLORD/PALLET/etc).
const vridAgg = new Map(); // inboundVrid -> {units, containers, byType, labels, inbLane}

const _norm = (s) => String(s || '').trim().toUpperCase();
const _looksLikeVrid = (s) => /^[0-9A-Z]{6,}$/.test(String(s||'').trim().toUpperCase());

const _addAgg = (vrid, contType, label, inbLane) => {
  if (!vrid) return;
  const t = String(contType || '').toUpperCase();
  // Only count physical containers (do NOT count PACKAGE nodes / packages)
  if (t !== 'CART' && t !== 'PALLET' && t !== 'GAYLORD') return;

  const wt = (t === 'PALLET') ? (Number(SETTINGS.palletUnits) || 1.5)
           : (t === 'GAYLORD') ? (Number(SETTINGS.gaylordUnits) || 1.5)
           : 1;

  let agg = vridAgg.get(vrid);
  if (!agg) {
    agg = { units: 0, containers: 0, byType: { CART: 0, PALLET: 0, GAYLORD: 0 }, labels: [], inbLane: inbLane || '' };
    vridAgg.set(vrid, agg);
  }

  agg.containers += 1;
  agg.units += wt;
  if (t === 'CART') agg.byType.CART += 1;
  else if (t === 'PALLET') agg.byType.PALLET += 1;
  else if (t === 'GAYLORD') agg.byType.GAYLORD += 1;

  try {
    const lbl = String(label || '').trim();
    if (lbl) agg.labels.push(lbl);
  } catch (_) {}
};

const _walkPhysical = (node, vrid, inbLane) => {
  if (!node) return;
  const c = node?.container || {};
  const t = String(c?.contType || '').toUpperCase();
  if (t && t !== 'LOAD') {
    _addAgg(vrid, t, (c?.label || c?.containerLabel || c?.containerId || ''), inbLane);
  }
  const kids = node?.childNodes || [];
  if (Array.isArray(kids)) for (const k of kids) _walkPhysical(k, vrid, inbLane);
};

const _walk = (node) => {
  if (!node) return;
  const c = node?.container || {};
  const t = String(c?.contType || '').toUpperCase();

  if (t === 'LOAD') {
    const vridRaw = _norm(c?.containerId || c?.vrId || c?.label || '');
    const vrid = (__knownIbVrids.has(vridRaw) || _looksLikeVrid(vridRaw)) ? vridRaw : '';
    const inbLane = String(c?.lane || '').trim();

    if (vrid) {
      const kids = node?.childNodes || [];
      if (Array.isArray(kids) && kids.length) {
        for (const k of kids) _walkPhysical(k, vrid, inbLane);
      } else {
        // still record the inbound lane even if no physical children visible
        if (!vridAgg.has(vrid)) vridAgg.set(vrid, { units: 0, containers: 0, byType: { CART: 0, PALLET: 0, GAYLORD: 0 }, labels: [], inbLane });
      }
    }
  }

  const kids = node?.childNodes || [];
  if (Array.isArray(kids)) for (const k of kids) _walk(k);
};

for (const n of roots) _walk(n);



      for (const [vrid, agg] of vridAgg.entries()) {
        const ib = ibByVrid.get(vrid) || null;
        if (!ib || !ib.planId) continue;
          if (String(ib?.status || '').toUpperCase().includes('COMPLETED')) continue;

        const existing = mergeByVrid.get(vrid) || null;
        if (!existing) {
          mergeByVrid.set(vrid, {
            planId: String(ib?.planId || ''),
            vrid,
            status: String(ib?.status || ''),
            eta: String(ib?.estimatedArrivalTime || ''),
            sch: String(ib?.scheduledArrivalTime || ''),
            aat: String(ib?.actualArrivalTime || ''),
            loc: String(ib?._sspLocation || ''),
            inbLane: String(agg.inbLane || ''),
            units: Number(agg.units || 0),
            containers: Number(agg.containers || 0),
            byType: { ...(agg.byType || { CART: 0, PALLET: 0, GAYLORD: 0 }) },
          });
        } else {
          existing.units += Number(agg.units || 0);
          existing.containers += Number(agg.containers || 0);
          const bt = agg.byType || {};
          existing.byType.CART += Number(bt.CART || 0);
          existing.byType.PALLET += Number(bt.PALLET || 0);
          existing.byType.GAYLORD += Number(bt.GAYLORD || 0);
        }
      }
    }

    const rows = Array.from(mergeByVrid.values());
    rows.sort((a, b) => (Number(b.containers || 0) - Number(a.containers || 0)) || String(a.vrid).localeCompare(String(b.vrid)));

    STATE.ibContribByLaneCpt[lgKey] = rows;
    STATE.ibContribTsByLaneCpt[lgKey] = Date.now();

    // If panel is visible, refresh quickly so leaders see inbound without clicking.
    try { if (typeof renderPanel === 'function') renderPanel(); } catch (_) {}
  }


function renderPanel() {
    const s = document.getElementById("ssp2-status");
    const b = document.getElementById("bulk-count");
    const ov = document.getElementById("ov-stat");
    const list = document.getElementById("ssp2-list");
    const lastEl = document.getElementById("last-stat");
    if (!s || !b || !ov) return;
    if (lastEl) lastEl.textContent = STATE.lastRun ? STATE.lastRun.toLocaleTimeString() : "—";

    const qw = getQueryWindows(Date.now());
    const ibGroupsCount = Array.isArray(STATE.ib4cptGroups) ? STATE.ib4cptGroups.length : 0;
    (() => {
      const nowMs = Date.now();
      const ibGroupsCount = Array.isArray(STATE.ib4cptGroups) ? STATE.ib4cptGroups.length : 0;

      // Load-based shift KPIs (Expected/Processed/Remaining are LOADS, not IB4CPT groups or container-units)
      let expectedLoads = null;
      let processedLoads = null;
      let remainingLoads = null;

      try {
        if (typeof _getShiftContext === "function" && typeof _shiftToWindowMs === "function") {
          const ctx = _getShiftContext(nowMs);
          const chosen = ctx && ctx.activeOrUpcoming;
          const baseDay0Ms = ctx && ctx.baseDay0Ms;
          const w = chosen ? _shiftToWindowMs(chosen, baseDay0Ms) : null;
          if (w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs)) {
            let exp = 0;
            let proc = 0;
            for (const l of (STATE?.inboundLoads || [])) {
              const t = (typeof _getLoadTimeForShiftBucketing === "function") ? _getLoadTimeForShiftBucketing(l) : null;
              if (t == null) continue;
              if (t >= w.startMs && t < w.endMs) {
                exp += 1;
                if (String(l?.status || "").toUpperCase() === "COMPLETED") {
                  const at = (typeof _parseInboundTs === "function") ? _parseInboundTs(l?.actualArrivalTime) : null;
                  if (at != null && at >= w.startMs && at < w.endMs) proc += 1;
                }
              }
            }
            expectedLoads = exp;
            processedLoads = proc;
            remainingLoads = Math.max(0, exp - proc);
          }
        }
      } catch (_) {}

      const sh = (typeof _getShiftSummary === "function") ? _getShiftSummary() : null;

      const inboundCount = Array.isArray(STATE.inboundLoadsWindow)
        ? STATE.inboundLoadsWindow.length
        : (Array.isArray(STATE.inboundLoads) ? STATE.inboundLoads.length : 0);

      const partsPlain = [];
      const partsHtml = [];

      const pushPart = (plain, html) => {
        partsPlain.push(plain);
        partsHtml.push(html);
      };

      pushPart(`Inbound loads: ${inboundCount}`, `<span><b>Inbound loads:</b> ${inboundCount}</span>`);
      pushPart(`IB4CPT groups: ${ibGroupsCount}`, `<span><b>IB4CPT groups:</b> ${ibGroupsCount}</span>`);

      if (sh && sh.ok) {
        pushPart(`Shift: ${sh.shiftName} (${sh.label})`, `<span><b>Shift:</b> ${sh.shiftName} (${sh.label})</span>`);

        if (expectedLoads != null && processedLoads != null && remainingLoads != null) {
          pushPart(`Expected: ${expectedLoads}`, `<span><b>Expected:</b> ${expectedLoads}</span>`);
          pushPart(`Processed: ${processedLoads}`, `<span><b>Processed:</b> ${processedLoads}</span>`);
          pushPart(`Remaining: ${remainingLoads}`, `<span><b>Remaining:</b> ${remainingLoads}</span>`);
        } else {
          // fallback to previous container-based stats (only when window calc unavailable)
          pushPart(`Expected: ${sh.expected}`, `<span><b>Expected:</b> ${sh.expected}</span>`);
          pushPart(`Processed: ${sh.processed}`, `<span><b>Processed:</b> ${sh.processed}</span>`);
          pushPart(`Remaining: ${sh.remaining}`, `<span><b>Remaining:</b> ${sh.remaining}</span>`);
        }

        // HC from shift settings (no re-math), Need is delta vs plan
        const hc = Number.isFinite(Number(sh.staffed)) ? Number(sh.staffed) : 0;
        pushPart(`HC: ${hc}`, `<span><b>HC:</b> ${hc}</span>`);

        const d = Number(sh.deltaNeed) || 0;
        const needColor = d > 0 ? "#dc2626" : (d < 0 ? "#2563eb" : "#16a34a");
        pushPart(`Need: ${formatDelta(d)}`, `<span><b>Need:</b> <span style="color:${needColor};font-weight:900;">${formatDelta(d)}</span></span>`);
      }

      pushPart(`Selected VRIDs: ${STATE.bulkSelection.size}`, `<span><b>Selected VRIDs:</b> ${STATE.bulkSelection.size}</span>`);

      const relayStatusLabel = (() => {
        const st = String((STATE.relayConnectivity && STATE.relayConnectivity.state) || "unknown");
        if (st === "connected") return "Relay connected";
        if (st === "fallback") return "Relay fallback";
        if (st === "no_auth") return "Relay not authed";
        if (st === "auth_only") return "Relay auth ready";
        if (st === "error") return "Relay error";
        return "Relay unknown";
      })();
      pushPart(relayStatusLabel, getRelayConnectivityBadgeHtml());

      const sep = ` <span style="opacity:.35;margin:0 8px;">|</span> `;
      const html = partsHtml.join(sep);
      const plain = partsPlain.join(" | ");

      // Persist for header mirror + tooltip.
      s.dataset.statusPlain = plain;
      s.dataset.statusHeaderHtml = html;

      // Keep panel status minimal (we hide it anyway right after mirroring).
      s.textContent = plain;
    })();
// Mirror the status line into the pillar header (condensed), and hide it in the panel to free space.
    try {
      const hs = document.getElementById("ssp2-h-status");
      if (hs && s && typeof s.textContent === "string") {
        hs.innerHTML = (s.dataset && s.dataset.statusHeaderHtml) ? s.dataset.statusHeaderHtml : (s.textContent || "").replace(/\s*\n\s*/g, " | ").trim();
        hs.title = (s.dataset && s.dataset.statusPlain) ? s.dataset.statusPlain : (s.textContent || "");
        // hide in-panel status block (requested: move to header)
        s.style.display = "none";
        const hn = document.getElementById("ssp2-h-node");
        if (hn) hn.textContent = `node: ${(STATE && (STATE.nodeId || STATE.nodeID)) ? (STATE.nodeId || STATE.nodeID) : "—"}`;
      }
    } catch {}
// Update capacity signal buttons (Action Panel)
    try {
      const ms = STATE.mergeStatsByLane || STATE.mergeStats || {};
      const curFilter = String(STATE.mergeFilter || "");
      const defs = [
        ["cancel", "ssp2-cap-cancel", "Cancel"],
        ["adhoc",  "ssp2-cap-adhoc",  "Adhoc"],
        ["risk",   "ssp2-cap-risk",   "Risk"],
        ["now",    "ssp2-cap-now",    "Merge Now"],
        ["soon",   "ssp2-cap-soon",   "Merge Soon"],
      ];

      // Always provide a way back to the unfiltered view.
      const allBtn = document.getElementById("ssp2-cap-all");
      if (allBtn) {
        if (curFilter) {
          allBtn.style.display = "";
          allBtn.textContent = "All";
          allBtn.style.background = "#111827";
          allBtn.style.color = "#fff";
          allBtn.style.borderColor = "#111827";
          allBtn.onclick = () => {
            try { STATE.mergeFilter = ""; renderPanel(); } catch (_) {}
          };
        } else {
          allBtn.style.display = "none";
          allBtn.onclick = null;
        }
      }

      defs.forEach(([key, id, label]) => {
        const el = document.getElementById(id);
        if (!el) return;
        const n = Number(ms[key] || 0);
        const isActive = (curFilter === key);

        // IMPORTANT: keep the active filter button visible even if counts drop to 0,
        // otherwise there is no way to toggle back.
        if (n > 0 || isActive) {
          el.style.display = "";
          el.textContent = (n > 0) ? `${label}: ${n}` : `${label}: 0`;
          el.style.background = isActive ? "#111827" : "#fff";
          el.style.color = isActive ? "#fff" : "#111827";
          el.style.borderColor = isActive ? "#111827" : "#d1d5db";
          el.onclick = () => {
            try {
              const cur = String(STATE.mergeFilter || "");
              STATE.mergeFilter = (cur === key) ? "" : key;
              renderPanel();
            } catch (_) {}
          };
        } else {
          el.style.display = "none";
          el.onclick = null;
        }
      });
    } catch (_) {}
// Update global disruptions widget (Action Panel)
    try {
      const ibEl = document.getElementById("ssp2-disruptions-ib");
      const obEl = document.getElementById("ssp2-disruptions-ob");

      const map = STATE.disruptionsByLaneCpt || {};
      let ibCount = 0;
      for (const k of Object.keys(map)) ibCount += (Array.isArray(map[k]) ? map[k].length : 0);

      if (ibEl) {
        if (ibCount > 0) {
          ibEl.style.display = "";
          ibEl.textContent = `Issues: ${ibCount}`;
        } else {
          ibEl.style.display = "none";
        }
      }

      const obCount = Number.isFinite(Number(STATE._globalOutboundLateCount)) ? Number(STATE._globalOutboundLateCount) : 0;
      if (obEl) {
        if (obCount > 0) {
          obEl.style.display = "";
          obEl.textContent = `Late: ${obCount}`;
        } else {
          obEl.style.display = "none";
        }
      }
    } catch (_) {}
    b.textContent = `Selected: ${STATE.bulkSelection.size}`;
    ov.textContent = `${STATE.overlayStats.matched}/${STATE.overlayStats.scanned}`;
    try { void checkRelayConnectivity({ ttlMs: 120000 }); } catch (_) {}
    // Action list (grouped by Lane -> VRIDs)
    if (list) {
      const esc = (s) =>
        String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");

      const nowMs = Date.now();
      const soonHorizonMs = 6 * 60 * 60 * 1000;

      // CPT lookup for merge state + target carts/load
      const cptMap = STATE.cptUtilization || {};

      // Lane groups
      const groups = new Map();

      const normLane = (l) => String(l || "").trim();

      const { startMs: opsStartMs, endMs: opsEndMs } = getOpsWindow(nowMs);

      const rawOutbound = (STATE.outboundLoads || [])
        // Visibility rule (Action Panel): include all outbound loads except those that are truly gone.
        // Keep "COMPLETED" / "FINISHED_LOADING" visible so leadership can still see what's on deck.
        .filter((l) => {
          const st = String((l?.loadStatus ?? l?.status ?? "")).toUpperCase();
          if (!st) return true;
          if (st.includes("CANCEL")) return false;
          if (st.includes("DEPART")) return false;
          return true;
        });

      const mode = normalizeObLoadType(SETTINGS.obLoadType || "all");

      const loads = getFilteredOutboundLoadsForMode(mode, {
        loads: rawOutbound,
        debugKey: "action-panel",
      })
        .map((l) => {
          const cptMs = toMs(l?.criticalPullTime);
          return {
            vrid: l?.vrId || "",
            lane: normLane(l?.lane || l?.route || ""),
            loadGroupId: String(l?.loadGroupId || "").trim(),
            location: l?.location || "",
            equip: (l?.equipmentType || l?.trailerEquipmentType || l?.trailer?.equipmentType || l?.vehicle?.equipmentType || ""),
            cptMs,
            outsideHorizon: !!(cptMs && (cptMs < opsStartMs || cptMs > opsEndMs)),
            sdtMs: parseSspDateTime(l?.scheduledDepartureTime || l?.scheduleDepartureTime || l?.scheduledDepartTime || l?.scheduleDepartTime || l?.departureTime || ""),
          };
        })
        .filter((x) => x.vrid)
        .filter((x) => {
          if (!x.cptMs) return false;

          // Horizon: keep within ops-day end, but do not show stale CPTs older than 3 hours from "now"
          const lookbackMs = 3 * 60 * 60 * 1000;
          const lowerBound = Math.max(opsStartMs - lookbackMs, nowMs - lookbackMs);

          if (x.cptMs < lowerBound) return false;
          return true;
        });

      for (const x of loads) {
        const laneKey = x.lane || "—";
        const key = laneKey + "::" + String(x.cptMs || 0);

        if (!groups.has(key)) {
          const cpt = cptMap[x.cptMs] || cptMap[String(x.cptMs || 0)] || null;
          groups.set(key, {
            lane: laneKey,
            cptMs: x.cptMs || 0,
            cptStr: fmtTime(x.cptMs),
            mergeState: cpt?.mergeState || "ok",
            requiredPerLoad: Number(cpt?.requiredPerLoad || 0),
            cptCapacity: Number(cpt?.capacity || 0),
            capacityTotal: 0,
            currentUnits: 0,
            remainingLoadsCpt: Number(cpt?.remainingLoads || 0),
            vrids: [],
            loadGroupIds: [],
          });
        }

        const __g = groups.get(key);
        __g.vrids.push(x);
        try {
          const lgid = String(x.loadGroupId || '').trim();
          if (lgid && Array.isArray(__g.loadGroupIds) && !__g.loadGroupIds.includes(lgid)) __g.loadGroupIds.push(lgid);
        } catch (_) {}

// Expose the current Action Panel grouping for the Merge Panel (keyed by "lane::cptMs").
STATE.actionGroups = groups;

// Merge counts by Lane (not by CPT buckets) so the header matches how many distinct lanes you actually have.
      try {
        const rank = { load: 0, ok: 0, soon: 1, now: 2, risk: 3, adhoc: 4, cancel: 5 };
        const laneBest = new Map(); // lane -> bestState
        for (const g of groups.values()) {
          const lane = String(g.lane || "—");
          const st = String(g.mergeState || "load");
          const cur = laneBest.get(lane) || "load";
          const rNew = (rank[st] != null) ? rank[st] : 0;
          const rCur = (rank[cur] != null) ? rank[cur] : 0;
          if (rNew > rCur) laneBest.set(lane, st);
        }

        const counts = { load: 0, ok: 0, soon: 0, now: 0, risk: 0, adhoc: 0, cancel: 0 };
        for (const st of laneBest.values()) {
          const k = String(st || "load");
          if (counts[k] != null) counts[k]++; else counts.load++;
        }
        STATE.mergeStatsByLane = counts;
      } catch (_) {}
      }

      const stateLabel = (st) =>
        st === "cancel" ? "CANCEL" :
        st === "adhoc" ? "ADHOC" :
        st === "risk" ? "RISK" :
        st === "now" ? "MERGE NOW" :
        st === "soon" ? "MERGE SOON" :
        st === "load" ? "LOAD" : "OK";
      const stateColor = (st) =>
        st === "cancel" ? "#6b7280" :
        st === "adhoc" ? "#7c3aed" :
        st === "risk" ? "#ef4444" :
        st === "now" ? SETTINGS.colorNow :
        st === "soon" ? SETTINGS.colorSoon :
        SETTINGS.colorOk;
      const capLabel = (pct) => (pct >= 100 ? "CAP FULL" : pct >= 80 ? "CAP RISK" : "OK");
      const capColor = (pct) => (pct >= 100 ? "#dc2626" : pct >= 80 ? "#f59e0b" : SETTINGS.colorOk);
      // Compute per-group Capacity (sum of trailer capacities for VRIDs) and Current Units (Available+Loaded+Inbound from table)
      const groupAgg = STATE.groupAgg || {};
      for (const [groupKey, g] of groups.entries()) {
        // capacityTotal: sum unique VRIDs in group
        const seen = new Set();
        let capTotal = 0;
        for (const v of (g.vrids || [])) {
          const vrid = String(v.vrid || v.vrId || "").trim();
          if (!vrid || seen.has(vrid)) continue;
          seen.add(vrid);
          const idx = STATE.vridIndex && STATE.vridIndex[vrid];
          capTotal += Number(idx?.capacity || 0);
        }
        g.capacityTotal = capTotal;

        // Current Units (in-facility) should reflect *physical handling units* for the outbound loadGroupId.
        // Inbound Units should reflect only upstream/notArrived volume (yard/on-door/in-transit) for the same loadGroupId.
        // Loaded Units remains authoritative per-VRID (OB loaded).
        const agg = groupAgg[groupKey] || null;

        let loadedSum = 0;
        const lgSeen = new Set();
        let currentSum = 0;
        let inboundSum = 0;
        let cuPending = false;
        let ibPending = false;

        for (const v of (g.vrids || [])) {
          const vrid = String(v.vrid || v.vrId || "").trim();
          if (!vrid) continue;

          const lu = Number(STATE.vridLoadedUnits && STATE.vridLoadedUnits[vrid]);
          if (Number.isFinite(lu) && lu > 0) loadedSum += lu;

          const idx = (STATE.vridIndex && STATE.vridIndex[vrid]) || null;
          const lg = String(idx?.loadGroupId || "").trim();
          if (!lg || lgSeen.has(lg)) continue;
          lgSeen.add(lg);

          // inFacility: physical containers in-facility (received/stacked/staged/loaded)
          const curCached = getLatestLoadGroupStatusCache(lg, "inFacility");
          if (curCached && curCached.ts) {
            currentSum += Number(curCached.totalUnits || 0);
          } else {
            cuPending = true;
            fetchContainerDetailsForLoadGroupId(lg, { planId: idx?.planId || "", trailerId: idx?.trailerId || "", vrid }, 'inFacility')
              .then(() => { /* cache populated */ })
              .catch(() => { /* ignore */ });
          }

          // notArrived: upstream volume only
          const ibCached = getLatestLoadGroupStatusCache(lg, "notArrived");
          if (ibCached && ibCached.ts) {
            inboundSum += Number(ibCached.totalUnits || 0);
          } else {
            ibPending = true;
            fetchContainerDetailsForLoadGroupId(lg, { planId: idx?.planId || "", trailerId: idx?.trailerId || "", vrid }, 'notArrived')
              .then(() => { /* cache populated */ })
              .catch(() => { /* ignore */ });
          }
        }

        let currentUnits = currentSum;

        // Prefer cached OB-derived Current Units (loadGroupContainerCache), but fall back to CPT-derived aggregates (groupAgg)
        // when OB stats are pending/unavailable.
        if (groupKey && STATE.groupAgg && STATE.groupAgg[groupKey]) {
          const ga = STATE.groupAgg[groupKey];
          if ((cuPending || currentUnits == null) && typeof ga.currentUnits === "number") {
            currentUnits = ga.currentUnits;
            cuPending = false;
          }
          if ((ibPending || inboundSum == null) && typeof ga.inboundUnits === "number") {
            inboundSum = ga.inboundUnits;
            ibPending = false;
          }
          g.inboundVridCount = ga.inboundVrids && ga.inboundVrids.size ? ga.inboundVrids.size : 0;
        } else {
          g.inboundVridCount = 0;
        }

        g.loadedUnits = loadedSum;
        g.currentUnits = currentUnits;
        g.inboundUnits = inboundSum;
        g.currentUnitsPending = cuPending;
        g.inboundUnitsPending = ibPending;
        g.remainingUnits = Math.max(0, Number(g.capacityTotal || 0) - Number(currentUnits || 0));
        // Compute lane-level merge/capacity state (DO NOT inherit CPT-level state; CPT buckets can mix lanes).
        try {
          const capTotal = Math.max(0, Number(g.capacityTotal || 0));
          const loads = Math.max(1, new Set((g.vrids || []).map(v => String(v.vrid || v.vrId || "").trim()).filter(Boolean)).size || 0);
          const capPer = capTotal && loads ? (capTotal / loads) : (Number(SETTINGS.cap53ftCarts) || 36);

          const loaded = Number(g.loadedUnits || 0);

          // Same adjustment as the UI: "Current" should exclude LOADED when the upstream source already includes it.
          let curAdj = Number(g.currentUnits || 0);
          if (loaded > 0 && curAdj >= loaded && (curAdj - loaded) <= capTotal) curAdj = Math.max(0, curAdj - loaded);

          const upstream = Number(g.inboundUnits || 0);

          const hardWarn = Number(SETTINGS.capHardWarnPct ?? 0.90);
          const soonPct  = Number(SETTINGS.capMergeSoonPct ?? 0.85);
          const nowPct   = Number(SETTINGS.capMergeNowPct ?? 1.00);
          const riskPct  = Number(SETTINGS.capRiskPct ?? 1.00);

          const baseWRaw = Number(SETTINGS.mergeInboundWeight);
          const baseW = Number.isFinite(baseWRaw) ? Math.max(0, Math.min(baseWRaw, 0.50)) : 0.35;

          const minsToCpt = Number.isFinite(Number(g.cptMs))
            ? Math.round((Number(g.cptMs) - Date.now()) / 60000)
            : NaN;

          let inboundW = baseW;
          if (Number.isFinite(minsToCpt)) {
            if (minsToCpt > 180) inboundW = Math.min(inboundW, 0.15);
            else if (minsToCpt > 90) inboundW = Math.min(inboundW, 0.25);
            else if (minsToCpt > 45) inboundW = Math.min(inboundW, baseW);
            else inboundW = Math.max(inboundW, 0.50);
          }

          const facility = loaded + curAdj;
          const projUnits = facility + inboundW * upstream;

          const hardPct = capTotal ? (facility / capTotal) : 0;
          const projPct = capTotal ? (projUnits / capTotal) : 0;
          const overage = Math.max(0, projUnits - capTotal);

          const adhocOver = Math.max(0, Number(SETTINGS.adhocOverageUnits ?? 8));
          const cancelLeadMin = Math.max(0, Number(SETTINGS.cancelLeadMinutes ?? 120));
          const cancelHorizonMin = Math.max(0, Number(SETTINGS.cancelShowHorizonMinutes ?? 360));
          const cancelMinObserved = Math.max(0, Number(SETTINGS.cancelMinObservedUnits ?? 6));

          const neededLoadsRaw = Math.ceil(projUnits / capPer);
          const neededLoads = (projUnits <= 0.01) ? 0 : Math.max(1, neededLoadsRaw);
          const cancelLoads = Math.max(0, loads - neededLoads);

          let st = "load";

          if (cancelLoads > 0 && Number.isFinite(minsToCpt) && minsToCpt >= cancelLeadMin && minsToCpt <= cancelHorizonMin) {
            const observedUnits = facility + upstream;
            if (observedUnits >= cancelMinObserved || minsToCpt <= 90) st = "cancel";
          }

          if (overage >= adhocOver) st = "adhoc";

          if (hardPct >= riskPct || projPct >= (riskPct + 0.10)) st = "risk";

          if (hardPct >= hardWarn && projPct >= nowPct) st = "now";
          else if (projPct >= soonPct && st === "load") st = "soon";

          g.mergeState = st;
          g.mergeMeta = { capTotal, loads, capPer, loaded, current: curAdj, upstream, inboundW, hardPct, projPct, overage, neededLoads, cancelLoads, minsToCpt };
        } catch (_) {}

      }


      const sortedGroups = Array.from(groups.values()).sort((a, b) => {
        if ((a.cptMs || 0) !== (b.cptMs || 0)) return (a.cptMs || 0) - (b.cptMs || 0);

        return String(a.lane).localeCompare(String(b.lane));
      });


      // Update pill counts (scoped to current Loads dropdown selection)
      // NOTE: count by *lane*, not lane+CPT buckets, so the header reflects real-world lane count.
      const laneStates = new Map(); // lane -> "now" | "soon" | "ok"
      const rank = (st) => (st === "now" ? 2 : st === "soon" ? 1 : 0);
      for (const g of sortedGroups) {
        const lane = String(g?.lane || "—");
        const st = String(g?.mergeState || "ok");
        const cur = laneStates.get(lane) || "ok";
        if (rank(st) > rank(cur)) laneStates.set(lane, st);
      }
      const stats = { now: 0, soon: 0, ok: 0 };
      for (const st of laneStates.values()) {
        if (st === "now") stats.now++;
        else if (st === "soon") stats.soon++;
        else stats.ok++;
      }
      const cntNow = document.getElementById("cnt-now");
      const cntSoon = document.getElementById("cnt-soon");
      const cntOk = document.getElementById("cnt-ok");
      if (cntNow) cntNow.textContent = String(stats.now);
      if (cntSoon) cntSoon.textContent = String(stats.soon);
      if (cntOk) cntOk.textContent = String((stats.load ?? stats.ok ?? 0));


      // Apply capacity filter (now/soon/risk/adhoc/cancel/load) if set
      let filteredGroups = sortedGroups;
      if (STATE.mergeFilter) {
        filteredGroups = sortedGroups.filter(g => g.mergeState === STATE.mergeFilter);
      }

      // Preload inbound VRIDs contributing to each lane (no-click visibility)
      try { _prefetchIbContribForGroups(filteredGroups.slice(0, 40)); } catch (_) {}
      try { _prefetchCuForGroups(filteredGroups.slice(0, 25)); } catch (_) {}
if (DEBUG.laneGroups) {
        dlog("LANE_GROUPS_SUMMARY", {
          loadsCount: loads.length,
          groupCount: sortedGroups.length,
          groupsShownLimit: 40,
        });
      }

      if (DEBUG.laneGroupsFull) {
        dgroup("[SSP UTIL][LANE_GROUPS FULL] Lane::CPT → VRIDs", () => {
          sortedGroups.forEach(g => {
            console.groupCollapsed(`GROUP ${g.lane} | CPT ${g.cptStr} | merge=${g.mergeState} | vrids=${g.vrids.length}`);
            console.log("group:", {
              lane: g.lane,
              cptStr: g.cptStr,
              cptMs: g.cptMs,
              mergeState: g.mergeState,
              targetPerLoad: g.targetPerLoad,
              capacity: g.capacity,
              remainingLoadsCpt: g.remainingLoadsCpt,
            });
            console.log("vrids:", g.vrids.map(v => ({
              vrid: v.vrid,
              lane: v.lane,
              location: v.location,
              equip: v.equip,
              cptStr: fmtTime(v.cptMs),
            })));
            console.groupEnd();
          });
        });
      }

      // Helpers for panel actions
      const mkBtn = (label, data, title) =>
        `<button class="ssp2-act" data-act="${esc(data)}" title="${esc(title || "")}"          style="padding:2px 8px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">          ${esc(label)}        </button>`;

      const groupHtml = filteredGroups
        .slice(0, 40)
        .map((g, idx) => {
          const capTotal = Number(g.capacityTotal || 0);

          const vridRows = g.vrids
            .sort((a, b) => {
              const am = Number(a.sdtMs || (STATE.vridIndex && STATE.vridIndex[a.vrid]?.sdtMs) || 0);
              const bm = Number(b.sdtMs || (STATE.vridIndex && STATE.vridIndex[b.vrid]?.sdtMs) || 0);
              if (am && bm && am !== bm) return am - bm;
              if (am && !bm) return -1;
              if (!am && bm) return 1;
              return String(a.vrid).localeCompare(String(b.vrid));
            })
            .map((v) => {
              const laneTxt = g.lane !== "—" ? g.lane : v.lane || "—";
              const idxMeta = (STATE.vridIndex && STATE.vridIndex[v.vrid]) ? STATE.vridIndex[v.vrid] : {};
              const locTxt = v.location ? ` <span style="color:#6b7280;">@ ${esc(v.location)}</span>` : "";
              const doorTxt = idxMeta.dockDoor ? ` <span style="color:#6b7280;">| ${esc(idxMeta.dockDoor)}</span>` : "";
              const trTxt = idxMeta.trailerNumber ? ` <span style="color:#6b7280;">| ${esc(idxMeta.trailerNumber)}</span>` : "";
              const eq = equipShort(v.equip);
              const eqBadge = eq !== "—" ? ` <span style=\"margin-left:6px;padding:2px 8px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;font-size:12px;\">${esc(eq)}</span>` : "";
              const cap = Number((STATE.vridIndex && STATE.vridIndex[v.vrid])?.capacity || 0);
              const curRaw = (STATE.vridUnits && Object.prototype.hasOwnProperty.call(STATE.vridUnits, v.vrid)) ? STATE.vridUnits[v.vrid] : null;
              const curTxt = (curRaw === null || curRaw === undefined) ? "—" : String(Number(curRaw) || 0);
              const utilBadge = cap ? ` <span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:#111827;color:#fff;font-weight:900;font-size:12px;">${curTxt}/${cap}</span>` : "";
              return `                <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-top:1px solid #f3f4f6;">                  <div style="font-weight:900;">                    ${esc(v.vrid)}${utilBadge}${eqBadge} <span class="ssp-relay-meta" data-vrid="${esc(v.vrid)}" style="margin-left:6px;"><span style="color:#9ca3af;font-weight:800;">—</span></span>${locTxt}${doorTxt}${trTxt}                    <div style="margin-top:2px;color:#6b7280;font-weight:800;">${esc(laneTxt)}</div>                  </div>                  <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center;">                    ${mkBtn("TT", "tt:" + v.vrid, "Open TT for VRID")}                    ${mkBtn("Relay", "relay:" + v.vrid, "Open Relay for VRID")}                    ${mkBtn("FMC", "fmc:" + v.vrid, "Open FMC for VRID")}                    ${mkBtn("Select", "sel:" + v.vrid, "Toggle SSP row checkbox")}                  </div>                </div>              `;
            })
            .join("");

          // cache lane->vrids for lane map panel
          try {
            STATE.__laneCptToVrids = STATE.__laneCptToVrids || {};
            STATE.__laneCptToVrids[`${String(g.lane||"")}|${Number(g.cptMs||0)}`] = g.vrids.map(x => String(x.vrid||x.vrId||"").trim()).filter(Boolean);
          } catch (_) {}


          // Action Panel should mirror ops-relevant buckets:
          // Capacity (planned), Loaded (on trailer), Current (in-facility), Inbound (not-arrived).
          // NOTE: Current/Inbound are populated asynchronously from OB fetchdata and cached.
          const __groupKey = _cuGroupKey(g.lane, g.cptMs);
          const __cu = (STATE.cuByGroupKey && STATE.cuByGroupKey[__groupKey]) ? STATE.cuByGroupKey[__groupKey] : null;
          const __cuUnits = (__cu && !__cu.loading && !__cu.error) ? Number(__cu.units || 0) : null;
          const curDisp = (__cuUnits === null || Number.isNaN(__cuUnits))
            ? (g.currentUnitsPending ? "…" : String(Number(g.currentUnits || 0)))
            : String(__cuUnits);
          const inbDisp = g.inboundUnitsPending ? "…" : String(Number(g.inboundUnits || 0));
          const curNum = (__cuUnits === null || __cuUnits === undefined || Number.isNaN(__cuUnits))
            ? (g.currentUnitsPending ? null : Number(g.currentUnits || 0))
            : Number(__cuUnits || 0);
          const pct = (capTotal > 0 && curNum !== null && !Number.isNaN(curNum)) ? Math.round((curNum / capTotal) * 100) : 0;
          const pctDisp = (!capTotal || curNum === null) ? "…" : String(pct);

          // Display utilization as (Loaded + Current + Inbound*w) / Capacity when mergeMeta is available.
          const __mm = g && g.mergeMeta ? g.mergeMeta : null;
          const __utilDen = (__mm && Number.isFinite(__mm.capTotal) && __mm.capTotal > 0) ? Number(__mm.capTotal) : (capTotal > 0 ? Number(capTotal) : 0);
          const __utilNum = (__mm && __utilDen)
            ? (Number(__mm.loaded || 0) + Number(__mm.current || 0) + (Number(__mm.inboundW || 0) * Number(__mm.upstream || 0)))
            : (Number(g.loadedUnits || 0) + (curNum === null ? 0 : Number(curNum || 0)));
          const __utilPct = (__utilDen > 0) ? Math.round((__utilNum / __utilDen) * 100) : 0;
          const __utilFactorDisp = (__utilDen > 0 && Number.isFinite(__utilNum))
            ? `${__utilNum.toFixed(1)}/${__utilDen} (${__utilPct}%)`
            : "…";

          const ibVridsDisp = (g.inboundVridCount && Number(g.inboundVridCount) > 0) ? ` • VRIDs: <b>${Number(g.inboundVridCount)}</b>` : ``;
          const sub =
            g.capacityTotal
              ? `Capacity: <b>${g.capacityTotal}</b> units | Loaded: <b>${g.loadedUnits || 0}</b> | Current: <b>${curDisp}</b> units | Inbound: <b>${inbDisp}</b> units${ibVridsDisp} <span style="color:#6b7280;">| Util: <b>${__utilFactorDisp}</b></span>`
              : `Capacity: —`;


          // Inline inbound VRIDs contributing (prefetched; falls back to count when empty)
          const __ibKey = _ibContribKey(g.lane, g.cptMs);
          const __ibRows = (STATE.ibContribByLaneCpt && STATE.ibContribByLaneCpt[__ibKey]) ? STATE.ibContribByLaneCpt[__ibKey] : [];
          const __ibTs = (STATE.ibContribTsByLaneCpt && STATE.ibContribTsByLaneCpt[__ibKey]) ? Number(STATE.ibContribTsByLaneCpt[__ibKey]||0) : 0;

          const ibContribHtml = '';
// Disruptions indicator (empty until we have lates/slips)
const __dkey = _ibContribKey(g.lane, g.cptMs);
const __dis = (typeof computeDisruptionsForLaneCpt === 'function') ? computeDisruptionsForLaneCpt(g.lane, g.cptMs) : [];
try {
  STATE.disruptionsByLaneCpt = STATE.disruptionsByLaneCpt || {};
  STATE.disruptionsByLaneCpt[__dkey] = Array.isArray(__dis) ? __dis : [];
} catch (_) {}
const __sev = (() => {
  let mx = 0;
  for (const x of (__dis || [])) {
    const m = Number(x?.minutes || 0);
    if (x?.kind === "LATE" || x?.kind === "ARRIVED_LATE") mx = Math.max(mx, 2);
    else if (x?.kind === "ETA_SLIP") mx = Math.max(mx, 1);
    if (m >= 60) mx = Math.max(mx, 3);
  }
  return mx;
})();
const __dColor = (__sev >= 3) ? "#dc2626" : (__sev === 2) ? "#f59e0b" : "#60a5fa";
const disruptDotHtml = (__dis && __dis.length)
  ? `<span class="disrupt-dot open-disruptions" data-lane="${esc(g.lane)}" data-cpt="${g.cptMs}" title="Disruptions: ${__dis.length}" style="cursor:pointer;width:12px;height:12px;border-radius:999px;display:inline-block;border:1px solid #e5e7eb;background:${__dColor};"></span>`
  : ``;


// // Outbound cases badge: number of VRIDs on this lane/CPT with >=1 FMC case
const __caseKey = _ibContribKey(g.lane, g.cptMs);
const __caseVridCount = (STATE.obCaseVridCountByLaneCpt && typeof STATE.obCaseVridCountByLaneCpt[__caseKey] === "number")
  ? STATE.obCaseVridCountByLaneCpt[__caseKey]
  : 0;

return `            <details ${idx == 0 ? "open" : ""} style="border:1px solid #e5e7eb;border-radius:12px;padding:10px;margin-bottom:8px;background:#fff;">              <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px;">                <div style="font-weight:900;">                  <span class="ssp-open-lane-map" data-lane="${esc(g.lane)}" data-cpt="${g.cptMs}" style="cursor:pointer;text-decoration:underline;">${esc(g.lane)}</span> (${fmtCptLabel((g && g.cptMs) || (lane && lane.cptMs) || cptMs)})                  <div style="margin-top:2px;color:#111827;font-weight:800;">${sub}</div>${ibContribHtml}                  <div style="margin-top:2px;color:#6b7280;font-weight:800;">Loads shown: ${g.vrids.length} | CPT remaining loads: ${g.remainingLoadsCpt}</div>                </div>                <div style="display:flex;gap:6px;align-items:center;">
	                  <span class="cap-dot open-merge" data-lane="${esc(g.lane)}" data-cpt="${g.cptMs}" title="Capacity: ${capLabel(pct)} (${pct}%)" style="cursor:pointer;width:12px;height:12px;border-radius:999px;display:inline-block;border:1px solid #e5e7eb;background:${capColor(pct)};"></span>
<span class="merge-dot open-merge" data-lane="${esc(g.lane)}" data-cpt="${g.cptMs}" title="Merge: ${stateLabel(g.mergeState)}" style="cursor:pointer;width:12px;height:12px;border-radius:999px;display:inline-block;border:1px solid #e5e7eb;background:${stateColor(g.mergeState)};"></span>
${disruptDotHtml}
	                </div>              </summary>              <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px;">                <button class="open-cases" data-lane="${esc(g.lane)}" data-cpt="${g.cptMs}" title="Open lane cases" style="cursor:pointer;padding:4px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;">Cases${__caseVridCount ? ` (${__caseVridCount})` : ``}</button>                <button class="open-merge" data-lane="${esc(g.lane)}" data-cpt="${g.cptMs}" title="Open lane details" style="cursor:pointer;padding:4px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;">Details</button>              </div>              <div style="margin-top:8px;">${vridRows}</div>            </details>          `;
        })
        .join("");

      STATE.dockOppsOpen = true;

      list.innerHTML =
        `<div style="font-weight:900;margin-bottom:8px;">Dock Opportunities (Lane → VRIDs)</div>` +
        (groupHtml || `<div style="color:#6b7280;">No outbound loads detected (or outside horizon).</div>`);
      // Prefetch Relay badges (cases/disruptions/notes) for visible VRIDs (non-blocking).
      // We keep a conservative cap to avoid hammering Track, but aim to cover what's on-screen.
      try {
        const vv = [];
        for (const g of filteredGroups.slice(0, 16)) {
          for (const x of (g.vrids || []).slice(0, 6)) {
            const id = String(x.vrid || x.vrId || "").trim();
            if (id) vv.push(id);
          }
        }
        _sspPrefetchRelayMetaBadges(vv, 48);
      } catch (_) {}


      // attach one delegated handler
      if (!list.dataset.ssp2Bound) {
        list.dataset.ssp2Bound = "1";
        list.addEventListener("click", (e) => {

          // Lane label click: open lane VRID list (Relay-backed) for quick planning glance.
          const laneSpan = e.target && e.target.closest ? e.target.closest(".ssp-open-lane-map") : null;
          if (laneSpan) {
            e.preventDefault();
            e.stopPropagation();
            const lane = laneSpan.getAttribute("data-lane") || "";
            const cpt = Number(laneSpan.getAttribute("data-cpt") || 0);
            try { openLaneMapPanel(lane, cpt); } catch (_) { window.open("https://track.relay.amazon.dev/", "_blank", "noopener"); }
            return;
          }
const dis = e.target.closest(".open-disruptions");
 if (dis) {
   e.preventDefault();
   e.stopPropagation();
   const lane = dis.getAttribute("data-lane") || "";
   const cpt = Number(dis.getAttribute("data-cpt") || 0);
   if (typeof openDisruptionsPanel === "function") openDisruptionsPanel(lane, cpt);
   return;
 }

 const cas = e.target.closest(".open-cases");
 if (cas) {
   e.preventDefault();
   e.stopPropagation();
   const lane = cas.getAttribute("data-lane") || "";
   const cpt = Number(cas.getAttribute("data-cpt") || 0);
   if (typeof openRelayCasesPanel === "function") openRelayCasesPanel(lane, cpt);
   return;
 }

 const chip = e.target.closest(".open-merge");
if (chip) {
  e.preventDefault();
  e.stopPropagation();
  const lane = chip.getAttribute("data-lane") || "";
  const cpt = Number(chip.getAttribute("data-cpt") || 0);
  openMergePanel(lane, cpt);
  return;
}

          const btn = e.target.closest("button.ssp2-act");
          if (!btn) return;
          e.preventDefault();
          e.stopPropagation();

          const act = btn.getAttribute("data-act") || "";
          const parts = act.split(":");
          const kind = parts[0];
          const vrid = parts.slice(1).join(":");
          if (!vrid) return;

          if (DEBUG.clickActions) {
            dlog("CLICK_ACTION", { kind, vrid, nodeId: STATE.nodeId });
          }

          const open = (url) => window.open(url, "_blank", "noopener");

          if (kind === "tt") open(buildTTUrl(STATE.nodeId, vrid));
          else if (kind === "relay") {
            // Default: open RelayMini (hover-style) for quick glance. Shift-click: open Relay in a new tab.
            try {
              if (e.shiftKey) return open(buildRelayUrl(vrid));
              _showRelayMiniForAnchor(btn, vrid, (STATE && (STATE.nodeId || STATE.nodeID)) || "");
              // Prefetch badges for this VRID immediately
              try { _sspPrefetchRelayMetaBadges([vrid], 1); } catch(_) {}
            } catch (err) {
              open(buildRelayUrl(vrid));
            }
          }
          else if (kind === "fmc") open(buildFmcUrl(vrid));
          else if (kind === "sel") {
            // toggle native SSP checkbox in the main dashboard row
            const table = document.querySelector("table#dashboard") || document.querySelector("table.dataTable");
            const tbody = table && table.querySelector("tbody");
            if (!tbody) return;

            const tr = Array.from(tbody.querySelectorAll("tr")).find((r) => (r.innerText || "").includes(vrid));
            if (!tr) return;

            const cb = tr.querySelector("input[type='checkbox']");
            if (cb) cb.click();
          }
        });
      }
    }
  }




  /* =====================================================
     PLANNING PANEL (Inbound Preview + Shift Window Filters)
     - Shows ops-window inbound loads with dropdown filters for shift windows
     - Hosts CSV IB CART + IB4CPT exports (moved from Action Panel)
  ====================================================== */
  function _getEnabledShifts() {
    return (SHIFT_SETTINGS?.shifts || []).filter(s => s && s.enabled);
  }

  function _getShiftContext(nowMs) {
    const baseDay0Ms = _getShiftBaseDay0Ms(nowMs);
    const enabledShifts = _getEnabledShifts();
    const activeOrUpcoming = _getActiveOrUpcomingShift(nowMs, baseDay0Ms, enabledShifts);
    return { baseDay0Ms, enabledShifts, activeOrUpcoming };
  }


  function _getActiveOrUpcomingShift(nowMs, baseDay0Ms, enabledShifts) {
    const enabled = Array.isArray(enabledShifts) ? enabledShifts : _getEnabledShifts();
    if (!enabled.length) return null;

    let active = null;
    let upcoming = null;
    let minToStart = Infinity;

    for (const s of enabled) {
      const w = _shiftToWindowMs(s, baseDay0Ms);
      if (!w) continue;
      if (nowMs >= w.startMs && nowMs < w.endMs) { active = s; break; }
      const toStart = w.startMs - nowMs;
      if (toStart > 0 && toStart < minToStart) { minToStart = toStart; upcoming = s; }
    }
    return active || upcoming || enabled[0];
  }

  function _getLoadTimeForPlanning(load) {
    // Prefer actual, then scheduled, then estimated.
    return (
      parseSspDateTime(load?.actualArrivalTime) ||
      parseSspDateTime(load?.scheduledArrivalTime) ||
      parseSspDateTime(load?.estimatedArrivalTime) ||
      toMs(load?.actualArrivalTime) ||
      toMs(load?.scheduledArrivalTime) ||
      toMs(load?.estimatedArrivalTime) ||
      0
    );
  }


  function _getLoadLocationForPlanning(l) {
    // Planning rows may be either:
    //  - the raw load object, OR
    //  - a getInboundDockView wrapper: { load: {...}, resource: [...] , ... }
    const load = l?.load || l;

    // Authoritative dock-door assignment for getInboundDockView is wrapper.resource[0].label
    const candidates = [
      l?.resource?.[0]?.label,
      l?.resource?.[0]?.resId,
      load?._sspLocation,

      // Common load-level fields (fallbacks)
      load?.location,
      load?.dockDoor,
      load?.dockDoorLabel,
      load?.dockDoorId,
      load?.door,
      load?.doorLabel,
      load?.resourceLabel,
      load?.resourceId,
      load?.assignedDockDoor,
      load?.assignedDoor,
      load?.currentLocation,
      load?.yardLocation,
      load?.stagingLocation,
      load?.destDockDoor,
      load?.inboundDoor,
      load?.inboundDockDoor,
      load?.doorName,

      // Occasionally embedded on load
      load?.resource?.[0]?.label,
      load?.resource?.[0]?.resId,

      // Rare but sometimes populated
      load?.recommendedLoadingDoorLabel,
    ];

    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s) return s;
    }
    return "";
  }




    // Bulk inbound container counts resolver for Planning panel (single call; cached)
  // Source: entity=getInboundContainerCount
  async function ensurePlanningInboundContainerCount(planIds) {
    try {
      const ids = Array.from(new Set((planIds || []).map(x => String(x || "").trim()).filter(Boolean)));
      if (!ids.length) return;
      if (STATE.__planIbCountInflight) return;

      const have = STATE?.ibContainerCount && typeof STATE.ibContainerCount === "object" ? STATE.ibContainerCount : null;
      if (have && ids.every(id => have[id])) return;

      STATE.__planIbCountInflight = true;

      const nodeId = String(STATE?.nodeId || STATE?.nodeID || "").trim();
      if (!nodeId) return;

      const r = await postFetch(
        "/ssp/dock/hrz/ib/fetchdata?",
        {
          entity: "getInboundContainerCount",
          nodeId,
          inboundLoadIds: ids.join(","),
        },
        "IB_PLAN",
        { priority: 3 }
      );

      const map = r?.ret?.inboundContainerCount;
      if (map && typeof map === "object") {
        STATE.ibContainerCount = Object.assign({}, (STATE.ibContainerCount || {}), map);
      }
    } catch (e) {
      console.warn("Planning ensurePlanningInboundContainerCount failed", e);
    } finally {
      STATE.__planIbCountInflight = false;
      try { renderPlanningPanel(); } catch {}
    }
  }

function _getLoadContainersLeftForPlanning(l) {
    const planId = String(l?.planId || "").trim();
    if (!planId) return "";

    // Preferred: bulk inboundContainerCount (inTrailerCount)
    const m = STATE?.ibContainerCount?.[planId];
    if (m && typeof m === "object") {
      const it = m?.inTrailerCount || {};
      const total = m?.totalCount || m?.total || {};
      // Convention: P=packages, C=containers
      const c = (typeof it?.C === "number") ? it.C : null;

      // Prefer TOTAL package count for planning/disruptions (inTrailer packages are often 0 even when total exists)
      const pTotal = (typeof total?.P === "number") ? total.P : null;
      const pInTrailer = (typeof it?.P === "number") ? it.P : null;
      const p = (pTotal != null) ? pTotal : pInTrailer;

      if (p != null) {
        STATE.__planPkgs = STATE.__planPkgs || {};
        STATE.__planPkgs[planId] = p;
      }
if (c != null) return String(c);
      // If C missing but counts exist, return blank (avoid misleading)
      return "";
    }

    // Fallbacks (rare): if load already has embedded counts
    const n =
      Number(l?.inTrailerCount?.C) ||
      Number(l?.inTrailerCountC) ||
      Number(l?.containerCountInTrailer) ||
      0;
    return n ? String(n) : "";
  }

function _findShiftByKey(key) {
    const k = String(key || "").trim();
    const shifts = _getEnabledShifts();
    return shifts.find(s => String(s.key || "").trim() === k)
        || shifts.find(s => String(s.name || s.label || "").trim() === k)
        || null;
  }

  
function _updatePlanSortIndicators(panel) {
  try {
    const PLAN = (window.__SSP_PLAN__ = window.__SSP_PLAN__ || { sort: { key: "status", dir: "asc" } });
    const keys = ["vrid","planId","route","status","cntrsLeft","scheduled","eta","arrived","equip","loc"];
    const ths = panel.querySelectorAll("#ssp2-plan-table thead th");
    ths.forEach((th, i) => {
      const k = keys[i];
      if (!k) return;

      th.style.cursor = "pointer";
      th.style.userSelect = "none";
      th.style.whiteSpace = "nowrap";

      let lab = th.querySelector(".ssp2-th-label");
      let arr = th.querySelector(".ssp2-sort-arrow");
      if (!lab || !arr) {
        const raw = th.textContent;
        th.innerHTML = `<span class="ssp2-th-label">${raw}</span> <span class="ssp2-sort-arrow" style="font-size:10px;opacity:.35;"></span>`;
        lab = th.querySelector(".ssp2-th-label");
        arr = th.querySelector(".ssp2-sort-arrow");
      }

      if (PLAN.sort && PLAN.sort.key === k) {
        arr.textContent = PLAN.sort.dir === "desc" ? "▼" : "▲";
        arr.style.opacity = "1";
        th.style.fontWeight = "900";
      } else {
        arr.textContent = "";
        arr.style.opacity = ".35";
        th.style.fontWeight = "800";
      }
    });
  } catch {}
}



function _sspRelayLaneLabel(detail) {
  try {
    const lanes = detail && detail.lanes;
    if (Array.isArray(lanes) && lanes.length) {
      const full = lanes[2] || lanes.find(x => String(x||"").includes("→")) || "";
      const s = String(full || "").trim();
      if (s) return s.replace(/\s+/g, "");
    }
  } catch {}
  try {
    const stops = (detail && detail.stops) || [];
    const a = stops[0] && stops[0].location && stops[0].location.nodeCode;
    const b = stops[stops.length-1] && stops[stops.length-1].location && stops[stops.length-1].location.nodeCode;
    if (a && b) return `${a}→${b}`;
  } catch {}
  return "";
}

function _sspRelayNextStop(detail) {
  try {
    const stops = (detail && detail.stops) || [];
    for (const s of stops) {
      const a = (s && s.arrival) || {};
      const done = !!(a.completionTime || a.actualTime || a.completedTime);
      if (!done) return s;
    }
    return stops[stops.length-1] || null;
  } catch { return null; }
}

function _sspRelayExtractCoordinates(root) {
  // Finds first plausible coordinates array [[lng,lat], ...] within an object tree.
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      // coordinate pairs array?
      if (cur.length >= 2 && Array.isArray(cur[0]) && cur[0].length >= 2) {
        const ok = (x) => x != null && isFinite(Number(x));
        const a = cur[0], b = cur[1];
        if (ok(a[0]) && ok(a[1]) && ok(b[0]) && ok(b[1])) return cur;
      }
      for (const v of cur) stack.push(v);
      continue;
    }

    if (cur.geometry && cur.geometry.coordinates) stack.push(cur.geometry.coordinates);
    if (cur.coordinates) stack.push(cur.coordinates);

    for (const k in cur) {
      if (!Object.prototype.hasOwnProperty.call(cur, k)) continue;
      stack.push(cur[k]);
    }
  }
  return null;
}

// --- Relay mini map + details (CORS via GM_xmlhttpRequest) ---
function _sspRelayRequest(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    try {
      const auth = _sspGetTrackAuthHeader();
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: timeoutMs,
        anonymous: false,
        withCredentials: true,
        headers: {
          "Accept": "application/json, text/plain, */*",
          ...(auth ? { "Authorization": auth } : {}),
          "Origin": "https://track.relay.amazon.dev",
          "Referer": "https://track.relay.amazon.dev/"
        },
        onload: (res) => {
          if (!res) return reject(new Error("No response"));
          const ok = res.status >= 200 && res.status < 300;
          if (!ok) return reject(new Error(`HTTP ${res.status}`));
          resolve(res.responseText || "");
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Timeout"))
      });
    } catch (e) { reject(e); }
  });
}



// Relay search: fetch a list of transport-views by a lane search term over a time window.
// Uses the same /api/v2/transport-views endpoint used by Track & Trace.
async function _sspRelaySearchTransportViews(searchTerm, startMs, endMs) {
  const term = String(searchTerm||'').trim();
  if (!term) return [];
  if (!_sspGetTrackAuthHeader()) throw new Error('NO_TRACK_AUTH');

  const fmtDate = (ms) => {
    const d = new Date(ms);
    const y = String(d.getFullYear());
    const m = String(d.getMonth()+1).padStart(2,'0');
    const da = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${da}`;
  };
  const fmtTime = (ms) => {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const ss = String(d.getSeconds()).padStart(2,'0');
    return `${hh}:${mm}:${ss}`;
  };

  const sMs = Number.isFinite(startMs) ? startMs : (Date.now()-12*60*60*1000);
  const eMs = Number.isFinite(endMs) ? endMs : (Date.now()+6*60*60*1000);

  const startDate = fmtDate(sMs);
  const endDate = fmtDate(eMs);
  const startTime = fmtTime(sMs);
  const endTime = fmtTime(eMs);

  const fetchPage = async (page) => {
    const u = new URL('https://track.relay.amazon.dev/api/v2/transport-views');
    const qs = u.searchParams;
    qs.append('searchTerm[]', term);
    qs.append('type[]', 'vehicleRun');
    qs.set('module', 'trip');
    qs.set('page', String(page||1));
    qs.set('pageSize', '200');
    qs.set('sortCol', 'sent');
    qs.set('ascending', 'true');
    qs.set('startDate', startDate);
    qs.set('endDate', endDate);
    qs.set('startTime', startTime);
    qs.set('endTime', endTime);
    qs.set('column', 'scheduled_end');
    qs.set('view', 'detail');
    qs.set('dateField', 'effectiveEnd');

    const txt = await _sspRelayRequest(u.toString(), 12000);
    const data = JSON.parse(txt || 'null');

    // common shapes: array, {content:[]}, {results:[]}, {transportViews:[]}, {items:[]}
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.content)) return data.content;
    if (data && Array.isArray(data.results)) return data.results;
    if (data && Array.isArray(data.transportViews)) return data.transportViews;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  };

  const out = [];
  const maxPages = 3;
  for (let page=1; page<=maxPages; page++) {
    const chunk = await fetchPage(page);
    if (!chunk || !chunk.length) break;
    out.push(...chunk);
    if (chunk.length < 200) break;
  }
  return out;
}

// FMC fallback (same-origin) when track.relay.amazon.dev is not accessible (401/403).
// Returns the first execution-like object for a VRID if found.
async function _sspFmcGetExecutionById(vrid) {
  const v = String(vrid||"").trim();
  if (!v) return null;

  const payload = {
    searchIds: [v],
    searchByIds: true,
    page: 0,
    pageSize: 10,
    bookmarkedSavedSearch: false,
    executionViewModePreference: "vrs",
    // Keep dashboardPreferences minimal but present (some environments require it)
    dashboardPreferences: JSON.stringify({
      length: 10,
      order: [[12, "asc"]],
      search: { search: "", columns: [], statuses: [], filters: [] }
    })
  };

  const resp = await sspFetch("https://trans-logistics.amazon.com/fmc/search/execution/by-id", {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, 2);

  if (!resp || !resp.ok) {
    const st = resp ? resp.status : 0;
    throw new Error(`HTTP ${st}`);
  }

  const data = await resp.json().catch(()=>null);
  if (!data) return null;

  // Try common shapes.
  const candidates =
    (Array.isArray(data.executions) ? data.executions : null) ||
    (Array.isArray(data.content) ? data.content : null) ||
    (Array.isArray(data.results) ? data.results : null) ||
    (data.data && Array.isArray(data.data.executions) ? data.data.executions : null) ||
    (data.page && Array.isArray(data.page.content) ? data.page.content : null) ||
    null;

  const first = candidates && candidates.length ? candidates[0] : null;
  if (first && typeof first === "object") {
    try { first.__sspSource = "FMC"; } catch(_) {}
    return first;
  }

  // Some versions return an object keyed by vrid.
  if (data[v] && typeof data[v] === "object") {
    try { data[v].__sspSource = "FMC"; } catch(_) {}
    return data[v];
  }
  return null;
}

function _sspRelayParseIsoToLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  // show local time like 01:45
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}

// cache: { [vrid]: { t:ms, detail:{...}, route:[{lat,lng}...] } }
function _sspRelayCache() {
  window.__SSP_RELAY_CACHE__ = window.__SSP_RELAY_CACHE__ || {};
  return window.__SSP_RELAY_CACHE__;
}

async function _sspRelayGetDetail(vrid, opts = {}) {
  const v = String(vrid||"").trim();
  if (!v) return null;
  const allowFmcFallback = opts && opts.allowFmcFallback === false ? false : true;
  const key = `NA:VR:${v}`;
  const cache = _sspRelayCache();
  const now = Date.now();
  const hit = cache[v] && cache[v].detail && (now - (cache[v].tDetail||0) < 60_000);
  if (hit) {
    const src = String(cache[v]?.detail?.__sspSource || "").toUpperCase();
    if (!allowFmcFallback && src === "FMC") throw new Error("Relay detail unavailable (cached FMC fallback).");
    return cache[v].detail;
  }

  // Prefer track.relay.amazon.dev when accessible; fallback to FMC if unauthorized.
  // If we ever see 401/403 from track.relay, permanently disable it for the session.
  if (window.__SSP_DISABLE_TRACK_RELAY__ === true) {
    if (!allowFmcFallback) throw new Error("Relay detail unavailable (Track blocked).");
    const obj = await _sspFmcGetExecutionById(v);
    cache[v] = cache[v] || {};
    cache[v].detail = obj;
    cache[v].tDetail = now;
    return obj;
  }

  try {
    // Track Relay endpoints require an Authorization bearer token.
    // If we haven't seen the Relay SPA make a Track request yet, we won't have it.
    if (!_sspGetTrackAuthHeader()) {
      throw new Error("NO_TRACK_AUTH");
    }
    const url = `https://track.relay.amazon.dev/api/v2/transport-views/${encodeURIComponent(key)}?view=detail`;
    const txt = await _sspRelayRequest(url);
    const obj = JSON.parse(txt);
    cache[v] = cache[v] || {};
    cache[v].detail = obj;
    cache[v].tDetail = now;
    return obj;
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : "";
    if (/NO_TRACK_AUTH/i.test(msg)) {
      // Don't disable track permanently; we just haven't captured the token yet.
      throw new Error("Relay detail needs Track auth. Open the VRID in Relay once (the 'Open' button) then retry.");
    }
    const isAuth = /HTTP\s*(401|403)/i.test(msg) || /unauthor/i.test(msg) || /forbidden/i.test(msg);
    if (isAuth) {
      // If we have an auth token and still get 401/403, assume Track is blocked for this session.
      // (If no token exists, we should have hit NO_TRACK_AUTH above.)
      window.__SSP_DISABLE_TRACK_RELAY__ = true;
      if (!allowFmcFallback) throw new Error("Relay detail blocked (track HTTP 401/403).");
      try {
        const obj = await _sspFmcGetExecutionById(v);
        cache[v] = cache[v] || {};
        cache[v].detail = obj;
        cache[v].tDetail = now;
        return obj;
      } catch (e2) {
        const msg2 = (e2 && e2.message) ? String(e2.message) : String(e2);
        throw new Error(`Relay detail blocked (track HTTP 401/403). FMC fallback failed: ${msg2}`);
      }
    }
    throw e;
  }
}

async function checkRelayConnectivity(opts = {}) {
  try {
    const now = Date.now();
    const force = !!opts.force;
    const ttlMs = Number(opts.ttlMs || 120000);
    const cached = STATE.relayConnectivity || { state: "unknown", checkedAt: 0, via: "none", message: "" };

    if (!force && cached.checkedAt && (now - cached.checkedAt) < ttlMs) return cached;
    if (!force && STATE.relayConnectivityInflight) return await STATE.relayConnectivityInflight;

    const inflight = (async () => {
      const auth = (typeof _sspGetTrackAuthHeader === "function") ? _sspGetTrackAuthHeader() : null;
      if (!auth) {
        const out = { state: "no_auth", checkedAt: Date.now(), via: "none", message: "Relay Track auth missing" };
        STATE.relayConnectivity = out;
        return out;
      }

      const sampleVrid = String(opts.vrid || ((Array.isArray(STATE.outboundLoads) ? STATE.outboundLoads : []).find((l) => String(l?.vrId || l?.vrid || "").trim())?.vrId || "")).trim();
      if (!sampleVrid) {
        const out = { state: "auth_only", checkedAt: Date.now(), via: "token", message: "Track auth present; no VRID sample available" };
        STATE.relayConnectivity = out;
        return out;
      }

      try {
        const detail = await _sspRelayGetDetail(sampleVrid);
        const src = String(detail?.__sspSource || "").toUpperCase();
        if (src === "FMC") {
          const out = { state: "fallback", checkedAt: Date.now(), via: "fmc", message: `Track unavailable; using FMC fallback (${sampleVrid})` };
          STATE.relayConnectivity = out;
          return out;
        }
        const out = { state: "connected", checkedAt: Date.now(), via: "track", message: `Relay Track connected (${sampleVrid})` };
        STATE.relayConnectivity = out;
        return out;
      } catch (e) {
        const msg = String((e && e.message) || e || "");
        const out = /Track auth/i.test(msg)
          ? { state: "no_auth", checkedAt: Date.now(), via: "none", message: "Relay Track auth missing" }
          : { state: "error", checkedAt: Date.now(), via: "none", message: msg.slice(0, 220) };
        STATE.relayConnectivity = out;
        return out;
      }
    })();

    STATE.relayConnectivityInflight = inflight;
    const out = await inflight;
    STATE.relayConnectivityInflight = null;
    return out;
  } catch (e) {
    const out = { state: "error", checkedAt: Date.now(), via: "none", message: String((e && e.message) || e || "relay connectivity check failed") };
    STATE.relayConnectivity = out;
    STATE.relayConnectivityInflight = null;
    return out;
  }
}

function getRelayConnectivityBadgeHtml() {
  try {
    const rc = STATE.relayConnectivity || {};
    const st = String(rc.state || "unknown");
    const colors = {
      connected: ["#16a34a", "#ecfdf5"],
      fallback: ["#f59e0b", "#fffbeb"],
      no_auth: ["#6b7280", "#f9fafb"],
      auth_only: ["#2563eb", "#eff6ff"],
      error: ["#dc2626", "#fef2f2"],
      unknown: ["#6b7280", "#f9fafb"],
    };
    const pair = colors[st] || colors.unknown;
    const label = st === "connected" ? "Relay: Connected" :
      st === "fallback" ? "Relay: FMC fallback" :
      st === "no_auth" ? "Relay: Not authed" :
      st === "auth_only" ? "Relay: Auth ready" :
      st === "error" ? "Relay: Error" : "Relay: Unknown";
    const title = String(rc.message || label).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<span title="${title}" style="padding:2px 8px;border-radius:999px;border:1px solid ${pair[0]};background:${pair[1]};color:${pair[0]};font-weight:900;">${label}</span>`;
  } catch (_) {
    return `<span style="padding:2px 8px;border-radius:999px;border:1px solid #6b7280;background:#f9fafb;color:#6b7280;font-weight:900;">Relay: Unknown</span>`;
  }
}

async function _sspRelayGetRoute(vrid) {
  const v = String(vrid||"").trim();
  if (!v) return null;
  const cache = _sspRelayCache();
  const now = Date.now();
  const hit = cache[v] && cache[v].route && (now - (cache[v].tRoute||0) < 5*60_000);
  if (hit) return cache[v].route;

  const key = `NA:VR:${v}`;

  // Track route endpoints also require Track auth. If we haven't captured it yet,
  // just return null (the mini will display "No route points").
  if (!_sspGetTrackAuthHeader()) {
    return null;
  }

  // 1) planned polyline
  let pts = null;
  try {
    const url1 = `https://track.relay.amazon.dev/api/crs-routing/${encodeURIComponent(key)}?getPlanned=true`;
    const txt1 = await _sspRelayRequest(url1);
    const arr = JSON.parse(txt1);
    if (Array.isArray(arr) && arr.length >= 2 && arr[0] && typeof arr[0] === "object" && ("lat" in arr[0]) && ("lng" in arr[0])) {
      pts = arr.map(p => ({ lat: Number(p.lat), lng: Number(p.lng) })).filter(p => isFinite(p.lat) && isFinite(p.lng));
    }
  } catch {}

  // 2) fallback: map-match coordinates (often [[lng,lat], ...])
  if (!pts || pts.length < 2) {
    try {
      const url2 = `https://track.relay.amazon.dev/api/crs-routing/map-match/${encodeURIComponent(key)}`;
      const txt2 = await _sspRelayRequest(url2);
      const obj = JSON.parse(txt2);
      const coords = _sspRelayExtractCoordinates(obj);
      if (Array.isArray(coords) && coords.length >= 2 && Array.isArray(coords[0])) {
        pts = coords.map(c => ({ lat: Number(c[1]), lng: Number(c[0]) })).filter(p => isFinite(p.lat) && isFinite(p.lng));
      }
    } catch {}
  }

  cache[v] = cache[v] || {};
  cache[v].route = (pts && pts.length >= 2) ? pts : null;
  cache[v].tRoute = now;
  return cache[v].route;
}


// --- Relay supplemental endpoints (notes, cases, disruptions) ---
// Notes endpoint observed: GET /api/transport-views/NA:VR:<vrid>/notes  (non-v2)
async function _sspRelayGetNotes(vrid) {
  const v = String(vrid||"").trim();
  if (!v) return null;
  const cache = _sspRelayCache();
  const now = Date.now();
  cache[v] = cache[v] || {};
  if (cache[v].notes && (now - (cache[v].tNotes||0) < 5*60_000)) return cache[v].notes;

  if (!_sspGetTrackAuthHeader()) return null;
  try {
    const key = `NA:VR:${v}`;
    const url = `https://track.relay.amazon.dev/api/transport-views/${encodeURIComponent(key)}/notes`;
    const txt = await _sspRelayRequest(url);
    const obj = JSON.parse(txt);
    cache[v].notes = obj;
    cache[v].tNotes = now;
    return obj;
  } catch (_) {
    return null;
  }
}

function _sspRelayExtractCases(detail) {
  try {
    if (!detail) return [];
    const direct = detail.cases;
    if (Array.isArray(direct)) return direct;

    const candidates = [
      detail.caseSummaries,
      detail.issues,
      detail.issueSummaries,
      detail.returnedObject?.cases,
      detail.returnedObject?.caseSummaries,
      detail.returnedObject,
      detail.case,
      detail.issue,
      Array.isArray(detail.items) ? detail.items.map((x) => x?.case || x?.issue || x).filter(Boolean) : null,
    ];

    for (const c of candidates) {
      if (Array.isArray(c)) {
        const mapped = c.map((x) => x?.case || x?.issue || x).filter((x) => x && typeof x === "object");
        if (mapped.length) return mapped;
      }
      if (c && typeof c === "object" && (c.caseId || c.id || c.caseStatus || c.status)) {
        return [c];
      }
    }
    return [];
  } catch { return []; }
}

function _sspRelayExtractDisruptions(detail) {
  try {
    const d = detail && detail.disruptions;
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function _sspRelayExtractNotesCount(notesObj) {
  try {
    if (!notesObj) return 0;
    if (Array.isArray(notesObj)) return notesObj.length;
    if (Array.isArray(notesObj.notes)) return notesObj.notes.length;
    if (Array.isArray(notesObj.content)) return notesObj.content.length;
    return 0;
  } catch { return 0; }
}

// Compute a lightweight "meta badge" summary for a VRID (used in Action Panel rows)
async function _sspRelayGetMetaBadges(vrid) {
  const v = String(vrid||"").trim();
  if (!v) return null;
  try {
    const detail = await _sspRelayGetDetail(v);
    const cases = _sspRelayExtractCases(detail);
    const disruptions = _sspRelayExtractDisruptions(detail);
    // Notes are optional; do not block the UI if they fail.
    let notesCount = 0;
    try { notesCount = _sspRelayExtractNotesCount(await _sspRelayGetNotes(v)); } catch (_) {}
    const topDis = (disruptions && disruptions.length)
      ? (disruptions.find(x => String(x?.severity||"").toUpperCase()==="HIGH") || disruptions[0])
      : null;
    return {
      vrid: v,
      casesCount: cases.length,
      disruptionsCount: disruptions.length,
      notesCount,
      topDisruptionType: topDis ? (topDis.type || topDis.id || "") : "",
      topDisruptionSeverity: topDis ? (topDis.severity || "") : ""
    };
  } catch (e) {
    // If we don't have Track auth yet, keep quiet; the mini already tells the user how to seed it.
    const msg = (e && e.message) ? String(e.message) : "";
    if (/Track auth/i.test(msg) || /needs Track auth/i.test(msg)) return null;
    return null;
  }
}

function _sspUpdateRelayMetaBadgesInDom(meta) {
  if (!meta || !meta.vrid) return;
  const v = String(meta.vrid);
  const nodes = document.querySelectorAll(`.ssp-relay-meta[data-vrid="${CSS.escape(v)}"]`);
  if (!nodes || !nodes.length) return;

  const mkBadge = (kind, label, title, bg) => {
    const b = bg || "#111827";
    return `<button class="ssp-relay-badge" data-kind="${esc(kind)}" data-vrid="${esc(v)}" title="${esc(title||"")}" onclick="return window.__SSP_RELAY_BADGE_HANDLER ? window.__SSP_RELAY_BADGE_HANDLER(event) : false;"
      style="padding:1px 8px;border-radius:999px;border:1px solid #e5e7eb;background:${b};color:#fff;font-weight:900;cursor:pointer;pointer-events:auto;">${esc(label)}</button>`;
  };

  for (const el of nodes) {
    const parts = [];
    // Disruptions: indicator only (no per-VRID count in UI)
    if (meta.disruptionsCount) {
      const sev = String(meta.topDisruptionSeverity||"").toUpperCase();
      const col = (sev === "HIGH") ? "#dc2626" : (sev === "MEDIUM") ? "#f59e0b" : "#60a5fa";
      parts.push(mkBadge("disruptions", "D", `Disruptions present (${meta.disruptionsCount}) ${meta.topDisruptionType||""}`, col));
    }
    // Cases: keep count (useful), but clickable
    if (meta.casesCount) {
      parts.push(mkBadge("cases", `C:${meta.casesCount}`, `Cases (${meta.casesCount})`, "#111827"));
    }
    // Notes: keep count, clickable
    if (meta.notesCount) {
      parts.push(mkBadge("notes", `N:${meta.notesCount}`, `Notes (${meta.notesCount})`, "#2563eb"));
    }
    el.innerHTML = parts.length ? parts.join(" ") : `<span style="color:#9ca3af;font-weight:800;">—</span>`;
  }
}

async function _sspPrefetchRelayMetaBadges(vrids, max=10) {
  try {
    const arr = Array.from(new Set((vrids||[]).map(v => String(v||"").trim()).filter(Boolean))).slice(0, max);
    if (!arr.length) return;
    STATE.__relayMetaCache = STATE.__relayMetaCache || {};
    for (const v of arr) {
      if (STATE.__relayMetaCache[v] && (Date.now() - (STATE.__relayMetaCache[v].t||0) < 2*60_000)) {
        _sspUpdateRelayMetaBadgesInDom(STATE.__relayMetaCache[v].meta);
        continue;
      }
      // Run in the background; don't block render
      (async () => {
        const meta = await _sspRelayGetMetaBadges(v);
        if (!meta) return;
        STATE.__relayMetaCache[v] = { t: Date.now(), meta };
        _sspUpdateRelayMetaBadgesInDom(meta);
      })();
    }
  } catch (_) {}
}


async function _sspPrefetchLaneRisk(laneKey, cptMs, vrids) {
  try {
    const lane = String(laneKey||"");
    const cpt = Number(cptMs||0);
    const el = document.querySelector(`.ssp-relay-risk[data-lane="${CSS.escape(lane)}"][data-cpt="${String(cpt)}"]`);
    if (!el) return;

    // Search-driven banner: use base lane (LDJ5->DBK6) and a window around CPT.
    const laneBase = (lane.split('-')[0] || lane).trim();
    const anchor = cpt || Date.now();
    const startMs = anchor - 12*60*60*1000;
    const endMs = anchor + 6*60*60*1000;

    let items = null;
    try { items = await _sspRelaySearchTransportViews(laneBase, startMs, endMs); } catch (_) { items = null; }
    if (!Array.isArray(items) || !items.length) { el.innerHTML = ""; return; }

    const seen = new Set();
    let casesV = 0, disV = 0;
    const need = [];

    for (const it of items.slice(0, 240)) {
      const v = String(it?.vrid || it?.id || it?.qualifiedVrid || it?.qualifiedId || "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);

      const hasCases = Array.isArray(it?.cases) ? (it.cases.length>0) : null;
      const hasDis = Array.isArray(it?.disruptions) ? (it.disruptions.length>0) : null;

      if (hasCases === true) casesV++;
      if (hasDis === true) disV++;

      if (hasCases === null || hasDis === null) need.push(v);
    }

    // If search results don't include cases/disruptions, fetch detail for a limited subset.
    if (need.length) {
      const max = Math.min(need.length, 50);
      for (let i=0;i<max;i++) {
        const v = need[i];
        try {
          const d = await _sspRelayGetDetail(v);
          if (!d) continue;
          if ((_sspRelayExtractCases(d)||[]).length) casesV++;
          if ((_sspRelayExtractDisruptions(d)||[]).length) disV++;
        } catch (_) {}
      }
    }

    if (!casesV && !disV) { el.innerHTML = ""; return; }

    const parts = [];
    if (casesV) parts.push(`<span class="ssp-risk-pill" title="VRIDs w/ cases" style="padding:1px 8px;border-radius:999px;border:1px solid #e5e7eb;background:#111827;color:#fff;font-weight:900;cursor:pointer;" data-kind="laneCases" data-lane="${esc(lane)}" data-cpt="${String(cpt)}">Cases:${casesV}</span>`);
    if (disV) parts.push(`<span class="ssp-risk-pill" title="VRIDs w/ disruptions" style="padding:1px 8px;border-radius:999px;border:1px solid #e5e7eb;background:#dc2626;color:#fff;font-weight:900;cursor:pointer;" data-kind="laneDisruptions" data-lane="${esc(lane)}" data-cpt="${String(cpt)}">Risk:${disV}</span>`);
    el.innerHTML = parts.join(" ");
  } catch (_) {}
}

// Click handlers for lane risk pills (reuses existing panels)
document.addEventListener("click", (e) => {
  const pill = e.target.closest(".ssp-risk-pill");
  if (!pill) return;
  e.preventDefault(); e.stopPropagation();
  const kind = pill.getAttribute("data-kind") || "";
  const lane = pill.getAttribute("data-lane") || "";
  const cpt = Number(pill.getAttribute("data-cpt") || 0);
  if (kind === "laneCases") { if (typeof openRelayCasesPanel === "function") openRelayCasesPanel(lane, cpt); }
  if (kind === "laneDisruptions") { if (typeof openDisruptionsPanel === "function") openDisruptionsPanel(lane, cpt); }
}, true);

function _sspWarnRelayOverlayMissingOnce(context, missingIds) {
  try {
    if (window.__SSP_RELAY_OVERLAY_MISSING_WARNED) return;
    window.__SSP_RELAY_OVERLAY_MISSING_WARNED = true;
    const miss = Array.isArray(missingIds) && missingIds.length
      ? ` Missing: ${missingIds.join(", ")}.`
      : "";
    console.warn(`[SSP] Relay overlay host nodes missing (${String(context || "unknown")}). Expected ssp-relay-vrid-overlay contract.${miss}`);
  } catch (_) {}
}

function _sspEnsureRelayVridOverlay() {
  try {
    let overlay = document.getElementById("ssp-relay-vrid-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ssp-relay-vrid-overlay";
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(2,6,23,.55);display:none;align-items:center;justify-content:center;padding:14px;";
      overlay.innerHTML = `
        <div id="ssp-relay-vrid-panel" style="width:min(1100px,96vw);max-height:92vh;overflow:hidden;background:#f8fafc;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 25px 90px rgba(2,6,23,.45);display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#111827;color:#e5e7eb;border-bottom:1px solid #0b1220;">
            <div id="ssp-relay-vrid-title" style="font-weight:900;">Relay detail</div>
            <button id="ssp-relay-vrid-close" style="margin-left:auto;cursor:pointer;padding:5px 10px;border-radius:999px;border:1px solid #475569;background:#0b1220;color:#e5e7eb;font-weight:900;">Close</button>
          </div>
          <div id="ssp-relay-vrid-body" style="padding:0;overflow:auto;max-height:calc(92vh - 56px);"></div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => { overlay.style.display = "none"; };
      overlay.querySelector("#ssp-relay-vrid-close")?.addEventListener("click", close);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      if (!window.__SSP_RELAY_VRID_ESC_BOUND) {
        window.__SSP_RELAY_VRID_ESC_BOUND = true;
        document.addEventListener("keydown", (ev) => {
          if (ev.key !== "Escape") return;
          const ov = document.getElementById("ssp-relay-vrid-overlay");
          if (ov && ov.style.display !== "none") ov.style.display = "none";
        });
      }
    }

    const title = document.getElementById("ssp-relay-vrid-title");
    const body = document.getElementById("ssp-relay-vrid-body");
    if (!overlay || !title || !body) {
      const missing = [];
      if (!overlay) missing.push("#ssp-relay-vrid-overlay");
      if (!title) missing.push("#ssp-relay-vrid-title");
      if (!body) missing.push("#ssp-relay-vrid-body");
      _sspWarnRelayOverlayMissingOnce("_sspEnsureRelayVridOverlay", missing);
      return null;
    }
    return { overlay, title, body };
  } catch (_) {
    _sspWarnRelayOverlayMissingOnce("_sspEnsureRelayVridOverlay:exception", []);
    return null;
  }
}

function _sspRelayToLocalDateTime(raw) {
  try {
    if (raw == null || raw === "") return "";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw);
    return d.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (_) {
    return String(raw || "");
  }
}

function _sspRelayExtractNotesList(notesObj) {
  try {
    if (!notesObj) return [];
    if (Array.isArray(notesObj)) return notesObj.filter(Boolean);
    if (Array.isArray(notesObj.notes)) return notesObj.notes.filter(Boolean);
    if (Array.isArray(notesObj.content)) return notesObj.content.filter(Boolean);
    if (Array.isArray(notesObj.items)) return notesObj.items.filter(Boolean);
    return [];
  } catch (_) {
    return [];
  }
}

function _sspRelayPhonetoolHref(userValue) {
  const userRaw = String(userValue || "").trim();
  if (!userRaw) return { label: "Unknown user", href: "" };
  const alias = userRaw.includes("@") ? userRaw.split("@")[0] : userRaw;
  const href = alias ? `https://phonetool.amazon.com/users/${encodeURIComponent(alias)}` : "";
  return { label: userRaw, href };
}

function _sspRelayRenderNotesHtml(notesObj) {
  const items = _sspRelayExtractNotesList(notesObj)
    .map((x) => (x && typeof x === "object") ? x : { content: String(x || "") })
    .sort((a, b) => {
      const ams = new Date(a?.createdDate || a?.createdTime || a?.createdAt || 0).getTime() || 0;
      const bms = new Date(b?.createdDate || b?.createdTime || b?.createdAt || 0).getTime() || 0;
      return bms - ams;
    });

  if (!items.length) {
    return `<div style="padding:12px;color:#6b7280;">No notes on this VRID.</div>`;
  }

  const rows = items.map((n, idx) => {
    const external = (n?.externallyVisible === true) || (String(n?.externallyVisible || "").toLowerCase() === "true");
    const createdRaw = n?.createdDate || n?.createdTime || n?.createdAt || "";
    const created = _sspRelayToLocalDateTime(createdRaw);
    const contentRaw = n?.content ?? n?.note ?? n?.text ?? n?.description ?? "";
    const content = (contentRaw && typeof contentRaw === "object")
      ? JSON.stringify(contentRaw)
      : String(contentRaw || "").trim();
    const userRaw =
      (n?.user && typeof n.user === "object")
        ? (n.user.login || n.user.user || n.user.email || n.user.alias || n.user.name || "")
        : (n?.user || n?.createdBy || n?.author || "");
    const user = _sspRelayPhonetoolHref(userRaw);
    const cardBg = external ? "#eff6ff" : "#f8fafc";
    const cardBd = external ? "#60a5fa" : "#d1d5db";
    const metaTag = external
      ? `<span style="color:#1d4ed8;font-weight:900;">(Visible to Carrier and any drivers)</span>`
      : "";
    const userHtml = user.href
      ? `<a href="${esc(user.href)}" target="_blank" rel="noopener" style="color:#1d4ed8;text-decoration:underline;font-weight:900;">${esc(user.label)}</a>`
      : `<span style="font-weight:900;color:#111827;">${esc(user.label)}</span>`;
    const createdHtml = created ? esc(created) : "Unknown time";
    const bodyHtml = content
      ? esc(content).replace(/\n/g, "<br>")
      : `<span style="color:#9ca3af;">(No note content)</span>`;

    return `
      <div style="border:1px solid ${cardBd};background:${cardBg};border-radius:12px;padding:10px 12px;${idx ? "margin-top:8px;" : ""}">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:#111827;">
          ${userHtml}
          <span style="color:#6b7280;font-weight:800;">- ${createdHtml}</span>
          ${metaTag}
        </div>
        <div style="margin-top:8px;color:#111827;white-space:normal;line-height:1.35;">${bodyHtml}</div>
      </div>
    `;
  }).join("");

  return `
    <div style="padding:10px;">
      <div style="font-weight:900;color:#111827;margin-bottom:6px;">Notes (${items.length})</div>
      ${rows}
    </div>
  `;
}

function _sspRelayRenderDisruptionsHtml(disruptions) {
  const arr = Array.isArray(disruptions) ? disruptions.filter((x) => x && typeof x === "object") : [];
  if (!arr.length) {
    return `<div style="padding:12px;color:#6b7280;">No disruptions on this VRID.</div>`;
  }

  const sevRank = (sev) => {
    const s = String(sev || "").toUpperCase();
    if (s === "HIGH" || s === "SEV1" || s === "CRITICAL") return 0;
    if (s === "MEDIUM" || s === "SEV2") return 1;
    if (s === "LOW" || s === "SEV3") return 2;
    return 3;
  };
  const sevColor = (sev) => {
    const s = String(sev || "").toUpperCase();
    if (s === "HIGH" || s === "SEV1" || s === "CRITICAL") return ["#7f1d1d", "#fecaca", "#b91c1c"];
    if (s === "MEDIUM" || s === "SEV2") return ["#78350f", "#fde68a", "#b45309"];
    if (s === "LOW" || s === "SEV3") return ["#1e3a8a", "#bfdbfe", "#2563eb"];
    return ["#374151", "#e5e7eb", "#4b5563"];
  };
  const toMs = (v) => {
    const t = new Date(v || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  const now = Date.now();
  const mapped = arr.map((d) => {
    const severity = String(d?.severity || d?.priority || "UNKNOWN").toUpperCase();
    const status = String(d?.status || "").toUpperCase();
    const createdRaw = d?.createdTime || d?.createdDate || d?.createdAt || "";
    const lastRaw = d?.lastModifiedTime || d?.modifiedTime || d?.updatedAt || "";
    const impactRaw = d?.impactTime || d?.endTime || d?.untilTime || "";
    const impactMs = toMs(impactRaw);
    const statusActive = status === "ACTIVE";
    const withinImpactWindow = !impactMs || impactMs > now;
    const isActive = statusActive && withinImpactWindow;
    return {
      raw: d,
      severity,
      status,
      id: String(d?.id || d?.disruptionId || "").trim(),
      type: String(d?.type || d?.disruptionType || "UNKNOWN").trim(),
      createdRaw,
      lastRaw,
      impactRaw,
      createdMs: toMs(createdRaw),
      lastMs: toMs(lastRaw),
      isActive
    };
  });

  const active = mapped
    .filter((d) => d.isActive)
    .sort((a, b) =>
      (sevRank(a.severity) - sevRank(b.severity)) ||
      (b.createdMs - a.createdMs) ||
      (b.lastMs - a.lastMs)
    );
  const inactiveCount = mapped.length - active.length;

  if (!active.length) {
    return `<div style="padding:12px;color:#6b7280;">No active disruptions right now.${inactiveCount ? ` (${inactiveCount} inactive or impact window elapsed)` : ""}</div>`;
  }

  const grouped = new Map();
  for (const d of active) {
    const key = d.severity || "UNKNOWN";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(d);
  }
  const order = Array.from(grouped.keys()).sort((a, b) => sevRank(a) - sevRank(b));

  const groupsHtml = order.map((severity) => {
    const items = grouped.get(severity) || [];
    const col = sevColor(severity);
    const cards = items.map((d) => {
      const created = _sspRelayToLocalDateTime(d.createdRaw);
      const lastMod = _sspRelayToLocalDateTime(d.lastRaw);
      const impact = _sspRelayToLocalDateTime(d.impactRaw);
      const idText = d.id ? `#${esc(d.id)}` : "(no id)";
      const typeText = d.type || "UNKNOWN";
      return `
        <div style="border:1px solid #d1d5db;border-radius:12px;background:#ffffff;padding:10px;">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <span style="font-weight:900;color:#111827;">${esc(typeText)}</span>
            <span style="color:#6b7280;font-weight:800;">${idText}</span>
            <span style="margin-left:auto;padding:1px 8px;border-radius:999px;border:1px solid #86efac;background:#dcfce7;color:#166534;font-weight:900;">Active</span>
          </div>
          <div style="margin-top:6px;color:#374151;font-weight:800;font-size:12px;">Created: ${esc(created || "Unknown")}</div>
          <div style="margin-top:2px;color:#374151;font-weight:800;font-size:12px;">Last modified: ${esc(lastMod || "Unknown")}</div>
          <div style="margin-top:2px;color:#374151;font-weight:800;font-size:12px;">Active until: ${esc(impact || "Unknown")}</div>
        </div>
      `;
    }).join("");

    return `
      <div style="border:1px solid ${col[1]};background:#f9fafb;border-radius:12px;padding:10px;${severity === order[0] ? "" : "margin-top:10px;"}">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="padding:2px 8px;border-radius:999px;border:1px solid ${col[2]};background:${col[1]};color:${col[0]};font-weight:900;">${esc(severity)}</span>
          <span style="color:#6b7280;font-weight:800;">${items.length} active disruption${items.length === 1 ? "" : "s"}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">${cards}</div>
      </div>
    `;
  }).join("");

  return `
    <div style="padding:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <div style="font-weight:900;color:#111827;">Active Disruptions (${active.length})</div>
        ${inactiveCount ? `<div style="margin-left:auto;color:#6b7280;font-weight:800;font-size:12px;">${inactiveCount} inactive/expired hidden</div>` : ""}
      </div>
      ${groupsHtml}
    </div>
  `;
}

/* =============================
 * Global click handling for Relay badges/buttons (so panels outside the Action list still work)
 * ============================= */
(function __sspRelayGlobalClicks(){
  if (window.__SSP_RELAY_GLOBAL_CLICKS) return;
  window.__SSP_RELAY_GLOBAL_CLICKS = true;

  const openOverlay = async (vrid, kind) => {
    const v = String(vrid||"").trim();
    if (!v) return;
    const k = String(kind||"").trim() || "detail";
    const host = _sspEnsureRelayVridOverlay();
    if (!host) {
      _sspWarnRelayOverlayMissingOnce("global-click-open", ["#ssp-relay-vrid-overlay", "#ssp-relay-vrid-title", "#ssp-relay-vrid-body"]);
      return;
    }
    const ov = host.overlay;
    const title = host.title;
    const body = host.body;

    ov.style.display = "flex";
    title.textContent = `Relay ${k} — ${v}`;
    body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Loading…</div>`;

    let detail = null, notes = null;
    try { detail = await _sspRelayGetDetail(v); } catch(_) { detail = null; }
    if (!detail) {
      body.innerHTML = `<div style="padding:10px;color:#6b7280;">Relay detail unavailable for ${esc(v)}.</div>`;
      return;
    }
    const cases = _sspRelayExtractCases(detail) || [];
    const disruptions = _sspRelayExtractDisruptions(detail) || [];
    if (k === "notes") {
      try { notes = await _sspRelayGetNotes(v); } catch(_) { notes = null; }
    }

    const renderJson = (obj) => `<pre style="margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;max-height:420px;overflow:auto;background:#0b1020;color:#e5e7eb;padding:10px;border-radius:12px;">${esc(JSON.stringify(obj, null, 2))}</pre>`;

    if (k === "cases") {
      body.innerHTML = cases.length
        ? `<div style="padding:10px;">${renderJson(cases)}</div>`
        : `<div style="padding:10px;color:#6b7280;">No cases on this VRID.</div>`;
    } else if (k === "disruptions") {
      body.innerHTML = _sspRelayRenderDisruptionsHtml(disruptions);
    } else if (k === "notes") {
      body.innerHTML = _sspRelayRenderNotesHtml(notes);
    } else {
      body.innerHTML = `<div style="padding:10px;">${renderJson(detail)}</div>`;
    }
  };

  // Expose a stable badge click handler (avoids event delegation edge cases)
  if (!window.__SSP_OPEN_RELAY_OVERLAY) window.__SSP_OPEN_RELAY_OVERLAY = openOverlay;
  if (!window.__SSP_RELAY_BADGE_HANDLER) window.__SSP_RELAY_BADGE_HANDLER = function(ev){
    try { if (ev) { ev.preventDefault(); ev.stopPropagation(); } } catch(_) {}
    const t = (ev && (ev.currentTarget || ev.target)) || null;
    const b = t && t.closest ? t.closest('button.ssp-relay-badge') : null;
    if (!b) return false;
    const vrid = b.getAttribute('data-vrid') || '';
    const kind = b.getAttribute('data-kind') || '';
    const opener = (typeof window.__SSP_OPEN_RELAY_OVERLAY === "function") ? window.__SSP_OPEN_RELAY_OVERLAY : openOverlay;
    opener(vrid, kind);
    return false;
  };

  document.addEventListener("click", (e) => {
    // Relay meta badges
    const b = e.target.closest("button.ssp-relay-badge");
    if (b) {
      e.preventDefault(); e.stopPropagation();
      const vrid = b.getAttribute("data-vrid") || "";
      const kind = b.getAttribute("data-kind") || "";
      const opener = (typeof window.__SSP_OPEN_RELAY_OVERLAY === "function") ? window.__SSP_OPEN_RELAY_OVERLAY : openOverlay;
      opener(vrid, kind);
      return;
    }

    // ssp2-act buttons (Relay/Mini etc) inside panels outside Action list
    const btn = e.target.closest("button.ssp2-act");
    if (btn) {
      // let existing list handler run if it is inside the action list (avoid double)
      const inActionList = !!btn.closest("#ssp2-list");
      if (inActionList) return;
      e.preventDefault(); e.stopPropagation();
      const act = btn.getAttribute("data-act") || "";
      const parts = act.split(":");
      const kind = parts[0];
      const vrid = parts.slice(1).join(":");
      if (!vrid) return;
      const open = (url) => window.open(url, "_blank", "noopener");
      if (kind === "tt") open(buildTTUrl(STATE.nodeId, vrid));
      else if (kind === "relay") {
        try {
          if (e.shiftKey) return open(buildRelayUrl(vrid));
          _showRelayMiniForAnchor(btn, vrid, (STATE && (STATE.nodeId || STATE.nodeID)) || "");
          try { _sspPrefetchRelayMetaBadges([vrid], 1); } catch(_) {}
        } catch (_) { open(buildRelayUrl(vrid)); }
      } else if (kind === "fmc") open(buildFmcUrl(vrid));
      else if (kind === "sel") { /* no-op outside table context */ }
      return;
    }
  }, true);

})();
// Pick stop for node (destination preferred). Returns { planned, eta, aat, nodeCode }
function _sspRelayTimesForNode(detail, nodeCode) {
  try {
    const stops = detail?.stops || [];
    const nc = String(nodeCode||"").trim();
    const match = stops.find(s => (s?.location?.nodeCode || s?.location?.name) === nc) ||
                  stops.find(s => String(s?.location?.nodeCode||"").includes(nc)) ||
                  stops[stops.length-1];
    const arr = match?.arrival || {};
    const planned = arr.plannedTime || "";
    const eta = arr.estimatedArrivalTime || arr.estimatedTime || "";
    const aat = arr.completionTime || "";
    return { planned, eta, aat, nodeCode: match?.location?.nodeCode || match?.location?.name || "" };
  } catch { return { planned:"", eta:"", aat:"", nodeCode:"" }; }
}

// Build a compact, human-readable meta block from Relay detail.
// Goal: surface key fields needed for capacity/cancel logic triage (CRID/CRID linkage, adhoc flags,
// execution status, reject/cancel timestamps, disruptions summary).
function _sspRelayExtractCurPos(detail) {
  try {
    if (!detail || typeof detail !== "object") return null;

    // Most common (observed): detail.assetPosition { latitude, longitude, heading, inMotion, timestamp, geoFeatures[] }
    const ap = detail.assetPosition || detail.assetposition || null;
    if (ap) {
      const lat = Number(ap.latitude ?? ap.lat);
      const lng = Number(ap.longitude ?? ap.lng ?? ap.lon);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng, heading: ap.heading, inMotion: ap.inMotion, timestamp: ap.timestamp };
    }

    // Fallbacks (schema variance)
    const p1 = detail.position || null;
    if (p1) {
      const lat = Number(p1.latitude ?? p1.lat);
      const lng = Number(p1.longitude ?? p1.lng ?? p1.lon);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng, timestamp: p1.timestamp };
    }

    const p2 = (detail.vehicle && (detail.vehicle.position || detail.vehicle.location)) || null;
    if (p2) {
      const lat = Number(p2.latitude ?? p2.lat);
      const lng = Number(p2.longitude ?? p2.lng ?? p2.lon);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng, timestamp: p2.timestamp };
    }
  } catch (_) {}
  return null;
}

function _sspRelayFormatMeta(detail, nodeCode, sched, eta, aat, route, curPos) {
  try {
    const lines = [];
    const d = detail || {};

    const execStatus = String(d?.executionStatusV2 || d?.executionStatus || d?.status || "").trim();
    const biz = String(d?.businessType || "").trim();
    const equip = String(d?.equipmentType || d?.requiredEquipmentType || d?.equipment || "").trim();
    const adhoc = (d?.isAdhocLoad === true) ? "YES" : (d?.isAdhocLoad === false ? "NO" : "");
    const crid = String(d?.crId || d?.crID || d?.carrierRequestId || "").trim();
    const rejected = String(d?.rejectedTime || d?.rejectedAt || "").trim();
    const cancelled = String(d?.cancelledTime || d?.canceledTime || d?.cancelledAt || d?.cancellationTime || "").trim();
    const carrierName = String(d?.carrier?.name || d?.carrierName || "").trim();
    const carrierScac = String(d?.carrier?.scac || d?.scac || "").trim();
    const driverName = String(d?.driver?.name || d?.assignedDrivers?.[0]?.name || d?.assignedDrivers?.[0]?.driverName || "").trim();
    const driverId = String(d?.driver?.id || d?.assignedDrivers?.[0]?.id || d?.driverId || "").trim();

    const dis = Array.isArray(d?.disruptions) ? d.disruptions : [];
    const disCount = dis.length;
    const disTypes = (() => {
      try {
        const m = new Map();
        for (const x of dis) {
          const t = String(x?.type || x?.qualifiedFieldId || x?.id || "").trim();
          if (!t) continue;
          m.set(t, (m.get(t) || 0) + 1);
        }
        const arr = Array.from(m.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 3);
        return arr.map(([k,v]) => v > 1 ? `${k}×${v}` : k).join(", ");
      } catch (_) { return ""; }
    })();

    lines.push(`Node:  ${String(nodeCode || "").trim()}`);
    lines.push(`Sched: ${sched || "-"}`);
    lines.push(`ETA:   ${eta || "-"}`);
    lines.push(`AAT:   ${aat || "-"}`);

    // route summary (planning glance)
    try {
      if (Array.isArray(route) && route.length >= 2) {
        const miles = _sspRouteMiles(route);
        const miStr = isFinite(miles) && miles > 0 ? `${Math.round(miles)} mi` : "";
        let progStr = "";
        if (curPos && isFinite(curPos.lat) && isFinite(curPos.lng)) {
          const idx = _sspNearestRouteIndex(route, curPos);
          if (idx >= 0) {
            const pct = Math.round((idx / Math.max(1, route.length-1)) * 100);
            // distance from route (rough)
            const near = route[idx];
            const off = (near && isFinite(near.lat) && isFinite(near.lng)) ? _sspHaversineMiles(near, curPos) : NaN;
            const offStr = isFinite(off) ? ` | off ${off.toFixed(off < 10 ? 1 : 0)} mi` : "";
            progStr = ` | prog ${pct}%${offStr}`;
          }
        }
        if (miStr || progStr) lines.push(`Route: ${miStr || "-"}${progStr}`);
      }
    } catch {}

    if (execStatus) lines.push(`Status: ${execStatus}`);
    if (biz) lines.push(`Type:   ${biz}${equip ? " | " + equip : ""}${adhoc ? " | Adhoc=" + adhoc : ""}`);
    else if (equip || adhoc) lines.push(`Type:   ${equip || ""}${adhoc ? (equip ? " | " : "") + "Adhoc=" + adhoc : ""}`);

    if (carrierName || carrierScac) lines.push(`Carrier: ${carrierName || "-"}${carrierScac ? " (" + carrierScac + ")" : ""}`);
    if (driverName || driverId) lines.push(`Driver:  ${driverName || "-"}${driverId ? " (" + driverId + ")" : ""}`);
    if (crid) lines.push(`CRID:   ${crid}`);
    if (cancelled) lines.push(`Cancelled: ${cancelled}`);
    if (rejected) lines.push(`Rejected:  ${rejected}`);

    if (disCount) lines.push(`Disruptions: ${disCount}${disTypes ? " | " + disTypes : ""}`);

    return lines.join("\n");
  } catch (e) {
    try {
      return `Node: ${String(nodeCode||"").trim()}\nSched: ${sched||"-"}\nETA: ${eta||"-"}\nAAT: ${aat||"-"}`;
    } catch (_) {
      return "";
    }
  }
}

function _sspRelayTrackMapUrlForVrid(vrid) {
  const v = String(vrid||"").trim();
  if (!v) return "";
  // Direct Relay Track view (preferred over search)
  return `https://track.relay.amazon.dev/view/NA:VR:${encodeURIComponent(v)}`;
}

function _ensureRelayMiniPopover() {
  let pop = document.getElementById("ssp2-relay-mini");
  if (pop) return pop;

  pop = document.createElement("div");
  pop.id = "ssp2-relay-mini";
  pop.style.position = "fixed";
  pop.style.zIndex = "999999";
  pop.style.width = "520px";
  pop.style.height = "360px";
  pop.style.display = "none";
  pop.style.border = "1px solid #d1d5db";
  pop.style.borderRadius = "14px";
  pop.style.background = "#fff";
  pop.style.boxShadow = "0 18px 45px rgba(0,0,0,.22)";
  pop.style.overflow = "hidden";

  pop.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #e5e7eb;background:#0b1020;color:#e5e7eb;">
      <div style="font-weight:900;">Relay</div>
      <div id="ssp2-relay-mini-vrid" style="font-weight:800;opacity:.9;"></div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <button id="ssp2-relay-mini-dump" title="Dump raw Relay detail/route objects to console" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">Dump</button>
        <button id="ssp2-relay-mini-map" title="Toggle basemap layer" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">Map</button>
        <button id="ssp2-relay-mini-open" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">Open</button>
        <button id="ssp2-relay-mini-close" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">✕</button>
      </div>
    </div>
    <div id="ssp2-relay-mini-body" style="padding:10px;box-sizing:border-box;max-height:calc(100% - 46px);height:calc(100% - 46px);overflow-y:auto;">
      <canvas id="ssp2-relay-mini-cv" width="500" height="180" style="width:100%;height:180px;border-radius:12px;border:1px solid #e5e7eb;background:#f9fafb;"></canvas>
      <div id="ssp2-relay-mini-meta" style="margin-top:10px;padding-bottom:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.35;white-space:pre-wrap;"></div>
    </div>
  `;
  document.body.appendChild(pop);

  let hideTimer = null;
  const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(() => { pop.style.display = "none"; }, 220);
  };
  pop.addEventListener("mouseenter", cancelHide);
  pop.addEventListener("mouseleave", scheduleHide);
  pop.querySelector("#ssp2-relay-mini-close").onclick = () => { pop.style.display = "none"; };

  // Basemap toggle (visual only)
  pop.querySelector("#ssp2-relay-mini-map").onclick = () => {
    try {
      const cur = !!(window.__SSP_RELAYMINI_BASEMAP);
      window.__SSP_RELAYMINI_BASEMAP = !cur;
      try { localStorage.setItem("SSP_RELAYMINI_BASEMAP", window.__SSP_RELAYMINI_BASEMAP ? "1" : "0"); } catch (_) {}
      // Re-render with existing cached objects
      try {
        const cv = pop.querySelector("#ssp2-relay-mini-cv");
        const route = pop.__sspRelayRoute || null;
        const detail = pop.__sspRelayDetail || null;
        const curPos = _sspRelayExtractCurPos(detail);
        _drawRouteOnCanvas(cv, route, curPos);
      } catch (_) {}
    } catch (e) {
      console.warn("Relay mini basemap toggle failed", e);
    }
  };

  // Wire dump button. The data objects are attached by _showRelayMiniForAnchor.
  pop.querySelector("#ssp2-relay-mini-dump").onclick = () => {
    try {
      const d = pop.__sspRelayDetail || null;
      const r = pop.__sspRelayRoute || null;
      console.log("[SSP UTIL][RelayMini] detail", d);
      console.log("[SSP UTIL][RelayMini] route", r);
      try { window.__SSP_LAST_RELAY_DETAIL = d; window.__SSP_LAST_RELAY_ROUTE = r; } catch (_) {}
      alert("Dumped Relay objects to console (and window.__SSP_LAST_RELAY_DETAIL).");
    } catch (e) {
      console.warn("Relay mini dump failed", e);
    }
  };
  pop.__sspCancelHide = cancelHide;
  pop.__sspScheduleHide = scheduleHide;
  return pop;
}

// --- Relay mini optional basemap (OSM tiles) ---
const __SSP_OSM_TILE_CACHE = new Map();

function _sspClamp(n, a, b){ n = Number(n); if (!isFinite(n)) return a; return Math.max(a, Math.min(b, n)); }

function _sspLatLngToWorldPx(lat, lng, z) {
  // Web Mercator world pixel coords at zoom z (tile size 256)
  const tileSize = 256;
  const s = tileSize * Math.pow(2, z);
  const latRad = (lat * Math.PI) / 180;
  const x = (lng + 180) / 360;
  const y = (1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2;
  return { x: x * s, y: y * s };
}

function _sspWorldPxToTileXY(px, z) {
  const tileSize = 256;
  const n = Math.pow(2, z);
  const tx = Math.floor(px.x / tileSize);
  const ty = Math.floor(px.y / tileSize);
  return { tx: _sspClamp(tx, 0, n-1), ty: _sspClamp(ty, 0, n-1) };
}

function _sspOSMTileUrl(z, x, y) {
  // public OSM tile endpoint. Visual only.
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function _sspLoadTileImage(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (__SSP_OSM_TILE_CACHE.has(key)) return __SSP_OSM_TILE_CACHE.get(key);
  const p = new Promise((resolve) => {
    const url = _sspOSMTileUrl(z, x, y);
    const finish = (blob) => {
      try {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        // Using object URL avoids CSP img-src issues in many cases.
        const objUrl = URL.createObjectURL(blob);
        img.onload = () => { try { URL.revokeObjectURL(objUrl); } catch(_){} resolve(img); };
        img.onerror = () => { try { URL.revokeObjectURL(objUrl); } catch(_){} resolve(null); };
        img.src = objUrl;
      } catch (e) {
        resolve(null);
      }
    };
    try {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "blob",
          onload: (resp) => {
            try { if (resp && resp.response) return finish(resp.response); } catch(_){}
            resolve(null);
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null)
        });
        return;
      }
    } catch (_) {}
    // Fallback: fetch
    fetch(url).then(r => r.ok ? r.blob() : null).then(b => b ? finish(b) : resolve(null)).catch(() => resolve(null));
  });
  __SSP_OSM_TILE_CACHE.set(key, p);
  return p;
}

function _sspPickZoomForBBox(minLat, minLng, maxLat, maxLng, w, h) {
  // Choose a zoom such that tile coverage stays small (<= 25 tiles)
  const zMax = 15, zMin = 6;
  for (let z = zMax; z >= zMin; z--) {
    const a = _sspLatLngToWorldPx(maxLat, minLng, z); // nw
    const b = _sspLatLngToWorldPx(minLat, maxLng, z); // se
    const tA = _sspWorldPxToTileXY(a, z);
    const tB = _sspWorldPxToTileXY(b, z);
    const tilesWide = (tB.tx - tA.tx + 1);
    const tilesHigh = (tB.ty - tA.ty + 1);
    if (tilesWide * tilesHigh <= 25) return z;
  }
  return 8;
}

async function _sspDrawOSMBackground(ctx, w, h, clean, curPos) {
  try {
    // Expand bbox slightly with current pos
    let minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
    for (const p of clean) {
      if (p.lat<minLat) minLat=p.lat;
      if (p.lat>maxLat) maxLat=p.lat;
      if (p.lng<minLng) minLng=p.lng;
      if (p.lng>maxLng) maxLng=p.lng;
    }
    if (curPos && isFinite(curPos.lat) && isFinite(curPos.lng)) {
      minLat = Math.min(minLat, curPos.lat);
      maxLat = Math.max(maxLat, curPos.lat);
      minLng = Math.min(minLng, curPos.lng);
      maxLng = Math.max(maxLng, curPos.lng);
    }

    // add a little padding
    const latPad = (maxLat - minLat) * 0.08 || 0.02;
    const lngPad = (maxLng - minLng) * 0.08 || 0.02;
    minLat -= latPad; maxLat += latPad; minLng -= lngPad; maxLng += lngPad;

    const z = _sspPickZoomForBBox(minLat, minLng, maxLat, maxLng, w, h);
    const nw = _sspLatLngToWorldPx(maxLat, minLng, z);
    const se = _sspLatLngToWorldPx(minLat, maxLng, z);
    const topLeft = { x: nw.x, y: nw.y };
    const bottomRight = { x: se.x, y: se.y };

    // scale world bbox into canvas
    const spanX = (bottomRight.x - topLeft.x) || 1;
    const spanY = (bottomRight.y - topLeft.y) || 1;
    const sx = w / spanX;
    const sy = h / spanY;

    const tNW = _sspWorldPxToTileXY(topLeft, z);
    const tSE = _sspWorldPxToTileXY(bottomRight, z);
    const tileSize = 256;

    const jobs = [];
    for (let ty = tNW.ty; ty <= tSE.ty; ty++) {
      for (let tx = tNW.tx; tx <= tSE.tx; tx++) {
        jobs.push({ z, tx, ty });
      }
    }
    // draw tiles
    const imgs = await Promise.all(jobs.map(j => _sspLoadTileImage(j.z, j.tx, j.ty)));
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const img = imgs[i];
      if (!img) continue;
      const tileWorldX = j.tx * tileSize;
      const tileWorldY = j.ty * tileSize;
      const dx = (tileWorldX - topLeft.x) * sx;
      const dy = (tileWorldY - topLeft.y) * sy;
      const dw = tileSize * sx;
      const dh = tileSize * sy;
      ctx.drawImage(img, dx, dy, dw, dh);
    }

    // return projectors for overlay
    return {
      project: (lat, lng) => {
        const p = _sspLatLngToWorldPx(lat, lng, z);
        return { x: (p.x - topLeft.x) * sx, y: (p.y - topLeft.y) * sy };
      }
    };
  } catch (_) {
    return null;
  }
}

async function _drawRouteOnCanvas(canvas, pts, curPos) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  // If no route points yet, at least draw the background grid (or basemap if enabled later).
  if (!Array.isArray(pts) || pts.length < 2) {
    try {
      ctx.save();
      ctx.strokeStyle = "rgba(17,24,39,0.08)";
      ctx.lineWidth = 1;
      const step = 24;
      for (let xg = 0; xg <= w; xg += step) { ctx.beginPath(); ctx.moveTo(xg,0); ctx.lineTo(xg,h); ctx.stroke(); }
      for (let yg = 0; yg <= h; yg += step) { ctx.beginPath(); ctx.moveTo(0,yg); ctx.lineTo(w,yg); ctx.stroke(); }
      ctx.restore();
    } catch (_) {}
    return;
  }

  // normalize points
  const clean = [];
  for (const p of pts) {
    const lat = Number(p && p.lat);
    const lng = Number(p && p.lng);
    if (isFinite(lat) && isFinite(lng)) clean.push({lat, lng});
  }
  if (clean.length < 2) return;

  let minLat=Infinity,maxLat=-Infinity,minLng=Infinity,maxLng=-Infinity;
  for (const p of clean) {
    if (p.lat<minLat) minLat=p.lat;
    if (p.lat>maxLat) maxLat=p.lat;
    if (p.lng<minLng) minLng=p.lng;
    if (p.lng>maxLng) maxLng=p.lng;
  }
  let project = null;
  // Load basemap if enabled (visual only). Falls back to grid.
  try {
    if (window.__SSP_RELAYMINI_BASEMAP == null) {
      try { window.__SSP_RELAYMINI_BASEMAP = (localStorage.getItem("SSP_RELAYMINI_BASEMAP") === "1"); } catch(_) { window.__SSP_RELAYMINI_BASEMAP = false; }
    }
    if (window.__SSP_RELAYMINI_BASEMAP) {
      const bg = await _sspDrawOSMBackground(ctx, w, h, clean, curPos);
      if (bg && typeof bg.project === "function") project = bg.project;
      // soft mask so line remains readable
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillRect(0,0,w,h);
      ctx.restore();
    }
  } catch (_) {}

  // fallback background grid (subtle)
  if (!project) {
    ctx.save();
    ctx.strokeStyle = "rgba(17,24,39,0.08)";
    ctx.lineWidth = 1;
    const step = 24;
    for (let xg = 0; xg <= w; xg += step) { ctx.beginPath(); ctx.moveTo(xg,0); ctx.lineTo(xg,h); ctx.stroke(); }
    for (let yg = 0; yg <= h; yg += step) { ctx.beginPath(); ctx.moveTo(0,yg); ctx.lineTo(w,yg); ctx.stroke(); }
    ctx.restore();
  }

  const pad=10;
  const latSpan = (maxLat-minLat)||1;
  const lngSpan = (maxLng-minLng)||1;

  const X = (lng)=> pad + ((lng-minLng)/lngSpan)*(w-2*pad);
  const Y = (lat)=> pad + ((maxLat-lat)/latSpan)*(h-2*pad);

  const P = (lat, lng) => {
    if (project) return project(lat, lng);
    return { x: X(lng), y: Y(lat) };
  };

  // route polyline
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 2;
  ctx.beginPath();
  { const p0 = P(clean[0].lat, clean[0].lng); ctx.moveTo(p0.x, p0.y); }
  for (let i=1;i<clean.length;i++) { const p = P(clean[i].lat, clean[i].lng); ctx.lineTo(p.x, p.y); }
  ctx.stroke();

  // waypoint dots (every ~N points)
  ctx.fillStyle = "rgba(17,24,39,0.35)";
  const every = Math.max(4, Math.floor(clean.length / 32));
  for (let i=0;i<clean.length;i+=every) {
    const p = clean[i];
    const q = P(p.lat, p.lng);
    ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, Math.PI*2); ctx.fill();
  }

  // start/end markers
  const first = clean[0], last = clean[clean.length-1];
  ctx.fillStyle = "#16a34a";
  { const p = P(first.lat, first.lng); ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2); ctx.fill(); }
  ctx.fillStyle = "#dc2626";
  { const p = P(last.lat, last.lng); ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2); ctx.fill(); }

  // current position marker (if present)
  if (curPos && isFinite(curPos.lat) && isFinite(curPos.lng)) {
    const qp = P(curPos.lat, curPos.lng);
    const cx = qp.x, cy = qp.y;
    // outer ring
    ctx.strokeStyle = "rgba(37,99,235,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI*2); ctx.stroke();
    // fill
    ctx.fillStyle = "rgba(37,99,235,0.65)";
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fill();
  }
}

async function _showRelayMiniForAnchor(anchorEl, vrid, nodeCode) {
  const pop = _ensureRelayMiniPopover();
  const url = _sspRelayTrackMapUrlForVrid(vrid);
  const v = String(vrid||"").trim();
  if (!v) return;

  // position
  const r = anchorEl.getBoundingClientRect();
  const pad = 10;
  const w = pop.offsetWidth || 520;
  const h = pop.offsetHeight || 360;
  let left = r.right + pad;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - pad);
  let top = r.top;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.display = "block";

  const vrEl = pop.querySelector("#ssp2-relay-mini-vrid");
  if (vrEl) vrEl.textContent = `VRID: ${v}`;

  const openBtn = pop.querySelector("#ssp2-relay-mini-open");
  if (openBtn) openBtn.onclick = () => window.open(url, "_blank", "noopener,noreferrer");

  const meta = pop.querySelector("#ssp2-relay-mini-meta");
  if (meta) meta.textContent = "Loading Relay…";

  const cv = pop.querySelector("#ssp2-relay-mini-cv");
  try { _drawRouteOnCanvas(cv, null, null); } catch {}

  try {
    const [detail, route] = await Promise.all([
      _sspRelayGetDetail(v),
      _sspRelayGetRoute(v).catch(()=>null)
    ]);

    const lane = _sspRelayLaneLabel(detail);
    const next = _sspRelayNextStop(detail);
    const nextNode = (next && next.location && next.location.nodeCode) ? next.location.nodeCode : "";
    const t = _sspRelayTimesForNode(detail, nodeCode || nextNode);
    const sched = _sspRelayParseIsoToLocal(t.planned);
    const eta = _sspRelayParseIsoToLocal(t.eta);
    const aat = _sspRelayParseIsoToLocal(t.aat);

    const curPos = _sspRelayExtractCurPos(detail);

    // Attach raw objects for the Dump button.
    try {
      pop.__sspRelayDetail = detail || null;
      pop.__sspRelayRoute = route || null;
    } catch (_) {}

    if (meta) {
      meta.textContent = _sspRelayFormatMeta(detail, (t.nodeCode || nodeCode || ""), sched, eta, aat, route, curPos);
    }
    if (route) _drawRouteOnCanvas(cv, route, curPos);
  } catch (e) {
    if (meta) meta.textContent = `Relay unavailable: ${e && e.message ? e.message : e}`;
  }
}
// --- end Relay mini map + details ---

function ensurePlanningPanel() {
    if (document.getElementById("ssp2-planpanel")) return;

    const p = document.createElement("div");
    p.id = "ssp2-planpanel";
    p.style.cssText = `
      position:fixed;top:90px;right:460px;width:980px;height:720px;min-width:760px;min-height:420px;
      background:#fff;border:1px solid #ccc;border-radius:10px;
      box-shadow:0 4px 14px rgba(0,0,0,.2);
      font-family:Arial;font-size:12px;z-index:99999;
      display:none;resize:both;overflow:hidden;flex-direction:column;
    `;

    p.innerHTML = `
      <div id="ssp2-planhdr" style="padding:10px;font-weight:900;background:#f3f3f3;cursor:move;border-radius:10px 10px 0 0;display:flex;align-items:center;gap:10px;">
        <span>Planning</span>
        <span id="ssp2-plan-meta" style="margin-left:auto;font-weight:800;color:#374151;"></span>
      </div>

      <div style="padding:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-bottom:1px solid #e5e7eb;">
        <label style="font-weight:800;">Window:</label>
        <select id="ssp2-plan-window" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">
          <option value="ops">Ops Window (07:00→07:00)</option>
          <option value="active">Active / Upcoming Shift</option>
        </select>

        <label style="font-weight:800;margin-left:10px;">Status:</label>
        <select id="ssp2-plan-status" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">
          <option value="all">All</option>
          <option value="open">Remaining (not completed)</option>
          <option value="completed">Completed</option>
        </select>

        <input id="ssp2-plan-search" placeholder="Search VRID / route / location" style="flex:1;min-width:220px;padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;font-weight:700;"/>

        <button id="ssp2-plan-close" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">Close</button>
      </div>

      <div style="padding:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button id="plan-csv-ib" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">CSV XD Graph</button>
        <button id="plan-csv-ib4" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">CSV IB4CPT</button>
        <button id="plan-refresh" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">Refresh</button>
        <span id="ssp2-plan-count" style="margin-left:auto;font-weight:900;"></span>
      </div>

      <div id="ssp2-plan-body" style="display:flex;gap:10px;padding:10px;flex:1;min-height:0;">
        <!-- Left: Loads (≈2/3) -->
        <div id="ssp2-plan-left" style="flex:2;min-width:0;display:flex;flex-direction:column;">
          <div id="ssp2-plan-scroll" style="overflow:auto;flex:1;min-height:0;">
            <table id="ssp2-plan-table" style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead>
                <tr style="text-align:left;border-bottom:1px solid #e5e7eb;">
                  <th style="padding:8px 6px;">VRID</th>
                  <th style="padding:8px 6px;">PlanId</th>
                  <th style="padding:8px 6px;">Route</th>
                  <th style="padding:8px 6px;">Status</th>
                  <th style="padding:8px 6px;">Cntrs Left</th>
                  <th style="padding:8px 6px;">Scheduled</th>
                  <th style="padding:8px 6px;">ETA</th>
                  <th style="padding:8px 6px;">Arrived</th>
                  <th style="padding:8px 6px;">Equip</th>
                  <th style="padding:8px 6px;">Loc</th>
                </tr>
              </thead>
              <tbody id="ssp2-plan-tbody"></tbody>
            </table>
          </div>
        </div>

        <!-- Right: Math + Debug (≈1/3) -->
        <div id="ssp2-plan-right" style="flex:1;min-width:340px;max-width:520px;display:flex;flex-direction:column;border-left:1px solid #e5e7eb;padding-left:10px;min-height:0;">
          <div id="ssp2-plan-right-top" style="flex:1;min-height:0;display:flex;flex-direction:column;">
            <div style="font-weight:900;margin-bottom:6px;">Container Math</div>
            <div id="ssp2-plan-math-meta" style="font-weight:800;color:#374151;margin-bottom:8px;"></div>

            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <button id="ssp2-plan-math-toggle" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">Details</button>
              <span id="ssp2-plan-math-badge" style="margin-left:auto;font-weight:900;padding:4px 8px;border-radius:999px;background:#eef2ff;color:#1e3a8a;">STAFFING</span>
            </div>
            <div id="ssp2-plan-mathui" style="flex:1;min-height:0;overflow:auto;background:#0b1020;color:#e5e7eb;border-radius:10px;padding:10px;"></div>
            <pre id="ssp2-plan-mathpre" style="display:none;flex:1;min-height:0;overflow:auto;background:#0b1020;color:#dbeafe;border-radius:10px;padding:10px;font-size:11px;line-height:1.25;white-space:pre-wrap;"></pre>
          </div>

          <div id="ssp2-plan-right-bot" style="flex:1;min-height:0;display:flex;flex-direction:column;margin-top:10px;">
            <div style="font-weight:900;margin-bottom:6px;">Debug</div>
            <div id="ssp2-plan-debug-meta" style="font-weight:800;color:#374151;margin-bottom:8px;"></div>
            <pre id="ssp2-plan-debugpre" style="flex:1;min-height:0;overflow:auto;background:#0b1020;color:#dbeafe;border-radius:10px;padding:10px;font-size:11px;line-height:1.25;white-space:pre-wrap;"></pre>
          </div>
        </div>
      </div>
    `;
document.body.appendChild(p);

    // Drag
    const hdr = p.querySelector("#ssp2-planhdr");
    let drag = false, ox = 0, oy = 0;
    hdr.onmousedown = (e) => { drag = true; ox = e.clientX - p.offsetLeft; oy = e.clientY - p.offsetTop; };
    document.addEventListener("mouseup", () => (drag = false));
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      p.style.left = (e.clientX - ox) + "px";
      p.style.top = (e.clientY - oy) + "px";
      p.style.right = "auto";
    });

    // Close
    p.querySelector("#ssp2-plan-close").onclick = () => { p.style.display = "none"; };

    // Math details toggle (Container Math)
    try {
      const tbtn = p.querySelector("#ssp2-plan-math-toggle");
      tbtn && (tbtn.onclick = () => {
        const pre = p.querySelector("#ssp2-plan-mathpre");
        const ui = p.querySelector("#ssp2-plan-mathui");
        if (!pre || !ui) return;
        const showing = pre.style.display !== "none";
        pre.style.display = showing ? "none" : "block";
        ui.style.display = showing ? "block" : "none";
        tbtn.textContent = showing ? "Details" : "Summary";
      });
    } catch {}

    // Populate enabled shifts into dropdown
    try {
      const winSel = p.querySelector("#ssp2-plan-window");
      for (const s of _getShiftContext(Date.now()).enabledShifts) {
        const key = String(s.key || "").trim() || String(s.name || s.label || "").trim();
        const label = String(s.name || s.label || key || "Shift").trim();
        const opt = document.createElement("option");
        opt.value = `shift:${key}`;
        opt.textContent = `Shift: ${label}`;
        winSel.appendChild(opt);
      }
    } catch {}

    // Filters
    p.querySelector("#ssp2-plan-window").onchange = () => renderPlanningPanel();
    p.querySelector("#ssp2-plan-status").onchange = () => renderPlanningPanel();
    p.querySelector("#ssp2-plan-search").oninput = () => renderPlanningPanel();

    // Sorting (click column headers)
    try {
      const PLAN = (window.__SSP_PLAN__ = window.__SSP_PLAN__ || { sort: { key: "status", dir: "asc" } });
      const ths = p.querySelectorAll("#ssp2-plan-table thead th");
      const keys = ["vrid","planId","route","status","cntrsLeft","scheduled","eta","arrived","equip","loc"];
      ths.forEach((th, i) => {
        const k = keys[i];
        if (!k) return;
        th.style.cursor = "pointer";
        th.title = "Sort";
        th.addEventListener("click", () => {
          const cur = PLAN.sort || (PLAN.sort = { key: "status", dir: "asc" });
          if (cur.key === k) cur.dir = (cur.dir === "asc" ? "desc" : "asc");
          else { cur.key = k; cur.dir = (k === "status" ? "asc" : "asc"); }
          renderPlanningPanel();
        });
      });
    } catch {}

    // Refresh
    p.querySelector("#plan-refresh").onclick = () => run(true);

  // CSV: XD Graph (replaces IB CART)
    p.querySelector("#plan-csv-ib").onclick = () => {
      try {
        const nowMs = Date.now();
        const ops = getOpsWindow(nowMs);
        const baseDay0Ms = _getShiftBaseDay0Ms(nowMs);

        const loads = Array.isArray(STATE?.inboundLoads) ? STATE.inboundLoads : [];
        if (!loads.length) { alert("No inbound loads loaded yet. Hit Refresh first."); return; }

        // XD Graph is an expected-volume view: prefer scheduled/ETA over actual arrival.
        const getExpectedTimeForXdGraph = (load) => (
          parseSspDateTime(load?.scheduledArrivalTime) ||
          parseSspDateTime(load?.estimatedArrivalTime) ||
          parseSspDateTime(load?.actualArrivalTime) ||
          toMs(load?.scheduledArrivalTime) ||
          toMs(load?.estimatedArrivalTime) ||
          toMs(load?.actualArrivalTime) ||
          0
        );

        const normStatus = (st) => String(st || "").toUpperCase();
        const isTransit = (st) => {
          const s = normStatus(st);
          return s.includes("SCHEDULED") || s.includes("NOTARRIVED") || s.includes("NOT_ARRIVED") || s.includes("IN_TRANSIT") || s.includes("INTRANSIT");
        };
        const isCompleted = (st) => normStatus(st).includes("COMPLETED");
        const isInFacility = (st) => {
          const s = normStatus(st);
          if (!s) return false;
          if (isCompleted(s)) return false;
          if (isTransit(s)) return false;
          return true;
        };
        const statusBucket = (st) => isInFacility(st) ? "ON_DOOR" : (isTransit(st) ? "ON_SCHEDULE" : "OTHER");

        const getCounts = (l) => {
          const planId = String(l?.planId || "").trim();
          const m = planId ? (STATE?.ibContainerCount?.[planId]) : null;
          const it = m?.inTrailerCount || {};
          const C = (typeof it?.C === "number") ? it.C : 0;
          const P = (typeof it?.P === "number") ? it.P : 0;
          const missing = (!m || (!it || (typeof it?.C !== "number" && typeof it?.P !== "number")));
          return { C, P, missing };
        };

        // Build responsibility buckets (gap-safe: bucket starts at previous bucket end)
        const shifts = _getEnabledShifts();
        const shiftWindows = (shifts || [])
          .map(s => {
            const w = _shiftToWindowMs(s, baseDay0Ms);
            return {
              name: String(s.name || s.label || s.key || "Shift"),
              endClipped: Math.min(w.endMs, ops.endMs),
            };
          })
          .filter(x => x.endClipped > ops.startMs)
          .sort((a,b) => a.endClipped - b.endClipped);

        const buckets = [];
        let prevEnd = ops.startMs;
        for (const it of shiftWindows) {
          const a = Math.max(prevEnd, ops.startMs);
          const b = Math.min(it.endClipped, ops.endMs);
          if (b > a) buckets.push({ shift: it.name, a, b });
          prevEnd = Math.max(prevEnd, it.endClipped);
        }

        const hourBucket = (ms) => {
          const d = new Date(ms);
          d.setMinutes(0,0,0);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth()+1).padStart(2,"0");
          const dd = String(d.getDate()).padStart(2,"0");
          const hh = String(d.getHours()).padStart(2,"0");
          return `${yyyy}-${mm}-${dd} ${hh}:00`;
        };

        const FALLBACK_SHIFT = "OPS_UNMAPPED";
        const agg = new Map(); // shift||hour||status -> record
        for (const l of loads) {
          const t = getExpectedTimeForXdGraph(l);
          if (!t) continue;
          if (t < ops.startMs || t >= ops.endMs) continue;
          if (isCompleted(l?.status || l?.loadStatus)) continue;

          let shiftName = null;
          for (const b of buckets) { if (t >= b.a && t < b.b) { shiftName = b.shift; break; } }
          // Keep ops-window loads in totals even when enabled shift windows are partial/incomplete.
          if (!shiftName) shiftName = FALLBACK_SHIFT;

          const hb = hourBucket(t);
          const sb = statusBucket(l?.status || l?.loadStatus);
          const { C, P, missing } = getCounts(l);

          const k = `${shiftName}||${hb}||${sb}`;
          const r = agg.get(k) || { shift: shiftName, hourBucket: hb, statusBucket: sb, loads: 0, carts: 0, packages: 0, missingCounts: 0, disruptedVrids: [] };
          r.loads += 1;
          r.carts += (C || 0);
          r.packages += (P || 0);
          if (missing) r.missingCounts += 1;

          // Check for disruptions for this load
          const lane = String(l?.route || l?.lane || "");
          const cptMs = t - (t % (60 * 60 * 1000)); // Start of hour
          const disruptionsList = (typeof computeDisruptionsForLaneCpt === "function") ? computeDisruptionsForLaneCpt(lane, cptMs) : [];
          const vrid = String(l?.vrId || l?.vrid || "");
          const hasDisruption = disruptionsList.some(d => String(d?.vrid || "") === vrid);
          if (hasDisruption && !r.disruptedVrids.includes(vrid)) {
            r.disruptedVrids.push(vrid);
          }

          agg.set(k, r);
        }

        const rows = Array.from(agg.values())
          .sort((a,b) => String(a.shift).localeCompare(String(b.shift)) || String(a.hourBucket).localeCompare(String(b.hourBucket)) || String(a.statusBucket).localeCompare(String(b.statusBucket)));

        // Add explicit per-hour sums so ops can graph expected totals directly.
        const byHour = new Map(); // shift||hour -> total row
        for (const r of rows) {
          const hk = `${r.shift}||${r.hourBucket}`;
          const t = byHour.get(hk) || { shift: r.shift, hourBucket: r.hourBucket, statusBucket: 'SUM_HOUR', loads: 0, carts: 0, packages: 0, missingCounts: 0, disruptedVrids: [] };
          t.loads += Number(r.loads || 0);
          t.carts += Number(r.carts || 0);
          t.packages += Number(r.packages || 0);
          t.missingCounts += Number(r.missingCounts || 0);
          // Aggregate disrupted VRIDs across status buckets for this hour
          for (const vrid of (r.disruptedVrids || [])) {
            if (!t.disruptedVrids.includes(vrid)) {
              t.disruptedVrids.push(vrid);
            }
          }
          byHour.set(hk, t);
        }

        // Format disruptions column for each row
        const formatDisruptions = (vrids) => {
          if (!vrids || vrids.length === 0) return "";
          return `${vrids.length} (${vrids.join(", ")})`;
        };

        const exportRows = rows.concat(
          Array.from(byHour.values()).sort((a,b) => String(a.shift).localeCompare(String(b.shift)) || String(a.hourBucket).localeCompare(String(b.hourBucket)))
        ).map(r => ({
          shift: r.shift,
          hourBucket: r.hourBucket,
          statusBucket: r.statusBucket,
          loads: r.loads,
          carts: r.carts,
          packages: r.packages,
          missingCounts: r.missingCounts,
          disruptions: formatDisruptions(r.disruptedVrids)
        }));

        const headers = ["shift","hourBucket","statusBucket","loads","carts","packages","missingCounts","disruptions"];

        downloadTextFile(
          `XD_GRAPH_${STATE.nodeId || "NODE"}_${new Date().toISOString().slice(0,10)}.csv`,
          toCsv(exportRows, headers),
          "text/csv;charset=utf-8"
        );
      } catch (e) {
        console.error(e);
        alert("XD Graph export failed.");
      }
    };

  // CSV: IB4CPT
    p.querySelector("#plan-csv-ib4").onclick = () => {
      try {
        if (typeof exportIB4CPT === "function") return exportIB4CPT();
        alert("IB4CPT export not initialized yet.");
      } catch (e) {
        console.error(e);
        alert("IB4CPT export failed.");
      }
    };

    renderPlanningPanel();
  }


function _getInboundLoadIdForHierarchy(l) {
  try {
    return String(
      l?.inboundLoadId ||
      l?.loadId ||
      l?.id ||
      l?.inboundLoad?.id ||
      l?.inboundLoad?.loadId ||
      ""
    ).trim();
  } catch {
    return "";
  }
}


// --- Relay hover preview (Option C) ---
function _relayTrackMapUrlForVrid(vrid) {
  const v = String(vrid || "").trim();
  if (!v) return "";
  return `https://track.relay.amazon.dev/view/NA:VR:${encodeURIComponent(v)}`;
}

function _ensureRelayPreviewPopover() {
  let pop = document.getElementById("ssp2-relay-preview");
  if (pop) return pop;

  pop = document.createElement("div");
  pop.id = "ssp2-relay-preview";
  pop.style.position = "fixed";
  pop.style.zIndex = "999999";
  pop.style.width = "520px";
  pop.style.height = "360px";
  pop.style.display = "none";
  pop.style.border = "1px solid #d1d5db";
  pop.style.borderRadius = "14px";
  pop.style.background = "#fff";
  pop.style.boxShadow = "0 18px 45px rgba(0,0,0,.22)";
  pop.style.overflow = "hidden";

  pop.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #e5e7eb;background:#0b1020;color:#e5e7eb;">
      <div style="font-weight:900;">Relay</div>
      <div id="ssp2-relay-vrid" style="font-weight:800;opacity:.9;"></div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <button id="ssp2-relay-open" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">Open</button>
        <button id="ssp2-relay-close" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">✕</button>
      </div>
    </div>
    <div style="position:relative;width:100%;height:calc(100% - 44px);">
      <iframe id="ssp2-relay-iframe" style="width:100%;height:100%;border:0;" referrerpolicy="no-referrer"></iframe>
      <div id="ssp2-relay-hint" style="position:absolute;left:10px;bottom:10px;right:10px;padding:8px 10px;border-radius:12px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:1.25;display:none;">
        If the preview stays blank, Relay is blocking embedding. Use <b>Open</b> to launch in a new tab.
      </div>
    </div>
  `;

  document.body.appendChild(pop);

  let hideTimer = null;
  const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(() => {
      const p = document.getElementById("ssp2-relay-preview");
      if (p) p.style.display = "none";
    }, 220);
  };

  pop.addEventListener("mouseenter", cancelHide);
  pop.addEventListener("mouseleave", scheduleHide);

  pop.querySelector("#ssp2-relay-close").onclick = () => { pop.style.display = "none"; };

  pop.__sspCancelHide = cancelHide;
  pop.__sspScheduleHide = scheduleHide;

  return pop;
}

function _showRelayPreviewForAnchor(anchorEl, vrid) {
  const pop = _ensureRelayPreviewPopover();
  const url = _sspRelayTrackMapUrlForVrid(vrid);
  if (!url) return;

  const r = anchorEl.getBoundingClientRect();
  const pad = 10;
  const w = pop.offsetWidth || 520;
  const h = pop.offsetHeight || 360;

  let left = r.right + pad;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - pad);
  let top = r.top;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.display = "block";

  const vrEl = pop.querySelector("#ssp2-relay-vrid");
  if (vrEl) vrEl.textContent = vrid ? `VRID: ${String(vrid).trim()}` : "";

  const openBtn = pop.querySelector("#ssp2-relay-open");
  if (openBtn) openBtn.onclick = () => window.open(url, "_blank", "noopener,noreferrer");

  const iframe = pop.querySelector("#ssp2-relay-iframe");
  const hint = pop.querySelector("#ssp2-relay-hint");

  try {
    if (hint) hint.style.display = "none";
    if (iframe) {
      if (iframe.getAttribute("data-src") !== url) {
        iframe.setAttribute("data-src", url);
        iframe.src = url;
      }
    }
    setTimeout(() => { try { if (hint && pop.style.display !== "none") hint.style.display = "block"; } catch {} }, 900);
  } catch {}
}
// --- end Relay hover preview ---

function renderPlanningPanel() {
  async function _sspHydratePlanningRelayTimes(panel) {
    try {
      const node = (STATE && (STATE.nodeId || STATE.nodeID)) || "";
      const spans = panel.querySelectorAll('span[data-ssp-relay][data-vrid]');
      const vrids = Array.from(new Set(Array.from(spans).map(s=>String(s.dataset.vrid||"").trim()).filter(Boolean)));
      if (!vrids.length) return;

      // hydrate in small batches to avoid hammering
      for (const v of vrids.slice(0, 60)) {
        try {
          const detail = await _sspRelayGetDetail(v);
          // NOTE: Do NOT overwrite the route/lane labels shown in SSP.
          // Relay detail often only provides origin→dest (and may omit CART/CYC/DR1 suffixes),
          // which is confusing for site ops. Keep SSP's own lane string as the source of truth.
          const t = _sspRelayTimesForNode(detail, node);
          const sched = _sspRelayParseIsoToLocal(t.planned);
          const eta = _sspRelayParseIsoToLocal(t.eta);
          const aat = _sspRelayParseIsoToLocal(t.aat);

          panel.querySelectorAll(`span[data-ssp-relay="scheduled"][data-vrid="${v}"]`).forEach(el => el.textContent = sched || "-");
          panel.querySelectorAll(`span[data-ssp-relay="eta"][data-vrid="${v}"]`).forEach(el => el.textContent = eta || "-");
          // Arrived column: AAT preferred; else show ETA (as "ETA") if no AAT yet
          panel.querySelectorAll(`span[data-ssp-relay="arrived"][data-vrid="${v}"]`).forEach(el => {
            el.textContent = aat || eta || "-";
          });
        } catch {}
      }
    } catch {}
  }

    const panel = document.getElementById("ssp2-planpanel");
    if (!panel) return;

    // Defensive: the host page sometimes mutates table DOM; ensure tbody always exists.
    let tbody = panel.querySelector("#ssp2-plan-tbody");
    if (!tbody) {
      const table = panel.querySelector("#ssp2-plan-table");
      if (table) {
        tbody = table.querySelector("tbody");
        if (!tbody) {
          tbody = document.createElement("tbody");
          table.appendChild(tbody);
        }
        tbody.id = "ssp2-plan-tbody";
      }
    }
    if (!tbody) return; // cannot render without a tbody
    const meta = panel.querySelector("#ssp2-plan-meta");
    const cnt = panel.querySelector("#ssp2-plan-count");
    const winSel = panel.querySelector("#ssp2-plan-window");
    const stSel = panel.querySelector("#ssp2-plan-status");
    const q = String(panel.querySelector("#ssp2-plan-search")?.value || "").trim().toLowerCase();

    const nowMs = Date.now();
    const ops = getOpsWindow(nowMs);
    const baseDay0Ms = _getShiftBaseDay0Ms(nowMs);
    const shiftCtx = _getShiftContext(nowMs);

    // Source loads: always use full inboundLoads, then filter into the ops window.
    const allLoads = Array.isArray(STATE?.inboundLoads) ? STATE.inboundLoads : [];
    const all = allLoads.filter(l => {
      const t = _getLoadTimeForPlanning(l);
      if (!t) return true; // keep unknown-timestamp rows visible in ops view
      return (t >= ops.startMs && t < ops.endMs);
    });

    // Determine selected window boundaries
    let wStart = ops.startMs, wEnd = ops.endMs;
    const winVal = String(winSel?.value || "ops");

    if (winVal === "active") {
      const s = shiftCtx.activeOrUpcoming;
      const w = s ? _shiftToWindowMs(s, baseDay0Ms) : null;
      if (w) { wStart = w.startMs; wEnd = w.endMs; }
    } else if (winVal.startsWith("shift:")) {
      const key = winVal.slice("shift:".length);
      const s = _findShiftByKey(key);
      const w = s ? _shiftToWindowMs(s, baseDay0Ms) : null;
      if (w) { wStart = w.startMs; wEnd = w.endMs; }
    }

    let rows = all.filter(l => {
      const t = _getLoadTimeForPlanning(l);
      if (!t) return winVal === "ops"; // keep timestamp-less loads in ops view only
      return (t >= wStart && t < wEnd);
    });

    // Status filter
    const statusMode = String(stSel?.value || "all");
    rows = rows.filter(l => {
      const st = String(l?.status || l?.loadStatus || "").toUpperCase();
      const done = (st === "COMPLETED");
      if (statusMode === "open") return !done;
      if (statusMode === "completed") return done;
      return true;
    });

    // Search filter
    if (q) {
      rows = rows.filter(l => {
        const s = [
          l?.vrId, l?.vrid, l?.planId, l?.route, l?.lane, _getLoadLocationForPlanning(l), _getLoadContainersLeftForPlanning(l),
          l?.equipmentType, l?.trailerEquipmentType, l?.status, l?.loadStatus
        ].map(v => String(v || "")).join(" ").toLowerCase();
        return s.includes(q);
      });
    }

    // Sort (default: status)
    try {
      const PLAN = (window.__SSP_PLAN__ = window.__SSP_PLAN__ || { sort: { key: "status", dir: "asc" } });
      const sort = PLAN.sort || (PLAN.sort = { key: "status", dir: "asc" });
      const dir = (sort.dir === "desc") ? -1 : 1;
      const statusRank = {
        "UNLOADING_IN_PROGRESS": 1,
        "UNLOADING IN PROGRESS": 1,
        "ARRIVED": 2,
        "CHECKED_IN": 3,
        "CHECKED IN": 3,
        "SCHEDULED": 4,
        "AT_YARD": 5,
        "AT YARD": 5,
        "CANCELLED": 90,
        "CANCELED": 90,
        "COMPLETED": 99,
      };
      const getV = (l) => {
        switch (sort.key) {
          case "vrid": return String(l?.vrId || l?.vrid || "");
          case "planId": return String(l?.planId || "");
          case "route": return String(l?.route || l?.lane || "");
          case "status": {
            const st = String(l?.status || "").toUpperCase().trim();
            const r = statusRank[st];
            return (r != null ? r : 50);
          }
          case "scheduled": return _getLoadTimeForPlanning({ scheduledArrivalTime: l?.scheduledArrivalTime }) || 0;
          case "eta": return _getLoadTimeForPlanning({ estimatedArrivalTime: l?.estimatedArrivalTime }) || 0;
          case "arrived": return _getLoadTimeForPlanning({ actualArrivalTime: l?.actualArrivalTime }) || 0;
          case "cntrsLeft": {
            const nodeId = STATE?.nodeId || STATE?.nodeID || "";
            const inboundLoadId = _getInboundLoadIdForHierarchy(l);
            const cached = _getIbTrailerRemainingCached(nodeId, inboundLoadId);
            const raw = (typeof cached === "number") ? String(cached) : _getLoadContainersLeftForPlanning(l);
            const s = String(raw || "").trim();
            if (!s || s === "…") return null;
            const m = s.match(/^(\d+)(?:\/(\d+))?$/);
            if (m) return Number(m[1]);
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
          }case "equip": return String(l?.equipmentType || l?.trailerEquipmentType || "");
          case "loc": return _getLoadLocationForPlanning(l);
          default: return "";
        }
      };
      rows.sort((a, b) => {
        const av = getV(a);
        const bv = getV(b);
        const aNil = (av == null);
        const bNil = (bv == null);
        if (aNil && bNil) return 0;
        if (aNil) return 1;
        if (bNil) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
} catch {}


    // Render meta + counts
    const completed = rows.filter(l => String(l?.status || l?.loadStatus || "").toUpperCase() === "COMPLETED").length;
    const open = rows.length - completed;
    meta.textContent = `Ops: ${fmtTime(ops.startMs)}→${fmtTime(ops.endMs)} | Window: ${fmtTime(wStart)}→${fmtTime(wEnd)}`;
    cnt.textContent = `Total: ${rows.length} | Remaining: ${open} | Completed: ${completed}`;
    // Right panel: Container Math (top) + Debug (bottom)
    try {
      const mathPre = panel.querySelector("#ssp2-plan-mathpre");
      const mathMeta = panel.querySelector("#ssp2-plan-math-meta");
      const dbgPre = panel.querySelector("#ssp2-plan-debugpre");
      const dbgMeta = panel.querySelector("#ssp2-plan-debug-meta");

      // Determine MOR2 cutoff (30 mins before MOR2 end) within ops window
      const targetCph = Number(SHIFT_SETTINGS?.targetCph) || 15;
      const mor2 = _findShiftByKey("Mor2") || _findShiftByKey("MOR2");
      const mor2W = mor2 ? _shiftToWindowMs(mor2, baseDay0Ms) : null;
      const cutoffMs = mor2W ? (mor2W.endMs - 30 * 60 * 1000) : null;

      // Helper: carts (C) + pkgs (P) remaining for a load (in trailer)
      const getCounts = (l) => {
        const planId = String(l?.planId || "").trim();
        const m = planId ? (STATE?.ibContainerCount?.[planId]) : null;
        const it = m?.inTrailerCount || {};
        const C = (typeof it?.C === "number") ? it.C : null;
        const P = (typeof it?.P === "number") ? it.P : null;
        return { planId, C, P };
      };

      const isCompleted = (l) => String(l?.status || l?.loadStatus || "").toUpperCase() === "COMPLETED";

      // 1) Window totals (selected window only)
      let sumC_window = 0, sumP_window = 0, missing_window = 0;
      for (const l of rows) {
        const { C, P } = getCounts(l);
        if (C == null && P == null) { missing_window++; continue; }
        if (!isCompleted(l)) {
          if (C != null) sumC_window += C;
          if (P != null) sumP_window += P;
        }
      }

      // 2) Ops-to-cutoff totals (ops start -> cutoffMs), remaining only
      let sumC_cut = 0, sumP_cut = 0, missing_cut = 0, loads_cut = 0;
      if (cutoffMs != null) {
        const opsLoads = Array.isArray(STATE?.inboundLoads) ? STATE.inboundLoads : [];
        for (const l of opsLoads) {
          const t = _getLoadTimeForPlanning(l);
          if (!t) continue;
          if (t < ops.startMs || t >= ops.endMs) continue;
          if (t > cutoffMs) continue;
          loads_cut++;
          const { C, P } = getCounts(l);
          if (C == null && P == null) { missing_cut++; continue; }
          if (!isCompleted(l)) {
            if (C != null) sumC_cut += C;
            if (P != null) sumP_cut += P;
          }
        }
      }

      // 3) Shift-over-shift forecast (within ops window)
// Bucketing rule (ops-responsibility):
// - Buckets are NOT strict "arrival between shift start/end" slices.
// - Each bucket starts at the PRIOR bucket end, so gaps (e.g., 01:15→02:00) roll into the next shift.
// - Equivalent: assign each load to the earliest shift whose bucketEnd (shift end) it falls before.
      const shifts = _getEnabledShifts();

      // Precompute shift windows, clip ends to ops, then order by earliest end (responsibility boundary).
      const _shiftWindows = (shifts || [])
        .map(s => {
          const w = _shiftToWindowMs(s, baseDay0Ms);
          return {
            s,
            startMs: w.startMs,
            endMs: w.endMs,
            endClipped: Math.min(w.endMs, ops.endMs),
          };
        })
        .filter(x => x.endClipped > ops.startMs)
        .sort((a, b) => (a.endClipped - b.endClipped));

      const perShift = [];
      let _prevEnd = ops.startMs;

      for (const item of _shiftWindows) {
        const s = item.s;
        // Responsibility bucket: [prevEnd, thisShiftEnd) (clipped to ops)
        const a = Math.max(_prevEnd, ops.startMs);
        const b = Math.min(item.endClipped, ops.endMs);
        if (b <= a) { _prevEnd = Math.max(_prevEnd, item.endClipped); continue; }

        let sumC = 0, sumP = 0, missing = 0, loads = 0;
        const opsLoads = Array.isArray(STATE?.inboundLoads) ? STATE.inboundLoads : [];
        for (const l of opsLoads) {
          const t = _getLoadTimeForPlanning(l);
          if (!t) continue;
          if (t < a || t >= b) continue;
          loads++;
          const { C, P } = getCounts(l);
          if (C == null && P == null) { missing++; continue; }
          if (!isCompleted(l)) {
            if (C != null) sumC += C;
            if (P != null) sumP += P;
          }
        }

        const durHrs = Math.max(0.0001, (b - a) / 3600000);
        const hc = Math.max(0, Math.ceil(sumC / (durHrs * targetCph)));

        // Active shift headcount (moment-in-time) if now is inside this responsibility bucket.
        // IMPORTANT: include backlog + all remaining loads due by bucket end (b) within ops window.
        let hcNow = null;
        let hcNowDueC = null, hcNowDueP = null, hcNowBacklogC = null, hcNowHrs = null;
        if (nowMs >= a && nowMs < b) {
          const remainingHrs = Math.max(0.0001, (b - nowMs) / 3600000);
          // Due-by-bucket-end totals: all remaining loads with loadTime < bucket end.
          let dueC = 0, dueP = 0;
          const opsLoads2 = Array.isArray(STATE?.inboundLoads) ? STATE.inboundLoads : [];
          for (const l2 of opsLoads2) {
            const t2 = _getLoadTimeForPlanning(l2);
            if (!t2) continue;
            if (t2 < ops.startMs || t2 >= ops.endMs) continue;
            if (t2 >= b) continue; // not due yet by this bucket end
            if (isCompleted(l2)) continue;
            const { C: c2, P: p2 } = getCounts(l2);
            if (c2 != null) dueC += c2;
            if (p2 != null) dueP += p2;
          }
          hcNowDueC = dueC;
          hcNowDueP = dueP;
          hcNowBacklogC = Math.max(0, dueC - sumC);
          hcNowHrs = remainingHrs;
          hcNow = Math.max(0, Math.ceil(dueC / (remainingHrs * targetCph)));
        }

        const key = String(s.key || "").trim() || String(s.name || s.label || "").trim();
        const label = String(s.name || s.label || key || "Shift").trim();

        perShift.push({
          key, label,
          start: a, end: b,
          loads, missing,
          C: sumC, P: sumP,
          durHrs,
          hc, hcNow,
          hcNowDueC, hcNowDueP, hcNowBacklogC, hcNowHrs
        });

        // Advance responsibility boundary to this shift end.
        _prevEnd = Math.max(_prevEnd, item.endClipped);
      }
// Render: top-right container math (algorithm first, then numbers)
      if (mathMeta) {
        const cutTxt = (cutoffMs != null) ? `${fmtTime(ops.startMs)}→${fmtTime(cutoffMs)}` : "n/a";
        const mor2Txt = mor2W ? `${fmtTime(mor2W.startMs)}→${fmtTime(mor2W.endMs)} (cutoff ${fmtTime(cutoffMs)})` : "MOR2 not configured";
        mathMeta.textContent = `Target: ${targetCph} CPH | MOR2: ${mor2Txt} | Cutoff Window: ${cutTxt}`;
      }

      // 2b) Cutoff staffing + breakdown (bucketed by shift windows, clipped to cutoff)
      let hc_cut_total = null;
      let cutRemainingHrs = null;
      let sumC_cut_unbucketed = 0, sumP_cut_unbucketed = 0, missing_cut_unbucketed = 0, loads_cut_unbucketed = 0;
      const perShiftCut = []; // [{label,start,end,C,P,loads,missing,durHrs,hc}]
      if (cutoffMs != null) {
        cutRemainingHrs = (cutoffMs > nowMs) ? ((cutoffMs - nowMs) / 3600000) : 0;
        const denomHrs = Math.max(0.0001, cutRemainingHrs || 0.0001);
        hc_cut_total = (cutoffMs > nowMs) ? Math.max(0, Math.ceil(sumC_cut / (denomHrs * targetCph))) : 0;

        // Build clipped intervals from perShift windows
        const intervals = [];
        for (const ps0 of perShift) {
          const a0 = ps0.start;
          const b0 = Math.min(ps0.end, cutoffMs);
          if (b0 <= a0) continue;
          intervals.push({
            label: ps0.label,
            start: a0,
            end: b0,
            C: 0, P: 0,
            loads: 0, missing: 0,
            durHrs: Math.max(0.0001, (b0 - a0) / 3600000),
          });
        }

        // Distribute all due-before-cutoff loads into intervals; anything that doesn't fit becomes "unbucketed"
        const opsLoads3 = Array.isArray(STATE?.inboundLoads) ? STATE.inboundLoads : [];
        for (const l3 of opsLoads3) {
          const t3 = _getLoadTimeForPlanning(l3);
          if (!t3) continue;
          if (t3 < ops.startMs || t3 >= ops.endMs) continue;
          if (t3 > cutoffMs) continue;
          if (isCompleted(l3)) continue;

          const { C: c3, P: p3 } = getCounts(l3);
          const isMissing = (c3 == null && p3 == null);

          let placed = false;
          for (const iv of intervals) {
            if (t3 >= iv.start && t3 < iv.end) {
              iv.loads++;
              if (isMissing) { iv.missing++; placed = true; break; }
              if (c3 != null) iv.C += c3;
              if (p3 != null) iv.P += p3;
              placed = true;
              break;
            }
          }

          if (!placed) {
            loads_cut_unbucketed++;
            if (isMissing) { missing_cut_unbucketed++; continue; }
            if (c3 != null) sumC_cut_unbucketed += c3;
            if (p3 != null) sumP_cut_unbucketed += p3;
          }
        }

        // Finalize perShiftCut with HC estimates per interval (informational only)
        for (const iv of intervals) {
          const hc = Math.max(0, Math.ceil(iv.C / (iv.durHrs * targetCph)));
          perShiftCut.push({ ...iv, hc });
        }
      }


      // Render: Container Math UI (summary + optional details)
      const mathUi = panel.querySelector("#ssp2-plan-mathui");
      const mathBadge = panel.querySelector("#ssp2-plan-math-badge");

      // Build DETAILS text (shown when user clicks "Details")
      const lines = [];
      lines.push("Algorithm (moment-in-time headcount):");
      lines.push("  HC_now = ceil( C_remaining_in_shift / (hours_remaining_in_shift * target_CPH) )");
      lines.push("");
      lines.push("Selected Window Totals (Remaining only):");
      lines.push(`  C (containers): ${sumC_window.toLocaleString()}   |   P (pkgs): ${sumP_window.toLocaleString()}   |   missingCounts: ${missing_window}`);
      lines.push("");
      if (cutoffMs != null) {
        lines.push("Ops-to-Cutoff Totals (Remaining; due before cutoff):");
        lines.push(`  Window: ${fmtTime(ops.startMs)}→${fmtTime(cutoffMs)}  (loads: ${loads_cut}, missingCounts: ${missing_cut})`);
        lines.push(`  C (containers): ${sumC_cut.toLocaleString()}   |   P (pkgs): ${sumP_cut.toLocaleString()}`);
        lines.push("");
      } else {
        lines.push("Ops-to-Cutoff Totals: MOR2 not configured (no cutoff)");
        lines.push("");
      }

      // Primary staffing call (now → cutoff)
      if (cutoffMs != null) {
        const hrsLeft = (cutRemainingHrs != null) ? cutRemainingHrs : ((cutoffMs > nowMs) ? ((cutoffMs - nowMs) / 3600000) : 0);
        const hcTotal = (hc_cut_total != null) ? hc_cut_total : null;
        lines.push("Ops-to-Cutoff Staffing (Primary):");
        lines.push(`  Horizon: now→cutoff  (hrsLeft: ${Math.max(0, hrsLeft).toFixed(2)} | target: ${targetCph} CPH)`);
        lines.push(`  C_total_due: ${sumC_cut.toLocaleString()}  |  P_total_due: ${sumP_cut.toLocaleString()}  |  HC_total_now_to_cutoff: ${hcTotal == null ? "n/a" : hcTotal}`);
        if (perShiftCut && perShiftCut.length) {
          const bucketedC = perShiftCut.reduce((a,b)=>a+(b.C||0),0);
          const bucketedP = perShiftCut.reduce((a,b)=>a+(b.P||0),0);
          lines.push(`  Bucketed (sum of shift intervals ≤ cutoff): C=${bucketedC.toLocaleString()} P=${bucketedP.toLocaleString()} | Unbucketed: C=${(sumC_cut_unbucketed||0).toLocaleString()} P=${(sumP_cut_unbucketed||0).toLocaleString()} (loads=${loads_cut_unbucketed||0}, missingCounts=${missing_cut_unbucketed||0})`);
          lines.push("  Breakdown by shift interval (informational):");
          for (const iv of perShiftCut) {
            const span2 = `${fmtTime(iv.start)}→${fmtTime(iv.end)}`;
            lines.push(`    ${iv.label}  ${span2}  | C=${(iv.C||0).toLocaleString()} P=${(iv.P||0).toLocaleString()} | loads=${iv.loads||0} missing=${iv.missing||0} | HC_interval=${iv.hc||0}`);
          }
        } else {
          lines.push(`  Unbucketed: C=${(sumC_cut_unbucketed||0).toLocaleString()} P=${(sumP_cut_unbucketed||0).toLocaleString()} (loads=${loads_cut_unbucketed||0}, missingCounts=${missing_cut_unbucketed||0})`);
        }
        lines.push("");
      }

      lines.push("Shift-over-Shift (within Ops window):");
      const _active = perShift.find(ps => ps && ps.hcNow != null) || null;
      let _activePriorC = 0, _activePriorP = 0, _activeUnbucketedC = 0, _activeUnbucketedP = 0;
      if (_active) {
        for (const ps2 of perShift) {
          if (!ps2 || ps2 === _active) continue;
          if (ps2.end <= _active.end) {
            _activePriorC += (ps2.C || 0);
            _activePriorP += (ps2.P || 0);
          }
        }
        const dueC = (_active.hcNowDueC || 0);
        const dueP = (_active.hcNowDueP || 0);
        _activeUnbucketedC = Math.max(0, dueC - ((_active.C || 0) + _activePriorC));
        _activeUnbucketedP = Math.max(0, dueP - ((_active.P || 0) + _activePriorP));
      }

      for (const ps of perShift) {
        const span = `${fmtTime(ps.start)}→${fmtTime(ps.end)}`;
        let hcNowTxt = "";
        if (ps && ps.hcNow != null) {
          const dueC = (ps.hcNowDueC || 0);
          const dueP = (ps.hcNowDueP || 0);
          const hrsLeft = (ps.hcNowHrs || 0);
          const priorC = _active ? _activePriorC : 0;
          const priorP = _active ? _activePriorP : 0;
          const unbucketedC = _active ? _activeUnbucketedC : 0;
          const unbucketedP = _active ? _activeUnbucketedP : 0;
          hcNowTxt = ` | HC_now: ${ps.hcNow} (due<=shiftEnd C=${dueC.toLocaleString()} P=${dueP.toLocaleString()}; priorBucketed C=${priorC.toLocaleString()} P=${priorP.toLocaleString()}; unbucketed C=${unbucketedC.toLocaleString()} P=${unbucketedP.toLocaleString()}; hrsLeft=${hrsLeft.toFixed(2)})`;
        }
        lines.push(`  ${ps.label}  ${span}`);
        lines.push(`    Remaining: C=${ps.C.toLocaleString()} P=${ps.P.toLocaleString()} | loads=${ps.loads} missing=${ps.missing} | HC_shift: ${ps.hc}${hcNowTxt}`);
      }

      if (mathPre) mathPre.textContent = lines.join("\n");

      // SUMMARY cards for PAs/AMs (execution view)
      if (mathUi) {
        const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString());
        const hrsLeft = (cutoffMs != null) ? Math.max(0, (cutoffMs - nowMs) / 3600000) : null;

        // Progress within cutoff horizon (ops.start → cutoff)
        let prog = null;
        if (cutoffMs != null && cutoffMs > ops.startMs) {
          prog = Math.min(1, Math.max(0, (nowMs - ops.startMs) / (cutoffMs - ops.startMs)));
        }

        // Active bucket for execution
        const active = perShift.find(ps => ps && ps.hcNow != null) || null;

        // Staffing call
        const hcTotal = (hc_cut_total != null) ? hc_cut_total : null;

        // Badge severity
        if (mathBadge) {
          let sev = "STAFFING";
          if (cutoffMs == null) sev = "NO CUTOFF";
          else if ((sumC_cut_unbucketed || 0) > 0 || (missing_cut || 0) > 0) sev = "CHECK DATA";
          mathBadge.textContent = sev;
          mathBadge.style.background = (sev === "CHECK DATA") ? "#fff7ed" : (sev === "NO CUTOFF" ? "#fee2e2" : "#eef2ff");
          mathBadge.style.color = (sev === "CHECK DATA") ? "#9a3412" : (sev === "NO CUTOFF" ? "#991b1b" : "#1e3a8a");
        }

        const card = (title, bodyHtml, subHtml="") => `
          <div style="border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 10px 8px;margin-bottom:10px;background:rgba(255,255,255,.04);">
            <div style="font-weight:900;font-size:12px;color:#e5e7eb;letter-spacing:.2px;">${title}</div>
            <div style="margin-top:6px;">${bodyHtml}</div>
            ${subHtml ? `<div style="margin-top:6px;color:#cbd5e1;font-size:11px;">${subHtml}</div>` : ``}
          </div>
        `;

        const big = (n, label) => `
          <div style="display:flex;align-items:baseline;gap:10px;">
            <div style="font-size:40px;font-weight:1000;line-height:1;color:#ffffff;">${n}</div>
            <div style="font-size:12px;font-weight:900;color:#cbd5e1;">${label}</div>
          </div>
        `;

        const kv = (k,v) => `<div style="display:flex;justify-content:space-between;gap:10px;"><div style="color:#cbd5e1;font-weight:800;">${k}</div><div style="color:#ffffff;font-weight:900;">${v}</div></div>`;

        const progressBar = (p) => {
          if (p == null) return "";
          const pct = Math.round(p*100);
          return `
            <div style="margin-top:8px;">
              <div style="display:flex;justify-content:space-between;color:#cbd5e1;font-size:11px;font-weight:800;">
                <span>Time to cutoff</span><span>${pct}% elapsed</span>
              </div>
              <div style="height:10px;border-radius:999px;background:rgba(255,255,255,.10);overflow:hidden;margin-top:4px;">
                <div style="height:10px;width:${pct}%;background:rgba(147,197,253,.9);"></div>
              </div>
            </div>
          `;
        };

        // Breakdown list: show top intervals by C
        const topIntervals = (perShiftCut || []).slice().sort((a,b)=>((b.C||0)-(a.C||0))).slice(0,4);
        const breakdownHtml = topIntervals.length ? topIntervals.map(iv => `
          <div style="padding:6px 0;border-top:1px solid rgba(255,255,255,.10);">
            <div style="display:flex;justify-content:space-between;gap:10px;">
              <div style="font-weight:900;color:#ffffff;">${iv.label}</div>
              <div style="font-weight:900;color:#ffffff;">C ${fmtInt(iv.C)}</div>
            </div>
            <div style="display:flex;justify-content:space-between;color:#cbd5e1;font-size:11px;font-weight:800;">
              <span>${fmtTime(iv.start)}→${fmtTime(iv.end)}</span>
              <span>HC interval ${fmtInt(iv.hc)}</span>
            </div>
          </div>
        `).join("") : `<div style="color:#cbd5e1;font-size:11px;">No shift intervals found.</div>`;

        // Build UI
        let html = "";
        html += card(
          "Ops-to-Cutoff Headcount (Primary)",
          big(hcTotal == null ? "—" : String(hcTotal), "HC needed now→cutoff"),
          [
            kv("C due ≤ cutoff", fmtInt(sumC_cut)),
            kv("Hours left", hrsLeft == null ? "—" : hrsLeft.toFixed(2)),
            kv("Target", `${targetCph} CPH`),
            cutoffMs != null ? kv("Cutoff", fmtTime(cutoffMs)) : ""
          ].filter(Boolean).join(""),
        );
        html += progressBar(prog);

        if (active) {
          html += card(
            "Active Bucket",
            big(String(active.hcNow != null ? active.hcNow : active.hc), `${active.label}`),
            [
              kv("Due ≤ bucket end (C)", fmtInt(active.hcNowDueC)),
              kv("Bucket end", fmtTime(active.end)),
              kv("Hours left in bucket", (active.hcNowHrs != null ? active.hcNowHrs.toFixed(2) : "—"))
            ].join("")
          );
        }

        html += card(
          "Cutoff Breakdown",
          breakdownHtml,
          `Unbucketed: C ${fmtInt(sumC_cut_unbucketed || 0)} | Missing counts: ${fmtInt(missing_cut || 0)}`
        );

        mathUi.innerHTML = html;
      }


      // Render: debug (bottom-right)
      if (dbgMeta) {
        const PLAN = window.__SSP_PLAN__ || {};
        const sort = PLAN.sort || { key: "status", dir: "asc" };
        dbgMeta.textContent = `Sort: ${sort.key} (${sort.dir}) | Rows: ${rows.length} | Rendered: ${panel.querySelectorAll("#ssp2-plan-tbody tr").length}`;
      }
      if (dbgPre) {
        const PLAN = window.__SSP_PLAN__ || {};
        const sort = PLAN.sort || { key: "status", dir: "asc" };
        const sample = rows.slice(0, 6).map(l => ({
          vrid: l?.vrId || l?.vrid,
          status: l?.status,
          scheduled: l?.scheduledArrivalTime,
          arrived: l?.actualArrivalTime,
          equip: l?.equipmentType || l?.trailerEquipmentType,
          location: _getLoadLocationForPlanning(l),
          cntrsLeft: _getLoadContainersLeftForPlanning(l),
          pkgsLeft: (STATE.__planPkgs && l?.planId) ? STATE.__planPkgs[String(l.planId).trim()] : undefined,
        }));
        dbgPre.textContent = [
          `Window: ${new Date(wStart).toLocaleString()} → ${new Date(wEnd).toLocaleString()}`,
          `Ops: ${new Date(ops.startMs).toLocaleString()} → ${new Date(ops.endMs).toLocaleString()}`,
          `Sample: ${JSON.stringify(sample, null, 2)}`
        ].join("\n");
      }
    } catch (e) {
      // keep UI resilient
    }


    // Render table

    tbody.innerHTML = "";
    for (let i = 0; i < rows.length; i++) {
      try {
      const l = rows[i];
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid #f1f5f9";
      if (i % 2 === 1) tr.style.background = "#f3f4f6";

      const tdText = (v) => {
        const x = document.createElement("td");
        x.style.padding = "8px 6px";
        x.textContent = (v == null ? "" : String(v));
        return x;
      };

      const tdNode = (node) => {
        const x = document.createElement("td");
        x.style.padding = "8px 6px";
        if (node) x.appendChild(node);
        return x;
      };

      const vrid = String(l?.vrId || l?.vrid || "").trim();
      const planId = String(l?.planId || "").trim();
      const inboundLoadId = _getInboundLoadIdForHierarchy(l);
      const route = String(l?.route || l?.lane || "").trim();
      const status = String(l?.status || l?.loadStatus || "").trim();
      const sched = l?.scheduledArrivalTime ? String(l.scheduledArrivalTime) : "";
      const eta = l?.estimatedArrivalTime ? String(l.estimatedArrivalTime) : "";
      const arrived = l?.actualArrivalTime ? String(l.actualArrivalTime) : "";
      const equip = String(l?.equipmentType || l?.trailerEquipmentType || "").trim();
      const loc = String(_getLoadLocationForPlanning(l) || "").trim();


// Containers left (carts) from bulk getInboundContainerCount
let cntrsLeft = "";
try {
  cntrsLeft = String(_getLoadContainersLeftForPlanning(l) || "");
  // If we don't have it yet but the planId exists, show placeholder while bulk call resolves
  if (!cntrsLeft && planId) cntrsLeft = "…";
} catch {
  cntrsLeft = planId ? "…" : "";
}

      // VRID link -> Relay (opens new tab)
      let vrEl = null;
      if (vrid) {
        const a = document.createElement("a");
        a.href = (typeof _sspRelayTrackMapUrlForVrid === "function") ? _sspRelayTrackMapUrlForVrid(vrid) : buildRelayUrl(vrid);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = vrid;
        a.style.fontWeight = "900";
        a.style.color = "#1d4ed8";
        a.style.textDecoration = "none";
        a.onmouseenter = () => (a.style.textDecoration = "underline");
        a.onmouseleave = () => (a.style.textDecoration = "none");
        vrEl = a;
      }

      tr.appendChild(vrEl ? tdNode(vrEl) : tdText(vrid));
      tr.appendChild(tdText(planId));
      
      // Route (hover -> Relay iframe preview)
      let routeEl = null;
      try {
        const span = document.createElement("span");
        span.textContent = route || "";
        span.dataset.sspRelay = "lane";
        span.dataset.vrid = vrid || "";
        span.style.cursor = vrid ? "pointer" : "default";
        span.style.textDecoration = vrid ? "underline" : "none";
        span.style.fontWeight = "800";
        span.style.color = "#111827";
        if (vrid) span.title = "Hover to preview in Relay (map/track). Click to open.";
        span.addEventListener("mouseenter", () => {
          if (!vrid) return;
          const pop = _ensureRelayPreviewPopover();
          if (pop && pop.__sspCancelHide) pop.__sspCancelHide();
          _showRelayMiniForAnchor(span, vrid, (STATE && STATE.nodeId) || (STATE && STATE.nodeID) || "");
        });
        span.addEventListener("mouseleave", () => {
          const pop = document.getElementById("ssp2-relay-preview");
          if (pop && pop.__sspScheduleHide) pop.__sspScheduleHide();
        });
        span.addEventListener("click", (e) => {
          if (!vrid) return;
          e.preventDefault();
          const url = _sspRelayTrackMapUrlForVrid(vrid);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        });
        routeEl = span;
      } catch {
        routeEl = document.createTextNode(route || "");
      }
      tr.appendChild(tdNode(routeEl));

      tr.appendChild(tdText(status));
      tr.appendChild(tdText(cntrsLeft));
      tr.appendChild(tdText(sched));
      (function(){
        const sp = document.createElement("span");
        sp.textContent = eta || "…";
        sp.dataset.sspRelay = "eta";
        sp.dataset.vrid = vrid || "";
        tr.appendChild(tdNode(sp));
      })();
      (function(){
        const sp = document.createElement("span");
        sp.textContent = arrived || "…";
        sp.dataset.sspRelay = "arrived";
        sp.dataset.vrid = vrid || "";
        tr.appendChild(tdNode(sp));
      })();
      tr.appendChild(tdText(equip));
      tr.appendChild(tdText(loc));
      tbody.appendChild(tr);
      } catch (e) {
        // If any row is malformed, skip it but keep rendering.
        continue;
      }
    }
    // If nothing rendered, show a placeholder row.
    _updatePlanSortIndicators(panel);
    _sspHydratePlanningRelayTimes(panel);


    if (!tbody.children.length) {
      const tr0 = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.colSpan = 10;
      td0.style.padding = '10px 6px';
      td0.style.color = '#6b7280';
      td0.textContent = 'No rows rendered in table. (Rows exist in memory; see Debug panel.)';
      tr0.appendChild(td0);
      tbody.appendChild(tr0);
    }
  }


  /* =====================================================
     PILLAR HEADER + SETTINGS MODAL + SETTINGS MODAL
  ====================================================== */
  function ensurePillarHeader() {
    if (!isSspHost()) return;
    if (document.getElementById("ssp2-pillar")) return;

    const bar = document.createElement("div");
    bar.id = "ssp2-pillar";
    bar.style.cssText = `
      position:fixed;top:0;left:0;right:0;height:52px;
      display:${UI_PREFS.headerHidden ? "none" : "flex"};
      align-items:center;gap:10px;padding:0 14px;
      background:#ffffff;border-bottom:1px solid #e5e7eb;
      z-index:2147483647;font-family:Arial,sans-serif;
    `;

    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:800;">SSP Util 2.0</span>
        <span style="padding:2px 8px;border-radius:999px;background:#f3f4f6;border:1px solid #e5e7eb;font-weight:700;">ssp-dock</span>
        <span id="ssp2-h-node" style="padding:2px 8px;border-radius:999px;background:#eef2ff;border:1px solid #c7d2fe;font-weight:800;color:#1e3a8a;">node: …</span>
      </div>

      <div style="display:flex;align-items:center;gap:12px;margin-left:10px;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input id="ssp2-h-overlay" type="checkbox" ${SETTINGS.overlayOn ? "checked" : ""}/>
          <span style="font-weight:700;">Overlay</span>
        </label>

        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input id="ssp2-h-actionable" type="checkbox" ${SETTINGS.actionableOnly ? "checked" : ""}/>
          <span style="font-weight:700;">Actionable Only</span>
        </label>
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-left:14px;">
        <button id="ssp2-h-refresh" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Refresh</button>
        <button id="ssp2-h-settings" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Settings</button>
        <button id="ssp2-h-panel" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Panel</button>
        <button id="ssp2-h-relay-connect" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Relay Connect</button>

        <select id="ssp2-h-loadtype" title="Loads filter" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">
          <option value="all">All Loads</option>
          <option value="amzl_all">outboundAMZL (ALL)</option>
          <option value="amzl53">outboundAMZL (53)</option>
          <option value="amzl26">outboundAMZL (26)</option>
          <option value="ddu">DDU</option>
        </select>

</div>

      <div id="ssp2-h-status" title="Action Panel status" style="display:flex;align-items:center;gap:10px;margin-left:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:700;color:#111827;max-width:55vw;"></div>

      <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
        <button id="ssp2-h-plan" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Planning</button>
        <button id="ssp2-h-copy" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Copy VRIDs</button>
        <button id="ssp2-h-hide" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Hide</button>
      </div>
    `;

    document.body.appendChild(bar);

    document.documentElement.style.scrollPaddingTop = "60px";
    document.body.style.paddingTop = UI_PREFS.headerHidden ? "" : "56px";

    const $ = (sel) => bar.querySelector(sel);

    $("#ssp2-h-overlay").addEventListener("change", (e) => {
      SETTINGS.overlayOn = !!e.target.checked;
      persistSettings();
      if (!SETTINGS.overlayOn) removeOverlays();
      else renderOverlays();
      renderPanel();
    });

    $("#ssp2-h-actionable").addEventListener("change", (e) => {
      SETTINGS.actionableOnly = !!e.target.checked;
      persistSettings();
      // filter logic to be applied later
      renderPanel();
    });

    $("#ssp2-h-refresh").addEventListener("click", () => run(true));

    $("#ssp2-h-panel").addEventListener("click", () => {
      try { ensurePanel(); } catch (_) {}
      const panel = document.getElementById("ssp2-panel");
      if (!panel) return;
      UI_PREFS.panelHidden = !UI_PREFS.panelHidden;
      panel.style.display = UI_PREFS.panelHidden ? "none" : "flex";
      persistPrefs();
    });

    $("#ssp2-h-relay-connect")?.addEventListener("click", async () => {
      try {
        const st = await checkRelayConnectivity({ force: true, ttlMs: 0 });
        if (st && st.state === "no_auth") {
          window.open("https://track.relay.amazon.dev/", "_blank", "noopener");
          alert("Relay auth is not captured yet. A Relay tab was opened; load a VRID in Track, then click Relay Connect again.");
        } else {
          renderPanel();
          alert(`Relay connectivity: ${String(st?.state || "unknown")} — ${String(st?.message || "")}`);
        }
      } catch (e) {
        alert(`Relay connectivity check failed: ${String((e && e.message) || e || "unknown error")}`);
      }
    });
    // Loads dropdown: classify by route keyword
    const lt = document.getElementById("ssp2-h-loadtype");
    if (lt) {
      lt.value = normalizeObLoadType(SETTINGS.obLoadType || "all") || "all";
      lt.addEventListener("change", (e) => {
        SETTINGS.obLoadType = normalizeObLoadType(String(e.target.value || "all"));
        persistSettings();
        renderPanel();
      });
    }
    $("#ssp2-h-settings").addEventListener("click", () => openSettingsModal());

    $("#ssp2-h-copy").addEventListener("click", async () => {
      try {
        const selected = Array.from(STATE.bulkSelection || []);
        await navigator.clipboard.writeText(selected.join(", "));
        alert(`Copied ${selected.length} VRIDs`);
      } catch (e) {
        alert("Clipboard copy failed (check permissions).");
        console.error(e);
      }
    });



    $("#ssp2-h-plan").addEventListener("click", () => {
      // Planning Panel: ops-window inbound preview + shift window filters + exports
      try {
        ensurePlanningPanel();
        const pp = document.getElementById("ssp2-planpanel");
        if (!pp) return;
        pp.style.display = (pp.style.display === "none" || !pp.style.display) ? "flex" : "none";
        renderPlanningPanel();
      } catch (e) {
        console.error("[SSP Util] Planning panel failed", e);
      }
    });

    $("#ssp2-h-hide").addEventListener("click", () => {
      UI_PREFS.headerHidden = true;
      persistPrefs();
      bar.style.display = "none";
      document.body.style.paddingTop = "";
      ensureHeaderRestoreTab();
    });

    ensureHeaderRestoreTab();
  }

  function ensureHeaderRestoreTab() {
    if (!UI_PREFS.headerHidden) return;
    if (document.getElementById("ssp2-header-tab")) return;

    const tab = document.createElement("div");
    tab.id = "ssp2-header-tab";
    tab.textContent = "SSP Util";
    tab.style.cssText = `
      position:fixed;top:12px;left:12px;
      padding:8px 10px;
      border-radius:12px;
      background:#111827;color:#fff;
      font-family:Arial,sans-serif;
      font-weight:800;
      cursor:pointer;
      z-index:2147483647;
      box-shadow:0 6px 16px rgba(0,0,0,.25);
    `;

    tab.onclick = () => {
      UI_PREFS.headerHidden = false;
      persistPrefs();
      const bar = document.getElementById("ssp2-pillar");
      if (bar) bar.style.display = "flex";
      document.body.style.paddingTop = "56px";
      tab.remove();
    };

    document.body.appendChild(tab);
  }


  // =====================================================
  // Settings Tabs: Tool Settings + Shift Settings
  // =====================================================
  let __SSP2_SETTINGS_ACTIVE_TAB__ = "tool";

  function _installSettingsTabs(modal, defaultTab) {
    try {
      if (!modal) return;

      const header = modal.firstElementChild;
      const toolPanel = header?.nextElementSibling; // existing settings grid
      if (!header || !toolPanel) return;

      // Avoid double-install
      if (modal.querySelector("#ssp2-settings-tabbar")) {
        __SSP2_SETTINGS_ACTIVE_TAB__ = defaultTab || __SSP2_SETTINGS_ACTIVE_TAB__ || "tool";
        _setSettingsTab(modal, __SSP2_SETTINGS_ACTIVE_TAB__);
        return;
      }

      // Wrap tool panel
      toolPanel.id = "ssp2-settings-tab-tool";


      // Add Merge Debug toggle into Tool tab (non-intrusive)
      try {
        const dbgWrap = document.createElement("div");
        dbgWrap.style.cssText = "margin-top:10px;padding-top:10px;border-top:1px solid #e5e7eb;";
        dbgWrap.innerHTML = `
          <div style="font-weight:800;margin-bottom:6px;">Debug</div>
          <label style="display:flex;align-items:center;gap:10px;">
            <input id="ssp2-merge-debug" type="checkbox" ${SETTINGS.mergeDebug ? "checked" : ""} />
            <span>Show Merge Panel debug details</span>
          </label>
        `;
        toolPanel.appendChild(dbgWrap);
        dbgWrap.querySelector("#ssp2-merge-debug")?.addEventListener("change", (e) => {
          SETTINGS.mergeDebug = !!e.target.checked;
          persistSettings();
        });
      } catch {}


      // Tab bar
      const tabbar = document.createElement("div");
      tabbar.id = "ssp2-settings-tabbar";
      tabbar.style.cssText = "display:flex;gap:8px;align-items:center;padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb;";

      tabbar.innerHTML = `
        <button id="ssp2-tab-tool" style="padding:6px 10px;border-radius:10px;border:1px solid #e5e7eb;background:#111827;color:#fff;font-weight:900;cursor:pointer;">Tool</button>
        <button id="ssp2-tab-shift" style="padding:6px 10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;color:#111827;font-weight:900;cursor:pointer;">Shift</button>
        <div style="margin-left:auto;opacity:.7;font-weight:800;">Shift planning</div>
      `;

      // Shift panel
      const shiftPanel = document.createElement("div");
      shiftPanel.id = "ssp2-settings-tab-shift-panel";
      shiftPanel.style.cssText = "padding:14px;display:none;";

      shiftPanel.innerHTML = _renderShiftSettingsHtml();

      // Insert tabbar + shift panel
      header.insertAdjacentElement("afterend", tabbar);
      tabbar.insertAdjacentElement("afterend", shiftPanel);

      // Wire tab clicks
      tabbar.querySelector("#ssp2-tab-tool")?.addEventListener("click", () => _setSettingsTab(modal, "tool"));
      tabbar.querySelector("#ssp2-tab-shift")?.addEventListener("click", () => _setSettingsTab(modal, "shift"));

      // Wire shift editor handlers
      _wireShiftSettingsHandlers(modal);

      __SSP2_SETTINGS_ACTIVE_TAB__ = defaultTab || "tool";
      _setSettingsTab(modal, __SSP2_SETTINGS_ACTIVE_TAB__);
    } catch (e) {
      // fail closed: keep tool settings usable
      console.warn("SSP Util: settings tabs install failed", e);
    }
  }

  function _setSettingsTab(modal, tab) {
    __SSP2_SETTINGS_ACTIVE_TAB__ = tab || "tool";
    const tool = modal.querySelector("#ssp2-settings-tab-tool");
    const shift = modal.querySelector("#ssp2-settings-tab-shift-panel");
    const bTool = modal.querySelector("#ssp2-tab-tool");
    const bShift = modal.querySelector("#ssp2-tab-shift");

    if (tool) tool.style.display = (__SSP2_SETTINGS_ACTIVE_TAB__ === "tool") ? "grid" : "none";
    if (shift) shift.style.display = (__SSP2_SETTINGS_ACTIVE_TAB__ === "shift") ? "block" : "none";

    if (bTool) {
      bTool.style.background = (__SSP2_SETTINGS_ACTIVE_TAB__ === "tool") ? "#111827" : "#fff";
      bTool.style.color = (__SSP2_SETTINGS_ACTIVE_TAB__ === "tool") ? "#fff" : "#111827";
    }
    if (bShift) {
      bShift.style.background = (__SSP2_SETTINGS_ACTIVE_TAB__ === "shift") ? "#111827" : "#fff";
      bShift.style.color = (__SSP2_SETTINGS_ACTIVE_TAB__ === "shift") ? "#fff" : "#111827";
    }
  }

  function _renderShiftSettingsHtml() {
    // SHIFT_SETTINGS is defined in the staffing module; if not present, show placeholder.
    const targetCph = (typeof SHIFT_SETTINGS !== "undefined" && SHIFT_SETTINGS?.targetCph) ? SHIFT_SETTINGS.targetCph : 15;
    const siteCode = (typeof SHIFT_SETTINGS !== "undefined" && SHIFT_SETTINGS?.siteCode) ? SHIFT_SETTINGS.siteCode : (STATE.nodeId || "");
    return `
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff;">
        <div style="font-weight:900;margin-bottom:10px;">Shift Settings</div>

        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;">
          <label style="display:flex;flex-direction:column;gap:6px;min-width:260px;">
            <span style="font-weight:800;opacity:.8;">Target CPH (containers per AA-hour)</span>
            <input id="s-shift-targetcph" type="number" min="1" step="0.1" value="${targetCph}"
              style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          </label>

          <label style="display:flex;flex-direction:column;gap:6px;min-width:180px;">
            <span style="font-weight:800;opacity:.8;">Site Code</span>
            <input id="s-shift-sitecode" type="text" value="${siteCode}"
              style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          </label>

          <button id="s-shift-add" style="padding:8px 10px;border-radius:10px;border:1px solid #e5e7eb;background:#111827;color:#fff;font-weight:900;cursor:pointer;">Add shift</button>
          <button id="s-shift-save" style="padding:8px 10px;border-radius:10px;border:1px solid #e5e7eb;background:#10b981;color:#fff;font-weight:900;cursor:pointer;">Save</button>
        </div>

        <div style="margin-top:12px;border-top:1px solid #e5e7eb;padding-top:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Shifts</div>
          <div style="overflow-x:auto;padding-bottom:6px;">
            <div style="min-width:980px;">
              <div style="display:grid;grid-template-columns:80px 140px 110px 90px 110px 90px 90px 120px 60px;gap:8px;align-items:center;font-weight:900;opacity:.75;">
            <div>On</div><div>Name</div><div>Start Day</div><div>Start</div><div>End Day</div><div>End</div><div>Staffed</div><div>Override</div><div></div>
          </div>
          <div id="s-shift-rows" style="margin-top:8px;display:flex;flex-direction:column;gap:8px;"></div>
            </div>
          </div>
          <div style="margin-top:10px;font-size:12px;opacity:.7;">
            Use Current→Next for cross-midnight shifts (Wrap). Use Next→Next for Mor2-style planning.
          </div>
        </div>
      </div>
    `;
  }

  function _wireShiftSettingsHandlers(modal) {
    const shiftPanel = modal.querySelector("#ssp2-settings-tab-shift-panel");
    if (!shiftPanel) return;

    const rowsEl = shiftPanel.querySelector("#s-shift-rows");
    const btnAdd = shiftPanel.querySelector("#s-shift-add");
    const btnSave = shiftPanel.querySelector("#s-shift-save");

    function renderRows() {
      if (!rowsEl) return;
      const shifts = (typeof SHIFT_SETTINGS !== "undefined" && Array.isArray(SHIFT_SETTINGS?.shifts)) ? SHIFT_SETTINGS.shifts : [];
      rowsEl.innerHTML = "";
      shifts.forEach((s, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:80px 140px 110px 90px 110px 90px 90px 120px 60px;gap:8px;align-items:center;";
        row.innerHTML = `
          <input data-k="enabled:${idx}" type="checkbox" ${s.enabled ? "checked" : ""} />
          <input data-k="name:${idx}" type="text" value="${String(s.name||"")}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          <select data-k="startDay:${idx}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;">
            <option value="0" ${Number(s.startDay||0)===0?"selected":""}>Current</option>
            <option value="1" ${Number(s.startDay||0)===1?"selected":""}>Next</option>
          </select>
          <input data-k="start:${idx}" type="text" value="${String(s.start||"")}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          <select data-k="endDay:${idx}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;">
            <option value="0" ${Number(s.endDay||0)===0?"selected":""}>Current</option>
            <option value="1" ${Number(s.endDay||0)===1?"selected":""}>Next</option>
          </select>
          <input data-k="end:${idx}" type="text" value="${String(s.end||"")}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          <input data-k="staffedAAs:${idx}" type="number" value="${Number(s.staffedAAs||0)}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          <input data-k="containerOverride:${idx}" type="number" value="${String(s.containerOverride??"")}" style="padding:8px;border-radius:10px;border:1px solid #e5e7eb;" />
          <button data-del="${idx}" style="padding:8px 10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;font-weight:900;cursor:pointer;">Del</button>
        `;
        rowsEl.appendChild(row);
      });

      rowsEl.querySelectorAll("button[data-del]").forEach(btn => {
        btn.addEventListener("click", () => {
          const i = Number(btn.getAttribute("data-del"));
          if (!Number.isFinite(i)) return;
          if (typeof SHIFT_SETTINGS === "undefined") return;
          SHIFT_SETTINGS.shifts.splice(i, 1);
          renderRows();
        });
      });
    }

    btnAdd?.addEventListener("click", () => {
      if (typeof SHIFT_SETTINGS === "undefined") return;
      SHIFT_SETTINGS.shifts.push({
        id: `shift_${Date.now()}`,
        name: "New Shift",
        enabled: true,
        start: "07:00",
        startDay: 0,
        end: "11:00",
        endDay: 0,
        staffedAAs: 0,
        containerOverride: "",
      });
      renderRows();
    });

    btnSave?.addEventListener("click", () => {
      if (typeof SHIFT_SETTINGS === "undefined") return;

      const cph = Number(shiftPanel.querySelector("#s-shift-targetcph")?.value);
      if (Number.isFinite(cph) && cph > 0) SHIFT_SETTINGS.targetCph = cph;

      const site = String(shiftPanel.querySelector("#s-shift-sitecode")?.value || "").trim();
      if (site) SHIFT_SETTINGS.siteCode = site;

      // Commit row edits
      shiftPanel.querySelectorAll("[data-k]").forEach(el => {
        const key = el.getAttribute("data-k");
        if (!key) return;
        const [field, idxStr] = key.split(":");
        const idx = Number(idxStr);
        if (!Number.isFinite(idx) || !SHIFT_SETTINGS.shifts[idx]) return;
        const s = SHIFT_SETTINGS.shifts[idx];

        if (el.type === "checkbox") s[field] = el.checked;
        else if (field === "startDay" || field === "endDay") s[field] = Number(el.value) ? 1 : 0;
        else if (field === "staffedAAs") s.staffedAAs = Number(el.value) || 0;
        else if (field === "containerOverride") s.containerOverride = String(el.value || "").trim();
        else s[field] = String(el.value || "").trim();
      });

      if (typeof saveShiftSettings === "function") saveShiftSettings(SHIFT_SETTINGS);
      // Update panel status after saving shift settings
      try { if (typeof renderPanel === 'function') renderPanel(); } catch {}
    });

    // Initial render
    renderRows();
  }
function openSettingsModal(defaultTab) {
    if (document.getElementById("ssp2-settings-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "ssp2-settings-backdrop";
    backdrop.style.cssText = `
      position:fixed;inset:0;
      background:rgba(0,0,0,.35);
      z-index:2147483647;
      display:flex;align-items:center;justify-content:center;
      font-family:Arial,sans-serif;
    `;

    const modal = document.createElement("div");
    modal.id = "ssp2-settings-modal";
    modal.style.cssText = `
      width:720px;max-width:92vw;
      background:#fff;border-radius:14px;
      box-shadow:0 10px 30px rgba(0,0,0,.25);
      border:1px solid #e5e7eb;
      overflow:hidden;
    `;

    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:900;">SSP Util 2.0 — Settings</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="ssp2-settings-reset" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Reset</button>
          <button id="ssp2-settings-close" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Close</button>
        </div>
      </div>

      <div style="padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Refresh</div>
          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Refresh interval (seconds)</span>
            <input id="s-refresh" type="number" min="10" step="5" value="${SETTINGS.refreshSeconds}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Inbound CSV Alerts</div>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">CPT buffer cutoff (minutes)</span>
            <input id="s-buffer" type="number" min="0" step="5" value="${SETTINGS.ibCptBufferMinutes}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Alert lead min (minutes)</span>
            <input id="s-leadmin" type="number" min="0" step="1" value="${SETTINGS.ibAlertLeadMinMinutes}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Alert lead max (minutes)</span>
            <input id="s-leadmax" type="number" min="0" step="1" value="${SETTINGS.ibAlertLeadMaxMinutes}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <div style="margin-top:8px;color:#6b7280;font-size:11px;">
            Note: This is settings-only right now. The timed “Pull CSV” prompt will be wired next.
          </div>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Merge Thresholds</div>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Merge Soon threshold</span>
            <input id="s-soon" type="number" min="0" max="1" step="0.05" value="${SETTINGS.mergeSoon}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Merge Now threshold</span>
            <input id="s-now" type="number" min="0" max="1" step="0.05" value="${SETTINGS.mergeNow}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Equipment Capacities</div>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">53' carts capacity</span>
            <input id="s-cap53" type="number" min="1" step="1" value="${SETTINGS.cap53ftCarts}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">26' carts capacity</span>
            <input id="s-cap26" type="number" min="1" step="1" value="${SETTINGS.cap26ftCarts}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>


          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Cube truck carts capacity</span>
            <input id="s-capcube" type="number" min="1" step="1" value="${SETTINGS.capCubeCarts}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>


</div>
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Colors</div>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">OK</span>
            <input id="s-colok" type="text" value="${SETTINGS.colorOk}"
              style="width:180px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;font-family:monospace;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Merge Soon</span>
            <input id="s-colsoon" type="text" value="${SETTINGS.colorSoon}"
              style="width:180px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;font-family:monospace;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Merge Now</span>
            <input id="s-colnow" type="text" value="${SETTINGS.colorNow}"
              style="width:180px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;font-family:monospace;"/>
          </label>

          <div style="margin-top:8px;color:#6b7280;font-size:11px;">
            Use hex colors (e.g., #16a34a).
          </div>
        </div>


        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Highlights</div>

          <div style="color:#6b7280;font-size:11px;margin-bottom:10px;">
            Add keyword-to-color mappings. Any cell that contains the keyword will be highlighted.
          </div>

          <div id="s-hl-list" style="display:flex;flex-direction:column;gap:8px;"></div>

          <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
            <input id="s-hl-keyword" placeholder="keyword (e.g., Fifty)" style="flex:1;min-width:180px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
            <input id="s-hl-color" type="color" value="#2563eb" style="width:44px;height:34px;border:1px solid #d1d5db;border-radius:10px;padding:0;"/>
            <button id="s-hl-add" style="padding:8px 12px;border-radius:10px;border:1px solid #d1d5db;background:#111827;color:#fff;font-weight:800;cursor:pointer;">
              Add
            </button>
          </div>

          <div style="margin-top:8px;color:#6b7280;font-size:11px;">
            Tip: keep keywords short and specific. First match wins if multiple keywords match the same cell.
          </div>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Toggles</div>
          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Overlay enabled</span>
            <input id="s-ov" type="checkbox" ${SETTINGS.overlayOn ? "checked" : ""}/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Actionable only</span>
            <input id="s-act" type="checkbox" ${SETTINGS.actionableOnly ? "checked" : ""}/>
          </label>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;">
          <div style="font-weight:900;margin-bottom:8px;">Diagnostics</div>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Enable diagnostics</span>
            <input id="s-diag-on" type="checkbox" ${SETTINGS.diagEnabled ? "checked" : ""}/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Console logging</span>
            <input id="s-diag-console" type="checkbox" ${SETTINGS.diagConsole ? "checked" : ""}/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Capture payload subset</span>
            <input id="s-diag-payload" type="checkbox" ${SETTINGS.diagCapturePayload ? "checked" : ""}/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Failures only</span>
            <input id="s-diag-failonly" type="checkbox" ${SETTINGS.diagFailuresOnly ? "checked" : ""}/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;">Max events</span>
            <input id="s-diag-max" type="number" min="50" step="10" value="${SETTINGS.diagMaxEvents}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <label style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <span style="font-weight:700;">Max chars</span>
            <input id="s-diag-chars" type="number" min="1000" step="500" value="${SETTINGS.diagMaxChars}"
              style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          </label>

          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
            <button id="s-diag-copy" style="padding:8px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Copy entities (since last refresh)</button>
            <button id="s-diag-dl" style="padding:8px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Download diag.json</button>
            <button id="s-diag-clear" style="padding:8px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Clear</button>
            <button id="s-diag-lasterr" style="padding:8px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">Copy last error</button>
          </div>

          <div style="margin-top:8px;color:#6b7280;font-size:11px;">
            Diagnostics records fetchdata entities and timing per refresh cycle. Use “Download diag.json” when reporting issues.
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px;padding:12px 14px;border-top:1px solid #e5e7eb;background:#fafafa;">
        <button id="ssp2-settings-cancel" style="padding:8px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">Cancel</button>
        <button id="ssp2-settings-save" style="padding:8px 12px;border-radius:10px;border:1px solid #111827;background:#111827;color:#fff;font-weight:900;cursor:pointer;">Save</button>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Prevent number-input spinner runaway in Settings (mouse-up can be lost due to overlay interactions).
    // Behavior: allow a single increment/decrement click, but stop hold-to-repeat by blurring shortly after pointerdown.
    try {
      const numInputs = Array.from(modal.querySelectorAll('input[type="number"]') || []);
      numInputs.forEach((inp) => {
        inp.addEventListener("pointerdown", (e) => {
          // Only for mouse interactions; touch users may want press-and-hold.
          if (e && e.pointerType && e.pointerType !== "mouse") return;
          // Stop propagation so panel-level handlers can't interfere with click lifecycle.
          try { e.stopPropagation(); } catch {}
          // Break the browser's auto-repeat after a short delay.
          window.setTimeout(() => {
            try { if (document.activeElement === inp) inp.blur(); } catch {}
          }, 180);
        }, true);

        inp.addEventListener("mousedown", (e) => { try { e.stopPropagation(); } catch {} }, true);
        inp.addEventListener("mouseup", (e) => { try { e.stopPropagation(); } catch {} }, true);
      });
    } catch {}

    _installSettingsTabs(modal, defaultTab);

    const close = () => backdrop.remove();

    const readNum = (id) => Number(document.getElementById(id)?.value);
    const readStr = (id) => String(document.getElementById(id)?.value || "");
    const readChk = (id) => !!document.getElementById(id)?.checked;

    // Diagnostics controls (independent of Save/Cancel)
    try {
      const btnCopy = document.getElementById("s-diag-copy");
      const btnDl = document.getElementById("s-diag-dl");
      const btnClear = document.getElementById("s-diag-clear");
      const btnErr = document.getElementById("s-diag-lasterr");

      if (btnCopy) {
        btnCopy.onclick = () => {
          const store = window.__SSP_DIAG || { runId: 0, lastRefreshTs: 0, events: [] };
          const ts0 = Number(store.lastRefreshTs || 0);
          const evsAll = Array.isArray(store.events) ? store.events : [];
          const evs = ts0 ? evsAll.filter(e => e && e.ts >= ts0) : evsAll;

          const compact = evs.map(e => {
            const out = {
              ts: e.ts,
              runId: e.runId,
              area: e.area,
              entity: e.entity,
              ms: e.ms,
              status: e.status,
              ok: e.ok,
              note: e.note,
            };
            // Include safe payload subset only when capture is enabled and present.
            if (SETTINGS && SETTINGS.diagCapturePayload && e.payload) {
              if (e.payload.safe) out.payloadSafe = e.payload.safe;
              else if (e.payload.keys) out.payloadKeys = e.payload.keys;
            }
            return out;
          });

          diagCopy(JSON.stringify(compact, null, 2));
        };
      }

      if (btnDl) {
        btnDl.onclick = () => {
          const store = window.__SSP_DIAG || { runId: 0, lastRefreshRunId: 0, lastRefreshTs: 0, events: [], lastError: null };
          diagDownload(`ssp_util_diag_${Date.now()}.json`, store);
        };
      }

      if (btnClear) {
        btnClear.onclick = () => {
          if (!window.__SSP_DIAG) window.__SSP_DIAG = { runId: 0, lastRefreshRunId: 0, lastRefreshTs: 0, events: [], lastError: null };
          window.__SSP_DIAG.events = [];
          window.__SSP_DIAG.lastError = null;
          try { alert("SSP Util: diagnostics cleared."); } catch (_) {}
        };
      }

      if (btnErr) {
        btnErr.onclick = () => {
          const store = window.__SSP_DIAG || {};
          diagCopy(JSON.stringify(store.lastError || null, null, 2));
        };
      }
    } catch (_) {}

    // Highlights editor
    const hlList = document.getElementById("s-hl-list");
    const hlKey = document.getElementById("s-hl-keyword");
    const hlColor = document.getElementById("s-hl-color");
    const hlAdd = document.getElementById("s-hl-add");

    function renderHighlightList(mappings) {
      if (!hlList) return;
      hlList.innerHTML = "";
      if (!mappings.length) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#6b7280;font-size:11px;padding:6px 0;";
        empty.textContent = "No highlights configured.";
        hlList.appendChild(empty);
        return;
      }

      mappings.forEach((m, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;align-items:center;";
        row.innerHTML = `
          <input data-hl-k="${idx}" value="${escapeHtml(m.keyword)}"
            style="flex:1;min-width:160px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;"/>
          <input data-hl-c="${idx}" type="color" value="${m.color}"
            style="width:44px;height:34px;border:1px solid #d1d5db;border-radius:10px;padding:0;"/>
          <button data-hl-del="${idx}" style="padding:8px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:800;cursor:pointer;">
            Remove
          </button>
        `;
        hlList.appendChild(row);
      });

      // wire remove
      hlList.querySelectorAll("[data-hl-del]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = Number(btn.getAttribute("data-hl-del"));
          const next = normalizeHighlights(SETTINGS.highlights);
          next.splice(i, 1);
          SETTINGS.highlights = next;
          renderHighlightList(next);
        });
      });
    }

    // initial render from persisted settings
    SETTINGS.highlights = normalizeHighlights(SETTINGS.highlights);
    renderHighlightList(SETTINGS.highlights);

    if (hlAdd) {
      hlAdd.addEventListener("click", () => {
        const keyword = String(hlKey?.value || "").trim();
        const color = String(hlColor?.value || "").trim() || "#2563eb";
        if (!keyword) return;
        const next = normalizeHighlights([...(normalizeHighlights(SETTINGS.highlights)), { keyword, color }]);
        SETTINGS.highlights = next;
        if (hlKey) hlKey.value = "";
        renderHighlightList(next);
      });
    }

    function readHighlightListFromDom() {
      const keywordInputs = Array.from(hlList?.querySelectorAll("input[data-hl-k]") || []);
      const colorInputs = Array.from(hlList?.querySelectorAll("input[data-hl-c]") || []);
      const byIdx = {};
      keywordInputs.forEach((el) => { byIdx[el.getAttribute("data-hl-k")] = byIdx[el.getAttribute("data-hl-k")] || {}; byIdx[el.getAttribute("data-hl-k")].keyword = el.value; });
      colorInputs.forEach((el) => { byIdx[el.getAttribute("data-hl-c")] = byIdx[el.getAttribute("data-hl-c")] || {}; byIdx[el.getAttribute("data-hl-c")].color = el.value; });
      const rows = Object.keys(byIdx).sort((a,b)=>Number(a)-Number(b)).map(k => byIdx[k]);
      return normalizeHighlights(rows);
    }

    document.getElementById("ssp2-settings-close").onclick = close;
    document.getElementById("ssp2-settings-cancel").onclick = close;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    document.getElementById("ssp2-settings-reset").onclick = () => {
      SETTINGS = { ...DEFAULT_SETTINGS };
      persistSettings();
      close();
      // re-open with defaults
      openSettingsModal();
    };

    document.getElementById("ssp2-settings-save").onclick = () => {
      const next = { ...SETTINGS };

      // --- SHIFT TAB COMMIT (so the bottom Save also persists Shift Settings) ---
      try {
        const shiftPanel = modal.querySelector("#ssp2-settings-tab-shift-panel");
        if (shiftPanel && typeof SHIFT_SETTINGS !== "undefined") {
          const cph = Number(shiftPanel.querySelector("#s-shift-targetcph")?.value);
          if (Number.isFinite(cph) && cph > 0) SHIFT_SETTINGS.targetCph = cph;

          const site = String(shiftPanel.querySelector("#s-shift-sitecode")?.value || "").trim();
          if (site) SHIFT_SETTINGS.siteCode = site;

          // Commit row edits (even if user didn't press the Shift-tab Save button)
          shiftPanel.querySelectorAll("[data-k]").forEach(el => {
            const key = el.getAttribute("data-k");
            if (!key) return;
            const [field, idxStr] = key.split(":");
            const idx = Number(idxStr);
            if (!Number.isFinite(idx) || !SHIFT_SETTINGS.shifts[idx]) return;
            const s = SHIFT_SETTINGS.shifts[idx];

            if (el.type === "checkbox") s[field] = el.checked;
            else if (field === "startDay" || field === "endDay") s[field] = Number(el.value) ? 1 : 0;
            else if (field === "staffedAAs") s.staffedAAs = Number(el.value) || 0;
            else if (field === "containerOverride") s.containerOverride = String(el.value || "").trim();
            else s[field] = String(el.value || "").trim();
          });

          if (typeof saveShiftSettings === "function") saveShiftSettings(SHIFT_SETTINGS);
        }
      } catch {}


      next.highlights = readHighlightListFromDom();

      next.refreshSeconds = Math.max(10, readNum("s-refresh") || DEFAULT_SETTINGS.refreshSeconds);

      next.ibCptBufferMinutes = Math.max(0, readNum("s-buffer") || DEFAULT_SETTINGS.ibCptBufferMinutes);
      next.ibAlertLeadMinMinutes = Math.max(0, readNum("s-leadmin") || DEFAULT_SETTINGS.ibAlertLeadMinMinutes);
      next.ibAlertLeadMaxMinutes = Math.max(0, readNum("s-leadmax") || DEFAULT_SETTINGS.ibAlertLeadMaxMinutes);

      // ensure leadMin <= leadMax
      if (next.ibAlertLeadMinMinutes > next.ibAlertLeadMaxMinutes) {
        const tmp = next.ibAlertLeadMinMinutes;
        next.ibAlertLeadMinMinutes = next.ibAlertLeadMaxMinutes;
        next.ibAlertLeadMaxMinutes = tmp;
      }

      next.mergeSoon = Math.min(1, Math.max(0, readNum("s-soon") || DEFAULT_SETTINGS.mergeSoon));
      next.mergeNow = Math.min(1, Math.max(0, readNum("s-now") || DEFAULT_SETTINGS.mergeNow));

      next.cap53ftCarts = Math.max(1, readNum("s-cap53") || DEFAULT_SETTINGS.cap53ftCarts);
      next.cap26ftCarts = Math.max(1, readNum("s-cap26") || DEFAULT_SETTINGS.cap26ftCarts);
      next.capCubeCarts = Math.max(1, readNum("s-capcube") || DEFAULT_SETTINGS.capCubeCarts);

      next.colorOk = readStr("s-colok") || DEFAULT_SETTINGS.colorOk;
      next.colorSoon = readStr("s-colsoon") || DEFAULT_SETTINGS.colorSoon;
      next.colorNow = readStr("s-colnow") || DEFAULT_SETTINGS.colorNow;

      next.overlayOn = readChk("s-ov");
      next.actionableOnly = readChk("s-act");

      // Diagnostics
      next.diagEnabled = readChk("s-diag-on");
      next.diagConsole = readChk("s-diag-console");
      next.diagCapturePayload = readChk("s-diag-payload");
      next.diagFailuresOnly = readChk("s-diag-failonly");
      next.diagMaxEvents = Math.max(50, readNum("s-diag-max") || DEFAULT_SETTINGS.diagMaxEvents);
      next.diagMaxChars = Math.max(1000, readNum("s-diag-chars") || DEFAULT_SETTINGS.diagMaxChars);

      SETTINGS = next;
      persistSettings();

      // reflect header toggle checkboxes immediately
      const ov = document.getElementById("ssp2-h-overlay");
      const act = document.getElementById("ssp2-h-actionable");
      if (ov) ov.checked = SETTINGS.overlayOn;
      if (act) act.checked = SETTINGS.actionableOnly;

      // apply immediately
      // Overlays can be toggled off, but phone icons should still bind/rebind.
      try { bindPhoneIconsOnDashboard(); } catch {}
    try { scheduleDriverPrefetch('renderOverlays'); } catch {}

      if (!SETTINGS.overlayOn) removeOverlays();
      else renderOverlays();

      // update timer interval
      applyRefreshTimer();

      renderPanel();
      close();
      run(true);
    };
  }

  /* =====================================================
     REFRESH TIMER MANAGEMENT
  ====================================================== */
  let refreshHandle = null;

  function applyRefreshTimer() {
    if (refreshHandle) clearInterval(refreshHandle);
    refreshHandle = setInterval(() => run(false), Math.max(10, SETTINGS.refreshSeconds) * 1000);
    log("Refresh timer set:", SETTINGS.refreshSeconds, "seconds");
  }

  /** Detect currently selected node/facility id. Prefer URL nodeId, then UI control, then storage/global state. */

function detectNodeId() {
  const isNode = (v) => {
    const s = String(v || "").trim().toUpperCase();
    return /^[A-Z0-9]{3,6}$/.test(s) ? s : "";
  };

  // 1) Canonical: URL param nodeId
  try {
    const u = new URL(window.location.href);
    const v = isNode(u.searchParams.get("nodeId"));
    if (v) { __sspMarkUsed("nodeId:url.nodeId"); return v; }
  } catch (_) {}

  // 2) Common node selectors (explicit)
  try {
    const sel = document.querySelector('select#nodeId, select[name="nodeId"], select[id*="node" i], select[name*="node" i], select[id*="facility" i], select[name*="facility" i]');
    const v = isNode(sel && sel.value);
    if (v) { __sspMarkUsed("nodeId:select"); return v; }
  } catch (_) {}

  // 3) Any option currently selected that looks like a nodeId
  try {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const s of selects) {
      const v = isNode(s && s.value);
      if (!v) continue;
      const id = (s.id || "").toLowerCase();
      const name = (s.name || "").toLowerCase();
      if (id.includes('node') || name.includes('node') || id.includes('facility') || name.includes('facility')) {
        __sspMarkUsed("nodeId:select.scan");
        return v;
      }
    }
  } catch (_) {}

  // 4) localStorage/sessionStorage (some SSP surfaces persist the last node)
  try {
    const keys = ["nodeId","selectedNodeId","scNodeId","facility","site","warehouse"];
    for (const k of keys) {
      const lv = isNode(localStorage.getItem(k));
      if (lv) { __sspMarkUsed(`nodeId:localStorage.${k}`); return lv; }
      const sv = isNode(sessionStorage.getItem(k));
      if (sv) { __sspMarkUsed(`nodeId:sessionStorage.${k}`); return sv; }
    }
  } catch (_) {}

  // 5) Known globals (shallow scan only)
  try {
    const candidates = [
      window.STATE,
      window.__STATE__,
      window.__INITIAL_STATE__,
      window.__PRELOADED_STATE__,
      window.__APP_STATE__,
    ];
    for (const obj of candidates) {
      const v = isNode(obj && (obj.nodeId || obj.facility || obj.site || obj.scNodeId));
      if (v) { __sspMarkUsed("nodeId:global"); return v; }
    }
  } catch (_) {}

  // 6) DOM text sniff (lightweight)
  try {
    const txt = document.body ? document.body.innerText : "";
    const m = txt && txt.match(/\b(?:Node|Facility)\s*[:#-]?\s*([A-Z0-9]{3,6})\b/);
    const v = isNode(m && m[1]);
    if (v) { __sspMarkUsed("nodeId:domText"); return v; }
  } catch (_) {}

  __sspMarkUsed("nodeId:none");
  return String(STATE && STATE.nodeId || "").trim();
}


  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function ensureNodeIdReady(opts={}) {
    const retries = Number.isFinite(opts.retries) ? opts.retries : 80;
    const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 250;
    for (let i = 0; i < retries; i++) {
      const nid = detectNodeId();
      if (nid) return nid;
      await sleep(delayMs);
    }
    return '';
  }

/* =====================================================
     MAIN LOOP
  ====================================================== */
  async function run(force = false) {

    if (STATE.running && !force) return;
    STATE.running = true;

    // Diagnostics: new refresh cycle marker
    try {
      const nowTs = Date.now();
      if (window.__SSP_DIAG) {
        window.__SSP_DIAG.runId = (window.__SSP_DIAG.runId || 0) + 1;
        window.__SSP_DIAG.lastRefreshRunId = window.__SSP_DIAG.runId;
        window.__SSP_DIAG.lastRefreshTs = nowTs;
      } else {
        window.__SSP_DIAG = { runId: 1, lastRefreshRunId: 1, lastRefreshTs: nowTs, events: [], lastError: null };
      }
    } catch (_) {}

    try {
      // node selection: canonical nodeId from URL
      __sspLogUrlParamsOnce("run");
      // NodeId can be injected after initial render (SPA). Wait briefly before making any API calls.
      STATE.nodeId = await ensureNodeIdReady({ retries: 80, delayMs: 250 });
      log("Running SSP Util for", STATE.nodeId);

      if (!STATE.nodeId) {
        STATE.lastError = "Unable to detect nodeId from URL (nodeId=). Skipping fetches to avoid SSP ok=false errors.";
        renderPanel();
        return;
      }

      await loadInbound();
      await loadIB4CPT();
      await loadOutbound();
      computeCPTUtilization();
      renderOverlays();
      applyHighlights();

      STATE.lastRun = new Date();
      renderPanel();
    } catch (e) {
      setLastError("run(): Unhandled", e, null);
      renderPanel();
    } finally {
      STATE.running = false;
    }
  }

  /* =====================================================
     BOOT
  ====================================================== */

/* ============================================================
   MERGE PANEL (Phase 2 UI)
   - Opened ONLY from the Action Panel by clicking the merge tag (MERGE NOW / MERGE SOON / OK).
   - Displays dual charts: Underutilized outbound VRIDs (left) + Mergeable inbound VRIDs (right).
   - Bottom: Inbound VRIDs for this route with eligible units (from getEligibleContainerCountsForLoads).
============================================================ */

function ensureMergePanel() {
  if (document.getElementById("ssp-merge-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "ssp-merge-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100000;display:none;align-items:center;justify-content:center;";

  const panel = document.createElement("div");
  panel.id = "ssp-merge-panel";
  panel.style.cssText =
    "width:min(980px,92vw);max-height:86vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:Arial;font-size:12px;";

  panel.innerHTML = `

    <style id="ssp-merge-css">
      /* Merge Panel spacing/grid refactor (CSS-only) */
      #ssp-merge-panel .ssp-cu-grid{
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
        gap:10px;
        align-items:stretch;
      }
      #ssp-merge-panel .ssp-cu-card{
        border:1px solid #e5e7eb;
        border-radius:12px;
        padding:10px 12px;
        background:#fff;
        margin:0;
        min-width:0;
      }
      /* Remove disclosure marker + its left gutter so first card doesn't "nudge" */
      #ssp-merge-panel .ssp-cu-card > summary::-webkit-details-marker{ display:none; }
      #ssp-merge-panel .ssp-cu-card > summary::marker{ content:""; }
      #ssp-merge-panel .ssp-cu-card__summary{
        list-style:none;
        cursor:pointer;
        display:flex;
        align-items:flex-start;
        justify-content:space-between;
        gap:10px;
        padding:0;
        margin:0;
      }
      #ssp-merge-panel .ssp-cu-card__summary:focus{ outline:none; }
    </style>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #e5e7eb;">
      <div>
        <div style="font-weight:900;font-size:13px;">Merge Panel</div>
        <div id="ssp-merge-subtitle" style="color:#6b7280;margin-top:2px;"></div>
      </div>
      <button id="ssp-merge-close" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;">Close</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px;">
      <div>
        <div style="font-weight:900;margin-bottom:6px;">Current Units (System View)</div>
        <div id="ssp-merge-current" style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:10px;"></div>
        <div style="font-weight:900;margin-bottom:6px;">Underutilized (Outbound)</div>
        <div id="ssp-merge-under" style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;"></div>
      </div>
      <div>
        <div style="font-weight:900;margin-bottom:6px;">Mergeable (Inbound Eligible)</div>
        <div id="ssp-merge-mergeable" style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;"></div>
      </div>
    </div>

    <div style="padding:0 12px 12px 12px;">
      <div style="font-weight:900;margin:6px 0;">Inbound VRIDs contributing to this route</div>
      <div id="ssp-merge-inb" style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;"></div>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { overlay.style.display = "none";
    STATE.mergePanelOpen = false; }
  });

  panel.querySelector("#ssp-merge-close").addEventListener("click", () => {
    overlay.style.display = "none";
  });
}


// --- Disruptions (Inbound + Outbound) ---
// Inbound disruptions: derived from inbound VRIDs that contribute to a given lane+CPT (STATE.ibContribByLaneCpt).
// Outbound disruptions for panel rendering are Relay-only (transport-view search + detail disruptions).
// Legacy FMC outbound helpers remain below for non-panel tooling.
const OUTBOUND_LATE_THRESHOLD_MIN = 15;

function computeDisruptionsForLaneCpt(laneKey, cptMs) {
  // INBOUND ONLY (kept for backward compatibility with dot-indicator logic)
  try {
    const key = _ibContribKey(laneKey, cptMs);
    const rows = (STATE.ibContribByLaneCpt && STATE.ibContribByLaneCpt[key]) ? STATE.ibContribByLaneCpt[key] : [];
    const nowMs = Date.now();

    const parseTs = (s) => {
      try { if (typeof _parseInboundTs === "function") return _parseInboundTs(s); } catch (_) {}
      try { return parseSspDateTime(s); } catch (_) {}
      return null;
    };

    const out = [];
    for (const r of (rows || [])) {
      const vrid = String(r?.vrid || "").trim();
      if (!vrid) continue;

      const schMs = parseTs(r?.sch);
      const etaMs = parseTs(r?.eta);
      const aatMs = parseTs(r?.aat);

      // Prefer total container count from inboundContainerCount (Dock Mgmt semantics).
      // Contrib rows may split units by lane; totalCount gives the trailer total.
      const cont = (() => {
        try {
          const pid = String(r?.planId || "").trim();
          const rec = pid ? (STATE?.ibContainerCount?.[pid] || null) : null;
          const total = rec?.totalCount || rec?.total || null;
          const cTotal = total && (typeof total.C === "number") ? total.C : null;
          if (cTotal != null) return Number(cTotal);
        } catch (_) {}
        const v = Number(r?.containers || 0);
        return Number.isFinite(v) ? v : 0;
      })();
      const pkgs = (() => {
        try {
          const pid = String(r?.planId || "").trim();
          if (!pid) return null;

          // Best source: inboundContainerCount total packages (matches Dock Mgmt export semantics)
          const rec = STATE?.ibContainerCount?.[pid];
          const total = rec?.totalCount || rec?.total || null;
          const pTotal = total && (typeof total.P === "number") ? total.P : null;
          if (pTotal != null) return Number(pTotal);

          // Fallback: cached planning pkg count (may be inTrailer-based)
          if (STATE.__planPkgs && Object.prototype.hasOwnProperty.call(STATE.__planPkgs, pid)) {
            const v = Number(STATE.__planPkgs[pid] || 0);
            return Number.isFinite(v) ? v : null;
          }
        } catch (_) {}
        return null;
      })();

      let kind = null;
      let minutes = 0;

      if (schMs && aatMs) {
        minutes = Math.floor((aatMs - schMs) / 60000);
        if (minutes > 0) kind = "ARRIVED_LATE";
      } else if (schMs && !aatMs) {
        minutes = Math.floor((nowMs - schMs) / 60000);
        if (minutes > 0) kind = "LATE";
      }

      if (!kind && schMs && etaMs) {
        const slip = Math.floor((etaMs - schMs) / 60000);
        if (slip >= 15) { kind = "ETA_SLIP"; minutes = slip; }
      }

      if (!kind) continue;

      out.push({
        vrid,
        planId: String(r?.planId || ""),
        containers: cont,
        packages: pkgs,
        scheduledMs: schMs,
        etaMs,
        actualMs: aatMs,
        kind,
        minutes: Math.max(0, Number(minutes || 0)),
      });
    }

    // Deduplicate by VRID (inbound contrib can surface the same VRID multiple times
    // across lane/CPT groupings). Keep the most actionable record while preserving totals.
    {
      const sev = (x) => (x.kind === "ARRIVED_LATE" || x.kind === "LATE") ? 2 : 1;
      const m = new Map();
      for (const r of out) {
        const k = String(r.vrid || "");
        const cur = m.get(k);
        if (!cur) { m.set(k, r); continue; }
        // Merge counts: totals should match; if they don't, take the max.
        cur.containers = Math.max(Number(cur.containers || 0), Number(r.containers || 0));
        if (cur.packages == null) cur.packages = r.packages;
        if (r.packages != null) cur.packages = Math.max(Number(cur.packages || 0), Number(r.packages || 0));
        // Time fields: keep earliest scheduled; prefer actual if present; otherwise latest ETA.
        if (!cur.scheduledMs || (r.scheduledMs && r.scheduledMs < cur.scheduledMs)) cur.scheduledMs = r.scheduledMs;
        if (r.actualMs) cur.actualMs = Math.max(Number(cur.actualMs || 0), Number(r.actualMs || 0));
        if (r.etaMs) cur.etaMs = Math.max(Number(cur.etaMs || 0), Number(r.etaMs || 0));
        // Keep the more severe kind, then larger minutes.
        if (sev(r) > sev(cur) || (sev(r) === sev(cur) && Number(r.minutes || 0) > Number(cur.minutes || 0))) {
          cur.kind = r.kind;
          cur.minutes = Number(r.minutes || 0);
        }
        m.set(k, cur);
      }
      out.length = 0;
      for (const v of m.values()) out.push(v);
    }

    // User preference: sort by Scheduled Arrival Time.
    out.sort((a,b) => (Number(a.scheduledMs||0) - Number(b.scheduledMs||0)) || (Number(b.minutes||0) - Number(a.minutes||0)) || String(a.vrid).localeCompare(String(b.vrid)));

    return out;
  } catch (e) {
    return [];
  }
}

// Aggregate inbound disruptions for all lanes currently in the Action Panel.
// We intentionally scope to visible actionGroups (not the entire day) so "All lanes"
// matches what the user is looking at right now.
function computeDisruptionsAll() {
  try {
    const groups = (STATE.actionGroups && STATE.actionGroups.values) ? Array.from(STATE.actionGroups.values()) : [];
    const all = [];
    for (const g of groups) {
      const lane = g?.lane;
      const cpt = g?.cptMs;
      const rows = computeDisruptionsForLaneCpt(lane, cpt) || [];
      for (const r of rows) all.push({ ...r, laneKey: String(lane || ""), cptMs: Number(cpt || 0) });
    }

    // Cross-lane dedupe by VRID (keep most severe, preserve totals).
    const sev = (x) => (x.kind === "ARRIVED_LATE" || x.kind === "LATE") ? 2 : 1;
    const m = new Map();
    for (const r of all) {
      const k = String(r.vrid || "");
      const cur = m.get(k);
      if (!cur) { m.set(k, r); continue; }
      cur.containers = Math.max(Number(cur.containers || 0), Number(r.containers || 0));
      if (cur.packages == null) cur.packages = r.packages;
      if (r.packages != null) cur.packages = Math.max(Number(cur.packages || 0), Number(r.packages || 0));
      if (!cur.scheduledMs || (r.scheduledMs && r.scheduledMs < cur.scheduledMs)) cur.scheduledMs = r.scheduledMs;
      if (r.actualMs) cur.actualMs = Math.max(Number(cur.actualMs || 0), Number(r.actualMs || 0));
      if (r.etaMs) cur.etaMs = Math.max(Number(cur.etaMs || 0), Number(r.etaMs || 0));
      if (sev(r) > sev(cur) || (sev(r) === sev(cur) && Number(r.minutes || 0) > Number(cur.minutes || 0))) {
        cur.kind = r.kind;
        cur.minutes = Number(r.minutes || 0);
      }
      // Keep a stable laneKey/cptMs for jump: prefer the record whose scheduled time matches earliest.
      if (cur.scheduledMs === r.scheduledMs) { cur.laneKey = r.laneKey; cur.cptMs = r.cptMs; }
      m.set(k, cur);
    }
    const out = Array.from(m.values());
    out.sort((a,b) => (Number(a.scheduledMs||0) - Number(b.scheduledMs||0)) || (Number(b.minutes||0) - Number(a.minutes||0)) || String(a.vrid).localeCompare(String(b.vrid)));
    return out;
  } catch (_) {
    return [];
  }
}

function _sspRelaySeverityScore(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "HIGH" || s === "CRITICAL" || s === "SEV1") return 3;
  if (s === "MEDIUM" || s === "SEV2") return 2;
  if (s === "LOW" || s === "SEV3") return 1;
  return 0;
}

function _sspRelayPanelErrorText(err) {
  const msg = String((err && err.message) || err || "").trim();
  if (/NO_TRACK_AUTH|Track auth|needs Track auth/i.test(msg)) {
    return "Relay unavailable: authentication required. Open Relay Track, open a VRID, then retry.";
  }
  if (/401|403|forbidden|unauthor/i.test(msg)) {
    return "Relay unavailable: access expired or blocked. Open Relay Track, reconnect, then retry.";
  }
  return "Relay unavailable right now. Open Relay Track, reconnect, and retry.";
}

function _sspRelayPanelUnavailableHtml(err, panelLabel) {
  const safe = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const label = String(panelLabel || "Relay panel");
  const msg = _sspRelayPanelErrorText(err);
  const raw = String((err && err.message) || err || "").trim();
  return `
    <div style="padding:12px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;color:#7f1d1d;">
      <div style="font-weight:900;">${safe(label)}: Relay unavailable</div>
      <div style="margin-top:6px;font-weight:700;">${safe(msg)}</div>
      <div style="margin-top:6px;color:#991b1b;font-size:12px;">Retry steps: open Relay Track, refresh auth/session, then reopen this panel.</div>
      ${raw ? `<div style="margin-top:6px;color:#b91c1c;font-size:11px;">Details: ${safe(raw.slice(0, 240))}</div>` : ""}
    </div>
  `;
}

async function _sspRelayBuildOutboundDisruptionsForPanel(laneKey, cptMs) {
  const contexts = [];
  if (String(laneKey || "") === "__ALL__") {
    const groups = (STATE.actionGroups && STATE.actionGroups.values) ? Array.from(STATE.actionGroups.values()) : [];
    for (const g of groups) {
      const lane = String(g?.lane || "").trim();
      const cpt = Number(g?.cptMs || 0);
      if (!lane) continue;
      contexts.push({ laneKey: lane, cptMs: cpt });
    }
  } else {
    contexts.push({ laneKey: String(laneKey || "").trim(), cptMs: Number(cptMs || 0) });
  }

  const uniqCtx = [];
  const seenCtx = new Set();
  for (const c of contexts) {
    const k = `${c.laneKey}::${String(c.cptMs || 0)}`;
    if (!c.laneKey || seenCtx.has(k)) continue;
    seenCtx.add(k);
    uniqCtx.push(c);
  }

  const byVrid = new Map();
  let firstErr = null;
  let relayHitCount = 0;

  const vridFrom = (o) => String(o?.vrid || o?.vrId || o?.vehicleRunId || o?.id || o?.qualifiedVrid || o?.qualifiedId || "").trim();
  const laneFrom = (o, fallbackLane) => {
    const lane = String(
      o?.lane ||
      o?.laneKey ||
      o?.route ||
      o?.laneRoute ||
      (Array.isArray(o?.lanes) && o.lanes.length ? o.lanes[o.lanes.length - 1] : "") ||
      ""
    ).trim();
    return lane || String(fallbackLane || "Unknown");
  };
  const scheduledFrom = (o, cptValue) =>
    _msFromAny(
      o?.scheduledArrivalTime ??
      o?.scheduledTime ??
      o?.scheduledEnd ??
      o?.scheduledStart ??
      o?.criticalPullTime ??
      o?.effectiveEnd ??
      o?.effectiveStart ??
      cptValue
    );
  const minutesFromDisruption = (d) => {
    const n = Number(
      d?.minutes ??
      d?.minutesLate ??
      d?.delayMinutes ??
      d?.etaSlipMinutes ??
      d?.impactMinutes ??
      d?.impact?.minutes ??
      d?.latenessMinutes ??
      0
    );
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  const pickTopDisruption = (arr) => {
    const rows = Array.isArray(arr) ? arr.filter((x) => x && typeof x === "object") : [];
    if (!rows.length) return null;
    rows.sort((a, b) =>
      (_sspRelaySeverityScore(b?.severity) - _sspRelaySeverityScore(a?.severity)) ||
      (minutesFromDisruption(b) - minutesFromDisruption(a))
    );
    return rows[0] || null;
  };

  for (const ctx of uniqCtx) {
    const lane = String(ctx.laneKey || "").trim();
    const cpt = Number(ctx.cptMs || 0);
    const laneToken = (lane.split("-")[0] || lane).trim();
    const anchor = cpt || Date.now();
    const startMs = anchor - 12 * 60 * 60 * 1000;
    const endMs = anchor + 6 * 60 * 60 * 1000;
    const restrictVrids = (String(laneKey || "") === "__ALL__")
      ? null
      : new Set(getFilteredOutboundVridsForLaneCpt(lane, cpt, { debugKey: "relay-disruptions-panel" }));

    let items = [];
    try {
      items = await _sspRelaySearchTransportViews(laneToken, startMs, endMs);
      relayHitCount += 1;
    } catch (e) {
      if (!firstErr) firstErr = e;
      continue;
    }
    if (!Array.isArray(items) || !items.length) continue;

    const metaByVrid = new Map();
    const needDetails = [];
    for (const it of items.slice(0, 260)) {
      const vrid = vridFrom(it);
      if (!vrid) continue;
      if (restrictVrids && restrictVrids.size && !restrictVrids.has(vrid)) continue;
      const entry = {
        vrid,
        laneKey: laneFrom(it, lane),
        cptMs: cpt || 0,
        scheduledMs: scheduledFrom(it, cpt) || null,
        containers: Number(it?.containers || it?.cntrsLeft || 0) || null,
        packages: Number(it?.packages || it?.pkgCount || 0) || null,
        disruptions: Array.isArray(it?.disruptions) ? it.disruptions : null,
      };
      metaByVrid.set(vrid, entry);
      if (entry.disruptions === null) needDetails.push(vrid);
    }

    for (const vrid of needDetails.slice(0, 80)) {
      try {
        const detail = await _sspRelayGetDetail(vrid, { allowFmcFallback: false });
        const rec = metaByVrid.get(vrid);
        if (rec) rec.disruptions = _sspRelayExtractDisruptions(detail) || [];
      } catch (e) {
        if (!firstErr) firstErr = e;
        const rec = metaByVrid.get(vrid);
        if (rec) rec.disruptions = [];
      }
    }

    for (const rec of metaByVrid.values()) {
      const disruptions = Array.isArray(rec.disruptions) ? rec.disruptions : [];
      if (!disruptions.length) continue;
      const top = pickTopDisruption(disruptions);
      const candidate = {
        vrid: rec.vrid,
        laneKey: rec.laneKey || lane,
        cptMs: rec.cptMs || cpt || 0,
        scheduledMs: rec.scheduledMs || null,
        containers: rec.containers,
        packages: rec.packages,
        kind: String(top?.type || top?.disruptionType || top?.id || "Disruption"),
        severity: String(top?.severity || "UNKNOWN"),
        status: String(top?.status || top?.state || top?.disposition || ""),
        minutes: minutesFromDisruption(top),
        disruptionCount: disruptions.length,
      };
      const cur = byVrid.get(candidate.vrid);
      if (!cur) {
        byVrid.set(candidate.vrid, candidate);
        continue;
      }
      const curScore = _sspRelaySeverityScore(cur.severity);
      const nextScore = _sspRelaySeverityScore(candidate.severity);
      if (
        nextScore > curScore ||
        (nextScore === curScore && Number(candidate.minutes || 0) > Number(cur.minutes || 0))
      ) {
        byVrid.set(candidate.vrid, { ...cur, ...candidate });
      } else {
        // Keep max disruption count and earliest schedule while preserving stronger severity row.
        cur.disruptionCount = Math.max(Number(cur.disruptionCount || 0), Number(candidate.disruptionCount || 0));
        if (!cur.scheduledMs || (candidate.scheduledMs && candidate.scheduledMs < cur.scheduledMs)) cur.scheduledMs = candidate.scheduledMs;
      }
    }
  }

  const rows = Array.from(byVrid.values());
  rows.sort((a, b) =>
    (_sspRelaySeverityScore(b.severity) - _sspRelaySeverityScore(a.severity)) ||
    (Number(b.minutes || 0) - Number(a.minutes || 0)) ||
    (Number(a.scheduledMs || 0) - Number(b.scheduledMs || 0)) ||
    String(a.vrid || "").localeCompare(String(b.vrid || ""))
  );

  return { rows, error: firstErr, relayHitCount };
}

// Aggregate outbound disruptions for all lanes currently in the Action Panel.
// NOTE: This may trigger FMC calls for unique VRIDs; we cap to avoid runaway requests.
// TODO(relay-cutover-panels-only): retained for non-panel workflows. Remove when broader FMC deprecation is approved.
async function computeOutboundDisruptionsAll() {
  try {
    const groups = (STATE.actionGroups && STATE.actionGroups.values) ? Array.from(STATE.actionGroups.values()) : [];
    const all = [];
    const seen = new Set();
    let vridBudget = 180; // hard cap across all lanes

    for (const g of groups) {
      if (vridBudget <= 0) break;
      const lane = g?.lane;
      const cpt = g?.cptMs;
      const vs = (g && g.vrids) ? g.vrids : [];
      const laneVrids = [];
      for (const v of vs) {
        const vrid = String(v?.vrid || v?.vrId || "").trim();
        if (!vrid || seen.has(vrid)) continue;
        seen.add(vrid);
        laneVrids.push(vrid);
        vridBudget -= 1;
        if (vridBudget <= 0) break;
      }

      // Reuse existing per-lane logic but temporarily override g.vrids to laneVrids-only to keep behavior consistent.
      // We call computeOutboundDisruptionsForLaneCpt which knows how to build fmc urls and parse first-stop timing.
      // To avoid rewriting, we create a shallow temp group entry.
      if (!laneVrids.length) continue;

      // Build a lightweight temp actionGroup compatible with computeOutboundDisruptionsForLaneCpt()
      const saved = g.vrids;
      try {
        g.vrids = laneVrids.map((x) => ({ vrid: x }));
        const rows = await computeOutboundDisruptionsForLaneCpt(lane, cpt);
        for (const r of (rows || [])) all.push({ ...r, laneKey: String(lane || ""), cptMs: Number(cpt || 0) });
      } finally {
        g.vrids = saved;
      }
    }

    // Dedupe across lanes by VRID (keep most severe minutes).
    const sev = (x) => (x.kind === "ARRIVED_LATE" || x.kind === "LATE") ? 2 : 1;
    const m = new Map();
    for (const r of all) {
      const k = String(r.vrid || "");
      const cur = m.get(k);
      if (!cur) { m.set(k, r); continue; }
      if (sev(r) > sev(cur) || (sev(r) === sev(cur) && Number(r.minutes || 0) > Number(cur.minutes || 0))) {
        // preserve urls if present
        const keepUrls = { fmcExecutionUrl: cur.fmcExecutionUrl, fmcCaseSearchUrl: cur.fmcCaseSearchUrl };
        Object.assign(cur, r);
        if (!cur.fmcExecutionUrl) cur.fmcExecutionUrl = keepUrls.fmcExecutionUrl;
        if (!cur.fmcCaseSearchUrl) cur.fmcCaseSearchUrl = keepUrls.fmcCaseSearchUrl;
      }
      // Keep earliest scheduled time
      if (!cur.scheduledMs || (r.scheduledMs && r.scheduledMs < cur.scheduledMs)) cur.scheduledMs = r.scheduledMs;
      m.set(k, cur);
    }

    const out = Array.from(m.values());
    out.sort((a,b) => (Number(a.scheduledMs||0) - Number(b.scheduledMs||0)) || (Number(b.minutes||0) - Number(a.minutes||0)) || String(a.vrid).localeCompare(String(b.vrid)));
    return out;
  } catch (_) {
    return [];
  }
}



function _getActionGroup(laneKey, cptMs) {
  try {
    const k = _cuGroupKey(laneKey, cptMs);
    return STATE.actionGroups && STATE.actionGroups.get ? STATE.actionGroups.get(k) : null;
  } catch (_) { return null; }
}

function getFilteredOutboundVridsForLaneCpt(laneKey, cptMs, options = {}) {
  try {
    const laneNorm = String(laneKey || "").trim();
    const cptNum = Number(cptMs || 0);
    if (!laneNorm || !cptNum) return [];

    const mode = normalizeObLoadType(SETTINGS.obLoadType || "all");
    const filtered = getFilteredOutboundLoadsForMode(mode, {
      loads: Array.isArray(STATE.outboundLoads) ? STATE.outboundLoads : [],
      basePredicate: (l) => {
        const st = String((l?.loadStatus ?? l?.status ?? "")).toUpperCase();
        if (st.includes("CANCEL") || st.includes("DEPART")) return false;
        return true;
      },
      equipmentPredicate: options.equipmentPredicate,
      debugKey: String(options.debugKey || "lane-cpt-vrids"),
    });

    const out = [];
    for (const l of filtered) {
      const vrid = String(l?.vrId || l?.vrid || "").trim();
      if (!vrid) continue;
      const lane = String(l?.lane || l?.route || "").trim();
      const cpt = Number(toMs(l?.criticalPullTime) || 0);
      if (lane !== laneNorm || cpt !== cptNum) continue;
      out.push(vrid);
    }

    return Array.from(new Set(out));
  } catch (_) {
    return [];
  }
}

function _msFromAny(x) {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const s = String(x || "").trim();
  if (!s) return null;
  // epoch ms
  if (/^\d{13}$/.test(s)) return Number(s);
  // epoch sec
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  try { return parseSspDateTime(s); } catch (_) {}
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  return null;
}

function _extractFirstStopTimesFromFmcLoad(fmcLoad) {
  // Returns { scheduledMs, etaMs, actualMs, checkinMs }
  // Field names vary across payloads; attempt many.
  const stops = fmcLoad?.stops || fmcLoad?.routeStops || fmcLoad?.loadStops || fmcLoad?.executionStops || null;
  const first = Array.isArray(stops) && stops.length ? stops[0] : (fmcLoad?.firstStop || fmcLoad?.originStop || null);

  const scheduledMs =
    _msFromAny(first?.scheduledArrivalTime) ??
    _msFromAny(first?.plannedArrivalTime) ??
    _msFromAny(first?.arrival?.plannedTime) ??
    _msFromAny(first?.arrivalPlannedTime) ??
    _msFromAny(fmcLoad?.firstStopScheduledArrivalTime) ??
    _msFromAny(fmcLoad?.scheduledArrivalTime) ??
    null;

  const etaMs =
    _msFromAny(first?.estimatedArrivalTime) ??
    _msFromAny(first?.arrival?.estimatedArrivalTime) ??
    _msFromAny(first?.eta) ??
    _msFromAny(fmcLoad?.firstStopEstimatedArrivalTime) ??
    _msFromAny(fmcLoad?.estimatedArrivalTime) ??
    null;

  const actualMs =
    _msFromAny(first?.actualArrivalTime) ??
    _msFromAny(first?.arrival?.completionTime) ??
    _msFromAny(first?.arrival?.actualTime) ??
    _msFromAny(fmcLoad?.firstStopActualArrivalTime) ??
    _msFromAny(fmcLoad?.actualArrivalTime) ??
    null;

  const checkinMs =
    _msFromAny(fmcLoad?.driverCheckInTime) ??
    _msFromAny(fmcLoad?.checkInTime) ??
    _msFromAny(fmcLoad?.driver?.checkInTime) ??
    _msFromAny(fmcLoad?.driver?.checkedInAt) ??
    null;

  return { scheduledMs, etaMs, actualMs, checkinMs };
}

async function fetchFmcCasesSearch(vehicleRunId, firstStopArrivalTimeMs) {
  const vrid = String(vehicleRunId || "").trim();
  const t0 = Number(firstStopArrivalTimeMs || 0);
  if (!vrid || !t0) return null;

  try {
    STATE.__fmcCasesCache = STATE.__fmcCasesCache || {};

    // Normalize candidate timestamps. FMC has been seen accepting either ms epoch or sec epoch,
    // and sometimes prefers rounded-to-minute values.
    const candidates = [];
    const push = (x) => { const n = Number(x || 0); if (n && !candidates.includes(n)) candidates.push(n); };

    push(t0);
    // If ms epoch, also try sec epoch. If sec epoch, also try ms epoch.
    if (t0 > 1e12) push(Math.floor(t0 / 1000));
    if (t0 > 1e9 && t0 < 1e12) push(t0 * 1000);

    // Round-to-minute variants (both ms and sec forms where applicable)
    for (const n of candidates.slice()) {
      if (n > 1e12) push(Math.floor(n / 60000) * 60000);
      if (n > 1e9 && n < 1e12) push(Math.floor(n / 60) * 60);
    }

    // Probe a small window if exact match is brittle (±5 minutes on rounded ms/sec)
    for (const n of candidates.slice()) {
      if (n > 1e12) {
        push(n - (5 * 60 * 1000));
        push(n + (5 * 60 * 1000));
      } else if (n > 1e9) {
        push(n - (5 * 60));
        push(n + (5 * 60));
      }
    }

    const doGet = async (t) => {
      const cacheKey = `caseSearch:${vrid}:${t}`;
      const cur = STATE.__fmcCasesCache[cacheKey];
      if (cur && (Date.now() - cur.ts) < (10 * 60 * 1000)) return cur.data;

      const url = `https://trans-logistics.amazon.com/fmc/api/v3/cases/search?vehicleRunId=${encodeURIComponent(vrid)}&firstStopArrivalTime=${encodeURIComponent(String(t))}`;
      const res = await sspFetch(url, {
        method: "GET",
        credentials: "include",
        headers: { "accept": "application/json, text/plain, */*" }
      });
      const data = await res.json().catch(() => null);
      STATE.__fmcCasesCache[cacheKey] = { ts: Date.now(), data };
      return data;
    };

    // Return the first response that actually contains cases (best-effort parsing).
    for (const t of candidates) {
      const data = await doGet(t);

      const arr =
        data?.returnedObject?.cases ||
        data?.returnedObject?.caseSummaries ||
        (Array.isArray(data?.returnedObject) ? data.returnedObject : null) ||
        data?.cases ||
        data?.caseSummaries ||
        (Array.isArray(data) ? data : null);

      if (Array.isArray(arr) && arr.length) return data;

      // Some builds return a single object for a single case (rare, but seen); treat that as "has cases".
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const hasSingleCaseShape = !!(data?.caseId || data?.id || data?.caseStatus || data?.status);
        if (hasSingleCaseShape) return data;
      }
    }

    // Nothing found.
    return await doGet(candidates[0]);
  } catch (_) {
    return null;
  }
}
/* ================================
 * Outbound Cases (FMC)
 * - Shows if VRIDs have open cases
 * - Lets you jump to Relay + optionally fetch case details
 * ================================ */

function _extractCasesArray(casesJson) {
  if (!casesJson) return [];
  const arr =
    casesJson?.returnedObject?.cases ||
    casesJson?.returnedObject?.caseSummaries ||
    casesJson?.returnedObject ||
    casesJson?.cases ||
    casesJson?.caseSummaries ||
    (Array.isArray(casesJson) ? casesJson : null);
  return Array.isArray(arr) ? arr : [];
}

function _caseIdFromObj(c) {
  return String(c?.caseId || c?.id || c?.caseNumber || c?.caseReferenceId || "").trim();
}

async function fetchFmcCaseDetails(caseId) {
  const cid = String(caseId || "").trim();
  if (!cid) return null;
  try {
    STATE.__fmcCaseDetailCache = STATE.__fmcCaseDetailCache || {};
    const cacheKey = `caseDetail:${cid}`;
    const cur = STATE.__fmcCaseDetailCache[cacheKey];
    if (cur && (Date.now() - cur.ts) < (10 * 60 * 1000)) return cur.data;

    // Try a few likely endpoints (FMC is inconsistent across regions/versions)
    const urls = [
      `https://trans-logistics.amazon.com/fmc/api/v3/cases/${encodeURIComponent(cid)}`,
      `https://trans-logistics.amazon.com/fmc/api/v3/cases/details/${encodeURIComponent(cid)}`,
      `https://trans-logistics.amazon.com/fmc/api/v3/cases/details?caseId=${encodeURIComponent(cid)}`,
    ];

    let data = null;
    for (const url of urls) {
      try {
        const res = await sspFetch(url, {
          method: "GET",
          credentials: "include",
          headers: { "accept": "application/json, text/plain, */*" },
        });
        if (!res || !res.ok) continue;
        data = await res.json().catch(() => null);
        if (data) break;
      } catch (_) {}
    }

    STATE.__fmcCaseDetailCache[cacheKey] = { ts: Date.now(), data };
    return data;
  } catch (_) {
    return null;
  }
}

// Build a best-effort "human UI" URL for a case id (may vary by deployment).
function _fmcCaseUiUrls(caseId) {
  const cid = String(caseId || "").trim();
  if (!cid) return [];
  return [
    `https://trans-logistics.amazon.com/fmc/cases/${encodeURIComponent(cid)}`,
    `https://trans-logistics.amazon.com/fmc/case/${encodeURIComponent(cid)}`,
  ];
}

async function computeOutboundCasesForLaneCpt(laneKey, cptMs) {
  // TODO(relay-cutover-panels-only): legacy FMC case aggregation kept for non-panel tooling; outside current scope.
  try {
    const cacheKey = `obCases:${String(laneKey || "")}:${Number(cptMs || 0)}`;
    STATE.__obCasesCache = STATE.__obCasesCache || {};
    const cur = STATE.__obCasesCache[cacheKey];
    if (cur && (Date.now() - cur.ts) < (5 * 60 * 1000)) return cur.data || [];

    const g = _getActionGroup(laneKey, cptMs);
    const vs = (g && g.vrids) ? g.vrids : [];
    const allowedVrids = new Set(getFilteredOutboundVridsForLaneCpt(laneKey, cptMs, { debugKey: "outbound-case-collection" }));
    const scopedVs = vs.filter((v) => allowedVrids.has(String(v?.vrid || v?.vrId || "").trim()));
    if (!scopedVs.length) return [];

    const out = [];
    for (const v of scopedVs.slice(0, 80)) {
      const vrid = String(v?.vrid || v?.vrId || "").trim();
      if (!vrid || !allowedVrids.has(vrid)) continue;

      // Need firstStopArrivalTime. Best source is FMC execution load's first stop scheduled time.
      let fmcLoad = null;
      try { fmcLoad = await fetchFmcExecutionLoad(vrid); } catch (_) {}

      const times = _extractFirstStopTimesFromFmcLoad(fmcLoad || {});
      const scheduledMs = times.scheduledMs || Number(cptMs || 0) || null;
      if (!scheduledMs) continue;

      const casesJson = await fetchFmcCasesSearch(vrid, scheduledMs);
      const casesArr = _extractCasesArray(casesJson);
      if (!casesArr.length) continue;

      // Pull a couple useful fields from the first case for at-a-glance display.
      const first = casesArr[0] || {};
      const firstId = _caseIdFromObj(first);
      const status = String(first?.status || first?.caseStatus || first?.state || "").trim();
      const topic = String(first?.topicKey || first?.topic || first?.caseTopic || first?.caseType || "").trim();

      out.push({
        vrid,
        scheduledMs,
        caseCount: casesArr.length,
        firstCaseId: firstId || null,
        firstStatus: status || null,
        firstTopic: topic || null,
        fmcApiUrl: `https://trans-logistics.amazon.com/fmc/api/v3/cases/search?vehicleRunId=${encodeURIComponent(vrid)}&firstStopArrivalTime=${encodeURIComponent(String(scheduledMs))}`,
      });
    }

    out.sort((a,b) => (Number(a.scheduledMs||0) - Number(b.scheduledMs||0)) || (Number(b.caseCount||0) - Number(a.caseCount||0)) || String(a.vrid).localeCompare(String(b.vrid)));

    STATE.obCaseVridCountByLaneCpt = STATE.obCaseVridCountByLaneCpt || {};
    try {
      const __caseKey = _ibContribKey(laneKey, cptMs);
      STATE.obCaseVridCountByLaneCpt[__caseKey] = Array.isArray(out) ? out.length : 0;
    } catch (_) {}

    STATE.__obCasesCache[cacheKey] = { ts: Date.now(), data: out };
    return out;
  } catch (_) {
    return [];
  }
}


// =====================================================
// Lane Map Panel (Relay-backed VRID list; optional jump to Relay)
// - Triggered by clicking the lane label in Action Panel cards.
// - Shows VRIDs for that lane+CPT and lets you open RelayMini per VRID.
// =====================================================
function ensureLaneMapPanel() {
  let p = document.getElementById("ssp2-lane-map-panel");
  if (p) return p;
  p = document.createElement("div");
  p.id = "ssp2-lane-map-panel";
  p.style.position = "fixed";
  p.style.right = "14px";
  p.style.bottom = "14px";
  p.style.width = "460px";
  p.style.maxHeight = "75vh";
  p.style.zIndex = "999999";
  p.style.background = "#fff";
  p.style.border = "1px solid #d1d5db";
  p.style.borderRadius = "14px";
  p.style.boxShadow = "0 18px 45px rgba(0,0,0,.22)";
  p.style.display = "none";
  p.style.overflow = "hidden";
  p.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #e5e7eb;background:#0b1020;color:#e5e7eb;">
      <div style="font-weight:900;">Lane</div>
      <div id="ssp2-lane-map-title" style="font-weight:800;opacity:.95;"></div>
      <div style="margin-left:auto;display:flex;gap:8px;">
        <button id="ssp2-lane-map-open-relay" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">Open in Relay</button>
        <button id="ssp2-lane-map-close" style="padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e5e7eb;font-weight:900;cursor:pointer;">✕</button>
      </div>
    </div>
    <div id="ssp2-lane-map-body" style="padding:10px;max-height:calc(75vh - 46px);overflow:auto;">
      <div id="ssp2-lane-map-list" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
  `;
  document.body.appendChild(p);
  p.querySelector("#ssp2-lane-map-close").onclick = () => { p.style.display = "none"; };
  return p;
}

function openLaneMapPanel(lane, cptMs) {
  const p = ensureLaneMapPanel();
  const title = p.querySelector("#ssp2-lane-map-title");
  const list = p.querySelector("#ssp2-lane-map-list");
  const laneStr = String(lane||"—");
  const cptStr = fmtTime(Number(cptMs||0));
  if (title) title.textContent = `${laneStr} (CPT ${cptStr || "—"})`;
  const key = `${laneStr}|${Number(cptMs||0)}`;
  const vrids = (STATE.__laneCptToVrids && STATE.__laneCptToVrids[key]) ? STATE.__laneCptToVrids[key] : [];
  const nodeCode = (STATE && (STATE.nodeId || STATE.nodeID)) || "";
  if (list) {
    list.innerHTML = (vrids && vrids.length)
      ? vrids.slice(0, 40).map(v => {
          const vv = String(v);
          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #e5e7eb;border-radius:12px;padding:8px;">
            <div style="font-weight:900;">${esc(vv)} <span class="ssp-relay-meta" data-vrid="${esc(vv)}" style="margin-left:8px;"></span></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
              <button class="ssp-lane-vrid-mini" data-vrid="${esc(vv)}" style="padding:4px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">Mini</button>
              <a href="${esc(buildRelayUrl(vv))}" target="_blank" rel="noopener" style="padding:4px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;text-decoration:none;color:#111827;">Relay</a>
            </div>
          </div>`;
        }).join("")
      : `<div style="color:#6b7280;">No VRIDs cached for this lane/CPT (open Action Panel first).</div>`;
  }

  const openBtn = p.querySelector("#ssp2-lane-map-open-relay");
  if (openBtn) {
    openBtn.onclick = () => {
      const firstVrid = (vrids && vrids.length) ? String(vrids[0] || "").trim() : "";
      const url = firstVrid ? buildRelayUrl(firstVrid) : "https://track.relay.amazon.dev/";
      window.open(url, "_blank", "noopener,noreferrer");
    };
  }

  // delegate clicks for Mini buttons
  p.onclick = (e) => {
    const b = e.target && e.target.closest && e.target.closest("button.ssp-lane-vrid-mini");
    if (!b) return;
    const vrid = b.getAttribute("data-vrid") || "";
    if (!vrid) return;
    _showRelayMiniForAnchor(b, vrid, nodeCode);
    try { _sspPrefetchRelayMetaBadges([vrid], 1); } catch(_) {}
  };

  p.style.display = "block";
  // prefetch badges for lane list
  try { _sspPrefetchRelayMetaBadges(vrids, 12); } catch(_) {}
}

function ensureCasesPanel() {
  if (document.getElementById("ssp-cases-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "ssp-cases-overlay";
  overlay.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:2147483646;";

  const panel = document.createElement("div");
  panel.id = "ssp-cases-panel";
  panel.style.cssText = "width:min(980px,94vw);max-height:90vh;background:#fff;border-radius:14px;border:1px solid #e5e7eb;box-shadow:0 20px 70px rgba(0,0,0,.25);overflow:hidden;";

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #e5e7eb;background:#0b1020;color:#e5e7eb;">
      <div style="font-weight:900;">Cases</div>
      <div id="ssp-cases-subtitle" style="color:#cbd5e1;font-weight:800;font-size:12px;"></div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
        <button id="ssp-cases-close" style="cursor:pointer;padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.10);color:#fff;font-weight:900;">Close</button>
      </div>
    </div>
    <div id="ssp-cases-body" style="padding:14px;max-height:calc(90vh - 54px);overflow:auto;"></div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.style.display = "none";
  });
  document.getElementById("ssp-cases-close")?.addEventListener("click", () => {
    overlay.style.display = "none";
  });
}

async function openCasesPanel(laneKey, cptMs) {
  // TODO(relay-cutover-panels-only): legacy FMC-oriented panel retained for compatibility; lane UI routes to openRelayCasesPanel.
  try { ensureCasesPanel(); } catch (_) {}
  const overlay = document.getElementById("ssp-cases-overlay");
  const subEl = document.getElementById("ssp-cases-subtitle");
  const body = document.getElementById("ssp-cases-body");
  if (!overlay || !body) return;

  const laneLabel = String(laneKey || "—");
  const cptLabel = cptMs ? fmtTime(Number(cptMs || 0)) : "";
  if (subEl) subEl.textContent = cptLabel ? `${laneLabel} (CPT ${cptLabel})` : laneLabel;

  overlay.style.display = "flex";
  body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Loading cases…</div>`;

  const rows = await computeOutboundCasesForLaneCpt(laneKey, cptMs);

  if (!rows || !rows.length) {
    body.innerHTML = `<div style="padding:10px;color:#6b7280;">No cases found for this lane/CPT.</div>`;
    return;
  }

  const renderRow = (r, i) => {
    const zebra = (i % 2) ? "background:#f9fafb;" : "background:#fff;";
    const vr = esc(String(r.vrid || ""));
    const sched = r.scheduledMs ? fmtTime(Number(r.scheduledMs || 0)) : "—";
    const cc = Number(r.caseCount || 0) || 0;

    const relayUrl = (typeof _sspRelayTrackMapUrlForVrid === "function") ? _sspRelayTrackMapUrlForVrid(vr) : "";
    const vrLink = relayUrl
      ? `<a href="${esc(relayUrl)}" target="_blank" rel="noopener" style="font-weight:900;text-decoration:none;color:#111827;">${vr}</a>`
      : `<span style="font-weight:900;color:#111827;">${vr}</span>`;

    const cid = r.firstCaseId ? esc(String(r.firstCaseId)) : "";
    const status = r.firstStatus ? esc(String(r.firstStatus)) : "";
    const topic = r.firstTopic ? esc(String(r.firstTopic)) : "";

    const uiUrls = r.firstCaseId ? _fmcCaseUiUrls(r.firstCaseId) : [];
    const uiLinks = uiUrls.map((u, idx) => `<a href="${esc(u)}" target="_blank" rel="noopener" style="padding:4px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;text-decoration:none;color:#111827;">Case UI ${idx+1}</a>`).join("");

    const apiLink = r.fmcApiUrl
      ? `<a href="${esc(r.fmcApiUrl)}" target="_blank" rel="noopener" style="padding:4px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;text-decoration:none;color:#111827;">API</a>`
      : "";

    const detailsBtn = r.firstCaseId
      ? `<button class="ssp-case-details" data-case="${esc(String(r.firstCaseId))}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;">Details</button>`
      : "";

    return `
      <div class="ssp-case-row" data-vrid="${vr}" style="display:grid;grid-template-columns:170px 80px 90px 1fr;gap:10px;align-items:center;padding:10px 10px;border-radius:12px;${zebra}">
        <div>${vrLink}<div style="color:#6b7280;font-weight:800;font-size:11px;margin-top:2px;">Sched ${esc(sched)}</div></div>
        <div style="font-weight:900;">${cc} case${cc===1?"":"s"}</div>
        <div style="color:#6b7280;font-weight:800;font-size:12px;">${cid ? `#${cid}` : "—"}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          ${status ? `<span style="padding:4px 10px;border-radius:999px;border:1px solid #e5e7eb;background:#f3f4f6;font-weight:900;color:#111827;">${status}</span>` : ""}
          ${topic ? `<span style="padding:4px 10px;border-radius:999px;border:1px solid #e5e7eb;background:#f3f4f6;font-weight:900;color:#111827;">${topic}</span>` : ""}
          ${detailsBtn}
          ${uiLinks}
          ${apiLink}
        </div>
      </div>
      <div class="ssp-case-detail-box" data-casebox="${cid}" style="display:none;margin:-4px 10px 10px 10px;padding:10px 10px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;">
        <div style="color:#6b7280;font-weight:800;">Loading…</div>
      </div>
    `;
  };

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="font-weight:900;">Cases found (${rows.length} VRIDs)</div>
      <div style="margin-left:auto;color:#6b7280;font-weight:800;font-size:12px;">(VRID opens Relay; details is best-effort)</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${rows.map(renderRow).join("")}
    </div>
  `;

  // Details fetch wiring
  body.querySelectorAll("button.ssp-case-details").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cid = btn.getAttribute("data-case") || "";
      if (!cid) return;
      const box = body.querySelector(`.ssp-case-detail-box[data-casebox="${CSS.escape(cid)}"]`);
      if (!box) return;
      if (box.style.display === "none") {
        box.style.display = "block";
        box.innerHTML = `<div style="color:#6b7280;font-weight:800;">Loading…</div>`;
        const data = await fetchFmcCaseDetails(cid);
        if (!data) {
          box.innerHTML = `<div style="color:#6b7280;">Unable to fetch case details via API (endpoint may differ). Use the Case UI links instead.</div>`;
        } else {
          const pretty = esc(JSON.stringify(data, null, 2));
          box.innerHTML = `<div style="font-weight:900;margin-bottom:6px;">Case ${esc(cid)}</div><pre style="margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;max-height:260px;overflow:auto;background:#0b1020;color:#e5e7eb;padding:10px;border-radius:12px;">${pretty}</pre>`;
        }
      } else {
        box.style.display = "none";
      }
    });
  });
}


async function computeOutboundDisruptionsForLaneCpt(laneKey, cptMs) {
  // TODO(relay-cutover-panels-only): retained for non-panel workflows. Remove when broader FMC deprecation is approved.
  try {
    const g = _getActionGroup(laneKey, cptMs);
    const vs = (g && g.vrids) ? g.vrids : [];
    const allowedVrids = new Set(getFilteredOutboundVridsForLaneCpt(laneKey, cptMs, { debugKey: "disruptions-derivation" }));
    const scopedVs = vs.filter((v) => allowedVrids.has(String(v?.vrid || v?.vrId || "").trim()));
    if (!scopedVs.length) return [];

    const out = [];
    for (const v of scopedVs.slice(0, 60)) {
      const vrid = String(v?.vrid || v?.vrId || "").trim();
      if (!vrid || !allowedVrids.has(vrid)) continue;

      let fmcLoad = null;
      try { fmcLoad = await fetchFmcExecutionLoad(vrid); } catch (_) {}

      const times = _extractFirstStopTimesFromFmcLoad(fmcLoad || {});
      const scheduledMs = times.scheduledMs || null;
      const etaMs = times.etaMs || null;
      const actualMs = times.actualMs || null;

      // If we can't compute lateness, skip.
      if (!scheduledMs) continue;

      const etaOrArr = actualMs || etaMs;
      if (!etaOrArr) continue;

      const lateMin = Math.floor((etaOrArr - scheduledMs) / 60000);
      if (lateMin < OUTBOUND_LATE_THRESHOLD_MIN) continue;

      // Case lookup: use scheduledMs as "firstStopArrivalTime" (matches the request you captured).
      const casesJson = await fetchFmcCasesSearch(vrid, scheduledMs);
      const casesArr =
        casesJson?.returnedObject?.cases ||
        casesJson?.returnedObject ||
        casesJson?.cases ||
        casesJson?.caseSummaries ||
        (Array.isArray(casesJson) ? casesJson : null);

      const caseCount = Array.isArray(casesArr) ? casesArr.length : (casesJson && typeof casesJson === "object" ? 1 : 0);

      out.push({
        vrid,
        containers: Number(v?.containers || v?.cntrsLeft || 0) || null,
        packages: null,
        scheduledMs,
        etaMs,
        actualMs,
        checkinMs: times.checkinMs || null,
        minutes: Math.max(0, lateMin),
        caseCount,
        caseUrl: `https://trans-logistics.amazon.com/fmc/api/v3/cases/search?vehicleRunId=${encodeURIComponent(vrid)}&firstStopArrivalTime=${encodeURIComponent(String(scheduledMs))}`,
      });
    }

    // Sort by Scheduled Arrival Time (primary), then minutes.
    out.sort((a,b) => (Number(a.scheduledMs||0) - Number(b.scheduledMs||0)) || (Number(b.minutes||0) - Number(a.minutes||0)) || String(a.vrid).localeCompare(String(b.vrid)));
    return out;
  } catch (_) {
    return [];
  }
}


async function openDisruptionsPanel(laneKey, cptMs) {
  try { ensureDisruptionsPanel(); } catch (_) {}
  const overlay = document.getElementById("ssp-disrupt-overlay");
  const panel = document.getElementById("ssp-disrupt-panel");
  const subEl = document.getElementById("ssp-disrupt-subtitle");
  const body = document.getElementById("ssp-disrupt-body");
  if (!overlay || !panel || !body) return;

  const __all = (laneKey === "__ALL__");
  const laneLabel = __all ? "All lanes" : String(laneKey || "—");
  const cptLabel = cptMs ? fmtTime(cptMs) : "";
  if (subEl) subEl.textContent = cptLabel ? `${laneLabel} (CPT ${cptLabel})` : laneLabel;

  overlay.style.display = "flex";

  // initial shell
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <div style="font-weight:900;color:#111827;">Inbound + Outbound disruptions</div>
      <div style="flex:1"></div>
      <div style="color:#6b7280;font-weight:800;font-size:12px;">Threshold: &gt;${OUTBOUND_LATE_THRESHOLD_MIN}m late (Outbound)</div>
    </div>
    <div id="ssp-disrupt-all"></div>
    <div style="margin-top:8px;color:#6b7280;font-size:11px;">
      Outbound: Relay transport-view search + detail disruptions. Inbound: SSP inbound contrib (IB4CPT) + arrival/ETA slip.
    </div>
  `;

  const allBox = body.querySelector("#ssp-disrupt-all");

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const kindLabel = (k) => (k === "LATE" ? "Driver Late" : k === "ARRIVED_LATE" ? "Arrived Late" : k === "ETA_SLIP" ? "ETA Slip" : String(k || "Issue"));
  const lateTxt = (r) => {
    const m = Number(r.minutes || 0);
    if (!m) return "—";
    if (r.kind === "ARRIVED_LATE") return `${m}m late`;
    if (r.kind === "LATE") return `${m}m late`;
    if (r.kind === "ETA_SLIP") return `+${m}m`;
    return `${m}m`;
  };

  // Build rows
  let inboundRows = [];
  let outboundRows = [];

  try {
    inboundRows = __all
      ? (computeDisruptionsAll() || [])
      : (computeDisruptionsForLaneCpt(laneKey, cptMs) || []);
  } catch (_) {
    inboundRows = [];
  }

  let outboundErr = null;
  try {
    const relayOut = await _sspRelayBuildOutboundDisruptionsForPanel(laneKey, cptMs);
    outboundRows = relayOut?.rows || [];
    outboundErr = relayOut?.error || null;
  } catch (e) {
    outboundRows = [];
    outboundErr = e || new Error("Relay outbound disruptions unavailable");
  }

  const renderAll = () => {
    if (!allBox) return;

    // Build inbound column (show all inbound disruptions)
    const inboundHtml = (inboundRows && inboundRows.length)
      ? (`<div style="font-weight:900;margin-bottom:6px;">Inbound (${inboundRows.length})</div>` + inboundRows.map((r, i) => {
          const vr = esc(r.vrid || "");
          const sched = r.scheduledMs ? fmtTime(r.scheduledMs) : "—";
          const eta = r.arrivalMs ? fmtTime(r.arrivalMs) : (r.etaMs ? fmtTime(r.etaMs) : "—");
          const pk = (r.packages == null || Number.isNaN(Number(r.packages))) ? "—" : String(Number(r.packages));
          const cn = (r.containers == null || Number.isNaN(Number(r.containers))) ? "—" : String(Number(r.containers));
          const late = lateTxt(r);
          const href = (typeof buildRelayUrl === "function") ? buildRelayUrl(r.vrid || "") : "";
          const vrLink = href ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:900;">${vr}</a>` : `<span style="color:#2563eb;font-weight:900;">${vr}</span>`;
          return `
            <div class="ssp-disrupt-row-ib" data-vrid="${esc(r.vrid||"")}" style="padding:8px;margin-bottom:8px;border-radius:10px;background:#fff;border:1px solid #eef2ff;">
              <div style="font-size:13px;">${vrLink}</div>
              <div style="color:#6b7280;font-size:11px;margin-top:4px;">Sched: ${sched} • ETA/Arr: ${eta} • C ${cn} • P ${pk}</div>
              <div style="font-weight:900;color:#111827;margin-top:6px;">${esc(late)}</div>
            </div>
          `;
        }).join("") )
      : `<div style="color:#6b7280;padding:10px;border-radius:8px;">No inbound disruptions</div>`;

    // Build outbound grouped-by-lane column
    let outboundHtml = "";
    if (outboundRows && outboundRows.length) {
      // Group by laneKey
      const lm = new Map();
      for (const r of outboundRows) {
        const lane = String(r.laneKey || r.lane || "—");
        if (!lm.has(lane)) lm.set(lane, []);
        lm.get(lane).push(r);
      }
      // Compute lane severity (max minutes) and sort lanes by severity desc
      const lanes = Array.from(lm.entries()).map(([lane, rows]) => ({ lane, rows }));
      for (const entry of lanes) entry.maxMin = Math.max(...entry.rows.map(x => Number(x.minutes || 0) || 0));
      lanes.sort((a,b) => Number(b.maxMin || 0) - Number(a.maxMin || 0));

      // Render lanes as stacked cards (highest severity first)
      outboundHtml = lanes.map((ln) => {
        const rows = ln.rows.slice().sort((a,b) => Number(b.minutes||0) - Number(a.minutes||0) || String(a.vrid||"").localeCompare(String(b.vrid||"")));
        const laneHeader = `<div style="font-weight:900;margin-bottom:6px;">${esc(ln.lane)} — ${rows.length} VRID(s) — worst: ${rows.length?String(rows[0].minutes||0)+"m":"—"}</div>`;
        const vrs = rows.map((r) => {
          const vr = esc(r.vrid||"");
          const mins = Number(r.minutes||0);
          const cn = (r.containers == null || Number.isNaN(Number(r.containers))) ? "—" : String(Number(r.containers));
          const href = (typeof buildRelayUrl === "function") ? buildRelayUrl(r.vrid || "") : "";
          const link = href ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:900;">${vr}</a>` : `<span style="color:#2563eb;font-weight:900;">${vr}</span>`;
          const caseBtn = r.caseUrl ? `<a href="${esc(r.caseUrl)}" target="_blank" rel="noopener" style="margin-left:8px;padding:4px 8px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;text-decoration:none;color:#111827;">Cases</a>` : "";
          return `<div class="ssp-disrupt-row-ob" data-lane="${esc(ln.lane)}" data-vrid="${esc(r.vrid||"")}" style="padding:8px;margin-bottom:6px;border-radius:8px;background:#fff;border:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center;">
                    <div>${link}${caseBtn}<div style="font-size:11px;color:#6b7280;margin-top:4px;">C ${cn}</div></div>
                    <div style="font-weight:900;color:#dc2626;">${String(mins)}m</div>
                  </div>`;
        }).join("");
        return `<div style="margin-bottom:12px;padding:10px;border-radius:10px;background:#f9fafb;border:1px solid #eef2ff;">${laneHeader}${vrs}</div>`;
      }).join("");
    } else if ((typeof _sspGetTrackAuthHeader === "function" && !_sspGetTrackAuthHeader()) || outboundErr) {
      outboundHtml = _sspRelayPanelUnavailableHtml(outboundErr || new Error("NO_TRACK_AUTH"), "Outbound disruptions");
    } else {
      outboundHtml = `<div style="color:#6b7280;padding:10px;border-radius:8px;">No outbound disruptions</div>`;
    }

    allBox.innerHTML = `
      <div style="display:flex;gap:16px;align-items:flex-start;max-height:62vh;overflow:auto;padding-right:8px;">
        <div style="flex:0 0 46%;min-width:260px;">
          ${inboundHtml}
        </div>
        <div style="flex:1;min-width:320px;">
          <div style="font-weight:900;margin-bottom:6px;">Outbound — grouped by lane (highest severity first)</div>
          ${outboundHtml}
        </div>
      </div>
    `;

    // Jump behavior: clicking outbound/inbound rows will scroll to action panel lane card
    allBox.querySelectorAll(".ssp-disrupt-row-ob, .ssp-disrupt-row-ib").forEach((el) => {
      el.addEventListener("click", (e) => {
        try { if (e && e.target && e.target.closest && e.target.closest("a")) return; } catch (_) {}
        try {
          const lane = el.getAttribute("data-lane") || el.getAttribute("data-lanekey") || laneKey || "";
          const cpt = el.getAttribute("data-cpt") || cptMs || "";
          const target = document.querySelector(`.open-disruptions[data-lane="${CSS.escape(String(lane))}"][data-cpt="${CSS.escape(String(cpt))}"]`);
          if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (_) {}
      });
    });
  };

  renderAll();
}


function ensureDisruptionsPanel() {
  if (document.getElementById("ssp-disrupt-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "ssp-disrupt-overlay";
  overlay.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:2147483646;";

  const panel = document.createElement("div");
  panel.id = "ssp-disrupt-panel";
  panel.style.cssText = "width:min(1280px,96vw);max-height:90vh;background:#fff;border-radius:14px;border:1px solid #e5e7eb;box-shadow:0 20px 70px rgba(0,0,0,.25);overflow:hidden;";

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #e5e7eb;">
      <div>
        <div style="font-weight:1000;font-size:13px;">Disruptions</div>
        <div id="ssp-disrupt-subtitle" style="color:#6b7280;margin-top:2px;"></div>
      </div>
      <button id="ssp-disrupt-close" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;">Close</button>
    </div>
    <div id="ssp-disrupt-body" style="padding:12px;"></div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.style.display = "none";
  });
  panel.querySelector("#ssp-disrupt-close").addEventListener("click", () => {
    overlay.style.display = "none";
  });
}


/* ============================================================
   SIDE WIDGET: OB Details Probe (LoadGroupId + optional PlanId)
   - Debug utility to test getContainerDetailsForLoadGroupId behavior.
   - Manual inputs; does not affect Action/Merge panels.
   - Calls: /ssp/dock/hrz/ob/fetchdata?
   - Payload includes:
       entity=getContainerDetailsForLoadGroupId
       nodeId=<detected>
       status=<selected>
       loadGroupId=<single>
       planId=<optional>
 ============================================================ */

function ensureObDetailsProbeWidget_v198_removed(){}

function barRow(labelLeft, valueRight, pct, accent) {
  const p = Math.max(0, Math.min(100, Number(pct || 0)));
  const a = accent || "#2563eb";
  return `
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0;">
      <div style="min-width:120px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(labelLeft)}</div>
      <div style="flex:1;height:10px;background:#f3f4f6;border-radius:999px;overflow:hidden;">
        <div style="height:10px;width:${p}%;background:${a};"></div>
      </div>
      <div style="min-width:70px;text-align:right;font-variant-numeric:tabular-nums;">${esc(valueRight)}</div>
    </div>
  `;
}

function openMergePanel(laneKey, cptMs) {
  STATE.mergePanelOpen = true;
  ensureMergePanel();
  const overlay = document.getElementById("ssp-merge-overlay");
  // Make the overlay visible immediately when opening the panel.
  if (overlay) overlay.style.display = "flex";
  const sub = document.getElementById("ssp-merge-subtitle");
  const current = document.getElementById("ssp-merge-current");
  const under = document.getElementById("ssp-merge-under");
  const mergeable = document.getElementById("ssp-merge-mergeable");
  const inb = document.getElementById("ssp-merge-inb");

  const runId = ++STATE.mergePanelRunId;

  const key = String(laneKey || "—") + "::" + String(Number(cptMs || 0));
  const g = STATE.actionGroups ? STATE.actionGroups.get(key) : null;

  const __all = String(laneKey||"") === "__ALL__";
  const laneTxt = __all ? "All lanes" : (laneKey || (g && g.lane) || "—");
  const cptTxt = fmtTime(Number(cptMs || (g && g.cptMs) || 0));
  sub.textContent = __all ? `${laneTxt}` : `${laneTxt} (CPT ${cptTxt})`;

  // Helpful context for leaders: show the query windows we are using.
  const qw = getQueryWindows(Date.now());

  // Request OB details on-demand when opening the Merge Panel.
  try {
    for (const v of (g && g.vrids) ? g.vrids : []) {
      const vr = String(v?.vrid || v?.vrId || "").trim();
      if (vr) ensureVridDetailsRequested(vr);
    }
  } catch {}

// Inbound VRIDs list is rendered below (planId/arrival clamped); loadGroup container details are shown inline per VRID when available.

  // --- Mergeable inbound eligible (CDT lane attribution + container-details membership)
  // These values are also used by Current Units rendering, so they MUST be initialized before any renderCurrentUnits() call.
  const eligMap = STATE.inboundEligibleMap || {};
  const NL = (v) => String(v ?? "")
    .trim().toUpperCase().replace(/\s+/g, "").replace(/[|]/g, "").replace(/→/g, "->");

  const wantLane = NL(laneTxt);
  const wantCpt = Number(cptMs || 0);
  const lgKey = wantLane + "::" + String(wantCpt);
  const lgIds = (STATE.ibLaneCptLoadGroups && STATE.ibLaneCptLoadGroups[lgKey]) ? STATE.ibLaneCptLoadGroups[lgKey] : [];

  // Fast totals from CDT counts (containers remaining for this lane+CPT)
  const laneCptUnits = Number((STATE.ibLaneCptUnits && STATE.ibLaneCptUnits[lgKey]) || 0);

  const debugOn = !!SETTINGS.mergeDebug;
  const mergeDebugHtml = (obj) => {
    if (!debugOn) return "";
    try {
      return `
        <details style="margin-top:10px;">
          <summary style="cursor:pointer;color:#111827;font-weight:700;">Debug</summary>
          <div style="margin-top:8px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;font-size:11px;white-space:pre-wrap;">${esc(JSON.stringify(obj || {}, null, 2))}</div>
        </details>
      `;
    } catch (e) {
      return `<div style="margin-top:10px;color:#b91c1c;">Debug render error: ${esc(String(e))}</div>`;
    }
  };

  const dbgBase = {
    lane: wantLane,
    cpt: wantCpt,
    loadGroupIds: lgIds,
    laneCptUnits,
    inboundLoads: (STATE.inboundLoads || []).length,
    inboundLoadsAll: (STATE.inboundLoadsAll || []).length,
    eligMapKeys: Object.keys(eligMap || {}).length,
  };

// --- Current Units verification (which containers the system sees)
  // Loaded units are derived from getOutboundLoadContainerDetails (authoritative).
  // Remaining units are derived from IB4CPT CDT-based unLoadedCount (eligible not yet on trailers).

  // --- Current Units (inFacility)
  // SSP OB typically requires loadGroupId plus an identifying inbound planId (and often a vrid) to return a scoped tree.
  // We compute Current Units by calling getContainerDetailsForLoadGroupId with status=inFacility using an inbound anchor (planId-first).

  const countInFacilityUnitsForLaneFromRoots = (roots, loadGroupId, laneTokenNorm) => {
  // Walk full tree. ROOT_NODE often begins with location nodes (GENERAL_AREA/STACKING_AREA/STAGING_AREA/DOCK_DOOR/TRAILER/SORTER),
  // with CART/PALLET/GAYLORD/BAG/CAGE nested underneath; and PACKAGE nodes nested underneath those containers.
  const out = { units: 0, byType: { CART: 0, PALLET: 0, GAYLORD: 0, BAG: 0, CAGE: 0 }, matched: 0 };

  if (!Array.isArray(roots)) return out;
  const lg = String(loadGroupId || '').trim();
  if (!lg) return out;

  const tok = String(laneTokenNorm || '').trim(); // already normalized upstream when provided
  const isContainerType = (t) => ['CART','PALLET','GAYLORD','BAG','CAGE'].includes(t);
  const stack = roots.map(n => ({ n, ctxTok: tok })); // ctxTok reserved if we later need context-based matching

  while (stack.length) {
    const { n } = stack.pop();
    if (!n) continue;

    const c = n.container || n.containerDetails || null;
    const kids = Array.isArray(n.childNodes) ? n.childNodes : [];
    for (const k of kids) stack.push({ n: k });

    if (!c) continue;

    const t = String(c.contType || '').trim().toUpperCase();
    if (!isContainerType(t)) continue;

    const outLg = String(c.outboundLoadGroupId || '').trim();
    if (!outLg || outLg !== lg) continue;

    // Lane filter: stackFilter is most reliable; label is a fallback.
    if (tok) {
      const sf = normalizeStackFilterToken(String(c.stackFilter || ''));
      const lb = normalizeStackFilterToken(String(c.label || ''));
      const hit = (sf && sf.includes(tok)) || (lb && lb.includes(tok));
      if (!hit) continue;
    }

    out.matched += 1;
    out.byType[t] = (out.byType[t] || 0) + 1;
    out.units += unitsForContainerType(t);
  }

  return out;
};


  const renderCurrentUnits = async () => {
    // Use the first non-empty outbound loadGroupId for this lane/CPT.
    const lg = String((Array.isArray(lgIds) ? lgIds.find(Boolean) : '') || (Array.isArray(dbgBase.loadGroupIds) ? dbgBase.loadGroupIds.find(Boolean) : '') || "").trim();
    if (!lg) {
      current.innerHTML = `<div style="color:#6b7280;">No loadGroupId for Current Units.</div>`;
      return;
    }
const data = await fetchCurrentUnitsCoordinator({ lg, laneTxt });
if (!data) {
  current.innerHTML = '<div style="color:#6b7280;">Unable to compute Current Units.</div>';
  return;
}
if (data && data.loading) {
  current.innerHTML = '<div style="color:#6b7280;">Current Units: loading…</div>';
  // Poll once or twice; coordinator resolves asynchronously and will populate shortly.
  setTimeout(() => { try { if (STATE.mergePanelRunId === runId) void renderCurrentUnits(); } catch (_) {} }, 450);
  return;
}
if (data && data.error) {
  current.innerHTML = '<div style="color:#b91c1c;">Current Units error: ' + String(data.error) + '</div>';
  return;
}

const bt = data.byType || {};
const debugOn = !!SETTINGS.mergeDebug;
const bucketStr = Object.keys(data.bucketCounts || {}).map(k => (k + ':' + data.bucketCounts[k])).join(' | ') || '-';
const debugHtml = debugOn
  ? (
      '<div style="color:#9ca3af;font-size:11px;margin-top:4px;">' +
        'roots:' + (data.rootsCount || 0) + ' ' +
        'metaAll:' + (data.metaAllCount || 0) + ' ' +
        'meta:' + (data.metaCount || ((data.meta || []).length)) + ' ' +
        'pkgs:' + (data.pkgCount || 0) +
      '</div>' +
      '<div style="color:#9ca3af;font-size:11px;">' +
        'buckets:' + bucketStr +
      '</div>'
    )
  : '';



  // Coordinator step trace (Merge Debug)
  const cuDbg = (STATE.currentUnitsDebugByLg && STATE.currentUnitsDebugByLg[String(lg)]) || null;
  const stepsHtml = (debugOn && cuDbg)
    ? (
        '<div style="margin-top:6px;">' +
        '<details><summary style="cursor:pointer;">Coordinator Trace (' + (cuDbg.steps ? cuDbg.steps.length : 0) + ')</summary>' +
        '<pre style="max-height:220px;overflow:auto;background:#f8f8f8;border:1px solid #e5e7eb;border-radius:6px;padding:8px;margin-top:6px;">' +
        esc(JSON.stringify(cuDbg.steps || [], null, 2)) +
        '</pre></details></div>'
      )
    : '';

current.innerHTML = `
  <div style="font-size:18px;font-weight:900;">
    ${fmtUnits(data.units)} units
  </div>
  <div style="color:#6b7280;font-size:12px;">
    CART:${bt.CART || 0}
    PALLET:${bt.PALLET || 0}
    GAYLORD:${bt.GAYLORD || 0}
  </div>
  ${debugHtml}
  ${renderContainerBucketsV2(data.meta)}
`;

    return; // coordinator handled render

    // Cache/inflight controls (avoid spamming OB)
    STATE.currentUnitsCache = STATE.currentUnitsCache || {};
    STATE.currentUnitsInflight = STATE.currentUnitsInflight || new Set();
    const key = `cu::${STATE.nodeId || ''}::${lg}::${String(laneTxt || '')}`;

    const cached = STATE.currentUnitsCache[key];
    if (cached && (Date.now() - (cached.ts || 0) < 3 * 60 * 1000)) {
      const tip = `CART:${(cached.byType&&cached.byType.CART)||0}  PALLET:${(cached.byType&&cached.byType.PALLET)||0}  GAYLORD:${(cached.byType&&cached.byType.GAYLORD)||0}`;
      current.innerHTML = `
        <div style="font-size:18px;font-weight:900;" title="${tip}">${fmtUnits(cached.units)} units</div>
        <div style="color:#6b7280;font-size:12px;">In facility${cached.meta?` • ${cached.meta.length} containers`:''}</div>
        ${cached.meta?renderContainerBucketsV2(cached.meta):''}
      `;
      return;
    }

    if (STATE.currentUnitsInflight.has(key)) {
      current.innerHTML = `<div style="color:#6b7280;">Loading current units…</div>`;
      return;
    }
    // Need an OB anchor (planId+vrId) that belongs to this outbound loadGroupId.
    STATE.laneAnchorByLg = STATE.laneAnchorByLg || {};
    let anchor = STATE.laneAnchorByLg[lg] || null;

    // Validate cached anchor against current outbound data.
    if (anchor && anchor.planId) {
      const pid = String(anchor.planId || '').trim();
      const ok = (STATE.outboundLoadsAll || []).some(l => obLoadGroupId(l) === lg && obPlanId(l) === pid);
      if (!ok) {
        _step('anchor_invalidated', { pid, reason: 'not_found_in_outboundLoadsAll' });
        anchor = null;
      } else {
        _step('anchor_valid', { pid });
      }
    }

    if (!anchor) {
      anchor = resolveObAnchorForLg(lg, laneTxt);
      _step('anchor_resolved', { anchor });
      if (anchor) STATE.laneAnchorByLg[lg] = anchor;
    }

    if (!anchor || !anchor.planId) {
      current.innerHTML = `<div style="color:#6b7280;">No matching planId found for this loadGroupId.</div>`;
      return;
    }

    const laneTokenNorm = normalizeStackFilterToken(String(laneTxt || '').split('->').pop() || '');

    STATE.currentUnitsInflight.add(key);
  _step('inflight_add');
    current.innerHTML = `<div style="color:#6b7280;">Loading current units…</div>`;

    try {
      const payload = {
        entity: 'getContainerDetailsForLoadGroupId',
        nodeId: STATE.nodeId,
        loadGroupId: lg,
        planId: String(anchor.planId),
        vrId: String(anchor.vrid || ''),
        status: 'notArrived',
        trailerId: '',
      };

      const resp = await postFetch('/ssp/dock/hrz/ob/fetchdata?', payload, 'OB', { priority: 2 });
      __sspRecordPull('CU_OB', payload, resp, { via: 'renderCurrentUnits', note: 'postFetch return (parsed)' });
      const roots = getObRootNodes(resp);
    _step('roots_extracted', { rootsCount: Array.isArray(roots) ? roots.length : -1 });
        const laneTokenNorm = normalizeStackFilterToken(
  String(laneTxt || '').split('->').pop() || ''
);

const inboundSummary = summarizeRootsForLane(roots, laneTokenNorm);


      const metaAll = extractContainersMetaWithLocationFromObRoots(roots) || [];
    _step('meta_extracted', { metaAll: metaAll.length });
      // Scope to this outbound loadGroupId only
      const meta = metaAll.filter(x => String(x.outboundLoadGroupId || '').trim() === lg);

      const loadedContainers = meta.filter(m => String(m.locationType || '').toUpperCase() === 'TRAILER' || String(m.bucket||'') === 'Loaded').length;
      const inFacilityContainers = Math.max(0, meta.length - loadedContainers);
let inboundHtml = '';

if (!inboundSummary || inboundSummary.vrids.size === 0) {
  inboundHtml = `
    <div style="color:#6b7280;">
      No inbound loads in this ops window contribute containers to this lane/loadGroup.
    </div>
  `;
} else {
  inboundHtml = `
    <div>
      <b>${inboundSummary.vrids.size}</b> inbound VRID(s) contributing
    </div>
    ${[...inboundSummary.samples.entries()].map(([vrid, s]) => `
      <div style="margin-left:12px;margin-top:4px;">
        <b>${esc(vrid)}</b> — ${s.count} container(s)
        ${
          s.exampleContainers.length
            ? `<div style="color:#6b7280;font-size:12px;">
                 ${s.exampleContainers.map(esc).join(', ')}
               </div>`
            : ''
        }
      </div>
    `).join('')}
  `;
}


      // IMPORTANT: In SSP Util, "units" means *weighted handling units* (containers), not packages.
      // Capacity math is based on physical handling units:
      //   CART=1.0, PALLET=1.5, GAYLORD=1.5, BAG=0.25 (configurable), CAGE=1.0 (assumed).
      // Packages are still useful for diagnostics, but must not drive capacity math.
      const packages = meta.reduce((s,x) => s + Number(x.pkgCount || 0), 0);
      const weightedUnits = meta.reduce((s,x) => s + unitsForContainerType(String(x.contType||'').toUpperCase()), 0);
      const totals = {
        units: weightedUnits,        // weighted handling units (capacity basis)
        containers: meta.length,     // raw physical container count
        packages,
        loadedContainers,
        inFacilityContainers,
        byType: meta.reduce((a,x) => {
          const t = String(x.contType || '').toUpperCase();
          a[t] = (a[t] || 0) + 1;
          return a;
        }, { CART:0, PALLET:0, GAYLORD:0, TOTE:0, BAG:0, CAGE:0 }),
      };

      STATE.currentUnitsCache[key] = { ts: Date.now(), ...totals, meta };

      const tip = `CART:${totals.byType.CART||0}  PALLET:${totals.byType.PALLET||0}  GAYLORD:${totals.byType.GAYLORD||0}  BAG:${totals.byType.BAG||0}  CAGE:${totals.byType.CAGE||0}  •  Packages:${totals.packages||0}`;
      current.innerHTML = `
        <div style="font-size:18px;font-weight:900;" title="${tip}">${fmtUnits(totals.units)} units</div>
        <div style="color:#6b7280;font-size:12px;">Current • ${totals.containers} containers (Loaded: ${totals.loadedContainers}, In-facility: ${totals.inFacilityContainers}) • ${totals.packages||0} packages</div>
        ${renderContainerBucketsV2(meta)}
      `;

    } catch (_) {
      current.innerHTML = `<div style="color:#6b7280;">Unable to compute Current Units.</div>` + __sspRenderPullDebug("CU_OB");
    } finally {
      STATE.currentUnitsInflight.delete(key);
    }
  };

  // kick once on open; later inbound resolution will refresh it when anchor is available
  void renderCurrentUnits();
  // --- Underutilized outbound VRIDs (simple view)
  const vrids = (g && g.vrids) ? g.vrids.slice() : [];
  vrids.sort((a, b) => {
    const pa = (a.capacity ? (a.loadedUnits || 0) / a.capacity : 0);
    const pb = (b.capacity ? (b.loadedUnits || 0) / b.capacity : 0);
    return pa - pb;
  });

  if (!vrids.length) {
    under.innerHTML = `<div style="color:#6b7280;">No outbound VRIDs found for this route/CPT.</div>`;
  } else {
    under.innerHTML = vrids
      .map((v) => {
        const cap = Number(v.capacity || 0);
        const loaded = Number(v.loadedUnits || 0);
        const pct = cap > 0 ? Math.round((loaded / cap) * 100) : 0;
        const accent = pct < 50 ? "#dc2626" : pct < 80 ? "#f59e0b" : "#16a34a";
        return barRow(v.vrid, `${loaded}/${cap}`, pct, accent);
      })
      .join("");
  }

  mergeable.innerHTML = lgIds.length
    ? `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
         <div>
           <div style="font-weight:900;">Eligible containers (merge candidates in facility): —</div>
           <div style="color:#6b7280;font-size:12px;">LoadGroupIds: ${lgIds.length}</div>
         </div>
       </div>` + mergeDebugHtml(dbgBase)
    : `<div style="color:#6b7280;">No inbound volume attributed to this lane/CPT.</div>` + mergeDebugHtml(dbgBase);

  if (STATE.mergePanelRunId !== runId) return;
  inb.innerHTML = lgIds.length
    ? `<div style="color:#6b7280;">Resolving inbound VRIDs for ${lgIds.length} loadGroupId(s)…</div>`
    : `<div style="color:#6b7280;">No inbound VRIDs detected for this route.</div>` + mergeDebugHtml(dbgBase);

  // Resolve inbound VRIDs + units via a SINGLE OB call (planId-first anchor), then attribute containers to parent LOAD (VRID).
  // This avoids relying on getEligibleContainerCountsForLoads, which can return 0 depending on node/service behavior.
  if (lgIds.length) {
    (async () => {
      try {
        await ensureInboundReady();

        const wantLaneStr = String(wantLane || "");
        const laneTokenWant = (wantLaneStr.split('->')[1] || '').trim();
        const laneTokenNorm = String(laneTokenWant || '').toUpperCase().replace(/\s+/g,'').replace(/_+/g,'-').replace(/-CYC(\d)\b/g,'-CYCLE$1');

        // Build a fast VRID -> inboundLoad lookup (planId/status/times), scoped to the current ops window.
        const { startMs: ibWinStart, endMs: ibWinEnd } = getOpsWindow(Date.now());
        const inWindow = (ms) => (ms && ms >= ibWinStart && ms <= ibWinEnd);
        const ibByVrid = new Map();
        for (const l of (STATE.inboundLoadsAll || [])) {
          const vr = String(l?.vrId || l?.vrid || '').trim();
          if (!vr) continue;
          const t = toMs(l?.actualArrivalTime || l?.estimatedArrivalTime || l?.scheduledArrivalTime);
          if (!inWindow(t)) continue;
          ibByVrid.set(vr, l);
        }

        const __knownIbVrids = new Set(ibByVrid.keys());

        // Anchor OB call using a planId that belongs to this outbound loadGroupId (do NOT use inbound planIds).
        STATE.laneAnchorByLg = STATE.laneAnchorByLg || {};
        const lg0 = String(lgIds[0] || '').trim();
        let anchor = STATE.laneAnchorByLg[lg0] || null;
        if (anchor && anchor.planId) {
          const pid = String(anchor.planId || '').trim();
          const ok = (STATE.outboundLoadsAll || []).some(l => obLoadGroupId(l) === lg0 && obPlanId(l) === pid);
          if (!ok) {
        _step('anchor_invalidated', { pid, reason: 'not_found_in_outboundLoadsAll' });
        anchor = null;
      } else {
        _step('anchor_valid', { pid });
      }
        }
        if (!anchor) {
          anchor = resolveObAnchorForLg(lg0, wantLaneStr);
          if (anchor) STATE.laneAnchorByLg[lg0] = anchor;
        }
        if (!anchor || !anchor.planId) {
          inb.innerHTML = `<div style="color:#6b7280;">No matching OB planId found for this loadGroupId.</div>` + mergeDebugHtml(dbgBase);
          return;
        }

        const loadGroupId = String(lgIds[0] || '').trim();
	      const payload = {
          entity: 'getContainerDetailsForLoadGroupId',
          nodeId: STATE.nodeId,
          loadGroupId,
	        planId: String(anchor.planId),
	        vrId: String(anchor.vrid || anchor.vrId || ''),
          status: 'notArrived',
          trailerId: '',
        };

        const t0 = performance.now();
        const resp = await postFetch('/ssp/dock/hrz/ob/fetchdata?', payload, 'OB', { priority: 2 });
        const dtMs = Math.round(performance.now() - t0);

	      const roots = getObRootNodes(resp);
    _step('roots_extracted', { rootsCount: Array.isArray(roots) ? roots.length : -1 });

        const weightByType = {
          CART: 1,
          PALLET: Number(SETTINGS.palletUnits) || 1.5,
          GAYLORD: Number(SETTINGS.gaylordUnits) || 1.5,
          BAG: Number(SETTINGS.bagUnits) || 0.25,
          CAGE: 1,
        };

        // Helper: recursively count physical containers under a node.
        const countPhysicalUnder = (node, out) => {
          if (!node) return;
          const c = node.container || {};
          const t = String(c.contType || '').toUpperCase();

          if (t === 'CART' || t === 'PALLET' || t === 'GAYLORD') {
            const og = String(c.outboundLoadGroupId || '').trim();
            const sf = String(c.stackFilter || '').toUpperCase().replace(/\s+/g,'').replace(/_+/g,'-').replace(/-CYC(\d)\b/g,'-CYCLE$1');
            if (og && og === loadGroupId && (!laneTokenNorm || sf.includes(laneTokenNorm))) {
              out.containers += 1;
              out.byType[t] = (out.byType[t] || 0) + 1;
              out.units += Number(weightByType[t] || 1);
              const lab = String(c.label || c.containerId || '').trim();
              if (lab) out.labels.push(lab);
            }
            return; // physical containers are leaves for our purposes
          }

          const kids = node.childNodes || [];
          if (Array.isArray(kids)) {
            for (const k of kids) countPhysicalUnder(k, out);
          }
        };

        // Attribute containers to parent LOAD nodes (VRIDs)
        const vridAgg = new Map(); // vrid -> {units, containers}
        for (const n of (roots || [])) {
          const c = n?.container || {};
          const t = String(c?.contType || '').toUpperCase();
          if (t !== 'LOAD') continue;
          const vrid = _extractKnownVridFromLoadContainer(c, __knownIbVrids);
          if (!vrid) continue;
          const out = { units: 0, containers: 0, byType: { CART: 0, PALLET: 0, GAYLORD: 0 }, labels: [] };
          countPhysicalUnder(n, out);
          if (out.units > 0 || out.containers > 0) vridAgg.set(vrid, out);
        }

        // Build rows: only loads that actually contribute containers to this lane/loadGroup.
        const rows = [];
        for (const [vrid, agg] of vridAgg.entries()) {
          const ib = ibByVrid.get(vrid) || null;
          // If the load is not in our inbound ops-window cache, do not surface it (prevents orphan VRIDs).
          if (!ib || !ib.planId) continue;
          const planId = String(ib?.planId || '');
          rows.push({
            planId,
            vrid,
            status: String(ib?.status || ''),
            eta: String(ib?.estimatedArrivalTime || ''),
            sch: String(ib?.scheduledArrivalTime || ''),
            aat: String(ib?.actualArrivalTime || ''),
            loc: String(ib?._sspLocation || ''),
            inbLane: String(agg.inbLane || ''),
            units: Number(agg.units || 0),
            containers: Number(agg.containers || 0),
            byType: agg.byType || { CART: 0, PALLET: 0, GAYLORD: 0 },
            labels: Array.isArray(agg.labels) ? agg.labels : [],
            unitTip: (() => {
              const bt = agg.byType || { CART: 0, PALLET: 0, GAYLORD: 0 };
              const parts = [
                `CART: ${Number(bt.CART||0)} | PALLET: ${Number(bt.PALLET||0)} | GAYLORD: ${Number(bt.GAYLORD||0)}`,
              ];
              const labs = Array.isArray(agg.labels) ? agg.labels : [];
              if (labs.length) {
                const head = labs.slice(0, 15);
                parts.push(...head);
                if (labs.length > head.length) parts.push(`…+${labs.length - head.length} more`);
              }
              return parts.join('\n');
            })(),
          });
        }

        // Cache an inbound anchor per *outbound loadGroupId* so Current Units (inFacility) can be scoped correctly.
        // We key by outbound loadGroupId because that is what getContainerDetailsForLoadGroupId expects.
        // planId is the critical identifier; vrid improves scoping when present.
        try {
          STATE.laneAnchorByLg = STATE.laneAnchorByLg || {};
          const outLg = String((Array.isArray(lgIds) ? lgIds.find(Boolean) : '') || '').trim();
          if (outLg && rows.length) {
            const a = rows[0];
            if (a && a.planId) {
              STATE.laneAnchorByLg[outLg] = { planId: String(a.planId || ''), vrid: String(a.vrid || '') };
            }
          }
        } catch (_) {}

        // Refresh Current Units now that we have an anchor
        if (STATE.mergePanelRunId === runId) { try { void renderCurrentUnits(); } catch (_) {} }

        // Merge Panel should not show completed loads unless they STILL have contributing units (rows already enforce this).
        // Sort by time then status.
        const timeKey = (r) => {
          const t = toMs(r.aat || r.eta || r.sch);
          return t ? Number(t) : 0;
        };
        rows.sort((a,b) => timeKey(a) - timeKey(b) || (b.units - a.units) || String(a.vrid).localeCompare(String(b.vrid)));

        // Eligible merge candidates = in-facility (not scheduled/notArrived) and under mergeSoon fullness.
        const cap = Number(g?.cap || g?.capacity || SETTINGS.cap53ftCarts) || 36;
        const soon = Number(SETTINGS.mergeSoon) || 0.37;

        const normStatus = (st) => String(st || '').toUpperCase();
        const isTransit = (st) => {
          const s = normStatus(st);
          return s.includes('SCHEDULED') || s.includes('NOTARRIVED') || s.includes('NOT_ARRIVED');
        };
        const isCompleted = (st) => normStatus(st).includes('COMPLETED');
        const isInFacility = (st) => {
          const s = normStatus(st);
          if (!s) return false;
          if (isCompleted(s)) return false;
          if (isTransit(s)) return false;
          return true;
        };

        const mergeCandidates = rows.filter(r => isInFacility(r.status) && (Number(r.units || 0) / cap) < soon);
        const eligibleUnits = mergeCandidates.reduce((sum, r) => sum + Number(r.units || 0), 0);

        mergeable.innerHTML = `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
            <div>
              <div style="font-weight:900;">Eligible containers (merge candidates in facility): ${fmtUnits(eligibleUnits)}</div>
              <div style="color:#6b7280;font-size:12px;">Merge-candidate VRIDs: ${mergeCandidates.length} | LoadGroups: ${lgIds.length}</div>
            </div>
          </div>` + mergeDebugHtml(Object.assign({}, dbgBase, { mpSteps: mpSteps }, { cap, mergeSoon: soon, eligibleUnits, mergeCandidates: mergeCandidates.length, obMs: dtMs }));

        const body = rows.length
          ? rows.map(r => {
              const timeLabel = r.aat ? `AAT ${esc(r.aat)}` : (r.eta ? `ETA ${esc(r.eta)}` : (r.sch ? `SCH ${esc(r.sch)}` : ''));
              const locLabel = r.loc ? ` | ${esc(r.loc)}` : '';
              return `
                <div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid #f3f4f6;">
                  <div style="flex:1;min-width:0;">
                    <div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(r.vrid)}">${esc(r.vrid)}</div>
                    <div style="color:#6b7280;font-size:12px;">${esc(r.status || '—')}${timeLabel ? ` | ${timeLabel}` : ''}${locLabel}</div>
                  </div>
                  <div style="text-align:right;white-space:nowrap;">
                    <div style="font-weight:900;"><span title="${esc(String(r.unitTip || ''))}" style="cursor:help;">${fmtUnits(r.units)}</span> <span style="color:#9ca3af;font-size:12px;font-weight:700;">units</span></div>
                  </div>
                </div>`;
            }).join('')
          : `<div style="color:#6b7280;">No inbound loads in this ops window contribute containers to this lane/loadGroup.</div>`;

        if (STATE.mergePanelRunId !== runId) return;
        // Cache a planId-first anchor for this loadGroup so inFacility OB queries (Current Units) can be scoped correctly.
        try {
          STATE.laneAnchorByLg = STATE.laneAnchorByLg || {};
          const outLg = String((Array.isArray(lgIds) ? lgIds.find(Boolean) : '') || '').trim();
          const a = rows.find(r => r && r.planId) || null;
          if (outLg && a) STATE.laneAnchorByLg[outLg] = { planId: String(a.planId || ''), vrid: String(a.vrid || '') };
        } catch (_) {}

// Prefer the no-click OB-attributed contributor cache (same source used by the Action Panel).
// The older lane-token heuristic can show 0 even when inbound is clearly contributing.
const __ibKey = _ibContribKey(wantLane, wantCpt);
try { _enqueueIbContrib(wantLane, wantCpt); } catch (_) {}

const __renderIb = () => {
  const rows2 = (STATE.ibContribByLaneCpt && STATE.ibContribByLaneCpt[__ibKey]) ? STATE.ibContribByLaneCpt[__ibKey] : [];
  const ts2 = (STATE.ibContribTsByLaneCpt && STATE.ibContribTsByLaneCpt[__ibKey]) ? Number(STATE.ibContribTsByLaneCpt[__ibKey] || 0) : 0;
  const ageMin = ts2 ? Math.max(0, Math.round((Date.now() - ts2) / 60000)) : 0;

  const refreshBtn = `<button id="ssp-merge-inb-refresh" style="padding:4px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer;font-weight:800;">Refresh</button>`;

  if (!Array.isArray(rows2) || !rows2.length) {
    inb.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div style="color:#6b7280;">No inbound loads in this ops window contribute containers to this lane/loadGroup.</div>
        ${refreshBtn}
      </div>
    ` + mergeDebugHtml(Object.assign({}, dbgBase, { mpSteps: mpSteps }, { cacheKey: __ibKey, resolvedVrids: 0, obMs: dtMs }));
  } else {
    const pills = rows2.slice(0, 18).map(r => {
      const tip = [
        `Units: ${fmtUnits(Number(r.units||0))} | Containers: ${Number(r.containers||0)}`,
        (r.inbLane ? `IB Lane: ${r.inbLane}` : ''),
        (r.loc ? `Loc: ${r.loc}` : ''),
        (r.status ? `Status: ${r.status}` : ''),
        (r.eta ? `ETA: ${r.eta}` : (r.sch ? `SCH: ${r.sch}` : (r.aat ? `AAT: ${r.aat}` : ''))),
        (Array.isArray(r.labels) && r.labels.length ? `Labels: ${r.labels.slice(0, 12).join(', ')}${r.labels.length>12 ? ' …' : ''}` : '')
      ].filter(Boolean).join('\n');
      return `<span title="${esc(tip)}" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;font-weight:900;">${esc(r.vrid)}</span>`;
    }).join(' ');
    const more = (rows2.length > 18) ? ` <span style="color:#6b7280;font-weight:900;">+${rows2.length - 18}</span>` : '';

    const tableRows = rows2.slice(0, 50).map(r => {
      const when = esc(r.aat || r.eta || r.sch || '');
      const st = esc(r.status || '');
      const loc = esc(r.loc || '');
      const units = fmtUnits(Number(r.units || 0));
      const cont = Number(r.containers || 0);
      return `
        <tr>
          <td style="padding:6px 8px;border-top:1px solid #f3f4f6;font-weight:900;">${esc(r.vrid)}</td>
          <td style="padding:6px 8px;border-top:1px solid #f3f4f6;text-align:right;font-weight:900;">${units}</td>
          <td style="padding:6px 8px;border-top:1px solid #f3f4f6;text-align:right;">${cont}</td>
          <td style="padding:6px 8px;border-top:1px solid #f3f4f6;color:#374151;">${st}</td>
          <td style="padding:6px 8px;border-top:1px solid #f3f4f6;color:#374151;">${when}</td>
          <td style="padding:6px 8px;border-top:1px solid #f3f4f6;color:#374151;">${loc}</td>
        </tr>
      `;
    }).join('');

    const clipped = rows2.length > 50 ? `<div style="color:#6b7280;font-size:12px;margin-top:6px;">Showing first 50 of ${rows2.length} inbound VRIDs.</div>` : '';

    inb.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
        <div>
          <div><b>${rows2.length}</b> inbound VRID(s) contributing</div>
          <div style="color:#6b7280;font-size:12px;margin-top:2px;">Updated ${ageMin}m ago</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${refreshBtn}
        </div>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${pills}${more}
      </div>
      <div style="margin-top:10px;overflow:auto;max-height:32vh;border:1px solid #f3f4f6;border-radius:10px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="text-align:left;padding:6px 8px;">VRID</th>
              <th style="text-align:right;padding:6px 8px;">Units</th>
              <th style="text-align:right;padding:6px 8px;">Cntrs</th>
              <th style="text-align:left;padding:6px 8px;">Status</th>
              <th style="text-align:left;padding:6px 8px;">ETA/SCH/AAT</th>
              <th style="text-align:left;padding:6px 8px;">Location</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
      ${clipped}
    ` + mergeDebugHtml(Object.assign({}, dbgBase, { mpSteps: mpSteps }, { cacheKey: __ibKey, resolvedVrids: rows2.length, obMs: dtMs }));
  }

  const btn = document.getElementById("ssp-merge-inb-refresh");
  if (btn) {
    btn.onclick = (e) => {
      e.stopPropagation();
      try { if (STATE.ibContribTsByLaneCpt) STATE.ibContribTsByLaneCpt[__ibKey] = 0; } catch (_) {}
      try { _enqueueIbContrib(wantLane, wantCpt); } catch (_) {}
      inb.innerHTML = `<div style="color:#6b7280;">Refreshing inbound VRIDs…</div>` + mergeDebugHtml(Object.assign({}, dbgBase, { mpSteps: mpSteps }, { cacheKey: __ibKey, obMs: dtMs }));
      setTimeout(() => { if (STATE.mergePanelRunId === runId) __renderIb(); }, 750);
    };
  }
};

// Paint immediately with cache (or loading), then poll briefly for the async worker.
inb.innerHTML = `<div style="color:#6b7280;">Loading inbound VRID contributions…</div>` + mergeDebugHtml(Object.assign({}, dbgBase, { mpSteps: mpSteps }, { cacheKey: __ibKey, obMs: dtMs }));
(function __poll(attempt) {
  if (STATE.mergePanelRunId !== runId) return;
  const rows2 = (STATE.ibContribByLaneCpt && STATE.ibContribByLaneCpt[__ibKey]) ? STATE.ibContribByLaneCpt[__ibKey] : null;
  const ts2 = (STATE.ibContribTsByLaneCpt && STATE.ibContribTsByLaneCpt[__ibKey]) ? Number(STATE.ibContribTsByLaneCpt[__ibKey] || 0) : 0;
  if (Array.isArray(rows2) && ts2) { __renderIb(); return; }
  if (attempt >= 18) { __renderIb(); return; }
  setTimeout(() => __poll(attempt + 1), 350);
})(0);

        // Attempt Current Units render now that an anchor is likely available.
        void renderCurrentUnits();
      } catch (e) {
        if (STATE.mergePanelRunId !== runId) return;
        inb.innerHTML = `<div style="color:#b91c1c;">Failed to resolve inbound VRIDs: ${esc(String(e))}</div>` + mergeDebugHtml(Object.assign({}, dbgBase, { mpSteps: mpSteps }, { error: String(e) }));
      }
    })();
  }
  overlay.style.display = "flex";
}

setTimeout(() => {
    ensurePillarHeader();
    ensurePanel();

    // Debug side widget (batch capability probe for OB entities)
    // OB Details Probe widget removed (v1.5.26)

    // Keep phone icons rebound across SSP table rerenders.
    try { ensurePhoneIconObserver(); } catch {}

    applyRefreshTimer();
    run(true);
  }, 2500);


  /* =====================================================
     SHIFT STAFFING (Target CPH + Shift Timings + Overrides)
     - CPT Risk stays hard-coded elsewhere (not configurable)
  ====================================================== */

  const SHIFT_SETTINGS_KEY = 'SSP_UTIL_SHIFT_SETTINGS_V1';

  const SHIFT_DEFAULTS = {
    siteCode: 'MOR1',
    targetCph: 15, // containers per AA-hour
    shifts: [
      { id: 'mor1',  name: 'Mor1',  enabled: true, start: '02:00', startDay: 0, end: '06:00', endDay: 0, staffedAAs: 0, containerOverride: '' },
      { id: 'day',   name: 'Day',   enabled: true, start: '07:00', startDay: 0, end: '11:00', endDay: 0, staffedAAs: 0, containerOverride: '' },
      { id: 'twi',   name: 'Twi',   enabled: true, start: '11:45', startDay: 0, end: '15:45', endDay: 0, staffedAAs: 0, containerOverride: '' },
      { id: 'night', name: 'Night', enabled: true, start: '16:30', startDay: 0, end: '20:30', endDay: 0, staffedAAs: 0, containerOverride: '' },
      { id: 'wrap',  name: 'Wrap',  enabled: true, start: '21:15', startDay: 0, end: '01:15', endDay: 1, staffedAAs: 0, containerOverride: '' },
      { id: 'mor2',  name: 'Mor2',  enabled: true, start: '02:00', startDay: 1, end: '06:00', endDay: 1, staffedAAs: 0, containerOverride: '' },
    ],
  };

  function _safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

  function loadShiftSettings() {
    const raw = localStorage.getItem(SHIFT_SETTINGS_KEY);
    const parsed = raw ? _safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return structuredClone(SHIFT_DEFAULTS);

    const out = structuredClone(SHIFT_DEFAULTS);
    if (typeof parsed.siteCode === 'string') out.siteCode = parsed.siteCode;
    if (Number.isFinite(Number(parsed.targetCph)) && Number(parsed.targetCph) > 0) out.targetCph = Number(parsed.targetCph);

    if (Array.isArray(parsed.shifts)) {
      out.shifts = parsed.shifts.map((s, idx) => {
        const d = out.shifts[idx] || { id: `shift_${idx}`, name: `Shift ${idx + 1}` };
        return {
          id: String(s.id ?? d.id ?? `shift_${idx}`),
          name: String(s.name ?? d.name ?? `Shift ${idx + 1}`),
          enabled: Boolean(s.enabled ?? true),
          start: String(s.start ?? d.start ?? '07:00'),
          startDay: Number(s.startDay ?? d.startDay ?? 0) ? 1 : 0,
          end: String(s.end ?? d.end ?? '11:00'),
          endDay: Number(s.endDay ?? d.endDay ?? 0) ? 1 : 0,
          staffedAAs: Number.isFinite(Number(s.staffedAAs)) ? Number(s.staffedAAs) : 0,
          containerOverride: s.containerOverride ?? '',
        };
      });
    }
    return out;
  }

  function saveShiftSettings(settings) {
    localStorage.setItem(SHIFT_SETTINGS_KEY, JSON.stringify(settings));
  }

  let SHIFT_SETTINGS = loadShiftSettings();

  function _getOpsBaseDay0Ms(opsEndMs) {
    const d = new Date(opsEndMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }


  // Shift planning uses the *current* ops-day (07:00->07:00) so "Upcoming" selects the correct next shift
  // for the current local time (e.g., Wrap should be upcoming before 21:15 on the same calendar day).
  function _getShiftBaseDay0Ms(nowMs) {
    const now = new Date(nowMs);
    const cut = new Date(now);
    cut.setHours(7, 0, 0, 0);

    // If before 07:00, ops-day started yesterday at 07:00
    if (nowMs < cut.getTime()) cut.setDate(cut.getDate() - 1);

    // Day 0 is the midnight of the calendar date that contains the ops-day start.
    const day0 = new Date(cut);
    day0.setHours(0, 0, 0, 0);
    return day0.getTime();
  }

function _hhmmToMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    return (h * 60) + mm;
  }

  function _shiftToWindowMs(shift, baseDay0Ms) {
    const startMin = _hhmmToMinutes(shift.start);
    const endMin = _hhmmToMinutes(shift.end);
    if (startMin == null || endMin == null) return null;

    const startMs = baseDay0Ms + ((shift.startDay || 0) * 1440 + startMin) * 60 * 1000;
    const endMs   = baseDay0Ms + ((shift.endDay   || 0) * 1440 + endMin)   * 60 * 1000;
    if (!(endMs > startMs)) return null;
    return { startMs, endMs };
  }

  function _hoursBetween(aMs, bMs) {
    return Math.max(0, (bMs - aMs) / 3600000);
  }

  // Parses "14-Jan-26 04:09" (local)
  const _MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  function _parseInboundTs(str) {
    if (!str || typeof str !== 'string') return null;
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const dd = Number(m[1]);
    const mon = _MONTHS[m[2].toLowerCase()];
    const yy = 2000 + Number(m[3]);
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    if (mon == null) return null;
    return new Date(yy, mon, dd, hh, mm, 0, 0).getTime();
  }

  function _getLoadTimeForShiftBucketing(load) {
    return _parseInboundTs(load?.actualArrivalTime) ?? _parseInboundTs(load?.scheduledArrivalTime) ?? null;
  }

  function _getLoadContainerCount(load) {
    const candidates = [
      load?.containerCount,
      load?.containers,
      load?.container_count,
      load?.expectedContainers,
      load?.units,
    ];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 1;
  }

  function _requiredAAs(containers, targetCph, hours) {
    const c = Number(containers);
    const r = Number(targetCph);
    const h = Number(hours);
    if (!(c > 0) || !(r > 0) || !(h > 0)) return 0;
    return Math.ceil(c / (r * h));
  }

  function _computeShiftStaffing(shift, baseDay0Ms, nowMs) {
    const w = _shiftToWindowMs(shift, baseDay0Ms);
    if (!w) return { valid: false, reason: 'Invalid shift window' };

    const durationH = _hoursBetween(w.startMs, w.endMs);
    const remainingH = _hoursBetween(nowMs, w.endMs);

    // Expected containers: override OR derived from inbound loads in window
    let expected = null;
    const ov = String(shift.containerOverride ?? '').trim();
    if (ov !== '') {
      const n = Number(ov);
      if (Number.isFinite(n) && n >= 0) expected = n;
    }
    if (expected == null) {
      expected = 0;
      for (const l of (STATE?.inboundLoads || [])) {
        const t = _getLoadTimeForShiftBucketing(l);
        if (t == null) continue;
        if (t >= w.startMs && t < w.endMs) expected += _getLoadContainerCount(l);
      }
    }

    // Processed: COMPLETED loads w/ actualArrivalTime in shift window
    let processed = 0;
    for (const l of (STATE?.inboundLoads || [])) {
      if (String(l?.status || '').toUpperCase() !== 'COMPLETED') continue;
      const t = _parseInboundTs(l?.actualArrivalTime);
      if (t == null) continue;
      if (t >= w.startMs && t < w.endMs) processed += _getLoadContainerCount(l);
    }

    const remaining = Math.max(0, expected - processed);

    const staffed = Number.isFinite(Number(shift.staffedAAs)) ? Number(shift.staffedAAs) : 0;

    // If shift is active, staff against remaining hours; if upcoming, staff against full shift duration.
    const inWindow = nowMs >= w.startMs && nowMs < w.endMs;
    const hoursForCalc = inWindow ? Math.max(0, remainingH) : Math.max(0, durationH);
    const neededNow = hoursForCalc > 0 ? _requiredAAs(remaining, SHIFT_SETTINGS.targetCph, hoursForCalc) : 0;

    // Positive delta means we are short (need more AAs). Negative means surplus.
    const deltaNeed = neededNow - staffed;

    return {
      valid: true,
      inWindow,
      expected,
      processed,
      remaining,
      neededNow,
      staffed,
      deltaNeed,
    };
  }

  const _STAFFING_WIDGET_ID = 'ssp-util-staffing-widget';
  const _SHIFT_MODAL_ID = 'ssp-util-shift-modal';

  function _formatDeltaNeed(v) {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    return v > 0 ? `+${v}` : `${v}`;
  }

  function _getShiftSummary() {
    const nowMs = Date.now();
    if (typeof getOpsWindow !== 'function') return { ok: false, title: 'getOpsWindow unavailable' };

    const ctx = _getShiftContext(nowMs);
    const baseDay0Ms = ctx.baseDay0Ms;

    const enabled = ctx.enabledShifts;
    if (enabled.length === 0) return { ok: false, title: 'No shifts enabled' };

    const chosen = ctx.activeOrUpcoming;
    if (!chosen) return { ok: false, title: 'No shifts enabled' };
    const stats = _computeShiftStaffing(chosen, baseDay0Ms, nowMs);
    if (!stats.valid) return { ok: false, title: stats.reason };

    return {
      ok: true,
      label: stats.inWindow ? 'Active' : 'Upcoming',
      shiftName: chosen.name,
      expected: stats.expected,
      processed: stats.processed,
      remaining: stats.remaining,
      neededNow: stats.neededNow,
      staffed: stats.staffed,
      deltaNeed: stats.deltaNeed,
    };
  }


  function closeShiftModal() {
    const m = document.getElementById(_SHIFT_MODAL_ID);
    if (m) m.remove();
  }
function diagCopy(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  });
}

function diagDownload(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

  function openShiftSettingsQuickEditor() {
    closeShiftModal();

    const modal = document.createElement('div');
    modal.id = _SHIFT_MODAL_ID;
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.zIndex = '100000';
    modal.style.background = 'rgba(0,0,0,0.55)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.onclick = (e) => { if (e.target === modal) closeShiftModal(); };

    const card = document.createElement('div');
    card.style.width = '980px';
    card.style.maxWidth = '96vw';
    card.style.maxHeight = '86vh';
    card.style.overflow = 'auto';
    card.style.background = '#121212';
    card.style.color = '#fff';
    card.style.borderRadius = '14px';
    card.style.padding = '14px 14px 12px';
    card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div style="font-weight:800;font-size:14px;">Shift Settings</div>
        <button id="sspShiftClose" style="background:#2a2a2a;border:0;color:#fff;border-radius:10px;padding:8px 10px;cursor:pointer;">Close</button>
      </div>

      <div style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap;align-items:end;">
        <label style="display:flex;flex-direction:column;gap:6px;">
          <span style="opacity:0.85;">Target CPH (containers per AA-hour)</span>
          <input id="sspTargetCph" type="number" min="1" step="0.1" value="${SHIFT_SETTINGS.targetCph}"
            style="width:260px;padding:8px;border-radius:10px;border:1px solid #333;background:#0f0f0f;color:#fff;" />
        </label>

        <label style="display:flex;flex-direction:column;gap:6px;">
          <span style="opacity:0.85;">Site Code</span>
          <input id="sspSiteCode" type="text" value="${SHIFT_SETTINGS.siteCode}"
            style="width:180px;padding:8px;border-radius:10px;border:1px solid #333;background:#0f0f0f;color:#fff;" />
        </label>

        <button id="sspShiftAdd" style="background:#2f6fed;border:0;color:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;">Add shift</button>
        <button id="sspShiftSave" style="background:#23a55a;border:0;color:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;">Save</button>
      </div>

      <div style="margin-top:12px;border-top:1px solid #2a2a2a;padding-top:10px;">
        <div style="font-weight:700;margin-bottom:8px;">Shifts</div>
        <div style="display:grid;grid-template-columns: 80px 140px 120px 110px 120px 110px 110px 140px 70px;gap:8px;align-items:center;opacity:0.9;">
          <div>Enabled</div><div>Name</div><div>Start Day</div><div>Start</div><div>End Day</div><div>End</div>
          <div>Staffed</div><div>Override Cnt</div><div></div>
        </div>
        <div id="sspShiftRows" style="margin-top:8px;display:flex;flex-direction:column;gap:8px;"></div>
        <div style="margin-top:10px;opacity:0.8;font-size:11px;">
          Start/End Day are relative to Day 0. Use Current→Next for cross-midnight shifts (Wrap) and Next→Next for Mor2-style shifts.
        </div>
      </div>
    `;

    modal.appendChild(card);
    document.body.appendChild(modal);

    document.getElementById('sspShiftClose')?.addEventListener('click', closeShiftModal);

    const rows = document.getElementById('sspShiftRows');

    function daySelect(value, id) {
      return `
        <select data-field="${id}" style="padding:8px;border-radius:10px;border:1px solid #333;background:#0f0f0f;color:#fff;">
          <option value="0" ${String(value) === '0' ? 'selected' : ''}>Current</option>
          <option value="1" ${String(value) === '1' ? 'selected' : ''}>Next</option>
        </select>
      `;
    }

    function input(value, id, type='text') {
      return `<input data-field="${id}" type="${type}" value="${String(value ?? '')}"
        style="width:100%;padding:8px;border-radius:10px;border:1px solid #333;background:#0f0f0f;color:#fff;" />`;
    }

    function checkbox(checked, id) {
      return `<input data-field="${id}" type="checkbox" ${checked ? 'checked' : ''} style="transform:scale(1.2);" />`;
    }

    function renderRows() {
      rows.innerHTML = '';
      SHIFT_SETTINGS.shifts.forEach((s, idx) => {
        const row = document.createElement('div');
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '80px 140px 120px 110px 120px 110px 110px 140px 70px';
        row.style.gap = '8px';
        row.style.alignItems = 'center';

        row.innerHTML = `
          <div>${checkbox(s.enabled, `enabled:${idx}`)}</div>
          <div>${input(s.name, `name:${idx}`)}</div>
          <div>${daySelect(s.startDay, `startDay:${idx}`)}</div>
          <div>${input(s.start, `start:${idx}`, 'text')}</div>
          <div>${daySelect(s.endDay, `endDay:${idx}`)}</div>
          <div>${input(s.end, `end:${idx}`, 'text')}</div>
          <div>${input(s.staffedAAs ?? 0, `staffedAAs:${idx}`, 'number')}</div>
          <div>${input(s.containerOverride ?? '', `containerOverride:${idx}`, 'number')}</div>
          <div><button data-del="${idx}" style="background:#2a2a2a;border:0;color:#fff;border-radius:10px;padding:8px 10px;cursor:pointer;">Del</button></div>
        `;
        rows.appendChild(row);
      });

      rows.querySelectorAll('button[data-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-del'));
          if (!Number.isFinite(idx)) return;
          SHIFT_SETTINGS.shifts.splice(idx, 1);
          renderRows();
        });
      });
    }

    renderRows();

    document.getElementById('sspShiftAdd')?.addEventListener('click', () => {
      SHIFT_SETTINGS.shifts.push({
        id: `shift_${Date.now()}`,
        name: 'New Shift',
        enabled: true,
        start: '07:00',
        startDay: 0,
        end: '11:00',
        endDay: 0,
        staffedAAs: 0,
        containerOverride: '',
      });
      renderRows();
    });

    document.getElementById('sspShiftSave')?.addEventListener('click', () => {
      const cph = Number(document.getElementById('sspTargetCph')?.value);
      if (Number.isFinite(cph) && cph > 0) SHIFT_SETTINGS.targetCph = cph;

      const site = String(document.getElementById('sspSiteCode')?.value ?? '').trim();
      if (site) SHIFT_SETTINGS.siteCode = site;

      const inputs = modal.querySelectorAll('[data-field]');
      for (const el of inputs) {
        const key = el.getAttribute('data-field');
        if (!key) continue;
        const [field, idxStr] = key.split(':');
        const idx = Number(idxStr);
        if (!Number.isFinite(idx) || !SHIFT_SETTINGS.shifts[idx]) continue;
        const s = SHIFT_SETTINGS.shifts[idx];

        if (el.type === 'checkbox') s[field] = el.checked;
        else if (field === 'startDay' || field === 'endDay') s[field] = Number(el.value) ? 1 : 0;
        else if (field === 'staffedAAs') {
          const n = Number(el.value);
          s.staffedAAs = Number.isFinite(n) ? n : 0;
        } else if (field === 'containerOverride') s.containerOverride = String(el.value ?? '').trim();
        else s[field] = String(el.value ?? '').trim();
      }

      // Disable invalid rows (do not block save)
      const nowMs = Date.now();
      if (typeof getOpsWindow === 'function') {
        const { endMs } = getOpsWindow(nowMs);
        const baseDay0Ms = _getOpsBaseDay0Ms(endMs);
        SHIFT_SETTINGS.shifts.forEach(s => { if (!_shiftToWindowMs(s, baseDay0Ms)) s.enabled = false; });
      }

      saveShiftSettings(SHIFT_SETTINGS);
      closeShiftModal();
      try { if (typeof renderPanel === 'function') renderPanel(); } catch {}
    });
  }

  // Staffing overlay widget removed; shift summary is rendered in the panel status.
})();



/* ===== SSP Util v1.6.15: Current Units fixes ===== */

function extractContainersMetaWithLocationFromObRoots(roots) {
  const out = [];
  const seen = new Set();

  const norm = v => String(v ?? "").trim();
  const up = v => norm(v).toUpperCase();

  // Location-ish nodes in OB trees. (These may appear as container nodes with contType == DOCK_DOOR/TRAILER/etc.)
  
  const looksLikeContainerLabel = (s) => {
    const v = String(s || '').toUpperCase().trim();
    // Treat raw container labels/ids as NOT valid "location" labels.
    // This prevents PACKAGE nodes from overwriting the real parent location (GENERAL_AREA / STAGING / DOCK_DOOR).
    return (
      v.startsWith('CART_') ||
      v.startsWith('PALLET_') ||
      v.startsWith('GAYLORD_') ||
      v.startsWith('TOTE_') ||
      v.startsWith('BAG_') ||
      v.startsWith('CAGE_')
    );
  };

const isLocation = (t) => (
    t.endsWith("_AREA") ||
    t === "DOCK_DOOR" ||
    t === "TRAILER" ||
    t === "SORTER" ||
    t === "PACKAGE"
  );

  // Physical handling units we care about for CU/merge sizing.
  const isContainer = (t) => ["CART","PALLET","GAYLORD","TOTE","BAG","CAGE"].includes(t);

  // Some OB trees don't provide nice labels on the location node; they tuck it into other fields.
  const pickLabel = (c) => {
    // Prefer human-readable labels first.
    const cand = [
      c?.label,
      c?.locationLabel,
      c?.currentLocationLabel,
      c?.displayLabel,
      c?.name,
      c?.dockDoorId ? `DOOR ${c.dockDoorId}` : "",
      c?.trailerId,
      c?.locationId,
    ].map(norm).filter(Boolean);
    return cand[0] || "";
  };

  const pickLocType = (c) => {
    const cand = [
      c?.locationType,
      c?.currentLocationType,
      c?.locType,
      c?.location?.locationType,
      c?.currentLocation?.locationType,
      c?.location?.type,
      c?.currentLocation?.type,
      c?.currentLocType,
    ].map(norm).filter(Boolean);
    return cand[0] || "";
  };

  const bucketFor = (ltRaw, llUp) => {
    const lt = up(ltRaw);

    if (lt === "TRAILER") return "Loaded";
    if (lt === "DOCK_DOOR") return "Staged"; // door-present = in-facility, treat as staged
    if (lt === "STACKING_AREA") return "Stacked";
    if (lt === "SORTER") return "Sorter";

    // Treat GENERAL/STAGING/PACKAGE/blank as in-facility; infer receive vs staged from label.
    if (lt === "GENERAL_AREA" || lt === "STAGING_AREA" || lt === "PACKAGE" || !lt) {
      if (llUp.includes("RECEIVE") || llUp.includes("RCV") || llUp.includes("RECV")) return "Received";
      return "Staged";
    }

    // Fallback: many sites use custom *_AREA types; bucket those as staged unless clearly stacking.
    if (lt.endsWith("_AREA")) {
      if (lt.includes("STACK")) return "Stacked";
      return "Staged";
    }

    return "Unknown";
  };

  // ctx: { lt: <locationType>, ll: <locationLabel> }
  const stack = Array.isArray(roots) ? roots.map(n => ({ n, ctx: { lt: "", ll: "" } })) : [];
  while (stack.length) {
    const { n, ctx } = stack.pop();
    const c = n?.container || n?.containerDetails || n?.cont || {};
    const t = up(c.contType || c.containerType || c.type || "");

    let next = ctx;

    if (t && isLocation(t)) {
      const lbl = pickLabel(c);
      if (t === "PACKAGE") {
        // PACKAGE labels sometimes carry the operational "where" (e.g., pod / area label),
        // but on some trees they mirror the *container id* (CART_*, etc.). Don't let that
        // overwrite the parent location label.
        const useLbl = (lbl && !looksLikeContainerLabel(lbl)) ? lbl : "";
        next = { lt: (ctx.lt || "PACKAGE"), ll: (useLbl || ctx.ll || "") };
      } else {
        next = { lt: (t || ctx.lt || ""), ll: (lbl || ctx.ll || "") };
      }
    }

    // Some trees store location directly on the container node; prefer it.
    if (isContainer(t)) {
      const id = norm(c.containerId);
      if (id && !seen.has(id)) {
        seen.add(id);

        const kids = Array.isArray(n.childNodes) ? n.childNodes : [];
        const pkgCount = kids.length
          ? (kids.filter(x => up(x?.container?.contType || x?.containerDetails?.contType || "") === "PACKAGE").length || kids.length)
          : 0;

        const ltDirect = pickLocType(c);
        const llDirect = pickLabel(c);

        const lt = norm(ltDirect || next.lt || "");
        const llDirectNorm = norm(llDirect || "");
        const looksLikeContainerLabel = (v) => {
          const u = String(v || "").toUpperCase();
          return (
            u.startsWith("CART") || u.startsWith("PALLET") || u.startsWith("GAYLORD") ||
            u.startsWith("BAG") || u.startsWith("TOTE") || u.startsWith("CAGE")
          );
        };
        const ll = norm((llDirectNorm && (!looksLikeContainerLabel(llDirectNorm) || !next.ll)) ? llDirectNorm : (next.ll || ""));

        out.push({
          id,
          label: norm(c.label || id),
          stackFilter: norm(c.stackFilter || ""),
          pkgCount,
          contType: t,
          outboundLoadGroupId: norm(c.outboundLoadGroupId || ""),
          inboundLoadId: norm(c.inboundLoadId || ""),
          locationType: lt,
          locationLabel: ll,
          bucket: bucketFor(lt, up(ll)),
        });
      }
    }

    (n?.childNodes || []).forEach(k => stack.push({ n: k, ctx: next }));
  }
  return out;
}

function renderContainerBucketsV2(meta) {
  const esc = s => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const rows = Array.isArray(meta) ? meta.slice() : [];
  if (!rows.length) return '<div style="color:#6b7280;">—</div>';


  const byBucket = rows.reduce((a,m) => {
    const b = String(m.bucket || 'Unknown') || 'Unknown';
    (a[b] ||= []).push(m);
    return a;
  }, {});

  const bucketOrder = ['Loaded','Staged','Received','Stacked','Sorter','Unknown']
    .filter(b => (byBucket[b]||[]).length)
    .concat(Object.keys(byBucket).filter(b => !['Loaded','Staged','Received','Stacked','Sorter','Unknown'].includes(b)).sort());

  const colors = {
    Loaded:   '#16a34a',
    Received: '#0ea5e9',
    Staged:   '#2563eb',
    Stacked:  '#6b7280',
    Sorter:   '#9333ea',
    Unknown:  '#9ca3af',
  };

  const total = rows.length;
  const counts = bucketOrder.map(k => ({ k, n: (byBucket[k]||[]).length })).filter(x => x.n > 0);
  const bar = total ? `<div style="margin-top:6px;">
      <div style="display:flex;height:10px;border-radius:999px;overflow:hidden;background:#e5e7eb;" title="${esc(counts.map(x=>`${x.k}:${x.n}`).join(' | '))}">
        ${counts.map(x => {
          const pct = Math.max(0.5, (x.n/total)*100);
          const c = colors[x.k] || colors.Unknown;
          return `<div style="width:${pct}%;background:${c};" title="${esc(x.k)}: ${x.n} (${Math.round((x.n/total)*100)}%)"></div>`;
        }).join('')}
      </div>
      <div style="margin-top:6px;font-size:12px;color:#374151;display:flex;flex-wrap:wrap;gap:10px;">
        ${counts.map(x => {
          const c = colors[x.k] || colors.Unknown;
          return `<span style="display:inline-flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:${c};display:inline-block;"></span>
            <span><b>${esc(x.k)}</b>: ${x.n}</span>
          </span>`;
        }).join('')}
      </div>
    </div>` : '';

  const groupByLoc = (items) => {
    const m = new Map();
    for (const it of items) {
      const k = String(it.locationLabel || '').trim() || 'Unknown';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return Array.from(m.entries()).sort((a,b)=> b[1].length - a[1].length);
  };

  const renderRawList = (items) => {
    if (!items.length) return '—';
    return items
      .slice()
      .sort((a,b)=> String(a.label||'').localeCompare(String(b.label||'')))
      .map(x => `${esc(x.label)}  [${esc(x.locationLabel || '')}]`)
      .join('\n');
  };

  const renderLoaded = (items) => {
    // Group by trailerId-like label (locationLabel on TRAILER context)
    const groups = groupByLoc(items);
    return groups.map(([loc, arr]) => {
      const units = arr.reduce((s,x)=>s+unitsForContainerType(x.contType),0);
      return `<details open style="margin-top:8px;">
        <summary style="cursor:pointer;font-weight:800;">
          ${esc(loc)} — ${arr.length} ctrs • ${fmtUnits(units)} units
        </summary>
        <div style="margin-top:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;">
          ${renderRawList(arr)}
        </div>
      </details>`;
    }).join('');
  };

  const renderStaged = (items) => {
    const groups = groupByLoc(items);
    // Clickable squares via <details> with a styled <summary>
    const cards = groups.map(([loc, arr]) => {
      const units = arr.reduce((s,x)=>s+unitsForContainerType(x.contType),0);
      const cts = arr.length;
      const title = `${loc}\n${cts} ctrs • ${units} units`;
      return `<details class="ssp-cu-card">
        <summary class="ssp-cu-card__summary">
          <div style="min-width:0;">
            <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px;">${esc(loc)}</div>
            <div style="color:#6b7280;font-size:12px;">${cts} ctrs • ${fmtUnits(units)} units</div>
          </div>
          <div style="font-weight:900;color:#2563eb;">View</div>
        </summary>
        <div style="margin-top:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;">
          ${renderRawList(arr)}
        </div>
      </details>`;
    }).join('');

    return `<div class="ssp-cu-grid" style="margin-top:8px;">
      ${cards || '<div style="color:#6b7280;">—</div>'}
    </div>`;
  };

  const sec = (name, items, renderer) => {
    if (!items || !items.length) return '';
    const units = items.reduce((s,x)=>s+unitsForContainerType(x.contType),0);
    const c = colors[name] || '#9ca3af';
    const body = renderer ? renderer(items) : `<div style="margin-top:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;">${renderRawList(items)}</div>`;
    const open = (name === 'Loaded' || name === 'Staged');
    return `<details style="margin-top:10px;" ${open?'open':''}>
      <summary style="cursor:pointer;font-weight:900;display:flex;align-items:center;gap:8px;">
        <span style="width:10px;height:10px;border-radius:3px;background:${c};display:inline-block;"></span>
        <span>${esc(name)}</span>
        <span style="color:#6b7280;font-weight:800;">(${items.length} ctrs • ${fmtUnits(units)} units)</span>
      </summary>
      ${body}
    </details>`;
  };

  const parts = [];
  parts.push(bar);

  // Loaded: grouped by trailer label
  parts.push(sec('Loaded', byBucket.Loaded || [], renderLoaded));

  // Staged: grouped by location label with clickable tiles
  parts.push(sec('Staged', byBucket.Staged || [], renderStaged));

  // Received & Stacked: raw list (leave as raw list per your request)
  parts.push(sec('Received', byBucket.Received || [], null));
  parts.push(sec('Stacked', byBucket.Stacked || [], null));

  // Other buckets raw
  for (const b of bucketOrder) {
    if (['Loaded','Staged','Received','Stacked'].includes(b)) continue;
    parts.push(sec(b, byBucket[b] || [], null));
  }

  return parts.join('');
}

function renderContainerBuckets(meta = {}) {
  if (!meta || typeof meta !== 'object') return '';

  const colors = {
    Loaded: '#22c55e',
    Received: '#3b82f6',
    Staged: '#f59e0b',
    Inbound: '#a855f7',
    Cancelled: '#ef4444',
    Unbucketed: '#9ca3af'
  };

  const renderRawList = (items) =>
    items.map(x => `${x.id || x.containerId || 'Unknown'} (${x.contType || 'UNK'})`).join('\n');

  const section = (name, items = []) => {
    if (!items.length) return '';

    const units = items.reduce((sum, x) => sum + unitsForContainerType(x.contType), 0);
    const color = colors[name] || '#9ca3af';

    return `
      <details style="margin-top:10px;" ${name === 'Loaded' || name === 'Staged' ? 'open' : ''}>
        <summary style="cursor:pointer;font-weight:900;display:flex;align-items:center;gap:8px;">
          <span style="width:10px;height:10px;border-radius:3px;background:${color};display:inline-block;"></span>
          ${name} — ${items.length} containers / ${fmtUnits(units)} units
        </summary>
        <div style="margin-top:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;">
          ${renderRawList(items)}
        </div>
      </details>
    `;
  };

  return `
    ${section('Loaded', meta.loaded)}
    ${section('Received', meta.received)}
    ${section('Staged', meta.staged)}
    ${section('Inbound', meta.inbound)}
    ${section('Cancelled', meta.cancelled)}
    ${section('Unbucketed', meta.unbucketed)}
  `;
}





/* ===== SSP Util v1.6.15: Raw debug capture for Merge Panel pulls ===== */
function __sspSafeStringify(obj, maxLen=30000) {
  let s = "";
  try { s = JSON.stringify(obj, null, 2); }
  catch (e) { s = String(obj); }
  if (s.length > maxLen) s = s.slice(0, maxLen) + "\n…(truncated)…";
  return s;
}
function __sspEnsureDebug() {
  window.__SSP_DEBUG = window.__SSP_DEBUG || {};
  window.__SSP_DEBUG.pull = window.__SSP_DEBUG.pull || {};
  return window.__SSP_DEBUG.pull;
}
function __sspRecordPull(kind, payload, resp, extra) {
  try {
    const store = __sspEnsureDebug();
    store[kind] = {
      ts: Date.now(),
      kind,
      payload,
      respOk: (resp && typeof resp === 'object') ? resp.ok : undefined,
      respMessage: (resp && typeof resp === 'object') ? resp.message : undefined,
      resp: resp,
      extra: extra || null,
    };
  } catch (_) {}
}
function __sspGetPull(kind) {
  try {
    const store = (__sspEnsureDebug() || {});
    return store[kind] || null;
  } catch (_) { return null; }
}
function __sspRenderPullDebug(kind) {
  const d = __sspGetPull(kind);
  if (!d) return '<div style="color:#6b7280;">No raw data captured yet.</div>';
  const when = new Date(d.ts).toLocaleTimeString();
  const esc = (v) => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const payloadTxt = esc(__sspSafeStringify(d.payload));
  const respTxt = esc(__sspSafeStringify(d.resp));
  const extraTxt = d.extra ? esc(__sspSafeStringify(d.extra)) : '';
  return (
    '<details style="margin-top:8px;" open>' +
    '<summary style="cursor:pointer;font-weight:800;">Raw (' + esc(kind) + ') @ ' + esc(when) + '</summary>' +
    '<div style="margin-top:6px;font-size:12px;color:#6b7280;">resp.ok=' + esc(String(d.respOk)) + ' message=' + esc(d.respMessage||'') + '</div>' +
    '<div style="margin-top:8px;font-weight:800;">Payload</div>' +
    '<pre style="white-space:pre-wrap;font-size:11px;">' + payloadTxt + '</pre>' +
    '<div style="margin-top:8px;font-weight:800;">Response</div>' +
    '<pre style="white-space:pre-wrap;font-size:11px;">' + respTxt + '</pre>' +
    (d.extra ? ('<div style="margin-top:8px;font-weight:800;">Extra</div><pre style="white-space:pre-wrap;font-size:11px;">' + extraTxt + '</pre>') : '') +
    '</details>'
  );
}
/* ===== end v1.5.17 ===== */
/* =============================
 * Relay Cases (primary)
 * ============================= */

function _sspRelaySummarizeCase(c) {
  const o = c || {};
  const id = o.caseId || o.id || o.uuid || o.case || o.case_id || '';
  const status = o.status || o.state || o.caseStatus || '';
  const topic = o.topic || o.type || o.category || o.reason || '';
  const msg = o.message || o.summary || o.title || '';
  return {
    id: String(id || '').trim(),
    status: String(status || '').trim(),
    topic: String(topic || '').trim(),
    message: String(msg || '').trim()
  };
}

async function openRelayCasesPanel(laneKey, cptMs) {
  // Uses Relay/Track transport view detail (detail.cases[]). FMC case search is not used.
  try { ensureCasesPanel(); } catch (_) {}
  const overlay = document.getElementById('ssp-cases-overlay');
  const subEl = document.getElementById('ssp-cases-subtitle');
  const body = document.getElementById('ssp-cases-body');
  if (!overlay || !body) return;

  const laneLabel = String(laneKey || '—');
  const cptLabel = cptMs ? fmtTime(Number(cptMs || 0)) : '';
  if (subEl) subEl.textContent = cptLabel ? `${laneLabel} (CPT ${cptLabel})` : laneLabel;

  overlay.style.display = 'flex';
  body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Loading cases from Relay…</div>`;

  // Resolve VRIDs for lane/cpt from the current Action Panel grouping.
  let group = null;
  try { group = _getActionGroup(laneKey, cptMs); } catch (_) { group = null; }
  const vs = (group && group.vrids) ? group.vrids : [];
  const allowedVrids = new Set(getFilteredOutboundVridsForLaneCpt(laneKey, cptMs, { debugKey: "relay-bulk-vrid-open" }));
  const vrids = [];
  for (const v of vs) {
    const id = String(v?.vrid || v?.vrId || '').trim();
    if (id && allowedVrids.has(id)) vrids.push(id);
  }

  if (!vrids.length) {
    body.innerHTML = `<div style="padding:10px;color:#6b7280;">No VRIDs found for this lane/CPT.</div>`;
    return;
  }

  // Fetch details in a controlled fanout.
  const rows = [];
  const max = Math.min(60, vrids.length);
  for (let i = 0; i < max; i++) {
    const vrid = vrids[i];
    let detail = null;
    try { detail = await _sspRelayGetDetail(vrid, { allowFmcFallback: false }); } catch (_) { detail = null; }
    if (!detail) continue;
    let cases = [];
    try { cases = _sspRelayExtractCases(detail) || []; } catch (_) { cases = []; }
    if (!cases.length) continue;
    const summaries = cases.map(_sspRelaySummarizeCase);
    rows.push({ vrid, count: cases.length, cases: summaries });
  }

  if (!rows.length) {
    const rc = STATE.relayConnectivity || {};
    const hint = (String(rc.state || "") === "fallback" || String(rc.state || "") === "no_auth")
      ? `<div style="margin-top:6px;color:#9ca3af;font-size:12px;">Relay Track is not fully available (${esc(String(rc.state||"unknown"))}). Open a VRID in Track and retry.</div>`
      : "";
    body.innerHTML = `<div style="padding:10px;color:#6b7280;">No Relay cases found for this lane/CPT.</div>${hint}`;
    return;
  }

  const renderRow = (r, i) => {
    const zebra = (i % 2) ? 'background:#f9fafb;' : 'background:#fff;';
    const vr = esc(String(r.vrid || ''));
    const relayUrl = (typeof _sspRelayTrackMapUrlForVrid === 'function') ? _sspRelayTrackMapUrlForVrid(vr) : '';
    const vrLink = relayUrl
      ? `<a href="${esc(relayUrl)}" target="_blank" rel="noopener" style="font-weight:900;text-decoration:none;color:#111827;">${vr}</a>`
      : `<span style="font-weight:900;color:#111827;">${vr}</span>`;

    const casesHtml = (r.cases || []).slice(0, 12).map((c) => {
      const id = c.id ? `#${esc(c.id)}` : '';
      const st = c.status ? esc(c.status) : '';
      const tp = c.topic ? esc(c.topic) : '';
      const msg = c.message ? esc(c.message) : '';
      const bits = [id, st, tp].filter(Boolean).join(' • ');
      return `<div style="padding:6px 8px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
        <div style="font-weight:900;">${bits || 'Case'}</div>
        ${msg ? `<div style="color:#6b7280;font-weight:800;font-size:11px;margin-top:2px;">${msg}</div>` : ''}
      </div>`;
    }).join('');

    const more = (r.count > 12) ? `<div style="color:#6b7280;font-weight:800;font-size:11px;margin-top:6px;">+${r.count-12} more…</div>` : '';

    return `<div style="padding:10px;border-radius:12px;${zebra}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div>${vrLink}<div style="color:#6b7280;font-weight:800;font-size:11px;margin-top:2px;">${r.count} case${r.count===1?'':'s'}</div></div>
        <div style="display:flex;gap:8px;align-items:center;">
          <a href="${esc(_sspRelayTrackMapUrlForVrid(vr))}" target="_blank" rel="noopener" style="padding:4px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;font-weight:900;text-decoration:none;color:#111827;">Open in Relay</a>
        </div>
      </div>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">${casesHtml}${more}</div>
    </div>`;
  };

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="font-weight:900;">Relay cases (${rows.length} VRIDs)</div>
      <div style="margin-left:auto;color:#6b7280;font-weight:800;font-size:12px;">(Relay is the source of truth)</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">${rows.map(renderRow).join('')}</div>
  `;
}


/* =============================
 * PATCH v1.6.69 — Relay case details + badge click fix
 * - Clicking C/D/N badges now always works (global capture handler)
 * - Cases: use caseId -> /api/v2/transport-views?module=issue&type[]=case&searchId[]=... to fetch case detail
 * - Correspondence: /api/cases/NA:CASE:<id>/correspondences
 * ============================= */
(function(){
  try {
    // ---------- helpers ----------
    const _esc = (s) => (typeof esc === "function") ? esc(s) : String(s||"").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    const _safeJson = (x) => {
      try { return JSON.stringify(x, null, 2); } catch (e) { return String(x); }
    };

    function _sspRelayQualifiedCaseId(caseObjOrId){
      const o = caseObjOrId;
      if (o && typeof o === "object") {
        const q = o.qualifiedId || o.qualifiedCaseId || o.qualified || "";
        if (q) return String(q);
        const id = o.id || o.caseId || o.caseID || "";
        if (id) return `NA:CASE:${String(id)}`;
      }
      const id = String(o||"").trim();
      if (!id) return "";
      if (id.includes(":")) return id;
      return `NA:CASE:${id}`;
    }

    function _sspRelayExtractCaseIdsFromDetail(detail){
      try {
        const arr = (detail && Array.isArray(detail.cases)) ? detail.cases : [];
        const ids = [];
        for (const c of arr) {
          const q = _sspRelayQualifiedCaseId(c);
          if (q) ids.push(q);
        }
        return Array.from(new Set(ids));
      } catch (_) { return []; }
    }

    async function _sspRelaySearchCasesByIds(qualifiedCaseIds){
      const ids = (qualifiedCaseIds||[]).map(x=>String(x||"").trim()).filter(Boolean);
      if (!ids.length) return [];
      if (typeof _sspRelayRequest !== "function") return [];
      if (typeof _sspGetTrackAuthHeader === "function" && !_sspGetTrackAuthHeader()) throw new Error("NO_TRACK_AUTH");

      // Track endpoint accepts numeric searchId; use numeric portion for searchId[].
      const nums = ids.map(q => {
        const m = String(q).match(/(\d{6,})/);
        return m ? m[1] : "";
      }).filter(Boolean);

      if (!nums.length) return [];

      const qs = nums.map(n => `searchId[]=${encodeURIComponent(n)}`).join("&");
      const url = `https://track.relay.amazon.dev/api/v2/transport-views?${qs}&module=issue&type[]=case&view=detail&sortCol=sent&ascending=true`;
      const txt = await _sspRelayRequest(url, 12000);
      let js = null;
      try { js = JSON.parse(txt); } catch (_) { js = null; }
      // Response is typically an array of { vrid, case: {...}, module:'issue', ... }
      if (Array.isArray(js)) return js;
      if (js && Array.isArray(js.items)) return js.items;
      return [];
    }

    async function _sspRelayGetCaseCorrespondences(qualifiedCaseId){
      const qid = _sspRelayQualifiedCaseId(qualifiedCaseId);
      if (!qid) return [];
      const url = `https://track.relay.amazon.dev/api/cases/${encodeURIComponent(qid)}/correspondences`;
      const txt = await _sspRelayRequest(url, 12000);
      let js = null;
      try { js = JSON.parse(txt); } catch (_) { js = null; }
      return Array.isArray(js) ? js : (js && Array.isArray(js.items) ? js.items : []);
    }

    // ---------- overlay render ----------
    async function _sspOpenCasesOverlayForVrid(vrid){
      const v = String(vrid||"").trim();
      if (!v) return;
      const host = (typeof _sspEnsureRelayVridOverlay === "function") ? _sspEnsureRelayVridOverlay() : null;
      if (!host) {
        if (typeof _sspWarnRelayOverlayMissingOnce === "function") {
          _sspWarnRelayOverlayMissingOnce("cases-open", ["#ssp-relay-vrid-overlay", "#ssp-relay-vrid-title", "#ssp-relay-vrid-body"]);
        }
        return;
      }
      const overlay = host.overlay;
      const titleEl = host.title;
      const body = host.body;

      overlay.style.display = "flex";
      if (titleEl) titleEl.textContent = `Cases — ${v}`;
      body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Loading case details…</div>`;

      let detail = null;
      try { detail = (typeof _sspRelayGetDetail === "function") ? await _sspRelayGetDetail(v, { allowFmcFallback: false }) : null; } catch (_) { detail = null; }
      if (!detail) {
        body.innerHTML = `<div style="padding:10px;color:#6b7280;">Unable to load Relay detail for ${_esc(v)}.</div>`;
        return;
      }

      const caseIds = _sspRelayExtractCaseIdsFromDetail(detail);
      if (!caseIds.length) {
        body.innerHTML = `<div style="padding:10px;color:#6b7280;">No cases on this VRID.</div>`;
        return;
      }

      // Fetch case detail (issue module) and render a compact list. Correspondence loads on expand.
      let caseItems = [];
      try { caseItems = await _sspRelaySearchCasesByIds(caseIds); } catch (_) { caseItems = []; }

      // Map by numeric id for easy join
      const mapByNum = new Map();
      for (const it of (caseItems||[])) {
        const c = it && (it.case || it.caze || it.issue || it);
        const q = _sspRelayQualifiedCaseId(c);
        const m = String(q).match(/(\d{6,})/);
        const num = m ? m[1] : "";
        if (num) mapByNum.set(num, { it, caseObj: c, qid: q });
      }

      const rows = [];
      for (const qid of caseIds) {
        const m = String(qid).match(/(\d{6,})/);
        const num = m ? m[1] : "";
        const hit = num ? mapByNum.get(num) : null;
        const c = hit ? hit.caseObj : { qualifiedId: qid };
        const status = c?.status || c?.state || c?.caseStatus || "";
        const sev = c?.severity ?? c?.priority ?? "";
        const subject = c?.subject || c?.title || c?.summary || "";
        const queue = c?.queue || c?.queueName || "";
        rows.push({ qid, num, status, sev, subject, queue, raw: c });
      }

      const render = rows.map((r, idx) => {
        const zebra = (idx%2) ? "background:#0b1020;" : "background:#0a0f1d;";
        const header = `
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-weight:900;">${_esc(r.num || r.qid)}</div>
            ${r.status?`<span style="padding:1px 8px;border:1px solid #374151;border-radius:999px;font-weight:900;">${_esc(r.status)}</span>`:""}
            ${String(r.sev)!==""?`<span style="padding:1px 8px;border:1px solid #374151;border-radius:999px;font-weight:900;">sev:${_esc(String(r.sev))}</span>`:""}
            ${r.queue?`<span style="padding:1px 8px;border:1px solid #374151;border-radius:999px;font-weight:900;">${_esc(r.queue)}</span>`:""}
            <span style="margin-left:auto;display:flex;gap:8px;">
              <button class="ssp-case-open" data-qid="${_esc(r.qid)}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #374151;background:#111827;color:#fff;font-weight:900;">Open</button>
              <button class="ssp-case-raw" data-qid="${_esc(r.qid)}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #374151;background:#0b1020;color:#e5e7eb;font-weight:900;">Raw</button>
            </span>
          </div>`;
        const subj = r.subject ? `<div style="margin-top:6px;color:#e5e7eb;font-weight:900;">${_esc(r.subject)}</div>` : "";
        return `
          <div style="border:1px solid #1f2937;border-radius:14px;padding:10px;${zebra}">
            ${header}
            ${subj}
            <div class="ssp-case-correspondence" data-qid="${_esc(r.qid)}" style="display:none;margin-top:10px;border-top:1px solid #1f2937;padding-top:10px;">
              <div style="color:#9ca3af;font-weight:800;">Loading correspondence…</div>
            </div>
            <div class="ssp-case-rawbox" data-qid="${_esc(r.qid)}" style="display:none;margin-top:10px;">
              <pre style="white-space:pre-wrap;font-size:11px;max-height:280px;overflow:auto;background:#000;border:1px solid #1f2937;color:#e5e7eb;padding:10px;border-radius:12px;margin:0;">${_esc(_safeJson(r.raw))}</pre>
            </div>
          </div>
        `;
      }).join("");

      body.innerHTML = `
        <div style="padding:10px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <div style="font-weight:900;color:#e5e7eb;">${rows.length} case${rows.length===1?"":"s"}</div>
            <div style="margin-left:auto;color:#9ca3af;font-weight:800;font-size:12px;">(Relay: issue→case + correspondences)</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">${render}</div>
        </div>
      `;

      body.querySelectorAll("button.ssp-case-open").forEach(btn=>{
        btn.addEventListener("click", async (e)=>{
          e.preventDefault(); e.stopPropagation();
          const qid = btn.getAttribute("data-qid") || "";
          const box = body.querySelector(`.ssp-case-correspondence[data-qid="${CSS.escape(qid)}"]`);
          if (!box) return;
          const open = (box.style.display === "none");
          box.style.display = open ? "block" : "none";
          if (!open) return;
          // Load once
          if (box.getAttribute("data-loaded")==="1") return;
          box.setAttribute("data-loaded","1");
          let items = [];
          try { items = await _sspRelayGetCaseCorrespondences(qid); } catch (err) { items = []; }
          if (!items.length) {
            box.innerHTML = `<div style="color:#9ca3af;font-weight:800;">No correspondence found.</div>`;
            return;
          }
          const msgs = items.map((m)=>{
            const from = m?.fromAddress || m?.from || m?.sender || "";
            const created = m?.createdAt || m?.sentAt || m?.time || "";
            const desc = m?.description || m?.body || m?.text || "";
            const head = `<div style="display:flex;gap:10px;align-items:center;">
              <div style="font-weight:900;color:#e5e7eb;">${_esc(from||"")}</div>
              <div style="margin-left:auto;color:#9ca3af;font-weight:800;font-size:12px;">${_esc(created||"")}</div>
            </div>`;
            const bodyTxt = `<div style="margin-top:6px;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#e5e7eb;">${_esc(desc||"")}</div>`;
            return `<div style="padding:10px;border:1px solid #1f2937;border-radius:12px;background:#000;margin-top:8px;">${head}${bodyTxt}</div>`;
          }).join("");
          box.innerHTML = msgs;
        });
      });

      body.querySelectorAll("button.ssp-case-raw").forEach(btn=>{
        btn.addEventListener("click", (e)=>{
          e.preventDefault(); e.stopPropagation();
          const qid = btn.getAttribute("data-qid") || "";
          const raw = body.querySelector(`.ssp-case-rawbox[data-qid="${CSS.escape(qid)}"]`);
          if (!raw) return;
          raw.style.display = (raw.style.display==="none") ? "block" : "none";
        });
      });
    }

    // Override the overlay opener for badges
    if (window.__SSP_OPEN_RELAY_OVERLAY && !window.__SSP_OPEN_RELAY_OVERLAY_ORIG) window.__SSP_OPEN_RELAY_OVERLAY_ORIG = window.__SSP_OPEN_RELAY_OVERLAY;
    window.__SSP_OPEN_RELAY_OVERLAY = async function(vrid, kind){
      const k = String(kind||"").toLowerCase();
      if (k === "cases") return _sspOpenCasesOverlayForVrid(vrid);
      // fall back to existing implementation if present
      if (typeof window.__SSP_OPEN_RELAY_OVERLAY_ORIG === "function") return window.__SSP_OPEN_RELAY_OVERLAY_ORIG(vrid, kind);
      try {
        // Basic JSON fallback for disruptions/notes/detail on vrid overlay host nodes.
        const host = (typeof _sspEnsureRelayVridOverlay === "function") ? _sspEnsureRelayVridOverlay() : null;
        if (!host) {
          if (typeof _sspWarnRelayOverlayMissingOnce === "function") {
            _sspWarnRelayOverlayMissingOnce("overlay-fallback", ["#ssp-relay-vrid-overlay", "#ssp-relay-vrid-title", "#ssp-relay-vrid-body"]);
          }
          return;
        }
        const overlay = host.overlay;
        const titleEl = host.title;
        const body = host.body;
        overlay.style.display = "flex";
        if (titleEl) titleEl.textContent = `${String(kind||"detail")} — ${String(vrid||"")}`;
        let payload = null;
        if (k === "notes" && typeof _sspRelayGetNotes === "function") payload = await _sspRelayGetNotes(vrid);
        else if (typeof _sspRelayGetDetail === "function") payload = await _sspRelayGetDetail(vrid);
        body.innerHTML = `<div style="padding:10px;">${(typeof renderJson==="function") ? renderJson(payload) : `<pre>${_esc(_safeJson(payload))}</pre>`}</div>`;
      } catch (e) {}
    };

    // Preserve original if not already preserved
    if (!window.__SSP_OPEN_RELAY_OVERLAY_ORIG && window.__SSP_OPEN_RELAY_OVERLAY && window.__SSP_OPEN_RELAY_OVERLAY !== window.__SSP_OPEN_RELAY_OVERLAY_ORIG) {
      // (noop; set below only once)
    }
  } catch (_) {}
})();

/* PATCH 1.6.70 — lane cases panel uses Relay issue APIs */
(function(){
  try {
    const _esc = (s)=> (typeof esc==='function') ? esc(s) : String(s||'').replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    const pad = (n)=> String(n).padStart(2,'0');
    const dateStr = (d)=> `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const timeStr = (d)=> `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const laneBase = (laneKey)=>{
      const s = String(laneKey||'').trim();
      const parts = s.split('->');
      if (parts.length<2) return s;
      const o = parts[0].trim();
      const rest = parts.slice(1).join('->').trim();
      const d = rest.split('-')[0].trim();
      return (o && d) ? `${o}->${d}` : s;
    };
    const relayJson = async (url, timeoutMs = 12000) => {
      const txt = await _sspRelayRequest(url, timeoutMs);
      try { return JSON.parse(txt || "null"); } catch (_) { return null; }
    };

    async function searchLaneViews(laneKey, cptMs){
      const lane = laneBase(laneKey);
      const cpt = Number(cptMs||0) || Date.now();
      const start = new Date(cpt - 12*60*60*1000);
      const end = new Date(cpt + 6*60*60*1000);
      const qs = new URLSearchParams();
      qs.append('module','trip');
      qs.append('page','1');
      qs.append('pageSize','200');
      qs.append('sortCol','sent');
      qs.append('ascending','true');
      qs.append('column','scheduled_end');
      qs.append('view','detail');
      qs.append('dateField','effectiveEnd');
      qs.append('searchTerm[]', lane);
      qs.append('type[]','vehicleRun');
      qs.append('startDate', dateStr(start));
      qs.append('endDate', dateStr(end));
      qs.append('startTime', timeStr(start));
      qs.append('endTime', timeStr(end));
      const url = `https://track.relay.amazon.dev/api/v2/transport-views?${qs.toString()}`;
      if (typeof _sspRelayRequest!=='function') throw new Error('relay req not ready');
      const res = await relayJson(url);
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.items)) return res.items;
      if (res && Array.isArray(res.results)) return res.results;
      return [];
    }

    const vridFromRow = (r)=> String((r&& (r.vrid||r.vrId||r.vehicleRunId||r.id||r.vr))||'').trim();
    const extractCaseStubs = (o)=>{
      const obj = o||{};
      const xs = Array.isArray(obj.cases) ? obj.cases : (obj.case ? [obj.case] : []);
      return xs.map((c)=>{
        const cc=c||{};
        const id = (cc.id||cc.caseId||cc.case||cc.case_id||'').toString().replace(/^NA:CASE:/,'');
        const qid = (cc.qualifiedId||`NA:CASE:${id}`);
        return { caseId:id, qualifiedId:qid, raw:cc };
      }).filter(x=>x.caseId);
    };

    async function fetchIssueCase(caseId){
      const id = String(caseId||'').replace(/^NA:CASE:/,'').trim();
      if (!id) return null;
      const qs = new URLSearchParams();
      qs.append('searchId[]', id);
      qs.append('module','issue');
      qs.append('type[]','case');
      qs.append('view','detail');
      qs.append('sortCol','sent');
      qs.append('ascending','true');
      const url = `https://track.relay.amazon.dev/api/v2/transport-views?${qs.toString()}`;
      const res = await relayJson(url);
      if (Array.isArray(res)) return res[0]||null;
      if (res && Array.isArray(res.items)) return res.items[0]||null;
      if (res && Array.isArray(res.results)) return res.results[0]||null;
      return null;
    }

    async function fetchCorr(caseId){
      const id = String(caseId||'').replace(/^NA:CASE:/,'').trim();
      if (!id) return [];
      const url = `https://track.relay.amazon.dev/api/cases/NA:CASE:${id}/correspondences`;
      let res=null; try{ res=await relayJson(url); }catch(_){ res=null; }
      return Array.isArray(res) ? res : (res && Array.isArray(res.items) ? res.items : []);
    }

    const sumIssue = (ir)=>{
      const r=ir||{};
      const c=r.case||{};
      const id = String((c.id||c.caseId||r.id||'')).replace(/^NA:CASE:/,'');
      return {
        id,
        status: c.status||r.status||'',
        severity: (c.severity!==undefined?c.severity:''),
        queue: c.queue||'',
        subject: c.subject||c.title||c.summary||'',
        raw: ir
      };
    };

    async function mapLimit(items, limit, fn){
      const out=new Array(items.length);
      let idx=0;
      const workers=new Array(Math.min(limit, items.length)).fill(0).map(async ()=>{
        while(idx<items.length){
          const i=idx++;
          try{ out[i]=await fn(items[i],i); }catch(_){ out[i]=null; }
        }
      });
      await Promise.all(workers);
      return out;
    }

    // Override lane cases panel entrypoint
    window.openRelayCasesPanel = async function(laneKey, cptMs){
      try{ if (typeof ensureCasesPanel==='function') ensureCasesPanel(); }catch(_){ }
      const overlay=document.getElementById('ssp-cases-overlay');
      const subEl=document.getElementById('ssp-cases-subtitle');
      const body=document.getElementById('ssp-cases-body');
      if (!overlay||!body) return;
      const laneLabel=String(laneKey||'—');
      const cptLabel=cptMs?(typeof fmtTime==='function'?fmtTime(Number(cptMs||0)):''):'';
      if (subEl) subEl.textContent = cptLabel ? `${laneLabel} (CPT ${cptLabel})` : laneLabel;
      overlay.style.display='flex';
      body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Loading lane cases from Relay…</div>`;

      // Search lane VRIDs (Relay)
      let rows=[]; try{ rows = await searchLaneViews(laneKey, cptMs); }catch(_){ rows=[]; }

      const vridToCaseIds = new Map();
      for (const r of rows){
        const vrid = vridFromRow(r);
        if (!vrid) continue;
        const stubs = extractCaseStubs(r);
        if (!stubs.length) continue;
        const cur = vridToCaseIds.get(vrid) || [];
        stubs.forEach(s=> cur.push(String(s.caseId)));
        vridToCaseIds.set(vrid, cur);
      }

      // Fallback: if search didn't include case stubs, use current Action Panel VRIDs and VRID detail.cases[]
      if (vridToCaseIds.size===0 && typeof _getActionGroup==='function' && typeof _sspRelayGetDetail==='function'){
        let group=null; try{ group=_getActionGroup(laneKey, cptMs); }catch(_){ group=null; }
        const vs=(group&&group.vrids)?group.vrids:[];
        const vrids=vs.map(v=>String(v?.vrid||v?.vrId||'').trim()).filter(Boolean).slice(0,80);
        await mapLimit(vrids, 6, async (vrid)=>{
          const d=await _sspRelayGetDetail(vrid, { allowFmcFallback: false });
          const stubs=extractCaseStubs(d);
          if (!stubs.length) return;
          vridToCaseIds.set(vrid, stubs.map(s=>String(s.caseId)));
        });
      }

      const vrids=Array.from(vridToCaseIds.keys());
      if (!vrids.length){
        body.innerHTML = `<div style="padding:10px;color:#6b7280;">No cases found for this lane.</div>`;
        return;
      }

      const uniq=[]; const seen=new Set();
      for (const ids of vridToCaseIds.values()){
        (ids||[]).forEach((x)=>{ const id=String(x||'').replace(/^NA:CASE:/,'').trim(); if(!id||seen.has(id)) return; seen.add(id); uniq.push(id); });
      }

      body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Fetching ${uniq.length} case(s)…</div>`;

      const issueRows = await mapLimit(uniq, 6, fetchIssueCase);
      const byId = new Map();
      issueRows.forEach((ir)=>{ if(!ir) return; const s=sumIssue(ir); if(s.id) byId.set(String(s.id), s); });

      const vrSection = (vrid)=>{
        const ids = Array.from(new Set((vridToCaseIds.get(vrid)||[]).map(x=>String(x||'').replace(/^NA:CASE:/,'').trim()).filter(Boolean)));
        const relayUrl = (typeof _sspRelayTrackMapUrlForVrid==='function') ? _sspRelayTrackMapUrlForVrid(vrid) : '';
        const head = `<div style="display:flex;align-items:center;gap:10px;">
          ${relayUrl ? `<a href="${_esc(relayUrl)}" target="_blank" rel="noopener" style="font-weight:900;text-decoration:none;color:#e5e7eb;">${_esc(vrid)}</a>` : `<div style="font-weight:900;color:#e5e7eb;">${_esc(vrid)}</div>`}
          <div style="margin-left:auto;color:#9ca3af;font-weight:800;">${ids.length} case${ids.length===1?'':'s'}</div>
        </div>`;
        const cards = ids.map((cid)=>{
          const c = byId.get(String(cid)) || {};
          const status = c.status ? _esc(c.status) : '';
          const queue = c.queue ? _esc(c.queue) : '';
          const subject = c.subject ? _esc(c.subject) : '';
          const sev = (c.severity!==undefined && c.severity!==null && String(c.severity)!=='') ? _esc(String(c.severity)) : '';
          const top = [status, queue].filter(Boolean).join(' • ');
          return `<div style="padding:10px;border:1px solid #1f2937;border-radius:12px;background:#000;">
            <div style="display:flex;gap:10px;align-items:center;">
              <div style="font-weight:900;color:#e5e7eb;">#${_esc(cid)}</div>
              ${sev?`<div style="padding:2px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:900;font-size:11px;">sev ${sev}</div>`:''}
              <div style="margin-left:auto;display:flex;gap:8px;">
                <button class="ssp-case-thread-btn" data-cid="${_esc(cid)}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:900;">Thread</button>
                <button class="ssp-case-raw-btn" data-cid="${_esc(cid)}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:900;">Raw</button>
              </div>
            </div>
            ${top?`<div style="margin-top:6px;color:#e5e7eb;font-weight:800;font-size:12px;">${top}</div>`:''}
            ${subject?`<div style="margin-top:4px;color:#9ca3af;font-weight:800;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:900px;">${subject}</div>`:''}
            <div class="ssp-case-thread" data-cid="${_esc(cid)}" data-loaded="0" style="display:none;margin-top:10px;"></div>
            <div class="ssp-case-raw" data-cid="${_esc(cid)}" style="display:none;margin-top:10px;">
              <pre style="margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;max-height:260px;overflow:auto;background:#0b1020;color:#e5e7eb;padding:10px;border-radius:12px;">${_esc(JSON.stringify((c.raw)||{}, null, 2))}</pre>
            </div>
          </div>`;
        }).join('');
        return `<div style="padding:12px;border:1px solid #1f2937;border-radius:14px;background:#000;margin-top:10px;">${head}<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">${cards}</div></div>`;
      };

      body.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="font-weight:900;">Lane Cases (Relay)</div>
        <div style="margin-left:auto;color:#9ca3af;font-weight:800;font-size:12px;">${_esc(laneBase(laneKey))} • ${vrids.length} VRIDs</div>
      </div>
      <div style="max-height:70vh;overflow:auto;padding-right:6px;">${vrids.slice(0,120).map(vrSection).join('')}</div>`;

      body.querySelectorAll('button.ssp-case-raw-btn').forEach((btn)=>{
        btn.addEventListener('click',(e)=>{
          e.preventDefault(); e.stopPropagation();
          const cid=btn.getAttribute('data-cid')||'';
          const box=body.querySelector(`.ssp-case-raw[data-cid="${CSS.escape(cid)}"]`);
          if (!box) return;
          box.style.display = (box.style.display==='none') ? 'block' : 'none';
        });
      });

      body.querySelectorAll('button.ssp-case-thread-btn').forEach((btn)=>{
        btn.addEventListener('click',async (e)=>{
          e.preventDefault(); e.stopPropagation();
          const cid=btn.getAttribute('data-cid')||'';
          const box=body.querySelector(`.ssp-case-thread[data-cid="${CSS.escape(cid)}"]`);
          if (!box) return;
          const open = (box.style.display==='none');
          box.style.display = open ? 'block' : 'none';
          if (!open) return;
          if (box.getAttribute('data-loaded')==='1') return;
          box.setAttribute('data-loaded','1');
          box.innerHTML = `<div style="color:#9ca3af;font-weight:800;">Loading correspondence…</div>`;
          const msgs = await fetchCorr(cid);
          if (!msgs.length){ box.innerHTML = `<div style="color:#9ca3af;font-weight:800;">No correspondence found.</div>`; return; }
          box.innerHTML = msgs.map((m)=>{
            const from=m?.fromAddress||m?.from||m?.sender||'';
            const created=m?.createdAt||m?.sentAt||m?.time||'';
            const desc=m?.description||m?.body||m?.text||'';
            return `<div style="padding:10px;border:1px solid #1f2937;border-radius:12px;background:#0b1020;margin-top:8px;">
              <div style="display:flex;gap:10px;align-items:center;">
                <div style="font-weight:900;color:#e5e7eb;">${_esc(from)}</div>
                <div style="margin-left:auto;color:#9ca3af;font-weight:800;font-size:12px;">${_esc(created)}</div>
              </div>
              <div style="margin-top:6px;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#e5e7eb;">${_esc(desc)}</div>
            </div>`;
          }).join('');
        });
      });
    };

    // Final override: render lane cases as a sortable kanban board.
	    window.openRelayCasesPanel = async function(laneKey, cptMs){
	      try { if (typeof ensureCasesPanel === "function") ensureCasesPanel(); } catch (_) {}
	      const overlay = document.getElementById("ssp-cases-overlay");
	      const subEl = document.getElementById("ssp-cases-subtitle");
	      const body = document.getElementById("ssp-cases-body");
      if (!overlay || !body) return;

	      const laneLabel = String(laneKey || "-");
	      const cptLabel = cptMs ? (typeof fmtTime === "function" ? fmtTime(Number(cptMs || 0)) : "") : "";
	      if (subEl) subEl.textContent = cptLabel ? `${laneLabel} (CPT ${cptLabel})` : laneLabel;
	      overlay.style.display = "flex";
	      body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Loading lane cases from Relay...</div>`;
	      const showRelayUnavailable = (err) => {
	        try { STATE.__relayPanelLastError = String((err && err.message) || err || ""); } catch (_) {}
	        body.innerHTML = _sspRelayPanelUnavailableHtml(err, "Cases");
	      };
	      if (typeof _sspGetTrackAuthHeader === "function" && !_sspGetTrackAuthHeader()) {
	        showRelayUnavailable(new Error("NO_TRACK_AUTH"));
	        return;
	      }

	      let rows = [];
	      let rowsErr = null;
	      try { rows = await searchLaneViews(laneKey, cptMs); } catch (e) { rows = []; rowsErr = e; }

      const laneFallback = laneBase(laneKey) || String(laneKey || "").trim() || "Unknown";
      const vridToCaseIds = new Map();
      const caseIdToVrids = new Map();
      const vridToLane = new Map();

      const laneFromRow = (r) => {
        const lane = String(
          r?.lane ||
          r?.laneKey ||
          r?.route ||
          r?.laneRoute ||
          (Array.isArray(r?.lanes) && r.lanes.length ? r.lanes[r.lanes.length - 1] : "") ||
          ""
        ).trim();
        return lane || laneFallback;
      };

      const registerCase = (vrid, caseId, laneLabelValue) => {
        const v = String(vrid || "").trim();
        const id = String(caseId || "").replace(/^NA:CASE:/, "").trim();
        if (!v || !id) return;

        if (!vridToCaseIds.has(v)) vridToCaseIds.set(v, []);
        const ids = vridToCaseIds.get(v);
        if (!ids.includes(id)) ids.push(id);

        if (!caseIdToVrids.has(id)) caseIdToVrids.set(id, []);
        const list = caseIdToVrids.get(id);
        if (!list.includes(v)) list.push(v);

        if (!vridToLane.has(v)) vridToLane.set(v, String(laneLabelValue || laneFallback || "Unknown").trim() || "Unknown");
      };

      for (const r of rows) {
        const vrid = vridFromRow(r);
        if (!vrid) continue;
        const stubs = extractCaseStubs(r);
        if (!stubs.length) continue;
        const lane = laneFromRow(r);
        stubs.forEach((s) => registerCase(vrid, s.caseId, lane));
      }

	      let detailErr = null;
	      if (caseIdToVrids.size === 0 && typeof _getActionGroup === "function" && typeof _sspRelayGetDetail === "function") {
	        let group = null;
	        try { group = _getActionGroup(laneKey, cptMs); } catch (_) { group = null; }
	        const vrids = ((group && group.vrids) ? group.vrids : [])
	          .map(v => String(v?.vrid || v?.vrId || "").trim())
	          .filter(Boolean)
	          .slice(0, 80);
	        await mapLimit(vrids, 6, async (vrid) => {
	          if (!vridToLane.has(vrid)) vridToLane.set(vrid, laneFallback);
	          let d = null;
	          try {
	            d = await _sspRelayGetDetail(vrid, { allowFmcFallback: false });
	          } catch (e) {
	            if (!detailErr) detailErr = e;
	            return;
	          }
	          const stubs = extractCaseStubs(d);
	          if (!stubs.length) return;
	          stubs.forEach((s) => registerCase(vrid, s.caseId, laneFallback));
	        });
	      }
	      if (caseIdToVrids.size === 0 && (rowsErr || detailErr)) {
	        showRelayUnavailable(detailErr || rowsErr);
	        return;
	      }

	      const vrids = Array.from(vridToCaseIds.keys());
	      if (!vrids.length) {
	        if (rowsErr || detailErr) {
	          showRelayUnavailable(detailErr || rowsErr);
	        } else {
	          body.innerHTML = `<div style="padding:10px;color:#6b7280;">No cases found for this lane.</div>`;
	        }
	        return;
	      }

      const uniq = Array.from(caseIdToVrids.keys());
      body.innerHTML = `<div style="padding:10px;color:#6b7280;font-weight:800;">Fetching ${uniq.length} case(s)...</div>`;

      const issueRows = await mapLimit(uniq, 6, fetchIssueCase);
      const byId = new Map();
      issueRows.forEach((ir) => { if (!ir) return; const s = sumIssue(ir); if (s.id) byId.set(String(s.id), s); });

      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const sortChoices = [
        { id: "status_type_lane", label: "Status -> Type -> Lane", keys: ["status", "type", "lane"] },
        { id: "type_status_lane", label: "Type -> Status -> Lane", keys: ["type", "status", "lane"] },
        { id: "lane_type_status", label: "Lane -> Type -> Status", keys: ["lane", "type", "status"] },
      ];
      const sortById = new Map(sortChoices.map((x) => [x.id, x]));
      if (!sortById.has(STATE.__relayCasesSortOrder)) STATE.__relayCasesSortOrder = "status_type_lane";

      const pickType = (summary) => {
        const raw = summary?.raw || {};
        const c = raw?.case || raw?.issue || raw || {};
        return String(c?.type || c?.caseType || c?.topic || c?.category || c?.reason || c?.topicKey || summary?.queue || "").trim() || "Unknown";
      };
      const norm = (v, fallback = "Unknown") => {
        const s = String(v || "").trim();
        return s || fallback;
      };
      const readKey = (item, key) => {
        if (key === "status") return norm(item.status);
        if (key === "type") return norm(item.type);
        return norm(item.lane);
      };

      const caseItems = uniq.map((cid) => {
        const c = byId.get(String(cid)) || {};
        const vrList = Array.from(new Set((caseIdToVrids.get(String(cid)) || []).map((v) => String(v || "").trim()).filter(Boolean)));
        vrList.sort((a, b) => collator.compare(a, b));
        const laneList = Array.from(new Set(vrList.map((v) => String(vridToLane.get(v) || laneFallback || "Unknown").trim()).filter(Boolean)));
        laneList.sort((a, b) => collator.compare(a, b));
        return {
          caseId: String(cid || "").trim(),
          status: norm(c.status),
          type: norm(pickType(c)),
          lane: norm(laneList[0] || laneFallback),
          lanes: laneList,
          subject: String(c.subject || "").trim(),
          severity: (c.severity !== undefined && c.severity !== null && String(c.severity) !== "") ? String(c.severity) : "",
          vrids: vrList,
          raw: c.raw || {},
        };
      }).filter((x) => x.caseId);

      const renderCaseCard = (item, tertiaryKey) => {
        const lanePills = (item.lanes || []).slice(0, 3).map((ln) =>
          `<span style="padding:1px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:800;font-size:11px;">${_esc(ln)}</span>`
        ).join("");
        const laneMore = (item.lanes || []).length > 3
          ? `<span style="padding:1px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#9ca3af;font-weight:800;font-size:11px;">+${(item.lanes || []).length - 3}</span>`
          : "";
        const vridLinks = (item.vrids || []).slice(0, 3).map((vrid) => {
          const relayUrl = (typeof _sspRelayTrackMapUrlForVrid === "function") ? _sspRelayTrackMapUrlForVrid(vrid) : "";
          return relayUrl
            ? `<a href="${_esc(relayUrl)}" target="_blank" rel="noopener" style="padding:1px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:800;font-size:11px;text-decoration:none;">${_esc(vrid)}</a>`
            : `<span style="padding:1px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:800;font-size:11px;">${_esc(vrid)}</span>`;
        }).join("");
        const vridMore = (item.vrids || []).length > 3
          ? `<span style="padding:1px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#9ca3af;font-weight:800;font-size:11px;">+${(item.vrids || []).length - 3}</span>`
          : "";
        const top = [item.status, item.type].filter(Boolean).join(" | ");
        const tertiaryValue = _esc(readKey(item, tertiaryKey));
        return `<div style="padding:10px;border:1px solid #1f2937;border-radius:12px;background:#000;">
          <div style="display:flex;gap:8px;align-items:center;">
            <div style="font-weight:900;color:#e5e7eb;">#${_esc(item.caseId)}</div>
            ${item.severity ? `<div style="padding:2px 8px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:900;font-size:11px;">sev ${_esc(item.severity)}</div>` : ""}
            <div style="margin-left:auto;display:flex;gap:8px;">
              <button class="ssp-case-thread-btn" data-cid="${_esc(item.caseId)}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:900;">Thread</button>
              <button class="ssp-case-raw-btn" data-cid="${_esc(item.caseId)}" style="cursor:pointer;padding:4px 10px;border-radius:999px;border:1px solid #374151;background:#111827;color:#e5e7eb;font-weight:900;">Raw</button>
            </div>
          </div>
          ${top ? `<div style="margin-top:6px;color:#e5e7eb;font-weight:800;font-size:12px;">${_esc(top)}</div>` : ""}
          ${item.subject ? `<div style="margin-top:4px;color:#9ca3af;font-weight:800;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(item.subject)}</div>` : ""}
          <div style="margin-top:6px;color:#9ca3af;font-weight:800;font-size:11px;">${_esc(tertiaryKey.toUpperCase())}: ${tertiaryValue}</div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${lanePills}${laneMore}</div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${vridLinks}${vridMore}</div>
          <div class="ssp-case-thread" data-cid="${_esc(item.caseId)}" data-loaded="0" style="display:none;margin-top:10px;"></div>
          <div class="ssp-case-raw" data-cid="${_esc(item.caseId)}" style="display:none;margin-top:10px;">
            <pre style="margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;max-height:260px;overflow:auto;background:#0b1020;color:#e5e7eb;padding:10px;border-radius:12px;">${_esc(JSON.stringify(item.raw || {}, null, 2))}</pre>
          </div>
        </div>`;
      };

      const wireCaseButtons = () => {
        body.querySelectorAll("button.ssp-case-raw-btn").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const cid = btn.getAttribute("data-cid") || "";
            const box = body.querySelector(`.ssp-case-raw[data-cid="${CSS.escape(cid)}"]`);
            if (!box) return;
            box.style.display = (box.style.display === "none") ? "block" : "none";
          });
        });

        body.querySelectorAll("button.ssp-case-thread-btn").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const cid = btn.getAttribute("data-cid") || "";
            const box = body.querySelector(`.ssp-case-thread[data-cid="${CSS.escape(cid)}"]`);
            if (!box) return;
            const open = (box.style.display === "none");
            box.style.display = open ? "block" : "none";
            if (!open) return;
            if (box.getAttribute("data-loaded") === "1") return;
            box.setAttribute("data-loaded", "1");
            box.innerHTML = `<div style="color:#9ca3af;font-weight:800;">Loading correspondence...</div>`;
            const msgs = await fetchCorr(cid);
            if (!msgs.length) { box.innerHTML = `<div style="color:#9ca3af;font-weight:800;">No correspondence found.</div>`; return; }
            box.innerHTML = msgs.map((m) => {
              const from = m?.fromAddress || m?.from || m?.sender || "";
              const created = m?.createdAt || m?.sentAt || m?.time || "";
              const desc = m?.description || m?.body || m?.text || "";
              return `<div style="padding:10px;border:1px solid #1f2937;border-radius:12px;background:#0b1020;margin-top:8px;">
                <div style="display:flex;gap:10px;align-items:center;">
                  <div style="font-weight:900;color:#e5e7eb;">${_esc(from)}</div>
                  <div style="margin-left:auto;color:#9ca3af;font-weight:800;font-size:12px;">${_esc(created)}</div>
                </div>
                <div style="margin-top:6px;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#e5e7eb;">${_esc(desc)}</div>
              </div>`;
            }).join("");
          });
        });
      };

      const renderBoard = () => {
        const active = sortById.get(STATE.__relayCasesSortOrder) || sortChoices[0];
        const firstKey = active.keys[0];
        const secondKey = active.keys[1];
        const thirdKey = active.keys[2];

        const firstGroups = new Map();
        for (const item of caseItems) {
          const k = readKey(item, firstKey);
          if (!firstGroups.has(k)) firstGroups.set(k, []);
          firstGroups.get(k).push(item);
        }
        const firstVals = Array.from(firstGroups.keys()).sort((a, b) => collator.compare(a, b));

        const columnsHtml = firstVals.map((firstVal) => {
          const items = firstGroups.get(firstVal) || [];
          const secondGroups = new Map();
          for (const item of items) {
            const k = readKey(item, secondKey);
            if (!secondGroups.has(k)) secondGroups.set(k, []);
            secondGroups.get(k).push(item);
          }
          const secondVals = Array.from(secondGroups.keys()).sort((a, b) => collator.compare(a, b));
          const sectionsHtml = secondVals.map((secondVal) => {
            const cards = (secondGroups.get(secondVal) || [])
              .slice()
              .sort((a, b) => collator.compare(readKey(a, thirdKey), readKey(b, thirdKey)) || collator.compare(a.caseId, b.caseId))
              .map((item) => renderCaseCard(item, thirdKey))
              .join("");
            return `<div style="margin-bottom:10px;">
              <div style="font-weight:900;color:#cbd5e1;font-size:12px;margin-bottom:6px;">${_esc(secondVal)} (${(secondGroups.get(secondVal) || []).length})</div>
              <div style="display:flex;flex-direction:column;gap:8px;">${cards}</div>
            </div>`;
          }).join("");
          return `<div style="flex:0 0 360px;max-width:420px;padding:10px;border:1px solid #1f2937;border-radius:14px;background:#020617;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <div style="font-weight:900;color:#e5e7eb;">${_esc(firstVal)}</div>
              <div style="margin-left:auto;color:#9ca3af;font-weight:800;font-size:12px;">${items.length}</div>
            </div>
            ${sectionsHtml || `<div style="color:#9ca3af;font-size:12px;">No cases</div>`}
          </div>`;
        }).join("");

        body.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="font-weight:900;">Lane Cases (Relay)</div>
          <div style="color:#9ca3af;font-weight:800;font-size:12px;">${_esc(laneBase(laneKey))} | ${vrids.length} VRIDs | ${caseItems.length} cases</div>
          <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <label for="ssp-cases-sort-order" style="color:#9ca3af;font-weight:800;font-size:12px;">Sort</label>
            <select id="ssp-cases-sort-order" style="padding:6px 10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:900;cursor:pointer;">
              ${sortChoices.map((o) => `<option value="${_esc(o.id)}">${_esc(o.label)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div style="max-height:70vh;overflow:auto;padding-right:6px;">
          <div style="display:flex;gap:10px;align-items:flex-start;min-width:min-content;">${columnsHtml || `<div style="color:#6b7280;">No cases found.</div>`}</div>
        </div>`;

        const select = body.querySelector("#ssp-cases-sort-order");
        if (select) {
          select.value = active.id;
          select.addEventListener("change", () => {
            const next = String(select.value || "");
            if (!sortById.has(next)) return;
            STATE.__relayCasesSortOrder = next;
            renderBoard();
          });
        }
        wireCaseButtons();
      };

      renderBoard();
    };
    try { openRelayCasesPanel = window.openRelayCasesPanel; } catch (_) {}

  } catch (_) {}
})();
