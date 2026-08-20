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
    ("Alice Nováková", 0.9412, 2.11),
    ("Bob Svoboda", 0.9275, 1.48),
    ("Carla Dvořáková", 0.9380, 3.95),
    ("David Kučera", 0.9012, 0.98),
    ("Eva Horáková", 0.9412, 2.60),
]

with open("seed_tokens.txt", "a", encoding="utf-8") as log:
    for name, metric, test in DEMO:
        token = uuid.uuid4().hex
        body = json.dumps({"name": name, "metric": metric, "test_time_s": test}).encode()
        req = urllib.request.Request(
            f"{BASE}/api/submissions/mine", data=body, method="PUT",
            headers={"Content-Type": "application/json", "X-Owner-Token": token},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                sub = json.loads(resp.read())["submission"]
                print(f"{resp.status}  {sub['id']}  {name}  token={token}")
                log.write(f"{token}\t{sub['id']}\t{name}\n")
        except urllib.error.HTTPError as e:
            print(f"{e.code}  {name}: {e.read().decode(errors='replace')}")
        except urllib.error.URLError as e:
            sys.exit(f"Cannot reach {BASE}: {e.reason}. Is the server running?")
print("tokens appended to seed_tokens.txt")
