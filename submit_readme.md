# Submitting to the leaderboard

You upload predictions. The site scores them against the answer key and puts the
accuracy on the ladder.

## The file

One JSON file holding both benchmarks. Re-upload whenever you have something
better.

```json
[
  {
    "name": "Jane Doe",
    "benchmark": "A",
    "average_time_per_example": 7.02,
    "predictions": [
      { "id": 1, "intent": "card_arrival" },
      { "id": 2, "intent": "lost_or_stolen_card" }
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

| Field                      | Meaning                                              |
|----------------------------|------------------------------------------------------|
| `name`                     | your name, as it should appear on the board          |
| `benchmark`                | `A` or `B`                                           |
| `average_time_per_example` | milliseconds per message, the number you measured    |
| `predictions`              | one `{id, intent}` for every row of that `test.tsv`  |

- `id` is the `id` column of that benchmark's `test.tsv`. They run 1 to 3,080 for
  A and 1 to 4,500 for B, and both start at 1. Not the row number of your
  dataframe.
- One prediction per id, all of them. 3,080 for A, 4,500 for B.
- `intent` is copied exactly from `intents.txt`. `Card Arrival` is not
  `card_arrival`.
- Use the same name in both entries. A file with two names is rejected.

Building the file from a dataframe of predictions:

```python
import json

entries = []
for benchmark, test, predicted, ms in runs:      # your two runs
    entries.append({
        "name": "Jane Doe",
        "benchmark": benchmark,
        "average_time_per_example": float(ms),
        "predictions": [{"id": int(i), "intent": str(p)}
                        for i, p in zip(test["id"], predicted)],
    })

with open("predictions.json", "w") as f:
    json.dump(entries, f)
```

`int()` and `float()` matter: numpy types will not serialise.

Template: [`predictions.json`](examples/predictions.json).

The site checks your ids and your category names and tells you what is wrong. If
it accepts the file, it shows your accuracy immediately. That number is your
score on part of the test set; the final ranking uses the part you are not shown.

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
