/**
 * Netstat Globe — web server: TCP/UDP connections → geolocated arcs on a 3D globe.
 * Windows: PowerShell Get-NetTCPConnection / Get-NetUDPEndpoint.
 * Linux / macOS: `lsof` when available; on Linux, `ss` (iproute2) is used if `lsof` is not installed.
 */
const http = require('http');
const path = require('path');
const dns = require('dns').promises;
const express = require('express');
const { WebSocketServer } = require('ws');
const { execFile } = require('child_process');
const { fetchPepwaveConnectionRows } = require('./pepwave');

const PORT = Number(process.env.PORT) || 3847;

/** Allowed WebSocket poll intervals (ms); must match client dropdown. */
const ALLOWED_POLL_MS = [500, 1000, 2000, 3000, 5000, 10000, 30000];

function normalizePollMs(ms) {
  const n = Number(ms);
  if (ALLOWED_POLL_MS.includes(n)) return n;
  const t = Number.isFinite(n) ? n : 3000;
  return ALLOWED_POLL_MS.reduce((best, a) =>
    Math.abs(a - t) < Math.abs(best - t) ? a : best
  );
}

let currentPollMs = normalizePollMs(process.env.POLL_MS || 3000);

/** @type {'local' | 'pepwave'} */
let connectionSource = 'local';
/** @type {{ host: string, username: string, password: string, sshPort?: number } | null} */
let pepwaveConfig = null;

function normalizeConnectionSource(v) {
  return v === 'pepwave' ? 'pepwave' : 'local';
}

function applyConnectionSource(source, config) {
  connectionSource = normalizeConnectionSource(source);
  if (connectionSource === 'pepwave' && config && typeof config === 'object') {
    const host = config.host != null ? String(config.host).trim() : '';
    const username = config.username != null ? String(config.username) : '';
    const password = config.password != null ? String(config.password) : '';
    if (!host || !username) {
      pepwaveConfig = null;
      connectionSource = 'local';
      return;
    }
    let sshPort = Number(config.sshPort);
    if (!Number.isFinite(sshPort) || sshPort <= 0) sshPort = 8822;
    pepwaveConfig = {
      host,
      username,
      password,
      sshPort,
    };
  } else {
    pepwaveConfig = null;
    if (connectionSource === 'pepwave') connectionSource = 'local';
  }
}

async function runConnectionSourceQuery() {
  if (connectionSource === 'pepwave' && pepwaveConfig) {
    return fetchPepwaveConnectionRows(pepwaveConfig);
  }
  return runNetConnections();
}

const IP_API_BATCH =
  'http://ip-api.com/batch?fields=status,message,country,countryCode,lat,lon,query,city,regionName';

const app = express();

const geoCache = new Map();
/** @type {Map<string, string>} resolved PTR name per remote IP (or "—") */
const remoteHostnameCache = new Map();
let userGeo = null;

async function reverseLookupHostname(ip, ms = 750) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
    if (Array.isArray(names) && names[0]) {
      const n = String(names[0]).trim();
      return n || '—';
    }
  } catch {
    /* no PTR, timeout, or invalid */
  }
  return '—';
}

async function resolveRemoteHostnames(ips) {
  const unique = [...new Set(ips)].filter((ip) => ip && !remoteHostnameCache.has(ip));
  const chunk = 32;
  for (let i = 0; i < unique.length; i += chunk) {
    const part = unique.slice(i, i + chunk);
    await Promise.all(
      part.map(async (ip) => {
        const h = await reverseLookupHostname(ip);
        remoteHostnameCache.set(ip, h);
      })
    );
  }
}

function isLoopback(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const lower = ip.toLowerCase();
  return lower === '127.0.0.1' || lower === '::1' || lower.startsWith('127.');
}

function isPrivateOrReservedIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** True when Get-NetUDPEndpoint has no specific remote (wildcard / unspecified). */
function isUdpUnspecifiedRemote(ra, rp) {
  const s = String(ra || '')
    .trim()
    .toLowerCase();
  if (!s || s === '*' || s === '0.0.0.0' || s === '::' || s === '[::]' || s === '::0') {
    return true;
  }
  if (Number.isNaN(Number(rp)) || Number(rp) === 0) return true;
  return false;
}

function isPublicRemote(ip) {
  if (!ip || ip === '*' || ip === '0.0.0.0') return false;
  if (isLoopback(ip)) return false;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return false;
    if (lower === '::') return false;
    return true;
  }
  return !isPrivateOrReservedIPv4(ip);
}

/** Human-readable place from ip-api fields (city, region, country). */
function formatGeoPlace(g) {
  if (!g || typeof g !== 'object') return 'Unknown';
  const city = String(g.city || '').trim();
  const region = String(g.regionName || g.region || '').trim();
  const country = String(g.country || g.countryCode || '').trim();
  const parts = [];
  if (city) parts.push(city);
  if (region) parts.push(region);
  if (country) parts.push(country);
  if (parts.length) return parts.join(', ');
  return 'Unknown';
}

function geoFromApiItem(item) {
  return {
    lat: item.lat,
    lon: item.lon,
    country: item.country || item.countryCode || '',
    countryCode: item.countryCode || '',
    city: item.city ? String(item.city) : '',
    regionName: item.regionName ? String(item.regionName) : '',
    placeName: formatGeoPlace(item),
  };
}

function runPowerShellNetConnections() {
  return new Promise((resolve, reject) => {
    const script = `
$ProgressPreference = 'SilentlyContinue'
$procCache = @{}

function Get-ProcessNameCached($procId) {
  if (-not $procCache.ContainsKey($procId)) {
    try { $procCache[$procId] = (Get-Process -Id $procId -ErrorAction Stop).ProcessName }
    catch { $procCache[$procId] = '?' }
  }
  return $procCache[$procId]
}

$tcpData = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object {
  $r = $_
  $procId = $r.OwningProcess
  $procName = Get-ProcessNameCached $procId
  $creationIso = $null
  if ($null -ne $r.CreationTime) {
    try { $creationIso = $r.CreationTime.ToUniversalTime().ToString('o') } catch { }
  }
  [PSCustomObject]@{
    Transport = 'TCP'
    LocalAddress = $r.LocalAddress
    LocalPort = $r.LocalPort
    RemoteAddress = $r.RemoteAddress
    RemotePort = $r.RemotePort
    OwningProcess = $procId
    ProcessName = $procName
    CreationTimeUtc = $creationIso
  }
})

$udpData = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object {
  $u = $_
  $procId = $u.OwningProcess
  $procName = Get-ProcessNameCached $procId
  $creationIso = $null
  if ($null -ne $u.CreationTime) {
    try { $creationIso = $u.CreationTime.ToUniversalTime().ToString('o') } catch { }
  }
  $rAddr = ''
  if ($null -ne $u.RemoteAddress) { try { $rAddr = [string]$u.RemoteAddress } catch { } }
  $rPort = 0
  if ($null -ne $u.RemotePort) { try { $rPort = [int]$u.RemotePort } catch { } }
  [PSCustomObject]@{
    Transport = 'UDP'
    LocalAddress = $u.LocalAddress
    LocalPort = $u.LocalPort
    RemoteAddress = $rAddr
    RemotePort = $rPort
    OwningProcess = $procId
    ProcessName = $procName
    CreationTimeUtc = $creationIso
  }
})

@($tcpData) + @($udpData) | ConvertTo-Json -Compress -Depth 4
`.trim();

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        try {
          const text = (stdout || '').trim();
          if (!text) {
            resolve([]);
            return;
          }
          const data = JSON.parse(text);
          const rows = Array.isArray(data) ? data : [data];
          resolve(rows);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/** Strip IPv6 zone index (fe80::1%en0) for consistent keys and geo. */
function normalizeEndpointHost(host) {
  let h = String(host || '').trim();
  if (!h) return h;
  const pct = h.indexOf('%');
  if (pct !== -1) h = h.slice(0, pct);
  return h;
}

/** Parse host:port from lsof NAME segment (supports [IPv6]:port). */
function parseHostPort(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const close = s.indexOf(']:');
    if (close === -1) return null;
    const inner = s.slice(1, close);
    const portStr = s.slice(close + 2);
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port)) return null;
    return { host: inner, port };
  }
  const lastColon = s.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const host = s.slice(0, lastColon);
  const portStr = s.slice(lastColon + 1);
  if (!/^\d+$/.test(portStr)) return null;
  const port = parseInt(portStr, 10);
  return { host, port };
}

/**
 * @param {'reject' | 'null-on-missing'} onMissing
 */
function execProbe(cmd, args, onMissing = 'reject') {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 1) {
          resolve('');
          return;
        }
        if (err.code === 'ENOENT' && onMissing === 'null-on-missing') {
          resolve(null);
          return;
        }
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `${cmd} not found. Install it (e.g. apt install lsof, brew install lsof) or use a system with ${cmd} in PATH.`
            )
          );
          return;
        }
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function execLsof(args) {
  return execProbe('lsof', args, 'reject');
}

function execSs(args) {
  return new Promise((resolve, reject) => {
    execFile('ss', args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 1) {
          resolve('');
          return;
        }
        if (err.code === 'ENOENT') {
          reject(new Error('ss (iproute2) not found'));
          return;
        }
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/** Content before optional `users:(("name",pid=...` on an ss line. */
function ssBeforeUsers(trimmed) {
  const idx = trimmed.indexOf('users:');
  return idx === -1 ? trimmed.trim() : trimmed.slice(0, idx).trim();
}

function parseSsAddrPairAfterQty(beforeUsers) {
  const m = beforeUsers.match(/^\S+\s+\d+\s+\d+\s+(.+?)\s+(\S+)\s*$/);
  if (!m) return null;
  return { localSpec: m[1].trim(), peerSpec: m[2].trim() };
}

function ssParseUsersBlock(trimmed) {
  const usersM = trimmed.match(/users:\(\("([^"]*)",pid=(\d+)/);
  if (!usersM) {
    return { processName: '?', pid: null };
  }
  return {
    processName: usersM[1] || '?',
    pid: parseInt(usersM[2], 10),
  };
}

function isSsUdpPeerUnspecified(peerSpec) {
  const t = String(peerSpec || '').trim().toLowerCase();
  if (!t || t === '*:*' || t === '[::]:*' || t === '0.0.0.0:*' || t === ':::*') return true;
  if (t.includes('*') && t.includes(':')) {
    const afterColon = t.slice(t.lastIndexOf(':') + 1);
    if (afterColon === '*' || afterColon === '0') return true;
  }
  const p = parseHostPort(peerSpec);
  if (!p) return true;
  const h = String(p.host || '').toLowerCase();
  if (h === '*' || h === '0.0.0.0' || h === '::' || p.port === 0) return true;
  return false;
}

function parseSsTcpEstablishedLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !/^ESTAB/i.test(trimmed)) return null;

  const { processName, pid } = ssParseUsersBlock(trimmed);
  const beforeUsers = ssBeforeUsers(trimmed);
  const pair = parseSsAddrPairAfterQty(beforeUsers);
  if (!pair) return null;

  const local = parseHostPort(pair.localSpec);
  const remote = parseHostPort(pair.peerSpec);
  if (!local || !remote || local.port == null || remote.port == null) return null;

  return {
    Transport: 'TCP',
    LocalAddress: normalizeEndpointHost(local.host),
    LocalPort: local.port,
    RemoteAddress: normalizeEndpointHost(remote.host),
    RemotePort: remote.port,
    OwningProcess: Number.isFinite(pid) ? pid : null,
    ProcessName: processName,
    CreationTimeUtc: null,
  };
}

function parseSsUdpLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const { processName, pid } = ssParseUsersBlock(trimmed);
  const beforeUsers = ssBeforeUsers(trimmed);
  const pair = parseSsAddrPairAfterQty(beforeUsers);
  if (!pair) return null;

  const state = trimmed.split(/\s+/)[0].toUpperCase();
  const local = parseHostPort(pair.localSpec);
  if (!local || local.port == null) return null;

  if (state === 'ESTAB' || state === 'ESTABLISHED') {
    const remote = parseHostPort(pair.peerSpec);
    if (!remote || remote.port == null) return null;
    return {
      Transport: 'UDP',
      LocalAddress: normalizeEndpointHost(local.host),
      LocalPort: local.port,
      RemoteAddress: normalizeEndpointHost(remote.host),
      RemotePort: remote.port,
      OwningProcess: Number.isFinite(pid) ? pid : null,
      ProcessName: processName,
      CreationTimeUtc: null,
    };
  }

  if (isSsUdpPeerUnspecified(pair.peerSpec)) {
    return {
      Transport: 'UDP',
      LocalAddress: normalizeEndpointHost(local.host),
      LocalPort: local.port,
      RemoteAddress: '',
      RemotePort: null,
      OwningProcess: Number.isFinite(pid) ? pid : null,
      ProcessName: processName,
      CreationTimeUtc: null,
    };
  }

  const remote = parseHostPort(pair.peerSpec);
  if (!remote || remote.port == null) return null;
  return {
    Transport: 'UDP',
    LocalAddress: normalizeEndpointHost(local.host),
    LocalPort: local.port,
    RemoteAddress: normalizeEndpointHost(remote.host),
    RemotePort: remote.port,
    OwningProcess: Number.isFinite(pid) ? pid : null,
    ProcessName: processName,
    CreationTimeUtc: null,
  };
}

function parseSsTcpToNetRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const row = parseSsTcpEstablishedLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

function parseSsUdpToNetRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const row = parseSsUdpLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

async function runLinuxSsConnections() {
  const [tcpOut, udpOut] = await Promise.all([
    execSs(['-H', '-tanp', '-n', 'state', 'established']),
    execSs(['-H', '-uanp', '-n']),
  ]);
  return [...parseSsTcpToNetRows(tcpOut), ...parseSsUdpToNetRows(udpOut)];
}

async function runUnixNetConnections() {
  if (process.platform === 'linux') {
    const [tcpOut, udpOut] = await Promise.all([
      execProbe('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED'], 'null-on-missing'),
      execProbe('lsof', ['-nP', '-iUDP'], 'null-on-missing'),
    ]);
    if (tcpOut !== null && udpOut !== null) {
      return parseLsofToNetRows(`${tcpOut}\n${udpOut}`);
    }
    try {
      return await runLinuxSsConnections();
    } catch (e) {
      throw new Error(
        `On Linux, install lsof or iproute2 (ss). ${String(e.message || e)}`
      );
    }
  }

  const [tcpOut, udpOut] = await Promise.all([
    execLsof(['-nP', '-iTCP', '-sTCP:ESTABLISHED']),
    execLsof(['-nP', '-iUDP']),
  ]);
  return parseLsofToNetRows(`${tcpOut}\n${udpOut}`);
}

function parseLsofLine(line) {
  const trimmed = line.trim();
  if (!trimmed || /^COMMAND\s/.test(trimmed)) return null;

  const m = trimmed.match(/\s(TCP|UDP)\s+(.+)$/i);
  if (!m) return null;
  const proto = m[1].toUpperCase();
  let rest = m[2].trim().replace(/\s*\([^)]*\)\s*$/, '').trim();

  const head = trimmed.match(/^(\S+)\s+(\d+)\s+/);
  if (!head) return null;
  const processName = head[1] || '?';
  const pid = parseInt(head[2], 10);
  if (!Number.isFinite(pid)) return null;

  if (proto === 'TCP') {
    const arrow = rest.indexOf('->');
    if (arrow === -1) return null;
    const left = rest.slice(0, arrow).trim();
    const right = rest.slice(arrow + 2).trim();
    const local = parseHostPort(left);
    const remote = parseHostPort(right);
    if (!local || !remote || local.port == null || remote.port == null) return null;
    return {
      Transport: 'TCP',
      LocalAddress: normalizeEndpointHost(local.host),
      LocalPort: local.port,
      RemoteAddress: normalizeEndpointHost(remote.host),
      RemotePort: remote.port,
      OwningProcess: pid,
      ProcessName: processName,
      CreationTimeUtc: null,
    };
  }

  const arrow = rest.indexOf('->');
  if (arrow !== -1) {
    const left = rest.slice(0, arrow).trim();
    const right = rest.slice(arrow + 2).trim();
    const local = parseHostPort(left);
    const remote = parseHostPort(right);
    if (!local || !remote || local.port == null || remote.port == null) return null;
    return {
      Transport: 'UDP',
      LocalAddress: normalizeEndpointHost(local.host),
      LocalPort: local.port,
      RemoteAddress: normalizeEndpointHost(remote.host),
      RemotePort: remote.port,
      OwningProcess: pid,
      ProcessName: processName,
      CreationTimeUtc: null,
    };
  }

  const local = parseHostPort(rest);
  if (!local || local.port == null) return null;
  return {
    Transport: 'UDP',
    LocalAddress: normalizeEndpointHost(local.host),
    LocalPort: local.port,
    RemoteAddress: '',
    RemotePort: null,
    OwningProcess: pid,
    ProcessName: processName,
    CreationTimeUtc: null,
  };
}

function parseLsofToNetRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const row = parseLsofLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

async function runNetConnections() {
  if (process.platform === 'win32') {
    return runPowerShellNetConnections();
  }
  return runUnixNetConnections();
}

async function fetchPublicIpGeo() {
  try {
    const r = await fetch(
      'http://ip-api.com/json/?fields=status,lat,lon,query,city,regionName,country,countryCode'
    );
    const j = await r.json();
    if (j.status === 'success' && typeof j.lat === 'number' && typeof j.lon === 'number') {
      return {
        lat: j.lat,
        lon: j.lon,
        label: j.query,
        country: j.country || '',
        city: j.city || '',
        regionName: j.regionName || '',
        placeName: formatGeoPlace(j),
      };
    }
  } catch {
    /* ignore */
  }
  return { lat: 20, lon: 0, label: 'local', placeName: 'Unknown', country: '', city: '', regionName: '' };
}

async function batchGeoLookup(ips) {
  const need = [...new Set(ips)].filter((ip) => !geoCache.has(ip));
  if (need.length === 0) return;

  const chunkSize = 100;
  for (let i = 0; i < need.length; i += chunkSize) {
    const chunk = need.slice(i, i + chunkSize);
    const body = chunk.map((query) => ({ query }));
    try {
      const r = await fetch(IP_API_BATCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const arr = await r.json();
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const q = item.query;
        if (item.status === 'success' && typeof item.lat === 'number' && typeof item.lon === 'number') {
          geoCache.set(q, geoFromApiItem(item));
        } else {
          geoCache.set(q, null);
        }
      }
    } catch {
      chunk.forEach((ip) => geoCache.set(ip, null));
    }
  }
}

function arcKey(localIp, localPort, remoteIp, remotePort) {
  return `${localIp}:${localPort}->${remoteIp}:${remotePort}`;
}

function udpConnectionKey(localIp, localPort, owningPid) {
  return `UDP|${localIp}|${localPort}|${owningPid}`;
}

async function buildSnapshot() {
  if (!userGeo) {
    userGeo = await fetchPublicIpGeo();
  }

  let rows;
  try {
    rows = await runConnectionSourceQuery();
  } catch (e) {
    return {
      error: String(e.message || e),
      arcs: [],
      connections: [],
      userGeo,
      updatedAt: Date.now(),
    };
  }

  const connections = [];
  const remotePublic = new Set();
  const localsNeedingGeo = new Set();
  const seenConnKeys = new Set();

  for (const row of rows) {
    const transport = String(row.Transport || 'TCP').toUpperCase();
    const la = String(row.LocalAddress || '').trim();
    const lp = Number(row.LocalPort);
    const op = Number(row.OwningProcess);
    const procNameRaw = row.ProcessName != null ? String(row.ProcessName).trim() : '';
    const processName = procNameRaw || '?';
    if (!la || Number.isNaN(lp)) continue;

    let createTime = null;
    const ctRaw = row.CreationTimeUtc != null ? String(row.CreationTimeUtc).trim() : '';
    if (ctRaw) createTime = ctRaw;

    if (transport === 'UDP') {
      const ura = String(row.RemoteAddress || '').trim();
      const urp = Number(row.RemotePort);

      if (!isUdpUnspecifiedRemote(ura, urp)) {
        const ra = ura;
        const rp = urp;
        if (!ra || ra === '::' || Number.isNaN(rp)) continue;

        const udpWithRemoteKey = `UDP|${arcKey(la, lp, ra, rp)}`;
        if (seenConnKeys.has(udpWithRemoteKey)) continue;
        seenConnKeys.add(udpWithRemoteKey);

        connections.push({
          connectionKey: udpWithRemoteKey,
          localAddress: la,
          localPort: lp,
          remoteAddress: ra,
          remotePort: rp,
          owningPid: Number.isFinite(op) ? op : null,
          processName,
          protocol: 'UDP',
          createTime,
        });
        if (isPublicRemote(ra)) remotePublic.add(ra);
        if (isPublicRemote(la)) localsNeedingGeo.add(la);
        continue;
      }

      const pidPart = Number.isFinite(op) ? op : '?';
      const ck = udpConnectionKey(la, lp, pidPart);
      if (seenConnKeys.has(ck)) continue;
      seenConnKeys.add(ck);
      connections.push({
        connectionKey: ck,
        localAddress: la,
        localPort: lp,
        remoteAddress: '',
        remotePort: null,
        owningPid: Number.isFinite(op) ? op : null,
        processName,
        protocol: 'UDP',
        createTime,
      });
      if (isPublicRemote(la)) localsNeedingGeo.add(la);
      continue;
    }

    const ra = String(row.RemoteAddress || '').trim();
    const rp = Number(row.RemotePort);
    if (!ra || ra === '::' || Number.isNaN(rp)) continue;
    const remoteIsPublic = isPublicRemote(ra);
    if (!remoteIsPublic && connectionSource !== 'pepwave') continue;

    const tcpKey = arcKey(la, lp, ra, rp);
    if (seenConnKeys.has(tcpKey)) continue;
    seenConnKeys.add(tcpKey);

    connections.push({
      connectionKey: tcpKey,
      localAddress: la,
      localPort: lp,
      remoteAddress: ra,
      remotePort: rp,
      owningPid: Number.isFinite(op) ? op : null,
      processName,
      protocol: 'TCP',
      createTime,
    });
    if (remoteIsPublic) remotePublic.add(ra);
    if (isPublicRemote(la)) localsNeedingGeo.add(la);
  }

  await Promise.all([
    batchGeoLookup([...remotePublic, ...localsNeedingGeo]),
    resolveRemoteHostnames([...remotePublic]),
  ]);

  for (const c of connections) {
    const ra = c.remoteAddress != null ? String(c.remoteAddress).trim() : '';
    c.remoteHost = ra ? remoteHostnameCache.get(ra) || '—' : '—';
  }

  const arcs = [];
  const seen = new Set();

  for (const c of connections) {
    const ra = String(c.remoteAddress || '').trim();
    const rp = Number(c.remotePort);
    if (!ra || Number.isNaN(rp)) continue;
    if (!isPublicRemote(ra)) continue;

    const key = c.connectionKey;
    if (seen.has(key)) continue;
    seen.add(key);

    const end = geoCache.get(ra);
    if (!end) continue;

    let startLat = userGeo.lat;
    let startLon = userGeo.lon;
    let startPlace = userGeo.placeName || formatGeoPlace(userGeo);
    if (isPublicRemote(c.localAddress)) {
      const loc = geoCache.get(c.localAddress);
      if (loc) {
        startLat = loc.lat;
        startLon = loc.lon;
        startPlace = loc.placeName || formatGeoPlace(loc);
      }
    }

    const endPlace = end.placeName || formatGeoPlace(end);
    const proto = c.protocol === 'UDP' ? 'UDP' : 'TCP';

    arcs.push({
      connectionKey: key,
      protocol: proto,
      startLat,
      startLng: startLon,
      endLat: end.lat,
      endLng: end.lon,
      startPlace,
      endPlace,
      color: ['#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#f472b6'][arcs.length % 5],
      label: `${c.processName} (${proto}) · ${startPlace} → ${endPlace} — ${c.localAddress}:${c.localPort} → ${ra}:${rp}`,
      remoteCountry: end.country || '',
    });
  }

  return {
    arcs,
    connections,
    userGeo,
    updatedAt: Date.now(),
    connectionSource,
  };
}

function debugPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Netstat Globe — debug</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem; background: #0f172a; color: #e2e8f0; }
    a { color: #38bdf8; }
    pre { background: #020617; padding: 1rem; overflow: auto; max-height: 70vh; font-size: 12px; line-height: 1.4; border: 1px solid #334155; border-radius: 6px; }
    .row { margin: 0.5rem 0; }
    code { background: #1e293b; padding: 0.1em 0.35em; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Debug</h1>
  <p>Test the pipeline in order — each step is independent of the WebSocket / globe.</p>
  <ul>
    <li><a href="/api/health"><code>/api/health</code></a> — server up, last broadcast time, WebSocket client count</li>
    <li><a href="/api/raw-tcp"><code>/api/raw-tcp</code></a> — raw TCP (Established) + UDP endpoints (PowerShell on Windows; <code>lsof</code> on macOS; Linux prefers <code>lsof</code> or falls back to <code>ss</code>); no geo</li>
    <li><a href="/api/snapshot"><code>/api/snapshot</code></a> — cached snapshot (same JSON as WS)</li>
    <li><a href="/api/snapshot?live=1"><code>/api/snapshot?live=1</code></a> — rebuild snapshot now (OS connection query + geo)</li>
    <li><a href="/globe-test.html"><code>/globe-test.html</code></a> — minimal 3D globe only (no WebSocket)</li>
  </ul>
  <div class="row"><label><input type="checkbox" id="live" /> Use live rebuild each refresh (<code>?live=1</code>)</label></div>
  <div class="row"><label>Refresh ms <input type="number" id="interval" value="3000" min="500" step="500" style="width:5rem" /></label>
    <button type="button" id="pause">Pause</button></div>
  <p id="fetch-status"></p>
  <pre id="out">Loading…</pre>
  <script>
    const out = document.getElementById('out');
    const statusEl = document.getElementById('fetch-status');
    const liveCb = document.getElementById('live');
    const intervalEl = document.getElementById('interval');
    const pauseBtn = document.getElementById('pause');
    let timer = null;
    let paused = false;
    async function pull() {
      const live = liveCb.checked ? '?live=1' : '';
      const t0 = performance.now();
      try {
        const r = await fetch('/api/snapshot' + live, { cache: 'no-store' });
        const text = await r.text();
        out.textContent = text;
        statusEl.textContent = 'HTTP ' + r.status + ' · ' + Math.round(performance.now() - t0) + ' ms · ' + new Date().toLocaleTimeString();
      } catch (e) {
        out.textContent = String(e);
        statusEl.textContent = 'Fetch failed';
      }
    }
    function schedule() {
      if (timer) clearInterval(timer);
      timer = null;
      if (paused) return;
      const ms = Math.max(500, parseInt(intervalEl.value, 10) || 3000);
      timer = setInterval(pull, ms);
      pull();
    }
    liveCb.addEventListener('change', schedule);
    intervalEl.addEventListener('change', schedule);
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      if (paused) { clearInterval(timer); timer = null; statusEl.textContent = 'Paused'; }
      else schedule();
    });
    schedule();
  </script>
</body>
</html>`;
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let pollTimer = null;
let lastSnapshot = null;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    pollMs: currentPollMs,
    lastSnapshotAt: lastSnapshot ? lastSnapshot.updatedAt : null,
    websocketClients: wss.clients.size,
  });
});

/** Raw OS rows (TCP Established + UDP endpoints) — no geolocation. */
app.get('/api/raw-tcp', async (req, res) => {
  try {
    const rows = await runNetConnections();
    res.json({ ok: true, count: rows.length, rows, updatedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e), rows: [], updatedAt: Date.now() });
  }
});

/** Proxy allowed ad-block list URLs (avoids browser CORS when loading filter lists). */
const BLOCKLIST_SOURCES = {
  'easylist.to': 'https://easylist.to/easylist/easylist.txt',
};

app.get('/api/blocklist/:id', async (req, res) => {
  const url = BLOCKLIST_SOURCES[req.params.id];
  if (!url) {
    res.status(404).json({ ok: false, error: 'Unknown blocklist id' });
    return;
  }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'NetstatGlobe/1.0' } });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `Upstream HTTP ${r.status}` });
      return;
    }
    const text = await r.text();
    res.type('text/plain; charset=utf-8').send(text);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

/** Same payload as the WebSocket broadcast; use ?live=1 to force a fresh snapshot (slower). */
app.get('/api/snapshot', async (req, res) => {
  try {
    const live = req.query.live === '1' || req.query.live === 'true';
    const snapshot = live ? await buildSnapshot() : lastSnapshot || (await buildSnapshot());
    res.type('json').send(JSON.stringify(snapshot, null, 2));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/debug', (req, res) => {
  res.type('html').send(debugPageHtml());
});

app.use(express.static(path.join(__dirname, 'public')));

async function broadcast() {
  const snapshot = await buildSnapshot();
  lastSnapshot = snapshot;
  const payload = JSON.stringify(snapshot);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function broadcastPollConfig() {
  const cfg = JSON.stringify({
    type: 'config',
    pollMs: currentPollMs,
    connectionSource,
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(cfg);
  }
}

function restartPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollTimer = setInterval(broadcast, currentPollMs);
}

function applyPollMs(ms) {
  const next = ALLOWED_POLL_MS.includes(Number(ms)) ? Number(ms) : normalizePollMs(ms);
  if (next === currentPollMs) return;
  currentPollMs = next;
  restartPollTimer();
  broadcastPollConfig();
}

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({ type: 'config', pollMs: currentPollMs, connectionSource })
  );

  if (lastSnapshot) {
    ws.send(JSON.stringify(lastSnapshot));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw || ''));
      if (msg && msg.type === 'setPollMs' && msg.ms != null) {
        applyPollMs(msg.ms);
        return;
      }
      if (msg && msg.type === 'setConnectionSource') {
        applyConnectionSource(msg.source, msg.pepwave);
        broadcastPollConfig();
        broadcast().catch(() => {});
      }
    } catch {
      /* ignore */
    }
  });

  ws.on('error', () => {});
});

function shutdown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — usually a previous Netstat Globe is still running.\n` +
        `Run: npm run restart   (kills the listener on this port, then starts the server)\n` +
        `Or use another port: Windows (cmd) set PORT=3848 && npm start · macOS/Linux: PORT=3848 npm start\n`
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Netstat Globe: http://localhost:${PORT}/`);
  console.log(`Debug (text + APIs): http://localhost:${PORT}/debug`);
  console.log(`Globe test (minimal): http://localhost:${PORT}/globe-test.html`);
  userGeo = await fetchPublicIpGeo();
  await broadcast();
  restartPollTimer();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
