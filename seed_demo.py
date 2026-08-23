"""Insert a few fake submissions into a *running* leaderboard (for demos).

Usage:  python seed_demo.py [http://localhost:8000]

Each fake row gets its own random owner token, like real uploads from different
browsers. The tokens are written to seed_tokens.txt so the rows can be removed
again, e.g.:  curl -X DELETE -H "X-Owner-Token: <token>" <url>/api/submissions/mine
"""

import json
import sys
import urllib.error
import urllib.request
import uuid

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"

DEMO = [
    # (name, [(benchmark, accuracy, latency_ms), ...])
    ("Alice Nováková", [("A", 0.921, 3.2), ("B", 0.958, 6.1)]),
    ("Bob Svoboda", [("A", 0.895, 0.7), ("B", 0.917, 0.9)]),
    ("Carla Dvořáková", [("A", 0.934, 48.0), ("B", 0.964, 61.5)]),
    ("David Kučera", [("A", 0.902, 11.9)]),
    ("Eva Horáková", [("B", 0.941, 18.4)]),
    ("Filip Veselý", [("A", 0.874, 0.6), ("B", 0.923, 245.0)]),
]

with open("seed_tokens.txt", "a", encoding="utf-8") as log:
    for name, results in DEMO:
        token = uuid.uuid4().hex
        body = json.dumps([{"name": name, "benchmark": b, "metric": m, "latency_ms": l}
                           for b, m, l in results]).encode()
        req = urllib.request.Request(
            f"{BASE}/api/submissions/mine", data=body, method="PUT",
            headers={"Content-Type": "application/json", "X-Owner-Token": token},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                subs = json.loads(resp.read())["submissions"]
                benches = "+".join(x["benchmark"] for x in subs)
                print(f"{resp.status}  {benches}  {name}  token={token}")
                log.write(f"{token}\t{benches}\t{name}\n")
        except urllib.error.HTTPError as e:
            print(f"{e.code}  {name}: {e.read().decode(errors='replace')}")
        except urllib.error.URLError as e:
            sys.exit(f"Cannot reach {BASE}: {e.reason}. Is the server running?")
print("tokens appended to seed_tokens.txt")
