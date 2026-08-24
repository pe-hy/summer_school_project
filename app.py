"""
Ostr-AI Summer School 2026 — Final Project Leaderboard
------------------------------------------------------
Small Flask server that serves the static front-end and a tiny JSON REST API
backed by TinyDB (a NoSQL document store persisted to data/leaderboard.json).

Run:  python app.py            (defaults: host 0.0.0.0, port 8000)
Env:  LEADERBOARD_HOST, LEADERBOARD_PORT, LEADERBOARD_DB (path to the db file),
      LEADERBOARD_ADMIN_KEY (optional; enables organiser delete-by-id)

There is no login by design. Each browser generates a random "owner token"
(kept in localStorage) and sends it with every write request. A token owns at
most one submission; only the holder of the token can replace or delete it.
Only a SHA-256 hash of the token is stored in the database.
"""

from __future__ import annotations

import contextlib
import hashlib
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
import unicodedata
import zipfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
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
try:
    db.storage.read()  # fail fast, with a readable message, if the db file is unusable
except RuntimeError as e:
    sys.exit(f"ERROR: {e}")
Submission = Query()


def _migrate_legacy_rows() -> None:
    """Startup schema upkeep. Rows from an older schema are REMOVED (their values
    cannot be converted), with a stderr note — but only after the pre-migration
    file has been copied to a .bak next to it, so nothing is lost irreversibly."""
    legacy = [doc for doc in submissions.all()
              if any(k in doc for k in ("surname", "train_time_s", "test_time_s", "avg_time_s"))
              or TIME_FIELD not in doc or doc.get("benchmark") not in BENCHMARKS]
    if legacy and DB_PATH.exists():
        with contextlib.suppress(OSError):
            shutil.copy2(DB_PATH, DB_PATH.with_name(DB_PATH.name + ".pre-migration.bak"))
    for doc in submissions.all():
        if (any(k in doc for k in ("surname", "train_time_s", "test_time_s", "avg_time_s"))
                or TIME_FIELD not in doc or doc.get("benchmark") not in BENCHMARKS):
            print(f"NOTE: removing legacy submission {doc.get('name', '?')!r}: the schema changed "
                  "(two benchmarks, latency in ms); ask the owner to re-upload.", file=sys.stderr)
            submissions.remove(doc_ids=[doc.doc_id])
            continue
        person = unicodedata.normalize("NFKC", doc.get("name", "")).casefold()
        if doc.get("person_key") != person:
            submissions.update({"person_key": person}, doc_ids=[doc.doc_id])


_thread_lock = threading.Lock()   # TinyDB is not thread-safe; Flask's dev server is threaded
_LOCK_PATH = DB_PATH.with_name(DB_PATH.name + ".lock")


@contextlib.contextmanager
def db_lock():
    """Serialise read-modify-write cycles across threads AND worker processes
    (production servers such as PythonAnywhere/gunicorn run several workers)."""
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
                yield
            finally:
                if locked:
                    fcntl.flock(lock_fh, fcntl.LOCK_UN)


with db_lock():
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
        if path.exists():
            with open(path, encoding="utf-8") as fh:
                next(fh, None)                       # header
                for line in fh:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) == 2 and parts[0].isdigit():
                        gold[int(parts[0])] = parts[1]
        keys[bench] = gold
        print(f"answer key {bench}: {len(gold):,} test labels" if gold
              else f"WARNING: no answer key for benchmark {bench} at {path} - submissions will be refused",
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
        out[bench] = set(path.read_text(encoding="utf-8").split()) if path.exists() else set()
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
    for item in predictions:
        if not isinstance(item, dict):
            bad_rows += 1
            continue
        raw_id, intent = item.get("id"), item.get("intent")
        if isinstance(raw_id, str) and raw_id.strip().isdigit():
            raw_id = int(raw_id.strip())
        if isinstance(raw_id, bool) or not isinstance(raw_id, int) or not isinstance(intent, str):
            bad_rows += 1
            continue
        if raw_id not in gold:
            unknown_ids.append(raw_id)
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
    missing = len(gold) - len(seen)
    if missing > 0:
        absent = sorted(set(gold) - set(seen))[:3]
        errors.append(f"Benchmark {bench}: {missing:,} of {len(gold):,} test messages have no prediction, "
                      f"for example id {absent}. Predict every row of test.tsv.")
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
    """One entry (object), or an array with one result per benchmark (same name)."""
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        return None, ["Submission must be a JSON object or an array of one or two objects."]
    if len(data) > len(BENCHMARKS):
        return None, [f"At most {len(BENCHMARKS)} results (one per benchmark), found {len(data)}."]
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


def get_owner_hash(required: bool = True) -> str | None:
    token = request.headers.get("X-Owner-Token", "").strip()
    if not token or not is_valid_token(token):
        if required:
            abort(400, description="Missing or malformed X-Owner-Token header." if token else "Missing X-Owner-Token header.")
        return None
    return hash_token(token)


def api_json_body() -> object:
    try:
        return request.get_json(force=True, silent=False)
    except (BadRequest, RecursionError, ValueError):  # malformed / too deeply nested JSON
        return None


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
    """Create or replace the caller's result(s). Body: one entry or an array with
    one entry per benchmark. Only the benchmarks present in the body are touched."""
    owner_hash = get_owner_hash()
    entries, errors = validate_submission(api_json_body())
    if errors:
        return jsonify({"error": "Invalid submission.", "details": errors}), 422

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db_lock():
        # conflict pass first, so a two-entry upload is all-or-nothing
        req_benches = [e["benchmark"] for e in entries]
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
        # only genuinely new rows count against the cap — replacing is always allowed
        inserts = [e for e in entries if not submissions.get(
            (Submission.owner_hash == owner_hash) & (Submission.benchmark == e["benchmark"]))]
        if len(submissions) + len(inserts) > MAX_SUBMISSIONS:
            return jsonify({"error": "The leaderboard is full.",
                            "details": ["The leaderboard is full. Contact an organiser."]}), 507
        results = []
        any_created = False
        for entry in entries:
            existing = submissions.get(
                (Submission.owner_hash == owner_hash) & (Submission.benchmark == entry["benchmark"]))
            if existing:
                doc = {**existing, **entry, "person_key": person_key(entry), "submitted_at": now}
                submissions.update(doc, doc_ids=[existing.doc_id])
            else:
                doc = {"id": uuid.uuid4().hex[:12], "owner_hash": owner_hash, **entry,
                       "person_key": person_key(entry), "submitted_at": now}
                submissions.insert(doc)
                any_created = True
            results.append(public_row(doc, owner_hash))
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


@app.after_request
def cache_headers(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Vary"] = "X-Owner-Token"
    elif request.path.startswith("/static/"):
        # URLs carry a content-hash ?v=..., so long caching is safe
        response.headers["Cache-Control"] = "public, max-age=86400"
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
                abort(404, description="The data files are not installed on this server.")
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for folder, f in files:
                    zf.write(f, f"{folder}/{f.name}")
            _data_zip = buf.getvalue()
    return send_file(io.BytesIO(_data_zip), mimetype="application/zip",
                     as_attachment=True, download_name="ostrai-2026-benchmarks.zip")


@app.get("/static/<path:filename>")
def static_files(filename: str):
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
