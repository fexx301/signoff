"""Free audit preview: send each sampled Kite-catalog endpoint an UNPAID request (its listed example input)
and compare the payment challenge it returns with what the catalog lists. Signs and pays nothing.
Usage: python3 -I scripts/free-audit.py <endpoints.tsv> <out.json>"""
import base64, json, subprocess, sys, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

USDC = {  # USDC contract → (chain, decimals)
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ("base", 6),
    "epjfwdd5aufqssqem2qn1xzybapc8g4wegkzwytdt1v": ("solana", 6),
}

def detail(eid):
    r = subprocess.run(["ksearch", "service", "search", "--example", eid, "--output", "json", "--no-interactive"],
                       capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout)

def challenge(resp_headers, body):
    for k, v in resp_headers.items():
        if k.lower() in ("payment-required", "x-payment-required"):
            try:
                return json.loads(base64.b64decode(v + "=" * (-len(v) % 4)))
            except Exception:
                pass
    try:
        return json.loads(body)
    except Exception:
        return None

def probe(eid):
    rec = {"id": eid}
    try:
        d = detail(eid)
    except Exception as e:
        return {**rec, "outcome": "no_detail", "err": str(e)[:120]}
    f = d.get("facts") or {}
    rec.update(host=d.get("host"), method=d.get("method"), path=d.get("path"), state=f.get("state"),
               listed_usd=f.get("price_usd"), route=f.get("route"), example=f.get("example"))
    ex = d.get("example_input") or {}
    url = ex.get("url") or d.get("url") or ""
    if ":" in (d.get("path") or "") or "{" in url:
        return {**rec, "outcome": "skipped_path_params"}
    if ex.get("query"):
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({k: v if isinstance(v, str) else json.dumps(v) for k, v in ex["query"].items()})
    data = json.dumps(ex["body"]).encode() if ex.get("body") is not None else None
    req = urllib.request.Request(url, data=data, method=d.get("method") or "GET",
                                 headers={"content-type": "application/json", "user-agent": "signoff-audit-preview/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            status, hdrs, body = r.status, dict(r.headers), r.read(4000).decode("utf8", "replace")
    except urllib.error.HTTPError as e:
        status, hdrs, body = e.code, dict(e.headers), e.read(4000).decode("utf8", "replace")
    except Exception as e:
        return {**rec, "outcome": "unreachable", "err": type(e).__name__ + ": " + str(e)[:100]}
    rec["http"] = status
    if 200 <= status < 300:
        return {**rec, "outcome": "served_without_payment", "body_head": body[:200]}
    if status != 402:
        return {**rec, "outcome": f"http_{status}", "body_head": body[:200]}
    ch = challenge(hdrs, body)
    accepts = (ch or {}).get("accepts") or []
    if not accepts:
        return {**rec, "outcome": "402_unparsed", "body_head": body[:200]}
    offers = []
    for a in accepts:
        asset = str(a.get("asset", "")).lower()
        chain, dec = USDC.get(asset, (a.get("network"), None))
        amt = a.get("amount") or a.get("maxAmountRequired")
        usd = int(amt) / 10 ** dec if dec is not None and str(amt).isdigit() else None
        offers.append({"network": a.get("network"), "chain": chain, "usd": usd, "payTo": a.get("payTo")})
    rec["offers"] = offers
    base = [o["usd"] for o in offers if o["chain"] == "base" and o["usd"] is not None]
    rec["challenge_usd"] = min(base) if base else None
    lst = rec.get("listed_usd")
    if rec["challenge_usd"] is None or lst is None:
        rec["outcome"] = "402_price_unknown"
    elif abs(rec["challenge_usd"] - lst) <= max(1e-6, 0.01 * lst):
        rec["outcome"] = "402_price_matches"
    else:
        rec["outcome"] = "402_price_differs"
    return rec

if __name__ == "__main__":
    ids = [l.split("\t")[0] for l in open(sys.argv[1]) if l.strip()]
    with ThreadPoolExecutor(12) as ex:
        rows = list(ex.map(probe, ids))
    json.dump(rows, open(sys.argv[2], "w"), indent=1)
    from collections import Counter
    print(len(rows), "endpoints")
    print(Counter(r["outcome"] for r in rows).most_common())
    print("by listed state:", Counter((r.get("state"), r["outcome"]) for r in rows).most_common(20))
