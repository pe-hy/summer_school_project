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
import hmac
import json
import os
import stat
import sys
import threading
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory
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
NUMBER_FIELDS = ("metric", "avg_time_s")
NON_NEGATIVE_FIELDS = ("avg_time_s",)
FIELDS = STRING_FIELDS + NUMBER_FIELDS
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
        tmp = self.path.with_name(self.path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, **self.json_kwargs)
            fh.flush()
            os.fsync(fh.fileno())
        if self.path.exists():  # keep whatever permissions the organiser set on the db file
            os.chmod(tmp, stat.S_IMODE(self.path.stat().st_mode))
        os.replace(tmp, self.path)
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
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024  # 64 KB is plenty for one row
app.json.sort_keys = False
app.json.ensure_ascii = False

DB_PATH.with_name(DB_PATH.name + ".tmp").unlink(missing_ok=True)  # leftover from a crash mid-write
db = TinyDB(DB_PATH, storage=AtomicJSONStorage, indent=2, ensure_ascii=False)
submissions = db.table("submissions")
try:
    db.storage.read()  # fail fast, with a readable message, if the db file is unusable
except RuntimeError as e:
    sys.exit(f"ERROR: {e}")
Submission = Query()


def _migrate_legacy_rows() -> None:
    """Startup schema upkeep. Rows from before the avg-time-per-example schema are
    REMOVED (their total-test-time value cannot be converted to a per-example
    average), with a note on stderr so an organiser can ask for a re-upload."""
    for doc in submissions.all():
        if any(k in doc for k in ("surname", "train_time_s", "test_time_s")) or "avg_time_s" not in doc:
            print(f"NOTE: removing legacy submission {doc.get('name', '?')!r} — the schema changed to "
                  "average time per example; ask the owner to re-upload.", file=sys.stderr)
            submissions.remove(doc_ids=[doc.doc_id])
            continue
        person = unicodedata.normalize("NFKC", doc.get("name", "")).casefold()
        if doc.get("person_key") != person:
            submissions.update({"person_key": person}, doc_ids=[doc.doc_id])


_migrate_legacy_rows()
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


# ----------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------
def validate_entry(data: object) -> tuple[dict | None, list[str]]:
    """Return (clean_entry, errors). clean_entry is None when errors exist."""
    errors: list[str] = []
    if not isinstance(data, dict):
        return None, ["Submission must be a JSON object."]

    unknown = sorted(str(k).encode("utf-8", "replace").decode("utf-8")[:40] for k in set(data) - set(FIELDS))
    if unknown:
        errors.append("Unexpected field(s): " + ", ".join(unknown))

    clean: dict = {}
    for field in STRING_FIELDS:
        if field not in data:
            errors.append(f"Missing field '{field}'.")
            continue
        value = data[field]
        if not isinstance(value, str) or not value.strip():
            errors.append(f"'{field}' must be a non-empty text value.")
            continue
        value = unicodedata.normalize("NFC", " ".join(value.split()))  # collapse whitespace
        if len(value) > MAX_NAME_LEN:
            errors.append(f"'{field}' must be at most {MAX_NAME_LEN} characters.")
            continue
        # control, format (zero-width, bidi overrides), surrogate and private-use characters
        if any(unicodedata.category(c) in INVALID_CATEGORIES for c in value):
            errors.append(f"'{field}' contains invisible or control characters.")
            continue
        clean[field] = value

    for field in NUMBER_FIELDS:
        if field not in data:
            errors.append(f"Missing field '{field}'.")
            continue
        value = data[field]
        # bool is a subclass of int in Python; reject it explicitly.
        # Huge ints would overflow float(), hence the try/except.
        try:
            number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
        except OverflowError:
            number = None
        if number is None or number != number or abs(number) > MAX_ABS_NUMBER:
            errors.append(f"'{field}' must be a finite number (|x| <= {MAX_ABS_NUMBER:g}).")
            continue
        if field in NON_NEGATIVE_FIELDS and number < 0:
            errors.append(f"'{field}' must be >= 0.")
            continue
        if field == "metric" and not 0 <= number <= 1:
            errors.append("'metric' must be between 0 and 1 — accuracy as a fraction (93.12 % is 0.9312).")
            continue
        clean[field] = number

    return (clean, []) if not errors else (None, errors)


def person_key(entry: dict) -> str:
    """Case-insensitive identity used to stop the same person appearing twice."""
    return unicodedata.normalize("NFKC", entry["name"]).casefold()


def public_row(doc: dict, owner_hash: str | None) -> dict:
    """Public view of a document (never exposes the owner hash)."""
    return {
        "id": doc.get("id"),
        "name": doc.get("name", ""),
        "metric": doc.get("metric"),
        "avg_time_s": doc.get("avg_time_s"),
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
    """Create the caller's submission, or replace it if one already exists."""
    owner_hash = get_owner_hash()
    clean, errors = validate_entry(api_json_body())
    if errors:
        return jsonify({"error": "Invalid submission.", "details": errors}), 422

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db_lock():
        existing = submissions.get(Submission.owner_hash == owner_hash)
        # the same person must not appear twice under different tokens
        same_person = submissions.get(Submission.person_key == person_key(clean))
        if same_person and (not existing or same_person.doc_id != existing.doc_id):
            msg = (f"A submission for {same_person['name']} already exists and was uploaded from a "
                   "different browser. If it is yours, use that browser to replace it, or ask an organiser to remove it.")
            return jsonify({"error": "Duplicate person.", "details": [msg]}), 409
        if existing:
            doc = {**existing, **clean, "person_key": person_key(clean), "submitted_at": now}
            submissions.update(doc, doc_ids=[existing.doc_id])
            created = False
        else:
            if len(submissions) >= MAX_SUBMISSIONS:
                return jsonify({"error": "The leaderboard is full.", "details": ["The leaderboard is full — contact an organiser."]}), 507
            doc = {"id": uuid.uuid4().hex[:12], "owner_hash": owner_hash, **clean,
                   "person_key": person_key(clean), "submitted_at": now}
            submissions.insert(doc)
            created = True
    return jsonify({"submission": public_row(doc, owner_hash), "created": created}), (201 if created else 200)


@app.get("/api/submissions/mine")
def get_my_submission():
    owner_hash = get_owner_hash()
    with db_lock():
        doc = submissions.get(Submission.owner_hash == owner_hash)
    return jsonify({"submission": public_row(doc, owner_hash) if doc else None})


@app.delete("/api/submissions/mine")
def delete_my_submission():
    owner_hash = get_owner_hash()
    with db_lock():
        removed = submissions.remove(Submission.owner_hash == owner_hash)
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
        response.headers.setdefault("Cache-Control", "public, max-age=86400")
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
