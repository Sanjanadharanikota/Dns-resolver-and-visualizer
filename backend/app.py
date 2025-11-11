from flask import Flask, send_from_directory, request, jsonify
from flask_cors import CORS
import logging
import os
import sys
import re
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError

# ===========================================================
# CONFIGURE REALTIME OUTPUT
# ===========================================================
print("🔧 Booting DNS Resolver Server...", flush=True)
sys.stdout.reconfigure(line_buffering=True)
os.environ["PYTHONUNBUFFERED"] = "1"

# ===========================================================
# PATH SETUP
# ===========================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")

print(f"📁 BASE_DIR: {BASE_DIR}", flush=True)
print(f"📁 FRONTEND_DIR: {FRONTEND_DIR}", flush=True)

if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


# ===========================================================
# SAFE IMPORTS
# ===========================================================
try:
    import resolver
    import cache_manager
    import access_control
    cache_manager.load_cache()
    access_control.load_lists()
    print("✅ Loaded resolver, cache_manager, access_control", flush=True)
except Exception as e:
    print(f"⚠️ Using mock modules ({e})", flush=True)
    # fallback mocks
    class resolver:
        @staticmethod
        def resolve_all(domain):
            time.sleep(0.5)
            return {
                "records": {"A": ["8.8.8.8"], "NS": ["ns1.google.com"]},
                "ttl": 300
            }

    class cache_manager:
        _CACHE = {}
        @staticmethod
        def get_cached(d): return None
        @staticmethod
        def set_cache(d, r, t): pass
        @staticmethod
        def get_cache_summary(): return {}
        @staticmethod
        def clear_cache(): return 0

    class access_control:
        _BLACKLIST = set()
        @staticmethod
        def is_blocked(d): return (d in access_control._BLACKLIST, "")
        @staticmethod
        def add_to_blacklist(d): access_control._BLACKLIST.add(d)
        @staticmethod
        def remove_from_blacklist(d): access_control._BLACKLIST.discard(d)

# ===========================================================
# FLASK APP SETUP
# ===========================================================
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="/")
CORS(app)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("dns-app")

# Thread pool for blocking DNS tasks
executor = ThreadPoolExecutor(max_workers=6)
RESOLVE_TIMEOUT = 6  # seconds

# ===========================================================
# ROUTES
# ===========================================================
@app.route("/")
def index():
    index_path = os.path.join(app.static_folder, "index.html")
    if os.path.exists(index_path):
        return send_from_directory(app.static_folder, "index.html")
    return jsonify({"status": "ok", "message": "DNS Resolver running"}), 200


@app.route("/api/test", methods=["GET"])
def api_test():
    return jsonify({
        "status": "ok",
        "message": "Server working fine",
        "timestamp": datetime.now().isoformat()
    })


@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({
        "status": "healthy",
        "blacklist_size": len(access_control._BLACKLIST),
        "timestamp": datetime.now().isoformat()
    })


@app.route("/api/resolve", methods=["POST"])
def api_resolve():
    data = request.get_json() or {}
    domain = str(data.get("domain", "")).strip().lower().rstrip(".")
    mode = str(data.get("mode", "recursive")).strip().lower()
    logger.info(f"🔍 Resolve request for {domain}")

    if not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", domain):
        return jsonify({"error": "Invalid domain format"}), 400

    steps = []

    # 1️⃣ Check blocklist
    blocked, reason = access_control.is_blocked(domain)
    if blocked:
        steps.append({"name": "access_control", "status": "blocked", "info": reason})
        return jsonify({"domain": domain, "blocked": True, "steps": steps}), 200

    steps.append({"name": "access_control", "status": "allowed", "info": ""})

    # 2️⃣ Check cache (used for early return in recursive; for other modes we still write later if missing)
    cached = cache_manager.get_cached(domain)
    if cached and (mode in ("", "recursive", "recursive")):
        steps.append({"name": "cache_lookup", "status": "hit"})
        return jsonify({
            "domain": domain,
            "cached": True,
            "records": cached["records"],
            "ttl": cached["ttl"],
            "steps": steps
        }), 200

    steps.append({"name": "cache_lookup", "status": "miss"})

    # 3️⃣ Resolve (threaded with timeout) — handle modes
    def do_resolve():
        if mode in ("", "recursive"):
            return {"mode": "recursive", **resolver.resolve_all(domain)}
        elif mode == "iterative":
            # Simulate iterative: gather NS at TLD and Auth stages, then final records
            import dns.resolver as dres
            timings = {}
            steps_detail = []
            r = dres.Resolver()
            r.timeout = 3.0
            r.lifetime = 5.0
            # Step 1: Root -> TLD NS
            t0 = time.time()
            tld_part = domain.split(".")[-1]
            try:
                tld_ns = r.resolve(tld_part + ".", "NS", raise_on_no_answer=False)
                tld_ns_vals = [str(getattr(rr, 'target', rr).to_text()).rstrip('.') for rr in tld_ns] if tld_ns else []
            except Exception:
                tld_ns_vals = []
            t1 = time.time()
            timings["root_to_tld_ms"] = int((t1 - t0) * 1000)
            steps_detail.append({"name": "root_query", "status": "done", "ns": tld_ns_vals, "ms": timings["root_to_tld_ms"]})
            # Step 2: TLD -> Auth NS
            t2 = time.time()
            auth_ns_vals = []
            try:
                # query NS for the zone (best-effort: the domain itself)
                auth_ns = r.resolve(domain, "NS", raise_on_no_answer=False)
                auth_ns_vals = [str(getattr(rr, 'target', rr).to_text()).rstrip('.') for rr in auth_ns] if auth_ns else []
            except Exception:
                auth_ns_vals = []
            t3 = time.time()
            timings["tld_to_auth_ms"] = int((t3 - t2) * 1000)
            steps_detail.append({"name": "tld_query", "status": "done", "ns": auth_ns_vals, "ms": timings["tld_to_auth_ms"]})
            # Step 3: Auth -> Final records (full set and A/AAAA focus)
            t4 = time.time()
            full = resolver.resolve_all(domain) or {"records": {}, "ttl": 300}
            aaaa = resolver.resolve_types(domain, ["A", "AAAA"]) or {"records": {}}
            t5 = time.time()
            timings["auth_to_ip_ms"] = int((t5 - t4) * 1000)
            steps_detail.append({"name": "auth_query", "status": "done", "ms": timings["auth_to_ip_ms"]})
            # Merge A/AAAA into full records
            records = full.get("records", {}) or {}
            for k in ("A", "AAAA"):
                vals = (aaaa.get("records", {}) or {}).get(k)
                if vals:
                    records[k] = vals
            ttl = min(full.get("ttl", 300), aaaa.get("ttl", 300))
            return {"mode": "iterative", "records": records, "ttl": ttl, "iterative": {"steps": steps_detail, "timings": timings}}
        elif mode == "multi":
            # Parallel A and AAAA with per-type latency
            from concurrent.futures import ThreadPoolExecutor
            def timed_resolve(tp):
                t0 = time.time()
                rr = resolver.resolve_types(domain, [tp])
                t1 = time.time()
                return rr, int((t1 - t0) * 1000)
            with ThreadPoolExecutor(max_workers=3) as ex:
                fa = ex.submit(timed_resolve, "A")
                faaaa = ex.submit(timed_resolve, "AAAA")
                fall = ex.submit(resolver.resolve_all, domain)  # fetch full record set for results panel
                (ra, a_ms) = fa.result()
                (raaaa, aaaa_ms) = faaaa.result()
                full_records = fall.result() if fall else {"records": {}, "ttl": 300}
            total_ms = max(a_ms, aaaa_ms)
            recA = ra.get("records", {}).get("A", [])
            recAAAA = raaaa.get("records", {}).get("AAAA", [])
            # Detect NXDOMAIN from either branch or the full resolve
            def has_nx(rec):
                try:
                    err = (rec or {}).get("records", {}).get("error")
                    items = err if isinstance(err, list) else ([str(err)] if err else [])
                    j = " ".join([str(x).lower() for x in items])
                    return "nxdomain" in j or "does not exist" in j
                except Exception:
                    return False
            nxa = has_nx(ra)
            nxb = has_nx(raaaa)
            nxfull = has_nx(full_records)
            # Choose faster by smaller latency among those that have an answer
            faster = "-"
            if recA and recAAAA:
                faster = "A" if a_ms <= aaaa_ms else "AAAA"
            elif recA and not recAAAA:
                faster = "A"
            elif recAAAA and not recA:
                faster = "AAAA"
            ttl = min(ra.get("ttl", 300), raaaa.get("ttl", 300)) if (recA or recAAAA) else max(ra.get("ttl", 300), raaaa.get("ttl", 300))
            response = {
                "mode": "multi",
                "ttl": ttl,
                "multi": {
                    "A": recA,
                    "AAAA": recAAAA,
                    "faster": faster,
                    "latency_ms": {"A": a_ms, "AAAA": aaaa_ms, "total": total_ms}
                }
            }
            # Surface NXDOMAIN at top-level records for consistent frontend handling
            if nxa and nxb or nxfull:
                response["records"] = {"error": ["NXDOMAIN (domain does not exist)"]}
            else:
                # Provide comprehensive records table (A/AAAA/CNAME/MX/NS/TXT/SRV/CAA) for results panel
                try:
                    response["records"] = full_records.get("records", {}) or {}
                    # ensure A/AAAA present from the parallel branch if available
                    if recA:
                        response["records"]["A"] = recA
                    if recAAAA:
                        response["records"]["AAAA"] = recAAAA
                    # TTL as min of sources
                    response["ttl"] = min(ttl, full_records.get("ttl", ttl))
                except Exception:
                    pass
            return response
        else:
            return {"mode": "recursive", **resolver.resolve_all(domain)}

    future = executor.submit(do_resolve)
    try:
        result = future.result(timeout=RESOLVE_TIMEOUT)
    except TimeoutError:
        steps.append({"name": "dns_query", "status": "timeout"})
        return jsonify({
            "domain": domain,
            "cached": False,
            "records": {},
            "steps": steps,
            "message": f"DNS query timed out after {RESOLVE_TIMEOUT}s"
        }), 504

    mode_used = (result or {}).get("mode", mode or "recursive")

    if mode_used == "recursive":
        # 4️⃣ Cache and return (support negative caching e.g., NXDOMAIN)
        records = result.get("records", {})
        ttl = result.get("ttl", 300)
        # Write to cache if not already present
        if not cached:
            cache_manager.set_cache(domain, records, ttl)

        # Determine DNS query outcome for visualization
        status = "success"
        try:
            errors = []
            if isinstance(records, dict):
                err = records.get("error")
                if isinstance(err, list):
                    errors = [str(e).lower() for e in err]
                elif isinstance(err, str):
                    errors = [err.lower()]
            if any("nxdomain" in e for e in errors):
                status = "nxdomain"
        except Exception:
            pass

        steps.append({"name": "dns_query", "status": status})
        steps.append({"name": "cache_update", "status": "done"})

        return jsonify({
            "domain": domain,
            "mode": mode_used,
            "cached": False,
            "records": records,
            "ttl": ttl,
            "steps": steps
        }), 200

    if mode_used == "iterative":
        it = result.get("iterative", {})
        # Write A/AAAA to cache if not present
        records = result.get("records", {}) or {}
        ttl = result.get("ttl", 300)
        if not cached:
            cache_manager.set_cache(domain, records, ttl)
        return jsonify({
            "domain": domain,
            "mode": mode_used,
            "records": result.get("records", {}),
            "ttl": result.get("ttl", 300),
            "iterative": it,
            "steps": steps + [
                {"name": "dns_iterative", "status": "root"},
                {"name": "dns_iterative", "status": "tld"},
                {"name": "dns_iterative", "status": "auth"}
            ]
        }), 200

    if mode_used == "multi":
        # Build combined records and write to cache if not present
        m = result.get("multi", {})
        combined_records = {}
        if isinstance(m.get("A"), list) and m.get("A"):
            combined_records["A"] = m.get("A")
        if isinstance(m.get("AAAA"), list) and m.get("AAAA"):
            combined_records["AAAA"] = m.get("AAAA")
        if not combined_records:
            combined_records = {"error": ["No DNS records found"]}
        ttl = result.get("ttl", 300)
        if not cached:
            cache_manager.set_cache(domain, combined_records, ttl)
        return jsonify({
            "domain": domain,
            "mode": mode_used,
            "ttl": result.get("ttl", 300),
            "multi": result.get("multi", {})
        }), 200

    # Fallback
    return jsonify({"domain": domain, "mode": mode_used, "records": result.get("records", {}), "ttl": result.get("ttl", 300)}), 200


@app.route("/api/cache", methods=["GET"])
def api_cache():
    summary = cache_manager.get_cache_summary()
    entries = [{"domain": d, **info} for d, info in summary.items()]
    return jsonify({"entries": entries, "count": len(entries)}), 200


@app.route("/api/cache/clear", methods=["DELETE"])
def api_cache_clear():
    count = cache_manager.clear_cache()
    return jsonify({"message": f"Cache cleared ({count} entries removed)"}), 200


@app.route("/api/block", methods=["POST"])
def api_block():
    data = request.get_json() or {}
    domain = str(data.get("domain", "")).strip().lower()
    access_control.add_to_blacklist(domain)
    return jsonify({"message": f"{domain} blocked"}), 200


@app.route("/api/unblock", methods=["POST"])
def api_unblock():
    data = request.get_json() or {}
    domain = str(data.get("domain", "")).strip().lower()
    access_control.remove_from_blacklist(domain)
    return jsonify({"message": f"{domain} unblocked"}), 200


@app.route("/api/blocked", methods=["GET"])
def api_blocked():
    return jsonify({"blocked_domains": sorted(list(access_control._BLACKLIST))}), 200


@app.errorhandler(404)
def handle_404(e):
    return jsonify({"error": "Not Found", "message": f"The requested URL {request.path} was not found."}), 404


# ===========================================================
# ENTRY POINT
# ===========================================================
if __name__ == "__main__":
    print("\n" + "="*60)
    print("🚀 DNS Resolver Server Running")
    print("="*60)
    print("🌐 http://127.0.0.1:5001")
    print("📡 /api/test /api/resolve /api/cache /api/block /api/unblock")
    print("="*60)
    app.run(host="127.0.0.1", port=5001, debug=True, use_reloader=False)
