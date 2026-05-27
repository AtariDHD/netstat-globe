# Netstat Globe

Real-time network connections on a 3D globe. A small Node.js server polls active sockets (from your OS or a Pepwave router), geolocates public remote IPs, and streams updates to a web UI over WebSocket.

<img src="screenshot.png" width="400">

## Features

- Live **TCP Established** connections + **UDP endpoints**
- **3D globe** visualization with arcs; **Real-time Day/Night**, static **Night** or **Day**, or **Zoomable Administrative Boundaries** map tiles (Settings)
- Connection **drawer** with **Live**, **History**, **Highlight Rules**, and **Settings** tabs
- **Live search** across process, local, remote, remote host, from, and to — **Include** or **Exclude** mode (saved in the browser)
- **Highlight & notification rules** — color matching arcs on the globe, a colored dot on matching live rows, optional browser notifications, and hover tooltips showing the rule label
- **Rule sets** — save, switch, rename, and delete named sets of highlight rules (stored in the browser)
- **Ad Tracker List** filter — match remote hostnames against hosted block lists (e.g. EasyList)
- Connection tables with sorting, protocol filters (TCP / UDP / Both), column picker, copy-to-clipboard
- **Ctrl+click** Local / Remote / Remote Host to open a WHOIS lookup
- Hover a globe arc or live table row to link-highlight both (uses the rule color when a rule matches)
- **Connection source**: this machine (**Local**) or a **Pepwave / Peplink router** via SSH `get session`
- Works on **Windows, Linux, macOS** (local source); Pepwave source runs from the Node server over SSH

## Drawer tabs

| Tab | Purpose |
|-----|---------|
| **Live** | Current connections, search, protocol filter, column visibility |
| **History** | Closed / past connections with its own sort and filters |
| **Highlight Rules** | Create and manage rules and rule sets |
| **Settings** | Connection source, globe theme, update frequency |

## Settings

Open the connections drawer and select the **Settings** tab.

### Connection source

| Source | Description |
|--------|-------------|
| **Local Machine** | Poll TCP/UDP on the computer running the server (default) |
| **Pepwave Router** | SSH to the router and run `get session` to list active NAT sessions |

For **Pepwave**, enter router address, local admin username/password, and SSH port (default **8822**). On the router, enable **System → Admin Security → CLI SSH**. Use the same local admin login as the web UI (not InControl 2). Credentials are sent to your local Node server over WebSocket and are not written to disk by the app.

When Pepwave is active, the HUD shows **router connections** instead of local connection counts.

### Globe theme

In **Settings → Globe Theme**, pick one of:

| Theme | Description |
|-------|-------------|
| **Real-time Day/Night** (default) | Blends day and night earth textures with a terminator that follows the actual time of day and updates as you rotate the globe |
| **Night** | Static night-side earth texture |
| **Day** | Static day-side earth texture (blue marble) |
| **Zoomable Administrative Boundaries** | Slippy map tiles (OpenStreetMap) on the globe; country and regional detail increases as you zoom in |

The choice is saved in your browser (`localStorage`). If the real-time shader fails to load (network or WebGL), the app falls back to **Night**. The boundaries theme loads tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright); use responsibly per their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

### Globe clouds

Enable **Show clouds (updated every 3 hours)** to overlay a static clouds texture on top of the globe. The image is re-fetched every 3 hours from `https://clouds.matteason.co.uk/images/8192x4096/clouds.jpg`.

### Update frequency

Choose how often the server polls for new connections (0.5 s–30 s). The choice is remembered in your browser and sent to the server over WebSocket.

## Highlight & notification rules

Open the **Highlight Rules** tab in the drawer.

### Rule sets

- Use **Active set** to switch between saved rule sets.
- **Set name** + **Save set** stores the current rules under that name.
- **Delete set** removes the active set (you can start fresh with **Add rule**).
- Legacy single-list rules in `localStorage` are migrated into a **Default** set on first load.

### Each rule has

| Field | Description |
|--------|-------------|
| **Label** | Name used in browser notifications and live-row hover tooltips |
| **Highlight** | Color for matching globe arcs and the dot in the live table |
| **Notifications** | Disabled, or **Web browser notification** when a new matching connection appears |
| **Filter by** | Remote IP, **Local IP**, Remote hostname, Remote location, or **Ad Tracker List** |
| **Filter** | See [Filter syntax](#filter-syntax) below |

- Rules and rule sets are stored in **localStorage** in the browser.
- **Add rule** creates the first rule when none exist; additional rules require the previous rule’s filter to be filled in (for Ad Tracker List, the list must finish loading).
- Rule cards use an HTML `<template>` in `public/index.html` (`#settings-rule-template`).

### Filter syntax

Filters are a **comma-separated list** of expressions. A connection matches if **any** expression matches.

**Regular expressions (all filter types)**  
Wrap the pattern in slashes; matching is always **case-insensitive**:

```text
/google/
.*\.amazonaws\.com
```

**Remote hostname / Remote location (non-regex)**

- Plain text: substring match (case-insensitive)
- `*` wildcard: matches one or more characters (e.g. `spa*in`)

**Remote IP address / Local IP address (non-regex)**

- Single address: `180.92.1.177`
- Range: `180.92.1.1-180.92.1.255`
- Wildcard: `180.92.*` (prefix by octet; `*` matches remaining octets)
- CIDR: `180.92.1.0/24`

**Ad Tracker List**

- Pick a hosted block list (e.g. EasyList). The app loads domains from the list and matches **remote hostnames** (including subdomain suffixes).
- Lists are fetched via the server proxy `GET /api/blocklist/:id` when the browser cannot load the upstream URL directly (CORS).

### Browser notifications

- Fires only when a **new** matching connection appears (not on every poll).
- At most **one notification every 10 seconds**, with counts aggregated in that window.
- One rule matched:  
  `3 new connections were made matching rule: "Spain".`
- Several rules matched:  
  `5 new connections were made matching several network notification rules.`
- Permission is requested when you enable notifications on a rule.

## Requirements

- Node.js **18+**
- OS tools (for **Local** source):
  - **Windows**: PowerShell + `Get-NetTCPConnection` / `Get-NetUDPEndpoint` (built-in)
  - **Linux**: prefers `lsof` if installed; falls back to `ss` (`iproute2`) when `lsof` is missing
  - **macOS**: `lsof` (ships with macOS)
- **Pepwave source**: network reachability to the router’s SSH port (default 8822); router CLI SSH enabled

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

## API (debug / integrations)

| Endpoint | Description |
|----------|-------------|
| `/api/health` | Server status, last broadcast, WebSocket client count |
| `/api/raw-tcp` | Raw TCP/UDP from the OS (no geo) |
| `/api/snapshot` | Cached JSON snapshot (same as WebSocket) |
| `/api/snapshot?live=1` | Force a fresh snapshot |
| `/api/blocklist/:id` | Proxy for ad-block filter lists (e.g. `easylist.to`) |

WebSocket clients can send `{ "type": "setPollMs", "ms": 3000 }` and `{ "type": "setConnectionSource", "source": "local" | "pepwave", "pepwave": { ... } }` to change server behavior.

## Notes / Troubleshooting

- **Linux without `lsof`**: install one of these
  - `lsof` (recommended): `sudo apt install lsof` / `sudo yum install lsof` / `sudo apk add lsof`
  - `ss` via iproute2: `sudo apt install iproute2`
- **Permissions on Linux**: `ss -p` and `lsof` may not show process names for sockets you don’t own unless you run with elevated privileges.
- **Geo lookups**: the server uses `ip-api.com` to geolocate public IPs and caches results in memory.
- **WebGL**: if the globe does not render, the live/history tables still work; check browser WebGL support at [get.webgl.org](https://get.webgl.org/).
- **Browser notifications**: must be allowed for this site; blocked sites show a hint in Highlight Rules.
- **Pepwave SSH errors**: verify CLI SSH is enabled, port 8822 (or your custom port) is reachable, and credentials match a local admin account. Session output is parsed from the Peplink `get session` table (`Service` → process name, `Idle` → elapsed time).
