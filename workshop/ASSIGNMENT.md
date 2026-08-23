# Final Project: Fast & Accurate Text Classification

## The task

You get two collections of short customer-service messages — **Benchmark A** and
**Benchmark B**. For each one, build a system that reads a message and decides
which **category** it belongs to. (In the data files the categories are called
*intents* — e.g. the message "I lost my card, what do I do?" belongs to the
category `lost_card`.)

|  | Benchmark A | Benchmark B |
|---|---|---|
| Categories | 77 | 150 |
| Structure | one topic area | ten topic areas |
| Training pool | 10,003 messages | 18,000 messages |

Build for both — they look similar but do not behave the same.

## What you get

Per benchmark, in `benchmark_a/` and `benchmark_b/`:

| File | Contents |
|---|---|
| `pool.tsv` | training messages, one per line — **no labels** |
| `intents.txt` | the category names, one per line |
| `test.tsv` | the evaluation messages **with** their correct categories |

## Labels

The training pool comes unlabeled on purpose: producing labels is part of the
project. Label a few hundred by hand, write rules, or — the intended path — use
an LLM through **OpenRouter** to label the pool for you. How much you label, and
how much you trust the LLM, is your call.

Two rules:

1. Don't go hunting for the original datasets' labels online — that defeats the
   whole exercise.
2. `test.tsv` is only for measuring. Never train on it, never let your labeling
   pipeline peek at it.

## What counts

Two numbers per benchmark, measured by you, on the test set:

- **Accuracy** — the fraction of test messages your system gets right (0–1).
- **Average time per example** — milliseconds per message. Load your model first,
  then time the classification of the test messages one at a time and divide by
  their count. Everything runs on a **Colab T4**, so the numbers are comparable.

## The leaderboard

One file — CSV or JSON, one row per benchmark, templates and a guide on the site.
Re-upload to update; the benchmarks can be submitted separately or together.

Ladders rank by accuracy. The overall standing is the average of your two
accuracies; a skipped benchmark counts as 0.

[Open the leaderboard](/)
