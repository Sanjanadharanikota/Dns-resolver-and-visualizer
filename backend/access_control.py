# access_control.py
import os
from typing import Set, Tuple

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_BASE_DIR, "data")
_BLACKLIST_PATH = os.path.join(_DATA_DIR, "blacklist.txt")
_WHITELIST_PATH = os.path.join(_DATA_DIR, "whitelist.txt")

_BLACKLIST: Set[str] = set()
_WHITELIST: Set[str] = set()

def _ensure_data_dir() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)

def _normalize(name: str) -> str:
    return name.strip().lower().rstrip(".")

def _load_list(path: str) -> Set[str]:
    items: Set[str] = set()
    if not os.path.exists(path):
        return items
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            items.add(_normalize(line))
    return items

def _save_list(path: str, items: Set[str]) -> None:
    _ensure_data_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for item in sorted(items):
            fh.write(item + "\n")
    os.replace(tmp, path)

def load_lists() -> None:
    """Load blacklist and whitelist from disk (no-throw)."""
    global _BLACKLIST, _WHITELIST
    _ensure_data_dir()
    try:
        _BLACKLIST = _load_list(_BLACKLIST_PATH)
    except Exception:
        _BLACKLIST = set()
    try:
        _WHITELIST = _load_list(_WHITELIST_PATH)
    except Exception:
        _WHITELIST = set()

def _matches(domain: str, patterns: Set[str]) -> bool:
    if not patterns:
        return False
    domain = _normalize(domain)
    for pat in patterns:
        if domain == pat or domain.endswith("." + pat):
            return True
    return False

def is_blocked(domain: str) -> Tuple[bool, str]:
    domain = _normalize(domain)
    if not domain:
        return True, "invalid-domain"
    # whitelist (if non-empty) restricts allowed domains
    if _WHITELIST and not _matches(domain, _WHITELIST):
        return True, "not-whitelisted"

    if _matches(domain, _BLACKLIST):
        return True, "blacklist"

    return False, ""

def add_to_blacklist(domain: str) -> None:
    domain = _normalize(domain)
    if not domain:
        return
    _BLACKLIST.add(domain)
    _save_list(_BLACKLIST_PATH, _BLACKLIST)

def remove_from_blacklist(domain: str) -> None:
    domain = _normalize(domain)
    if domain in _BLACKLIST:
        _BLACKLIST.remove(domain)
        _save_list(_BLACKLIST_PATH, _BLACKLIST)

def get_blacklist() -> Set[str]:
    return set(_BLACKLIST)

def get_whitelist() -> Set[str]:
    return set(_WHITELIST)
