# Ostr-AI 2026 — Final Project Leaderboard

A small, self-contained leaderboard for the Ostr-AI AI Summer School 2026
final project — **Fast & Accurate Text Classification** (two benchmarks, A and B).
Students upload a `.csv`/`.json` with one result per benchmark; the ladders update
live, rank by accuracy (ties to the faster system), and plot the trade-off.

<p align="center"><img src="static/logo.png" alt="Ostr-AI logo" width="160"></p>

## Features

- **Two ladders + overall standing** — one section per benchmark (sortable table
  + accuracy-vs-latency scatter with equal-score guide lines), plus an overall
  table of `S_final = (S_A + S_B) / 2`. Sticky section nav, per-benchmark colours.
- **Workshop scoring** — ladders rank by accuracy with latency as the tie-break;
  the overall standing is the mean of the two accuracies (missing counts 0).
- **Assignment on the site** — `/assignment` renders `workshop/ASSIGNMENT.md`
  (instructor notes are git-ignored and never served or deployed).
- **Upload / edit / delete** — a file holds one result per benchmark (one or two
  rows), parsed and validated **in the browser** with a preview that shows the
  computed S before submitting. The server re-validates defensively; replacing
  and deleting work per benchmark.
- **No accounts** — each browser gets a random owner token in `localStorage`; a
  token owns at most one row **per benchmark** (same name on both) and only its
  holder can replace or delete them. The database stores only a SHA-256 hash of
  the token.
- **NoSQL storage** — submissions are documents in [TinyDB](https://tinydb.readthedocs.io/)
  (`data/leaderboard.json`, written atomically). No database server needed.
- **Live updates** — the table refreshes itself every 10 s.
- No front-end framework or CDN dependency; colours taken from the Ostr-AI logo.

## Run it

```bash
pip install -r requirements.txt
python app.py                 # http://localhost:8000
```

Environment variables: `LEADERBOARD_HOST` (default `0.0.0.0`), `LEADERBOARD_PORT`
(default `8000`), `LEADERBOARD_DB` (default `data/leaderboard.json`),
`LEADERBOARD_ADMIN_KEY` (optional, see below).

To try it with a few fake rows: `python seed_demo.py` (server must be running;
their tokens go to `seed_tokens.txt` so you can delete them again).
For a public deployment put it behind a WSGI server, e.g.
`pip install waitress && waitress-serve --port 8000 app:app`.

## Deploy for free (PythonAnywhere)

The app needs a persistent disk for `data/leaderboard.json`, which rules out most
"free" PaaS tiers (Render, Koyeb, Fly, Vercel lose or lack local storage).
**PythonAnywhere's free tier** keeps files, serves HTTPS at
`https://<username>.pythonanywhere.com`, needs no credit card, and has an API —
so deployment is one script:

1. Create a free account: https://www.pythonanywhere.com/registration/register/beginner/
   (the username becomes the site address, e.g. `ostrai2026`).
2. Log in → **Account** → **API token** tab → *Create a new API token*.
3. Run, from any machine with Python 3.8+ (no packages needed):
   ```bash
   python deploy/deploy_pythonanywhere.py          # asks for username + token
   ```
   It uploads the project (TinyDB is vendored in `vendor/`, nothing to install),
   creates and configures the web app, writes the WSGI file, maps `/static/`,
   reloads, checks the site, and prints the URL plus an organiser admin key
   (saved to `deploy/.admin_key`, git-ignored). Re-run it any time to update the
   code — the database on the server is never touched.

Free-tier notes: the site runs on shared workers (the app uses a cross-process file
lock, so that is fine); it switches off after 3 months unless you click
*"Run until 3 months from today"* on the Web tab — PythonAnywhere emails a reminder.
`EU` accounts (eu.pythonanywhere.com) are detected automatically.

## Student guide

[`submit_readme.md`](submit_readme.md) — the required file format on one page.
It is also rendered at `/guide` on the running site. Templates:
[`examples/submission.csv`](examples/submission.csv),
[`examples/submission.json`](examples/submission.json).

## Configuration

| What                       | Where                                            |
|----------------------------|--------------------------------------------------|
| Benchmark names / subtitles | `static/app.js` → `BENCHMARKS`                  |
| Refresh interval           | `static/app.js` → `CONFIG.REFRESH_MS`            |
| Validation rules           | `app.py` → `validate_entry`, `static/app.js` → `validateEntry`, and the limits quoted in `submit_readme.md` (keep all three in sync) |
| Row cap (anti-abuse)       | `app.py` → `MAX_SUBMISSIONS` (default 500)       |
| Colours / fonts            | `static/style.css` → `:root` variables           |

## HTTP API

| Method   | Path                     | Purpose                                              |
|----------|--------------------------|------------------------------------------------------|
| `GET`    | `/api/submissions`       | all rows (with `benchmark` and `mine`)               |
| `GET`    | `/api/submissions/mine`  | the caller's rows (one per benchmark)                |
| `PUT`    | `/api/submissions/mine`  | upsert one entry or an array of two (all-or-nothing) |
| `DELETE` | `/api/submissions/mine`  | delete all the caller's rows                         |
| `DELETE` | `/api/submissions/mine/<A\|B>` | delete one benchmark's row                      |
| `DELETE` | `/api/submissions/<id>`  | organiser delete (header `X-Admin-Key`)              |

The caller is identified by the `X-Owner-Token` header (the browser sends it
automatically). A `name` (case-insensitive) can appear once **per benchmark**;
a second browser uploading the same name gets `409`. One token must use the same
name on both benchmarks (`422` otherwise).

**Organiser tip — removing a row whose owner lost their token:** start the server
with `LEADERBOARD_ADMIN_KEY=<secret> python app.py`, read the row's `id` from
`GET /api/submissions`, then
`curl -X DELETE -H "X-Admin-Key: <secret>" http://host:8000/api/submissions/<id>`.

## Layout

```
app.py              Flask server + REST API + TinyDB (atomic JSON storage)
static/             index.html, guide.html, style.css, app.js, logo.png, favicon.png
examples/           submission.csv, submission.json (templates)
submit_readme.md    one-page guide for students (rendered at /guide)
workshop/           ASSIGNMENT.md (rendered at /assignment); INSTRUCTOR_NOTES.md
                    is git-ignored and must never be committed, served or deployed
seed_demo.py        optional: insert a few fake rows for a demo
deploy/             deploy_pythonanywhere.py — one-shot free hosting (see above)
vendor/             vendored TinyDB (pure Python, MIT) for hosts without pip
Ostr-AI logo.png    original full-resolution logo
data/               created at runtime, holds leaderboard.json (git-ignored)
```
