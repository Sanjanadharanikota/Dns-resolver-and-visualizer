# DNS Resolver & 3D Visualizer (Local)

An educational, local-first web app that resolves DNS records and visualizes the full DNS journey in 3D (Three.js + GSAP). It includes a TTL-based cache persisted to disk, simple access control (block/unblock), a modern UI with orbit controls, path tracing, timing analysis, and utility admin endpoints.

### What it does
- Resolves DNS records: A, AAAA, CNAME, MX, NS, TXT, SRV, CAA
- Visualizes steps in 3D: client → access control → cache → root → TLD → authoritative → IP
- Caches results with TTL in `data/cache.json` (JSON on disk) and memory
- Blocks domains and manages the list from the UI (block/unblock)
- Provides admin endpoints to inspect cache and manage blocked domains

Modes (selectable in UI):
- Recursive: classic flow (existing behavior)
- Iterative: step-by-step Root → TLD → Authoritative hops with labels and timings
- Multi-Path: parallel A and AAAA final hops from Authoritative with per-type latency and winner highlight

---
# Key Features

## Core DNS Engine
- Full DNS resolution using dnspython
- Timeout protection
- Negative caching support for NXDOMAIN

## TTL-Based Caching
- Stored in RAM and persisted to data/cache.json
- Atomic write: temp → replacement
- Cache entry format:
{
  "example.com": {
    "records": {"A": ["93.184.216.34"], "AAAA": [], "MX": []},
    "timestamp": 1700000000,
    "ttl": 3600
  }
}

## Acess Control

- Domains can be blocked or unblocked via UI
- Enforced before DNS resolution
- Blocked queries trigger red 3D restricted state & alert

## 3DVisualizer
- Three.js + GSAP engineered scene
- Camera follows the DNS packet through nodes
- Per-hop latency labels
- Auto-rotate summary framing
- Cache hit path → Short direct jump animation
- Multi-path mode → Parallel A/AAAA branches (Green vs Blue)
- Iterative mode → Hop-colored segments

## NXDomain Handling
- Red error state in UI
- Visualizer zooms to last reachable node
- No record table rendered

## Demo (Local)
1) Start the server
```bash
cd dns-resolver-visualizer
python -m venv venv
venv\Scripts\activate  # Windows PowerShell
pip install -r requirements.txt
python backend\app.py
```
2) Open `http://127.0.0.1:5000/`

Try a domain like `example.com` and click Resolve. Run it twice to see cache behavior. Use Show Cache to view current cache entries. Try a made-up domain to see NXDOMAIN handling.

---

## Project Structure
```
dns-resolver-visualizer/
├── backend/
│   ├── app.py               # Flask app, routes, logging, input validation
│   ├── resolver.py          # dnspython integration with timeouts
│   ├── cache_manager.py     # in-memory + JSON TTL cache (atomic saves)
│   └── access_control.py    # blacklist/whitelist loading & checks
├── frontend/
│   ├── index.html           # UI layout, 3D visualizer, controls
│   ├── css/style.css        # modern, responsive styling
│   ├── js/visualizer3d.js   # Three.js + GSAP 3D scene, labels, paths, timings
│   └── js/script.js         # UI wiring, logs, results, cache/blocked controls
├── data/
│   ├── cache.json           # persisted cache (JSON)
│   ├── blacklist.txt        # one domain per line
│   └── whitelist.txt        # optional allow-list
├── tests/
│   └── test_app.py          # basic integration tests (pytest)
├── requirements.txt         # pinned deps
├── run.bat                  # convenience script for Windows
├── README.md                # this file
├── CONTRIBUTING.md          # how to contribute locally
└── LICENSE                  # MIT
```

---

## Features
- DNS resolution via `dnspython` with timeouts
- TTL-based cache persisted to `data/cache.json` (atomic writes) and held in memory
- Access control (block/unblock domains) with UI buttons
- 3D visualizer with:
  - Packet following camera during resolution, then orbit/auto-rotate
  - In-scene labels appearing near spheres explaining role and context
  - Timing analysis per hop (Root/TLD/Auth) embedded in labels
  - Final summary view that frames all spheres, shows all labels
  - Path tracing (glowing tubes + directional arrows); paths persist dimmed
  - Cache HIT path (client→access, cache→IP) drawn and cache labeled “HIT”
  - Blocked runs: Access shows red “Restricted — blocked by policy”, auto-rotate stays off
- Iterative visualization: distinct colored segments per hop with floating labels over each path
- Multi-Path visualization: two simultaneous branches (A=green, AAAA=blue), slower branch dimmed, per-type latencies and “winner”
- Cache hit shortcut visualization
- NXDOMAIN detection and red error state.
- Results panel:
  - DNS records table (A/AAAA/CNAME/MX/NS/TXT/SRV/CAA)
  - Timing Analysis table (populated in all modes)
  - Prominent alerts for Cache hit (green) and Restricted (red)
- Basic tests with `pytest`

---

## How It Works

### Resolution Flow
1) Input validation (simple domain regex)
2) Access control check (whitelist/blacklist)
3) Cache lookup (hit/miss)
4) DNS queries:
   - A record first to derive preferred TTL
   - AAAA, CNAME, MX, NS after that
5) Cache update and response

The response includes a `steps` array to drive the frontend visualization.

### Caching
- Cache entries shape in `data/cache.json`:
  ```json
  {
    "example.com": {
      "records": {"A":["93.184.216.34"],"AAAA":[],"CNAME":[],"MX":[],"NS":[]},
      "timestamp": 1700000000,
      "ttl": 3600
    }
  }
  ```
- Entries are valid if `timestamp + ttl > now`
- Atomic save: write to temp file then replace
- Unified caching across modes: recursive, iterative, and multi-path all write to cache when no valid entry exists
- Negative caching: NXDOMAIN responses are stored with a short TTL to prevent repeat lookups for a few minutes

### Access Control
- Blocked domains are enforced before resolution and surfaced in both the visualization and results
- The UI provides Block/Unblock controls; persistence is handled by the backend

### Negative Answers (NXDOMAIN)
- In all modes, NXDOMAIN shows a red banner “This domain does not exist” and the visualization zooms to the Authoritative node and stops
- Results panel shows an NXDOMAIN alert; no records table is shown for NXDOMAIN
- Multi-Path: if both A and AAAA fail (or full resolve indicates NXDOMAIN), we stop at Authoritative and show the banner

---

## Backend API

### POST `/api/resolve`
Request:
```json
{ "domain": "example.com", "mode": "recursive|iterative|multi" }
```
Response (shape):
```json
{
  "domain": "example.com",
  "blocked": false,
  "cached": false,
  "mode": "recursive",
  "records": {"A":[],"AAAA":[],"CNAME":[],"MX":[],"NS":[],"TXT":[],"SRV":[],"CAA":[]},
  "steps": [
    {"name":"access_control","status":"allowed","info":""},
    {"name":"cache_lookup","status":"miss","info":""},
    {"name":"dns_query","status":"success"},
    {"name":"cache_update","status":"done","info":""}
  ],
  "message": "Resolved successfully"
}
```

Notes:
- If cached, `cached: true` and `cache_lookup` step is `hit`. Visualization takes the cache→IP shortcut.
- On timeout, status code 504 is returned with `dns_query` step `timeout`.
- On invalid domain, status code 400 with a helpful message.

### GET `/api/cache`
Returns cache summary for UI/debug:
```json
{
  "entries": [
    {"domain":"example.com","first_ip":"93.184.216.34","remaining_seconds":3540,"ttl":3600,"expires_at":1700003540,"types":["A","NS"]}
  ]
}
```

### Blocked Domains
- GET `/api/blocked` → `{ "blocked_domains": ["bad.com", ...] }`
- POST `/api/block` `{ "domain": "bad.com" }` → `{ "message": "blocked" }`
- POST `/api/unblock` `{ "domain": "bad.com" }` → `{ "message": "unblocked" }`

### Cache
- GET `/api/cache` → cache summary used by UI
- DELETE `/api/cache/clear` → clears cache entries

---

## Frontend
- Location: `frontend/`
- Entry: `index.html` (served at `/` by Flask)
- Controls (IDs):
  - `domainInput`, `resolveBtn`, `clearBtn`, `speedRange`, `playPauseBtn`, `replayBtn`, `autoRotateToggle`, `showCacheBtn`, `refreshCacheBtn`, `refreshBlockedBtn`, `blockBtn`, `unblockBtn`
- Panels:
  - `#results`, `#logs`, `#cachePanel`, `#blockedPanel`

### 3D Viewer Controls
- Left drag: orbit
- Right drag or Ctrl+drag: pan
- Mouse wheel / pinch: zoom
- Auto-rotate resumes after summary; disabled when a domain is blocked
 - Mode-specific behaviors:
   - Iterative: labeled steps per hop; earlier segments dim as you progress
   - Multi-Path: parallel A/AAAA
   - branches from Authoritative; slower branch dimmed

### Keyboard Shortcuts
- Enter in domain input → Resolve
- Esc → Clear visualization

---
## Screenshots of project
### Screenshots



[![Screenshot 4](https://github.com/Sanjanadharanikota/Dns-resolver-and-visualizer/blob/main/Screenshot%202025-11-11%20213544.png)](https://github.com/Sanjanadharanikota/Dns-resolver-and-visualizer/blob/main/Screenshot%202025-11-11%20213544.png)





## Installation & Running
```bash
cd dns-resolver-visualizer
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python backend\app.py
```
Open `http://127.0.0.1:5000/`

Windows users can run:
```bat
run.bat
```

---

## Testing
Run all tests with:
```bash
pytest
```
Tests cover:
- Resolve returns steps and records for allowed domains (or timeout gracefully)
- Cache behavior (second resolve indicates cached)
- Blacklist enforcement (blocked response)

---

## Configuration & Defaults
- DNS timeout: 3 seconds per query
- Default TTL when A record missing: 300 seconds
- Cache file: `data/cache.json` (auto-created)
- Lists: `data/blacklist.txt`, `data/whitelist.txt`

---

## Troubleshooting
- No records returned:
  - Blocked domains intentionally show no records (results include a red Restricted alert)
  - Some domains may not have the requested record types
  - Network or DNS timeout (look for `dns_query: timeout`)
- Cache not updating:
  - Check write permissions for `data/`
  - Use “Clear Cache” then “Show Cache” to refresh the panel
- Access control unexpected:
  - Use the UI Block/Unblock buttons and “Show Blocked” to confirm state
  - Blocked runs will show a red Restricted label in the scene and results
- Windows path issues:
  - Use `python backend\app.py` and ensure the virtualenv is activated

---
### Features at a Glance
-<b>DNS Record Resolution</b>
Supports A, AAAA, CNAME, MX, NS, TXT, SRV, and CAA records.

-<b>3D DNS Path Visualization</b>
Animated journey of the DNS query from Client → Access → Cache → Root → TLD → Authoritative → IP.

-<b>Three Resolution Modes</b>

Recursive

Iterative

Multi-Path (parallel A & AAAA lookups)

-<b>TTL-Based Caching</b>
In-memory + JSON disk cache with automatic expiry and negative caching for NXDOMAIN.

-<b>Access Control System</b>
Block or unblock domains using a simple UI panel.

-<b>Cache Management Tools</b>
Show cache, clear cache, view expiration timers, and track cache hits.

-<b>NXDOMAIN Handling</b>
Red error banner in 3D view when the domain does not exist.

-<b>Blocked-Domain Visualization</b>
Shows restricted state in 3D with a clear message.

-<b>Timing Analysis</b>
Per-hop latency for Root, TLD, and Authoritative servers.

-<b>Smooth UI and Controls</b>
Orbit controls, auto-rotate, adjustable animation speed, replay, pause/play.

-<b>Admin API Endpoints</b>
/api/resolve, /api/cache, /api/cache/clear, /api/blocked, /api/block, /api/unblock.

-<b>Cross-Platform</b>
Works on any browser; backend runs on Windows, Linux, or macOS.


