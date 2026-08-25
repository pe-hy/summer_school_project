# Handoff

Leaderboard for the Ostr-AI 2026 summer school final project. Live at
**https://pehy.pythonanywhere.com**. Written for whoever picks this up next.

## What it is

Students get two datasets of short customer-service messages (Benchmark A and
Benchmark B). Each message belongs to one category. The training pool ships
without labels: producing labels is the project, and an LLM through OpenRouter
is the intended route. Students then train a local model, predict every message
in `test.tsv`, and upload one JSON file. The server scores it against an answer
key they never see.

The student-facing text is `workshop/ASSIGNMENT.md`, rendered at `/assignment`.
Read it first; it is short and it is the contract.

## Run it

```bash
pip install -r requirements.txt
python app.py                 # http://localhost:8000
```

TinyDB is vendored in `vendor/`, so the app runs where pip cannot.

On this LUMI box there is no system python. Use the container:

```bash
/scratch/project_465002631/Petr/_LOCAL_CONTAINER/run.sh python app.py
```

## Deploy

```bash
bash update_site.sh
```

Uploads the project to PythonAnywhere and reloads the web app. Credentials sit
in `deploy/.pa_token` and `deploy/.admin_key`, both git-ignored. The upload list
is `UPLOAD` in `deploy/deploy_pythonanywhere.py`; it deliberately ships the two
answer-key files and nothing else from `workshop/data/_instructor/`.

Deploys take two to four minutes. `update_site.sh` prints a health check at the
end.

## Layout

| Path | What |
|---|---|
| `app.py` | Flask server: validation, scoring, storage, static routes |
| `static/app.js` | The whole front end: parsing, ladders, plots, upload dialog |
| `static/index.html` | Page skeleton plus the ladder template cloned per benchmark |
| `static/md.js` | Markdown renderer for `/guide` and `/assignment` |
| `workshop/ASSIGNMENT.md` | The assignment, served at `/assignment` |
| `submit_readme.md` | Submission guide, served at `/guide` |
| `workshop/data/benchmark_a`, `benchmark_b` | What students download |
| `examples/predictions.json` | Submission template |
| `scripts/final_standings.py` | Final ranking from the hidden slice |
| `update_site.sh`, `deploy/` | Deployment |

## Instructor-only, git-ignored, never served

- `workshop/data/_instructor/` answer keys. `test_labels_*.tsv` are deployed so
  the server can score; nothing serves them. `pool_labels_*.tsv` are the pool's
  true labels, local only.
- `workshop/baseline/` the reference notebook and the Haiku labels embedded in
  it. Verified 404 on the live site.
- `workshop/INSTRUCTOR_NOTES.md` predates most decisions below and contradicts
  what shipped. It is the only place the source corpora are named. Treat it as
  history, not as instructions.
- `workshop/data/README.md` and `scripts/build_data.py` name the corpora and
  link to the original labels, so they stay out of the public repo.
- `deploy/.admin_key`, `deploy/.pa_token`.

Keep it that way. The assignment asks students not to look up the original
labels, and the repo is public.

## How scoring works

`POST`-style `PUT /api/submissions/mine` takes a JSON array, one object per
benchmark: `name`, `benchmark`, `average_time_per_example`, and `predictions`, a
list of `{id, intent}` covering every row of that benchmark's `test.tsv`.

The server refuses anything it cannot score and says why: missing rows, ids that
are not in `test.tsv`, categories that are not in `intents.txt`, duplicate ids,
two names in one file. Accuracy is computed server-side and is never taken from
the client. Latency is self-reported and unverifiable by design.

**Public and hidden split.** Submissions are unlimited, so the board reports
accuracy on a fixed 40 % slice of each test set (`PUBLIC_SHARE` in `app.py`) and
silently stores the score on the remaining 60 % as `metric_hidden`, which never
appears in any API response. `scripts/final_standings.py` prints the real
ranking from the server's database. Tell students the board is partial; the
assignment already does.

## Decisions already made, with reasons

Do not relitigate these without a reason. Each cost a round of discussion.

- **Server scores, students never see test labels.** Earlier versions shipped
  labelled test sets and accepted a typed accuracy, which anyone could fake.
- **Rank by accuracy only.** An earlier composite score `S = 100·acc − log2(ms)`
  was cut. Latency is shown and plotted, not ranked.
- **One JSON file per upload**, both benchmarks inside, one name. Earlier
  variants used CSV, two files, or dialog fields for name and speed. All gone.
- **No local validation against LLM labels.** Holding out LLM-labelled data
  measures agreement with the labeller, not accuracy. On Benchmark A the model
  is already better than its labels, so maximising agreement makes it worse. The
  assignment says to hold out part of the pool and states plainly what the
  number does and does not mean.
- **No label budget.** It was unenforceable once the oracle was cut, and label
  quality matters far more than label quantity.
- **Inference must run locally.** Otherwise calling an LLM per test message wins
  on accuracy with no work.
- **Names are not tied to browsers.** A browser token owns at most one row per
  benchmark, and a name is claimed by one browser, but one browser may hold
  different names. An earlier one-name-per-browser rule blocked legitimate use.

## Reference numbers

Trained on Haiku labels for a sample of the pool, MiniLM embeddings plus
logistic regression: **67.4 %** on A and **82.3 %** on B on the public slice, at
about 7 ms per message on a Colab T4. The same pipeline trained on the same
messages with correct labels reaches roughly 88.7 % and 92.4 %, so label noise
costs about 19 points on A and 9 on B. Haiku's labels themselves were 65 %
correct on A and 86 % on B.

That gap is the point of the exercise. Do not publish these numbers to students.

## Testing

There is no test runner. What exists:

- A QuickJS harness that loads the real `static/app.js` and exercises the parser
  against fixture files. Pattern: extract the `STUBS` block from
  `/tmp/.../scratchpad/test_client.py` and eval it with `app.js`.
- End-to-end checks were done by parsing a file with the real front-end code and
  posting exactly what it produced to a local server, then to the live one.

Anything touching parsing, scoring or the upload flow should be checked this
way. Asserting that code looks right has repeatedly been wrong here.

## Open, not done

- **No starter code for students.** They must build the labelling pipeline, the
  timing harness and the JSON writer from the guide alone. Stripping the labels
  and the model out of the instructor notebook would give them a skeleton. This
  is the biggest remaining gap.
- **No OpenRouter logistics anywhere**: no key, no credit, no model suggestion,
  no rate-limit guidance. First question on day one.
- **No administrivia**: no deadline, no team size, no organiser contact.
- **Public checkpoints exist for both corpora on HuggingFace.** A student who
  identifies the datasets can download a fine-tuned model, run it locally, and
  beat everyone. The rule forbids looking up labels, not weights. Either name
  what is banned or rename the categories to paraphrases.
- **Overall standing groups by typed name**, not by the stable browser token.
  Two names means two half-rows, each averaging a missing benchmark as zero.
- **Latency methodology is loose**: no warmup, no `torch.cuda.synchronize()`, no
  batch-size rule, so two honest students can measure differently.

## Working notes

- `git push` fails from this shell; the user runs it. There are 18 unpushed
  commits as of this handoff.
- Do not run `find`, `du` or recursive `ls` on the Lustre paths.
- The ROCm container recompiles per input shape, so single-message latency
  measured here is meaningless. Timing belongs on Colab.
- The user wants plain writing: short sentences, no em-dashes, no filler, no
  status-report tone. Do the thing that was asked and stop.
- Sub-agents run on Opus or Sonnet, never the main model.
- Do not publish artifacts or hosted previews of this work.
