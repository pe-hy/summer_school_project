"""Build the workshop data files for Benchmark A (BANKING77) and B (CLINC-150).

Per benchmark:
  pool.tsv     id \t text          (training messages, labels stripped, shuffled)
  intents.txt  one category name per line
  test.tsv     id \t text \t intent  (evaluation set, with labels)

Also writes _instructor/pool_labels_<x>.tsv (the pool's true labels) for reference.
"""
import csv, hashlib, io, json, random, sys, urllib.request
from pathlib import Path

OUT = Path("/pfs/lustrep4/scratch/project_465002631/Petr/summer_school_project/workshop/data")
SEED = 20260824

SRC = {
    "b77_train": "https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/train.csv",
    "b77_test": "https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/test.csv",
    "clinc": "https://raw.githubusercontent.com/clinc/oos-eval/master/data/data_full.json",
}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    print(f"  fetched {url.rsplit('/', 1)[-1]}: {len(data):,} bytes  sha256={hashlib.sha256(data).hexdigest()[:16]}")
    return data


def clean(text: str) -> str:
    """One message per line, and parseable by every TSV reader.

    Whitespace (tabs, newlines) is collapsed, and the double-quote character is
    replaced by an apostrophe: a field that starts with a quote makes pandas and
    csv.reader treat it as an opening quote and swallow the following rows. 93
    of ~35,500 messages are affected and their meaning is unchanged.
    """
    return " ".join(str(text).replace('"', "'").split())


def write_benchmark(key: str, pool: list[tuple[str, str]], test: list[tuple[str, str]], intents: list[str]) -> dict:
    """pool/test are lists of (text, intent). Ids are assigned after shuffling."""
    rng = random.Random(SEED + (0 if key == "a" else 1))
    pool = pool[:]
    test = test[:]
    rng.shuffle(pool)
    rng.shuffle(test)

    d = OUT / f"benchmark_{key}"
    d.mkdir(parents=True, exist_ok=True)

    with open(d / "pool.tsv", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("id\ttext\n")
        for i, (text, _label) in enumerate(pool, 1):
            fh.write(f"{i}\t{text}\n")
    with open(d / "test.tsv", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("id\ttext\tintent\n")
        for i, (text, label) in enumerate(test, 1):
            fh.write(f"{i}\t{text}\t{label}\n")
    with open(d / "intents.txt", "w", encoding="utf-8", newline="\n") as fh:
        for name in intents:
            fh.write(name + "\n")

    inst = OUT / "_instructor"
    inst.mkdir(parents=True, exist_ok=True)
    with open(inst / f"pool_labels_{key}.tsv", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("id\tintent\n")
        for i, (_text, label) in enumerate(pool, 1):
            fh.write(f"{i}\t{label}\n")

    return {"pool": len(pool), "test": len(test), "intents": len(intents)}


print("Benchmark A: BANKING77")
b77_train = list(csv.DictReader(io.StringIO(fetch(SRC["b77_train"]).decode("utf-8"))))
b77_test = list(csv.DictReader(io.StringIO(fetch(SRC["b77_test"]).decode("utf-8"))))
a_pool = [(clean(r["text"]), r["category"]) for r in b77_train]
a_test = [(clean(r["text"]), r["category"]) for r in b77_test]
a_intents = sorted({lbl for _t, lbl in a_pool} | {lbl for _t, lbl in a_test})
stats_a = write_benchmark("a", a_pool, a_test, a_intents)

print("Benchmark B: CLINC-150 (in-domain only)")
clinc = json.loads(fetch(SRC["clinc"]).decode("utf-8"))
print("  splits:", {k: len(v) for k, v in clinc.items()})
b_pool = [(clean(t), lbl) for t, lbl in clinc["train"] + clinc["val"]]
b_test = [(clean(t), lbl) for t, lbl in clinc["test"]]
b_intents = sorted({lbl for _t, lbl in b_pool} | {lbl for _t, lbl in b_test})
stats_b = write_benchmark("b", b_pool, b_test, b_intents)

# ---- sanity checks -------------------------------------------------------
report = {"A": stats_a, "B": stats_b}
for key, pool, test, intents, expect in (
    ("A", a_pool, a_test, a_intents, {"pool": 10003, "test": 3080, "intents": 77}),
    ("B", b_pool, b_test, b_intents, {"pool": 18000, "test": 4500, "intents": 150}),
):
    got = {"pool": len(pool), "test": len(test), "intents": len(intents)}
    status = "OK " if got == expect else "MISMATCH"
    print(f"{status} Benchmark {key}: {got}  (expected {expect})")
    overlap = {t for t, _ in pool} & {t for t, _ in test}
    print(f"     pool/test text overlap: {len(overlap)}")
    assert all("\t" not in t and "\n" not in t for t, _ in pool + test), "tab/newline leaked into a message"
    assert all(lbl in intents for _t, lbl in test), "test label missing from intents.txt"
    per = len(pool) / len(intents)
    print(f"     ~{per:.0f} pool messages per category")

print("\nfiles:")
for p in sorted(OUT.rglob("*")):
    if p.is_file():
        print(f"  {p.relative_to(OUT)}  {p.stat().st_size:,} bytes  {sum(1 for _ in open(p, encoding='utf-8')):,} lines")
