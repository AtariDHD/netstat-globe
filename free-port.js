/**
 * Stop whichever process is LISTENING on PORT (default 3847).
 * Used so `npm run restart` can replace a leftover Netstat Globe instance.
 */
const { execFileSync } = require('child_process');

const port = Number(process.argv[2] || process.env.PORT || 3847);

if (process.platform === 'win32') {
  const script =
    `$ErrorActionPreference = 'SilentlyContinue'; ` +
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($null -ne $c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }`;

  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'inherit', windowsHide: true }
  );
} else {
  try {
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    const pids = out.trim().split(/\n/).filter(Boolean);
    for (const line of pids) {
      const pid = parseInt(line.trim(), 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* no listener on port, or lsof unavailable */
  }
}
