# Final Project: Fast and Accurate Text Classification

## The task

You have two collections of short customer-service messages, Benchmark A and
Benchmark B. For each collection, build a system that reads a message and
decides which category it belongs to. The data files call the categories
"intents". For example, "I lost my card, what do I do?" belongs to the class
`lost_or_stolen_card`.

|  | Benchmark A | Benchmark B |
|---|---|---|
| Categories | 77 | 150 |
| Topic areas | one | ten |
| Training pool | 10,003 messages | 18,000 messages |
| Test set | 3,080 messages | 4,500 messages |

You should build two models. What works on Benchmark A may not carry over to Benchmark B.

## What you get

Per benchmark, in `benchmark_a/` and `benchmark_b/`:

| File | Contents |
|---|---|
| `pool.tsv` | training messages, one per line, without labels |
| `labeled_examples.tsv` | 10 pool messages per category with their real labels: 770 rows for A, 1,500 for B |
| `intents.txt` | the category names, one per line |
| `test.tsv` | the messages you are scored on, without labels |

[Download the data](/data/benchmarks.zip)

## Labels

The pool comes without labels, apart from a small seed set: `labeled_examples.tsv`
gives you 10 correctly labelled messages for every category, 770 rows for
Benchmark A and 1,500 for Benchmark B. Labelling the rest of the pool is part of
the project, and an LLM on OpenRouter is the practical route, and manual
supervision of label quality is necessary.

Those messages are also in `pool.tsv`, under the same ids. They show the label
format, and they are the one place where you can see what each category actually
covers.

Two rules:

1. Do not look up the original datasets' (or their labels) online.
2. `test.tsv` is only for measuring. Never train on it and never let your
   labelling pipeline see it.

Before you train, hold out part of your labelled pool. That is your validation
set.

What the score means depends on where those rows came from. Rows you labelled
yourself only say how well your model agrees with your own labels, not how often
it is right; that still catches a broken run and separates two systems that are
far apart. The rows in `labeled_examples.tsv` are correct, so a slice held out of
those is a real accuracy estimate, a small and therefore noisy one, and every row
you hold out is a row your labelling pipeline no longer gets to learn from. Run
that pipeline over the seed rows and compare what it produces against the labels
that ship with them, and you learn the other half: how good your own labels are.
Label quality is usually what needs the work.

## What counts

- **Accuracy**: the site scores it. You upload a category for every message in
  `test.tsv`, and the site checks your categories against an answer key you
  never see.
- **Average time per example**: you measure it. Load your model before you start
  the clock, classify the test messages in batches of a fixed size of 64, then
  divide the total time by the number of messages. Report the result in
  milliseconds. Measure on a Colab T4 so the numbers are comparable.

This is the measurement, exactly:

```python
import time

BATCH_SIZE = 64                       # fixed: everyone times with this batch size
texts = test["text"].tolist()         # the whole test set, in order

classify(texts[:BATCH_SIZE])          # warmup: one untimed batch, so one-off
                                      # startup costs stay off the clock

predictions = []
start = time.perf_counter()
for i in range(0, len(texts), BATCH_SIZE):
    predictions.extend(classify(texts[i:i + BATCH_SIZE]))
total_ms = (time.perf_counter() - start) * 1000.0

average_time_per_example = total_ms / len(texts)   # the number you report
```

`classify` is your whole system, end to end, taking a list of messages and
returning a category for each. The test sets do not divide evenly by 64, so the
last batch is smaller; dividing by `len(texts)` handles that. The result is
still average milliseconds per example, it is just measured in batches of 64
instead of one message at a time.

Your system must run locally when it classifies: no API calls, no network
access. Labelling the pool with an LLM is allowed, because it happens before
classification.

## The leaderboard

Upload one JSON file with your name, your average time per example, and a
category for every message in `test.tsv`. Both benchmarks go in one file, and a
file with only one of them is rejected. Take the `id` from `test.tsv` and spell
the category exactly as in `intents.txt`.

```json
[
  { "name": "Jane Doe", "benchmark": "A", "average_time_per_example": 7.02,
    "predictions": [{ "id": 1, "intent": "card_arrival" }] },
  { "name": "Jane Doe", "benchmark": "B", "average_time_per_example": 7.51,
    "predictions": [{ "id": 1, "intent": "translate" }] }
]
```

The [submission guide](/guide) lists every field and shows how to build the file.

Re-upload as often as you like. Each ladder ranks by accuracy. Your time per
example is shown beside it and plotted against it, but it does not change your
rank. The overall standing averages your two accuracies.

The board shows your score on part of the test set. The final ranking uses the
part it does not show you, so tuning against the board buys you nothing.

[Open the leaderboard](/)
