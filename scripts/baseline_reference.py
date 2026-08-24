"""Reference baseline: train on the Haiku labels, evaluate on the test sets.

This is the CPU version of what the Colab notebook does on a T4. It prints the
numbers that go into the notebook's markdown so the two cannot disagree.

    python scripts/baseline_reference.py
"""
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "workshop/data"
LABELS = ROOT / "workshop/baseline/labels"
ENCODER = "sentence-transformers/all-MiniLM-L6-v2"

print(f"loading encoder {ENCODER} ...")
encoder = SentenceTransformer(ENCODER)

rows = []
for bench in ("a", "b"):
    pool = pd.read_csv(DATA / f"benchmark_{bench}/pool.tsv", sep="\t")
    test = pd.read_csv(DATA / f"benchmark_{bench}/test.tsv", sep="\t")
    haiku = pd.read_csv(LABELS / f"pool_labels_haiku_{bench}.tsv", sep="\t")
    truth = pd.read_csv(DATA / f"_instructor/pool_labels_{bench}.tsv", sep="\t").set_index("id")["intent"]

    train = haiku.merge(pool, on="id")
    label_acc = (train["id"].map(truth).values == train["intent"].values).mean()

    X = encoder.encode(train["text"].tolist(), batch_size=256, show_progress_bar=False, normalize_embeddings=True)
    clf = LogisticRegression(max_iter=2000, C=10.0)
    clf.fit(X, train["intent"].tolist())

    texts = test["text"].tolist()
    gold = test["intent"].tolist()

    # accuracy: batch encode (identical predictions, just faster than one at a time)
    Xt = encoder.encode(texts, batch_size=256, show_progress_bar=False, normalize_embeddings=True)
    acc = float(np.mean(clf.predict(Xt) == np.array(gold)))

    # control: same pipeline, same examples, but the TRUE labels -> cost of Haiku's mistakes
    clf_true = LogisticRegression(max_iter=2000, C=10.0)
    clf_true.fit(X, train["id"].map(truth).tolist())
    acc_true = float(np.mean(clf_true.predict(Xt) == np.array(gold)))

    # latency: single messages, end to end, median of 3 passes over a 400-message sample
    sample = texts[:400]
    for t in sample[:50]:
        clf.predict(encoder.encode([t], normalize_embeddings=True))
    runs = []
    for _ in range(3):
        t0 = time.perf_counter()
        for t in sample:
            clf.predict(encoder.encode([t], normalize_embeddings=True))
        runs.append((time.perf_counter() - t0) * 1000 / len(sample))
    latency = float(np.median(runs))

    print(f"\nBenchmark {bench.upper()}")
    print(f"  Haiku labels used        : {len(train):,}  ({len(train)/train['intent'].nunique():.0f} per category)")
    print(f"  label accuracy vs key    : {label_acc*100:.1f} %")
    print(f"  test accuracy (Haiku)    : {acc*100:.2f} %")
    print(f"  test accuracy (true lbls): {acc_true*100:.2f} %   <- same examples, perfect labels")
    print(f"  cost of labeling errors  : {(acc_true-acc)*100:.2f} points")
    print(f"  latency (CPU, 1 at a time): {latency:.2f} ms/example")
    rows.append({"name": "Haiku + MiniLM baseline", "benchmark": bench.upper(),
                 "metric": round(acc, 4), "latency_ms": round(latency, 3)})

print("\nsubmission rows:")
print(pd.DataFrame(rows).to_csv(index=False))
