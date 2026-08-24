# Workshop data

Built by `scripts/build_data.py` from the public sources below. Give students
`benchmark_a/` and `benchmark_b/`; keep `_instructor/` (git-ignored).

| Benchmark | Source | Pool | Test | Categories |
|---|---|---|---|---|
| A | BANKING77 (PolyAI), canonical train/test split | 10,003 | 3,080 | 77 |
| B | CLINC-150 (`clinc/oos-eval`, `data_full.json`), in-domain only, train+val merged as the pool | 18,000 | 4,500 | 150 |

Per benchmark:

- `pool.tsv` : `id \t text`, shuffled, labels stripped. This is what students label.
- `test.tsv` : `id \t text \t intent`, shuffled. Students measure accuracy against this.
- `intents.txt` : the category names, one per line.
- `_instructor/pool_labels_<a|b>.tsv` : `id \t intent`, the pool's true labels.

Notes:

- Ids are positions after shuffling with a fixed seed, so ordering carries no signal.
  Re-running the build script reproduces the files byte for byte.
- BANKING77 ships one label with an odd capital (`Refund_not_showing_up`); it is
  lowercased here so the category names are consistent.
- A handful of messages appear in both pool and test (7 in A, 1 in B). That is in
  the original corpora and is left as is.
- Reference baseline (char TF-IDF + LinearSVC trained on the full pool labels):
  90.7 % on A, 91.9 % on B, under 1 ms per message on CPU. Students working from
  LLM labels should land below this.
