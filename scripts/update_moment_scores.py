#!/usr/bin/env python3
"""Refresh Kairo Moment Scores from Realtor.com Economic Research county data.

Downloads the public county history CSV (no login), computes each market's
score, writes data/moment-scores.json, embeds the same data in
src/kairo-realty.html (published page) and rebuilds index.html.
Exits non-zero, changing nothing, if the data cannot be fetched or validated.
"""
import csv, io, json, re, sys, urllib.request, datetime, zoneinfo
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_County_History.csv"
MARKETS = [  # (tab name, area label, county FIPS)
    ("Nassau", "Nassau County, Long Island", "36059"),
    ("Suffolk", "Suffolk County, Long Island", "36103"),
    ("Brooklyn", "Brooklyn (Kings County)", "36047"),
    ("Queens", "Queens", "36081"),
    ("The Bronx", "The Bronx", "36005"),
    ("Staten Island", "Staten Island (Richmond County)", "36085"),
]
# year-over-year change in each metric; +1 means a higher value favors sellers
COMPONENTS = [("pending_ratio_yy", +1), ("median_days_on_market_yy", -1),
              ("price_reduced_share_yy", -1), ("active_listing_count_yy", -1)]
LOOKBACK = 36

def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def pct_rank(series, x):
    vals = [v for v in series if v is not None]
    if not vals or x is None: return None
    below = sum(v < x for v in vals); eq = sum(v == x for v in vals)
    return (below + 0.5 * eq) / len(vals)

def money(v):
    return f"${v/1e6:.2f}M" if v >= 1e6 else f"${round(v/1e3):,}K"

def signal(score):
    return "Seller's moment" if score >= 60 else ("Buyer's moment" if score < 40 else "Balanced market")

def change(v, noun_up, noun_down):
    if v is None or abs(v) < 0.005: return "about the same as a year ago"
    return f"{noun_up if v > 0 else noun_down} {abs(v)*100:.0f}% from a year ago"

def main():
    want = {f for _, _, f in MARKETS}
    rows = {f: [] for f in want}
    with urllib.request.urlopen(URL, timeout=300) as r:
        for row in csv.DictReader(io.TextIOWrapper(r, encoding="utf-8")):
            f = row["county_fips"].zfill(5)
            if f in want: rows[f].append(row)
    out = []
    latest_months = set()
    for name, area, fips in MARKETS:
        h = sorted(rows[fips], key=lambda r: r["month_date_yyyymm"])
        if len(h) < 13: sys.exit(f"Not enough history for {area}")
        cur = h[-1]; window = h[-LOOKBACK-1:-1]
        latest_months.add(cur["month_date_yyyymm"])
        parts = []
        for col, sign in COMPONENTS:
            p = pct_rank([num(r[col]) for r in window], num(cur[col]))
            if p is not None: parts.append(p if sign > 0 else 1 - p)
        if len(parts) < 3: sys.exit(f"Missing metrics for {area}")
        score = round(100 * sum(parts) / len(parts))
        price, dom, active = num(cur["median_listing_price"]), num(cur["median_days_on_market"]), num(cur["active_listing_count"])
        reduced, pending = num(cur["price_reduced_share"]), num(cur["pending_ratio"])
        if None in (price, dom, active): sys.exit(f"Missing core values for {area}")
        why = (f"Homes are spending a median {dom:.0f} days on market, "
               f"{change(num(cur['median_days_on_market_yy']), 'up', 'down')}. "
               + (f"{reduced*100:.0f}% of listings took a price cut. " if reduced is not None else "")
               + f"Active listings are {change(num(cur['active_listing_count_yy']), 'up', 'down')}.")
        out.append({"name": name, "area": area, "score": score, "signal": signal(score), "why": why,
                    "median": money(price), "dom": int(dom), "active": int(active),
                    "pending_ratio": pending,
                    "trend": [round(num(r["median_listing_price"])) for r in h[-12:]]})
    if len(latest_months) != 1: sys.exit(f"Counties disagree on latest month: {latest_months}")
    m = latest_months.pop()
    month_label = datetime.date(int(m[:4]), int(m[4:]), 1).strftime("%B %Y")
    today = datetime.datetime.now(zoneinfo.ZoneInfo("America/New_York")).date()
    data = {"source": "Realtor.com Economic Research", "source_url": "https://www.realtor.com/research/data/",
            "data_month": m, "month_label": month_label,
            "checked": today.isoformat(), "checked_label": today.strftime("%b %-d, %Y"),
            "markets": out}
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data/moment-scores.json").write_text(json.dumps(data, indent=2) + "\n")
    page = ROOT / "src/kairo-realty.html"
    src = page.read_text()
    blob = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    src, n = re.subn(r"/\*DATA\*/.*?/\*END\*/", lambda _: "/*DATA*/" + blob + "/*END*/", src, flags=re.S)
    if n != 1: sys.exit("Data marker not found in src/kairo-realty.html")
    prompt = json.dumps((ROOT / "concierge/system-prompt.md").read_text().strip()).replace("</", "<\\/")
    src, n = re.subn(r"/\*PROMPT\*/.*?/\*ENDPROMPT\*/", lambda _: "/*PROMPT*/" + prompt + "/*ENDPROMPT*/", src, flags=re.S)
    if n != 1: sys.exit("Prompt marker not found in src/kairo-realty.html")
    page.write_text(src)
    j = src.index("</style>") + len("</style>")
    head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
            '<link rel="icon" type="image/png" href="assets/kairo-logo.png">\n'
            '<meta property="og:title" content="Kairo Realty | Intelligent Real Estate, Perfectly Timed.">\n'
            '<meta property="og:image" content="assets/kairo-logo.png">\n')
    (ROOT / "index.html").write_text(head + src[:j] + "\n</head>\n<body>" + src[j:] + "\n</body>\n</html>\n")
    for x in out: print(f"{x['name']:14} {x['score']:3}  {x['signal']:16} {x['median']:>7}  {x['dom']}d  {x['active']}")
    print("data month:", month_label)

if __name__ == "__main__":
    main()
