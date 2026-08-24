# Submitting to the leaderboard

You upload **predictions**, not scores. The site checks them against the answer
key and puts the accuracy on the ladder.

## The file

One row per test message. The file carries everything: who you are, how fast
your system ran, and what you predicted.

| Field                      | Meaning                                               |
|----------------------------|-------------------------------------------------------|
| `name`                     | your name, as it should appear on the board           |
| `benchmark`                | `A` or `B`                                            |
| `average_time_per_example` | milliseconds per message, measured on a Colab T4      |
| `id`                       | the id from that benchmark's `test.tsv`               |
| `intent`                   | the category you predict, spelled as in `intents.txt` |

Rules:

- One row for **every** message in `test.tsv`: 3,080 rows for A, 4,500 for B.
- Both benchmarks can go in one file, or upload them separately.
- Each id appears once per benchmark.
- `name` and `average_time_per_example` are one value per benchmark, repeated on
  every row in CSV.

```csv
name,benchmark,average_time_per_example,id,intent
Jane Doe,A,7.02,1,card_arrival
Jane Doe,A,7.02,2,lost_card
Jane Doe,B,7.51,1,translate
```

In JSON the predictions nest, so the name and the speed are written once:

```json
[
  {
    "name": "Jane Doe",
    "benchmark": "A",
    "average_time_per_example": 7.02,
    "predictions": [
      { "id": 1, "intent": "card_arrival" },
      { "id": 2, "intent": "lost_card" }
    ]
  }
]
```

Templates: [`predictions.csv`](examples/predictions.csv) · [`predictions.json`](examples/predictions.json).

Press Submit and the site tells you your accuracy straight away.

## Editing and deleting

Your browser remembers your uploads, so you can re-upload as often as you like;
a new file replaces the benchmarks it contains. You can also delete either
benchmark.

That memory lives in the browser, not in an account, which has two consequences:

- **On a shared or lab machine**, the browser may still be holding someone
  else's upload. The site shows you whose result it has before you replace or
  delete anything. If the name is not yours, work in a private window instead.
- **Switching browsers or machines** starts a fresh identity, so the site will
  not let you edit your earlier row. Stick to one browser, or ask an organiser.

If the name you type is already on the board from another browser, the site says
so. If that is genuinely you, upload from the browser you used before. If you
just share a name with someone, add something that tells you apart.

## Common mistakes

- Missing rows. Predict every message in `test.tsv`, not a sample.
- Categories that are not in `intents.txt`, or reformatted (`Card Arrival`
  instead of `card_arrival`).
- Mixing up the ids: `id` comes from `test.tsv`, not from `pool.tsv`.
- Latency in seconds. Report milliseconds per message.
