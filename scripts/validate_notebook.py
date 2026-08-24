#!/usr/bin/env python
"""Validate the instructor's reference notebook (haiku_minilm_baseline.ipynb)
without a GPU, without Colab, and without network access to the leaderboard.

Checks, each printed as a clear PASS/FAIL line:

  1. structure   - valid JSON, nbformat 4, has markdown + code cells, every
                    cell has its required keys, no stale outputs/exec counts.
  2. syntax      - every code cell compiles (Jupyter magics stripped first).
  3. discipline  - no API call / API key / LLM endpoint anywhere in the
                    notebook, and no em-dash character anywhere in the file.
  4. labels      - the embedded gzip+base64 blob(s) decode to exactly the two
                    Haiku label tables on disk (row counts, id sets, and every
                    category a real entry of the matching intents.txt).
  5. dry run     - the notebook's own pipeline code, executed on a small CPU
                    subset of the real data, produces a valid submission
                    table (columns, value ranges, one row per benchmark,
                    accuracy well above random).

nbformat is NOT assumed to be installed; the notebook is read as plain JSON.

Usage:
    python scripts/validate_notebook.py [path/to/notebook.ipynb]

Exit code is 0 iff every check passed.
"""
from __future__ import annotations

import ast
import base64
import gzip
import io
import json
import os
import re
import sys
import tempfile
import traceback
import zipfile
from pathlib import Path

# --------------------------------------------------------------------------
# Paths / constants
# --------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_NOTEBOOK = ROOT / "workshop/baseline/haiku_minilm_baseline.ipynb"
LABELS_DIR = ROOT / "workshop/baseline/labels"
DATA_DIR = ROOT / "workshop/data"

BANNED_KEYWORDS = ["anthropic", "openrouter", "api_key", "openai"]
EM_DASH = "—"

EXPECTED_ROWS = {"a": 2000, "b": 2999}

# random-baseline denominators = full taxonomy size, per the assignment data
N_CATEGORIES = {"a": 77, "b": 150}

SUBMISSION_COLUMNS = ["name", "benchmark", "metric", "latency_ms"]

DRY_RUN_TRAIN_N = 200   # rows per benchmark for the dry run's pool subset
                         # (kept under the notebook's encode batch size of
                         # 256 so training encodes in a single batch)
DRY_RUN_TEST_N = 60     # rows per benchmark for the dry run's test subset
                         # (kept small: the notebook's own latency measurement
                         # classifies these one message at a time, 3 passes,
                         # plus a fixed 100-message warmup -- on a contended
                         # shared CPU that is the slow part of the whole dry run)

_PASS = "PASS"
_FAIL = "FAIL"

_results: list[tuple[str, bool]] = []


def banner(title: str) -> None:
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


def report(name: str, ok: bool, detail: str = "") -> bool:
    _results.append((name, ok))
    tag = _PASS if ok else _FAIL
    line = f"[{tag}] {name}"
    if detail:
        line += f"\n       {detail}"
    print(line)
    return ok


# --------------------------------------------------------------------------
# Notebook loading helpers
# --------------------------------------------------------------------------


def cell_source(cell: dict) -> str:
    src = cell.get("source", "")
    if isinstance(src, list):
        return "".join(src)
    return src or ""


def code_cells(nb: dict) -> list[tuple[int, dict]]:
    return [(i, c) for i, c in enumerate(nb.get("cells", [])) if c.get("cell_type") == "code"]


def strip_magics(src: str) -> str:
    """Drop lines that are Jupyter magics/shell-escapes (leading ! or %)."""
    kept = []
    for line in src.splitlines():
        if line.lstrip().startswith("!") or line.lstrip().startswith("%"):
            continue
        kept.append(line)
    return "\n".join(kept)


def load_notebook(path: Path):
    """Returns (nb_dict_or_None, raw_text_or_None, error_message_or_None)."""
    if not path.exists():
        return None, None, f"notebook not found at {path}"
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        return None, None, f"could not read file as utf-8 text: {e}"
    try:
        nb = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, raw, f"invalid JSON: {e}"
    return nb, raw, None


# --------------------------------------------------------------------------
# Check 1: structure
# --------------------------------------------------------------------------


def check_structure(nb: dict) -> bool:
    banner("1. STRUCTURE")
    ok_all = True

    ok_all &= report("nbformat major version is 4", nb.get("nbformat") == 4,
                      f"nbformat={nb.get('nbformat')!r}")

    cells = nb.get("cells")
    if not isinstance(cells, list) or not cells:
        report("notebook has cells", False, "no 'cells' list found, or it is empty")
        return False
    report("notebook has cells", True, f"{len(cells)} cells")

    types_present = {c.get("cell_type") for c in cells}
    ok_all &= report("has at least one markdown cell", "markdown" in types_present,
                      f"cell types present: {sorted(t for t in types_present if t)}")
    ok_all &= report("has at least one code cell", "code" in types_present)

    key_problems = []
    stale_problems = []
    for i, c in enumerate(cells):
        ctype = c.get("cell_type")
        base_required = {"cell_type", "metadata", "source"}
        missing = base_required - set(c.keys())
        if missing:
            key_problems.append(f"cell {i} ({ctype}): missing key(s) {sorted(missing)}")
            continue
        if ctype == "code":
            code_required = {"outputs", "execution_count"}
            missing = code_required - set(c.keys())
            if missing:
                key_problems.append(f"cell {i} (code): missing key(s) {sorted(missing)}")
                continue
            outputs = c.get("outputs")
            exec_count = c.get("execution_count")
            if outputs not in ([], None) and outputs != []:
                stale_problems.append(f"cell {i}: outputs is not empty ({len(outputs)} output item(s))")
            if exec_count is not None:
                stale_problems.append(f"cell {i}: execution_count is {exec_count!r}, expected null")

    ok_all &= report("every cell has its required keys", not key_problems,
                      "\n       ".join(key_problems) if key_problems else "")
    ok_all &= report("no stale outputs / execution counts", not stale_problems,
                      "\n       ".join(stale_problems) if stale_problems else "")

    return ok_all


# --------------------------------------------------------------------------
# Check 2: syntax
# --------------------------------------------------------------------------


def check_syntax(nb: dict) -> bool:
    banner("2. SYNTAX")
    problems = []
    n_checked = 0
    n_magic_only = 0
    for i, cell in code_cells(nb):
        src = cell_source(cell)
        stripped = strip_magics(src)
        if not stripped.strip():
            n_magic_only += 1
            continue
        n_checked += 1
        try:
            ast.parse(stripped)
        except SyntaxError as e:
            problems.append(f"cell {i}: {e.__class__.__name__}: {e.msg} (line {e.lineno})")

    detail = f"{n_checked} cell(s) parsed, {n_magic_only} magic-only cell(s) skipped"
    ok = report("every code cell compiles (magics stripped)", not problems, detail)
    if problems:
        report("syntax errors found", False, "\n       ".join(problems))
        ok = False
    return ok


# --------------------------------------------------------------------------
# Check 3: discipline
# --------------------------------------------------------------------------


def check_discipline(nb: dict) -> bool:
    banner("3. DISCIPLINE (no API calls/keys, no em-dash)")
    ok_all = True

    keyword_hits = []
    postcall_hits = []
    emdash_hits = []

    for i, cell in enumerate(nb.get("cells", [])):
        src = cell_source(cell)
        low = src.lower()
        for kw in BANNED_KEYWORDS:
            if kw in low:
                keyword_hits.append(f"cell {i} ({cell.get('cell_type')}): contains {kw!r}")
        if "requests.post" in low or re.search(r"requests\s*\.\s*post", src):
            postcall_hits.append(f"cell {i} ({cell.get('cell_type')}): contains requests.post(...)")
        if EM_DASH in src:
            n = src.count(EM_DASH)
            emdash_hits.append(f"cell {i} ({cell.get('cell_type')}): {n} em-dash char(s)")

    ok_all &= report("no LLM/API keyword (anthropic/openrouter/api_key/openai)",
                      not keyword_hits, "\n       ".join(keyword_hits))
    ok_all &= report("no requests.post(...) call anywhere",
                      not postcall_hits, "\n       ".join(postcall_hits))
    ok_all &= report("no em-dash character anywhere in the notebook",
                      not emdash_hits, "\n       ".join(emdash_hits))

    return ok_all


# --------------------------------------------------------------------------
# Check 4: embedded labels
# --------------------------------------------------------------------------


_BASE64_RUN = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")
_STRING_LITERAL = re.compile(
    r'("""(?:.*?)"""|\'\'\'(?:.*?)\'\'\'|"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\')',
    re.DOTALL,
)


def _literal_text(m: "re.Match") -> str:
    lit = m.group(1)
    inner = lit[3:-3] if lit[:3] in ('"""', "'''") else lit[1:-1]
    return re.sub(r"\s+", "", inner)


def _is_pure_base64_charset(s: str) -> bool:
    return bool(s) and bool(re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", s))


def _candidate_blobs(nb: dict) -> list[str]:
    """Collect plausible base64 blob strings from every code cell.

    A blob may be a single (possibly triple-quoted, multi-line) string
    literal, or it may be split across several adjacent literals the way
    Python implicitly concatenates them, e.g.::

        BLOB = (
            "AAAA..."
            "BBBB..."
            "=="
        )

    Adjacency is judged the way Python's own parser does: only whitespace
    (no other code) may separate two literals for them to be one string.
    """
    seen: set[str] = set()
    candidates: list[str] = []

    for _i, cell in code_cells(nb):
        src = cell_source(cell)
        matches = list(_STRING_LITERAL.finditer(src))

        # single literals (handles multi-line triple-quoted blobs on their own)
        for m in matches:
            compact = _literal_text(m)
            if len(compact) >= 200 and _is_pure_base64_charset(compact):
                if compact not in seen:
                    seen.add(compact)
                    candidates.append(compact)

        # fallback: raw base64-charset runs directly in source (unquoted
        # context, e.g. inside an f-string or a non-standard literal form)
        for m in _BASE64_RUN.finditer(src):
            compact = m.group(0)
            if compact not in seen:
                seen.add(compact)
                candidates.append(compact)

        # runs of literals adjacent in source (only whitespace between them,
        # exactly like Python's own implicit string concatenation), all pure
        # base64 charset, joined in order -- this is what catches a blob
        # wrapped across many short lines including a short final remainder
        group: list["re.Match"] = []
        prev_end = None

        def _flush(group):
            if len(group) < 2:
                return
            parts = [_literal_text(m) for m in group]
            if not all(_is_pure_base64_charset(p) for p in parts if p):
                return
            joined = "".join(parts)
            if len(joined) >= 200 and joined not in seen:
                seen.add(joined)
                candidates.append(joined)

        for m in matches:
            if prev_end is not None and src[prev_end:m.start()].strip() == "":
                group.append(m)
            else:
                _flush(group)
                group = [m]
            prev_end = m.end()
        _flush(group)

    return candidates


def _try_gunzip_b64(blob: str) -> str | None:
    try:
        raw = base64.b64decode(blob, validate=True)
    except Exception:
        return None
    try:
        return gzip.decompress(raw).decode("utf-8")
    except Exception:
        return None


# The intent is whatever follows the tab up to end of line -- almost always
# [A-Za-z0-9_], but BANKING77 ships one category literally named
# "reverted_card_payment?", so the charset must not be tighter than that.
_ROW_RE = re.compile(r"^[ \t]*(\d+)\t([^\t\r\n]+?)[ \t]*\r?$", re.MULTILINE)


def _extract_rows(text: str) -> list[tuple[int, str]]:
    """Pull (id, intent) rows out of arbitrary decoded text: plain TSV, TSV
    nested inside a JSON string value, or a JSON {id: intent} mapping."""
    rows: list[tuple[int, str]] = []

    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            obj = json.loads(stripped)
        except Exception:
            obj = None
        if isinstance(obj, dict):
            # case A: values are id-like keys -> intent strings directly
            if all(re.fullmatch(r"\d+", str(k)) for k in obj if str(k)) and obj and all(
                isinstance(v, str) for v in obj.values()
            ):
                for k, v in obj.items():
                    if re.fullmatch(r"\d+", str(k)) and v and not re.search(r"[\t\r\n]", v):
                        rows.append((int(k), v))
                return rows
            # case B: values are nested TSV-text blobs (e.g. {"a": "...", "b": "..."})
            for v in obj.values():
                if isinstance(v, str):
                    rows.extend(_extract_rows(v))
            if rows:
                return rows
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, dict) and "id" in item and "intent" in item:
                    try:
                        rows.append((int(item["id"]), str(item["intent"])))
                    except (TypeError, ValueError):
                        pass
            if rows:
                return rows

    # plain TSV / line-oriented fallback: "<id>\t<intent>", header line ignored
    for m in _ROW_RE.finditer(text):
        rows.append((int(m.group(1)), m.group(2)))
    return rows


def _load_source_labels():
    import pandas as pd

    tables = {}
    for bench in ("a", "b"):
        path = LABELS_DIR / f"pool_labels_haiku_{bench}.tsv"
        df = pd.read_csv(path, sep="\t")
        tables[bench] = dict(zip(df["id"].astype(int), df["intent"].astype(str)))
    return tables


def _load_intents():
    intents = {}
    for bench in ("a", "b"):
        path = DATA_DIR / f"benchmark_{bench}/intents.txt"
        names = [l for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
        intents[bench] = set(names)
    return intents


def check_labels(nb: dict) -> tuple[bool, dict]:
    """Returns (ok, decoded_tables) where decoded_tables maps 'a'/'b' -> {id: intent}."""
    banner("4. EMBEDDED LABELS")

    try:
        source = _load_source_labels()
    except Exception as e:  # noqa: BLE001
        report("source label files readable", False, str(e))
        return False, {}
    intents = _load_intents()

    candidates = _candidate_blobs(nb)
    report("base64 candidate string(s) found in code cells", bool(candidates),
           f"{len(candidates)} candidate(s)")
    if not candidates:
        report("at least one candidate decodes as gzip+base64", False)
        return False, {}

    decoded_rows: list[tuple[int, str]] = []
    n_decoded = 0
    for blob in candidates:
        text = _try_gunzip_b64(blob)
        if text is None:
            continue
        n_decoded += 1
        decoded_rows.extend(_extract_rows(text))

    ok_decode = report("at least one candidate decodes as gzip+base64", n_decoded > 0,
                        f"{n_decoded}/{len(candidates)} candidate(s) decoded successfully")
    if not ok_decode:
        return False, {}

    # bucket decoded rows into benchmark a / b by which intents.txt the
    # category name belongs to. The vocabularies are almost entirely
    # disjoint, but not perfectly (e.g. "exchange_rate" is a real category in
    # both taxonomies) -- for a category name that is valid in both, fall
    # back to which source file already records that exact (id, intent)
    # pair, since that is unambiguous.
    bucketed: dict[str, dict[int, str]] = {"a": {}, "b": {}}
    ambiguous = []
    unknown = []
    for id_, intent in decoded_rows:
        in_a = intent in intents["a"]
        in_b = intent in intents["b"]
        if in_a and not in_b:
            bucketed["a"][id_] = intent
        elif in_b and not in_a:
            bucketed["b"][id_] = intent
        elif in_a and in_b:
            matches_a = source["a"].get(id_) == intent
            matches_b = source["b"].get(id_) == intent
            if matches_a and not matches_b:
                bucketed["a"][id_] = intent
            elif matches_b and not matches_a:
                bucketed["b"][id_] = intent
            else:
                ambiguous.append((id_, intent))
        else:
            unknown.append((id_, intent))

    ok_all = ok_decode
    for bench in ("a", "b"):
        got = bucketed[bench]
        want = source[bench]
        n_expected = EXPECTED_ROWS[bench]

        row_count_ok = len(got) == n_expected
        report(f"benchmark {bench.upper()}: row count == {n_expected}", row_count_ok,
               f"decoded {len(got)} row(s)")

        id_set_ok = set(got.keys()) == set(want.keys())
        if not id_set_ok:
            missing = set(want.keys()) - set(got.keys())
            extra = set(got.keys()) - set(want.keys())
            detail = f"missing {len(missing)} id(s), {len(extra)} unexpected id(s)"
            if missing:
                detail += f"; e.g. missing {sorted(missing)[:5]}"
            if extra:
                detail += f"; e.g. extra {sorted(extra)[:5]}"
        else:
            detail = ""
        report(f"benchmark {bench.upper()}: id set identical to source file", id_set_ok, detail)

        bad_categories = sorted({v for v in got.values() if v not in intents[bench]})
        cat_ok = not bad_categories
        report(f"benchmark {bench.upper()}: every category present in intents.txt", cat_ok,
               f"invalid categories: {bad_categories[:5]}" if bad_categories else "")

        exact_ok = got == want
        report(f"benchmark {bench.upper()}: decoded table reproduces source exactly", exact_ok,
               "" if exact_ok else "id->intent mapping differs from the source file")

        ok_all &= row_count_ok & id_set_ok & cat_ok & exact_ok

    if ambiguous:
        report("no ambiguous rows (category valid in both taxonomies)", False,
               f"{len(ambiguous)} row(s), e.g. {ambiguous[:3]}")
        ok_all = False
    if unknown:
        report("no rows with an unrecognised category", False,
               f"{len(unknown)} row(s), e.g. {unknown[:3]}")
        ok_all = False

    return ok_all, bucketed


# --------------------------------------------------------------------------
# Check 5: end-to-end CPU dry run of the notebook's own pipeline code
# --------------------------------------------------------------------------


def _empty_zip_bytes() -> bytes:
    """A minimal, valid, empty zip archive: extracting it is a safe no-op,
    so it never clobbers the small data files staged ahead of the run."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w"):
        pass
    return buf.getvalue()


def _stage_small_data(tmp_dir: Path, label_ids: dict[str, set]) -> None:
    """Write small pool.tsv/test.tsv/intents.txt subsets under tmp_dir/benchmark_a
    and tmp_dir/benchmark_b, using genuine text from the real data files."""
    import pandas as pd

    for bench in ("a", "b"):
        src_dir = DATA_DIR / f"benchmark_{bench}"
        dst_dir = tmp_dir / f"benchmark_{bench}"
        dst_dir.mkdir(parents=True, exist_ok=True)

        pool = pd.read_csv(src_dir / "pool.tsv", sep="\t")
        ids_with_labels = label_ids.get(bench) or set()
        wanted_ids = sorted(ids_with_labels)[:DRY_RUN_TRAIN_N]
        pool_sub = pool[pool["id"].isin(wanted_ids)]
        if pool_sub.empty:
            # fall back to an arbitrary slice so the dry run can still exercise
            # the code path, even though the join will then yield ~0 rows
            pool_sub = pool.head(DRY_RUN_TRAIN_N)
        pool_sub.to_csv(dst_dir / "pool.tsv", sep="\t", index=False)

        test = pd.read_csv(src_dir / "test.tsv", sep="\t")
        test.head(DRY_RUN_TEST_N).to_csv(dst_dir / "test.tsv", sep="\t", index=False)

        (dst_dir / "intents.txt").write_text((src_dir / "intents.txt").read_text(encoding="utf-8"),
                                               encoding="utf-8")


def _install_cpu_patches(namespace: dict, tmp_dir: Path) -> list[str]:
    """Monkeypatch network/GPU-dependent calls inside `namespace` so the
    notebook's own code can run offline, on CPU, against the staged small
    data files. Returns a list of human-readable notes about what was
    patched."""
    # huggingface_hub / transformers read these into module-level constants
    # at import time, so they must be set *before* the first import of
    # sentence_transformers (directly or transitively) anywhere in this
    # process, or "offline" silently has no effect.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    import pandas as pd
    import torch
    import sentence_transformers as st

    notes = ["HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 (use local encoder cache only)"]

    # --- pandas.read_csv: redirect known benchmark filenames to the staged
    #     small subsets, regardless of the directory prefix the notebook uses.
    real_read_csv = pd.read_csv

    def patched_read_csv(filepath_or_buffer, *a, **kw):
        try:
            p = str(filepath_or_buffer)
        except Exception:
            p = ""
        name = os.path.basename(p)
        bench = None
        if "_a" in p or "benchmark_a" in p or p.rstrip("/").endswith("/a"):
            bench = "a"
        elif "_b" in p or "benchmark_b" in p or p.rstrip("/").endswith("/b"):
            bench = "b"
        if bench and name in ("pool.tsv", "test.tsv"):
            redirected = tmp_dir / f"benchmark_{bench}" / name
            if redirected.exists():
                return real_read_csv(redirected, *a, **kw)
        return real_read_csv(filepath_or_buffer, *a, **kw)

    pd.read_csv = patched_read_csv
    notes.append("pandas.read_csv redirected to staged small data files")

    # --- SentenceTransformer: force CPU regardless of what device is requested
    RealST = st.SentenceTransformer

    class ForcedCPUSentenceTransformer(RealST):  # type: ignore[misc]
        def __init__(self, *a, **kw):
            kw["device"] = "cpu"
            super().__init__(*a, **kw)

        def encode(self, *a, **kw):
            kw.pop("device", None)
            return super().encode(*a, **kw)

    st.SentenceTransformer = ForcedCPUSentenceTransformer
    namespace["SentenceTransformer"] = ForcedCPUSentenceTransformer
    notes.append("SentenceTransformer forced to device='cpu'")

    # --- torch.nn.Module.to: strip any 'cuda' target so a hard-coded
    #     .to('cuda') on this GPU-less node degrades to a no-op instead of
    #     raising.
    real_to = torch.nn.Module.to

    def patched_to(self, *a, **kw):
        a2 = tuple("cpu" if isinstance(x, str) and "cuda" in x else x for x in a)
        if "device" in kw and isinstance(kw["device"], str) and "cuda" in kw["device"]:
            kw = dict(kw)
            kw["device"] = "cpu"
        return real_to(self, *a2, **kw)

    torch.nn.Module.to = patched_to
    notes.append("torch.nn.Module.to forced to cpu for any cuda target")

    # --- network: the notebook's data-download step must not touch the
    #     network during a dry run, and must not overwrite the small staged
    #     files with the real, full-size ones. Rather than guessing which
    #     cell does the downloading (and risking deleting a helper function
    #     defined in the same cell), make the download itself harmless: any
    #     "fetch the zip" call gets a valid but EMPTY zip archive, so
    #     extracting it is a no-op and the staged files underneath survive.
    import urllib.request

    empty_zip = _empty_zip_bytes()

    class _FakeHTTPResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, *a, **kw):
            return super().read(*a, **kw)

    def fake_urlopen(*_a, **_kw):
        return _FakeHTTPResponse(empty_zip)

    urllib.request.urlopen = fake_urlopen
    namespace["urlopen"] = fake_urlopen
    notes.append("urllib.request.urlopen faked (returns an empty zip, no network)")

    try:
        import requests

        class _FakeHTTPGetResponse:
            status_code = 200
            content = empty_zip

            def raise_for_status(self):
                return None

            def iter_content(self, *a, **kw):
                yield empty_zip

        real_requests_get = requests.get

        def fake_requests_get(url, *a, **kw):
            if isinstance(url, str) and url.rstrip().lower().endswith(".zip"):
                return _FakeHTTPGetResponse()
            return real_requests_get(url, *a, **kw)

        requests.get = fake_requests_get
        notes.append("requests.get faked for .zip URLs (returns an empty zip, no network)")
    except ImportError:
        pass

    return notes


def check_dry_run(nb: dict, labels_ok: bool, decoded_tables: dict) -> bool:
    banner("5. END-TO-END CPU DRY RUN")

    if not decoded_tables or not (decoded_tables.get("a") or decoded_tables.get("b")):
        report("dry run executed", False,
               "skipped: no decodable embedded label blob (see check 4)")
        return False

    label_ids = {b: set(decoded_tables.get(b, {}).keys()) for b in ("a", "b")}

    with tempfile.TemporaryDirectory(prefix="validate_notebook_") as tmp:
        tmp_dir = Path(tmp)
        try:
            _stage_small_data(tmp_dir, label_ids)
        except Exception as e:  # noqa: BLE001
            report("staged small CPU-sized data subset", False,
                   f"{e.__class__.__name__}: {e}")
            return False
        report("staged small CPU-sized data subset", True,
               f"{DRY_RUN_TRAIN_N} pool rows + {DRY_RUN_TEST_N} test rows per benchmark, "
               f"under {tmp_dir}")

        namespace: dict = {"__name__": "__validate_dry_run__"}
        notes = _install_cpu_patches(namespace, tmp_dir)
        for n in notes:
            print(f"       (patched) {n}")

        prev_cwd = os.getcwd()
        os.chdir(tmp_dir)
        cell_errors = []
        n_run = 0
        n_empty = 0
        try:
            for i, cell in code_cells(nb):
                src = cell_source(cell)
                stripped = strip_magics(src)
                if not stripped.strip():
                    n_empty += 1
                    continue
                n_run += 1
                try:
                    exec(compile(stripped, f"<notebook cell {i}>", "exec"), namespace)  # noqa: S102
                except Exception as e:  # noqa: BLE001
                    cell_errors.append((i, "".join(traceback.format_exception_only(type(e), e)).strip()))
        finally:
            os.chdir(prev_cwd)

        report("code cells executed", True,
               f"{n_run} cell(s) executed, {n_empty} magic-only cell(s) skipped "
               f"(network calls faked, see patch notes above)")
        if cell_errors:
            detail = "\n       ".join(f"cell {i}: {msg}" for i, msg in cell_errors)
            report("all executed cells raised no exception", False, detail)
        else:
            report("all executed cells raised no exception", True)

        # regardless of per-cell errors above, check for the artifacts the
        # pipeline is supposed to produce -- an error in a late cell (e.g. an
        # unguarded Colab download) should not by itself hide a working
        # pipeline that already wrote its submission files.
        csv_path = tmp_dir / "submission.csv"
        json_path = tmp_dir / "submission.json"

        found_csv = csv_path.exists()
        found_json = json_path.exists()
        ok_files = report("submission.csv and submission.json were written",
                           found_csv and found_json,
                           f"csv found: {found_csv}, json found: {found_json}")
        if not ok_files:
            return False

        import pandas as pd

        try:
            df_csv = pd.read_csv(csv_path)
            with open(json_path, encoding="utf-8") as f:
                obj_json = json.load(f)
            df_json = pd.DataFrame(obj_json)
        except Exception as e:  # noqa: BLE001
            report("submission files parse", False, f"{e.__class__.__name__}: {e}")
            return False

        ok_all = True
        for label, df in (("submission.csv", df_csv), ("submission.json", df_json)):
            cols_ok = list(df.columns) == SUBMISSION_COLUMNS
            ok_all &= report(f"{label}: columns == {SUBMISSION_COLUMNS}", cols_ok,
                              f"got {list(df.columns)}")
            if not cols_ok:
                continue

            benches_ok = sorted(df["benchmark"].astype(str).str.upper().tolist()) == ["A", "B"]
            ok_all &= report(f"{label}: exactly one row per benchmark (A and B)", benches_ok,
                              f"got benchmark values {df['benchmark'].tolist()}")

            metric_ok = df["metric"].between(0, 1).all()
            ok_all &= report(f"{label}: metric in [0, 1]", bool(metric_ok),
                              f"got {df['metric'].tolist()}")

            latency_ok = (df["latency_ms"] > 0).all()
            ok_all &= report(f"{label}: latency_ms > 0", bool(latency_ok),
                              f"got {df['latency_ms'].tolist()}")

            if benches_ok:
                for _, row in df.iterrows():
                    bench = str(row["benchmark"]).lower()
                    random_baseline = 1.0 / N_CATEGORIES.get(bench, 1)
                    threshold = random_baseline * 5  # "clearly better than random"
                    above_random = row["metric"] > threshold
                    ok_all &= report(
                        f"{label}: benchmark {row['benchmark']} accuracy well above random "
                        f"(> {threshold:.4f}, i.e. 5x 1/{N_CATEGORIES.get(bench, '?')})",
                        bool(above_random),
                        f"got metric={row['metric']:.4f}, latency_ms={row['latency_ms']:.3f}",
                    )

        return ok_all


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:  # noqa: BLE001 -- best effort; harmless if unsupported
        pass

    nb_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_NOTEBOOK

    banner(f"VALIDATING: {nb_path}")

    nb, raw, err = load_notebook(nb_path)

    if nb is None:
        # Structure check (JSON validity) already failed; still emit a clear
        # PASS/FAIL line for every numbered check instead of crashing.
        report("1. structure: file is valid JSON / notebook loads", False, err)
        for name in (
            "2. syntax",
            "3. discipline",
            "4. embedded labels",
            "5. end-to-end dry run",
        ):
            report(f"{name} (skipped)", False, "notebook could not be loaded")
        return _finish()

    structure_ok = check_structure(nb)
    syntax_ok = check_syntax(nb)
    discipline_ok = check_discipline(nb)
    labels_ok, decoded_tables = check_labels(nb)
    dryrun_ok = check_dry_run(nb, labels_ok, decoded_tables)

    return _finish()


def _finish() -> int:
    banner("SUMMARY")
    n_pass = sum(1 for _, ok in _results if ok)
    n_total = len(_results)
    for name, ok in _results:
        print(f"  [{_PASS if ok else _FAIL}] {name}")
    print(f"\n{n_pass}/{n_total} checks passed")
    all_ok = n_pass == n_total
    print("\nOVERALL: " + (_PASS if all_ok else _FAIL))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
