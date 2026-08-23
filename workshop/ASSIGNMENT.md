# Efficient Intent Classification Challenge

## 1. The task

You are given two collections of short utterances written by real users of
customer-service assistants. None of the utterances are labeled. For each collection you
are also given the names of the intents that assistant supports.

For each benchmark, build a system that reads one utterance and outputs one intent name.

Two things about your systems are measured: how often they are right, and how long they
take. Both count towards your score. **You must submit to both benchmarks.**

|  | Benchmark A | Benchmark B |
|---|---|---|
| Intents | 77 | 150 |
| Structure | one service domain | ten service domains |
| Unlabeled pool | 10,003 utterances | 18,000 utterances |
| Label budget | 1,500 (about 19 per intent) | 3,000 (about 20 per intent) |

The two budgets differ only so that the labels per intent match. Everything else about
the two benchmarks is for you to find out.

## 2. What you are given

Per benchmark, in `benchmark_a/` and `benchmark_b/`:

| File | Contents |
|---|---|
| `pool.tsv` | The unlabeled utterances, one per line, each with an integer id. |
| `intents.txt` | The intent names, one per line. |
| `test_inputs.tsv` | The graded utterances, each with an integer id. No labels. |

Shared: `oracle.py` (annotation client) and `submit.py` (submission client), both of
which take a benchmark argument.

The gold labels for `test_inputs.tsv` are held by the instructors and are never
published. They are the only thing you are graded against.

## 3. Your annotation budget

You may buy gold labels for pool utterances: up to **1,500** on Benchmark A and up to
**3,000** on Benchmark B.

Send a list of pool ids to the oracle and it returns the gold label for each. You may
split this across as many rounds as you like, in any sizes you like, at any point during
the workshop. Spent budget is not refunded. The oracle logs every call.

**The two budgets are separate and cannot be transferred between benchmarks.**

Which utterances you buy is your decision. What you do with them, and what you do with
the ones you did not buy, is also your decision.

**One hard rule.** Gold labels for pool utterances come from the oracle and from
nowhere else. You may not look up, download, reconstruct, or otherwise obtain labels
for these utterances from any external source, and you may not attempt to identify or
locate the corpora they were drawn from. Every label your system trains on must be
traceable either to an oracle response or to something your own pipeline produced.

## 4. Rules at inference time

These govern the run that produces your submitted predictions, on either benchmark.

- Your system receives the test utterances **one at a time**, in the order given, and
  must emit a label for each one before it is shown the next. It never sees the test
  set as a whole.
- **No network access** during the run.
- **No lookup table, cache, or index keyed on the test texts**, and no precomputation
  over the test inputs before the clock starts.
- The labels you submit must be exactly the labels the timed run produced. No manual
  correction, no second pass, no model consulted outside the timed pipeline.

Everything before the timed run is unrestricted. Any amount of training, any hardware,
any external pretrained models, any compute budget, any wall-clock time.

## 5. How you are scored

Each benchmark is scored independently and then the two are averaged.

**Accuracy** `A` is top-1 accuracy on that benchmark's graded set. Macro-F1 is reported
alongside it as a diagnostic and is not scored.

**Latency** `L` is the mean wall-clock milliseconds per example of that benchmark's
timed run, measured as described in section 6.

For each benchmark,

```
S = 100 * A  -  log2( L / L_ref )
```

and your standing is

```
S_final = ( S_A + S_B ) / 2
```

`L_ref` is a fixed constant. It shifts every score by the same amount and therefore has
no effect on the ranking; ignore it. What the formula actually says is this:

> **Halving your average time per example is worth exactly as much as gaining one
> percentage point of accuracy.**

`L` is clipped from below at 0.01 ms/example. That is a numerical guard against
dividing by measurement noise, not a target.

A benchmark you do not submit to scores zero in the average.

## 6. Measuring your latency

Each benchmark is timed separately, on its own graded set.

All timed runs happen on `dai-03`. Book a slot; timed runs must not overlap with another
team's, and a run that shares the machine will be rejected.

1. Load and initialise everything. **Not timed.**
2. Warm up on at least 100 pool utterances from that benchmark. **Not timed.**
3. Start the clock, feed that benchmark's test inputs one at a time, stop the clock.
   `L = total elapsed / number of examples`.
4. Do this three times and report the **median**.

The timed region covers the entire path from raw string to emitted intent name:
normalisation, tokenisation, feature construction, every model call, any routing or
control logic, and the final decision. If it happens between receiving the string and
emitting the label, it is timed.

Report the load average of the machine at the start and end of each timed run.

Two further numbers must be reported per benchmark and are **not** scored, but a
submission without them is incomplete: p90 single-example latency, and offline
throughput (examples per second when you are free to process the graded set however you
like).

## 7. Submitting

A submission targets one benchmark and consists of three files.

- `predictions.tsv`: test id and predicted intent name, one per line.
- `timing.json`: your median `L`, the three individual run times, p90, offline
  throughput, and the load averages.
- `config.json`: which must declare
  - how many oracle labels you have used on this benchmark, and their ids;
  - every model, corpus, and pretrained checkpoint your system touches, each with a
    version or URL;
  - the provenance of every training label your system used;
  - the devices, thread count, numeric precision, and batching behaviour of the timed
    run;
  - a one-paragraph description of how the system works.

You may submit **5 times per day per benchmark**.

You may submit different systems to the two benchmarks. If you do, section 8 still
applies to both.

**The leaderboard is not the final ranking.** It scores you on a random 40% of each
graded set. Final standings use the other 60% and are revealed only at the end. A system
tuned against the leaderboard until it stops moving will do worse than one you had
reason to believe in.

## 8. Final deliverable

**Code.** Reproduces your submitted numbers on both benchmarks, starting from the pools
and your oracle labels. A README that states the commands, in order.

**Write-up**, at most 6 pages, covering:

- what you built for each benchmark, and why that rather than the alternatives;
- **at least two qualitatively different working systems per benchmark**, each with its
  measured accuracy and latency;
- **for every system you built, its score on both benchmarks**, including systems you
  did not submit and systems you built for the other benchmark. If a system is only
  reported on one benchmark, say why you could not run it on the other;
- one accuracy-versus-latency plot per benchmark, with every system you measured on it,
  including the ones you discarded;
- what you tried that did not work. A negative result you can explain is worth more here
  than a positive one you cannot.

Report honestly. A submission that says "we expected X, measured Y, and here is why we
think the difference is real" scores better than one that quietly omits Y.

## 9. Integrity

Your `config.json` is a declaration. Submitting one that misstates label provenance,
model inventory, or timing conditions is the one thing in this workshop that is not
recoverable.

We reproduce the top submissions on our own machine before the final ranking is
published. If your reported latency cannot be reproduced within a reasonable margin, the
reproduced number is the one that counts.
