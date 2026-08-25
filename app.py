"""
Ostr-AI Summer School 2026: Final Project Leaderboard
-----------------------------------------------------
Small Flask server that serves the static front-end and a tiny JSON REST API
backed by TinyDB (a NoSQL document store persisted to data/leaderboard.json).
Accuracy is computed here from the instructor-only answer keys; the client
never supplies it.

Run:  python app.py            (defaults: host 0.0.0.0, port 8000)
Env:  LEADERBOARD_HOST, LEADERBOARD_PORT, LEADERBOARD_DB (path to the db file),
      LEADERBOARD_ADMIN_KEY (optional; enables organiser delete-by-id)

There is no login by design. Each browser generates a random "owner token"
(kept in localStorage) and sends it with every write request. A token owns at
most one submission per benchmark, and only the holder of the token can replace
or delete those. Only a SHA-256 hash of the token is stored in the database.
"""

from __future__ import annotations

import contextlib
import hashlib
import html as html_mod
import io
import hmac
import json
import os
import random
import shutil
import stat
import sys
import tempfile
import threading
import time
import unicodedata
import zipfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import (Flask, abort, g, has_app_context, jsonify, redirect, request,
                   send_file, send_from_directory)
from werkzeug.exceptions import BadRequest, HTTPException, InternalServerError

BASE_DIR = Path(__file__).resolve().parent
try:
    from tinydb import Query, TinyDB
    from tinydb.storages import Storage
except ImportError:  # hosts without pip (e.g. PythonAnywhere free tier): use the vendored copy
    sys.path.insert(0, str(BASE_DIR / "vendor"))
    from tinydb import Query, TinyDB
    from tinydb.storages import Storage

STATIC_DIR = BASE_DIR / "static"
DB_PATH = Path(os.environ.get("LEADERBOARD_DB") or BASE_DIR / "data" / "leaderboard.json")
ADMIN_KEY = os.environ.get("LEADERBOARD_ADMIN_KEY") or None
# Password for the /admin text editor. Never hardcode it: this repo is public.
# The deployer writes it into the WSGI file from deploy/.edit_password.
# Unset means the editor does not exist at all (every /admin route 404s).
EDIT_PASSWORD = os.environ.get("LEADERBOARD_EDIT_PASSWORD") or None
EDIT_SESSION_HOURS = 8
EDIT_MAX_BYTES = 256 * 1024
EDIT_MAX_TRIES = 8            # per IP, before a cool-off
EDIT_COOLOFF_S = 300

# ----------------------------------------------------------------------------
# Submission schema (keep in sync with static/app.js and submit_readme.md)
# ----------------------------------------------------------------------------
STRING_FIELDS = ("name",)
BENCHMARKS = ("A", "B")
TIME_FIELD = "average_time_per_example"
TIME_ALIASES = (TIME_FIELD, "latency_ms")     # the old name still parses
FIELDS = STRING_FIELDS + ("benchmark", "predictions") + TIME_ALIASES
MAX_TIME_MS = 1e7              # 10,000 s per message is beyond any real run
MAX_NAME_LEN = 80
MAX_ABS_NUMBER = 1e15          # anything bigger is certainly a mistake
MAX_SUBMISSIONS = 500          # hard cap on rows (the API is unauthenticated)
TOKEN_MIN_LEN, TOKEN_MAX_LEN = 16, 64
INVALID_CATEGORIES = {"Cc", "Cf", "Cs", "Co", "Cn"}   # Unicode general categories rejected in names


def is_valid_token(token: str) -> bool:
    return TOKEN_MIN_LEN <= len(token) <= TOKEN_MAX_LEN and all(c.isalnum() or c == "-" for c in token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------------------
# Storage: TinyDB with atomic writes (temp file + os.replace) so a crash
# mid-write can never leave a half-written, unparseable leaderboard.json
# ----------------------------------------------------------------------------
class AtomicJSONStorage(Storage):
    def __init__(self, path: Path, **json_kwargs):
        self.path = Path(path)
        self.json_kwargs = json_kwargs
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read(self):
        if not self.path.exists() or self.path.stat().st_size == 0:
            return None
        with open(self.path, encoding="utf-8") as fh:
            try:
                data = json.load(fh)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"{self.path} is not valid JSON ({e}). Fix or move the file and restart.") from e
        if not isinstance(data, dict):
            raise RuntimeError(f"{self.path} must contain a JSON object (TinyDB layout), found {type(data).__name__}.")
        return data

    def write(self, data):
        # unique temp name: concurrent workers can never interleave inside one file
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, **self.json_kwargs)
                fh.flush()
                os.fsync(fh.fileno())
            if self.path.exists():  # keep whatever permissions the organiser set on the db file
                os.chmod(tmp, stat.S_IMODE(self.path.stat().st_mode))
            os.replace(tmp, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
        try:  # make the rename itself durable
            dir_fd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass

    def close(self):
        pass


app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # predictions for both test sets, with room to spare
app.json.sort_keys = False
app.json.ensure_ascii = False

db = TinyDB(DB_PATH, storage=AtomicJSONStorage, indent=2, ensure_ascii=False)
submissions = db.table("submissions")
# The final standings live in two documents that change independently: the
# frozen snapshot itself (written by _final_publish, never computed on the fly)
# and whether it is currently public. Hiding the standings only flips the flag,
# so the saved snapshot survives untouched and can be shown again as it was.
final_table = db.table("final")
final_state = db.table("final_state")
# One integer, bumped on sign-out: every editor token carries the epoch it was
# minted under, so bumping it revokes them all at once, in every worker.
admin_state = db.table("admin_state")
try:
    db.storage.read()  # fail fast, with a readable message, if the db file is unusable
except RuntimeError as e:
    sys.exit(f"ERROR: {e}")
Submission = Query()


def _migrate_legacy_rows() -> None:
    """Startup schema upkeep. Rows from an older schema are REMOVED (their values
    cannot be converted), with a stderr note, but only after the pre-migration
    file has been copied to a .bak next to it, so nothing is lost irreversibly."""
    legacy = [doc for doc in submissions.all()
              if any(k in doc for k in ("surname", "train_time_s", "test_time_s", "avg_time_s"))
              or TIME_FIELD not in doc or "metric_hidden" not in doc
              or doc.get("benchmark") not in BENCHMARKS]
    if legacy and DB_PATH.exists():
        with contextlib.suppress(OSError):
            shutil.copy2(DB_PATH, DB_PATH.with_name(DB_PATH.name + ".pre-migration.bak"))
    for doc in submissions.all():
        if (any(k in doc for k in ("surname", "train_time_s", "test_time_s", "avg_time_s"))
                or TIME_FIELD not in doc or "metric_hidden" not in doc
                or doc.get("benchmark") not in BENCHMARKS):
            print(f"NOTE: removing legacy submission {doc.get('name', '?')!r}: the schema changed "
                  "(two benchmarks, latency in ms); ask the owner to re-upload.", file=sys.stderr)
            submissions.remove(doc_ids=[doc.doc_id])
            continue
        person = unicodedata.normalize("NFKC", doc.get("name", "")).casefold()
        if doc.get("person_key") != person:
            submissions.update({"person_key": person}, doc_ids=[doc.doc_id])


_thread_lock = threading.Lock()   # TinyDB is not thread-safe; Flask's dev server is threaded
_lock_depth = threading.local()   # so a nested `with db_lock()` cannot deadlock
_LOCK_PATH = DB_PATH.with_name(DB_PATH.name + ".lock")


@contextlib.contextmanager
def db_lock():
    """Serialise read-modify-write cycles across threads AND worker processes
    (production servers such as PythonAnywhere/gunicorn run several workers).
    Re-entrant: entering it again on the same thread is a no-op, so a helper
    that needs the lock stays safe to call from inside another locked block."""
    if getattr(_lock_depth, "held", False):
        yield
        return
    _lock_depth.held = True
    try:
        yield from _db_lock_held()
    finally:
        _lock_depth.held = False


def _db_lock_held():
    with _thread_lock:
        with open(_LOCK_PATH, "a+") as lock_fh:
            locked = False
            try:
                import fcntl
                fcntl.flock(lock_fh, fcntl.LOCK_EX)
                locked = True
            except (ImportError, OSError):   # Windows / exotic filesystems: thread lock only
                pass
            try:
                # TinyDB caches the next document id and its query results per
                # process. Production runs several workers against one file, so
                # a cache filled before another worker wrote is already wrong:
                # inserts would collide on a used id and reads would be stale.
                # The lock is held now, so drop both and re-read from disk.
                submissions.clear_cache()
                submissions._next_id = None
                final_table.clear_cache()
                final_table._next_id = None
                final_state.clear_cache()
                final_state._next_id = None
                admin_state.clear_cache()
                admin_state._next_id = None
                yield
            finally:
                if locked:
                    fcntl.flock(lock_fh, fcntl.LOCK_UN)


def _sweep_orphan_tmp() -> None:
    """A SIGKILL mid-write leaves a full-size .tmp beside the db: the cleanup in
    AtomicJSONStorage.write cannot run. A crash loop would fill the directory."""
    for stale in DB_PATH.parent.glob(DB_PATH.name + ".*.tmp"):
        with contextlib.suppress(OSError):
            stale.unlink()


with db_lock():
    _sweep_orphan_tmp()
    _migrate_legacy_rows()


# ----------------------------------------------------------------------------
# Answer keys (instructor-only files; never served, only used to score)
# ----------------------------------------------------------------------------
PUBLIC_SHARE = 0.4        # the slice the board scores against; the rest decides the final ranking
SPLIT_SEED = 20260824


def _load_answer_keys() -> dict[str, dict[int, str]]:
    keys: dict[str, dict[int, str]] = {}
    for bench in BENCHMARKS:
        path = BASE_DIR / "workshop" / "data" / "_instructor" / f"test_labels_{bench.lower()}.tsv"
        gold: dict[int, str] = {}
        # An unreadable key must degrade to "this benchmark cannot be scored",
        # never take the whole site down at import time.
        try:
            with open(path, encoding="utf-8") as fh:
                next(fh, None)                       # header
                for line in fh:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) == 2 and parts[0].isdigit():
                        gold[int(parts[0])] = parts[1]
        except OSError as e:
            gold = {}
            print(f"WARNING: cannot read the answer key at {path} ({e.strerror}).", file=sys.stderr)
        keys[bench] = gold
        print(f"answer key {bench}: {len(gold):,} test labels" if gold
              else f"WARNING: no answer key for benchmark {bench} at {path}: submissions will be refused",
              file=sys.stderr)
    return keys


def _public_split(keys: dict[str, dict[int, str]]) -> dict[str, set[int]]:
    """A fixed random slice of each test set. The board shows the score on this
    slice only, so tuning against the leaderboard does not transfer to the final
    ranking, which uses the remaining rows."""
    split: dict[str, set[int]] = {}
    for bench, gold in keys.items():
        ids = sorted(gold)
        random.Random(f"{SPLIT_SEED}-{bench}").shuffle(ids)
        split[bench] = set(ids[:max(1, round(len(ids) * PUBLIC_SHARE))])
    return split


def _load_intents() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for bench in BENCHMARKS:
        path = BASE_DIR / "workshop" / "data" / f"benchmark_{bench.lower()}" / "intents.txt"
        try:    # unreadable intents.txt: accept any category rather than refuse to start
            out[bench] = set(path.read_text(encoding="utf-8").split())
        except OSError as e:
            out[bench] = set()
            print(f"WARNING: cannot read {path} ({e.strerror}); category names will not be checked.", file=sys.stderr)
    return out


ANSWER_KEYS = _load_answer_keys()
PUBLIC_IDS = _public_split(ANSWER_KEYS)
INTENTS = _load_intents()


def score_predictions(bench: str, predictions: object) -> tuple[dict | None, list[str]]:
    """Return (scores, errors). scores has the public 'metric' shown on the board
    and 'metric_hidden' for the final ranking. predictions: [{"id", "intent"}, ...]"""
    gold = ANSWER_KEYS.get(bench) or {}
    if not gold:
        return None, [f"Benchmark {bench} cannot be scored right now. Tell an organiser."]
    if not isinstance(predictions, list):
        return None, [f"Benchmark {bench}: 'predictions' must be a list of {{id, intent}} objects."]
    if len(predictions) > 2 * len(gold) + 10:
        return None, [f"Benchmark {bench}: far too many rows ({len(predictions)}); expected {len(gold):,}."]

    seen: dict[int, str] = {}
    bad_rows = 0
    unknown_ids: list[int] = []
    dup_ids: list[int] = []
    for item in predictions:
        if not isinstance(item, dict):
            bad_rows += 1
            continue
        raw_id, intent = item.get("id"), item.get("intent")
        # Cap the digits before converting: CPython refuses to parse an integer
        # string longer than 4300 digits, and that ValueError would be a 500.
        if isinstance(raw_id, str) and raw_id.strip().isdigit() and len(raw_id.strip()) <= 12:
            raw_id = int(raw_id.strip())
        if isinstance(raw_id, bool) or not isinstance(raw_id, int) or not isinstance(intent, str):
            bad_rows += 1
            continue
        if raw_id not in gold:
            unknown_ids.append(raw_id)
            continue
        if raw_id in seen:
            dup_ids.append(raw_id)
            continue
        seen[raw_id] = intent.strip()

    errors = []
    allowed = INTENTS.get(bench) or set()
    if allowed:
        unknown = sorted({i for i in seen.values() if i not in allowed})
        if unknown:
            errors.append(f"Benchmark {bench}: {len(unknown)} category name(s) are not in intents.txt, "
                          f"for example {unknown[:3]}. Copy the names exactly as they appear there.")
    if bad_rows:
        errors.append(f"Benchmark {bench}: {bad_rows} row(s) are not a valid id/intent pair.")
    if unknown_ids:
        errors.append(f"Benchmark {bench}: {len(unknown_ids)} id(s) are not in test.tsv, "
                      f"for example {sorted(unknown_ids)[:3]}.")
    if dup_ids:
        errors.append(f"Benchmark {bench}: {len(dup_ids)} id(s) appear more than once, "
                      f"for example {sorted(set(dup_ids))[:3]}. Predict each test message once.")
    missing = len(gold) - len(seen)
    if missing > 0:
        absent = sorted(set(gold) - set(seen))[:3]
        errors.append(f"Benchmark {bench}: {missing:,} of {len(gold):,} test messages have no prediction, "
                      f"for example ids {absent}. Predict every row of test.tsv.")
    if errors:
        return None, errors
    public = PUBLIC_IDS.get(bench) or set(gold)
    hidden = [i for i in gold if i not in public]
    public_correct = sum(1 for i in public if seen.get(i) == gold[i])
    hidden_correct = sum(1 for i in hidden if seen.get(i) == gold[i])
    return {
        "metric": public_correct / len(public),
        "metric_hidden": (hidden_correct / len(hidden)) if hidden else None,
    }, []


# ----------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------
def validate_entry(data: object) -> tuple[dict | None, list[str]]:
    """One benchmark's submission: name, benchmark, average_time_per_example and predictions.
    The accuracy is computed here from the answer key, never taken from the client."""
    errors: list[str] = []
    if not isinstance(data, dict):
        return None, ["Each result must be an object with name, benchmark, "
                      "average_time_per_example and predictions."]

    unknown = sorted(str(k).encode("utf-8", "replace").decode("utf-8")[:40] for k in set(data) - set(FIELDS))
    if unknown:
        errors.append("Unexpected field(s): " + ", ".join(unknown))

    clean: dict = {}
    if "name" not in data:
        errors.append("Missing field 'name'.")
    else:
        value = data["name"]
        if not isinstance(value, str) or not value.strip():
            errors.append("'name' must be a non-empty text value.")
        else:
            value = unicodedata.normalize("NFC", " ".join(value.split()))
            if len(value) > MAX_NAME_LEN:
                errors.append(f"'name' must be at most {MAX_NAME_LEN} characters.")
            elif any(unicodedata.category(c) in INVALID_CATEGORIES for c in value):
                errors.append("'name' contains invisible or control characters.")
            else:
                clean["name"] = value

    bench = None
    if "benchmark" not in data:
        errors.append("Missing field 'benchmark'.")
    else:
        bench = normalize_benchmark(data["benchmark"])
        if bench is None:
            errors.append('\'benchmark\' must be "A" or "B".')
        else:
            clean["benchmark"] = bench

    given = next((k for k in TIME_ALIASES if k in data), None)
    if given is None:
        errors.append(f"Missing field '{TIME_FIELD}'.")
    else:
        value = data[given]
        if isinstance(value, str):
            try:
                value = float(value.strip().replace(",", "."))
            except ValueError:
                value = None
        try:
            number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
        except OverflowError:
            number = None
        if number is None or number != number or not 0 <= number <= MAX_TIME_MS:
            errors.append(f"'{TIME_FIELD}' must be a number of milliseconds per message, 0 or more.")
        else:
            clean[TIME_FIELD] = number

    if "predictions" not in data:
        errors.append("Missing field 'predictions'.")
    elif bench is not None and not errors:
        scores, score_errors = score_predictions(bench, data["predictions"])
        if score_errors:
            errors.extend(score_errors)
        else:
            clean.update(scores)

    return (clean, []) if not errors else (None, errors)


def normalize_benchmark(value: object) -> str | None:
    """'A', 'a', 'benchmark_a', 'Benchmark A', 'project B', ... -> 'A'/'B'; None if unknown."""
    if not isinstance(value, str):
        return None
    key = "".join(c for c in value.casefold() if c.isalnum())
    for b in BENCHMARKS:
        low = b.casefold()
        if key in (low, f"benchmark{low}", f"bench{low}", f"project{low}"):
            return b
    return None


def validate_submission(data: object) -> tuple[list[dict] | None, list[str]]:
    """An array with one result per benchmark, both carrying the same name.
    A submission is always both benchmarks: a partial file is refused."""
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        return None, ["A submission is one JSON array holding two objects: "
                      "one for Benchmark A and one for Benchmark B."]
    if len(data) != len(BENCHMARKS):
        if len(data) > len(BENCHMARKS) and not any(
                isinstance(d, dict) and "predictions" in d for d in data):
            # one object per prediction at the top level, not one per benchmark
            return None, ["Each benchmark needs one object holding a 'predictions' list. "
                          "This file looks like one object per prediction instead."]
        return None, [f"A submission is one file with one result per benchmark: "
                      f"{len(BENCHMARKS)} entries, found {len(data)}."]
    errors: list[str] = []
    entries: list[dict] = []
    for i, item in enumerate(data):
        label = f"entry {i + 1}: " if len(data) > 1 else ""
        clean, errs = validate_entry(item)
        errors.extend(label + e for e in errs)
        if clean:
            entries.append(clean)
    if not errors:
        benches = [e["benchmark"] for e in entries]
        if len(set(benches)) != len(benches):
            errors.append("Both results are for the same benchmark. One must be A and one B.")
        if len({person_key(e) for e in entries}) > 1:
            errors.append("Both results must carry the same name.")
    return (entries, []) if not errors else (None, errors)


def person_key(entry: dict) -> str:
    """Case-insensitive identity used to stop the same person appearing twice."""
    return unicodedata.normalize("NFKC", entry["name"]).casefold()


def public_row(doc: dict, owner_hash: str | None) -> dict:
    """Public view of a document (never exposes the owner hash)."""
    return {
        "id": doc.get("id"),
        "name": doc.get("name", ""),
        "benchmark": doc.get("benchmark"),
        "metric": doc.get("metric"),   # public slice only; metric_hidden is never served
        TIME_FIELD: doc.get(TIME_FIELD),
        "person_key": doc.get("person_key"),
        "submitted_at": doc.get("submitted_at", ""),
        "mine": bool(owner_hash) and doc.get("owner_hash") == owner_hash,
    }


# ----------------------------------------------------------------------------
# Final standings
# ----------------------------------------------------------------------------
# The ranking that decides the project is the mean of a person's two accuracies
# over the WHOLE test set. Organisers publish it once, at the end: publishing
# takes a frozen snapshot and stores it, so a later upload cannot change a
# result that has already been announced. Only republishing takes a fresh one.
# ----------------------------------------------------------------------------
def _final_standings() -> list[dict]:
    """Snapshot rows: one per person, ranked by the mean of their whole-test-set
    accuracies (_full_metric, defined with the scores page below) with a missing
    benchmark counting as 0. The hidden slice itself is never stored here.
    The caller must hold db_lock()."""
    people: dict[str, dict] = {}
    for row in submissions.all():
        bench = row.get("benchmark")
        if bench not in BENCHMARKS:
            continue
        key = row.get("person_key") or unicodedata.normalize("NFKC", row.get("name", "")).casefold()
        person = people.setdefault(key, {"name": row.get("name", "?"), "acc": {}})
        person["name"] = row.get("name", person["name"])
        person["acc"][bench] = _full_metric(row, bench)

    entries = []
    for key, person in people.items():
        accs = {f"acc{b}": person["acc"].get(b) for b in BENCHMARKS}
        entries.append({"name": person["name"], "person_key": key, "accs": accs,
                        "final": sum(v or 0.0 for v in accs.values()) / len(BENCHMARKS)})
    entries.sort(key=lambda e: (-e["final"], e["name"].casefold()))

    standings: list[dict] = []
    last_rank, last_key = 0, None
    for position, e in enumerate(entries, 1):
        # Same tie rule as the board (computeRanks in static/app.js): scores that
        # print identically at two decimals share a rank.
        printed = f"{e['final'] * 100:.2f}"
        rank = last_rank if printed == last_key else position
        last_rank, last_key = rank, printed
        standings.append({"rank": rank, "name": e["name"], "person_key": e["person_key"],
                          **e["accs"], "final": e["final"]})
    return standings


def _final_get() -> dict | None:
    """The saved snapshot, public or not, or None if nothing was ever computed.
    The caller must hold db_lock()."""
    docs = final_table.all()
    return dict(docs[-1]) if docs else None


def _final_state() -> dict:
    """Whether the saved snapshot is public right now, and when that last
    changed. The single source of truth for visibility, absence included.

    NO state document at all means the snapshot was published by a version that
    predates this table, so it stays public: upgrading the server must not make
    a published board vanish under the readers. Only an explicit visible=false,
    written by Unpublish, hides one. Absence and explicit-false are different.
    The caller must hold db_lock()."""
    docs = final_state.all()
    if not docs:
        # A snapshot written by this version always writes a state row too, so
        # "no state row" can only mean the snapshot predates this table. An
        # unstamped snapshot is legacy and stays public; a stamped one whose
        # state row is missing was tampered with or half-restored from a
        # backup, and must NOT silently republish itself.
        docs_all = final_table.all()
        legacy = [d for d in docs_all if "schema" not in d]
        # exactly one unstamped snapshot and nothing else: a genuine legacy
        # publish. Anything else is a hand-edited or half-restored database, and
        # must not republish itself silently.
        return {"visible": len(docs_all) == 1 and len(legacy) == 1, "changed_at": ""}
    state = dict(docs[-1])
    return {"visible": bool(state.get("visible")), "changed_at": state.get("changed_at") or ""}


def _final_set_visible(visible: bool) -> None:
    """Show or hide the saved snapshot. This writes the flag and NOTHING else:
    the snapshot itself is never touched here, which is what makes hiding
    reversible. The caller must hold db_lock()."""
    doc = {"visible": bool(visible),
           "changed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    def _apply(table: dict) -> None:
        table.clear()          # exactly one document, whatever was there before
        table[1] = doc

    final_state._update_table(_apply)


def _final_publish() -> dict:
    """Recompute the standings, replace the saved snapshot and show it.
    Idempotent: each table holds at most one document. The snapshot is written
    before the flag, so a crash between the two writes leaves the previous
    visibility in force rather than exposing a half-written result.
    The caller must hold db_lock()."""
    # "schema" marks a snapshot written by this version, which always writes a
    # final_state row alongside. Its absence is what identifies a legacy
    # snapshot in _final_state(). Never served: /api/final returns only
    # published_at and standings.
    doc = {"schema": 2,
           "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "standings": _final_standings()}

    def _apply(table: dict) -> None:
        table.clear()          # publishing twice replaces, never piles up
        table[1] = doc

    final_table._update_table(_apply)
    _final_set_visible(True)
    return doc


def get_owner_hash(required: bool = True) -> str | None:
    token = request.headers.get("X-Owner-Token", "").strip()
    if not token or not is_valid_token(token):
        if required:
            abort(400, description="Missing or malformed X-Owner-Token header." if token else "Missing X-Owner-Token header.")
        return None
    return hash_token(token)


BAD_JSON = object()   # distinct from a literal null body, which is merely invalid


def api_json_body() -> object:
    try:
        return request.get_json(force=True, silent=False)
    except (BadRequest, RecursionError, ValueError):  # malformed / too deeply nested JSON
        return BAD_JSON


# ----------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------
@app.get("/api/submissions")
def list_submissions():
    owner_hash = get_owner_hash(required=False)
    with db_lock():
        rows = [public_row(doc, owner_hash) for doc in submissions.all()]
    return jsonify({"submissions": rows, "count": len(rows)})


@app.put("/api/submissions/mine")
def upsert_my_submission():
    """Create or replace the caller's results. The body is an array with one
    entry per benchmark, so every upload rewrites both of the caller's rows."""
    owner_hash = get_owner_hash()
    body = api_json_body()
    if body is BAD_JSON:
        return jsonify({"error": "The file is not valid JSON.",
                        "details": ["The file is not valid JSON. Write it with json.dump and upload that file."]}), 400
    entries, errors = validate_submission(body)
    if errors:
        return jsonify({"error": "Invalid submission.", "details": errors}), 422

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db_lock():
        # conflict pass first, so nothing is written unless every entry is clear
        for entry in entries:
            pk = person_key(entry)
            # a name on the board belongs to exactly one browser token, on every benchmark
            other_owner = submissions.get(
                (Submission.person_key == pk) & (Submission.owner_hash != owner_hash))
            if other_owner:
                msg = (f"A submission under the name {other_owner.get('name', '?')} already exists and was "
                       "uploaded from a different browser. If it is yours, upload from that browser, or ask "
                       "an organiser to remove it.")
                return jsonify({"error": "Duplicate person.", "details": [msg]}), 409
        # No same-token two-name check is needed: every upload carries both
        # benchmarks, so it rewrites all of this token's rows under one name.
        # only genuinely new rows count against the cap; replacing is always allowed
        inserts = [e for e in entries if not submissions.get(
            (Submission.owner_hash == owner_hash) & (Submission.benchmark == e["benchmark"]))]
        if len(submissions) + len(inserts) > MAX_SUBMISSIONS:
            return jsonify({"error": "The leaderboard is full.",
                            "details": ["The leaderboard is full. Contact an organiser."]}), 507
        results = []
        any_created = False
        planned: list[tuple[int | None, dict]] = []
        for entry in entries:
            existing = submissions.get(
                (Submission.owner_hash == owner_hash) & (Submission.benchmark == entry["benchmark"]))
            if existing:
                doc = {**existing, **entry, "person_key": person_key(entry), "submitted_at": now}
                planned.append((existing.doc_id, doc))
            else:
                doc = {"id": uuid.uuid4().hex[:12], "owner_hash": owner_hash, **entry,
                       "person_key": person_key(entry), "submitted_at": now}
                planned.append((None, doc))
                any_created = True
            results.append(public_row(doc, owner_hash))

        def _apply(table: dict) -> None:
            next_id = max(table, default=0) + 1
            for doc_id, doc in planned:
                if doc_id is None:
                    table[next_id] = doc
                    next_id += 1
                else:
                    table[doc_id] = doc

        # ONE storage write for the whole submission. Writing per entry would
        # leave Benchmark A on the board and B missing if the second write
        # failed, which is exactly the half-submission this endpoint forbids.
        submissions._update_table(_apply)
    return jsonify({"submissions": results, "created": any_created}), (201 if any_created else 200)


@app.get("/api/submissions/mine")
def get_my_submission():
    owner_hash = get_owner_hash()
    with db_lock():
        docs = submissions.search(Submission.owner_hash == owner_hash)
    return jsonify({"submissions": [public_row(d, owner_hash) for d in docs]})


@app.delete("/api/submissions/mine")
@app.delete("/api/submissions/mine/<bench>")
def delete_my_submission(bench: str | None = None):
    owner_hash = get_owner_hash()
    cond = Submission.owner_hash == owner_hash
    if bench is not None:
        normalized = normalize_benchmark(bench)
        if normalized is None:
            abort(404, description="Unknown benchmark.")
        cond = cond & (Submission.benchmark == normalized)
    with db_lock():
        removed = submissions.remove(cond)
    if not removed:
        return jsonify({"error": "You have no submission to delete."}), 404
    return "", 204


@app.delete("/api/submissions/<submission_id>")
def admin_delete_submission(submission_id: str):
    """Organiser escape hatch (e.g. a student lost their token). Needs LEADERBOARD_ADMIN_KEY."""
    key = request.headers.get("X-Admin-Key", "")
    if not ADMIN_KEY or not hmac.compare_digest(key.encode("utf-8", "surrogateescape"), ADMIN_KEY.encode("utf-8")):
        return jsonify({"error": "Admin key missing or wrong (set LEADERBOARD_ADMIN_KEY on the server)."}), 403
    with db_lock():
        removed = submissions.remove(Submission.id == submission_id)
    if not removed:
        return jsonify({"error": "No submission with that id."}), 404
    return "", 204


@app.get("/api/final")
def get_final_standings():
    """The frozen final ranking, once the organisers have published it. Public
    and unauthenticated by design: publishing IS the moment the real scores
    become public. Serves the stored snapshot verbatim, so it carries the
    whole-test-set accuracies as accA/accB and nothing else: no owner hashes
    and no hidden-slice numbers. A snapshot the organisers have hidden again is
    still in the database but answers exactly like no snapshot at all."""
    with db_lock():
        doc = _final_get() if _final_state()["visible"] else None
    if not doc:
        return jsonify({"error": "The final standings are not published yet."}), 404
    return jsonify({"published_at": doc.get("published_at", ""),
                    "standings": doc.get("standings") or []})


# ----------------------------------------------------------------------------
# /admin : password-protected editor for the two documents the site renders.
# Not linked from anywhere and not indexed. Disabled unless
# LEADERBOARD_EDIT_PASSWORD is set, in which case every route here 404s so the
# panel is indistinguishable from a URL that does not exist.
# ----------------------------------------------------------------------------
EDITABLE = {
    "assignment": (BASE_DIR / "workshop" / "ASSIGNMENT.md", "Assignment", "/assignment"),
    "guide": (BASE_DIR / "submit_readme.md", "Submission guide", "/guide"),
}
_edit_fails: dict[str, list] = {}       # ip -> [count, first_failure_ts]
_edit_fail_lock = threading.Lock()


def _edit_enabled() -> bool:
    return bool(EDIT_PASSWORD)


def _client_ip() -> str:
    """The peer as the nearest proxy saw it, for login rate limiting.

    Take the LAST X-Forwarded-For entry, never the first. A client can send any
    header it likes, so the leading entries are attacker-controlled: reading
    those let anyone reset their own lockout by inventing a new address and go
    on guessing the admin password forever. The nearest trusted proxy appends
    the real peer last (nginx $proxy_add_x_forwarded_for), so the tail is the
    only part it actually vouches for."""
    fwd = request.headers.get("X-Forwarded-For", "")
    parts = [p.strip() for p in fwd.split(",") if p.strip()]
    return (parts[-1] if parts else request.remote_addr) or "?"


def _locked_out(ip: str) -> int:
    """Seconds remaining in the cool-off, or 0."""
    with _edit_fail_lock:
        entry = _edit_fails.get(ip)
        if not entry or entry[0] < EDIT_MAX_TRIES:
            return 0
        left = int(entry[1] + EDIT_COOLOFF_S - time.time())
        if left <= 0:
            _edit_fails.pop(ip, None)
            return 0
        return left


def _note_failure(ip: str) -> None:
    with _edit_fail_lock:
        entry = _edit_fails.get(ip)
        if not entry or time.time() - entry[1] > EDIT_COOLOFF_S:
            _edit_fails[ip] = [1, time.time()]
        else:
            entry[0] += 1


def _edit_sign(payload: str) -> str:
    return hmac.new(EDIT_PASSWORD.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _edit_epoch() -> int:
    """The session epoch, from the database so every worker agrees on it. Every
    token carries the epoch it was minted under, so bumping it revokes them all.
    Cached for the rest of the request: one read per admin hit, not per check."""
    if has_app_context() and getattr(g, "edit_epoch", None) is not None:
        return g.edit_epoch
    with db_lock():
        docs = admin_state.all()
    epoch = int(docs[-1].get("epoch") or 0) if docs else 0
    if has_app_context():
        g.edit_epoch = epoch
    return epoch


def _edit_bump_epoch() -> int:
    """Sign out everywhere: every token issued so far stops verifying, in this
    worker and in every other one, immediately."""
    with db_lock():
        docs = admin_state.all()
        epoch = (int(docs[-1].get("epoch") or 0) if docs else 0) + 1
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

        def _apply(table: dict) -> None:
            table.clear()
            table[1] = {"epoch": epoch, "changed_at": stamp}

        admin_state._update_table(_apply)
    if has_app_context():
        g.edit_epoch = epoch
    return epoch


def _edit_new_token() -> str:
    expiry = int(time.time()) + EDIT_SESSION_HOURS * 3600
    payload = f"{expiry}.{_edit_epoch()}"
    return f"{payload}.{_edit_sign(payload)}"


def _edit_token_ok(token: str) -> bool:
    expiry, _, rest = (token or "").partition(".")
    epoch, _, signature = rest.partition(".")
    # isdigit() is True for values int() then refuses: superscripts like "\u00b2",
    # other unicode digits, and strings past CPython's 4300-digit conversion
    # limit. Bound and restrict them here or an unauthenticated request can
    # raise ValueError out of this function and return 500 instead of 401.
    if not (expiry.isascii() and expiry.isdigit() and len(expiry) <= 12
            and epoch.isascii() and epoch.isdigit() and len(epoch) <= 12
            and signature):
        return False
    if int(expiry) < time.time():
        return False
    if int(epoch) != _edit_epoch():      # signed out since this token was issued
        return False
    return hmac.compare_digest(signature, _edit_sign(f"{expiry}.{epoch}"))


def _edit_session() -> str | None:
    token = request.cookies.get("edit_session", "")
    return token if _edit_token_ok(token) else None


def _edit_csrf(token: str | None) -> str:
    """The value the forms carry. It is DERIVED from the session token instead of
    being the token itself, so the cookie value never appears in a rendered page:
    a screenshot of the editor is no longer a working credential."""
    return _edit_sign("csrf:" + token) if token else ""


def _edit_csrf_ok(token: str) -> bool:
    """Exactly one csrf field, matching this session. Flask hands back the first
    value of a repeated field, so count them rather than trusting the first."""
    supplied = request.form.getlist("csrf")
    if len(supplied) != 1:
        return False
    return hmac.compare_digest(supplied[0].encode("utf-8", "surrogateescape"),
                               _edit_csrf(token).encode("utf-8"))


def _edit_write_guard():
    """The gate every /admin POST that changes something passes: the panel must
    exist, the session must be live and the form must carry this session's CSRF
    token. Returns the response to send back, or None to proceed."""
    if not _edit_enabled():
        abort(404)
    token = _edit_session()
    if not token:
        return app.response_class(_edit_login_page("Your session expired. Sign in again."),
                                  mimetype="text/html", status=401)
    if not _edit_csrf_ok(token):
        return app.response_class(_edit_login_page("Stale form. Sign in again."),
                                  mimetype="text/html", status=403)
    return None


def _edit_page(body: str, title: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{title}</title>
<link rel="icon" type="image/png" href="/static/favicon.png">
<link rel="stylesheet" href="/static/style.css">
<style>
 .adm {{ max-width: 60rem; margin: 3rem auto; padding: 0 1.5rem; }}
 .adm textarea {{ width: 100%; min-height: 32rem; font-family: var(--font-mono, monospace);
   font-size: .85rem; line-height: 1.55; padding: 1rem; border: 1px solid var(--line, #ccc);
   border-radius: .5rem; background: #fff; color: #111; }}
 .adm .row {{ display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; }}
 .adm .warn {{ border-left: 3px solid #b45309; background: #fffbeb; color: #7c2d12;
   padding: .75rem 1rem; border-radius: .25rem; margin: 1rem 0; }}
 .adm .err {{ border-left: 3px solid #b91c1c; background: #fef2f2; color: #7f1d1d;
   padding: .75rem 1rem; border-radius: .25rem; margin: 1rem 0; }}
 .adm .ok {{ border-left: 3px solid #15803d; background: #f0fdf4; color: #14532d;
   padding: .75rem 1rem; border-radius: .25rem; margin: 1rem 0; }}
 .adm input[type=password] {{ padding: .55rem .7rem; border: 1px solid var(--line, #ccc);
   border-radius: .4rem; min-width: 18rem; }}
</style></head><body><main class="adm">{body}</main></body></html>"""


def _edit_login_page(message: str = "") -> str:
    note = f'<p class="err">{html_mod.escape(message)}</p>' if message else ""
    return _edit_page(f"""
 <h1>Editor</h1>
 {note}
 <form method="post" action="/admin/login">
   <div class="row">
     <input type="password" name="password" placeholder="Password" autofocus
            autocomplete="current-password" required>
     <button class="btn btn-primary" type="submit">Sign in</button>
   </div>
 </form>""", "Editor")


def _edit_editor_page(key: str, message: str = "", ok: str = "") -> str:
    path, label, view = EDITABLE[key]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        text = ""
        message = message or f"Cannot read {path.name}: {e.strerror}"
    token = _edit_csrf(_edit_session())
    tabs = _edit_nav(key)
    note = f'<p class="err">{html_mod.escape(message)}</p>' if message else ""
    good = f'<p class="ok">{html_mod.escape(ok)}</p>' if ok else ""
    backup = path.with_suffix(path.suffix + ".bak")
    restore = ""
    if backup.exists():
        restore = ('<button class="btn btn-ghost btn-sm" type="submit" name="action" value="restore" '
                   'formnovalidate>Restore previous version</button>')
    return _edit_page(f"""
 <h1>Editor</h1>
 <div class="row">{tabs}
   <span style="flex:1"></span>
   <a class="btn btn-ghost btn-sm" href="{view}" target="_blank" rel="noopener">View page</a>
   <form method="post" action="/admin/logout" style="display:inline">
     <input type="hidden" name="csrf" value="{html_mod.escape(token)}">
     <button class="btn btn-ghost btn-sm" type="submit">Sign out</button>
   </form>
 </div>
 {note}{good}
 <p class="warn"><strong>Deploying overwrites this.</strong>
   <code>update_site.sh</code> uploads {html_mod.escape(path.name)} from the repository, so any edit
   made here is replaced by the next deploy. Copy your change back into the repository too.</p>
 <form method="post" action="/admin/save">
   <input type="hidden" name="csrf" value="{html_mod.escape(token)}">
   <input type="hidden" name="doc" value="{html_mod.escape(key)}">
   <textarea name="content" spellcheck="false">{html_mod.escape(text)}</textarea>
   <div class="row">
     <button class="btn btn-primary" type="submit" name="action" value="save">Save</button>
     {restore}
     <span class="card-head-note">{len(text):,} characters</span>
   </div>
 </form>""", f"Editor: {label}")


def _edit_set_cookie(resp, token: str, clear: bool = False):
    resp.set_cookie("edit_session", "" if clear else token,
                    max_age=0 if clear else EDIT_SESSION_HOURS * 3600,
                    httponly=True, samesite="Strict",
                    secure=request.headers.get("X-Forwarded-Proto", request.scheme) == "https",
                    path="/admin")
    return resp


def _edit_nav(active: str) -> str:
    links = [(f"/admin?doc={k}", v[1], k == active) for k, v in EDITABLE.items()]
    links.append(("/admin/scores", "Scores", active == "scores"))
    return " ".join(
        f'<a class="btn btn-ghost btn-sm" href="{href}"'
        f'{" aria-current=page" if cur else ""}>{html_mod.escape(label)}</a>'
        for href, label, cur in links)


def _slice_sizes(bench: str) -> tuple[int, int, int]:
    """(public rows, hidden rows, all rows) for one benchmark's test set."""
    total = len(ANSWER_KEYS.get(bench) or {})
    public = len(PUBLIC_IDS.get(bench) or ())
    return public, total - public, total


def _full_metric(row: dict, bench: str) -> float | None:
    """Accuracy over the WHOLE test set, rebuilt from the two stored slices.
    metric is the public 40 %, metric_hidden the remaining 60 %, so the full
    score is their row-weighted mean. Exact, no extra scoring pass needed."""
    public, hidden, total = _slice_sizes(bench)
    pub, hid = row.get("metric"), row.get("metric_hidden")
    if pub is None or hid is None or not total:
        return None
    # Recover the integer counts of correct answers before dividing. Going
    # straight from the two stored fractions leaves the result 1 ulp off on
    # about 1 % of count pairs, because c/n*n does not always round-trip.
    return (round(pub * public) + round(hid * hidden)) / total


def _pct(value) -> str:
    return "&ndash;" if value is None else f"{value * 100:.2f}&nbsp;%"


def _final_panel(published: dict | None, state: dict, notice: str = "") -> str:
    """Publish / hide / show-again controls for the saved standings. Three
    states: nothing computed yet, saved and public, saved but hidden."""
    token = html_mod.escape(_edit_csrf(_edit_session()))
    good = f'<p class="ok">{html_mod.escape(notice)}</p>' if notice else ""
    republish = ('<button class="btn btn-ghost btn-sm" type="submit">'
                 'Republish (refresh snapshot)</button>')
    if published:
        count = len(published.get("standings") or [])
        who = f'{count} {"person" if count == 1 else "people"}'
        stamp = html_mod.escape(str(published.get("published_at", "")))
    if published and state["visible"]:
        text = (f'Published. Computed <strong>{stamp}</strong> &middot; {who}. Anyone can read it '
                'at <a href="/api/final" target="_blank" rel="noopener">/api/final</a>.')
        buttons = republish + ('<button class="btn btn-ghost btn-sm" type="submit"'
                               ' formaction="/admin/unpublish" formnovalidate>Unpublish</button>')
    elif published:
        hidden_at = html_mod.escape(state["changed_at"])
        text = (f'Hidden since <strong>{hidden_at}</strong>. Nothing was lost: the standings '
                f'computed {stamp} ({who}) are still saved here, and <a href="/api/final" '
                'target="_blank" rel="noopener">/api/final</a> answers 404 until you show them '
                'again. Showing them again serves exactly those saved numbers; republishing '
                'replaces them with the table below as it stands now.')
        buttons = ('<button class="btn btn-primary" type="submit"'
                   ' formaction="/admin/republish_saved" formnovalidate>'
                   'Show the saved standings again</button>') + republish
    else:
        text = ("Not published. Nothing below leaves this page until you publish. Publishing "
                "freezes the <em>full</em> columns as they are now and serves them, with their "
                "mean, to everyone: later uploads do not change a published result.")
        buttons = '<button class="btn btn-primary" type="submit">Publish final standings</button>'
    return f"""
 {good}
 <form method="post" action="/admin/publish">
   <input type="hidden" name="csrf" value="{token}">
   <div class="row"><span>{text}</span><span style="flex:1"></span>{buttons}</div>
 </form>"""


def _edit_scores_page(notice: str = "") -> str:
    with db_lock():
        rows = submissions.all()
        published = _final_get()
        state = _final_state()
    people: dict[str, dict] = {}
    for r in rows:
        bench = r.get("benchmark")
        if bench not in BENCHMARKS:
            continue
        p = people.setdefault(r.get("person_key") or r.get("name", "?"),
                              {"name": r.get("name", "?")})
        p[bench] = r

    table = []
    for p in people.values():
        cells, hidden_parts, full_parts = [], [], []
        for bench in BENCHMARKS:
            row = p.get(bench)
            if row is None:
                cells.append((None, None, None, None))
                hidden_parts.append(0.0)
                full_parts.append(0.0)
                continue
            full = _full_metric(row, bench)
            cells.append((row.get("metric"), row.get("metric_hidden"), full,
                          row.get(TIME_FIELD)))
            hidden_parts.append(row.get("metric_hidden") or 0.0)
            full_parts.append(full or 0.0)
        table.append({
            "name": p["name"],
            "cells": cells,
            "hidden_avg": sum(hidden_parts) / len(BENCHMARKS),
            "final": sum(full_parts) / len(BENCHMARKS),   # what /admin/publish publishes
        })
    table.sort(key=lambda e: (-e["final"], e["name"].casefold()))
    # Share a rank on equal finals, exactly as the published snapshot and the
    # public board do, so the organiser sees the same numbering students will.
    last_rank, last_key = 0, None
    for i, e in enumerate(table, 1):
        key = f"{e['final'] * 100:.2f}"
        e["rank"] = last_rank if key == last_key else i
        last_rank, last_key = e["rank"], key

    head = "".join(
        f'<th colspan="4">Benchmark {b}</th>' for b in BENCHMARKS)
    sub = "".join('<th class="num">public</th><th class="num">hidden</th>'
                  '<th class="num">full</th><th class="num">ms</th>'
                  for _ in BENCHMARKS)
    body = []
    for e in table:
        tds = []
        for pub, hid, full, ms in e["cells"]:
            tds.append(f'<td class="num">{_pct(pub)}</td>'
                       f'<td class="num">{_pct(hid)}</td>'
                       f'<td class="num"><strong>{_pct(full)}</strong></td>'
                       f'<td class="num">{"&ndash;" if ms is None else f"{ms:g}"}</td>')
        body.append(
            f'<tr><td class="num">{e["rank"]}</td><td>{html_mod.escape(e["name"])}</td>'
            + "".join(tds)
            + f'<td class="num">{_pct(e["hidden_avg"])}</td>'
              f'<td class="num"><strong>{_pct(e["final"])}</strong></td></tr>')
    if not body:
        body.append('<tr><td colspan="12">No submissions yet.</td></tr>')

    sizes = " &middot; ".join(
        f"Benchmark {b}: {p:,} public / {h:,} hidden / {t:,} total"
        for b in BENCHMARKS for p, h, t in [_slice_sizes(b)])

    return _edit_page(f"""
 <h1>Scores</h1>
 <div class="row">{_edit_nav("scores")}
   <span style="flex:1"></span>
   <form method="post" action="/admin/logout" style="display:inline">
     <input type="hidden" name="csrf" value="{html_mod.escape(_edit_csrf(_edit_session()))}">
     <button class="btn btn-ghost btn-sm" type="submit">Sign out</button>
   </form>
 </div>
 <p class="warn"><strong>Organisers only.</strong> The public board shows the
   <em>public</em> column and nothing else. The hidden and full columns are never
   sent to a student's browser. Do not paste this page anywhere.</p>
 {_final_panel(published, state, notice)}
 <div class="table-card"><div class="table-scroll" tabindex="0" role="region" aria-label="Full scores">
 <table class="leaderboard">
   <thead>
     <tr><th rowspan="2" class="num">#</th><th rowspan="2">Name</th>{head}
         <th colspan="2">Overall</th></tr>
     <tr>{sub}<th class="num">hidden avg</th><th class="num">final</th></tr>
   </thead>
   <tbody>{"".join(body)}</tbody>
 </table></div>
 <p class="table-footnote">{sizes}. <strong>final</strong> is the mean of the two
   full scores, and it is exactly what Publish sends to the public page.
   <strong>hidden avg</strong> is the mean of the hidden slices, shown for
   information only. A missing benchmark counts as 0.</p>
 </div>""", "Editor: scores")


@app.get("/admin/scores")
def admin_scores():
    if not _edit_enabled():
        abort(404)
    if not _edit_session():
        return app.response_class(_edit_login_page(), mimetype="text/html", status=401)
    notice = {"1": "Final standings published.",
              "0": "Final standings hidden. The saved standings are still here.",
              "noop": "Nothing to hide: the standings were not public.",
              "again": "The saved standings are public again, exactly as they were computed.",
              "already": "The saved standings were already public; nothing changed.",
              "none": "Nothing has been computed yet, so there is nothing to show."
              }.get(request.args.get("published", ""), "")
    return app.response_class(_edit_scores_page(notice), mimetype="text/html")


@app.get("/admin")
def admin_editor():
    if not _edit_enabled():
        abort(404)
    if not _edit_session():
        return app.response_class(_edit_login_page(), mimetype="text/html")
    key = request.args.get("doc", "assignment")
    if key not in EDITABLE:
        key = "assignment"
    return app.response_class(_edit_editor_page(key), mimetype="text/html")


@app.post("/admin/login")
def admin_login():
    if not _edit_enabled():
        abort(404)
    ip = _client_ip()
    left = _locked_out(ip)
    if left:
        return app.response_class(
            _edit_login_page(f"Too many attempts. Try again in {left} seconds."),
            mimetype="text/html", status=429)
    supplied = request.form.get("password", "")
    time.sleep(0.25)   # blunt rapid guessing and timing probes
    if not hmac.compare_digest(supplied.encode("utf-8", "surrogateescape"),
                               EDIT_PASSWORD.encode("utf-8")):
        _note_failure(ip)
        return app.response_class(_edit_login_page("Wrong password."),
                                  mimetype="text/html", status=401)
    with _edit_fail_lock:
        _edit_fails.pop(ip, None)
    resp = app.response_class("", status=302)
    resp.headers["Location"] = "/admin"
    return _edit_set_cookie(resp, _edit_new_token())


@app.post("/admin/logout")
def admin_logout():
    if not _edit_enabled():
        abort(404)
    # A real sign-out (live session, matching form) bumps the epoch, which
    # invalidates every token issued so far, so a copied cookie stops working.
    # A request that fails the gate only clears this browser's cookie: nobody
    # can sign the organisers out by aiming a stray POST at this URL.
    refused = _edit_write_guard()
    if refused is not None:
        # Do not act for a caller who failed the gate. Clearing the cookie here
        # let a cross-origin form POST evict the organiser's session mid-workshop.
        return refused
    _edit_bump_epoch()
    resp = app.response_class("", status=302)
    resp.headers["Location"] = "/admin"
    return _edit_set_cookie(resp, "", clear=True)


@app.post("/admin/save")
def admin_save():
    denied = _edit_write_guard()
    if denied is not None:
        return denied
    key = request.form.get("doc", "")
    if key not in EDITABLE:
        abort(404)
    path = EDITABLE[key][0]
    backup = path.with_suffix(path.suffix + ".bak")

    if request.form.get("action") == "restore":
        if not backup.exists():
            return app.response_class(_edit_editor_page(key, "There is no previous version to restore."),
                                      mimetype="text/html", status=404)
        try:
            shutil.copy2(backup, path)
        except OSError as e:
            return app.response_class(_edit_editor_page(key, f"Could not restore: {e.strerror}"),
                                      mimetype="text/html", status=500)
        return app.response_class(_edit_editor_page(key, ok="Previous version restored."),
                                  mimetype="text/html")

    content = request.form.get("content", "")
    if len(content.encode("utf-8")) > EDIT_MAX_BYTES:
        return app.response_class(_edit_editor_page(key, "That is too large to save."),
                                  mimetype="text/html", status=413)
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    if not content.endswith("\n"):
        content += "\n"
    try:
        if path.exists():
            shutil.copy2(path, backup)          # one step of undo
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)               # atomic: readers never see half a file
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    except OSError as e:
        return app.response_class(_edit_editor_page(key, f"Could not save: {e.strerror}"),
                                  mimetype="text/html", status=500)
    return app.response_class(_edit_editor_page(key, ok="Saved. Reload the page to see it."),
                              mimetype="text/html")


def _admin_scores_redirect(flag: str):
    resp = app.response_class("", status=302)
    resp.headers["Location"] = f"/admin/scores?published={flag}"
    return resp


@app.post("/admin/publish")
def admin_publish():
    """Freeze the hidden-slice ranking as it stands and serve it from /api/final.
    Safe to press twice: it simply replaces the snapshot with a fresh one."""
    denied = _edit_write_guard()
    if denied is not None:
        return denied
    with db_lock():
        _final_publish()
    return _admin_scores_redirect("1")


@app.post("/admin/unpublish")
def admin_unpublish():
    """Hide the standings again: /api/final goes back to 404 and no route serves
    any part of them. The snapshot itself stays in the database, so this is
    reversible with /admin/republish_saved."""
    denied = _edit_write_guard()
    if denied is not None:
        return denied
    with db_lock():
        was_public = _final_get() is not None and _final_state()["visible"]
        if was_public:
            _final_set_visible(False)
    # only claim a withdrawal when something was actually withdrawn
    return _admin_scores_redirect("0" if was_public else "noop")


@app.post("/admin/republish_saved")
def admin_republish_saved():
    """Show the saved standings again, exactly as they were computed: this only
    flips the flag, it never recomputes. With nothing saved it is a no-op, and
    it says so rather than claiming success."""
    denied = _edit_write_guard()
    if denied is not None:
        return denied
    with db_lock():
        saved = _final_get() is not None
        already = saved and _final_state()["visible"]
        if saved and not already:
            _final_set_visible(True)
    return _admin_scores_redirect("again" if saved and not already
                                  else "already" if saved else "none")


OWNER_COOKIE = "ostrai_owner"
OWNER_COOKIE_MAX_AGE = 60 * 24 * 3600      # 60 days, refreshed on every visit


def _refresh_owner_cookie(response) -> None:
    """Mirror a valid X-Owner-Token into a cookie the SERVER sets.

    A student's identity is a random token in localStorage. Safari's tracking
    prevention deletes script-written storage after 7 days without a visit, which
    would cost them the right to replace or delete their own submission. A cookie
    written by the server through Set-Cookie is not capped that way, so the front
    end can restore the token from it. Identity still comes from the HEADER and
    nothing else: this cookie is a backup copy for the browser to read, never an
    authorisation source, and no request is ever authorised by it."""
    token = request.headers.get("X-Owner-Token", "").strip()
    if not token or not is_valid_token(token) or not token.isascii():
        # isalnum() is true for letters like 'e' with an accent, so a token can be
        # valid identity yet not fit in a cookie value: werkzeug would quote and
        # escape it, and the browser would read back something else. Skip those
        # rather than hand the front end a value that is not its token.
        return
    response.set_cookie(OWNER_COOKIE, token, max_age=OWNER_COOKIE_MAX_AGE, path="/",
                        httponly=False, samesite="Lax",
                        secure=request.headers.get("X-Forwarded-Proto", request.scheme) == "https")


@app.after_request
def cache_headers(response):
    if request.path.startswith("/admin"):
        # never cache the editor or its session state, anywhere
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["Referrer-Policy"] = "no-referrer"
        # the panel's buttons publish and withdraw with one click, so refuse to
        # be framed: UI redress works where a CSRF token does not
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    elif request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Vary"] = "X-Owner-Token"
    elif request.path.startswith("/static/") and response.status_code == 200:
        # URLs carry a content-hash ?v=..., so long caching is safe. Never cache
        # a miss: a request that races a deploy would pin the 404 for a day.
        response.headers["Cache-Control"] = "public, max-age=86400"
    # Never attach a student's owner token to a publicly cacheable response: a
    # shared cache would hand it to the next visitor, who could then overwrite
    # or delete that student's submission.
    if not request.path.startswith(("/admin", "/static/")):
        _refresh_owner_cookie(response)
    return response


@app.errorhandler(Exception)
def api_error(err):
    """JSON errors for the API; default HTML pages for everything else."""
    is_http = isinstance(err, HTTPException)
    code = err.code if is_http else 500
    if code == 500:
        app.logger.exception("Unhandled error in %s", request.path)
    if request.path.startswith("/api/"):
        return jsonify({"error": err.description if is_http else "Internal server error."}), code
    if code == 404:   # a styled page with a way back, not bare Flask
        with contextlib.suppress(OSError):
            resp = _serve_html("404.html")
            resp.status_code = 404
            return resp
    return err if is_http else InternalServerError()


# ----------------------------------------------------------------------------
# Static front-end
# ----------------------------------------------------------------------------
def _asset_version() -> str:
    """Content hash of the front-end assets, appended to their URLs (?v=...) so
    browsers can cache aggressively yet always pick up new versions."""
    h = hashlib.sha256()
    for f in sorted(STATIC_DIR.glob("*")):
        if f.is_file() and f.suffix != ".html":
            h.update(f.name.encode())
            h.update(f.read_bytes())
    return h.hexdigest()[:10]


ASSET_VERSION = _asset_version()


def _serve_html(filename: str):
    html = (STATIC_DIR / filename).read_text(encoding="utf-8").replace("__V__", ASSET_VERSION)
    resp = app.response_class(html, mimetype="text/html")
    resp.headers["Cache-Control"] = "no-cache"   # always revalidate the page itself
    return resp


@app.get("/")
def index():
    return _serve_html("index.html")


@app.get("/guide")
def guide():
    return _serve_html("guide.html")


@app.get("/assignment")
def assignment():
    return _serve_html("assignment.html")


# One canonical URL per page. Redirect rather than serve both, because the
# markdown carries relative links that would resolve differently under a
# trailing slash.
@app.get("/guide/")
@app.get("/assignment/")
def strip_trailing_slash():
    return redirect(request.path.rstrip("/"), code=301)


@app.get("/workshop/ASSIGNMENT.md")
def assignment_md():
    # Serve exactly this one file; nothing else in workshop/ is ever exposed.
    return send_from_directory(BASE_DIR / "workshop", "ASSIGNMENT.md", mimetype="text/markdown")


_data_zip: bytes | None = None
_data_zip_lock = threading.Lock()


@app.get("/data/benchmarks.zip")
def benchmarks_zip():
    """The student data, zipped on first request and cached in memory.
    Only benchmark_* directories are included, so the pool answer key in
    workshop/data/_instructor/ can never be served."""
    global _data_zip
    with _data_zip_lock:
        if _data_zip is None:
            folders = sorted((BASE_DIR / "workshop" / "data").glob("benchmark_*"))
            files = [(d.name, f) for d in folders if d.is_dir() for f in sorted(d.iterdir()) if f.is_file()]
            if not files:
                abort(404, description="The data files are not installed on this server. Tell an organiser.")
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for folder, f in files:
                    zf.write(f, f"{folder}/{f.name}")
            _data_zip = buf.getvalue()
    return send_file(io.BytesIO(_data_zip), mimetype="application/zip",
                     as_attachment=True, download_name="ostrai-2026-benchmarks.zip")


@app.get("/static/<path:filename>")
def static_files(filename: str):
    # The page templates carry a __V__ placeholder that only _serve_html fills
    # in, so serving them raw gives a second URL for the same page with its
    # asset versioning broken. NOTE: in production this never runs. The host
    # maps /static/ straight to the directory, so any file that exists there is
    # served by the web server and Flask is only reached on a miss. The pages
    # therefore also carry <link rel="canonical">. Moving them out of static/
    # is the only way to make this guard bite everywhere.
    if filename.lower().endswith(".html"):
        abort(404)
    return send_from_directory(STATIC_DIR, filename)


@app.get("/examples/<path:filename>")
def example_files(filename: str):
    return send_from_directory(BASE_DIR / "examples", filename, as_attachment=True)


@app.get("/submit_readme.md")
def submit_readme():
    return send_from_directory(BASE_DIR, "submit_readme.md", mimetype="text/markdown")


if __name__ == "__main__":
    host = os.environ.get("LEADERBOARD_HOST", "0.0.0.0")
    port = int(os.environ.get("LEADERBOARD_PORT", "8000"))
    print(f"Leaderboard running on http://{host}:{port}  (db: {DB_PATH}, admin key {'set' if ADMIN_KEY else 'not set'})")
    app.run(host=host, port=port, debug=False)
