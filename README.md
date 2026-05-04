# Netstat Globe

Real-time network connections on a 3D globe. A small Node.js server polls your OS for active TCP/UDP sockets, geolocates public remote IPs, and streams updates to a web UI over WebSocket.

<img src="screenshot.png" width="400">

## Features

- Live **TCP Established** connections + **UDP endpoints**
- **3D globe** visualization with arcs
- Connection **drawer** with sorting, filters, copy-to-clipboard
- **Ctrl+click** Local/Remote/Remote Host to open a WHOIS lookup
- Works on **Windows, Linux, macOS**

## Requirements

- Node.js **18+**
- OS tools:
  - **Windows**: PowerShell + `Get-NetTCPConnection` / `Get-NetUDPEndpoint` (built-in)
  - **Linux**: prefers `lsof` if installed; falls back to `ss` (`iproute2`) when `lsof` is missing
  - **macOS**: `lsof` (ships with macOS)

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Then open:

- App: `http://localhost:3847/`
- Debug page: `http://localhost:3847/debug`

### Choose a different port

- macOS/Linux:

```bash
PORT=3848 npm start
```

- Windows (cmd):

```bat
set PORT=3848 && npm start
```

## Restart (kill old process on same port)

If you have a leftover instance still listening on the port:

```bash
npm run restart
```

This runs `free-port.js` (kills the process listening on `PORT`) and then starts the server.

## Notes / Troubleshooting

- **Linux without `lsof`**: install one of these
  - `lsof` (recommended): `sudo apt install lsof` / `sudo yum install lsof` / `sudo apk add lsof`
  - `ss` via iproute2: `sudo apt install iproute2`
- **Permissions on Linux**: `ss -p` and `lsof` may not show process names for sockets you don’t own unless you run with elevated privileges.
- **Geo lookups**: the server uses `ip-api.com` to geolocate public IPs and caches results in memory.

