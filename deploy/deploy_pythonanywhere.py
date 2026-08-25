#!/usr/bin/env python3
"""
One-shot deployment of the leaderboard to a FREE PythonAnywhere account.

    python deploy/deploy_pythonanywhere.py

You need (one-time, ~2 minutes, no credit card):
  1. a free account at https://www.pythonanywhere.com/registration/register/beginner/
     (the username becomes the site address:  https://<username>.pythonanywhere.com)
  2. an API token: log in -> Account -> "API token" tab -> "Create a new API token"

The script asks for the username and token (or reads PA_USERNAME / PA_API_TOKEN from
the environment), then uploads the project, creates & configures the web app, writes
the WSGI file, maps /static/, reloads the site and checks that it answers.
Re-running it later re-uploads the code and reloads (the database is never touched).

Only the Python standard library is used, so it runs with any Python 3.8+.
"""

from __future__ import annotations

import argparse
import getpass
import json
import mimetypes
import os
import secrets
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOSTS = {"www": "https://www.pythonanywhere.com", "eu": "https://eu.pythonanywhere.com"}
PYTHON_VERSIONS = ("python313", "python312", "python311", "python310")
UPLOAD = [  # (directory or file relative to ROOT, recursive)
    "app.py", "submit_readme.md", "README.md", "requirements.txt", "seed_demo.py",
    "static", "examples", "vendor",
    "workshop/ASSIGNMENT.md",        # ONLY this file from workshop/, instructor notes must never ship
    "workshop/data/benchmark_a", "workshop/data/benchmark_b",
    # the answer keys: needed on the server to score, never served to anyone
    "workshop/data/_instructor/test_labels_a.tsv", "workshop/data/_instructor/test_labels_b.tsv",
]
SKIP_DIRS = {"__pycache__", ".git", "node_modules", "_instructor"}
# Editor and tool leftovers. An interrupted `sed -i` once left a half-written
# copy of app.js in static/, and the deployer served it publicly.
SKIP_FILE = re.compile(r"^(sed[A-Za-z0-9]{6}|\..*\.sw[a-z]|.*~|\.DS_Store|.*\.orig|.*\.rej|.*\.tmp|.*\.bak)$")


# ----------------------------------------------------------------------------
# tiny API client (urllib only)
# ----------------------------------------------------------------------------
def _throttle_delay(body: bytes, attempt: int) -> int:
    """PythonAnywhere answers 429 with {"detail": "... available in N seconds."}."""
    try:
        detail = json.loads(body.decode(errors="replace")).get("detail", "")
    except (ValueError, AttributeError):
        detail = ""
    m = re.search(r"(\d+)\s*second", detail)
    return min(int(m.group(1)) + 2 if m else 5 * (attempt + 1), 90)


class PA:
    def __init__(self, host: str, username: str, token: str, verbose: bool = True):
        self.base = HOSTS.get(host, host).rstrip("/")
        self.user = username
        self.token = token
        self.api = f"{self.base}/api/v0/user/{username}"
        self.verbose = verbose

    def _request(self, method: str, url: str, data: bytes | None = None, headers: dict | None = None,
                 _attempt: int = 0):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Authorization": f"Token {self.token}", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
                return resp.status, body
        except urllib.error.HTTPError as e:
            body = e.read()
            # PythonAnywhere throttles the API. Losing the last call means the
            # code is uploaded but the web app never reloads, which leaves new
            # static files running against old server code: wait and retry.
            if e.code == 429 and _attempt < 4:
                delay = _throttle_delay(body, _attempt)
                if self.verbose:
                    print(f"   throttled, retrying in {delay}s …")
                time.sleep(delay)
                return self._request(method, url, data, headers, _attempt + 1)
            return e.code, body
        except urllib.error.URLError as e:
            # A reload restarts the workers and can outlast the socket timeout.
            # Treat a timeout as "probably fine, verify below" rather than a
            # crash: exiting here skips the reload and leaves new static files
            # running against old server code.
            if isinstance(e.reason, TimeoutError) or isinstance(e, socket.timeout):
                if _attempt < 2:
                    print(f"   {url.rsplit('/', 2)[-2]} timed out, retrying …")
                    return self._request(method, url, data, headers, _attempt + 1)
                print(f"   WARNING: {url} timed out; the call may still have succeeded.")
                return 599, b'{"detail": "client timeout"}'
            sys.exit(f"Network error talking to {url}: {e.reason}")
        except TimeoutError:
            if _attempt < 2:
                print("   read timed out, retrying …")
                return self._request(method, url, data, headers, _attempt + 1)
            print(f"   WARNING: {url} timed out; the call may still have succeeded.")
            return 599, b'{"detail": "client timeout"}'

    def call(self, method: str, path: str, payload: dict | None = None, ok=(200, 201)):
        url = self.api + path
        data = urllib.parse.urlencode(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/x-www-form-urlencoded"} if payload is not None else {}
        status, body = self._request(method, url, data, headers)
        if status not in ok:
            raise RuntimeError(f"{method} {path} -> HTTP {status}: {body[:400].decode(errors='replace')}")
        try:
            return json.loads(body) if body else None
        except json.JSONDecodeError:
            return body

    def upload(self, remote_path: str, content: bytes):
        boundary = "----pa" + uuid.uuid4().hex
        ctype = mimetypes.guess_type(remote_path)[0] or "application/octet-stream"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"content\"; filename=\"{Path(remote_path).name}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
        status, resp = self._request("POST", f"{self.api}/files/path{remote_path}", body,
                                     {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        if status not in (200, 201):
            raise RuntimeError(f"upload {remote_path} -> HTTP {status}: {resp[:300].decode(errors='replace')}")
        return status

    def whoami_ok(self) -> bool:
        status, _ = self._request("GET", f"{self.api}/cpu/")
        return status == 200


# ----------------------------------------------------------------------------
def collect_files() -> list[tuple[Path, str]]:
    files = []
    for item in UPLOAD:
        p = ROOT / item
        if p.is_file():
            files.append((p, item))
        elif p.is_dir():
            for f in sorted(p.rglob("*")):
                if (f.is_file() and not (SKIP_DIRS & set(f.relative_to(ROOT).parts))
                        and f.suffix != ".pyc" and not SKIP_FILE.match(f.name)):
                    files.append((f, f.relative_to(ROOT).as_posix()))
    return files


def edit_password() -> str:
    """The /admin editor password. Kept out of the repository (it is public):
    deploy/.edit_password is git-ignored and is injected into the WSGI file."""
    f = ROOT / "deploy" / ".edit_password"
    try:
        return f.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def wsgi_source(project_dir: str, admin_key: str, edit_pw: str = "") -> str:
    return f'''# WSGI entry point for the Ostr-AI leaderboard (generated by deploy/deploy_pythonanywhere.py)
import os, sys
PROJECT = {project_dir!r}
if PROJECT not in sys.path:
    sys.path.insert(0, PROJECT)
os.environ.setdefault("LEADERBOARD_DB", PROJECT + "/data/leaderboard.json")
os.environ.setdefault("LEADERBOARD_ADMIN_KEY", {admin_key!r})
os.environ.setdefault("LEADERBOARD_EDIT_PASSWORD", {edit_pw!r})
from app import app as application  # noqa: E402
'''


def main() -> int:
    ap = argparse.ArgumentParser(description="Deploy the leaderboard to a free PythonAnywhere account.")
    ap.add_argument("--username", default=os.environ.get("PA_USERNAME"))
    ap.add_argument("--token", default=os.environ.get("PA_API_TOKEN"))
    ap.add_argument("--host", choices=["auto", "www", "eu"], default="auto",
                    help="www.pythonanywhere.com or eu.pythonanywhere.com (auto: detect)")
    ap.add_argument("--project-dir", default="summer_school_project", help="folder name under /home/<username>/")
    ap.add_argument("--admin-key", default=os.environ.get("LEADERBOARD_ADMIN_KEY"),
                    help="organiser key for DELETE /api/submissions/<id> (generated if omitted)")
    ap.add_argument("--api-base", help=argparse.SUPPRESS)      # testing: point at a mock API
    ap.add_argument("--site-url", help=argparse.SUPPRESS)      # testing: override the health-check URL
    ap.add_argument("--skip-health", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    username = args.username or input("PythonAnywhere username: ").strip()
    token_file = ROOT / "deploy" / ".pa_token"
    token = args.token or (token_file.read_text().strip() if token_file.exists() else "")
    if not token:
        try:
            token = getpass.getpass("PythonAnywhere API token (input hidden): ").strip()
        except (EOFError, OSError):
            sys.exit("No terminal for the token prompt. Save the token once with:\n"
                     f"  echo YOUR_TOKEN > {token_file}\nand re-run; it will be remembered.")
    if not username or not token:
        sys.exit("Username and API token are required.")

    # --- pick host --------------------------------------------------------------
    if args.api_base:
        HOSTS["custom"] = args.api_base
        hosts = ["custom"]
    else:
        hosts = ["www", "eu"] if args.host == "auto" else [args.host]
    pa = None
    for h in hosts:
        cand = PA(h, username, token)
        if cand.whoami_ok():
            pa = cand
            break
    if pa is None:
        sys.exit("Could not authenticate on www/eu.pythonanywhere.com — check the username and API token.")
    if not token_file.exists() or token_file.read_text().strip() != token:
        token_file.write_text(token + "\n")
        try:
            os.chmod(token_file, 0o600)
        except OSError:
            pass
    host_key = next(k for k, v in HOSTS.items() if v == pa.base)
    domain = f"{username}.pythonanywhere.com" if host_key != "eu" else f"{username}.eu.pythonanywhere.com"
    if args.api_base:
        domain = f"{username}.pythonanywhere.com"
    home = f"/home/{username}"
    project_dir = f"{home}/{args.project_dir}"
    print(f"✔ authenticated as {username} on {pa.base}")

    # --- admin key ----------------------------------------------------------------
    key_file = ROOT / "deploy" / ".admin_key"
    admin_key = args.admin_key or (key_file.read_text().strip() if key_file.exists() else "") or secrets.token_urlsafe(24)
    key_file.write_text(admin_key + "\n")
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        pass

    # --- upload project -------------------------------------------------------------
    files = collect_files()
    print(f"→ uploading {len(files)} files to {project_dir}/ …")
    for local, rel in files:
        pa.upload(f"{project_dir}/{rel}", local.read_bytes())
        if pa.verbose:
            print(f"   {rel}")
    pa.upload(f"{project_dir}/data/.keep", b"")  # make sure the data directory exists
    print("✔ files uploaded")

    # --- web app ---------------------------------------------------------------------
    apps = pa.call("GET", "/webapps/") or []
    existing = next((a for a in apps if a.get("domain_name") == domain), None)
    if existing:
        print(f"✔ web app {domain} already exists (python_version={existing.get('python_version')}) — updating it")
    else:
        created = None
        errors = []
        for ver in PYTHON_VERSIONS:
            try:
                pa.call("POST", "/webapps/", {"domain_name": domain, "python_version": ver})
                created = ver
                break
            except RuntimeError as e:
                errors.append(str(e))
        if not created:
            sys.exit("Could not create the web app:\n  " + "\n  ".join(errors))
        print(f"✔ created web app {domain} ({created})")

    pa.call("PATCH", f"/webapps/{domain}/", {"source_directory": project_dir, "force_https": "true"})
    print("✔ web app configured (source directory, HTTPS)")

    wsgi_path = f"/var/www/{domain.replace('.', '_')}_wsgi.py"
    pa.upload(wsgi_path, wsgi_source(project_dir, admin_key, edit_password()).encode())
    print(f"✔ WSGI file written: {wsgi_path}")

    mappings = pa.call("GET", f"/webapps/{domain}/static_files/") or []
    if not any(m.get("url") == "/static/" for m in mappings):
        pa.call("POST", f"/webapps/{domain}/static_files/", {"url": "/static/", "path": f"{project_dir}/static"})
        print("✔ static files mapping added (/static/)")
    else:
        print("✔ static files mapping already present")

    pa.call("POST", f"/webapps/{domain}/reload/", {}, ok=(200, 201, 204))
    print("✔ web app reloaded")

    # --- health check ---------------------------------------------------------------------
    site = args.site_url or f"https://{domain}"
    if not args.skip_health:
        print(f"→ checking {site}/api/submissions …")
        ok, last, data = False, None, {}
        for attempt in range(8):
            try:
                with urllib.request.urlopen(f"{site}/api/submissions", timeout=30) as r:
                    data = json.loads(r.read())
                    ok = "submissions" in data
                    if ok:
                        break
            except Exception as e:  # the app takes a few seconds to come up after a reload
                last = e
            time.sleep(5)
        if ok:
            print(f"✔ site is up: {data.get('count', 0)} submission(s) on the board")
        else:
            print(f"✗ the site did not answer yet ({last!r}). Open the Web tab on PythonAnywhere and check the error log.")

    print("\n====================================================================")
    print(f"  Leaderboard:      {site}")
    print(f"  Student guide:    {site}/guide")
    print(f"  Organiser key:    {admin_key}   (saved in deploy/.admin_key, git-ignored)")
    print(f"  Delete a row:     curl -X DELETE -H 'X-Admin-Key: {admin_key}' {site}/api/submissions/<id>")
    print("  Note: free PythonAnywhere sites switch off after 3 months unless you press")
    print("        'Run until 3 months from today' on the Web tab (it is one click, and it emails you).")
    print("====================================================================")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        sys.exit(f"ERROR: {e}")
    except KeyboardInterrupt:
        sys.exit(1)
