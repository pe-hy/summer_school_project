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
- BANKING77 ships one category name with an inconsistent capital letter; it is
  lowercased here so all category names look the same.
- Double quotes in messages are replaced by apostrophes (93 messages of ~35,500).
  A field that starts with a quote makes `pandas.read_csv` and `csv.reader` treat
  it as an opening quote and swallow the following rows, which silently loses
  thousands of examples. With the replacement the files parse identically under
  `line.split("\t")`, `csv.DictReader` and `pandas.read_csv(sep="\t")`, all with
  default settings.
- A handful of messages appear in both pool and test (7 in A, 1 in B). That is in
  the original corpora and is left as is.
- Reference baseline (char TF-IDF + LinearSVC trained on the full pool labels):
  90.65 % on A, 92.56 % on B, about 0.5 ms per message on CPU. The published
  numbers for that model are 90.4 and 92.3, so the data lines up. Students
  working from LLM labels should land below this.
