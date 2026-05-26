/**
 * Pepwave / Peplink router — SSH CLI active sessions (NAT table).
 * Command: get session (see Peplink CLI SSH Guide).
 *
 * SSH is typically on port 8822. Enable under System → Admin Security → CLI SSH.
 * Uses the same local admin credentials as the web UI (not InControl 2).
 */
const { Client } = require('ssh2');

const DEFAULT_SSH_PORT = 8822;
const SSH_READY_MS = 20000;
const SSH_EXEC_MS = 45000;
const MAX_SESSION_ROWS = 4000;

function parseHostSpec(host, sshPort) {
  let h = String(host || '').trim();
  if (!h) throw new Error('Router host is required');
  h = h.replace(/^https?:\/\//i, '');
  h = h.replace(/\/.*$/, '');

  let parsedHost = h;
  let parsedPort = null;

  const bracket = h.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    parsedHost = bracket[1];
    if (bracket[2]) parsedPort = Number(bracket[2]);
  } else {
    const colon = h.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) {
      parsedPort = Number(h.slice(colon + 1));
      parsedHost = h.slice(0, colon);
    }
  }

  const port =
    Number.isFinite(Number(sshPort)) && Number(sshPort) > 0
      ? Number(sshPort)
      : parsedPort != null && parsedPort > 0
        ? parsedPort
        : DEFAULT_SSH_PORT;

  return { host: parsedHost, port };
}

function connectClient(config) {
  const { host, port } = parseHostSpec(config.host, config.sshPort);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('SSH connection timed out'));
    }, SSH_READY_MS);

    conn.on('ready', () => {
      clearTimeout(timer);
      resolve({ conn, host, port });
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    conn.connect({
      host,
      port,
      username: String(config.username || ''),
      password: String(config.password || ''),
      readyTimeout: SSH_READY_MS,
      tryKeyboard: false,
    });
  });
}

function runSshExec(config, command) {
  return connectClient(config).then(
    ({ conn }) =>
      new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          conn.end();
          reject(new Error('SSH command timed out'));
        }, SSH_EXEC_MS);

        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            reject(err);
            return;
          }
          stream.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
          });
          stream.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
          });
          stream.on('close', (code) => {
            clearTimeout(timer);
            conn.end();
            const out = stdout.trim();
            if (!out && stderr.trim()) {
              reject(new Error(stderr.trim()));
              return;
            }
            if (code !== 0 && !out) {
              reject(new Error(stderr.trim() || `SSH command exited with code ${code}`));
              return;
            }
            resolve(stdout);
          });
        });
      })
  );
}

function runSshShellCommand(config, command) {
  return connectClient(config).then(
    ({ conn }) =>
      new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => {
          conn.end();
          reject(new Error('SSH shell timed out'));
        }, SSH_EXEC_MS);

        conn.shell((err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            reject(err);
            return;
          }

          const onData = (chunk) => {
            buf += chunk.toString('utf8');
          };

          stream.on('data', onData);
          stream.stderr.on('data', onData);
          stream.on('close', () => {
            clearTimeout(timer);
            conn.end();
            resolve(buf);
          });

          stream.write(`${command}\r\n`);
          stream.write('exit\r\n');
        });
      })
  );
}

async function fetchGetSessionText(config) {
  const command = 'get session';
  let text = '';
  try {
    text = await runSshExec(config, command);
  } catch {
    text = '';
  }
  if (!text || text.trim().length < 8) {
    text = await runSshShellCommand(config, command);
  }
  if (!text || !text.trim()) {
    throw new Error('No output from "get session" — check SSH CLI access and credentials');
  }
  return text;
}

const IPV4_PORT =
  /(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/g;

function parseIpv4PortToken(ip, portStr) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return null;
  const port = portStr != null && portStr !== '' ? Number(portStr) : 0;
  if (!Number.isFinite(port) || port < 0 || port > 65535) return null;
  return { ip: parts.join('.'), port };
}

function isHeaderLine(line) {
  const l = line.toLowerCase();
  if (!l.includes('source') && !l.includes('src')) return false;
  if (!l.includes('dest') && !l.includes('dst')) return false;
  return true;
}

function isPeplinkSessionHeader(line) {
  const l = String(line || '').toLowerCase();
  return (
    l.includes('dir') &&
    l.includes('prot') &&
    l.includes('src') &&
    l.includes('dest') &&
    l.includes('service') &&
    l.includes('idle')
  );
}

/** Pepwave/Peplink `get session` table: Dir Prot Src Dest Service Intf Idle */
const PEPLINK_SESSION_LINE =
  /^(In|Out)\s+(TCP|UDP|ICMP|IGMP|GRE|SCTP)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i;

function parseHostPortSpec(spec) {
  const cell = String(spec || '').trim();
  const m = cell.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (!m) return null;
  return parseIpv4PortToken(m[1], m[2]);
}

/**
 * Parse Peplink/Pepwave columnar session table (Dir, Prot, Src, Dest, Service, Intf, Idle).
 * @param {string} text
 */
function parsePeplinkSessionTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.some(isPeplinkSessionHeader)) return null;

  const rows = [];
  const seen = new Set();

  for (const line of lines) {
    if (isPeplinkSessionHeader(line)) continue;
    const m = line.match(PEPLINK_SESSION_LINE);
    if (!m) continue;

    const dir = String(m[1]).toLowerCase();
    const protocol = String(m[2]).toUpperCase();
    const src = parseHostPortSpec(m[3]);
    const dest = parseHostPortSpec(m[4]);
    const service = String(m[5] || '').trim();
    const idleSec = Number(m[7]);

    if (!src || !dest) continue;

    const local = dir === 'in' ? dest : src;
    const remote = dir === 'in' ? src : dest;

    const key = `${protocol}|${local.ip}:${local.port}|${remote.ip}:${remote.port}|${service}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let creationTimeUtc = null;
    if (Number.isFinite(idleSec) && idleSec >= 0) {
      creationTimeUtc = new Date(Date.now() - idleSec * 1000).toISOString();
    }

    rows.push({
      protocol,
      localAddress: local.ip,
      localPort: local.port,
      remoteAddress: remote.ip,
      remotePort: remote.port,
      service: service || protocol,
      idleSec,
      creationTimeUtc,
    });

    if (rows.length >= MAX_SESSION_ROWS) break;
  }

  return rows.length ? rows : null;
}

function parseProtocolFromLine(line) {
  const m = String(line || '').match(/\b(TCP|UDP|ICMP|IGMP|GRE|SCTP)\b/i);
  return m ? m[1].toUpperCase() : 'TCP';
}

function parseLineEndpoints(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^-+$/.test(trimmed.replace(/\s/g, ''))) return null;
  if (isHeaderLine(trimmed)) return null;
  if (/^total\b/i.test(trimmed)) return null;

  const endpoints = [];
  let m;
  IPV4_PORT.lastIndex = 0;
  while ((m = IPV4_PORT.exec(trimmed)) !== null) {
    const ep = parseIpv4PortToken(m[1], m[2]);
    if (ep) endpoints.push(ep);
  }
  if (endpoints.length < 2) return null;

  const protocol = parseProtocolFromLine(trimmed);
  return {
    protocol,
    localAddress: endpoints[0].ip,
    localPort: endpoints[0].port,
    remoteAddress: endpoints[1].ip,
    remotePort: endpoints[1].port,
  };
}

function parseCsvSessions(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  if (!lines[0].includes(',')) return null;

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = {
    protocol: header.findIndex((h) => h === 'protocol' || h === 'prot' || h === 'proto'),
    src: header.findIndex((h) => /^(src|source)/.test(h)),
    dst: header.findIndex((h) => /^(dst|dest|destination)/.test(h)),
    sport: header.findIndex((h) => /^(src[_-]?port|sport|source[_-]?port)$/.test(h)),
    dport: header.findIndex((h) => /^(dst[_-]?port|dport|dest[_-]?port)$/.test(h)),
  };

  if (idx.src === -1 || idx.dst === -1) return null;

  const rows = [];
  for (let i = 1; i < lines.length && rows.length < MAX_SESSION_ROWS; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < 2) continue;

    const parseCell = (col, fallbackPort) => {
      const cell = col != null ? String(col).trim() : '';
      if (!cell) return null;
      const pair = cell.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
      if (pair) return parseIpv4PortToken(pair[1], pair[2] != null ? pair[2] : fallbackPort);
      return parseIpv4PortToken(cell, fallbackPort);
    };

    const src = parseCell(cols[idx.src], idx.sport >= 0 ? cols[idx.sport] : undefined);
    const dst = parseCell(cols[idx.dst], idx.dport >= 0 ? cols[idx.dport] : undefined);
    if (!src || !dst) continue;

    let protocol = 'TCP';
    if (idx.protocol >= 0 && cols[idx.protocol]) {
      protocol = parseProtocolFromLine(cols[idx.protocol]);
    }

    rows.push({
      protocol,
      localAddress: src.ip,
      localPort: src.port,
      remoteAddress: dst.ip,
      remotePort: dst.port,
    });
  }

  return rows.length ? rows : null;
}

/**
 * Parse `get session` CLI output into connection tuples.
 * @param {string} text
 * @returns {Array<{ protocol: string, localAddress: string, localPort: number, remoteAddress: string, remotePort: number }>}
 */
function parseGetSessionOutput(text) {
  const raw = String(text || '');
  const peplink = parsePeplinkSessionTable(raw);
  if (peplink) return peplink;

  const csv = parseCsvSessions(raw);
  if (csv) return csv;

  const rows = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLineEndpoints(line);
    if (!parsed) continue;
    const key = `${parsed.protocol}|${parsed.localAddress}:${parsed.localPort}|${parsed.remoteAddress}:${parsed.remotePort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(parsed);
    if (rows.length >= MAX_SESSION_ROWS) break;
  }
  return rows;
}

function sessionsToNetRows(sessions) {
  const rows = [];
  for (const s of sessions) {
    const proto = String(s.protocol || 'TCP').toUpperCase();
    const transport = proto === 'UDP' ? 'UDP' : 'TCP';
    const row = {
      Transport: transport,
      LocalAddress: s.localAddress,
      LocalPort: Number(s.localPort) || 0,
      RemoteAddress: s.remoteAddress,
      RemotePort: Number(s.remotePort) || 0,
      OwningProcess: null,
      ProcessName: String(s.service || s.processName || proto).trim() || proto,
    };
    if (s.creationTimeUtc) {
      row.CreationTimeUtc = s.creationTimeUtc;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * @param {{ host: string, username: string, password: string, sshPort?: number }} config
 */
async function fetchPepwaveConnectionRows(config) {
  if (!config || !String(config.host || '').trim()) {
    throw new Error('Router host is required');
  }
  if (!String(config.username || '').trim()) {
    throw new Error('SSH username is required');
  }

  const text = await fetchGetSessionText(config);
  const sessions = parseGetSessionOutput(text);
  if (!sessions.length) {
    throw new Error(
      'Could not parse any sessions from "get session" output. Your firmware format may differ — share a sample line for parser tuning.'
    );
  }
  return sessionsToNetRows(sessions);
}

module.exports = {
  DEFAULT_SSH_PORT,
  parsePeplinkSessionTable,
  parseGetSessionOutput,
  fetchPepwaveConnectionRows,
};
