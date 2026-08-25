# Submitting to the leaderboard

You upload predictions. The site scores them against the answer key and puts
your accuracy on the ladder.

## The file you should submit

One JSON file holding both benchmarks.

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

| Field                      | Meaning                                                    |
|----------------------------|------------------------------------------------------------|
| `name`                     | your name, as it should appear on the board                |
| `benchmark`                | `A` or `B`                                                 |
| `average_time_per_example` | milliseconds per message, the number you measured          |
| `predictions`              | one `{id, intent}` for every row of that benchmark's `test.tsv` |

- `id` comes from that benchmark's `test.tsv`. Not from `pool.tsv`, and not from
  the row number in your dataframe. The ids run 1 to 3,080 for A and 1 to 4,500
  for B.
- Predict every id once.
- `intent` is copied exactly from `intents.txt`. `Card Arrival` is not
  `card_arrival`.
- A file carrying only one benchmark is rejected.
- Use the same name for both benchmarks. A file with two names is rejected.

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

Template: [`predictions.json`](/examples/predictions.json). It carries two
predictions per benchmark to show the shape, so you cannot upload it as it
stands. Yours needs every row of both test sets.

The site checks your ids and your category names. If something is wrong, it
tells you what. If it accepts the file, it shows your accuracy straight away.
That is your score on part of the test set. The final ranking uses the part you
are not shown (will be shown eventually...).

## Editing and deleting

Your browser remembers your uploads. A new file replaces both of your results,
and you can delete either benchmark on its own. Only this browser remembers
them, so if you switch browsers or clear its cookies and site data, ask an
organiser to remove your old result.

Each name belongs to one browser. If your upload is refused with *"A submission
under the name ... already exists"*, either you uploaded it from another browser
or someone else is using your name. Either way, ask an organiser.
