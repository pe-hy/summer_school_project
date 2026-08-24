# Final Project: Fast and Accurate Text Classification

## The task

You get two collections of short customer service messages, Benchmark A and
Benchmark B. For each one, build a system that reads a message and decides which
category it belongs to. The data files call the categories "intents". For
example, "I lost my card, what do I do?" belongs to the category `lost_card`.

|  | Benchmark A | Benchmark B |
|---|---|---|
| Categories | 77 | 150 |
| Structure | one topic area | ten topic areas |
| Training pool | 10,003 messages | 18,000 messages |

Build for both. They look similar but they do not behave the same.

## What you get

Per benchmark, in `benchmark_a/` and `benchmark_b/`:

| File | Contents |
|---|---|
| `pool.tsv` | training messages, one per line, without labels |
| `intents.txt` | the category names, one per line |
| `test.tsv` | the messages you are graded on, without categories |

[Download the data](/data/benchmarks.zip)

## Labels

The training pool is unlabeled on purpose. Producing labels is part of the
project. Label a few hundred messages by hand, write rules, or use an LLM
through OpenRouter to label the pool for you. How much you label and how much
you trust the LLM is up to you.

Two rules:

1. Do not look up the original datasets' labels online.
2. `test.tsv` is only for measuring. Never train on it and never let your
   labeling pipeline see it.

You have no labels for `test.tsv` and you never will. Hold out part of the pool
as your own validation set.

## What counts

- **Accuracy**: we score it. You upload a category for every message in
  `test.tsv` and the site checks it against the answer key.
- **Average time per example**: you measure it. Load your model first, then
  classify the test messages one at a time and divide the total time by their
  count. Report the milliseconds. Run this on a Colab T4 so the numbers are
  comparable.

When your system classifies, it runs locally: no API calls and no network access
at that point. Use the LLM to label the pool beforehand, then train something of
your own that stands on its own.

## The leaderboard

Upload one file, CSV or JSON, with three columns: `benchmark`, `id`, `intent`.
One row for every message in `test.tsv`, for each benchmark you enter. Both
benchmarks can go in the same file.

```csv
benchmark,id,intent
A,1,card_arrival
A,2,lost_card
B,1,translate
```

You type your name and your milliseconds per message when you upload. Re-upload
as often as you like.

Ladders rank by accuracy. The overall standing is the average of your two
accuracies. A skipped benchmark counts as 0.

The board scores you on part of the test set. The final ranking uses the part it
does not show you, so tuning against the leaderboard buys you nothing.

[Open the leaderboard](/)
