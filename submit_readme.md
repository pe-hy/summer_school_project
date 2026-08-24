# Submitting to the leaderboard

You upload **predictions**, not scores. The site checks them against the answer
key and puts the accuracy on the ladder.

## The file

One row per test message, in CSV or JSON, with three fields:

| Field       | Meaning                                              |
|-------------|------------------------------------------------------|
| `benchmark` | `A` or `B`                                           |
| `id`        | the id from that benchmark's `test.tsv`              |
| `intent`    | the category you predict, spelled as in `intents.txt` |

Rules:

- One row for **every** message in `test.tsv`: 3,080 rows for A, 4,500 for B.
- Both benchmarks can go in one file, or upload them separately.
- Each id appears once per benchmark.

```csv
benchmark,id,intent
A,1,card_arrival
A,2,lost_card
B,1,translate
```

JSON is the same thing as a list of objects:

```json
[
  { "benchmark": "A", "id": 1, "intent": "card_arrival" },
  { "benchmark": "B", "id": 1, "intent": "translate" }
]
```

Templates: [`predictions.csv`](examples/predictions.csv) · [`predictions.json`](examples/predictions.json).

## When you upload

The dialog asks for two things the file does not carry:

- **Your name**, as it should appear on the board.
- **Milliseconds per message**, the speed you measured on a Colab T4.

Press Submit and the site tells you your accuracy straight away.

## Editing and deleting

Your browser remembers your uploads, so you can re-upload as often as you like;
a new file replaces the benchmarks it contains. You can also delete either
benchmark. Switching browsers loses that link, so ask an organiser.

Each name appears once per benchmark. If your upload is refused with
*"a submission under this name already exists"*, it was either you from another
browser or a namesake. Either way, ask an organiser.

## Common mistakes

- Missing rows. Predict every message in `test.tsv`, not a sample.
- Categories that are not in `intents.txt`, or reformatted (`Card Arrival`
  instead of `card_arrival`).
- Mixing up the ids: `id` comes from `test.tsv`, not from `pool.tsv`.
- Latency in seconds. Report milliseconds per message.
