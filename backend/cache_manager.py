# cache_manager.py
import json
import os
import time
import threading
from typing import Dict, Optional

# ===========================================================
# GLOBALS
# ===========================================================
_CACHE: Dict[str, dict] = {}
_LOCK = threading.RLock()  # reentrant lock prevents deadlock
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_BASE_DIR, "data")
_CACHE_PATH = os.path.join(_DATA_DIR, "cache.json")


# ===========================================================
# HELPERS
# ===========================================================
def _now() -> int:
    return int(time.time())


def _ensure_data_dir() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)


def _safe_write_json(path: str, data: dict) -> None:
    """Atomic JSON write with fsync for crash safety."""
    _ensure_data_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ===========================================================
# CORE CACHE FUNCTIONS
# ===========================================================
def load_cache() -> None:
    """Load cache.json into memory safely."""
    global _CACHE
    _ensure_data_dir()
    with _LOCK:
        try:
            if not os.path.exists(_CACHE_PATH):
                _safe_write_json(_CACHE_PATH, {})
                _CACHE = {}
                return

            with open(_CACHE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                _CACHE = data if isinstance(data, dict) else {}
        except Exception as e:
            print(f"[cache_manager] Failed to load cache: {e}")
            _CACHE = {}

        clear_expired()  # clean on startup


def save_cache() -> None:
    """Persist the current in-memory cache (thread-safe)."""
    with _LOCK:
        try:
            _safe_write_json(_CACHE_PATH, _CACHE)
        except Exception as e:
            print(f"[cache_manager] Error saving cache: {e}")


def get_cached(domain: str) -> Optional[dict]:
    """Return cached entry if valid; else None."""
    now = _now()
    with _LOCK:
        entry = _CACHE.get(domain)
        if not entry:
            return None
        try:
            ts = int(entry.get("timestamp", 0))
            ttl = int(entry.get("ttl", 0))
            if (ts + ttl) > now:
                return entry
            # expired
            _CACHE.pop(domain, None)
            save_cache()
            return None
        except Exception:
            _CACHE.pop(domain, None)
            save_cache()
            return None


def set_cache(domain: str, records: dict, ttl: int) -> None:
    """Insert or update a domain entry in cache."""
    ttl = int(ttl or 300)
    with _LOCK:
        _CACHE[domain] = {
            "records": records,
            "timestamp": _now(),
            "ttl": ttl,
        }
    save_cache()  # call outside lock context to avoid re-entrance


# ===========================================================
# MAINTENANCE
# ===========================================================
def clear_expired() -> int:
    """Remove expired entries and return count removed."""
    now = _now()
    removed = 0
    with _LOCK:
        expired = [d for d, e in _CACHE.items() if e.get("timestamp", 0) + e.get("ttl", 0) < now]
        for d in expired:
            _CACHE.pop(d, None)
            removed += 1
    if removed:
        save_cache()
    return removed


def clear_cache() -> int:
    """Completely clear the cache and return number removed."""
    with _LOCK:
        count = len(_CACHE)
        _CACHE.clear()
    save_cache()
    return count


# ===========================================================
# SUMMARY
# ===========================================================
def get_cache_summary() -> Dict[str, dict]:
    """Return cache metadata for each domain."""
    now = _now()
    summary: Dict[str, dict] = {}

    with _LOCK:
        for domain, entry in _CACHE.items():
            try:
                ts = int(entry.get("timestamp", 0))
                ttl = int(entry.get("ttl", 0))
                expires_at = ts + ttl
                remaining = max(0, expires_at - now)
                records = entry.get("records", {}) or {}

                first_ip = None
                for t in ("A", "AAAA"):
                    vals = records.get(t) or []
                    if vals:
                        first_ip = vals[0]
                        break

                summary[domain] = {
                    "expires_at": expires_at,
                    "remaining_seconds": remaining,
                    "ttl": ttl,
                    "first_ip": first_ip or "-",
                    "types": list(records.keys()),
                }
            except Exception as e:
                print(f"[cache_manager] Summary error for {domain}: {e}")
    return summary


def get_ttl(domain: str) -> Optional[int]:
    """Return remaining TTL for a cached domain."""
    entry = get_cached(domain)
    if not entry:
        return None
    ts = int(entry.get("timestamp", 0))
    ttl = int(entry.get("ttl", 0))
    return max(0, (ts + ttl) - _now())
