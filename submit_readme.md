# Submitting your result to the leaderboard

Upload **one file** (`.csv` or `.json`) describing **one run** with the
**Upload submission** button on the leaderboard page. The file is checked in
your browser before anything is sent — if something is wrong you will see
exactly what to fix.

## Required fields

| Column         | Type                 | Meaning                                  |
|----------------|----------------------|------------------------------------------|
| `name`         | text, max 60 chars   | your first name                          |
| `surname`      | text, max 60 chars   | your last name                           |
| `metric`       | number               | your final score on the test set         |
| `train_time_s` | number, ≥ 0          | training wall-clock time in **seconds**  |
| `test_time_s`  | number, ≥ 0          | inference time on the test set, seconds  |

- All five columns are required, no other columns are allowed, and the file
  must contain exactly **one** data row.
- Numbers use a dot as the decimal separator (`0.93`, not `0,93`) and no
  thousands separators (`1250`, not `1,250`).
- Column names are case-insensitive; the names shown in the table
  (`Name`, `Surname`, `Metric`, `Train time (s)`, `Test time (s)`) are accepted too.

## CSV format

```csv
name,surname,metric,train_time_s,test_time_s
Jane,Doe,0.9312,184.5,2.37
```

## JSON format

```json
{
  "name": "Jane",
  "surname": "Doe",
  "metric": 0.9312,
  "train_time_s": 184.5,
  "test_time_s": 2.37
}
```

Templates you can copy: [`submission.csv`](examples/submission.csv) · [`submission.json`](examples/submission.json).

## Editing or deleting your entry

Your browser remembers your upload (no account needed). Open the leaderboard in
the **same browser** and use **Edit / re-upload** to replace your row or
**Delete** to remove it. If you switch browsers or clear site data, you cannot
edit the old row yourself — ask an organiser to remove it.

Each `name` + `surname` can appear only once on the leaderboard. If the upload is
refused with *"A submission for … already exists"*, it was either your own earlier
upload from another browser or a namesake — in both cases ask an organiser.

## Common mistakes

- Extra or misspelt columns (`score` instead of `metric`).
- More than one data row — submit only your final run.
- Times in minutes — convert to seconds.
- Decimal commas from Excel (`0,93`) — use a dot (`0.93`).
