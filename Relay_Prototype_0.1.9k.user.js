// ==UserScript==
// @name         Relay Prototype (SSP+Relay Midway Bootstrap) 0.1.9k
// @version      0.1.9k
// @description  Prototype: pull outbound vehicleRuns from Relay transport-views from SSP. Auto-bootstraps Relay bearer via Midway SSO (no Relay tab).
// @author       you
// @match        https://trans-logistics.amazon.com/*
// @match        https://ssp.amazon.com/*
// @match        https://*.amazon.com/*ssp*
// @match        https://track.relay.amazon.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      track.relay.amazon.dev
// @connect      midway-auth.amazon.com
// ==/UserScript==

(function () {
  'use strict';

  // Cross-domain auth capture:
  // This userscript runs on both SSP pages and track.relay.amazon.dev.
  // When loaded on track.relay.amazon.dev after Midway redirect, capture id_token from URL hash and store it for SSP use.
  const AUTH_KEY = 'relay_id_token_v1';

  function _parseHashParams(hash) {
    const h = String(hash || '').replace(/^#/, '');
    const p = new URLSearchParams(h);
    const o = {};
    for (const [k,v] of p.entries()) o[k]=v;
    return o;
  }

  async function _storeRelayTokenFromHashIfPresent() {
    try {
      if (!/track\.relay\.amazon\.dev$/i.test(location.hostname)) return false;
      const hp = _parseHashParams(location.hash);
      const tok = hp.id_token || hp.access_token || '';
      if (!tok) return false;
      if (typeof GM_setValue === 'function') await GM_setValue(AUTH_KEY, tok);
      // clean URL to avoid token sitting in address bar/history
      try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
      dlog('Captured Relay token from hash.');
      // Minimal on-page indicator
      try {
        const el = document.createElement('div');
        el.textContent = 'Relay auth captured ✔ You can close this tab.';
        el.style.cssText = 'position:fixed;z-index:999999;top:12px;left:12px;padding:10px 12px;border-radius:10px;background:#0b1220;color:#e5e7eb;font:600 12px ui-sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);';
        document.documentElement.appendChild(el);
        setTimeout(()=>{ try{ el.remove(); }catch(_){} }, 8000);
      } catch(_) {}
      return true;
    } catch (e) {
      try { console.warn('[RelayProto] token capture failed', e); } catch (_) {}
      return false;
    }
  }

  // Lightweight always-on logging
  const LOG_PREFIX = '[RelayProto]';
  const dlog = (...args) => { try { console.log(LOG_PREFIX, ...args); } catch (_) {} };
  const dtime = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // If we're on track.relay.amazon.dev, only capture auth token (if present) and don't inject SSP UI.
  (async () => {
    const did = await _storeRelayTokenFromHashIfPresent();
    if (/track\.relay\.amazon\.dev$/i.test(location.hostname)) {
      // Keep minimal footprint on Relay itself
      return;
    }
  })();

  // -------------------------------
  // Relay Auth Handshake (captures id_token on Relay domain, reuses on SSP domain)
  // -------------------------------
  const TOKEN_KEY = AUTH_KEY;
  const TOKEN_EXP_KEY = "relay_id_token_exp";

  function _b64urlJson(part) {
    try {
      const pad = "===".slice((part.length + 3) % 4);
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + pad;
      return JSON.parse(atob(b64));
    } catch {
      return null;
    }
  }

  function _looksLikeJwt(v) {
    return typeof v === "string" && v.length > 60 && v.split(".").length === 3;
  }

  function _parseJwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    return _b64urlJson(parts[1]);
  }

  function getStoredToken() {
    const t = GM_getValue(TOKEN_KEY, "");
    const exp = Number(GM_getValue(TOKEN_EXP_KEY, 0) || 0);
    if (!t) return "";
    if (exp && Date.now() > exp - 60_000) return ""; // treat as expired if <60s remaining
    return t;
  }

  function storeToken(token) {
    if (!_looksLikeJwt(token)) return false;
    const payload = _parseJwtPayload(token);
    const expMs = payload && payload.exp ? payload.exp * 1000 : 0;
    GM_setValue(TOKEN_KEY, token);
    GM_setValue(TOKEN_EXP_KEY, expMs);
    return true;
  }
  function getRelayAuthHeader() {
    const tok = getStoredToken();
    return tok ? `Bearer ${tok}` : '';
  }

  const RELAY_BOOTSTRAP_COOLDOWN_MS = 3 * 60 * 1000;
  let relayBootstrapInflight = null;
  let relayBootstrapLastAt = 0;
  let relayBootstrapLastError = '';

  async function bootstrapRelayAuth(opts = {}) {
    const force = !!opts.force;
    const cooldownMs = Number(opts.cooldownMs || RELAY_BOOTSTRAP_COOLDOWN_MS);
    const now = Date.now();

    if (!force && getRelayAuthHeader()) {
      return { ok: true, tried: false, reason: 'already_authed' };
    }
    if (relayBootstrapInflight) return relayBootstrapInflight;

    if (!force && relayBootstrapLastAt && (now - relayBootstrapLastAt) < cooldownMs && relayBootstrapLastError) {
      return { ok: false, tried: false, reason: 'cooldown', error: relayBootstrapLastError };
    }

    relayBootstrapInflight = (async () => {
      try {
        const token = await fetchRelayIdTokenViaMidway();
        if (!storeToken(token)) throw new Error('Midway token invalid or expired');
        relayBootstrapLastAt = Date.now();
        relayBootstrapLastError = '';
        return { ok: true, tried: true };
      } catch (e) {
        relayBootstrapLastAt = Date.now();
        relayBootstrapLastError = String(e?.message || e || 'bootstrap failed');
        return { ok: false, tried: true, error: relayBootstrapLastError };
      } finally {
        relayBootstrapInflight = null;
      }
    })();

    return relayBootstrapInflight;
  }

  function extractTokenFromHash() {
    const h = String(location.hash || "");
    if (!h || !h.startsWith("#")) return "";
    const qs = new URLSearchParams(h.slice(1));
    const t = qs.get("id_token") || qs.get("access_token") || "";
    return _looksLikeJwt(t) ? t : "";
  }

  function extractTokenFromStorage() {
    try {
      let best = "";
      const consider = (v) => {
        if (_looksLikeJwt(v) && v.length > best.length) best = v;
      };
      for (let i = 0; i < localStorage.length; i++) consider(localStorage.getItem(localStorage.key(i)));
      for (let i = 0; i < sessionStorage.length; i++) consider(sessionStorage.getItem(sessionStorage.key(i)));
      return best;
    } catch {
      return "";
    }
  }

  function captureRelayTokenIfPresent() {
    if (location.host !== "track.relay.amazon.dev") return false;
    const token = extractTokenFromHash() || extractTokenFromStorage();
    if (token && storeToken(token)) {
      // Remove token from URL
      if (location.hash) {
        history.replaceState(null, document.title, location.pathname + location.search);
      }


      console.log("[RelayProto] Captured Relay id_token.");
      return true;
    }
    return false;
  }

  // If we're on Relay, just capture token and exit.
  if (location.host === "track.relay.amazon.dev") {
    captureRelayTokenIfPresent();
    return;
  }

  // -------------------------------
  // Midway bootstrap (SSP domain): obtain Relay id_token without opening Relay UI
  // -------------------------------
  function _randNonce(len = 48) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    for (let i = 0; i < len; i++) out += chars[a[i] % chars.length];    return out;
  }

  
  function buildRelayMidwayAuthUrl() {
    const nonce = _randNonce(64);
    const redirectUri = 'https://track.relay.amazon.dev/?m=trip&preset=today&column=scheduled_end&type=vehicleRun';
    return (
      'https://midway-auth.amazon.com/SSO?' +
      new URLSearchParams({
        client_id: 'track.relay.amazon.dev',
        redirect_uri: redirectUri,
        response_type: 'id_token',
        scope: 'openid',
        nonce,
      }).toString()
    );
  }

function fetchRelayIdTokenViaMidway() {
    return new Promise((resolve, reject) => {
      const nonce = _randNonce(64);
      const redirectUri = 'https://track.relay.amazon.dev/?m=trip&preset=today&column=scheduled_end&type=vehicleRun';
      const url =
        'https://midway-auth.amazon.com/SSO?' +
        new URLSearchParams({
          client_id: 'track.relay.amazon.dev',
          redirect_uri: redirectUri,
          response_type: 'id_token',
          scope: 'openid',
          nonce,
        }).toString();

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        withCredentials: true,
        anonymous: false,
        headers: {
          Accept: '*/*',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Origin: 'https://track.relay.amazon.dev',
          Referer: 'https://track.relay.amazon.dev/',
        },
        onload: (resp) => {
          const body = String(resp.responseText || '').trim();
          if (resp.status < 200 || resp.status >= 300) {
            reject(new Error(`Midway HTTP ${resp.status}: ${body.slice(0, 300)}`));
            return;
          }
          if (!_looksLikeJwt(body)) {
            reject(new Error(`Midway token response not JWT (len=${body.length})`));
            return;
          }
          storeToken(body);
          resolve(body);
        },
        onerror: () => reject(new Error('Midway request failed (network/CORS)')),
        ontimeout: () => reject(new Error('Midway request timeout')),
      });
    });
  }

  const APP_KEY = '__RELAY_PROTO_010A__';
  const app = window[APP_KEY] || (window[APP_KEY] = {
    inited: false,
    ui: { btn: null, panel: null },
    timers: [],
    state: {
      open: false,
      loading: false,
      lastErr: '',
      authHold: false,
      lastAuthOk: 0,
      lastAuthFail: 0,
      lastFetchedAt: 0,
      data: [],
      grouped: new Map(),
    },
    settings: null,
  });

  if (app.inited) return;
  app.inited = true;

  const DEFAULTS = {
    nodeCode: 'LDJ5',
    shipperAccounts: ['OutboundAMZL', 'OutboundDDU'],
    dateField: 'effectiveEnd', // or 'dynamicSearchFields.dateRanges.plannedDockDepart'
    startTime: '05:00:00',
    endTime: '04:59:59',
    shiftDate: isoDateLocal(new Date()),
    filterBeforeWindow: true,
    // Execution status filtering (capacity only counts active work)
    excludeArrivedCompleted: true,
    startDateOffsetDays: 0,
    endDateOffsetDays: 1,
    refreshSeconds: 60,
    pageSize: 200,
    maxPages: 10,
  };

  function loadSettings() {
    try {
      const raw = GM_getValue('relayProto.settings', '');
      if (!raw) return { ...DEFAULTS };
      const obj = JSON.parse(raw);
      return { ...DEFAULTS, ...(obj || {}) };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function saveSettings(next) {
    app.settings = { ...app.settings, ...(next || {}) };
    GM_setValue('relayProto.settings', JSON.stringify(app.settings));
  }
  app.settings = loadSettings();

  GM_addStyle(`
    #relay-proto-btn {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 999999;
      background: linear-gradient(135deg, #1d4ed8, #2563eb);
      color: #eff6ff;
      border: 1px solid #334155;
      border-radius: 999px;
      padding: 10px 14px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      font-size: 12px;
      cursor: pointer;
      box-shadow: 0 10px 30px rgba(0,0,0,.25);
    }
    #relay-proto-panel {
      position: fixed;
      right: 14px;
      bottom: 58px;
      width: min(920px, calc(100vw - 28px));
      max-height: min(78vh, 820px);
      z-index: 999999;
      background: rgba(15, 23, 42, .98);
      color: #e5e7eb;
      border: 1px solid #334155;
      border-radius: 16px;
      overflow: hidden;
      display: none;
      box-shadow: 0 12px 44px rgba(0,0,0,.35);
    }
    #relay-proto-panel.open { display: block; }
    #relay-proto-panel .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid #334155;
      background: linear-gradient(90deg, rgba(30, 41, 59, .95), rgba(37, 99, 235, .22));
      font-weight: 800;
    }
    #relay-proto-panel .hdr .title { font-size: 15px; }
    #relay-proto-panel .hdr .subtitle {
      font-size: 11px;
      font-weight: 500;
      opacity: .85;
      margin-top: 2px;
    }
    #relay-proto-panel .hdr .meta {
      font-weight: 500;
      opacity: .8;
      font-size: 11px;
    }
    #relay-proto-panel .body {
      padding: 10px 12px;
      overflow: auto;
      max-height: calc(min(78vh, 820px) - 48px);
      font-size: 12px;
    }
    #relay-proto-panel input, #relay-proto-panel select, #relay-proto-panel textarea {
      background: #0b1220;
      color: #e5e7eb;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
    }
    #relay-proto-panel .section {
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 10px;
      background: rgba(2, 6, 23, .35);
    }
    #relay-proto-panel .section h4 {
      margin: 0 0 8px;
      font-size: 12px;
      color: #bfdbfe;
      letter-spacing: .2px;
    }
    #relay-proto-panel .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 8px; }
    #relay-proto-panel .field { display: flex; flex-direction: column; gap: 4px; }
    #relay-proto-panel .field label { font-size: 10px; opacity: .8; }
    #relay-proto-panel .btn {
      background: #2563eb;
      border: 1px solid #1d4ed8;
      color: white;
      border-radius: 10px;
      padding: 7px 10px;
      cursor: pointer;
      font-weight: 800;
      font-size: 12px;
    }
    #relay-proto-panel .btn.secondary {
      background: #111827;
      border: 1px solid #334155;
      color: #e5e7eb;
    }
    #relay-proto-panel .err {
      color: #fecaca;
      background: rgba(127, 29, 29, .35);
      border: 1px solid rgba(239, 68, 68, .4);
      padding: 8px 10px;
      border-radius: 10px;
      margin-bottom: 10px;
      display: none;
      white-space: pre-wrap;
    }
    #relay-proto-panel .err.show { display: block; }
    #relay-proto-panel details {
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 8px 10px;
      margin: 10px 0;
      background: rgba(2, 6, 23, .4);
    }
    #relay-proto-panel summary {
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-weight: 900;
    }
    #relay-proto-panel .mono {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      white-space: pre;
      overflow: auto;
      margin-top: 8px;
      opacity: .95;
    }
    #relay-proto-panel .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid #334155;
      background: rgba(15, 23, 42, .7);
      font-weight: 800;
      font-size: 11px;
      opacity: .9;
    }
    #relay-proto-panel .helper {
      font-size: 11px;
      opacity: .8;
      margin: 2px 0 8px;
    }
  `);
  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoDateLocal(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function esc(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }


  function isoDateUTC(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth()+1)}-${pad2(dt.getUTCDate())}`;
  }

  function hmsUTC(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;
  }
  function buildRelayUrl(page) {
    const s = app.settings;

    // Relay /transport-views startDate/endDate + startTime/endTime behave like UTC-based boundaries.
    // Build the window in local time, then convert to UTC date/time parts for the query.
    const w = computeWindowMs(s);
    const startDt = new Date(w.windowStartMs);
    const endDt = new Date(w.windowEndMs);

    const dynamicSearchFields = {
      shipperAccounts: Array.isArray(s.shipperAccounts)
        ? s.shipperAccounts
        : String(s.shipperAccounts || '').split(',').map(x => x.trim()).filter(Boolean),
      nodeCodes: [s.nodeCode],
    };

    const q = new URLSearchParams();
    q.append('type[]', 'vehicleRun');
    q.set('module', 'trip');
    q.set('page', String(page));
    q.set('pageSize', String(s.pageSize || 200));
    q.set('sortCol', 'sent');
    q.set('ascending', 'true');

    q.set('startDate', isoDateUTC(startDt));
    q.set('endDate', isoDateUTC(endDt));
    q.set('startTime', hmsUTC(startDt));
    q.set('endTime', hmsUTC(endDt));
    q.set('column', 'scheduled_end');
    q.set('view', 'detail');
    q.set('dynamicSearchFields', JSON.stringify(dynamicSearchFields));
    q.set('dateField', s.dateField || 'effectiveEnd');

    return `https://track.relay.amazon.dev/api/v2/transport-views?${q.toString()}`;
  }

  function normalizeRelayItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.results)) return payload.results;
    return [];
  }

  function relayRequestJson(url) {
    return new Promise((resolve, reject) => {
      const auth = getRelayAuthHeader();
      const hdrs = { Accept: 'application/json' };
      if (auth) hdrs.Authorization = auth;

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: hdrs,
        timeout: 30000,
        withCredentials: true,
        anonymous: false,
        onload: async (resp) => {
          dlog('relayRequestJson', { status: resp.status, url: url.slice(0,120) + (url.length>120?'…':'') });
          try {
            if (resp.status === 401 || resp.status === 403) {
              app.state.authHold = true;
              app.state.lastAuthFail = Date.now();
              try { GM_setValue(TOKEN_KEY, ''); GM_setValue(TOKEN_EXP_KEY, 0); } catch(_) {}
              reject(new Error(`Relay HTTP ${resp.status}: Unauthorized`));
              return;
            }
            if (resp.status < 200 || resp.status >= 300) {
              reject(new Error(`Relay HTTP ${resp.status}: ${(resp.responseText || '').slice(0, 500)}`));
              return;
            }
            app.state.authHold = false;
            app.state.lastAuthOk = Date.now();
            resolve(JSON.parse(resp.responseText));
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('Relay request failed (network/CORS)')),
        ontimeout: () => reject(new Error('Relay request timeout')),
      });
    });
  }

  async function gmGetJson(url, attempt = 0) {
    try {
      return await relayRequestJson(url);
    } catch (e) {
      const msg = String(e?.message || e || 'Relay request failed');
      const unauthorized = /Relay HTTP\s+(401|403)/.test(msg);
      if (!unauthorized || attempt > 0) throw e;

      const boot = await bootstrapRelayAuth({ force: true });
      if (!boot?.ok) throw new Error(boot?.error || msg);
      return await relayRequestJson(url);
    }
  }

  async function pullRelayVehicleRuns() {
    const s = app.settings;
    const out = [];
    const t0Fetch = dtime();
    const pageSize = s.pageSize || 200;
    const maxPages = s.maxPages || 10;

    for (let p = 1; p <= maxPages; p++) {
      const tPage = dtime();
      dlog('fetch page', p);
      const url = buildRelayUrl(p);
      dlog('request', url.slice(0,220) + (url.length>220?'…':''));
      const payload = await gmGetJson(url);
      const batch = normalizeRelayItems(payload);
      dlog('page done', { p, count: batch.length, ms: Math.round(dtime()-tPage) });
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    dlog('fetch complete', { total: out.length, ms: Math.round(dtime()-t0Fetch) });
    return out;
  }

  function getLaneKey(vr) {
    const lanes = vr?.lanes;
    if (Array.isArray(lanes) && lanes.length) return String(lanes[0]);
    const stops = vr?.stops;
    const o = stops?.[0]?.location?.nodeCode || stops?.[0]?.location?.code || '';
    const d = stops?.[stops.length - 1]?.location?.nodeCode || stops?.[stops.length - 1]?.location?.code || '';
    if (o && d) return `${o}->${d}`;
    return 'UNKNOWN->UNKNOWN';
  }
  function getPlannedDockDepartMs(vr) {
    const t = vr?.stops?.[0]?.departure?.plannedTime || vr?.stops?.[0]?.departure?.plannedTimeUtc;
    const ms = t ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  function _firstValidMs(values) {
    for (const t of values) {
      const ms = t ? Date.parse(t) : NaN;
      if (Number.isFinite(ms)) return ms;
    }
    return null;
  }

  function getScheduledArrivalMs(vr) {
    // In Relay detail view payloads, startTime is the planned driver arrival anchor.
    // Prefer it first so lateness/check-in logic aligns with expected SAT behavior.
    return _firstValidMs([
      vr?.startTime,
      vr?.scheduledStartTime,
      vr?.scheduled_start,
      vr?.stops?.[0]?.arrival?.plannedTime,
      vr?.stops?.[0]?.arrival?.plannedTimeUtc,
      vr?.stops?.[0]?.arrival?.scheduledTime,
      vr?.scheduledArrivalTime,
      vr?.scheduledArrival,
      vr?.arrivalTime,
    ]);
  }

  function getScheduledDepartureMs(vr) {
    return _firstValidMs([
      vr?.stops?.[0]?.departure?.plannedTime,
      vr?.stops?.[0]?.departure?.plannedTimeUtc,
      vr?.stops?.[0]?.departure?.scheduledTime,
      vr?.scheduledDepartureTime,
      vr?.scheduledDeparture,
      vr?.departureTime,
    ]);
  }

  function getDriverCheckInMs(vr) {
    return _firstValidMs([
      vr?.driverCheckInTime,
      vr?.driver?.checkInTime,
      vr?.driver?.checkedInAt,
      vr?.checkInTime,
      vr?.checkedInAt,
      vr?.freight?.[0]?.requests?.[0]?.driverCheckInTime,
      vr?.freight?.[0]?.requests?.[0]?.checkInTime,
      vr?.freight?.[0]?.driverCheckInTime,
    ]);
  }

  function isDriverPresent(vr, driverCheckInMs) {
    if (driverCheckInMs) return true;
    const hasDriverIdentity = !!(
      vr?.driver?.id ||
      vr?.driver?.name ||
      vr?.driverId ||
      vr?.driverName ||
      vr?.freight?.[0]?.requests?.[0]?.driverId ||
      vr?.freight?.[0]?.requests?.[0]?.driverName
    );
    return hasDriverIdentity;
  }

  function getScheduledEndMs(vr) {
    const t = vr?.endTime || vr?.scheduledEndTime || vr?.scheduled_end || vr?.effectiveEnd;
    const ms = t ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  function getCriticalPullTimeMs(vr) {
    const t = vr?.criticalPullTime || vr?.critical_pull_time || vr?.cpt || vr?.cptTime;
    const ms = t ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  

  function getTruckFilterKey(vr) {
    // For OutboundAMZL/OutboundDDU: a truckFilter is always present. Use it as the primary grouping key.
    const tf =
      vr?.freight?.[0]?.requests?.[0]?.truckFilter ??
      vr?.freight?.[0]?.truckFilter ??
      vr?.requests?.[0]?.truckFilter ??
      vr?.truckFilter ??
      null;

    if (tf == null) return 'UNKNOWN_FILTER';
    if (typeof tf === 'string') return tf.trim() || 'UNKNOWN_FILTER';

    const maybe =
      tf?.name ??
      tf?.filter ??
      tf?.truckFilter ??
      tf?.id ??
      tf?.value ??
      null;
    if (maybe != null) return String(maybe);
    try { return JSON.stringify(tf); } catch { return String(tf); }
  }

  function getLanesParts(vr) {
    const lanes = Array.isArray(vr?.lanes) ? vr.lanes.map(x => String(x)) : [];
    if (!lanes.length) return { origin:'', dest:'', full:'', lanes: [] };
    const origin = lanes[0] || '';
    const dest = lanes.length > 1 ? (lanes[1] || '') : '';
    const full = lanes[lanes.length - 1] || '';
    return { origin, dest, full, lanes };
  }

  function getEquipmentType(vr) {
    return (
      vr?.freight?.[0]?.equipmentType ||
      vr?.equipmentType ||
      vr?.freight?.[0]?.requests?.[0]?.equipmentType ||
      null
    );
  }

  function getCaseId(vr) {
    // Prefer numeric case id for easy searching; avoid qualifiedId.
    const c = vr?.cases?.[0];
    if (!c) return '';
    const v = c.id ?? c.caseId ?? c.itemId ?? c.itemid ?? null;
    return v != null ? String(v) : '';
  }

  function getCases(vr) {
    return Array.isArray(vr?.cases) ? vr.cases : [];
  }

  function getOpenCases(vr) {
    const cases = getCases(vr);
    return cases.filter(c => String(c?.status || '').toLowerCase() !== 'resolved');
  }

  function getCaseSummary(vr) {
    const open = getOpenCases(vr);
    const all = getCases(vr);
    const pick = open[0] || all[0] || null;
    const id = pick && (pick.id ?? pick.caseId ?? pick.itemId ?? pick.itemid) != null ? String(pick.id ?? pick.caseId ?? pick.itemId ?? pick.itemid) : '';
    const typeId = pick && (pick.typeId ?? pick.typeWsid ?? pick.typeWSID ?? pick.type) ? String(pick.typeId ?? pick.typeWsid ?? pick.typeWSID ?? pick.type) : '';
    const status = pick && pick.status ? String(pick.status) : '';
    return {
      hasAny: all.length > 0,
      openCount: open.length,
      id,
      typeId,
      status,
    };
  }

  function getCrId(vr) {
    // CR id may exist at the vehicleRun level (distinct from case id).
    const v = vr?.crId ?? vr?.crid ?? vr?.CRID ?? null;
    return v ? String(v) : '';
  }

  function hasCase(vr) {
    return Array.isArray(vr?.cases) && vr.cases.length > 0;
  }

  function getVrStatus(vr) {
    return String(
      vr?.status ??
      vr?.executionStatus ??
      vr?.state ??
      vr?.vehicleRunStatus ??
      ''
    );
  }

  function isInactiveForCapacity(status) {
    const s = String(status || '').toUpperCase();
    if (!s) return false;
    return (
      s.includes('COMPLETED') ||
      s.includes('DEPARTED') ||
      s.includes('CANCELLED') ||
      s.includes('ARRIVED_AT_FINAL_DESTINATION')
    );
  }

  function equipCapacityUnits(equipmentType) {
    const s = String(equipmentType || '').toLowerCase();
    if (!s) return 0;
    // Capacity model (outbound planning):
    // - 26' box truck ~= 18 units
    // - 53' trailer/truck ~= 36 units
    if (s.includes('fifty') || s.includes('53')) return 36;
    if (s.includes('twenty_six') || s.includes('twenty-six') || s.includes('26')) return 18;
    return 18; // default to 26' equivalent
  }

  function _parseHMS(t) {
    const parts = String(t || '').trim().split(':').map(x => x.trim()).filter(Boolean);
    let h = 0, m = 0, s = 0;
    if (parts.length >= 1) h = Number(parts[0] || 0);
    if (parts.length >= 2) m = Number(parts[1] || 0);
    if (parts.length >= 3) s = Number(parts[2] || 0);
    if (!Number.isFinite(h)) h = 0;
    if (!Number.isFinite(m)) m = 0;
    if (!Number.isFinite(s)) s = 0;
    h = Math.max(0, Math.min(23, Math.floor(h)));
    m = Math.max(0, Math.min(59, Math.floor(m)));
    s = Math.max(0, Math.min(59, Math.floor(s)));
    return { h, m, s };
  }

  function normalizeTimeHMS(t) {
    const { h, m, s } = _parseHMS(t);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function computeWindowMs(settings) {
    const shiftDate = settings.shiftDate && /^\d{4}-\d{2}-\d{2}$/.test(String(settings.shiftDate))
      ? String(settings.shiftDate)
      : isoDateLocal(new Date());

    const stNorm = normalizeTimeHMS(settings.startTime || '05:00:00');
    const etNorm = normalizeTimeHMS(settings.endTime || '04:59:59');

    const [yy, mm, dd] = shiftDate.split('-').map(n => Number(n));
    const st = _parseHMS(stNorm);
    const et = _parseHMS(etNorm);

    const start = new Date(yy, (mm - 1), dd, st.h, st.m, st.s, 0);
    let end = new Date(yy, (mm - 1), dd, et.h, et.m, et.s, 0);

    if (end.getTime() <= start.getTime()) {
      end.setDate(end.getDate() + 1);
    }

    const windowStartMs = start.getTime();
    const windowEndMs = end.getTime();

    return { windowStartMs, windowEndMs, shiftDate, st: stNorm, et: etNorm };
  }

  function summarize(vr) {
    const id = vr?.vehicleRunId || vr?.id || vr?.vrid || vr?.vehicleRunCode || '';
    const shipper = Array.isArray(vr?.shipperAccounts) ? vr.shipperAccounts.join(',') : (vr?.shipperAccount || '');
    const truckFilter = getTruckFilterKey(vr);
    const lanesParts = getLanesParts(vr);
    const equipmentType = getEquipmentType(vr);
    const capUnits = equipCapacityUnits(equipmentType);
    const cs = getCaseSummary(vr);
    const status = getVrStatus(vr);
    const driverCheckInMs = getDriverCheckInMs(vr);
    return {
      id,
      shipper,
      laneKey: getLaneKey(vr),
      truckFilter,
      lanes: lanesParts.lanes,
      laneOrigin: lanesParts.origin,
      laneDest: lanesParts.dest,
      laneRoute: lanesParts.full,
      equipmentType,
      capUnits,
      // Cases/CR
      hasCase: cs.hasAny,
      openCaseCount: cs.openCount,
      caseId: cs.id,
      caseTypeId: cs.typeId,
      caseStatus: cs.status,
      crId: getCrId(vr),
      plannedDockDepartMs: getPlannedDockDepartMs(vr),
      scheduledArrivalMs: getScheduledArrivalMs(vr),
      scheduledDepartureMs: getScheduledDepartureMs(vr),
      scheduledEndMs: getScheduledEndMs(vr),
      cptMs: getCriticalPullTimeMs(vr),
      driverPresent: isDriverPresent(vr, driverCheckInMs),
      driverCheckInMs,
      status,
      raw: vr,
    };
  }
  function groupVehicleRuns(vrs) {
    // First pass: summarize all rows
    const all = [];
    for (const vr of vrs) all.push(summarize(vr));

    // Second pass: detect BACKUP relationships (exclude originals from capacity)
    // Example backup link string: ENTITY_LINK##BACKUP##VEHICLE_RUN##111SYF8RB
    const excludedOriginals = new Set();
    for (const s of all) {
      const cr = String(s.crId || '');
      if (!cr) continue;
      if (cr.includes('BACKUP') && cr.includes('VEHICLE_RUN##')) {
        const tail = cr.split('VEHICLE_RUN##')[1] || '';
        const og = tail.split(/[^A-Za-z0-9_]/)[0] || '';
        if (og) excludedOriginals.add(og);
        s.isBackupLink = true;
        s.backupOf = og;
      }
    }
    for (const s of all) {
      s.excludeFromCapacity = excludedOriginals.has(String(s.id || ''));
    }

    // Third pass: group
    const g = new Map();
    for (const s of all) {
      const key = s.truckFilter || 'UNKNOWN_FILTER';
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(s);
    }
    for (const [, arr] of g.entries()) {
      arr.sort((a, b) =>
        (a.plannedDockDepartMs ?? 9e15) - (b.plannedDockDepartMs ?? 9e15) ||
        (a.scheduledEndMs ?? 9e15) - (b.scheduledEndMs ?? 9e15)
      );
    }
    return g;
  }

  function ensureUI() {
    if (app.ui.btn && app.ui.panel) return;

    const btn = document.createElement('button');
    btn.id = 'relay-proto-btn';
    btn.textContent = 'Relay Helper';
    btn.addEventListener('click', () => togglePanel());
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'relay-proto-panel';
    panel.innerHTML = `
      <div class="hdr">
        <div>
          <div class="title">Relay Helper <span class="pill">Prototype 0.1.9k</span></div>
          <div class="subtitle">Friendly capacity view for vehicle runs and case signals</div>
          <div class="meta" id="relay-proto-meta"></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn secondary" id="relay-proto-close">Close</button>
        </div>
      </div>
      <div class="body">
        <div class="err" id="relay-proto-err"></div>

        <div class="section">
          <h4>Scope</h4>
          <div class="helper">Choose where to pull runs from and which timestamp to filter by.</div>
          <div class="row">
            <div class="field">
              <label>Site Node</label>
              <input id="rp-node" style="width:90px" />
            </div>
            <div class="field" style="min-width:280px;flex:1;">
              <label>Shipper Accounts (comma-separated)</label>
              <input id="rp-shippers" />
            </div>
            <div class="field">
              <label>Time Anchor</label>
              <select id="rp-datefield">
                <option value="effectiveEnd">Scheduled End Time</option>
                <option value="dynamicSearchFields.dateRanges.plannedDockDepart">Planned Dock Depart</option>
              </select>
            </div>
          </div>
        </div>

        <div class="section">
          <h4>Shift Window</h4>
          <div class="row">
            <div class="field">
              <label>Shift Date</label>
              <input id="rp-shiftdate" style="width:140px" placeholder="YYYY-MM-DD" />
            </div>
            <div class="field" style="align-self:flex-end;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="checkbox" id="rp-filterwindow" />
                <label for="rp-filterwindow" style="margin:0;font-weight:700;">Only include runs inside this window</label>
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="checkbox" id="rp-excludecompleted" />
                <label for="rp-excludecompleted" style="margin:0;font-weight:700;">Skip arrived/completed for capacity count</label>
              </div>
            </div>
            <div class="field" style="flex:1;">
              <label>Computed Window</label>
              <div id="rp-window" style="padding:6px 8px;border:1px solid #334155;border-radius:8px;background:#0b1220;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;"></div>
            </div>
          </div>

          <div class="row">
            <div class="field">
              <label>Start Time</label>
              <input id="rp-starttime" style="width:120px" />
            </div>
            <div class="field">
              <label>End Time</label>
              <input id="rp-endtime" style="width:120px" />
            </div>
            <div class="field">
              <label>Auto Refresh (sec)</label>
              <input id="rp-refresh" style="width:90px" />
            </div>
            <div class="field" style="margin-left:auto;display:flex;flex-direction:row;gap:8px;align-items:flex-end;">
              <button class="btn secondary" id="relay-proto-save">Save Settings</button>
              <button class="btn" id="relay-proto-refresh">Pull Latest Runs</button>
            </div>
          </div>
        </div>

        <div id="relay-proto-results"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#relay-proto-close').addEventListener('click', () => togglePanel(false));
    panel.querySelector('#relay-proto-save').addEventListener('click', onSave);
    panel.querySelector('#relay-proto-refresh').addEventListener('click', () => refreshNow(true));
    const _w = () => updateWindowLabel();
    panel.querySelector('#rp-shiftdate').addEventListener('change', _w);
    panel.querySelector('#rp-starttime').addEventListener('change', _w);
    panel.querySelector('#rp-endtime').addEventListener('change', _w);

    app.ui.btn = btn;
    app.ui.panel = panel;

    hydrateInputs();
    render();
  }

  function togglePanel(force) {
    ensureUI();
    app.state.open = (typeof force === 'boolean') ? force : !app.state.open;
    app.ui.panel.classList.toggle('open', app.state.open);
    if (app.state.open) refreshNow(false);
  }


  function updateWindowLabel() {
    const p = app.ui.panel;
    if (!p) return;
    const s = app.settings;
    const shiftDate = p.querySelector('#rp-shiftdate')?.value?.trim() || s.shiftDate || isoDateLocal(new Date());
    const startTime = p.querySelector('#rp-starttime')?.value?.trim() || s.startTime || '05:00:00';
    const endTime = p.querySelector('#rp-endtime')?.value?.trim() || s.endTime || '04:59:59';
    const tmp = { shiftDate, startTime, endTime };
    const { windowStartMs, windowEndMs } = computeWindowMs(tmp);
    const el = p.querySelector('#rp-window');
    if (el) el.textContent = `${new Date(windowStartMs).toLocaleString()}  →  ${new Date(windowEndMs).toLocaleString()}`;
  }

  function hydrateInputs() {
    const s = app.settings;
    const p = app.ui.panel;
    p.querySelector('#rp-node').value = s.nodeCode || '';
    p.querySelector('#rp-shippers').value = (Array.isArray(s.shipperAccounts) ? s.shipperAccounts.join(',') : String(s.shipperAccounts || ''));
    p.querySelector('#rp-datefield').value = s.dateField || 'effectiveEnd';
    p.querySelector('#rp-shiftdate').value = s.shiftDate || isoDateLocal(new Date());
    p.querySelector('#rp-filterwindow').checked = (s.filterBeforeWindow !== false);
    p.querySelector('#rp-excludecompleted').checked = (s.excludeArrivedCompleted !== false);
    p.querySelector('#rp-starttime').value = s.startTime || '05:00:00';
    p.querySelector('#rp-endtime').value = s.endTime || '04:59:59';
    p.querySelector('#rp-refresh').value = String(s.refreshSeconds || 60);
    updateWindowLabel();
  }

  function onSave() {
    const p = app.ui.panel;
    const nodeCode = p.querySelector('#rp-node').value.trim() || 'LDJ5';
    const shipperAccounts = p.querySelector('#rp-shippers').value.split(',').map(x => x.trim()).filter(Boolean);
    const dateField = p.querySelector('#rp-datefield').value === 'dynamicSearchFields.dateRanges.plannedDockDepart'
      ? 'dynamicSearchFields.dateRanges.plannedDockDepart'
      : 'effectiveEnd';
    const shiftDate = p.querySelector('#rp-shiftdate').value.trim() || isoDateLocal(new Date());
    const filterBeforeWindow = !!p.querySelector('#rp-filterwindow').checked;
    const excludeArrivedCompleted = !!p.querySelector('#rp-excludecompleted').checked;
    const startTime = p.querySelector('#rp-starttime').value.trim() || '05:00:00';
    const endTime = p.querySelector('#rp-endtime').value.trim() || '04:59:59';
    const refreshSeconds = Math.max(10, Number(p.querySelector('#rp-refresh').value) || 60);

    saveSettings({ nodeCode, shipperAccounts, dateField, shiftDate, filterBeforeWindow, excludeArrivedCompleted, startTime, endTime, refreshSeconds });
    hydrateInputs();
    renderMeta();
  }

  function setErr(msg) {
    app.state.lastErr = msg || '';
    render();
  }

  function renderMeta() {
    const meta = app.ui.panel.querySelector('#relay-proto-meta');
    const s = app.settings;
    const fetched = app.state.lastFetchedAt ? new Date(app.state.lastFetchedAt).toLocaleTimeString() : '—';
    const { shiftDate, st, et } = computeWindowMs(s);
    const fieldLabel = s.dateField === 'dynamicSearchFields.dateRanges.plannedDockDepart' ? 'Planned Dock Depart' : 'Scheduled End';
    meta.textContent = `Node ${s.nodeCode} • Shippers ${(s.shipperAccounts || []).join(',')} • Shift ${shiftDate} ${st}→${et} • Filter ${fieldLabel} • Last refresh ${fetched}`;
  }

  function render() {
    if (!app.ui.panel) return;
    renderMeta();

    const err = app.ui.panel.querySelector('#relay-proto-err');
    const hasErr = !!app.state.lastErr;
    err.classList.toggle('show', hasErr);

    // If unauthorized, offer a one-click auth bootstrap (opens Relay in a new tab).
    const isUnauthorized = hasErr && /Relay HTTP\s+(401|403)/.test(app.state.lastErr);
    if (isUnauthorized) {
      err.innerHTML = `${escapeHtml(app.state.lastErr || '')}
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn secondary" id="rp-open-relay-auth">Open Relay to authenticate</button>
          <span style="opacity:.9;font-size:12px;">(One-time per session. After signing in, come back and click “Pull Latest Runs”.)</span>
        </div>`;
      const b = err.querySelector('#rp-open-relay-auth');
      if (b && !b.__bound) {
        b.__bound = true;
        b.addEventListener('click', () => {
          window.open(buildRelayMidwayAuthUrl(), '_blank', 'noopener');
        });
      }
    } else {
      err.textContent = app.state.lastErr || '';
    }

    const results = app.ui.panel.querySelector('#relay-proto-results');
    const grouped = app.state.grouped;

    if (!grouped || grouped.size === 0) {
      results.innerHTML = app.state.loading
        ? `<div class="pill">Loading Relay data…</div>`
        : `<div class="pill">No run data yet. Click “Pull Latest Runs”.</div>`;
      return;
    }

    const blocks = [];
    for (const [filterKey, arr] of grouped.entries()) {
      const count = arr.length;
      const shipSet = new Set(arr.map(x => x.shipper).filter(Boolean));
      const ships = Array.from(shipSet).slice(0, 6).join(',') + (shipSet.size > 6 ? '…' : '');

      const routeSet = new Set(arr.map(x => x.laneRoute).filter(Boolean));
      const route = Array.from(routeSet)[0] || '';
      const destSet = new Set(arr.map(x => x.laneDest).filter(Boolean));
      const dest = Array.from(destSet)[0] || '';
      const originSet = new Set(arr.map(x => x.laneOrigin).filter(Boolean));
      const origin = Array.from(originSet)[0] || '';
      const routeInfo = [route ? `Route:${route}` : '', origin ? `O:${origin}` : '', dest ? `D:${dest}` : ''].filter(Boolean).join(' ');


      const lines = arr.slice(0, 80).map(x => {
        const sat = x.scheduledArrivalMs ? new Date(x.scheduledArrivalMs).toLocaleString() : '—';
        const sdt = x.scheduledDepartureMs ? new Date(x.scheduledDepartureMs).toLocaleString() : '—';
        const pdd = x.plannedDockDepartMs ? new Date(x.plannedDockDepartMs).toLocaleString() : '—';
        const sed = x.scheduledEndMs ? new Date(x.scheduledEndMs).toLocaleString() : '—';
        const dci = x.driverCheckInMs ? new Date(x.driverCheckInMs).toLocaleString() : '—';
        const dp = x.driverPresent ? 'Yes' : 'No';
        const casePart = (x.openCaseCount > 0)
          ? `Open Case: Yes (${x.caseId || ''})${x.caseTypeId ? ' ['+x.caseTypeId+']' : ''}${x.caseStatus ? ' '+x.caseStatus : ''}`
          : (x.hasCase ? `Open Case: Resolved (${x.caseId || ''})` : 'Open Case: None');
        const crPart = x.crId ? `Change Request: Yes (${x.crId})` : 'Change Request: No';
        const excl = x.excludeFromCapacity ? 'EXCL_ORIG_BACKUP' : '';
        const st = x.status ? `Status: ${x.status}` : '';
        return `Run ${x.id || 'VRID?'} • Filter: ${x.truckFilter || ''} • Route: ${x.laneRoute || x.laneKey || ''} • Equipment: ${x.equipmentType || ''} • ${casePart} • ${crPart} • ${st}${excl ? ` • Excluded: ${excl}` : ''} • Scheduled Arrival: ${sat} • Scheduled Departure: ${sdt} • Driver Present: ${dp} • Driver Check-in: ${dci} • Planned Dock Depart: ${pdd} • Scheduled End: ${sed} • Shipper: ${x.shipper || ''}`;
      }).join('\n');

      blocks.push(`
        <details ${count ? 'open' : ''}>
          <summary>
            <span>${esc(filterKey)}</span>
            <span class="pill">${count} VRs</span>
            <span class="pill">${esc(routeInfo)}</span>
          </summary>
          <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
            ${ships ? `<span class="pill">Shippers: ${esc(ships)}</span>` : ''}
            ${(() => {
              const cpts = arr.map(x => x.cptMs).filter(Boolean);
              if (!cpts.length) return '';
              let min = cpts[0], max = cpts[0];
              for (const ms of cpts) { if (ms < min) min = ms; if (ms > max) max = ms; }
              const fmt = (ms) => new Date(ms).toLocaleString();
              const label = (min === max) ? fmt(min) : `${fmt(min)} → ${fmt(max)}`;
              return `<span class="pill">CPT: ${esc(label)}</span>`;
            })()}
            ${(() => {
              const byEquip = {};
              const byEquipCounted = {};
              const byCaseTypeOpen = {};
              let totalCap = 0;
              let counted = 0;
              let excludedBackup = 0;
              let excludedStatus = 0;
              for (const x of arr) {
                const k = x.equipmentType || 'UNKNOWN';
                byEquip[k] = (byEquip[k] || 0) + 1;
                if (x.openCaseCount > 0) {
                  const t = x.caseTypeId || 'UNKNOWN';
                  byCaseTypeOpen[t] = (byCaseTypeOpen[t] || 0) + x.openCaseCount;
                }

                const inactive = (app.settings.excludeArrivedCompleted !== false) && isInactiveForCapacity(x.status);
                if (inactive) { excludedStatus++; continue; }
                if (x.excludeFromCapacity) { excludedBackup++; continue; }
                byEquipCounted[k] = (byEquipCounted[k] || 0) + 1;
                totalCap += (x.capUnits || 0);
                counted++;
              }
              const parts = Object.entries(byEquip).slice(0,6).map(([k,v])=>`${k}:${v}`).join(' | ');
              const more = Object.keys(byEquip).length > 6 ? '…' : '';
              const partsCounted = Object.entries(byEquipCounted).slice(0,6).map(([k,v])=>`${k}:${v}`).join(' | ');
              const moreCounted = Object.keys(byEquipCounted).length > 6 ? '…' : '';
              const openCasePart = (() => {
                const entries = Object.entries(byCaseTypeOpen).filter(([k,v])=>v>0).slice(0,4);
                if (!entries.length) return '';
                const s = entries.map(([k,v])=>`${k}:${v}`).join(' | ');
                const m = Object.keys(byCaseTypeOpen).length > 4 ? '…' : '';
                return ` | OpenCases: ${s}${m}`;
              })();

              const exclPart = (excludedBackup || excludedStatus)
                ? ` | Counted: ${counted}/${arr.length}${excludedBackup ? ` (backupExcl:${excludedBackup})` : ''}${excludedStatus ? ` (statusExcl:${excludedStatus})` : ''}`
                : '';

              if (!parts) return '';
              return `<span class="pill">Equip: ${esc(parts + more)} | CountedEquip: ${esc((partsCounted||'') + moreCounted)} | Cap: ${totalCap}u${esc(exclPart)}${esc(openCasePart)}</span>`;
            })()}
          </div>
          <div class="mono">${esc(lines || '')}</div>
        </details>
      `);
    }
    results.innerHTML = blocks.join('');
  }

  async function refreshNow(force) {
    if (!app.state.open) return;
    if (app.state.loading) return;

    const t0 = dtime();
    dlog('refreshNow', { force: !!force, node: app.settings.nodeCode, shippers: app.settings.shipperAccounts, dateField: app.settings.dateField, shiftDate: app.settings.shiftDate, start: app.settings.startTime, end: app.settings.endTime, pageSize: app.settings.pageSize, maxPages: app.settings.maxPages });

    const now = Date.now();
    const minGap = Math.max(5, app.settings.refreshSeconds || 60) * 1000;
    if (!force && (now - app.state.lastFetchedAt) < minGap) return;

    app.state.loading = true;
    setErr('');
    render();

    try {
      if (!getRelayAuthHeader()) {
        await bootstrapRelayAuth({ force: false });
      }
      const vrs0 = await pullRelayVehicleRuns();
      const { windowStartMs, windowEndMs } = computeWindowMs(app.settings);
      const df = app.settings.dateField || 'effectiveEnd';
      const vrs = (app.settings.filterBeforeWindow !== false)
        ? vrs0.filter(vr => {
            const ms = df === 'dynamicSearchFields.dateRanges.plannedDockDepart'
              ? (getPlannedDockDepartMs(vr) ?? 0)
              : (getScheduledEndMs(vr) ?? 0);
            return ms >= windowStartMs && ms <= windowEndMs;
          })
        : vrs0;
      app.state.data = vrs;
      app.state.grouped = groupVehicleRuns(vrs);
      app.state.lastFetchedAt = Date.now();
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Relay HTTP\s+(401|403)/.test(msg)) {
        app.state.authHold = true;
        app.state.lastAuthFail = Date.now();
      }
      setErr(msg);
    } finally {
      app.state.loading = false;
      render();
      dlog('refreshNow done', { ms: Math.round(dtime()-t0), lastFetchedAt: app.state.lastFetchedAt, totalVRs: Array.isArray(app.state.data)?app.state.data.length:undefined, groups: app.state.grouped ? app.state.grouped.size : undefined });
    }
  }

  function startTimer() {
    const id = setInterval(() => {
      if (app.state.authHold) return; // pause auto-refresh until Relay auth restored
      refreshNow(false);
    }, 5000);
    app.timers.push(() => clearInterval(id));
  }

  ensureUI();
  startTimer();
})();function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
