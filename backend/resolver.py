# resolver.py
import dns.resolver
import dns.exception
import logging
from typing import Dict, Any, List

logger = logging.getLogger("dns-resolver")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# Configure defaults (tune via environment variables if desired)
DEFAULT_TTL = 300
QUERY_TIMEOUT = 3.0    # per-attempt timeout (seconds)
QUERY_LIFETIME = 5.0   # overall lifetime for resolver.resolve

RECORD_TYPES = ["A", "AAAA", "MX", "NS", "CNAME", "TXT", "SRV", "CAA"]

def _extract_values(rtype: str, answers) -> List[str]:
    vals = []
    if answers is None:
        return vals
    try:
        for r in answers:
            if rtype in ("A", "AAAA"):
                # address attribute for A/AAAA
                vals.append(getattr(r, "address", r.to_text()))
            elif rtype == "MX":
                vals.append(f"{getattr(r, 'preference', '')} {str(getattr(r, 'exchange', r)).rstrip('.')}".strip())
            elif rtype == "NS":
                # different dnspython versions use .target or .to_text()
                txt = getattr(r, "target", None) or r.to_text()
                vals.append(str(txt).rstrip("."))
            elif rtype == "CNAME":
                txt = getattr(r, "target", None) or r.to_text()
                vals.append(str(txt).rstrip("."))
            elif rtype == "TXT":
                # TXT may be a list of bytes/strings
                txt = r.to_text()
                vals.append(txt.strip('"'))
            elif rtype == "SRV":
                # priority weight port target
                try:
                    priority = getattr(r, "priority", None)
                    weight = getattr(r, "weight", None)
                    port = getattr(r, "port", None)
                    target = getattr(r, "target", None) or r.to_text()
                    vals.append(f"{priority} {weight} {port} {str(target).rstrip('.')}".strip())
                except Exception:
                    vals.append(r.to_text())
            elif rtype == "CAA":
                # flags tag value
                try:
                    flags = getattr(r, "flags", None)
                    tag = getattr(r, "tag", None)
                    value = getattr(r, "value", None)
                    if isinstance(value, bytes):
                        try:
                            value = value.decode()
                        except Exception:
                            value = str(value)
                    value_str = str(value).strip('"') if value is not None else ""
                    vals.append(f"{flags} {tag} \"{value_str}\"")
                except Exception:
                    vals.append(r.to_text())
            else:
                vals.append(r.to_text())
    except Exception:
        # fallback to textual representation
        try:
            for r in answers:
                vals.append(r.to_text())
        except Exception:
            pass
    return vals

def resolve_all(domain: str) -> Dict[str, Any]:
    """
    Resolve common record types for `domain`.
    Returns: {"records": {rtype: [values]}, "ttl": int}
    Always returns a dict (never raises).
    """
    result = {"records": {}, "ttl": DEFAULT_TTL}

    try:
        resolver = dns.resolver.Resolver()
        resolver.timeout = float(QUERY_TIMEOUT)
        resolver.lifetime = float(QUERY_LIFETIME)
        # Optionally you might set resolver.nameservers = [...] from env

        min_ttl = None
        for rtype in RECORD_TYPES:
            try:
                answers = resolver.resolve(domain, rtype, raise_on_no_answer=False)
                # determine TTL if available
                ttl = None
                if answers and getattr(answers, "rrset", None) is not None:
                    ttl = getattr(answers.rrset, "ttl", None)
                    try:
                        ttl = int(ttl) if ttl is not None else None
                    except Exception:
                        ttl = None

                vals = _extract_values(rtype, answers)
                if vals:
                    result["records"][rtype] = vals
                    if ttl:
                        if min_ttl is None:
                            min_ttl = ttl
                        else:
                            min_ttl = min(min_ttl, ttl)

            except dns.resolver.NXDOMAIN:
                logger.warning("NXDOMAIN: %s", domain)
                # nothing more to gain; domain doesn't exist
                result["records"] = {"error": ["NXDOMAIN (domain does not exist)"]}
                result["ttl"] = DEFAULT_TTL
                return result
            except dns.resolver.NoNameservers:
                logger.warning("NoNameservers for %s", domain)
                # Try continuing — may have other records types resolvable
            except dns.exception.Timeout:
                logger.warning("Timeout resolving %s %s", domain, rtype)
            except dns.resolver.NoAnswer:
                logger.debug("No %s record for %s", rtype, domain)
            except Exception as e:
                logger.exception("Unexpected error resolving %s %s: %s", domain, rtype, e)

        # TTL: if we collected at least one TTL, choose min_ttl; else fallback to DEFAULT_TTL
        result["ttl"] = int(min_ttl) if (min_ttl is not None and min_ttl > 0) else DEFAULT_TTL

        if not result["records"]:
            result["records"] = {"error": ["No DNS records found"]}

        logger.info("Resolved %s -> %s", domain, list(result["records"].keys()))
        return result

    except Exception as e:
        logger.exception("Resolver unexpected failure for %s: %s", domain, e)
        return {"records": {"error": [str(e)]}, "ttl": DEFAULT_TTL}


def resolve_types(domain: str, types: List[str]) -> Dict[str, Any]:
    """
    Resolve a subset of record types for `domain`.
    Returns: {"records": {rtype: [values]}, "ttl": int}
    """
    result = {"records": {}, "ttl": DEFAULT_TTL}
    try:
        r = dns.resolver.Resolver()
        r.timeout = float(QUERY_TIMEOUT)
        r.lifetime = float(QUERY_LIFETIME)
        min_ttl = None
        for rtype in types:
            try:
                answers = r.resolve(domain, rtype, raise_on_no_answer=False)
                ttl = None
                if answers and getattr(answers, "rrset", None) is not None:
                    ttl = getattr(answers.rrset, "ttl", None)
                    try:
                        ttl = int(ttl) if ttl is not None else None
                    except Exception:
                        ttl = None
                vals = _extract_values(rtype, answers)
                if vals:
                    result["records"][rtype] = vals
                    if ttl:
                        min_ttl = ttl if min_ttl is None else min(min_ttl, ttl)
            except dns.resolver.NXDOMAIN:
                logger.warning("NXDOMAIN: %s", domain)
                return {"records": {"error": ["NXDOMAIN (domain does not exist)"]}, "ttl": DEFAULT_TTL}
            except Exception:
                continue
        result["ttl"] = int(min_ttl) if (min_ttl is not None and min_ttl > 0) else DEFAULT_TTL
        if not result["records"]:
            result["records"] = {"error": ["No DNS records found"]}
        return result
    except Exception as e:
        logger.exception("resolve_types failure for %s: %s", domain, e)
        return {"records": {"error": [str(e)]}, "ttl": DEFAULT_TTL}
