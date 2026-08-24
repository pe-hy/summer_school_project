# Final Project: Fast and Accurate Text Classification

## The task

You get two collections of short customer service messages, Benchmark A and
Benchmark B. For each one, build a system that reads a message and decides which
category it belongs to. The data files call the categories "intents". For
example, "I lost my card, what do I do?" belongs to the category
`lost_or_stolen_card`.

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

You have no labels for `test.tsv` and you never will, so keep your own
validation set: hold out part of the pool before you train and never train on it.

Know what it measures. Those labels came from your own pipeline, so the number
says how well your model agrees with your labels, not how often it is right. It
will catch a broken run and separate two systems that differ a lot. It cannot
settle a close call, and a model that copies every mistake in your labels scores
100 percent on it. Hand-label some of the held-out messages yourself and you
also learn how good your labels are, which is usually the thing worth improving.

The leaderboard is the real test. It scores against the answer key, takes as
many submissions as you like, shows you your score on part of the test set, and
ranks you on the rest.

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

Upload one JSON file with your name, how fast your system ran, and a category
for every message in `test.tsv`. Both benchmarks go in the same file. The `id`
comes from `test.tsv`, and the category is spelled as in `intents.txt`.

```json
[
  { "name": "Jane Doe", "benchmark": "A", "average_time_per_example": 7.02,
    "predictions": [{ "id": 1, "intent": "card_arrival" }] },
  { "name": "Jane Doe", "benchmark": "B", "average_time_per_example": 7.51,
    "predictions": [{ "id": 1, "intent": "translate" }] }
]
```

Re-upload as often as you like. Ladders rank by accuracy, and the overall
standing is the average of your two accuracies. A skipped benchmark counts as 0.

The board scores you on part of the test set. The final ranking uses the part it
does not show you, so tuning against the leaderboard buys you nothing.

[Open the leaderboard](/)
