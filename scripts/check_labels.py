"""Validate the Haiku-produced pool labels and merge them into one file per benchmark.

Checks, per chunk: every input id present exactly once, no invented ids, every
label a real category. Then reports agreement with the held-out answer key.

    python scripts/check_labels.py
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CHUNKS = ROOT / "workshop/baseline/chunks"
LABELS = ROOT / "workshop/baseline/labels"
DATA = ROOT / "workshop/data"

problems: list[str] = []
summary = []

for bench in ("a", "b"):
    intents = set((DATA / f"benchmark_{bench}/intents.txt").read_text(encoding="utf-8").split("\n")) - {""}
    truth = pd.read_csv(DATA / f"_instructor/pool_labels_{bench}.tsv", sep="\t").set_index("id")["intent"]
    merged = []
    for chunk in sorted(CHUNKS.glob(f"{bench}*.tsv")):
        want = pd.read_csv(chunk, sep="\t")
        out = LABELS / f"{chunk.stem}.labels.tsv"
        if not out.exists():
            problems.append(f"{chunk.stem}: MISSING output file")
            continue
        try:
            got = pd.read_csv(out, sep="\t", dtype={"id": "Int64"})
        except Exception as e:  # noqa: BLE001
            problems.append(f"{chunk.stem}: unreadable ({e})")
            continue
        if list(got.columns) != ["id", "intent"]:
            problems.append(f"{chunk.stem}: columns {list(got.columns)} (want id, intent)")
            continue
        got = got.dropna()
        missing = set(want["id"]) - set(got["id"])
        extra = set(got["id"]) - set(want["id"])
        dupes = got["id"].duplicated().sum()
        bad = sorted(set(got["intent"]) - intents)
        if missing:
            problems.append(f"{chunk.stem}: {len(missing)} ids missing")
        if extra:
            problems.append(f"{chunk.stem}: {len(extra)} invented ids")
        if dupes:
            problems.append(f"{chunk.stem}: {dupes} duplicate ids")
        if bad:
            problems.append(f"{chunk.stem}: {len(bad)} invalid categories, e.g. {bad[:3]}")
        merged.append(got[got["id"].isin(want["id"])].drop_duplicates(subset="id"))

    if not merged:
        continue
    all_rows = pd.concat(merged).drop_duplicates(subset="id").sort_values("id")
    all_rows = all_rows[all_rows["intent"].isin(intents)]
    dest = LABELS / f"pool_labels_haiku_{bench}.tsv"
    all_rows.to_csv(dest, sep="\t", index=False)

    gold = all_rows["id"].map(truth)
    agree = (gold.values == all_rows["intent"].values).mean()
    covered = all_rows["intent"].nunique()
    summary.append((bench, len(all_rows), agree, covered, len(intents), dest))

print("=" * 68)
for bench, n, agree, covered, ncat, dest in summary:
    print(f"Benchmark {bench.upper()}: {n:,} usable labels | agreement with the answer key {agree*100:.1f} % "
          f"| {covered}/{ncat} categories seen")
    print(f"           -> {dest.relative_to(ROOT)}")
if problems:
    print("\nPROBLEMS:")
    for p in problems:
        print("  -", p)
else:
    print("\nno problems: every chunk complete, every id accounted for, every category valid")
print("=" * 68)
sys.exit(1 if problems else 0)
