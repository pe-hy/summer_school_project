# Handoff

Leaderboard for the Ostr-AI 2026 summer school final project. Live at
**https://pehy.pythonanywhere.com**. Written for whoever picks this up next,
and written to be **verified**: where a claim can be checked, the command to
check it is given.

## What it is

Students get two datasets of short customer-service messages (Benchmark A and
Benchmark B). Each message belongs to one category. The training pool ships
without labels: producing them is part of the project, and an LLM through
OpenRouter is the intended route. Students train a local model, predict every
message in both `test.tsv` files, and upload one JSON file. The server scores it
against an answer key they never see.

The student-facing text is `workshop/ASSIGNMENT.md`, rendered at `/assignment`,
and `submit_readme.md`, rendered at `/guide`. Read them first. They are the
contract, and the organiser has edited them by hand: **do not rewrite them
without being asked.**

## Run it

```bash
pip install -r requirements.txt
python app.py                 # http://localhost:8000
```

TinyDB is vendored in `vendor/`, so the app runs where pip cannot.

**There is no usable system Python on the LUMI login node** (it is 3.6 and
cannot reach numpy, torch or the project's packages). Everything goes through
the container:

```bash
CONT=/scratch/project_465002631/Petr/_LOCAL_CONTAINER/run.sh
$CONT python app.py
```

Never point a test server at the repository's `data/leaderboard.json`. Always
pass `LEADERBOARD_DB` to a scratch path.

## Deploy

```bash
bash update_site.sh
```

Uploads the project to PythonAnywhere and reloads the web app. Credentials are
in `deploy/.pa_token`, `deploy/.admin_key` and `deploy/.edit_password`, all
git-ignored. The upload list is `UPLOAD` in `deploy/deploy_pythonanywhere.py`;
it deliberately ships the two answer-key files and nothing else from
`workshop/data/_instructor/`.

**Deploy gotchas, all of which bit during the last session:**

- **PythonAnywhere throttles the API (HTTP 429).** It used to kill the deploy at
  the WSGI step, which silently skipped the reload and left new static files
  running against old server code. The deployer now retries, reading the delay
  from the API's own `"available in N seconds"` response, capped at 90 s.
- **The reload can outlast the socket timeout.** A `TimeoutError` used to crash
  the deploy with the same consequence. It now retries, then warns instead of
  crashing, because the call has usually succeeded anyway.
- **The deployer used to upload editor and tool temp files.** An interrupted
  `sed -i` once left a half-written copy of `app.js` in `static/`, and it was
  served publicly at HTTP 200. `SKIP_FILE` now excludes `sed??????`, `*.swp`,
  `*~`, `.DS_Store`, `*.orig`, `*.rej`, `*.tmp`, `*.bak`.
- **The deployer only ever uploads, never deletes.** A file removed from the
  repo lingers on the server forever. Remove it through the PythonAnywhere API.
- **`/static/` is mapped by PythonAnywhere directly to the directory.** Any file
  that exists there is served by the web server and Flask never sees it. That is
  why `app.py`'s guard against serving `static/*.html` cannot bite in
  production, and why the page templates carry `<link rel="canonical">` instead.
- **Deploying overwrites `/admin` edits.** `update_site.sh` uploads
  `workshop/ASSIGNMENT.md` and `submit_readme.md` from the repo. If the organiser
  edits them in the admin panel, copy the live version back into the repo before
  the next deploy, or the edit is lost. See "Open, not done".
- **Deploying signs organisers out of `/admin`**, because the session token
  format includes a server-side epoch. Log in again; the password is unchanged.

## Layout

| Path | What |
|---|---|
| `app.py` | Flask server: validation, scoring, storage, admin, static routes |
| `static/app.js` | The whole front end: parsing, ladders, plots, upload dialog, final-standings toggle |
| `static/index.html` | Page skeleton plus the ladder template cloned per benchmark |
| `static/404.html` | Styled 404 page |
| `static/md.js` | Markdown renderer for `/guide` and `/assignment` |
| `workshop/ASSIGNMENT.md` | The assignment, served at `/assignment` |
| `submit_readme.md` | Submission guide, served at `/guide` |
| `workshop/data/benchmark_a`, `benchmark_b` | What students download |
| `examples/predictions.json` | Submission template (shape only, not uploadable) |
| `scripts/final_standings.py` | Final ranking from the hidden slice, command line |
| `update_site.sh`, `deploy/` | Deployment |

## Instructor-only, git-ignored, never served

- `workshop/data/_instructor/` answer keys. `test_labels_*.tsv` are deployed so
  the server can score; nothing serves them. `pool_labels_*.tsv` are the pool's
  true labels, local only.
- `workshop/baseline/` the reference notebook and the Haiku labels in it.
- `workshop/INSTRUCTOR_NOTES.md`. It predates most decisions below and
  contradicts what shipped. History, not instructions.
- `workshop/data/README.md` and `scripts/build_data.py` name the corpora.
- `deploy/.admin_key`, `deploy/.pa_token`, `deploy/.edit_password`.

Keep it that way. The assignment asks students not to look up the original
labels, and **the repo is public**.

## The submission contract

`PUT /api/submissions/mine` takes a JSON array of **exactly two** objects, one
per benchmark, both carrying the same name:

```json
[{"name": "Jane Doe", "benchmark": "A", "average_time_per_example": 7.02,
  "predictions": [{"id": 1, "intent": "card_arrival"}]},
 {"name": "Jane Doe", "benchmark": "B", "average_time_per_example": 7.51,
  "predictions": [{"id": 1, "intent": "translate"}]}]
```

- **Both benchmarks are required.** A file with only one is rejected by the
  client and by the server. This changed during the last session; it used to be
  allowed and the missing one scored 0.
- **JSON only.** The CSV/TSV parser was deleted. Any other extension is refused.
- A: 3,080 test rows, ids 1..3080, 77 categories, 10,003 pool rows.
  B: 4,500 test rows, ids 1..4500, 150 categories, 18,000 pool rows.
- Accuracy is computed server-side and never taken from the client. Latency is
  self-reported and unverifiable by design.

The server refuses anything it cannot score and says why: missing rows, unknown
ids, categories not in `intents.txt`, duplicate ids, two names, one benchmark.

## Scoring: the 40/60 split

Each test set is split once, deterministically, by `PUBLIC_SHARE = 0.4` and
`SPLIT_SEED = 20260824` in `app.py`:

| | public | hidden | total |
|---|---|---|---|
| Benchmark A | 1,232 | 1,848 | 3,080 |
| Benchmark B | 1,800 | 2,700 | 4,500 |

`score_predictions()` compares the student's answer against the gold label for
**every** id, then stores two fractions:

```python
metric        = public_correct / len(public)     # shown on the board
metric_hidden = hidden_correct / len(hidden)     # never sent to any browser
```

The **full** (100 %) score is those two counts recombined by row weight:

```
full = (metric * n_public + metric_hidden * n_hidden) / n_total
```

This is exact, not an estimate: the multiplication recovers the integer counts
of correct answers. Verified repeatedly against a scorer that reads only the
answer key, matching to the last bit, including the load-bearing case of 100 %
public and 0 % hidden giving `accA = 0.4` rather than `0.5`, which proves the
weighting is real.

`metric_hidden` appears in **no** API response. `scripts/final_standings.py`
prints the hidden-slice ranking from the command line.

## The admin panel

**`/admin`**, password in `deploy/.edit_password` (git-ignored; the repo is
public, so it must never be hardcoded). The deployer injects it into the
server's WSGI file as `LEADERBOARD_EDIT_PASSWORD`. **If that variable is unset,
every `/admin` route returns 404** and the panel is indistinguishable from a URL
that does not exist. Not linked from anywhere on the site, `noindex`, `no-store`.

Three things live there:

1. **Edit the assignment and the guide.** Saves write atomically and keep one
   step of undo with a Restore button. A banner warns that deploying overwrites
   them.
2. **`/admin/scores`.** Every participant's public, hidden and full score per
   benchmark, plus `hidden avg` and `final`. **`final` is the mean of the two
   FULL scores and is exactly what Publish sends.** `hidden avg` is information
   only. These were the same word for two different numbers until it was fixed;
   do not reintroduce that.
3. **Publish / Unpublish / Republish.** See below.

Security shape, all of it verified adversarially:

- Session cookie is `expiry.epoch.HMAC`, HttpOnly, SameSite=Strict, scoped to
  `/admin`, Secure over HTTPS, 8 hours.
- The **session epoch** lives in the `admin_state` table. `/admin/logout` bumps
  it, which revokes every outstanding token across all worker processes. Without
  this, logging out only cleared the cookie and a captured token stayed valid
  for the full 8 hours.
- The **CSRF value is derived**, `HMAC(password, "csrf:" + session_token)`, so
  the session token never appears in rendered HTML. It used to be the session
  token itself, which made a screenshot of the page a working credential.
- Per-IP lockout after 8 failed logins, 5 minutes.

## Final standings: publish and revert

Two tables, deliberately separating the data from its visibility:

- **`final`** holds one frozen snapshot document: `{schema: 2, published_at,
  standings: [{rank, name, person_key, accA, accB, final}]}` where `accA`/`accB`
  are **full test-set** scores. **Never truncated.**
- **`final_state`** holds `{visible, changed_at}`.

| Action | Effect |
|---|---|
| Publish | Recompute, overwrite the snapshot, set visible |
| Unpublish | Set hidden. **The snapshot is kept.** |
| Show the saved standings again | Set visible, no recomputation |
| Republish (refresh) | Recompute from current submissions, then show |

`GET /api/final` serves the snapshot only when one exists **and** it is visible;
otherwise 404 with a body byte-identical to a server that never published, so
nobody can tell a withdrawal happened. While hidden, the snapshot is retained on
disk and reachable through no route at all: proven with a canary participant
swept across every route.

**The `schema` key matters.** Absence of a `final_state` row means the snapshot
was written by a version predating that table, so it stays visible: upgrading
must not make a published board vanish under the readers. But a snapshot that
*is* stamped `schema: 2` always writes a state row, so a stamped snapshot with
no state row means a half-restored backup and stays hidden. Absence,
explicit-false and tampering are three different things. This was a blocker
found in testing: the first version of the two-table design silently hid an
already-published board on upgrade.

Front end: with nothing published the page is byte-identical to before the
feature existed. Once published, the Overall standing shows the final standings
and grows a button toggling to the **Live board**, so the 40 % scores stay
reachable. Only the Overall table changes; the two ladders and the plots keep
showing live public scores. `/api/final` polling backs off to roughly once a
minute after three consecutive 404s, so unpublished pages do not spam the
console; publication is still noticed within about a minute without a reload.

## Student identity, and why it is not only localStorage

Identity is a random owner token sent as the `X-Owner-Token` header. It is what
lets a student replace or delete their own row. It was kept **only** in
`localStorage`, which has no expiry on Chrome, Firefox and Edge, but **Safari's
Intelligent Tracking Prevention deletes script-writable storage after 7 days of
Safari use without a visit to the site.** A student uploading from an iPhone on
day 1 and returning on day 10 lost the ability to edit their own submission.

A server-set cookie now mirrors it: **`ostrai_owner`**, `Max-Age` 60 days,
`Path=/`, `SameSite=Lax`, `Secure` behind an HTTPS proxy, **not** `HttpOnly` so
the client can read it. Server-set cookies are not subject to that 7-day cap.
Client resolution order: valid `localStorage` token wins, else adopt a valid
cookie token and write it back, else generate.

**The cookie is a backup copy, never a credential.** The server still treats the
`X-Owner-Token` header as the sole identity. Sending only the cookie is an
anonymous caller. Do not "simplify" this by accepting the cookie: a 60-day
non-HttpOnly cookie sent automatically on every request is a worse security
position than the header.

Subtlety worth keeping: `'é'.isalnum()` is True in Python, so a non-ASCII token
passed `is_valid_token()` and Werkzeug emitted a *quoted* cookie value, which
the browser then read back with quotes and rejected. The cookie path requires
`isascii()`; `is_valid_token()` itself is unchanged.

## Decisions already made, with reasons

Do not relitigate these without a reason. Each cost a round of discussion.

- **Server scores, students never see test labels.** Earlier versions shipped
  labelled test sets and accepted a typed accuracy, which anyone could fake.
- **Rank by accuracy only.** An earlier composite `S = 100·acc − log2(ms)` was
  cut. Latency is shown and plotted, never ranked. Ties at 2 dp share a rank;
  within a shared rank the faster system is listed first. The assignment says
  so, because the project is called "Fast and Accurate" and students reasonably
  assumed speed counted.
- **One JSON file per upload, both benchmarks, one name.** CSV, two files and
  dialog fields for name and speed are all gone. The CSV parser was deleted, not
  merely undocumented.
- **No local validation against LLM labels.** Holding out LLM-labelled data
  measures agreement with the labeller, not accuracy. The assignment says to
  hold out part of the pool and states plainly what that number does and does
  not mean.
- **No label budget.** Unenforceable once the oracle was cut, and label quality
  matters far more than label quantity.
- **Inference must run locally.** Otherwise calling an LLM per test message wins
  with no work.
- **Names are not tied to browsers.** A browser token owns at most one row per
  benchmark; a name is claimed by one browser; one browser may hold different
  names over time.
- **Ten gold-labelled pool examples ship** as `labeled_examples.tsv`, to show the
  label format. They stay in `pool.tsv` under the same ids, so the documented
  pool sizes and id ranges are unchanged. Ten rows train nothing; that is the
  point and the assignment says so.

## Reference numbers

Trained on Haiku labels for a sample of the pool, MiniLM embeddings plus
logistic regression. The live **Baseline** rows, which must never be deleted:

| id | benchmark | public | hidden | full | ms |
|---|---|---|---|---|---|
| `b9fcc1277c6c` | A | 67.37 % | 71.10 % | **69.61 %** | 6.99 |
| `b28e8a04f3dd` | B | 82.33 % | 83.74 % | **83.18 %** | 7.67 |

Final (mean of the full scores): **76.39 %**. `person_key` `baseline`,
`submitted_at` `2026-08-24T19:14:25+00:00`.

Note A's public score understates it by nearly four points, which is a good
illustration of why the split exists: 1,232 rows carry about ±1.3 points of
noise at that accuracy.

The same pipeline trained on correct labels reaches roughly 88.7 % and 92.4 %,
so label noise costs about 19 points on A and 9 on B. Haiku's labels were 65 %
correct on A and 86 % on B. **Do not publish these to students.**

## Testing

There is no test runner, and **there is no browser on this machine**. What
exists, and it is a lot:

The harnesses now live in the repository at **`tests/`**, which is git-ignored
(it contains a compiled wheel). They were previously in a session scratchpad
that no longer exists.

```bash
R=/scratch/project_465002631/Petr/summer_school_project
CONT=/scratch/project_465002631/Petr/_LOCAL_CONTAINER/run.sh

# 248-assertion navigation and regression suite. Expect: PASS 248  FAIL 0
$CONT bash -c "PYTHONPATH=$R/tests/pylibs python $R/tests/nav_harness/harness.py"

# focused front-end suites (parsing, ranking, plots, upload dialog, XSS,
# focus, races, the final-standings toggle, the owner cookie)
$CONT bash -c "PYTHONPATH=$R/tests/pylibs python $R/tests/fe/test_fixes.py"
```

- **QuickJS is a Python extension** in `tests/pylibs` (from `pip download
  quickjs`, unzipped; importable via `PYTHONPATH`). It runs the real
  `static/app.js` behind a DOM shim in `tests/fe/driver.py`, so front-end
  behaviour is *executed*, not reasoned about. This is the only way to test the
  front end here: there is no browser on this machine.
- **The two stale nav fixtures have been repaired** in `tests/nav_harness`. They
  used to upload single-benchmark files, which the app now rejects, and the
  suite crashed at `t_no_regression`. Both now send a Benchmark A and a
  Benchmark B entry, and the suite is 248 PASS / 0 FAIL.
- **`tests/fe/` still has stale fixtures.** `test_fixes.py` reports 6 failures
  (`3a`-`3d`, `4a`, `10`) from the same single-benchmark cause, and
  `test_upload.py`'s 422/409/507/500/413 scenarios are unreachable because the
  client rejects their fixture first. Those are fixture rot, not regressions.
  Repairing them the same way is the most useful tidying left.

Asserting that code looks right has repeatedly been wrong here. Anything
touching parsing, scoring, the upload flow, publishing or auth should be
executed against a real server.

## Verification status, end of the last session

Three independent adversarial agents tested the final state. All three now pass.
Each ran against its own server with `LEADERBOARD_DB` in a scratch path; none
touched the live site or the repository database.

| Lens | Verdict | Scale |
|---|---|---|
| Security and auth | SHIP after fixes below | 8,668 requests, 2 worker processes, 0 500s |
| Scoring correctness | SHIP | every published number bit-identical to an independent full-key count, delta 0.0 |
| Student journey | SHIP | whole workshop walked end to end against the real server and front end |

**Found and fixed in that round:**

- **`X-Forwarded-For` spoofing nullified the login lockout** (high). `_client_ip()`
  read the FIRST entry, which is client-supplied, so 30 wrong passwords with a
  different invented address each never tripped the limit, and a locked-out
  attacker could clear their own lockout at will. That is unlimited online
  guessing of the password controlling publication. It now reads the LAST entry,
  the only part a proxy vouches for.
- `/admin` could be framed, so its one-click Publish button was open to UI
  redress, which a CSRF token does not stop. `X-Frame-Options: DENY` and
  `frame-ancestors 'none'` added.
- `/admin/logout` acted for callers who failed the gate, so a cross-origin form
  POST could evict the organiser's session mid-workshop. It now returns the
  refusal.
- A `/static/` response could carry a student's `ostrai_owner` cookie together
  with `Cache-Control: public`. A shared cache would have handed one student's
  identity to the next visitor, who could then overwrite or delete their
  submission. The cookie is no longer attached under `/static/`.
- `deploy/.pa_token` was group-readable on shared scratch, which is enough for
  any project member to redeploy. Now `600`, like the other two secrets.
- `_full_metric` was 1 ulp off on about 1 % of count pairs, because `c/n*n` does
  not always round-trip. It never changed a printed figure or a rank, but it is
  now exact: the integer counts are recovered with `round()` before dividing.
  Re-checked across a wide grid of count pairs on both benchmarks: 0 mismatches.
- `/admin/scores` numbered rows 1..N while the published snapshot shares ranks
  on equal finals. Same data, two numberings. The admin table now shares ranks
  the same way; verified with a real tie showing rank 2, 2, then 4 in both.
- A row with `metric` but no `metric_hidden` would have published as `final 0.0`
  while still showing on the public board. Unreachable from any released schema,
  now caught by the startup migration anyway.

**Known and accepted, not fixed:**

- The login lockout counter is per worker process, so N workers allow N x 8
  attempts per window. Acceptable now the header-spoofing bypass is closed;
  move it into `admin_state` next to the epoch if you want it tight.
- Admin session tokens carry no per-session nonce, so two logins in the same
  second mint identical tokens. Sessions have no individual identity, so a
  leaked token can only be revoked by signing everyone out, which
  `/admin/logout` does. Adding `secrets.token_hex(8)` to the signed payload
  would fix it cheaply.
- Reporting latency in seconds instead of milliseconds is accepted silently.
  There is no lower bound because sub-millisecond timing is legitimate, and
  latency never changes a rank.
- Intents are `.strip()`ed before comparison, so trailing whitespace scores as
  correct. Lenient, not exploitable.

## Defects found and fixed in the last session

Kept because they document real failure modes, several of which were invisible
from reading the code.

**Server**
- Multi-worker data loss: TinyDB caches the next document id per process, so a
  worker that fell behind raised `ValueError: Document with ID N already exists`
  on every later insert. Measured 16 uploads → `{201: 11, 500: 9}`. `db_lock()`
  now resets the caches for every table.
- A two-entry upload was not atomic at write time: two storage writes, so a
  failure between them left A on the board and B missing. Now one
  `_update_table` call.
- A 4,301-digit id string passed `isdigit()` and 500'd on `int()`.
- The same bug class in `_edit_token_ok`: a crafted `edit_session` cookie
  returned 500 instead of 401 (unicode digits, 4,301 nines).
- An unreadable answer key killed the whole site at import time instead of
  degrading to "this benchmark cannot be scored".
- One token could hold two different names across two uploads.
- Duplicate ids were silently last-wins.
- Malformed JSON reported a shape error with 422 instead of 400.
- A SIGKILL mid-write left an orphan `.tmp` forever; swept at startup.
- 404s under `/static/` were cached for a day.

**Front end**
- Synonym keys silently changed the submitted score: `{"intent": x, "label": y}`
  submitted `y`, and which won depended on JSON key order. Same for `team` over
  `name` and `latency_ms` over the canonical time field.
- The Latency column never sorted: the header said `latency_ms`, rows carry
  `average_time_per_example`.
- The status bar went permanently stale after any upload or delete started from
  its own buttons, because the 10 s poll rebuilt the container holding focus.
- A complete two-benchmark file with one bad row was told to "add an entry for
  Benchmark B" it already had, and following that advice hid the real error.
- `md.js` rendered `javascript:` URLs in the standalone-link branch.

**Data and tooling**
- `scripts/build_data.py` wrote `test.tsv` **with the intent column**, and that
  directory is zipped verbatim into the student download. One re-run would have
  handed every student the answer key. It also never wrote the
  `test_labels_*.tsv` the server scores against.
- Four instructor scripts are stale: `baseline_reference.py` (`KeyError:
  'intent'`), `seed_demo.py` (every insert 422s, and it is deployed),
  `validate_notebook.py` (fails the correct notebook 23/24),
  `check_labels.py` (not idempotent; re-running changes 72 of 2,999 B labels).
  **These are still broken. Nobody fixed them.**

## Open, not done

- **Deploys overwrite `/admin` edits.** The repo wins. Either exclude those two
  files from `UPLOAD`, or keep syncing the live version back by hand. This has
  already had to be done twice.
- **The score-probing hole.** Submissions are unlimited and the accuracy comes
  back at full precision, so changing one prediction and watching whether the
  score moves by exactly 1/1232 reveals whether that id is in the public slice
  and whether the guess was right. Repeated, it recovers the public answer key.
  It cannot help the hidden ranking, so impact is limited, but rounding the
  reported accuracy to 0.1 % would close it.
- **Stale test fixtures**, above.
- **No starter code for students.** They build the labelling pipeline, the
  timing harness and the JSON writer from the guide alone.
- **No OpenRouter logistics**: no key, no credit, no model suggestion, no
  rate-limit guidance. First question on day one.
- **No administrivia**: no deadline, no team size, no organiser contact. The
  guide now promises the final ranking "will be shown eventually" and the board
  says "published in September", so somebody has to actually do that.
- **Public checkpoints exist for both corpora on HuggingFace.** A student who
  identifies the datasets can download a fine-tuned model and beat everyone. The
  rule forbids looking up labels, not weights.
- **Latency methodology** (tightened 2026-08-26): fixed batches of 64 with one
  untimed warmup batch, harness shown in the assignment. Still no
  `torch.cuda.synchronize()` requirement.
- **Nobody has clicked the final-standings toggle in a real browser.** Every
  code path is verified under QuickJS, but a human should press it once before
  September.

## Working notes

- `git push` fails from this shell; the user runs it. Many commits are unpushed.
- **Lustre fails intermittently** with `Cannot send after transport endpoint
  shutdown`, and reads can hang for minutes. Wrap every filesystem command in
  `timeout`. A `sed -i` interrupted this way once left a truncated file, which
  is how a temp file reached the public site. Editing a copy in `/tmp` and
  copying it in afterwards is the pattern that worked.
- Do not run `find`, `du` or recursive `ls` on the Lustre paths.
- The ROCm container recompiles per input shape, so single-message latency
  measured here is meaningless. Timing belongs on Colab.
- `pgrep -f <pattern>` matches the watcher's own command line. A wait loop built
  that way never exits, and a kill loop built that way kills your own shell.
  Use a bracket pattern, or filter out `bash -c`.
- The user wants plain writing: short sentences, no em-dashes, no filler, no
  status-report tone. Do the thing that was asked and stop.
- Sub-agents run on Opus or Sonnet, never the main model.
- Do not publish artifacts or hosted previews of this work.
