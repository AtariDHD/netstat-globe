/* global Globe */

(function () {
  const globeEl = document.getElementById('globe');
  const globeStage = globeEl ? globeEl.closest('.globe-stage') : null;
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('count');
  const errorEl = document.getElementById('error');

  const OPACITY = 0.5;

  const LS_COL_VIS_LIVE = 'netstatGlobeColVisLive';
  const LS_COL_VIS_HISTORY = 'netstatGlobeColVisHistory';
  const LS_SORT_KEY = 'netstatGlobeTableSortKey';
  const LS_SORT_DIR = 'netstatGlobeTableSortDir';
  const LS_POV = 'netstatGlobePov';
  const DEFAULT_POV = { lat: 39.6, lng: -98.5, altitude: 2 };
  const LS_POLL_MS = 'netstatGlobePollMs';
  const POLL_MS_OPTIONS = [500, 1000, 2000, 3000, 5000, 10000, 30000];
  const TABLE_SORT_IDS = [
    'pid',
    'process',
    'protocol',
    'local',
    'remote',
    'remoteHost',
    'from',
    'to',
    'createTime',
    'elapsed',
  ];
  const LS_HISTORY_MAX_ROWS = 'netstatGlobeHistoryMaxRows';
  const LS_HISTORY_SORT_KEY = 'netstatGlobeHistorySortKey';
  const LS_HISTORY_SORT_DIR = 'netstatGlobeHistorySortDir';
  const LS_DRAWER_TAB = 'netstatGlobeDrawerTab';
  const LS_PROTOCOL_FILTER_LIVE = 'netstatGlobeProtocolFilterLive';
  const LS_PROTOCOL_FILTER_HISTORY = 'netstatGlobeProtocolFilterHistory';
  const TABLE_HISTORY_SORT_IDS = [
    'time',
    'event',
    'pid',
    'process',
    'protocol',
    'local',
    'remote',
    'remoteHost',
    'from',
    'to',
  ];

  const SHARED_CONN_COL_IDS = ['pid', 'process', 'protocol', 'local', 'remote', 'remoteHost', 'from', 'to'];
  const LIVE_COL_IDS = [...SHARED_CONN_COL_IDS, 'createTime', 'elapsed'];
  const HIST_COL_IDS = ['time', 'event', ...SHARED_CONN_COL_IDS];

  const COL_DISPLAY_LABEL = {
    pid: 'PID',
    process: 'Process',
    protocol: 'Protocol',
    local: 'Local',
    remote: 'Remote',
    remoteHost: 'Remote Host',
    from: 'From',
    to: 'To',
    time: 'Time',
    event: 'Connection',
    createTime: 'Create Time',
    elapsed: 'Elapsed',
  };

  function defaultColVis(ids) {
    return Object.fromEntries(ids.map((id) => [id, true]));
  }

  function loadColVisLive() {
    const d = defaultColVis(LIVE_COL_IDS);
    try {
      const raw = localStorage.getItem(LS_COL_VIS_LIVE);
      if (raw) {
        const o = JSON.parse(raw);
        for (const id of LIVE_COL_IDS) {
          if (typeof o[id] === 'boolean') d[id] = o[id];
        }
      } else if (localStorage.getItem('netstatGlobeHideOriginCols') === '1') {
        d.local = false;
        d.from = false;
      }
    } catch {
      /* keep defaults */
    }
    return d;
  }

  function loadColVisHist() {
    const d = defaultColVis(HIST_COL_IDS);
    try {
      const raw = localStorage.getItem(LS_COL_VIS_HISTORY);
      if (raw) {
        const o = JSON.parse(raw);
        for (const id of HIST_COL_IDS) {
          if (typeof o[id] === 'boolean') d[id] = o[id];
        }
      } else if (localStorage.getItem('netstatGlobeHistoryHideOriginCols') === '1') {
        d.local = false;
        d.from = false;
      }
    } catch {
      /* keep defaults */
    }
    return d;
  }

  const colVisLive = loadColVisLive();
  const colVisHist = loadColVisHist();

  let lastConnections = [];
  let lastArcs = [];
  let tableSort = {
    key: localStorage.getItem(LS_SORT_KEY) || 'remote',
    dir: localStorage.getItem(LS_SORT_DIR) === 'desc' ? 'desc' : 'asc',
  };
  if (!TABLE_SORT_IDS.includes(tableSort.key)) tableSort.key = 'remote';

  let historyTableSort = {
    key: localStorage.getItem(LS_HISTORY_SORT_KEY) || 'time',
    dir: localStorage.getItem(LS_HISTORY_SORT_DIR) === 'asc' ? 'asc' : 'desc',
  };
  if (!TABLE_HISTORY_SORT_IDS.includes(historyTableSort.key)) historyTableSort.key = 'time';

  /** @type {Array<{ ts: number, event: string, process: string, protocol: string, local: string, remote: string, remoteHost: string, from: string, to: string, pid: number|null, pidStr: string }>} */
  let connectionHistory = [];

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${window.location.host}`;

  const world = new Globe(globeEl)
    .globeImageUrl('//cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg')
    .arcLabel('label')
    .arcDashLength(1)
    // arcColor / arcStroke set in syncArcStylesAndData() for hover highlighting
    .pointColor(() => 'orange')
    .pointAltitude(0)
    .pointRadius(0.02)
    .pointsMerge(true);

  function loadSavedPov() {
    try {
      const raw = localStorage.getItem(LS_POV);
      if (!raw) return null;
      const o = JSON.parse(raw);
      const lat = Number(o.lat);
      const lng = Number(o.lng);
      const altitude = Number(o.altitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
      if (!Number.isFinite(lng) || lng < -360 || lng > 360) return null;
      if (!Number.isFinite(altitude) || altitude <= 0 || altitude > 50) return null;
      return { lat, lng, altitude };
    } catch {
      return null;
    }
  }

  function savePovToStorage(pov) {
    if (!pov || typeof pov !== 'object') return;
    try {
      localStorage.setItem(
        LS_POV,
        JSON.stringify({
          lat: pov.lat,
          lng: pov.lng,
          altitude: pov.altitude,
        })
      );
    } catch {
      /* ignore */
    }
  }

  let povSaveTimer = null;
  let povPersistenceReady = false;

  function schedulePovSave(pov) {
    if (!povPersistenceReady) return;
    if (povSaveTimer) clearTimeout(povSaveTimer);
    povSaveTimer = setTimeout(() => {
      povSaveTimer = null;
      savePovToStorage(pov);
    }, 280);
  }

  if (typeof world.onZoom === 'function') {
    world.onZoom((pov) => {
      schedulePovSave(pov);
    });
  }

  window.addEventListener('pagehide', () => {
    try {
      const p = world.pointOfView();
      if (p && Number.isFinite(p.lat)) savePovToStorage(p);
    } catch {
      /* ignore */
    }
  });

  function layoutGlobe() {
    if (!globeEl) return;
    const stage = globeStage || globeEl.parentElement;
    const h =
      stage && stage.clientHeight > 0 ? stage.clientHeight : window.innerHeight;
    const w = Math.max(0, globeEl.clientWidth);
    globeEl.style.height = `${h}px`;
    world.width(w).height(h);
  }

  /** Stable arc objects by connection key so unchanged TCP rows keep the same THREE objects / arc state. */
  const arcByKey = new Map();

  const FLASH_MS = 4000;
  /** @type {Map<string, { kind: 'new'|'removed', until: number, removedConn?: object, removedArc?: object }>} */
  const flashState = new Map();
  let flashPruneTimer = null;

  let linkedHighlightKey = null;
  const LINK_OPACITY = Math.min(0.96, OPACITY + 0.44);
  const FLASH_NEW_OPACITY = Math.min(0.95, OPACITY + 0.4);

  function currentArcList() {
    return Array.from(arcByKey.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v);
  }

  function arcColorFor(d) {
    const key = String(d.connectionKey || d.__connectionKey || '').trim();
    const now = Date.now();
    const flash = flashState.get(key);

    if (linkedHighlightKey != null && key === linkedHighlightKey) {
      return [`rgba(0, 255, 0, ${LINK_OPACITY})`, `rgba(255, 0, 0, ${LINK_OPACITY})`];
    }
    if (flash && flash.until > now) {
      if (flash.kind === 'removed') {
        return [`rgba(148, 163, 184, ${OPACITY})`, `rgba(100, 116, 139, ${OPACITY})`];
      }
      if (flash.kind === 'new') {
        const op = FLASH_NEW_OPACITY;
        return [`rgba(34, 197, 94, ${op})`, `rgba(22, 163, 74, ${op})`];
      }
    }
    return [`rgba(0, 255, 0, ${OPACITY})`, `rgba(255, 0, 0, ${OPACITY})`];
  }

  function arcStrokeFor(d) {
    const key = String(d.connectionKey || d.__connectionKey || '').trim();
    const now = Date.now();
    const flash = flashState.get(key);

    if (linkedHighlightKey != null && key === linkedHighlightKey) {
      return 0.52;
    }
    if (flash && flash.until > now) {
      if (flash.kind === 'removed') return 0.18;
      if (flash.kind === 'new') return 0.48;
    }
    return 0.25;
  }

  function syncArcStylesAndData() {
    const list = currentArcList();
    world
      .arcColor(arcColorFor)
      .arcStroke(arcStrokeFor)
      .arcsData(list)
      .arcStartLat('startLat')
      .arcStartLng('startLng')
      .arcEndLat('endLat')
      .arcEndLng('endLng');
  }

  function syncTableRowHighlight() {
    const tbody = document.getElementById('connections-tbody');
    if (!tbody) return;
    for (const tr of tbody.querySelectorAll('tr[data-connection-key]')) {
      const k = tr.getAttribute('data-connection-key') || '';
      tr.classList.toggle(
        'is-linked-highlight',
        linkedHighlightKey != null && k === linkedHighlightKey
      );
    }
  }

  function countVisibleCols(which) {
    const vis = which === 'live' ? colVisLive : colVisHist;
    const ids = which === 'live' ? LIVE_COL_IDS : HIST_COL_IDS;
    let n = 0;
    for (const id of ids) {
      if (vis[id] !== false) n += 1;
    }
    return n;
  }

  function ensureNotAllHidden(vis, ids) {
    if (ids.some((id) => vis[id] !== false)) return;
    vis.pid = true;
  }

  function saveColVis(which) {
    try {
      const key = which === 'live' ? LS_COL_VIS_LIVE : LS_COL_VIS_HISTORY;
      const obj = which === 'live' ? colVisLive : colVisHist;
      localStorage.setItem(key, JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  function applyColumnVisibility(which) {
    const tableId = which === 'live' ? 'live-connections-table' : 'history-connections-table';
    const vis = which === 'live' ? colVisLive : colVisHist;
    const table = document.getElementById(tableId);
    if (!table) return;
    for (const el of table.querySelectorAll('[data-col]')) {
      const col = el.getAttribute('data-col');
      if (!col || !(col in vis)) continue;
      const show = vis[col] !== false;
      el.classList.toggle('col-hidden', !show);
    }
  }

  function applyAllColumnVisibility() {
    applyColumnVisibility('live');
    applyColumnVisibility('history');
  }

  let columnPickerWhich = 'live';

  function syncChooseColumnsCheckboxes() {
    const list = document.getElementById('choose-columns-list');
    if (!list) return;
    const vis = columnPickerWhich === 'live' ? colVisLive : colVisHist;
    for (const cb of list.querySelectorAll('input[type="checkbox"][data-col]')) {
      const id = cb.getAttribute('data-col');
      if (id && id in vis) cb.checked = vis[id] !== false;
    }
  }

  function openChooseColumnsDialog(which) {
    columnPickerWhich = which;
    const dlg = document.getElementById('choose-columns-dialog');
    const sub = document.getElementById('choose-columns-subtitle');
    const list = document.getElementById('choose-columns-list');
    const title = document.getElementById('choose-columns-title');
    if (!dlg || !list || !title) return;

    title.textContent = 'Choose columns';
    if (sub) {
      sub.textContent =
        which === 'live' ? 'Live connections table' : 'History table';
    }

    const ids = which === 'live' ? LIVE_COL_IDS : HIST_COL_IDS;
    const vis = which === 'live' ? colVisLive : colVisHist;
    list.replaceChildren();

    for (const id of ids) {
      const row = document.createElement('label');
      row.className = 'choose-columns-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-col', id);
      cb.checked = vis[id] !== false;
      const span = document.createElement('span');
      span.textContent = COL_DISPLAY_LABEL[id] || id;
      row.appendChild(cb);
      row.appendChild(span);
      cb.addEventListener('change', () => {
        vis[id] = cb.checked;
        ensureNotAllHidden(vis, ids);
        saveColVis(which);
        syncChooseColumnsCheckboxes();
        applyColumnVisibility(which);
        if (which === 'live') {
          refreshTableAndArcs();
        } else {
          renderHistoryTable();
        }
      });
      list.appendChild(row);
    }

    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

  function initChooseColumnsDialog() {
    const dlg = document.getElementById('choose-columns-dialog');
    const closeBtn = document.getElementById('choose-columns-close');
    const resetBtn = document.getElementById('choose-columns-reset');
    if (!dlg) return;

    closeBtn &&
      closeBtn.addEventListener('click', () => {
        if (typeof dlg.close === 'function') dlg.close();
      });

    resetBtn &&
      resetBtn.addEventListener('click', () => {
        const which = columnPickerWhich;
        const vis = which === 'live' ? colVisLive : colVisHist;
        const ids = which === 'live' ? LIVE_COL_IDS : HIST_COL_IDS;
        for (const id of ids) {
          vis[id] = true;
        }
        saveColVis(which);
        syncChooseColumnsCheckboxes();
        applyColumnVisibility(which);
        if (which === 'live') {
          refreshTableAndArcs();
        } else {
          renderHistoryTable();
        }
      });

    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && typeof dlg.close === 'function') dlg.close();
    });
  }

  function parseCreateTimeMs(iso) {
    if (iso == null || iso === '') return null;
    const t = Date.parse(String(iso));
    return Number.isFinite(t) ? t : null;
  }

  function formatCreateTimeLive(iso) {
    const ms = parseCreateTimeMs(iso);
    if (ms == null) return '—';
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatElapsedLive(iso) {
    const ms = parseCreateTimeMs(iso);
    if (ms == null) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}m ${s}s`;
    }
    if (sec < 86400) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${h}h ${m}m ${s}s`;
    }
    const d = Math.floor(sec / 86400);
    const rest = sec % 86400;
    const h = Math.floor(rest / 3600);
    const m = Math.floor((rest % 3600) / 60);
    const s = rest % 60;
    return `${d}d ${h}h ${m}m ${s}s`;
  }

  function syncTableHeaderSortState() {
    const thead = document.querySelector('#live-connections-table thead tr');
    if (!thead) return;
    for (const th of thead.querySelectorAll('th[data-col]')) {
      const col = th.dataset.col;
      th.classList.remove('sort-asc', 'sort-desc');
      if (col === tableSort.key) {
        th.classList.add(tableSort.dir === 'desc' ? 'sort-desc' : 'sort-asc');
        th.setAttribute('aria-sort', tableSort.dir === 'desc' ? 'descending' : 'ascending');
      } else {
        th.setAttribute('aria-sort', 'none');
      }
    }
  }

  function formatRemoteCell(c) {
    const ra = c.remoteAddress != null ? String(c.remoteAddress).trim() : '';
    if (!ra) return '—';
    const rp = c.remotePort;
    if (rp == null || Number.isNaN(Number(rp))) return '—';
    return `${ra}:${rp}`;
  }

  function copyableRemoteAddress(c) {
    return c.remoteAddress != null && String(c.remoteAddress).trim() !== ''
      ? String(c.remoteAddress).trim()
      : '';
  }

  function copyableRemoteHost(c) {
    const h = c.remoteHost != null ? String(c.remoteHost).trim() : '';
    return h && h !== '—' ? h : '';
  }

  let copyToastTimer = null;

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function showCopyToast(message) {
    const el = document.getElementById('copy-toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.add('copy-toast-visible');
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      el.classList.remove('copy-toast-visible');
      el.hidden = true;
      copyToastTimer = null;
    }, 2400);
  }

  function previewForToast(text) {
    const s = String(text);
    return s.length > 52 ? `${s.slice(0, 49)}…` : s;
  }

  /** Strip trailing :port from displayed local/remote cells (IPv4, hostname, or [IPv6]:port). */
  function stripAddressPort(combined) {
    const t = String(combined || '').trim();
    if (!t || t === '—') return '';
    const br = t.match(/^\[([^\]]+)\]:(\d+)$/);
    if (br) return `[${br[1]}]`;
    const lastColon = t.lastIndexOf(':');
    if (lastColon > 0) {
      const tail = t.slice(lastColon + 1);
      if (/^\d+$/.test(tail)) return t.slice(0, lastColon);
    }
    return t;
  }

  const WHOIS_DOMAINTOOLS_BASE = 'https://whois.domaintools.com/';

  function openWhoisDomaintools(query) {
    const q = String(query || '').trim();
    if (!q) return false;
    const url = `${WHOIS_DOMAINTOOLS_BASE}${encodeURIComponent(q)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }

  function getCellCopyText(m, colId) {
    if (colId === 'local') {
      const raw = m.copyLocal != null ? String(m.copyLocal).trim() : '';
      if (raw) return raw;
      return stripAddressPort(m.local);
    }
    if (colId === 'remote') {
      const raw = m.copyRemote != null ? String(m.copyRemote).trim() : '';
      if (raw) return raw;
      return stripAddressPort(m.remote);
    }
    if (colId === 'remoteHost') {
      const raw = m.copyRemoteHost != null ? String(m.copyRemoteHost).trim() : '';
      if (raw) return raw;
      const h = String(m.remoteHost || '').trim();
      return h && h !== '—' ? h : '';
    }
    return '';
  }

  function wireCopyableAddressCell(td, colId, m) {
    if (colId !== 'local' && colId !== 'remote' && colId !== 'remoteHost') return;
    const text = getCellCopyText(m, colId);
    td.classList.add('cell-copyable');
    td.title = text
      ? colId === 'remoteHost'
        ? 'Click to copy · Ctrl+click to open WHOIS'
        : 'Click to copy address (without port) · Ctrl+click to open WHOIS'
      : 'Nothing to copy';
    td.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.ctrlKey) {
        if (!text) {
          showCopyToast('Nothing to look up');
          return;
        }
        openWhoisDomaintools(text);
        return;
      }
      if (!text) {
        showCopyToast('Nothing to copy');
        return;
      }
      const ok = await copyTextToClipboard(text);
      if (ok) showCopyToast(`Copied to clipboard: ${previewForToast(text)}`);
      else showCopyToast('Could not copy to clipboard');
    });
  }

  function connectionRowModel(c, placesByKey) {
    const p = placesByKey.get(c.connectionKey);
    const rh = c.remoteHost != null && String(c.remoteHost).trim() !== '' ? String(c.remoteHost).trim() : '—';
    const createIso = c.createTime != null && String(c.createTime).trim() !== '' ? String(c.createTime).trim() : '';
    const createTimeMs = parseCreateTimeMs(createIso || null);
    const elapsedSec =
      createTimeMs == null ? null : Math.max(0, (Date.now() - createTimeMs) / 1000);
    return {
      connectionKey: c.connectionKey,
      process: c.processName || '?',
      protocol: c.protocol != null && String(c.protocol).trim() !== '' ? String(c.protocol).trim() : 'TCP',
      local: `${c.localAddress}:${c.localPort}`,
      remote: formatRemoteCell(c),
      remoteHost: rh,
      copyLocal: String(c.localAddress || '').trim(),
      copyRemote: copyableRemoteAddress(c),
      copyRemoteHost: copyableRemoteHost(c),
      from: p ? p.start : '—',
      to: p ? p.end : '—',
      pid: c.owningPid != null ? c.owningPid : null,
      pidStr: c.owningPid != null ? String(c.owningPid) : '—',
      createTimeDisplay: formatCreateTimeLive(createIso || null),
      elapsedDisplay: formatElapsedLive(createIso || null),
      createTimeMs,
      elapsedSec,
    };
  }

  function compareConnectionModels(a, b) {
    const key = tableSort.key;
    const dir = tableSort.dir === 'desc' ? -1 : 1;
    if (key === 'pid') {
      const va = a.pid == null ? -1 : a.pid;
      const vb = b.pid == null ? -1 : b.pid;
      return dir * (va - vb);
    }
    if (key === 'createTime') {
      const va = a.createTimeMs == null ? -1 : a.createTimeMs;
      const vb = b.createTimeMs == null ? -1 : b.createTimeMs;
      return dir * (va - vb);
    }
    if (key === 'elapsed') {
      const va = a.elapsedSec == null ? -1 : a.elapsedSec;
      const vb = b.elapsedSec == null ? -1 : b.elapsedSec;
      return dir * (va - vb);
    }
    const va = String(a[key] ?? '').toLowerCase();
    const vb = String(b[key] ?? '').toLowerCase();
    return dir * va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
  }

  function buildMergedArcsList(serverArcs) {
    const list = [...(serverArcs || [])];
    const keys = new Set(list.map((a) => String((a && a.connectionKey) || '')));
    const now = Date.now();
    for (const [k, f] of flashState) {
      if (f.kind === 'removed' && f.removedArc && f.until > now && !keys.has(k)) {
        list.push({ ...f.removedArc });
        keys.add(k);
      }
    }
    return list;
  }

  function buildMergedConnections() {
    const rows = [...(lastConnections || [])];
    const seen = new Set(rows.map((r) => String(r.connectionKey || '')));
    const now = Date.now();
    for (const [k, f] of flashState) {
      if (f.kind === 'removed' && f.removedConn && f.until > now && !seen.has(k)) {
        rows.push({ ...f.removedConn });
        seen.add(k);
      }
    }
    return rows;
  }

  function getLiveProtocolFilter() {
    try {
      const v = localStorage.getItem(LS_PROTOCOL_FILTER_LIVE);
      if (v === 'tcp' || v === 'udp' || v === 'both') return v;
    } catch {
      /* ignore */
    }
    return 'both';
  }

  function getHistoryProtocolFilter() {
    try {
      const v = localStorage.getItem(LS_PROTOCOL_FILTER_HISTORY);
      if (v === 'tcp' || v === 'udp' || v === 'both') return v;
    } catch {
      /* ignore */
    }
    return 'both';
  }

  function filterConnectionsByProtocol(conns, mode) {
    return (conns || []).filter((c) => {
      const p = String(c.protocol || 'TCP').toUpperCase();
      if (mode === 'both') return true;
      if (mode === 'tcp') return p === 'TCP';
      if (mode === 'udp') return p === 'UDP';
      return true;
    });
  }

  function arcProtocolFromItem(a) {
    if (a && a.protocol != null) return String(a.protocol).toUpperCase();
    const ck = String(a.connectionKey || '');
    if (ck.startsWith('UDP|')) return 'UDP';
    return 'TCP';
  }

  function filterArcsByProtocol(arcs, mode) {
    if (mode === 'both') return arcs || [];
    return (arcs || []).filter((a) => {
      const p = arcProtocolFromItem(a);
      if (mode === 'tcp') return p === 'TCP';
      if (mode === 'udp') return p === 'UDP';
      return true;
    });
  }

  /** Count of arcs actually sent to the globe (server arcs + flash ghosts, after protocol filter). */
  function getVisibleArcCount() {
    const mergedA = buildMergedArcsList(lastArcs);
    return filterArcsByProtocol(mergedA, getLiveProtocolFilter()).length;
  }

  function updateArcCountLabel() {
    if (!countEl) return;
    const n = getVisibleArcCount();
    countEl.textContent = n ? `Showing ${n} connection${n === 1 ? '' : 's'}` : 'Showing no connections';
  }

  function refreshTableAndArcs() {
    const mergedA = buildMergedArcsList(lastArcs);
    const mode = getLiveProtocolFilter();
    const filteredA = filterArcsByProtocol(mergedA, mode);
    applyArcs(filteredA);
    const mergedC = buildMergedConnections();
    const filteredC = filterConnectionsByProtocol(mergedC, mode);
    renderConnectionsTable(filteredC, filteredA);
    syncTableRowHighlight();
    updateArcCountLabel();
  }

  function scheduleFlashPrune() {
    if (flashPruneTimer) clearTimeout(flashPruneTimer);
    let nextWake = Infinity;
    const now = Date.now();
    for (const [, f] of flashState) {
      if (f.until > now) nextWake = Math.min(nextWake, f.until);
    }
    if (nextWake === Infinity) {
      flashPruneTimer = null;
      return;
    }
    flashPruneTimer = setTimeout(pruneFlashState, Math.max(40, nextWake - now + 25));
  }

  function pruneFlashState() {
    flashPruneTimer = null;
    const now = Date.now();
    let changed = false;
    for (const [k, f] of flashState) {
      if (f.until <= now) {
        flashState.delete(k);
        changed = true;
      }
    }
    if (changed) {
      refreshTableAndArcs();
    }
    scheduleFlashPrune();
  }

  const TABLE_COL_DEFS = [
    { id: 'pid', mono: true, origin: false },
    { id: 'process', mono: false, origin: false },
    { id: 'protocol', mono: true, origin: false },
    { id: 'local', mono: true, origin: true },
    { id: 'remote', mono: true, origin: false },
    { id: 'remoteHost', mono: false, origin: false },
    { id: 'from', mono: false, origin: true },
    { id: 'to', mono: false, origin: false },
  ];

  const LIVE_EXTRA_COL_DEFS = [
    { id: 'createTime', mono: true, origin: false },
    { id: 'elapsed', mono: false, origin: false },
  ];

  function formatHistoryTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function getHistoryMaxFromUi() {
    const inp = document.getElementById('history-max-rows');
    if (!inp) return 500;
    let n = parseInt(String(inp.value), 10);
    if (!Number.isFinite(n)) n = 500;
    return Math.max(1, Math.min(50000, n));
  }

  function trimHistory() {
    const max = getHistoryMaxFromUi();
    while (connectionHistory.length > max) {
      connectionHistory.pop();
    }
  }

  function appendHistoryEvent(kind, conn, arc) {
    if (!conn) return;
    const from = arc && arc.startPlace ? String(arc.startPlace) : '—';
    const to = arc && arc.endPlace ? String(arc.endPlace) : '—';
    const rh =
      conn.remoteHost != null && String(conn.remoteHost).trim() !== ''
        ? String(conn.remoteHost).trim()
        : '—';
    connectionHistory.unshift({
      ts: Date.now(),
      event: kind === 'disconnect' ? 'disconnect' : 'connect',
      process: conn.processName || '?',
      protocol: conn.protocol != null && String(conn.protocol).trim() !== '' ? String(conn.protocol).trim() : 'TCP',
      local: `${conn.localAddress}:${conn.localPort}`,
      remote: formatRemoteCell(conn),
      remoteHost: rh,
      copyLocal: String(conn.localAddress || '').trim(),
      copyRemote: copyableRemoteAddress(conn),
      copyRemoteHost: copyableRemoteHost(conn),
      from,
      to,
      pid: conn.owningPid != null ? conn.owningPid : null,
      pidStr: conn.owningPid != null ? String(conn.owningPid) : '—',
    });
    trimHistory();
    renderHistoryTable();
  }

  function compareHistoryModels(a, b) {
    const key = historyTableSort.key;
    const dir = historyTableSort.dir === 'desc' ? -1 : 1;
    if (key === 'time') {
      return dir * (a.ts - b.ts);
    }
    if (key === 'pid') {
      const va = a.pid == null ? -1 : a.pid;
      const vb = b.pid == null ? -1 : b.pid;
      return dir * (va - vb);
    }
    const va = String(a[key] ?? '').toLowerCase();
    const vb = String(b[key] ?? '').toLowerCase();
    return dir * va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
  }

  function syncHistoryTableHeaderSortState() {
    const thead = document.querySelector('#history-connections-table thead tr');
    if (!thead) return;
    for (const th of thead.querySelectorAll('th[data-col]')) {
      const col = th.dataset.col;
      th.classList.remove('sort-asc', 'sort-desc');
      if (col === historyTableSort.key) {
        th.classList.add(historyTableSort.dir === 'desc' ? 'sort-desc' : 'sort-asc');
        th.setAttribute('aria-sort', historyTableSort.dir === 'desc' ? 'descending' : 'ascending');
      } else {
        th.setAttribute('aria-sort', 'none');
      }
    }
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;

    const rawLen = connectionHistory.length;
    let rows = filterConnectionsByProtocol([...connectionHistory], getHistoryProtocolFilter());
    rows.sort(compareHistoryModels);

    const visibleColCount = countVisibleCols('history');

    tbody.replaceChildren();

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = visibleColCount;
      td.className = 'connections-empty';
      td.textContent =
        rawLen === 0
          ? 'No connection events yet.'
          : 'No events match the protocol filter.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      syncHistoryTableHeaderSortState();
      applyColumnVisibility('history');
      return;
    }

    function appendCell(tr, colDef, text, rowModel) {
      const td = document.createElement('td');
      td.setAttribute('data-col', colDef.id);
      if (colDef.mono) td.classList.add('mono');
      if (colDef.origin) td.classList.add('col-origin');
      td.textContent = text;
      wireCopyableAddressCell(td, colDef.id, rowModel);
      tr.appendChild(td);
    }

    for (const m of rows) {
      const tr = document.createElement('tr');

      const tdTime = document.createElement('td');
      tdTime.setAttribute('data-col', 'time');
      tdTime.classList.add('mono');
      tdTime.textContent = formatHistoryTime(m.ts);
      tr.appendChild(tdTime);

      const tdEv = document.createElement('td');
      tdEv.setAttribute('data-col', 'event');
      tdEv.textContent = m.event;
      tr.appendChild(tdEv);

      for (const col of TABLE_COL_DEFS) {
        const field = col.id === 'pid' ? 'pidStr' : col.id;
        appendCell(tr, col, m[field], m);
      }
      tbody.appendChild(tr);
    }

    syncHistoryTableHeaderSortState();
    applyColumnVisibility('history');
  }

  function initHistoryTableUi() {
    const histColsBtn = document.getElementById('history-choose-columns');
    histColsBtn && histColsBtn.addEventListener('click', () => openChooseColumnsDialog('history'));

    const maxInp = document.getElementById('history-max-rows');
    if (maxInp) {
      const saved = parseInt(localStorage.getItem(LS_HISTORY_MAX_ROWS) || '', 10);
      if (Number.isFinite(saved) && saved >= 1 && saved <= 50000) {
        maxInp.value = String(saved);
      } else {
        maxInp.value = '2000';
      }
      trimHistory();
      maxInp.addEventListener('change', () => {
        const n = getHistoryMaxFromUi();
        maxInp.value = String(n);
        localStorage.setItem(LS_HISTORY_MAX_ROWS, String(n));
        trimHistory();
        renderHistoryTable();
      });
    }

    const clearBtn = document.getElementById('history-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        connectionHistory = [];
        renderHistoryTable();
      });
    }

    const thead = document.querySelector('#history-connections-table thead');
    if (thead) {
      thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        const col = th.dataset.col;
        if (historyTableSort.key === col) {
          historyTableSort.dir = historyTableSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          historyTableSort.key = col;
          historyTableSort.dir = 'asc';
        }
        localStorage.setItem(LS_HISTORY_SORT_KEY, historyTableSort.key);
        localStorage.setItem(LS_HISTORY_SORT_DIR, historyTableSort.dir);
        renderHistoryTable();
      });
      thead.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        e.preventDefault();
        th.click();
      });
    }

    applyColumnVisibility('history');
    syncHistoryTableHeaderSortState();
    renderHistoryTable();
  }

  function initProtocolFilters() {
    const liveMode = getLiveProtocolFilter();
    for (const inp of document.querySelectorAll('input[name="live-protocol-filter"]')) {
      if (inp instanceof HTMLInputElement) {
        inp.checked = inp.value === liveMode;
        inp.addEventListener('change', () => {
          if (!inp.checked) return;
          try {
            localStorage.setItem(LS_PROTOCOL_FILTER_LIVE, inp.value);
          } catch {
            /* ignore */
          }
          refreshTableAndArcs();
        });
      }
    }

    const histMode = getHistoryProtocolFilter();
    for (const inp of document.querySelectorAll('input[name="history-protocol-filter"]')) {
      if (inp instanceof HTMLInputElement) {
        inp.checked = inp.value === histMode;
        inp.addEventListener('change', () => {
          if (!inp.checked) return;
          try {
            localStorage.setItem(LS_PROTOCOL_FILTER_HISTORY, inp.value);
          } catch {
            /* ignore */
          }
          renderHistoryTable();
        });
      }
    }
  }

  function initPanelTabs() {
    const liveTab = document.getElementById('tab-live');
    const histTab = document.getElementById('tab-history');
    const livePanel = document.getElementById('panel-live');
    const histPanel = document.getElementById('panel-history');
    if (!liveTab || !histTab || !livePanel || !histPanel) return;

    function selectTab(which) {
      const live = which === 'live';
      liveTab.setAttribute('aria-selected', live ? 'true' : 'false');
      histTab.setAttribute('aria-selected', live ? 'false' : 'true');
      liveTab.tabIndex = live ? 0 : -1;
      histTab.tabIndex = live ? -1 : 0;
      livePanel.hidden = !live;
      histPanel.hidden = live;
      try {
        localStorage.setItem(LS_DRAWER_TAB, live ? 'live' : 'history');
      } catch {
        /* ignore */
      }
    }

    liveTab.addEventListener('click', () => selectTab('live'));
    histTab.addEventListener('click', () => selectTab('history'));

    const saved = localStorage.getItem(LS_DRAWER_TAB);
    selectTab(saved === 'history' ? 'history' : 'live');
  }

  function initConnectionsTableUi() {
    const liveColsBtn = document.getElementById('live-choose-columns');
    liveColsBtn && liveColsBtn.addEventListener('click', () => openChooseColumnsDialog('live'));

    const thead = document.querySelector('#live-connections-table thead');
    if (thead) {
      thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        const col = th.dataset.col;
        if (tableSort.key === col) {
          tableSort.dir = tableSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          tableSort.key = col;
          tableSort.dir = 'asc';
        }
        localStorage.setItem(LS_SORT_KEY, tableSort.key);
        localStorage.setItem(LS_SORT_DIR, tableSort.dir);
        refreshTableAndArcs();
      });
      thead.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        e.preventDefault();
        th.click();
      });
    }

    applyColumnVisibility('live');
    syncTableHeaderSortState();
  }

  function setLinkedHighlight(key) {
    linkedHighlightKey = key != null && key !== '' ? String(key) : null;
    syncArcStylesAndData();
    syncTableRowHighlight();
  }

  function clearLinkedHighlightIf(key) {
    const k = key != null ? String(key) : '';
    if (linkedHighlightKey === k) setLinkedHighlight(null);
  }

  world.onArcHover((arc) => {
    if (!arc) {
      setLinkedHighlight(null);
      return;
    }
    const key = arc.connectionKey || arc.__connectionKey;
    setLinkedHighlight(key != null ? String(key) : null);
  });

  function stableConnectionKey(arc) {
    if (arc && typeof arc.connectionKey === 'string' && arc.connectionKey.length) {
      return arc.connectionKey;
    }
    if (arc && typeof arc.label === 'string' && arc.label.length) return arc.label;
    return ['startLat', 'startLng', 'endLat', 'endLng']
      .map((k) => arc[k])
      .join('|');
  }

  function applyArcs(incoming) {
    const next = Array.isArray(incoming) ? incoming : [];
    const nextKeys = new Set();

    for (const item of next) {
      const key = stableConnectionKey(item);
      nextKeys.add(key);
      let arc = arcByKey.get(key);
      if (arc) {
        arc.startLat = item.startLat;
        arc.startLng = item.startLng;
        arc.endLat = item.endLat;
        arc.endLng = item.endLng;
        if (item.connectionKey != null) arc.connectionKey = item.connectionKey;
        if (item.label != null) arc.label = item.label;
        if (item.remoteCountry != null) arc.remoteCountry = item.remoteCountry;
        if (item.startPlace != null) arc.startPlace = item.startPlace;
        if (item.endPlace != null) arc.endPlace = item.endPlace;
        if (item.protocol != null) arc.protocol = item.protocol;
      } else {
        arc = {
          __connectionKey: key,
          connectionKey: item.connectionKey || key,
          startLat: item.startLat,
          startLng: item.startLng,
          endLat: item.endLat,
          endLng: item.endLng,
          label: item.label,
          remoteCountry: item.remoteCountry,
          startPlace: item.startPlace,
          endPlace: item.endPlace,
          protocol: item.protocol,
        };
        arcByKey.set(key, arc);
      }
    }

    for (const key of arcByKey.keys()) {
      if (!nextKeys.has(key)) arcByKey.delete(key);
    }

    if (linkedHighlightKey != null && !arcByKey.has(linkedHighlightKey)) {
      linkedHighlightKey = null;
    }

    syncArcStylesAndData();
    syncTableRowHighlight();
  }

  function setError(msg) {
    if (msg) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
  }

  function renderConnectionsTable(connections, arcs) {
    const tbody = document.getElementById('connections-tbody');
    if (!tbody) return;

    const placesByKey = new Map();
    for (const a of arcs || []) {
      if (a && a.connectionKey) {
        placesByKey.set(a.connectionKey, {
          start: a.startPlace || '—',
          end: a.endPlace || '—',
        });
      }
    }

    const models = (connections || []).map((c) => connectionRowModel(c, placesByKey));
    models.sort(compareConnectionModels);

    const visibleColCount = countVisibleCols('live');

    tbody.replaceChildren();

    if (models.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = visibleColCount;
      td.className = 'connections-empty';
      td.textContent = 'No connections.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      syncTableHeaderSortState();
      applyColumnVisibility('live');
      return;
    }

    function appendCell(tr, colDef, text, copyModel) {
      const td = document.createElement('td');
      td.setAttribute('data-col', colDef.id);
      if (colDef.mono) td.classList.add('mono');
      if (colDef.origin) td.classList.add('col-origin');
      td.textContent = text;
      wireCopyableAddressCell(td, colDef.id, copyModel);
      tr.appendChild(td);
    }

    const nowMs = Date.now();

    for (const m of models) {
      const tr = document.createElement('tr');
      const ck = m.connectionKey != null ? String(m.connectionKey) : '';
      if (ck) tr.setAttribute('data-connection-key', ck);

      const fk = ck ? flashState.get(ck) : null;
      if (fk && fk.until > nowMs) {
        if (fk.kind === 'new') tr.classList.add('row-flash-new');
        if (fk.kind === 'removed') tr.classList.add('row-flash-removed');
      }

      for (const col of TABLE_COL_DEFS) {
        const field = col.id === 'pid' ? 'pidStr' : col.id;
        appendCell(tr, col, m[field], m);
      }
      for (const col of LIVE_EXTRA_COL_DEFS) {
        const text = col.id === 'createTime' ? m.createTimeDisplay : m.elapsedDisplay;
        appendCell(tr, col, text, m);
      }
      tbody.appendChild(tr);

      if (ck) {
        tr.addEventListener('mouseenter', () => setLinkedHighlight(ck));
        tr.addEventListener('mouseleave', () => clearLinkedHighlightIf(ck));
      }
    }

    syncTableHeaderSortState();
    applyColumnVisibility('live');
    syncTableRowHighlight();
  }

  function handlePayload(data) {
    if (data.error) {
      setError(data.error);
      flashState.clear();
      if (flashPruneTimer) {
        clearTimeout(flashPruneTimer);
        flashPruneTimer = null;
      }
      lastConnections = data.connections || [];
      lastArcs = data.arcs || [];
      refreshTableAndArcs();
      statusEl.textContent = data.updatedAt
        ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`
        : 'Live';
      return;
    }
    setError('');

    const prevConn = lastConnections || [];
    const prevKeys = new Set(prevConn.map((c) => String(c.connectionKey || '')));
    const nextConn = data.connections || [];
    const nextArcs = data.arcs || [];
    const nextKeys = new Set(nextConn.map((c) => String(c.connectionKey || '')));
    const until = Date.now() + FLASH_MS;
    const isInitial = prevKeys.size === 0 && prevConn.length === 0;

    if (!isInitial) {
      const arcByKeyNext = new Map();
      for (const a of nextArcs) {
        if (a && a.connectionKey != null) arcByKeyNext.set(String(a.connectionKey), a);
      }

      for (const k of nextKeys) {
        if (!prevKeys.has(k)) {
          flashState.set(k, { kind: 'new', until });
          const conn = nextConn.find((c) => String(c.connectionKey) === k);
          if (conn) {
            appendHistoryEvent('connect', { ...conn }, arcByKeyNext.get(k) || null);
          }
        }
      }
      for (const k of prevKeys) {
        if (!nextKeys.has(k)) {
          const conn = prevConn.find((c) => String(c.connectionKey) === k);
          const pa = lastArcs || [];
          const arc = pa.find((a) => a && String(a.connectionKey) === k);
          const isUdp = conn && String(conn.protocol || '').toUpperCase() === 'UDP';
          if (conn && (arc || isUdp)) {
            if (arc) {
              flashState.set(k, {
                kind: 'removed',
                until,
                removedConn: { ...conn },
                removedArc: { ...arc },
              });
            } else {
              flashState.set(k, {
                kind: 'removed',
                until,
                removedConn: { ...conn },
              });
            }
            appendHistoryEvent('disconnect', { ...conn }, arc ? { ...arc } : null);
          }
        }
      }
    }

    lastConnections = nextConn;
    lastArcs = nextArcs;

    refreshTableAndArcs();
    scheduleFlashPrune();

    statusEl.textContent = data.updatedAt
      ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`
      : 'Live';
  }

  function applyPollIntervalFromServer(ms) {
    const n = Number(ms);
    if (!POLL_MS_OPTIONS.includes(n)) return;
    const sel = document.getElementById('poll-interval');
    if (sel) sel.value = String(n);
    localStorage.setItem(LS_POLL_MS, String(n));
  }

  function initPollIntervalControl() {
    const sel = document.getElementById('poll-interval');
    if (!sel) return;
    const saved = localStorage.getItem(LS_POLL_MS);
    if (saved && POLL_MS_OPTIONS.includes(Number(saved))) {
      sel.value = saved;
    }
    sel.addEventListener('change', () => {
      const ms = Number(sel.value);
      if (!POLL_MS_OPTIONS.includes(ms)) return;
      localStorage.setItem(LS_POLL_MS, String(ms));
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'setPollMs', ms }));
      }
    });
  }

  let ws;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      statusEl.textContent = 'Live';
      const saved = localStorage.getItem(LS_POLL_MS);
      if (saved && POLL_MS_OPTIONS.includes(Number(saved))) {
        ws.send(JSON.stringify({ type: 'setPollMs', ms: Number(saved) }));
      }
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && data.type === 'config' && data.pollMs != null) {
          applyPollIntervalFromServer(data.pollMs);
          return;
        }
        handlePayload(data);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      statusEl.textContent = 'Reconnecting…';
      setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      statusEl.textContent = 'Connection error';
    };
  }

  initPollIntervalControl();
  initConnectionsTableUi();
  initHistoryTableUi();
  initPanelTabs();
  initChooseColumnsDialog();
  initProtocolFilters();
  applyAllColumnVisibility();
  connect();

  const drawer = document.getElementById('drawer');
  const drawerTab = document.getElementById('drawer-tab');
  const drawerClose = document.getElementById('drawer-close');
  const drawerPanel = document.getElementById('drawer-panel');

  const DRAWER_W_MIN = 500;
  const DRAWER_W_MAX = 1400;
  const DRAWER_W_STORAGE = 'netstatGlobeDrawerWidth';
  /** Minimum width (px) reserved for the globe beside the drawer (panel + tab). */
  const GLOBE_AREA_MIN_PX = 330;

  function getDrawerTabWidthPx() {
    const tab = document.getElementById('drawer-tab');
    return tab ? tab.getBoundingClientRect().width : 36;
  }

  function maxDrawerPanelWidthPx() {
    const shell = document.querySelector('.app-shell');
    const vw = shell ? shell.clientWidth : window.innerWidth;
    const tabW = getDrawerTabWidthPx();
    const maxPanel = vw - GLOBE_AREA_MIN_PX - tabW - 1;
    return Math.max(0, Math.min(DRAWER_W_MAX, Math.floor(maxPanel)));
  }

  function clampDrawerWidth(px) {
    const maxAllowed = maxDrawerPanelWidthPx();
    const minAllowed = Math.min(DRAWER_W_MIN, maxAllowed);
    const w = Math.round(px);
    return Math.min(DRAWER_W_MAX, maxAllowed, Math.max(minAllowed, w));
  }

  function getDrawerPanelWidthCssPx() {
    if (!drawer) return 420;
    const raw = drawer.style.getPropertyValue('--drawer-width').trim();
    let v = parseFloat(raw);
    if (Number.isFinite(v)) return v;
    const cs = getComputedStyle(drawer).getPropertyValue('--drawer-width').trim();
    v = parseFloat(cs);
    return Number.isFinite(v) ? v : 420;
  }

  function enforceDrawerWithinGlobeLimit() {
    if (!drawer || drawer.dataset.open !== 'true') return;
    const maxW = maxDrawerPanelWidthPx();
    const current = getDrawerPanelWidthCssPx();
    if (current <= maxW) return;
    drawer.style.setProperty('--drawer-width', `${maxW}px`);
    try {
      localStorage.setItem(DRAWER_W_STORAGE, String(Math.round(maxW)));
    } catch {
      /* ignore */
    }
    layoutGlobe();
  }

  if (drawer) {
    const saved = parseInt(localStorage.getItem(DRAWER_W_STORAGE), 10);
    if (Number.isFinite(saved)) {
      drawer.style.setProperty('--drawer-width', `${clampDrawerWidth(saved)}px`);
    }

    function setDrawerOpen(open) {
      drawer.dataset.open = open ? 'true' : 'false';
      if (drawerTab) {
        drawerTab.setAttribute('aria-expanded', open ? 'true' : 'false');
        drawerTab.title = open ? 'Hide connections' : 'Show connections';
      }
      requestAnimationFrame(() => {
        enforceDrawerWithinGlobeLimit();
        layoutGlobe();
        requestAnimationFrame(layoutGlobe);
      });
    }

    drawerTab &&
      drawerTab.addEventListener('click', () => {
        setDrawerOpen(drawer.dataset.open !== 'true');
      });
    drawerClose &&
      drawerClose.addEventListener('click', () => {
        setDrawerOpen(false);
      });

    const resizeEl = drawer.querySelector('.drawer-resize');
    if (resizeEl && drawerPanel) {
      resizeEl.addEventListener('mousedown', (e) => {
        if (drawer.dataset.open !== 'true') return;
        e.preventDefault();
        drawer.dataset.resizing = 'true';
        const startX = e.clientX;
        const startW = drawerPanel.getBoundingClientRect().width;

        function onMove(e2) {
          const dx = startX - e2.clientX;
          const next = clampDrawerWidth(startW + dx);
          drawer.style.setProperty('--drawer-width', `${next}px`);
          layoutGlobe();
        }

        function onUp() {
          drawer.dataset.resizing = 'false';
          const w = drawerPanel.getBoundingClientRect().width;
          localStorage.setItem(DRAWER_W_STORAGE, String(Math.round(w)));
          layoutGlobe();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  window.addEventListener('resize', () => {
    enforceDrawerWithinGlobeLimit();
    layoutGlobe();
  });

  if (globeStage && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => layoutGlobe());
    ro.observe(globeStage);
  }

  layoutGlobe();

  world.pointOfView(loadSavedPov() || DEFAULT_POV, 0);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      povPersistenceReady = true;
    });
  });
})();
