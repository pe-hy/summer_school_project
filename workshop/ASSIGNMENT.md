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
| `test.tsv` | the evaluation messages with their correct categories |

## Labels

The training pool is unlabeled on purpose. Producing labels is part of the
project. Label a few hundred messages by hand, write rules, or use an LLM
through OpenRouter to label the pool for you. How much you label and how much
you trust the LLM is up to you.

Two rules:

1. Do not look up the original datasets' labels online.
2. `test.tsv` is only for measuring. Never train on it and never let your
   labeling pipeline see it.

## What counts

Two numbers per benchmark, measured by you on the test set:

- **Accuracy**: the fraction of test messages your system gets right (0 to 1).
- **Average time per example**: milliseconds per message. Load your model first,
  then time the classification of the test messages one at a time and divide by
  their count. Everything runs on a Colab T4, so the numbers are comparable.

## The leaderboard

Upload one file, CSV or JSON, with one row per benchmark. Templates and a guide
are on the site. Re-upload to update. You can submit the benchmarks separately
or together.

Ladders rank by accuracy. The overall standing is the average of your two
accuracies. A skipped benchmark counts as 0.

[Open the leaderboard](/)
