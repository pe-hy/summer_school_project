# Ostr-AI 2026 Final Project Leaderboard

A small, self-contained leaderboard for the Ostr-AI AI Summer School 2026 final
project, **Fast and Accurate Text Classification** (two benchmarks, A and B).
Students upload one JSON file holding both benchmarks; the ladders update live,
rank by accuracy, and plot accuracy against latency.

<p align="center"><img src="static/logo.png" alt="Ostr-AI logo" width="160"></p>

## Features

- **Two ladders plus an overall standing.** One section per benchmark (a sortable
  table and an accuracy-vs-latency scatter), plus an overall table of the average
  of the two accuracies. Sticky table headers, per-benchmark colours.
- **Workshop scoring.** The server holds the answer keys and computes the
  accuracy; the client never supplies it. Ladders rank by accuracy, equal
  accuracies share a rank (the faster system listed first), and the overall
  standing is the mean of the two accuracies (a missing benchmark counts 0).
- **Public and hidden split.** The board shows the score on a fixed 40 % slice of
  each test set (`PUBLIC_SHARE` in `app.py`). The score on the rest is stored as
  `metric_hidden`, is never served, and decides the final ranking
  (`scripts/final_standings.py`).
- **Assignment and guide on the site.** `/assignment` renders
  `workshop/ASSIGNMENT.md`, `/guide` renders `submit_readme.md`, and
  `/data/benchmarks.zip` serves the student data. Instructor material is
  git-ignored and is never served or deployed.
- **Upload, replace, delete.** One file holds both benchmarks (exactly two
  entries; a partial file is refused), parsed and validated **in the browser**,
  with a preview of what was read before you submit. The server re-validates defensively. Deleting works
  per benchmark; replacing always rewrites both.
- **No accounts.** Each browser gets a random owner token in `localStorage`. A
  token owns at most one row **per benchmark**, and only its holder can replace
  or delete those rows. The database stores only a SHA-256 hash of the token.
- **NoSQL storage.** Submissions are documents in [TinyDB](https://tinydb.readthedocs.io/)
  (`data/leaderboard.json`, written atomically). No database server needed.
- **Live updates.** The table refreshes itself every 10 s.
- No front-end framework and no CDN dependency; colours taken from the Ostr-AI logo.

## Run it

```bash
pip install -r requirements.txt
python app.py                 # http://localhost:8000
```

Environment variables: `LEADERBOARD_HOST` (default `0.0.0.0`), `LEADERBOARD_PORT`
(default `8000`), `LEADERBOARD_DB` (default `data/leaderboard.json`),
`LEADERBOARD_ADMIN_KEY` (optional, see below).

To try it with a few fake rows: `python seed_demo.py` (the server must be
running; the tokens go to `seed_tokens.txt` so you can delete the rows again).
For a public deployment put it behind a WSGI server, e.g.
`pip install waitress && waitress-serve --port 8000 app:app`.

## Deploy for free (PythonAnywhere)

The app needs a persistent disk for `data/leaderboard.json`, which rules out most
"free" PaaS tiers (Render, Koyeb, Fly and Vercel lose or lack local storage).
**PythonAnywhere's free tier** keeps files, serves HTTPS at
`https://<username>.pythonanywhere.com`, needs no credit card, and has an API, so
deployment is one script:

1. Create a free account: https://www.pythonanywhere.com/registration/register/beginner/
   (the username becomes the site address, e.g. `ostrai2026`).
2. Log in, go to **Account**, open the **API token** tab, then *Create a new API token*.
3. Run, from any machine with Python 3.8+ (no packages needed):
   ```bash
   python deploy/deploy_pythonanywhere.py          # asks for username + token
   ```
   It uploads the project (TinyDB is vendored in `vendor/`, nothing to install),
   creates and configures the web app, writes the WSGI file, maps `/static/`,
   reloads, checks the site, and prints the URL plus an organiser admin key
   (saved to `deploy/.admin_key`, git-ignored). Re-run it any time to update the
   code; the database on the server is never touched.

`bash update_site.sh` runs the same script with the site's username already set.

Free-tier notes: the site runs on shared workers (the app uses a cross-process file
lock, so that is fine); it switches off after 3 months unless you click
*"Run until 3 months from today"* on the Web tab, and PythonAnywhere emails a
reminder. EU accounts (eu.pythonanywhere.com) are detected automatically.

## Student guide

[`submit_readme.md`](submit_readme.md) is the required file format on one page.
It is also rendered at `/guide` on the running site. The template is
[`examples/predictions.json`](examples/predictions.json).

The assignment itself is [`workshop/ASSIGNMENT.md`](workshop/ASSIGNMENT.md),
rendered at `/assignment`.

## Configuration

| What                       | Where                                            |
|----------------------------|--------------------------------------------------|
| Benchmark names / subtitles | `static/app.js` → `BENCHMARKS`                  |
| Refresh interval           | `static/app.js` → `CONFIG.REFRESH_MS`            |
| Test set sizes             | `static/app.js` → `CONFIG.TEST_ROWS` (must match `test.tsv`) |
| Public / hidden split      | `app.py` → `PUBLIC_SHARE`, `SPLIT_SEED`          |
| Validation rules           | `app.py` → `validate_entry`, `static/app.js` → `parseSubmissionFile`, and the numbers quoted in `submit_readme.md` (keep all three in sync) |
| Row cap (anti-abuse)       | `app.py` → `MAX_SUBMISSIONS` (default 500)       |
| Colours / fonts            | `static/style.css` → `:root` variables           |

## HTTP API

| Method   | Path                     | Purpose                                              |
|----------|--------------------------|------------------------------------------------------|
| `GET`    | `/api/submissions`       | all rows (with `benchmark` and `mine`)               |
| `GET`    | `/api/submissions/mine`  | the caller's rows (one per benchmark)                |
| `PUT`    | `/api/submissions/mine`  | upsert an array of two, one per benchmark (all-or-nothing) |
| `DELETE` | `/api/submissions/mine`  | delete all the caller's rows                         |
| `DELETE` | `/api/submissions/mine/<A\|B>` | delete one benchmark's row                      |
| `DELETE` | `/api/submissions/<id>`  | organiser delete (header `X-Admin-Key`)              |

The other routes are pages and files: `/`, `/assignment`, `/guide`,
`/workshop/ASSIGNMENT.md`, `/submit_readme.md`, `/examples/<file>`,
`/data/benchmarks.zip` and `/static/<file>`.

The caller is identified by the `X-Owner-Token` header (the browser sends it
automatically). A `name` (case-insensitive) can appear once **per benchmark**;
a second browser uploading the same name gets `409`. Two entries in one upload
must carry the same name (`422` otherwise).

**Organiser tip, removing a row whose owner lost their token:** start the server
with `LEADERBOARD_ADMIN_KEY=<secret> python app.py`, read the row's `id` from
`GET /api/submissions`, then
`curl -X DELETE -H "X-Admin-Key: <secret>" http://host:8000/api/submissions/<id>`.

## Layout

```
app.py              Flask server + REST API + TinyDB (atomic JSON storage)
static/             index.html, guide.html, assignment.html, style.css, app.js,
                    md.js, logo.png, favicon.png
examples/           predictions.json (submission template)
submit_readme.md    one-page guide for students (rendered at /guide)
workshop/           ASSIGNMENT.md (rendered at /assignment); INSTRUCTOR_NOTES.md
                    is git-ignored and must never be committed, served or deployed
workshop/data/      benchmark_a/ and benchmark_b/ ship to students; _instructor/
                    holds the answer keys and is git-ignored
scripts/            organiser tools: build_data.py, final_standings.py and others
seed_demo.py        optional: insert a few fake rows for a demo
deploy/             deploy_pythonanywhere.py, one-shot free hosting (see above)
update_site.sh      redeploy this site with the saved settings
HANDOFF.md          what the next maintainer needs to know
vendor/             vendored TinyDB (pure Python, MIT) for hosts without pip
Ostr-AI logo.png    original full-resolution logo
data/               created at runtime, holds leaderboard.json (git-ignored)
```
