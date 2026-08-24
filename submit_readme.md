# Submitting to the leaderboard

You upload **predictions**, not scores. The site checks them against the answer
key and puts the accuracy on the ladder.

## The file

One JSON file, both benchmarks in it, uploaded once.

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
  },
  {
    "name": "Jane Doe",
    "benchmark": "B",
    "average_time_per_example": 7.51,
    "predictions": [{ "id": 1, "intent": "translate" }]
  }
]
```

| Field                      | Meaning                                               |
|----------------------------|-------------------------------------------------------|
| `name`                     | your name, as it should appear on the board           |
| `benchmark`                | `A` or `B`                                            |
| `average_time_per_example` | milliseconds per message, measured on a Colab T4      |
| `predictions`              | one `{id, intent}` for every row of that `test.tsv`   |

- 3,080 predictions for A, 4,500 for B. Every id, once.
- `intent` is spelled exactly as in `intents.txt`.
- Use the same name for both benchmarks so you appear once in the overall standing.

Template: [`predictions.json`](examples/predictions.json).

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
