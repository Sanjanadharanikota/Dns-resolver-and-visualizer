// ---------------------------------------------------------------
// DNS Visualizer Frontend Controller
// Connects Flask backend endpoints with 3D visualizer and UI
// ---------------------------------------------------------------

const $ = id => document.getElementById(id);

// DOM references
const domainInput = $("domainInput");
const resolveBtn = $("resolveBtn");
const clearBtn = $("clearBtn");
const resultsDiv = $("results");
const logsDiv = $("logs");
const showCacheBtn = $("showCacheBtn");
const playPauseBtn = $("playPauseBtn");
const replayBtn = $("replayBtn");
const autoRotateToggle = $("autoRotateToggle");
const learningModeToggle = $("learningModeToggle");
const timelineBar = $("timelineBar");
const blockBtn = $("blockBtn");
const unblockBtn = $("unblockBtn");
const refreshBlockedBtn = $("refreshBlockedBtn");
const refreshCacheBtn = $("refreshCacheBtn");
const blockDomainInput = $("blockDomainInput");
const blockedPanel = $("blockedPanel");
const cachePanel = $("cachePanel");
const speedRange = $("speedRange");
const clearCacheBtn = $("clearCacheBtn");
const modeSelect = $("modeSelect");

let viz = null;
let depsReady = false;
let cacheInterval = null;
let lastTrace = null;
let cancelRequested = false;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function nowTime() { return new Date().toLocaleTimeString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function appendLog(msg, type = "info") {
  if (!logsDiv) return console.log(`[${type}] ${msg}`);
  const el = document.createElement("div");
  el.className = `item ${type}`;
  el.innerHTML = `${msg} <span class="time">${nowTime()}</span>`;
  logsDiv.appendChild(el);
  logsDiv.scrollTop = logsDiv.scrollHeight;
}

function updateTimeline(pct = 0) {
  if (!timelineBar) return;
  const clamped = Math.max(0, Math.min(1, pct));
  timelineBar.innerHTML = `<div style="width:${Math.floor(clamped * 100)}%;
      height:100%;background:linear-gradient(90deg,#2563eb,#60a5fa);
      border-radius:999px;transition:width 0.25s ease;"></div>`;
}

function resetUI() {
  if (resultsDiv) resultsDiv.innerHTML = "";
  if (logsDiv) logsDiv.innerHTML = "";
  updateTimeline(0);
}

function scrollToEl(id) {
  try {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (_) {}
}

// ---------------------------------------------------------------
// Visualizer Setup
// ---------------------------------------------------------------
async function waitForVisualizerEngine(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.DNSVisualizer3D) return resolve(true);
      if (Date.now() - start > timeout) return reject(new Error("visualizer3d.js not found"));
      setTimeout(check, 100);
    })();
  });
}

async function ensureVisualizer() {
  if (viz) return true;
  try {
    await waitForVisualizerEngine(6000);
    depsReady = true;
    viz = new DNSVisualizer3D();
    viz.init("visualizerContainer");
    // Apply same mapping as the UI control, defaulting to a slowed Normal
    const initialSel = Number(speedRange?.value || 2);
    viz.setSpeed(initialSel === 1 ? 0.3 : initialSel === 2 ? 0.4 : 0.8);
    viz.setAutoRotate(autoRotateToggle?.checked || false);
    appendLog("Visualizer ready", "info");
    return true;
  } catch (e) {
    appendLog("Visualizer unavailable: " + e.message, "error");
    return false;
  }
}

// ---------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------
function renderRecords(records = {}) {
  if (!resultsDiv) return;
  // Error/NXDOMAIN handling
  if (records && (records.error || records.Error || records.ERROR)) {
    const errRaw = records.error || records.Error || records.ERROR;
    const errList = Array.isArray(errRaw) ? errRaw : [String(errRaw)];
    const msgLower = errList.join(" ").toLowerCase();
    const isNX = msgLower.includes("nxdomain") || msgLower.includes("does not exist");
    const human = isNX ? "This domain does not exist." : (errList.join("; ") || "Error");
    resultsDiv.innerHTML = `<h5>DNS Results</h5>
      <div class="alert alert-warning" style="font-weight:700">${human}</div>`;
    return;
  }
  if (!records || Object.keys(records).length === 0) {
    resultsDiv.innerHTML = "<p>No DNS records found.</p>";
    return;
  }

  const table = document.createElement("table");
  table.className = "table table-sm";
  table.innerHTML = `<thead><tr><th>Type</th><th>Values</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  const order = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "CAA"];
  for (const t of order) {
    const vals = records[t] || [];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${t}</td><td>${vals.length ? vals.join(", ") : "-"}</td>`;
    tbody.appendChild(tr);
  }
  resultsDiv.innerHTML = "<h5>DNS Results</h5>";
  resultsDiv.appendChild(table);
}

// ---------------------------------------------------------------
// Visualization Runner
// ---------------------------------------------------------------
async function runVisualization(trace) {
  const ok = await ensureVisualizer();
  lastTrace = trace;
  resetUI();
  const modeLabel = (trace && trace.mode) ? String(trace.mode) : (modeSelect?.value || 'recursive');
  appendLog(`🔍 Resolving ${trace.domain} (mode: ${modeLabel})`, "info");

  const steps = trace.steps || [];
  const total = steps.length || 1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (cancelRequested) break;

    updateTimeline((i + 1) / total);
    appendLog(`${s.name}: ${s.status || "running"}`, "info");
    await sleep(200);
  }

  // If blocked, always use the minimal blocked visualization (no mode-specific runs)
  const isBlocked = Array.isArray(trace.steps) && trace.steps.some(s => s && s.name === 'access_control' && s.status === 'blocked');
  if (ok && !isBlocked) {
    try {
      if ((trace.mode || modeSelect?.value) === 'iterative' && viz.playIterative) {
        await viz.playIterative(trace);
      } else if ((trace.mode || modeSelect?.value) === 'multi' && viz.playMultiPath) {
        await viz.playMultiPath(trace);
      } else if (viz.playRecursive) {
        await viz.playRecursive(trace);
      } else if (viz.playTrace) {
        await viz.playTrace(trace);
      }
    } catch (e) { appendLog("Visualizer playback error: " + e.message, "error"); }
  } else if (ok && isBlocked && viz.playTrace) {
    // Minimal blocked rendering (same as recursive behavior)
    try { await viz.playTrace(trace); } catch (e) { appendLog("Visualizer playback error: " + e.message, "error"); }
  }

  // Results rendering — if blocked, always show blocked message prominently and exit
  if (isBlocked && resultsDiv) {
    resultsDiv.innerHTML = `<h5>DNS Results</h5>
      <div class="alert alert-danger mb-2" style="font-weight:700">Restricted: <strong>${trace.domain}</strong> is blocked by policy.</div>
      <div class="small text-muted">No DNS records are shown for blocked domains.</div>`;
    return;
  }
  if (trace.mode === 'multi') {
    // Render multi-path results panel
    if (resultsDiv) {
      const m = trace.multi || {};
      const aVals = m.A || [];
      const aaaaVals = m.AAAA || [];
      const faster = m.faster || '-';
      const lat = m.latency_ms || {};
      const aMs = (typeof lat.A === 'number') ? `${lat.A} ms` : '-';
      const aaaaMs = (typeof lat.AAAA === 'number') ? `${lat.AAAA} ms` : '-';
      const totalMs = (typeof lat.total === 'number') ? `${lat.total} ms` : '-';
      const header = `<h5>DNS Results</h5><div class="mb-2"><span class="badge bg-info">Mode: Multi-Path</span></div><div class="small text-muted">Legend: green=A (IPv4), blue=AAAA (IPv6), dimmer path is slower</div>`;
      // If NXDOMAIN surfaced at top-level, show that and skip details
      if (trace.records && (trace.records.error || trace.records.Error || trace.records.ERROR)) {
        const errRaw = trace.records.error || trace.records.Error || trace.records.ERROR;
        const errList = Array.isArray(errRaw) ? errRaw : [String(errRaw)];
        resultsDiv.innerHTML = header + `<div class="alert alert-warning mt-2" style="font-weight:700">This domain does not exist.</div>`;
        return;
      }
      const body = `<div class="small">A (IPv4): ${aVals.length ? aVals.join(', ') : '-'} — ${aMs}<br/>AAAA (IPv6): ${aaaaVals.length ? aaaaVals.join(', ') : '-'} — ${aaaaMs}<br/>Total: ${totalMs}<br/><strong>${faster !== '-' ? `${faster} responded faster` : ''}</strong></div>`;
      resultsDiv.innerHTML = header + body;
      // Also show full records table if provided by backend; fallback to just A/AAAA
      const recs = (trace.records && Object.keys(trace.records).length) ? trace.records : { A: aVals, AAAA: aaaaVals };
      const wrap = document.createElement('div');
      wrap.className = 'mt-2';
      resultsDiv.appendChild(wrap);
      // Temporarily render into wrap
      const prev = resultsDiv;
      const tmpDiv = document.createElement('div');
      resultsDiv = tmpDiv;
      renderRecords(recs);
      prev.appendChild(tmpDiv.firstChild); // move table
      resultsDiv = prev;
    }
  } else {
    // Default record rendering (recursive/iterative)
    renderRecords(trace.records);
    // Iterative: append backend timings if provided
    if (trace.mode === 'iterative' && trace.iterative && resultsDiv) {
      const it = trace.iterative;
      const t = it.timings || {};
      const mk = k => (typeof t[k] === 'number' ? `${t[k]} ms` : '-');
      const nsRoot = (it.steps?.[0]?.ns || []).join(', ') || '-';
      const nsTld = (it.steps?.[1]?.ns || []).join(', ') || '-';
      const sec = document.createElement('div');
      sec.innerHTML = `
        <h6 class="mt-3">Iterative Details</h6>
        <div class="small text-muted mb-1">Legend: orange=Root hop, purple=TLD hop, green=Authoritative/IP</div>
        <table class="table table-sm mb-2"><tbody>
          <tr><td>Root → TLD</td><td>${mk('root_to_tld_ms')}</td><td class="text-muted small">NS: ${nsRoot}</td></tr>
          <tr><td>TLD → Authoritative</td><td>${mk('tld_to_auth_ms')}</td><td class="text-muted small">NS: ${nsTld}</td></tr>
          <tr><td>Authoritative → IP</td><td>${mk('auth_to_ip_ms')}</td><td></td></tr>
        </tbody></table>`;
      resultsDiv.appendChild(sec);
    }
    if (resultsDiv) {
      const badge = document.createElement('div');
      badge.className = 'mb-2';
      badge.innerHTML = `<span class="badge bg-primary">Mode: ${(trace.mode || modeSelect?.value || 'recursive').replace(/^./, c=>c.toUpperCase())}</span>`;
      resultsDiv.prepend(badge);
    }
  }
  // Append timings if available
  try {
    if (viz && viz.timings && resultsDiv) {
      const t = viz.timings;
      const mk = (k) => (typeof t[k] === 'number' ? `${t[k]} ms` : '-');
      const timingsHtml = `
        <h6 class="mt-3">Timing Analysis</h6>
        <table class="table table-sm mb-0"><tbody>
          <tr><td>Total</td><td>${mk('total_ms')}</td></tr>
          <tr><td>Client → Access</td><td>${mk('client_to_access_ms')}</td></tr>
          <tr><td>Access → Cache</td><td>${mk('access_to_cache_ms')}</td></tr>
          <tr><td>Cache → Root</td><td>${mk('cache_to_root_ms')}</td></tr>
          <tr><td>Root → TLD</td><td>${mk('root_to_tld_ms')}</td></tr>
          <tr><td>TLD → Authoritative</td><td>${mk('tld_to_auth_ms')}</td></tr>
          <tr><td>Authoritative → IP</td><td>${mk('auth_to_ip_ms')}</td></tr>
          <tr><td>Cache → IP</td><td>${mk('cache_to_ip_ms')}</td></tr>
        </tbody></table>`;
      const wrap = document.createElement('div');
      wrap.innerHTML = timingsHtml;
      resultsDiv.appendChild(wrap);
    }
  } catch (_) {}
  appendLog(`✅ Done: ${trace.domain}`, "success");
  updateTimeline(1);
  // Bring Results section into view after simulation completes (delay to allow layout)
  try {
    setTimeout(() => {
      const el = document.getElementById("results");
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (el) {
        const top = el.getBoundingClientRect().top + window.pageYOffset - 60;
        window.scrollTo({ top, behavior: "smooth" });
      }
    }, 50);
  } catch (_) {}
}

// ---------------------------------------------------------------
// Backend API Calls
// ---------------------------------------------------------------
async function resolveDomain() {
  const domain = (domainInput?.value || "").trim();
  if (!domain) return appendLog("Enter a domain first.", "error");
  const mode = (modeSelect?.value || 'recursive');

  cancelRequested = false;
  resolveBtn.disabled = true;
  // Bring user to the visualization section automatically
  try { document.getElementById("visualizerContainer")?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
  resetUI();
  appendLog(`Resolving ${domain}…`, "info");

  try {
    const res = await fetch("/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, mode })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.blocked) {
      appendLog(`🚫 ${domain} blocked`, "error");
      // Bring user to visualization and results sections
      try { document.getElementById("visualizerContainer")?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
      // Prominent blocked message in results panel
      if (resultsDiv) {
        resultsDiv.innerHTML = `<h5>DNS Results</h5>
          <div class="alert alert-danger mb-2" style="font-weight:700">Restricted: <strong>${domain}</strong> is blocked by policy.</div>
          <div class="small text-muted">No DNS records are shown for blocked domains.</div>`;
      }
      // Visualization: move to Access, display blocked state
      await runVisualization({
        domain,
        records: {},
        steps: [ { name: "access_control", status: "blocked" } ]
      });
      // Ensure results are visible
      try { document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
      return;
    }

    await runVisualization({
      domain,
      mode: data.mode || mode,
      multi: data.multi,
      records: data.records || {},
      steps: data.steps || [
        { name: "access_control", status: data.blocked ? "blocked" : "allowed" },
        { name: "cache_lookup", status: data.cached ? "hit" : "miss" },
        { name: "dns_query", status: "success" },
        { name: "cache_update", status: "done" }
      ]
    });
    // If served from cache, prominently indicate in results
    if (data.cached && resultsDiv) {
      const alert = document.createElement('div');
      alert.className = 'alert alert-success mb-2';
      alert.style.fontWeight = '700';
      alert.innerHTML = 'Cache hit: response served from local DNS cache.';
      resultsDiv.prepend(alert);
    }

  } catch (err) {
    appendLog("❌ Error: " + err.message, "error");
  } finally {
    resolveBtn.disabled = false;
  }
}

function clearAll() {
  cancelRequested = true;
  resetUI();
  appendLog("🧹 Cleared.", "info");
  // Also clear visualization state for clarity
  try {
    if (viz) {
      viz.pause?.();
      if (viz.packet) viz.packet.visible = false;
      if (viz.labels) Object.values(viz.labels).forEach(s => { if (s) s.visible = false; });
      viz._hideInfo?.();
      viz._hideNXDomainBanner?.();
      // Clear any drawn path lines/arrows if available
      viz._clearPathLines?.();
    }
  } catch (_) {}

  // Also clear blocked domains list in backend
  (async () => {
    try {
      const r = await fetch('/api/blocked');
      const d = await r.json();
      const list = d.blocked_domains || [];
      for (const domain of list) {
        await fetch('/api/unblock', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ domain }) });
      }
      await loadBlocked();
      appendLog('🚮 Cleared blocked domains.', 'info');
    } catch (_) {}
  })();
}

// ---------------------------------------------------------------
// Cache & Block Panels
// ---------------------------------------------------------------
async function refreshCachePanel() {
  try {
    const r = await fetch("/api/cache");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d.entries?.length) {
      cachePanel.textContent = "No cache entries.";
      return;
    }
    cachePanel.textContent = d.entries
      .map(e => `${e.domain} → ${e.first_ip || "-"} | TTL:${e.ttl}s | Exp:${e.remaining_seconds || 0}s`)
      .join("\n");
  } catch (err) {
    cachePanel.textContent = `⚠️ ${err.message}`;
  }
}

async function clearCache() {
  try {
    const r = await fetch("/api/cache/clear", { method: "DELETE" });
    const d = await r.json();
    appendLog(`🧹 ${d.message}`, "success");
    cachePanel.textContent = "Cache cleared.";
    // Refresh cache panel view after clear
    setTimeout(refreshCachePanel, 300);
    scrollToEl("cachePanel");
  } catch (err) {
    appendLog("❌ Cache clear failed: " + err.message, "error");
  }
}

async function loadBlocked() {
  try {
    const r = await fetch("/api/blocked");
    const d = await r.json();
    blockedPanel.textContent = (d.blocked_domains || []).join("\n") || "No blocked domains";
  } catch (e) {
    blockedPanel.textContent = "⚠️ Cannot load blocked domains";
  }
}

async function blockDomain() {
  const domain = blockDomainInput?.value.trim();
  if (!domain) return appendLog("Enter domain to block.", "error");
  const r = await fetch("/api/block", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ domain }) });
  const d = await r.json();
  appendLog(`🚫 ${d.message || `${domain} blocked`}`, "error");
  await loadBlocked();
}

async function unblockDomain() {
  const domain = blockDomainInput?.value.trim();
  if (!domain) return appendLog("Enter domain to unblock.", "error");
  const r = await fetch("/api/unblock", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ domain }) });
  const d = await r.json();
  appendLog(`✅ ${d.message || `${domain} unblocked`}`, "success");
  await loadBlocked();
}

// ---------------------------------------------------------------
// Controls
// ---------------------------------------------------------------
function togglePlayPause() {
  if (!viz) return appendLog("Visualizer not initialized", "info");
  if (viz.running) { viz.pause(); appendLog("⏸️ Paused", "info"); }
  else { viz.resume(); appendLog("▶️ Resumed", "info"); }
}

function replayVisualization() {
  if (!lastTrace) return appendLog("No previous trace", "info");
  appendLog("🔁 Replaying...", "info");
  viz?.replay();
}

speedRange?.addEventListener("change", () => {
  if (!viz) return;
  const val = Number(speedRange.value);
  // Further slow mapping (Slow:0.3, Normal:0.4, Fast:0.8)
  viz.setSpeed(val === 1 ? 0.3 : val === 2 ? 0.4 : 0.8);
});

autoRotateToggle?.addEventListener("change", () => {
  if (viz) viz.setAutoRotate(autoRotateToggle.checked);
});

// ---------------------------------------------------------------
// Event bindings
// ---------------------------------------------------------------
resolveBtn?.addEventListener("click", resolveDomain);
clearBtn?.addEventListener("click", clearAll);
blockBtn?.addEventListener("click", blockDomain);
unblockBtn?.addEventListener("click", unblockDomain);
refreshBlockedBtn?.addEventListener("click", async () => { await loadBlocked(); scrollToEl("blockedPanel"); });
showCacheBtn?.addEventListener("click", async () => { await refreshCachePanel(); scrollToEl("cachePanel"); });
// Top toolbar "Clear Cache" button actually clears cache
refreshCacheBtn?.addEventListener("click", clearCache);
// In Cache Summary section, Show Cache button
const showCacheBtn2 = $("showCacheBtn2");
showCacheBtn2?.addEventListener("click", async () => { await refreshCachePanel(); scrollToEl("cachePanel"); });
playPauseBtn?.addEventListener("click", togglePlayPause);
replayBtn?.addEventListener("click", replayVisualization);
domainInput?.addEventListener("keydown", e => {
  if (e.key === "Enter") resolveDomain();
  if (e.key === "Escape") clearAll();
});

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
(async () => {
  try {
    await waitForVisualizerEngine(6000);
    depsReady = true;
    appendLog("Visualizer engine loaded", "info");
  } catch (e) {
    appendLog("Visualizer unavailable (3D disabled)", "error");
  }
  loadBlocked();
})();

