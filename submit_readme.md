# Submitting your results to the leaderboard

There are **two benchmarks — A and B** (see the [assignment](/assignment)), and each has
its own ladder. Upload with the **Upload results** button: either **one combined file**
with both results, or **one file per benchmark** (uploading again only replaces the
benchmarks contained in the file).

## Required fields — one row/object per benchmark

| Field          | Type                 | Meaning                                          |
|----------------|----------------------|--------------------------------------------------|
| `name`         | text, max 80 chars   | your name (identical in both entries)            |
| `benchmark`    | `"A"` or `"B"`       | which benchmark this result belongs to           |
| `metric`       | number, 0–1          | top-1 accuracy as a fraction (e.g. `0.9312`)     |
| `latency_ms`   | number, ≥ 0          | your `L`: mean **milliseconds per example**, the median of your three timed runs |

- No other fields are allowed; numbers use a dot as the decimal separator.
- One file may contain **one or two** results — never two for the same benchmark.
- Your ladder score is `S = 100 × accuracy − log2(latency_ms)`; halving your latency
  is worth one accuracy point. The overall standing averages S over both benchmarks
  (a missing benchmark counts as 0).

## CSV format (one or two data rows)

```csv
name,benchmark,metric,latency_ms
Jane Doe,A,0.9312,1.37
Jane Doe,B,0.9698,24.35
```

## JSON format (one object, or an array with one per benchmark)

```json
[
  { "name": "Jane Doe", "benchmark": "A", "metric": 0.9312, "latency_ms": 1.37 },
  { "name": "Jane Doe", "benchmark": "B", "metric": 0.9698, "latency_ms": 24.35 }
]
```

Templates: [`submission.csv`](examples/submission.csv) · [`submission.json`](examples/submission.json).

## Editing or deleting

Your browser remembers your uploads (no account needed). In the **same browser** you can
re-upload to replace a result, or delete per benchmark / everything. If you switch
browsers or clear site data, ask an organiser.

Each `name` can appear only once per benchmark. If your upload is refused with
*"a submission for … already exists"*, it was either your own earlier upload from
another browser or a namesake — either way, ask an organiser.

## Common mistakes

- Accuracy as a percentage (`93.12`) — submit the fraction (`0.9312`).
- Latency in **seconds** — submit milliseconds per example (the `L` from `timing.json`).
- Two rows with the same `benchmark`, or different `name`s in one file.
- Extra or misspelt fields (`score`, `avg_time_s` are not accepted).
