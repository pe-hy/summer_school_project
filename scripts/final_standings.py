"""Final ranking, scored on the hidden part of the test set.

The leaderboard shows accuracy on a fixed public slice; this prints the ranking
on the rows students never saw. Run it on the server's database file.

    python scripts/final_standings.py [path/to/leaderboard.json]
"""
import json
import sys
from pathlib import Path

db_path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/leaderboard.json")
rows = list(json.loads(db_path.read_text(encoding="utf-8")).get("submissions", {}).values())

people: dict[str, dict] = {}
for r in rows:
    p = people.setdefault(r.get("person_key", r.get("name", "?")), {"name": r.get("name", "?")})
    p[r["benchmark"]] = r

print(f"{'#':>3}  {'name':30s} {'A public':>9} {'A final':>9} {'B public':>9} {'B final':>9} {'FINAL':>8}")
table = []
for p in people.values():
    parts = []
    for bench in ("A", "B"):
        row = p.get(bench) or {}
        parts.append((row.get("metric"), row.get("metric_hidden")))
    final = sum((h or 0) for _pub, h in parts) / 2
    table.append((final, p["name"], parts))
for rank, (final, name, parts) in enumerate(sorted(table, reverse=True), 1):
    cells = "".join(f"{(pub or 0)*100:8.2f}% {(hid or 0)*100:8.2f}%" for pub, hid in parts)
    print(f"{rank:>3}  {name[:30]:30s} {cells} {final*100:7.2f}%")
print(f"\n{len(table)} participants. 'final' columns are the hidden slice; the board showed only 'public'.")
