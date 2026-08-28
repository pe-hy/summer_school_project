/* Ostr-AI 2026 leaderboard — front-end logic (no dependencies).
 *
 * Two benchmark ladders (A, B) + an overall standing. Rows come from
 * /api/submissions, already scored by the server against the answer key.
 * Identity = random owner token in localStorage; the server marks rows owned by
 * this browser with `mine: true` (one row per benchmark).
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    REFRESH_MS: 10000,
    MAX_NAME_LEN: 80,
    MAX_TIME_MS: 1e7,         // mirrors app.py MAX_TIME_MS
    // mirrors app.py MAX_CONTENT_LENGTH: the worst real file is 0.87 MB
    MAX_FILE_BYTES: 2 * 1024 * 1024,
    TEST_ROWS: { A: 3080, B: 4500 },
    LATENCY_FLOOR_MS: 0.01,   // clamp for the log axis only
  };
  const BENCHMARKS = [
    { key: "A", label: "Benchmark A", sub: "77 categories · one topic area", dotClass: "" },
    { key: "B", label: "Benchmark B", sub: "150 categories · ten topic areas", dotClass: "bench-b" },
  ];
  const BENCH_KEYS = BENCHMARKS.map((b) => b.key);

  const TIME_FIELD = "average_time_per_example";

  const TOKEN_KEY = "ostrai_owner_token";
  const COOKIE_KEY = "ostrai_owner";   // server-set mirror of TOKEN_KEY; see getOwnerToken()
  const VIEW_KEY = "ostrai_overall_view";

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    statCount: $("#stat-count"),
    statA: $("#stat-a"),
    statB: $("#stat-b"),
    statUpdated: $("#stat-updated"),
    myStatus: $("#my-status"),
    tabs: { A: $("#tab-a"), B: $("#tab-b") },
    tabCounts: { A: $("#tab-count-a"), B: $("#tab-count-b") },
    overallTable: $("#table-overall"),
    overallBody: $("#table-overall-body"),
    overallSub: $("#overall .section-sub"),
    overallCard: $("#overall .table-card"),
    overallFootnote: $("#overall .table-footnote"),
    btnOpenUpload: $("#btn-open-upload"),
    uploadDialog: $("#upload-dialog"),
    uploadTitle: $("#upload-title"),
    btnCloseUpload: $("#btn-close-upload"),
    btnCancelUpload: $("#btn-cancel-upload"),
    btnSubmitUpload: $("#btn-submit-upload"),
    fileInput: $("#file-input"),
    dropzone: $("#dropzone"),
    dropzoneFile: $("#dropzone-file"),
    validationBox: $("#validation-box"),
    warnBox: $("#warn-box"),

    previewBox: $("#preview-box"),
    previewEntries: $("#preview-entries"),
    dialogNote: $("#dialog-note"),
    deleteDialog: $("#delete-dialog"),
    deleteTitle: $("#delete-title"),
    deleteHint: $("#delete-hint"),
    btnCancelDelete: $("#btn-cancel-delete"),
    btnConfirmDelete: $("#btn-confirm-delete"),
    toast: $("#toast"),
  };

  // The live wording, read from the markup so switching back restores it exactly.
  const LIVE_SUB = el.overallSub.textContent;
  const LIVE_FOOTNOTE = el.overallFootnote.textContent;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    rows: [],                       // all rows from the server
    ladders: { A: [], B: [] },      // ranked rows per benchmark
    overall: [],                    // ranked overall standings
    final: null,                    // published final standings, null until /api/final answers 200
    overallView: null,              // "final" | "live" once the reader (or storage) has picked
    mine: { A: null, B: null },     // this browser's row per benchmark
    labeled: new Set(),             // person_keys whose names show on BOTH plots
    seededSelf: false,
    refreshSeq: 0,
    loaded: false,                  // has a board response ever arrived?
    pollAfter: 0,                   // ms timestamp the poll may resume at, after a 429
    fileSeq: 0,
    submitting: false,
    pending: null,                  // validated entries waiting for submit
    pendingFile: null,              // {name, text} of the parsed file
    statusKey: null,
    views: {},                      // per-table sort state + caches, filled below
  };
  for (const key of ["overall", "A", "B"]) {
    state.views[key] = { sortKey: "rank", sortDir: "asc", lastTableKey: null };
  }
  const ladders = {};               // per-benchmark DOM refs, filled by initLadders()
  const plots = {};                 // per-benchmark plot state {host, empty, tip, index, lastKey}

  // ---------------------------------------------------------------------------
  // Identity (owner token in localStorage, mirrored by a server-set cookie)
  //
  // Safari's tracking prevention deletes script-writable storage, localStorage
  // included, after 7 days without a visit, which would orphan the student's
  // submission. The server mirrors the token into the COOKIE_KEY cookie via a
  // Set-Cookie header, which is not subject to that cap, so an empty
  // localStorage is recovered from the cookie instead of minting a new
  // identity. The cookie is never written from here: a cookie set by script
  // would be capped at 7 days again, defeating the point.
  // ---------------------------------------------------------------------------
  function randomToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const TOKEN_OK = (t) => typeof t === "string" && /^[A-Za-z0-9-]{16,64}$/.test(t);

  // document.cookie is "a=1; b=2": split on ";", then on the FIRST "=" only
  // (values may contain "="), and compare the trimmed name so that neither
  // `not_ostrai_owner` nor `ostrai_owner_x` can pass for the real thing.
  // Anything that is not a well-formed token is ignored, never sent onward.
  function cookieToken() {
    let raw;
    try { raw = document.cookie; } catch (_) { return null; }
    if (typeof raw !== "string") return null;
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== COOKIE_KEY) continue;
      const value = part.slice(eq + 1).trim();
      if (TOKEN_OK(value)) return value;
    }
    return null;
  }

  let storageOk = true;
  function getOwnerToken() {
    let token = null;
    try { token = localStorage.getItem(TOKEN_KEY); } catch (_) { storageOk = false; }
    if (TOKEN_OK(token)) return token;
    token = cookieToken() || randomToken();
    try {
      localStorage.setItem(TOKEN_KEY, token);
      storageOk = localStorage.getItem(TOKEN_KEY) === token;
    } catch (_) { storageOk = false; }
    return token;
  }
  const OWNER_TOKEN = getOwnerToken();

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          "X-Owner-Token": OWNER_TOKEN,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      const err = new Error("Could not reach the server. Check your connection and try again.");
      err.status = 0;
      throw err;
    }
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch (_) { data = null; }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.details = (data && Array.isArray(data.details)) ? data.details : null;
      // Only the server knows how long its window has left. Guarded because a
      // Response without headers is a thing test doubles have.
      const retry = res.headers && res.headers.get ? parseInt(res.headers.get("Retry-After"), 10) : NaN;
      err.retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Parsing: JSON  ->  1-2 entries with the canonical keys
  // ---------------------------------------------------------------------------
  const stripBOM = (s) => s.replace(/^\uFEFF/, "");
  const normalizeHeader = (h) => stripBOM(String(h)).toLowerCase().replace(/[^a-z0-9]/g, "");
  const CANONICAL_BY_NORMALIZED = {
    name: "name", yourname: "name", student: "name", team: "name",
    benchmark: "benchmark", bench: "benchmark", project: "benchmark", task: "benchmark",
    averagetimeperexample: TIME_FIELD, avgtimeperexample: TIME_FIELD, averagetime: TIME_FIELD,
    latencyms: TIME_FIELD, latency: TIME_FIELD, msperexample: TIME_FIELD, timeperexample: TIME_FIELD,
    id: "id", messageid: "id", exampleid: "id", testid: "id",
    intent: "intent", label: "intent", category: "intent", prediction: "intent", predictedintent: "intent",
  };
  const OLD_SCHEMA = new Set(["metric", "accuracy", "acc", "avgtimes"]);
  const OLD_SCHEMA_MSG = "This looks like the old results format. The site now takes one entry per benchmark, each with name, benchmark, average_time_per_example and a predictions list of {id, intent}.";

  function normalizeBenchmark(v) {   // mirrors app.py normalize_benchmark
    if (typeof v !== "string") return null;
    const key = v.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const b of BENCH_KEYS) {
      const low = b.toLowerCase();
      if ([low, `benchmark${low}`, `bench${low}`, `project${low}`].includes(key)) return b;
    }
    return null;
  }

  function rowsFromJSON(text) {
    let data;
    try { data = JSON.parse(stripBOM(text)); }
    catch (e) { return { errors: [`Invalid JSON: ${e.message}`] }; }
    if (!Array.isArray(data)) data = [data];
    if (!data.length) return { errors: ["The file is empty."] };

    const canon = (item) => {
      const obj = {};
      let sawOld = false;
      for (const [k, v] of Object.entries(item)) {
        const norm = normalizeHeader(k);
        if (norm === "predictions") { obj.predictions = v; continue; }
        const key = CANONICAL_BY_NORMALIZED[norm];
        if (!key) { if (OLD_SCHEMA.has(norm)) sawOld = true; continue; }
        // The canonical spelling always wins; a synonym only fills an empty slot.
        // Otherwise {"intent": x, "label": y} would silently submit y, and which
        // one won would depend on the order of the keys in the file.
        if (obj[key] !== undefined && norm !== normalizeHeader(key)) continue;
        obj[key] = typeof v === "string" ? v.trim() : v;
      }
      return { obj, sawOld };
    };

    const out = [];
    const entryBenches = new Set();
    for (const item of data) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { errors: ["Every entry must be an object."] };
      }
      const { obj, sawOld } = canon(item);
      if (Array.isArray(obj.predictions)) {
        // nested shape: one object per benchmark, carrying its own prediction list
        const entryBench = normalizeBenchmark(String(obj.benchmark ?? ""));
        if (entryBench) {
          if (entryBenches.has(entryBench)) {
            return { errors: ["Both results are for the same benchmark. One must be A and one B."] };
          }
          entryBenches.add(entryBench);
        }
        for (const p of obj.predictions) {
          if (p === null || typeof p !== "object" || Array.isArray(p)) {
            return { errors: ["Every prediction must be an object with id and intent."] };
          }
          const { obj: inner } = canon(p);
          out.push({ ...obj, ...inner, predictions: undefined });
        }
      } else {
        if (sawOld && obj.id === undefined) return { errors: [OLD_SCHEMA_MSG] };
        // Neither a nested entry nor a flat prediction row: most often the
        // "predictions" key is misspelled, or it holds an object instead of a list.
        if (obj.id === undefined && obj.benchmark !== undefined) {
          return { errors: ['Each entry needs a "predictions" list, like [{"id": 1, "intent": "card_arrival"}].'] };
        }
        const flatBench = normalizeBenchmark(String(obj.benchmark ?? ""));
        if (flatBench) entryBenches.add(flatBench);
        out.push(obj);
      }
    }
    // Return the benchmarks the file DECLARES, not the ones that happened to
    // yield rows. An entry with an empty or unparsed prediction list still
    // counts as present, or we would tell the student to add it again.
    return { rows: out, benches: [...entryBenches], errors: [] };
  }

  // Group prediction rows per benchmark. The file carries everything the server
  // needs: who submitted, how fast their system was, and one row per test message.
  function parseSubmissionFile(fileName, text) {
    const lower = fileName.toLowerCase();
    let parsed;
    if (lower.endsWith(".json")) parsed = rowsFromJSON(text);
    else return { clean: null, errors: ["Upload the .json file you produced. The site takes one JSON file holding both benchmarks."] };
    if (!parsed.rows) return { clean: null, errors: parsed.errors };
    const declared = new Set(parsed.benches || []);

    const byBench = {};
    const errors = [];
    const badBench = new Set();
    const names = new Map();   // NFKC-casefolded key -> the first spelling seen
    let fatal = false;
    for (const row of parsed.rows) {
      // Read the name before anything else. It is a fact about the whole file,
      // so a row that fails below must not also make the file look nameless.
      if (row.name !== undefined && String(row.name).trim()) {
        const spelling = String(row.name).trim().replace(/\s+/g, " ");
        const key = spelling.normalize("NFKC").toLowerCase();   // mirrors app.py person_key
        if (!names.has(key)) names.set(key, spelling);
      }
      const bench = normalizeBenchmark(String(row.benchmark ?? ""));
      if (!bench) { badBench.add(String(row.benchmark ?? "(empty)").slice(0, 20)); continue; }
      const group = byBench[bench] || (byBench[bench] = { predictions: [], times: new Set() });
      if (row[TIME_FIELD] !== undefined && String(row[TIME_FIELD]).trim() !== "") {
        group.times.add(String(row[TIME_FIELD]).trim().replace(",", "."));
      }
      const id = Number(row.id);
      if (!Number.isInteger(id)) { errors.push(`Benchmark ${bench}: '${row.id}' is not a whole-number id.`); fatal = true; break; }
      const maxId = CONFIG.TEST_ROWS[bench];
      if (id < 1 || (maxId && id > maxId)) {
        errors.push(`Benchmark ${bench}: id ${id} is outside 1 to ${(maxId || 0).toLocaleString()}. The ids come from test.tsv and start at 1.`);
        fatal = true; break;
      }
      const intent = String(row.intent ?? "").trim();
      if (!intent) { errors.push(`Benchmark ${bench}: id ${id} has no intent.`); fatal = true; break; }
      group.predictions.push({ id, intent });
    }
    // A row that failed above makes every later count unreliable, so stop here
    // rather than adding invented "wrong number of predictions" errors on top.
    // The both-benchmarks rule still applies though: report it now, or the
    // student fixes the row, re-uploads and only then learns B is missing too.
    if (fatal) {
      const short = BENCH_KEYS.filter((b) => !declared.has(b));
      if (short.length && short.length < BENCH_KEYS.length) {
        errors.push(`The file covers Benchmark ${BENCH_KEYS.filter((b) => declared.has(b)).join(" and ")} only. One file holds both benchmarks: add an entry for Benchmark ${short.join(" and ")}.`);
      }
      return { clean: null, errors };
    }
    if (badBench.size) {
      errors.push(`The benchmark field must say A or B, found ${[...badBench].slice(0, 3).map((b) => `'${b}'`).join(", ")}.`);
    }
    const benches = Object.keys(byBench).sort();
    if (!errors.length && !benches.length) errors.push("No predictions found in the file.");
    // The file is the whole submission: one entry for A and one for B.
    else if (!errors.length && declared.size < BENCH_KEYS.length) {
      const present = BENCH_KEYS.filter((b) => declared.has(b));
      const missing = BENCH_KEYS.filter((b) => !declared.has(b));
      errors.push(`The file covers Benchmark ${present.join(" and ")} only. One file holds both benchmarks: add an entry for Benchmark ${missing.join(" and ")}.`);
    }
    // Declared but produced no rows: report the real problem, not a missing entry.
    for (const bench of BENCH_KEYS) {
      if (declared.has(bench) && !(bench in byBench)) {
        const expected = CONFIG.TEST_ROWS[bench];
        errors.push(`Benchmark ${bench}: 0 predictions, but test.tsv has ${(expected || 0).toLocaleString()} messages. Predict every row.`);
      }
    }

    if (!names.size) errors.push('The file has no name in it. Add a "name" field to each entry.');
    else if (names.size > 1) errors.push(`The file carries more than one name: ${[...names.values()].slice(0, 3).join(", ")}. Use one name for both benchmarks.`);
    else {
      const only = [...names.values()][0];
      const length = Array.from(only).length;   // count characters, not UTF-16 units
      if (length > CONFIG.MAX_NAME_LEN) {
        errors.push(`The name is ${length} characters. Keep it to ${CONFIG.MAX_NAME_LEN} or fewer.`);
      } else if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u.test(only)) {
        errors.push("The name contains invisible or control characters. Use plain text.");
      }
    }

    for (const bench of benches) {
      const group = byBench[bench];
      const ids = new Set(group.predictions.map((r) => r.id));
      if (ids.size !== group.predictions.length) {
        errors.push(`Benchmark ${bench}: ${group.predictions.length - ids.size} duplicate id(s). Predict each test message once.`);
      }
      const expected = CONFIG.TEST_ROWS[bench];
      if (expected && group.predictions.length !== expected) {
        errors.push(`Benchmark ${bench}: ${group.predictions.length.toLocaleString()} predictions, but test.tsv has ${expected.toLocaleString()} messages. Predict every row.`);
      }
      if (group.times.size === 0) {
        errors.push(`Benchmark ${bench}: no ${TIME_FIELD}. Add your measured milliseconds per message.`);
      } else if (group.times.size > 1) {
        errors.push(`Benchmark ${bench}: ${TIME_FIELD} differs between rows (${[...group.times].slice(0, 3).join(", ")}). It is one number per benchmark.`);
      } else if (!Number.isFinite(Number([...group.times][0])) || Number([...group.times][0]) < 0) {
        errors.push(`Benchmark ${bench}: ${TIME_FIELD} must be a number of milliseconds, 0 or more.`);
      } else if (Number([...group.times][0]) > CONFIG.MAX_TIME_MS) {
        errors.push(`Benchmark ${bench}: ${TIME_FIELD} is ${[...group.times][0]} ms per message, which cannot be right. Report milliseconds, not seconds or nanoseconds.`);
      }
    }
    if (errors.length) return { clean: null, errors };

    const name = [...names.values()][0];
    return {
      clean: benches.map((bench) => ({
        name,
        benchmark: bench,
        [TIME_FIELD]: Number([...byBench[bench].times][0]),
        predictions: byBench[bench].predictions,
      })),
      errors: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Scoring & standings
  // ---------------------------------------------------------------------------
  const fmtPct = (x) => (x === null || x === undefined) ? "–" : (x * 100).toFixed(2) + " %";
  const fmtLatency = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n)) return "–";
    if (n === 0) return "0";
    return String(+n.toPrecision(3));
  };
  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "–";
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  const fmtClock = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Ranked ladder rows: accuracy desc, then latency asc, earlier first.
  // Competition ranking: ties on accuracy at the displayed 2 dp (%) share a rank.
  function computeRanks(rows) {
    const sorted = [...rows].sort((a, b) =>
      (b.metric - a.metric) || (a.average_time_per_example - b.average_time_per_example) ||
      String(a.submitted_at).localeCompare(String(b.submitted_at)));
    let lastRank = 0, lastKey = null;
    return sorted.map((r, i) => {
      const key = (r.metric * 100).toFixed(2);
      const rank = key === lastKey ? lastRank : i + 1;
      lastRank = rank; lastKey = key;
      return { ...r, rank };
    });
  }

  // Overall standing: group by person_key; the average of the two accuracies,
  // a missing benchmark contributing 0.
  function overallStandings(rows) {
    const people = new Map();
    for (const r of rows) {
      const p = people.get(r.person_key) || { pk: r.person_key, name: r.name, mine: false, accA: null, accB: null };
      p["acc" + r.benchmark] = r.metric;
      p.name = r.name;
      p.mine = p.mine || r.mine;
      people.set(r.person_key, p);
    }
    const list = [...people.values()].map((p) => ({
      ...p, accFinal: ((p.accA ?? 0) + (p.accB ?? 0)) / 2,
    })).sort((a, b) => (b.accFinal - a.accFinal) || a.name.localeCompare(b.name));
    let lastRank = 0, lastKey = null;
    return list.map((p, i) => {
      const key = (p.accFinal * 100).toFixed(2);
      const rank = key === lastKey ? lastRank : i + 1;
      lastRank = rank; lastKey = key;
      return { ...p, rank };
    });
  }

  // ---------------------------------------------------------------------------
  // Plot geometry (pure, unit-tested): always-log x, iso-score diagonals
  // ---------------------------------------------------------------------------
  const LOG2_10 = Math.log2(10);   // accuracy points per decade of latency at lambda=1

  function niceStep(rough) {
    const pow = 10 ** Math.floor(Math.log10(rough));
    for (const m of [1, 2, 5, 10]) if (m * pow >= rough - 1e-12) return m * pow;
    return 10 * pow;
  }
  function linearTicks(min, max, target) {
    const step = niceStep((max - min) / Math.max(1, target));
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  const fmtTickX = (v) => String(+(v >= 1 ? v.toPrecision(6) : v.toPrecision(3)));

  function plotLayout(rows, width, height) {
    const M = { l: 58, r: 34, t: 34, b: 48 };
    const iw = Math.max(60, width - M.l - M.r);
    const ih = Math.max(60, height - M.t - M.b);
    const clampL = (v) => Math.max(v, CONFIG.LATENCY_FLOOR_MS);
    const us = rows.map((r) => Math.log10(clampL(r.average_time_per_example)));
    let u0 = Math.floor(Math.min(...us));
    let u1 = Math.ceil(Math.max(...us));
    if (u1 === u0) u1 += 1;
    const xTicks = [];
    if (u1 - u0 <= 1) {
      for (const m of [1, 2, 5]) xTicks.push(+(m * 10 ** u0).toPrecision(12));
      xTicks.push(+(10 ** u1).toPrecision(12));
    } else {
      for (let e = u0; e <= u1; e++) xTicks.push(+(10 ** e).toPrecision(12));
    }
    const xPosU = (u) => M.l + (u - u0) / (u1 - u0) * iw;
    const xPos = (v) => xPosU(Math.log10(clampL(v)));

    const ys = rows.map((r) => r.metric * 100);
    let ymin = Math.floor(Math.min(...ys)) - 2, ymax = Math.ceil(Math.max(...ys)) + 2;
    if (ymax - ymin < 6) { ymin -= 2; ymax += 2; }
    ymin = Math.max(0, ymin); ymax = Math.min(100, ymax);
    if (!(ymax > ymin)) { ymin = 0; ymax = 100; }
    const yTicks = linearTicks(ymin, ymax, 5);
    const yPos = (v) => M.t + (1 - (v - ymin) / (ymax - ymin)) * ih;

    const points = rows.map((r) => ({
      row: r,
      x: xPos(r.average_time_per_example),
      y: yPos(r.metric * 100),
    }));
    return { M, iw, ih, width, height, u0, u1, xTicks, yTicks, xPos, yPos, points };
  }

  // Around-the-point name placement (8-position model) — labels avoid other
  // labels and every dot; deterministic; a label that cannot fit is hidden.
  const LABEL_CANDIDATES = ["r", "l", "t", "b", "tr", "br", "tl", "bl"];
  function labelCandidate(p, cand, w) {
    switch (cand) {
      case "r":  return { x: p.x + 9, y: p.y + 4,  a: "start",  bx0: p.x + 9,     bx1: p.x + 9 + w };
      case "l":  return { x: p.x - 9, y: p.y + 4,  a: "end",    bx0: p.x - 9 - w, bx1: p.x - 9 };
      case "t":  return { x: p.x,     y: p.y - 11, a: "middle", bx0: p.x - w / 2, bx1: p.x + w / 2 };
      case "b":  return { x: p.x,     y: p.y + 17, a: "middle", bx0: p.x - w / 2, bx1: p.x + w / 2 };
      case "tr": return { x: p.x + 7, y: p.y - 9,  a: "start",  bx0: p.x + 7,     bx1: p.x + 7 + w };
      case "br": return { x: p.x + 7, y: p.y + 15, a: "start",  bx0: p.x + 7,     bx1: p.x + 7 + w };
      case "tl": return { x: p.x - 7, y: p.y - 9,  a: "end",    bx0: p.x - 7 - w, bx1: p.x - 7 };
      default:   return { x: p.x - 7, y: p.y + 15, a: "end",    bx0: p.x - 7 - w, bx1: p.x - 7 };
    }
  }
  function placeLabels(points, widthOf, M, iw, ih, allPoints) {
    const ASC = 9, DESC = 3, DOT = 7, PAD = 2;
    const bx0 = M.l + 1, bx1 = M.l + iw - 1, by0 = M.t + 1, by1 = M.t + ih - 1;
    const boxes = [];
    const dots = (allPoints || points).map((d) => [d.x - DOT, d.x + DOT, d.y - DOT, d.y + DOT]);
    const hitsBox = (b, o) => b[0] < o[1] && o[0] < b[1] && b[2] < o[3] && o[2] < b[3];
    for (const p of [...points].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const w = widthOf(p);
      p.labelPos = null;
      p.hideLabel = true;
      for (const cand of LABEL_CANDIDATES) {
        const c = labelCandidate(p, cand, w);
        const box = [c.bx0, c.bx1, c.y - ASC, c.y + DESC];
        if (box[0] < bx0 || box[1] > bx1 || box[2] < by0 || box[3] > by1) continue;
        if (dots.some((d) => hitsBox(box, d))) continue;
        const padded = [box[0] - PAD, box[1] + PAD, box[2] - PAD, box[3] + PAD];
        if (boxes.some((o) => hitsBox(padded, o))) continue;
        p.labelPos = c;
        p.hideLabel = false;
        boxes.push(box);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Plot rendering (per benchmark)
  // ---------------------------------------------------------------------------
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showPlotTip(bench, p, target) {
    const P = plots[bench];
    const box = P.tip.offsetParent || P.tip.parentElement;
    const boxRect = box.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2 - boxRect.left;
    const cy = r.top + r.height / 2 - boxRect.top;
    P.tip.textContent = `${p.row.name}: ${fmtPct(p.row.metric)}, ${fmtLatency(p.row.average_time_per_example)} ms/ex`;
    P.tip.hidden = false;
    const half = P.tip.offsetWidth / 2;
    P.tip.style.left = `${Math.min(Math.max(cx, half + 2), boxRect.width - half - 2)}px`;
    P.tip.style.top = `${cy}px`;
    P.tip.classList.toggle("below", cy < 46);
  }
  const hidePlotTip = (bench) => { plots[bench].tip.hidden = true; };

  function renderPlot(bench) {
    const P = plots[bench];
    if (!P) return;
    const rows = state.ladders[bench];
    if (!rows.length) {
      P.lastKey = "empty";
      P.index = new Map();
      P.host.replaceChildren();
      P.empty.hidden = false;
      hidePlotTip(bench);
      return;
    }
    P.empty.hidden = true;
    if (!P.host.offsetParent) { P.lastKey = null; return; }   // panel hidden: render on tab switch
    const width = Math.max(320, P.host.clientWidth || 640);
    const key = width + "|" + rows.map((r) => `${r.id},${r.name},${r.metric},${r.average_time_per_example},${r.mine ? 1 : 0}`).join(";");
    if (key === P.lastKey) { relayoutNames(bench); return; }
    P.lastKey = key;
    hidePlotTip(bench);

    const height = Math.round(Math.min(400, Math.max(280, width * 0.42)));
    const L = plotLayout(rows, width, height);
    const dotClass = (BENCHMARKS.find((b) => b.key === bench) || {}).dotClass || "";
    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`, height, role: "group",
      "aria-label": `Benchmark ${bench}: accuracy versus latency, the same data as the table above.`,
    });
    svg.style.width = "100%";
    for (const t of L.yTicks) {
      const y = L.yPos(t);
      svg.appendChild(svgEl("line", { x1: L.M.l, x2: L.M.l + L.iw, y1: y, y2: y, class: "plot-grid" }));
      svg.appendChild(svgEl("text", { x: L.M.l - 8, y: y + 3.5, class: "plot-tick plot-tick-y" }, String(t)));
    }
    for (const t of L.xTicks) {
      const x = L.xPos(t);
      svg.appendChild(svgEl("line", { x1: x, x2: x, y1: L.M.t, y2: L.M.t + L.ih, class: "plot-grid" }));
      svg.appendChild(svgEl("text", { x, y: L.M.t + L.ih + 16, class: "plot-tick" }, fmtTickX(t)));
    }
    svg.appendChild(svgEl("line", { x1: L.M.l, x2: L.M.l + L.iw, y1: L.M.t + L.ih, y2: L.M.t + L.ih, class: "plot-axis" }));
    svg.appendChild(svgEl("text", { x: 10, y: 16, class: "plot-axis-title plot-axis-title-y" }, "Test accuracy (%)"));
    svg.appendChild(svgEl("text", { x: L.M.l + L.iw / 2, y: L.height - 8, class: "plot-axis-title" },
      "Latency (ms per example, log scale)"));

    P.index = new Map();
    for (const p of L.points) {
      const mine = p.row.mine;
      const dot = svgEl("circle", { cx: p.x, cy: p.y, r: 5, class: `plot-dot ${dotClass}` + (mine ? " mine" : "") });
      svg.appendChild(dot);
      const hit = svgEl("circle", {
        cx: p.x, cy: p.y, r: 12, class: "plot-hit", "aria-hidden": "true",
      });
      const over = () => { dot.classList.add("hot"); showPlotTip(bench, p, hit); };
      const out = () => { dot.classList.remove("hot"); hidePlotTip(bench); };
      hit.addEventListener("pointerenter", over);
      hit.addEventListener("pointerleave", out);
      svg.appendChild(hit);
      P.index.set(p.row.person_key, { p, dot });
    }
    // Name label nodes for every point (hidden). Placement runs over the CHECKED
    // subset only — with every dot as an obstacle — so a ticked name is shown
    // whenever it can physically fit, however dense the rest of the board is.
    const estWidth = (p) => 10 + (p.row.name.length + (p.row.mine ? 6 : 0)) * 7;
    P.labelData = [];
    for (const p of L.points) {
      const node = svgEl("text", { class: "plot-name" + (p.row.mine ? " mine" : "") },
        p.row.name + (p.row.mine ? " (you)" : ""));
      node.style.display = "none";
      svg.appendChild(node);
      P.labelData.push({ pk: p.row.person_key, p, node });
      const entry = P.index.get(p.row.person_key);
      if (entry) entry.label = node;
    }
    P.layout = { M: L.M, iw: L.iw, ih: L.ih };
    P.allPoints = L.points;
    P.widths = new Map();
    P.host.replaceChildren(svg);
    try {   // measure real text widths once (display:none defeats measurement, so flip briefly)
      for (const d of P.labelData) {
        d.node.style.visibility = "hidden";
        d.node.style.display = "";
        const w = d.node.getComputedTextLength();
        P.widths.set(d.p, w > 0 ? w + 6 : estWidth(d.p));
        d.node.style.display = "none";
        d.node.style.visibility = "";
      }
    } catch (_) {
      for (const d of P.labelData) P.widths.set(d.p, estWidth(d.p));
    }
    relayoutNames(bench);
  }

  function relayoutNames(onlyBench) {
    for (const bench of BENCH_KEYS) {
      if (onlyBench && bench !== onlyBench) continue;
      const P = plots[bench];
      if (!P || !P.labelData || !P.layout) continue;
      const subset = P.labelData.filter((d) => state.labeled.has(d.pk));
      placeLabels(subset.map((d) => d.p), (p) => P.widths.get(p) || 80,
        P.layout.M, P.layout.iw, P.layout.ih, P.allPoints);
      for (const d of P.labelData) {
        const show = state.labeled.has(d.pk) && d.p.labelPos;
        d.node.style.display = show ? "" : "none";
        if (show) {
          d.node.setAttribute("x", d.p.labelPos.x);
          d.node.setAttribute("y", d.p.labelPos.y);
          d.node.setAttribute("text-anchor", d.p.labelPos.a);
        }
      }
    }
  }

  let spotlightPk = null;
  function plotSpotlight(pk, on, tipBench) {
    if (on && spotlightPk === pk && tipBench === undefined) return;
    for (const bench of BENCH_KEYS) {
      const P = plots[bench];
      if (!P || !P.index) continue;
      const prev = spotlightPk && P.index.get(spotlightPk);
      if (prev) prev.dot.classList.remove("hot");
      const entry = on && P.index.get(pk);
      if (entry) {
        entry.dot.classList.add("hot");
        if (bench === tipBench) showPlotTip(bench, entry.p, entry.dot);
        else hidePlotTip(bench);
      } else {
        hidePlotTip(bench);
      }
    }
    spotlightPk = on ? pk : null;
  }

  // ---------------------------------------------------------------------------
  // Final standings
  //
  // /api/final answers 404 until the organisers publish, and while it does this
  // whole block is inert: nothing is created and no wording is touched, so the
  // page is the live board it has always been. Once it answers 200 the Overall
  // section gains a button that switches between the published final standings
  // (scored on the complete test set) and the live board (the public scores).
  // The two benchmark ladders and the plots always stay live.
  // ---------------------------------------------------------------------------
  const FINAL_VIEW = "final";
  const LIVE_VIEW = "live";
  const FINAL_SUB = "Final standings · average of your two accuracies on the complete test set";
  const LIVE_VIEW_SUB = "Live board · average of your two accuracies";
  const FINAL_FOOTNOTE = "These are the final standings, scored on the complete test set.";

  function readStoredView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === FINAL_VIEW || v === LIVE_VIEW ? v : null;
    } catch (_) { return null; }
  }
  function storeView(v) {
    try { localStorage.setItem(VIEW_KEY, v); } catch (_) { /* blocked storage: the choice lasts the session */ }
  }
  // Only ever asked once something is published, so an unpublished page never
  // reads storage for this. Published and unasked defaults to the final view.
  function currentView() {
    if (state.overallView === null) state.overallView = readStoredView() || FINAL_VIEW;
    return state.overallView;
  }
  const showingFinal = () => !!state.final && currentView() === FINAL_VIEW;

  const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;

  function fmtDay(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // undefined = the answer told us nothing we can trust; keep what we have.
  function normalizeFinal(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.standings)) return undefined;
    const rows = [];
    for (const r of data.standings) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const rank = finiteOrNull(r.rank);
      rows.push({
        pk: typeof r.person_key === "string" ? r.person_key : "",
        name: typeof r.name === "string" ? r.name : "",
        accA: finiteOrNull(r.accA),
        accB: finiteOrNull(r.accB),
        accFinal: finiteOrNull(r.final),
        rank: rank === null ? rows.length + 1 : rank,
      });
    }
    return { publishedAt: typeof data.published_at === "string" ? data.published_at : "", rows };
  }

  // /api/final 404s until the organisers publish, and a 404 is logged by the
  // browser console on every poll. Riding the 10 s cycle would double the
  // request count and fill the console for weeks, so after a few consecutive
  // 404s the probe drops to one refresh in FINAL_PROBE_EVERY (about a minute);
  // the first answer that is not a 404 puts it straight back on every cycle.
  const FINAL_404_GRACE = 3;        // fast polls before backing off
  const FINAL_PROBE_EVERY = 6;      // 6 x REFRESH_MS = ~1 min while backed off
  let final404s = 0;                // consecutive "not published" answers
  let finalSkips = 0;               // refreshes since the last backed-off probe

  function probeFinal() {
    if (final404s < FINAL_404_GRACE) { finalSkips = 0; return true; }
    if (++finalSkips < FINAL_PROBE_EVERY) return false;
    finalSkips = 0;
    return true;
  }

  // Never rejects: 404 means "not published", anything else means "no news".
  async function fetchFinal() {
    try {
      const data = normalizeFinal(await api("GET", "/api/final"));
      final404s = 0;                // answering again: back on the fast cycle
      return data;
    } catch (err) {
      if (err.status === 404) { final404s++; return null; }
      // A 429 is the server asking for fewer requests, so asking again on the
      // very next cycle is the one thing not to do. Back off the same way a
      // 404 does, but keep whatever standings we already have.
      if (err.status === 429) { final404s++; return undefined; }
      return undefined;
    }
  }

  // The published rows in the shape the Overall table already renders.
  function finalTableRows() {
    const mine = new Set();
    for (const bench of BENCH_KEYS) {
      const row = state.mine[bench];
      if (row && row.person_key) mine.add(row.person_key);
    }
    return state.final.rows.map((r) => ({ ...r, mine: mine.has(r.pk) }));
  }

  let finalHead = null;             // the card-head holding the toggle, once published
  let btnFinalView = null;

  function buildFinalToggle() {
    btnFinalView = document.createElement("button");
    btnFinalView.type = "button";
    btnFinalView.id = "btn-final-view";
    btnFinalView.className = "btn btn-ghost btn-sm";
    btnFinalView.addEventListener("click", () => {
      state.overallView = showingFinal() ? LIVE_VIEW : FINAL_VIEW;
      storeView(state.overallView);
      applyOverallView();
      renderOverallTable();
      renderMyStatus();           // the strip quotes the view, so it flips too
    });
    finalHead = document.createElement("div");
    finalHead.className = "card-head";
    // .card-head is `justify-content: space-between`; the ladder heads pair a
    // leading note with trailing buttons, so a lone button would sit left. An
    // empty leading note keeps the same structure and puts the button right.
    const headSpacer = document.createElement("span");
    headSpacer.className = "card-head-note";
    finalHead.append(headSpacer, btnFinalView);
    // the strip goes above the table; the overall card has no head of its own
    el.overallCard.replaceChildren(finalHead, ...el.overallCard.childNodes);
  }

  function applyOverallView() {
    if (!state.final) {
      if (!finalHead) return;       // nothing published, nothing ever touched
      finalHead.remove();           // published, then withdrawn: put the page back
      finalHead = btnFinalView = null;
      el.overallSub.textContent = LIVE_SUB;
      el.overallFootnote.textContent = LIVE_FOOTNOTE;
      return;
    }
    if (!finalHead) buildFinalToggle();
    const final = showingFinal();
    const day = fmtDay(state.final.publishedAt);
    btnFinalView.textContent = final ? "Show the live board" : "Show the final standings";
    el.overallSub.textContent = final ? FINAL_SUB : LIVE_VIEW_SUB;
    el.overallFootnote.textContent = final
      ? FINAL_FOOTNOTE + (day ? ` Published ${day}.` : "")
      : LIVE_FOOTNOTE;
  }

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------
  function td(className, text) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const DEFAULT_DIR = { metric: "desc", average_time_per_example: "asc", name: "asc", submitted_at: "desc", rank: "asc", accA: "desc", accB: "desc", accFinal: "desc" };

  function sortView(rows, view) {
    const { sortKey, sortDir } = view;
    if (sortKey === "rank" && sortDir === "asc") return rows;
    const sign = sortDir === "asc" ? 1 : -1;
    return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
      const av = a[sortKey], bv = b[sortKey];
      let c;
      if (typeof av === "number" || typeof bv === "number") {
        c = ((av ?? -Infinity)) - ((bv ?? -Infinity));
      } else c = collator.compare(String(av ?? ""), String(bv ?? ""));
      if (c === 0) c = sign * (ia - ib);
      return sign * c;
    }).map(([r]) => r);
  }

  function updateAriaSort(headers, view) {
    for (const th of headers) {
      const active = th.dataset.key === view.sortKey;
      th.setAttribute("aria-sort", active ? (view.sortDir === "asc" ? "ascending" : "descending") : "none");
    }
  }

  function wireSort(headers, viewKey, rerender) {
    for (const th of headers) {
      th.querySelector(".sort-btn").addEventListener("click", () => {
        const view = state.views[viewKey];
        const key = th.dataset.key;
        if (view.sortKey === key) view.sortDir = view.sortDir === "asc" ? "desc" : "asc";
        else { view.sortKey = key; view.sortDir = DEFAULT_DIR[key] || "asc"; }
        view.lastTableKey = null;
        rerender();
      });
    }
  }

  function renderLadderTable(bench) {
    const view = state.views[bench];
    const dom = ladders[bench];
    if (dom.tbody.contains(document.activeElement)) return;   // keyboard user inside: retry next poll
    const rows = sortView(state.ladders[bench], view);
    const key = `${view.sortKey}|${view.sortDir}|` +
      rows.map((r) => `${r.id},${r.name},${r.metric},${r.average_time_per_example},${r.rank},${r.mine ? 1 : 0},${r.submitted_at}`).join(";");
    if (key === view.lastTableKey) return;
    view.lastTableKey = key;

    const frag = document.createDocumentFragment();
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "placeholder-row";
      const cell = td(null, `No results on Benchmark ${bench} yet.`);
      cell.colSpan = 6;
      tr.appendChild(cell);
      frag.appendChild(tr);
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.dataset.pk = r.person_key;
      if (r.mine) tr.classList.add("mine");
      const checkCell = document.createElement("td");
      checkCell.className = "check";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "name-check";
      check.checked = state.labeled.has(r.person_key);
      check.setAttribute("aria-label", `Show ${r.name} on the plots`);
      check.addEventListener("change", () => setLabeled(r.person_key, check.checked));
      checkCell.appendChild(check);
      tr.appendChild(checkCell);
      const rankCell = td("rank" + (r.rank <= 3 ? " top3" : ""), String(r.rank));
      tr.appendChild(rankCell);
      const nameCell = td("name-cell", r.name);
      if (r.mine) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "you";
        nameCell.appendChild(badge);
      }
      tr.appendChild(nameCell);
      tr.appendChild(td("num score-cell", fmtPct(r.metric)));
      tr.appendChild(td("num", fmtLatency(r.average_time_per_example)));
      const dateCell = td("date", fmtDate(r.submitted_at));
      dateCell.title = r.submitted_at;
      tr.appendChild(dateCell);
      frag.appendChild(tr);
    }
    dom.tbody.replaceChildren(frag);
    updateAriaSort(dom.headers, view);
    dom.countNote.textContent = `${state.ladders[bench].length} result${state.ladders[bench].length === 1 ? "" : "s"}`;
  }

  function renderOverallTable() {
    const view = state.views.overall;
    if (el.overallBody.contains(document.activeElement)) return;
    const final = showingFinal();
    const rows = sortView(final ? finalTableRows() : state.overall, view);
    const key = `${final ? "final" : "live"}|${view.sortKey}|${view.sortDir}|` +
      rows.map((r) => `${r.pk},${r.name},${r.accA},${r.accB},${r.accFinal},${r.rank},${r.mine ? 1 : 0}`).join(";");
    if (key === view.lastTableKey) return;
    view.lastTableKey = key;

    const frag = document.createDocumentFragment();
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "placeholder-row";
      const cell = td(null, final
        ? "No final standings to show."
        : "The overall standing appears with the first result.");
      cell.colSpan = 5;
      tr.appendChild(cell);
      frag.appendChild(tr);
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.dataset.pk = r.pk;
      if (r.mine) tr.classList.add("mine");
      const rankCell = document.createElement("td");
      rankCell.className = "rank";
      const medal = document.createElement("span");
      medal.className = "medal" + (r.rank <= 3 ? ` m${r.rank}` : "");
      medal.textContent = r.rank;
      rankCell.appendChild(medal);
      tr.appendChild(rankCell);
      const nameCell = td("name-cell", r.name);
      if (r.mine) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "you";
        nameCell.appendChild(badge);
      }
      tr.appendChild(nameCell);
      const a = td("num" + (r.accA === null ? " missing" : ""), fmtPct(r.accA));
      const b = td("num" + (r.accB === null ? " missing" : ""), fmtPct(r.accB));
      tr.appendChild(a);
      tr.appendChild(b);
      tr.appendChild(td("num score-cell", fmtPct(r.accFinal)));
      frag.appendChild(tr);
    }
    el.overallBody.replaceChildren(frag);
    updateAriaSort(el.overallTable.querySelectorAll("th[data-key]"), view);
  }

  // ---------------------------------------------------------------------------
  // Name checkboxes / show-all buttons (shared, person-keyed)
  // ---------------------------------------------------------------------------
  function allPersonKeys() {
    return new Set(state.rows.map((r) => r.person_key));
  }
  function updateLabelAllButtons() {
    const total = allPersonKeys().size;
    const all = total > 0 && state.labeled.size >= total;
    for (const bench of BENCH_KEYS) {
      const btn = ladders[bench] && ladders[bench].btnLabelAll;
      if (!btn) continue;
      btn.disabled = state.ladders[bench].length === 0;
      btn.textContent = all ? "Hide names" : "Show all names";
    }
  }
  function syncCheckboxes() {
    for (const bench of BENCH_KEYS) {
      const dom = ladders[bench];
      if (!dom) continue;
      for (const box of dom.tbody.querySelectorAll("input.name-check")) {
        const tr = box.closest("tr[data-pk]");
        if (tr) box.checked = state.labeled.has(tr.dataset.pk);
      }
    }
  }
  function setLabeled(pk, on) {
    if (on) state.labeled.add(pk); else state.labeled.delete(pk);
    updateLabelAllButtons();
    syncCheckboxes();
    relayoutNames();
  }

  // ---------------------------------------------------------------------------
  // Status panel: one slot per benchmark + overall line
  // ---------------------------------------------------------------------------
  // Whatever the Overall table is showing, the strip quotes the same number:
  // after publication that is the final standing, not the live public-slice one,
  // so the two cannot contradict each other on screen. `finalTableRows()` marks
  // "mine" exactly as the table does, and a withdrawal falls back to live.
  function myOverall() {
    const rows = showingFinal() ? finalTableRows() : state.overall;
    return rows.find((p) => p.mine) || null;
  }

  function renderMyStatus() {
    const mA = state.mine.A, mB = state.mine.B;
    const ov = myOverall();
    const key = [mA && `${mA.id},${mA.metric},${mA.rank}`, mB && `${mB.id},${mB.metric},${mB.rank}`,
      ov && `${ov.rank},${ov.accFinal}`, storageOk].join("|");
    if (key === state.statusKey) return;
    state.statusKey = key;

    // Rebuilding this box detaches whatever had focus, which would drop focus to
    // <body>. A closing dialog also restores focus here. So remember which
    // control was focused and put focus back on its replacement afterwards.
    const active = document.activeElement;
    const hadFocus = Boolean(active) && el.myStatus.contains(active);
    const focusedAct = hadFocus ? (active.dataset && active.dataset.act) || "" : "";

    const box = el.myStatus;
    box.replaceChildren();
    if (!mA && !mB) {
      const span = document.createElement("span");
      span.textContent = "You have not submitted yet.";
      box.appendChild(span);
    } else {
      for (const bench of BENCH_KEYS) {
        const m = state.mine[bench];
        const slot = document.createElement("span");
        slot.className = "slot";
        const tag = document.createElement("span");
        tag.className = "slot-bench" + (bench === "B" ? " bench-b" : "");
        tag.textContent = bench;
        slot.appendChild(tag);
        const txt = document.createElement("span");
        if (m) {
          txt.append(`${fmtPct(m.metric)} · #${m.rank}`);
        } else {
          txt.className = "slot-missing";
          txt.textContent = "no result, counts as 0";
        }
        slot.appendChild(txt);
        box.appendChild(slot);
      }
      // One file carries both benchmarks, so an upload rewrites both rows and a
      // delete drops both. The controls say so: one shared pair for the strip,
      // not a pair per benchmark that would promise a per-benchmark edit.
      const acts = document.createElement("span");
      acts.className = "slot";
      const rep = document.createElement("button");
      rep.type = "button";
      rep.className = "btn btn-ghost btn-sm";
      rep.textContent = "Replace both";
      rep.dataset.act = "all:replace";
      rep.addEventListener("click", () => openUploadDialog(rep));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm";
      del.textContent = "Delete both";
      del.dataset.act = "all:delete";
      del.addEventListener("click", () => openDeleteDialog(del));
      acts.append(rep, del);
      box.appendChild(acts);
      if (ov) {
        const line = document.createElement("span");
        line.className = "slot-overall";
        const strong = document.createElement("strong");
        strong.textContent = `Overall ${fmtPct(ov.accFinal)} (#${ov.rank})`;
        line.appendChild(strong);
        box.appendChild(line);
      }
    }
    if (!storageOk) {
      const warn = document.createElement("span");
      warn.className = "storage-warning";
      warn.textContent = "Your browser blocks site storage. After a reload you will not be able to edit or delete your results.";
      box.appendChild(warn);
    }
    if (hadFocus) {
      const again = focusedAct && box.querySelector(`[data-act="${focusedAct}"]`);
      const target = again || el.btnOpenUpload;
      if (target && typeof target.focus === "function") target.focus();
    }
  }

  function renderStats() {
    el.statCount.textContent = String(allPersonKeys().size);
    el.statA.textContent = String(state.ladders.A.length);
    el.statB.textContent = String(state.ladders.B.length);
    for (const bench of BENCH_KEYS) {
      el.tabCounts[bench].textContent = state.ladders[bench].length ? `(${state.ladders[bench].length})` : "";
    }
    el.statUpdated.textContent = fmtClock(new Date());
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  async function refresh({ silent = true } = {}) {
    const seq = ++state.refreshSeq;
    try {
      // The final standings ride the same cycle until they 404 often enough to
      // be worth backing off from; fetchFinal never rejects, and a skipped probe
      // reports undefined, which leaves whatever we already have alone.
      const [data, final] = await Promise.all([
        api("GET", "/api/submissions"),
        probeFinal() ? fetchFinal() : Promise.resolve(undefined),
      ]);
      if (seq !== state.refreshSeq) return;
      if (final !== undefined) state.final = final;
      state.loaded = true;
      state.rows = (data.submissions || []).filter((r) => typeof r.metric === "number");
      for (const bench of BENCH_KEYS) {
        state.ladders[bench] = computeRanks(state.rows.filter((r) => r.benchmark === bench));
        state.mine[bench] = state.ladders[bench].find((r) => r.mine) || null;
      }
      state.overall = overallStandings(state.rows);
      const alive = allPersonKeys();
      for (const pk of state.labeled) if (!alive.has(pk)) state.labeled.delete(pk);
      const myPk = (state.mine.A || state.mine.B || {}).person_key;
      if (!state.seededSelf && myPk) { state.labeled.add(myPk); state.seededSelf = true; }
      applyOverallView();
      renderOverallTable();
      for (const bench of BENCH_KEYS) {
        renderLadderTable(bench);
        renderPlot(bench);
      }
      renderMyStatus();
      renderStats();
      updateLabelAllButtons();
      // Whether an upload replaces an existing result depends on the board. A
      // dialog opened before the first load (the /#upload link on the guide and
      // assignment pages) computed that against an empty board, so redo it.
      if (el.uploadDialog.open && state.pending && !state.submitting) {
        showPreview(state.pending);
        el.btnSubmitUpload.textContent = submitLabel(state.pending);
      }
      // The first render pushes the tab strip down, so a deep link has to be
      // re-aimed once the real rows are in.
      if (deepLinkPending) { deepLinkPending = false; scrollToTabs(); }
    } catch (err) {
      if (seq !== state.refreshSeq) return;
      // 429 means the server is busy and has told us how long for. Polling
      // through that adds load to a site that is already struggling, so hold
      // off for as long as it asked (a minute at most, so the board still
      // comes back on its own).
      const waitS = err.status === 429
        ? Math.min(err.retryAfter || 30, 60)
        : Math.round(CONFIG.REFRESH_MS / 1000);
      if (err.status === 429) state.pollAfter = Date.now() + waitS * 1000;
      // A 429 carries the plain explanation and the wait in its details array.
      // err.message is only the one-word summary ("Too many requests."), which
      // tells a student nothing they can act on.
      const details = err.details && err.details.length ? err.details : [err.message];
      if (!silent) showToast(`Could not load the leaderboard: ${details[0]}`, "error");
      else el.statUpdated.textContent = "offline";
      // Before the first successful load the page is nothing but a "Loading…"
      // skeleton and a row of dashes, and a toast is gone in 4.5 seconds. Say
      // what happened in the page itself and leave it there until data arrives.
      if (!state.loaded) showLoadFailure(err, waitS);
    }
  }

  function placeholderRow(tbody, cols, text) {
    if (!tbody) return;
    const tr = document.createElement("tr");
    tr.className = "placeholder-row";
    const cell = td(null, text);
    cell.colSpan = cols;
    tr.appendChild(cell);
    tbody.replaceChildren(tr);
  }

  // The board has never had data, so there is nothing on screen to preserve and
  // nothing to contradict: fill the tables with the reason and the wait. The
  // poll keeps running, so this is replaced by real rows without a reload.
  function showLoadFailure(err, waitS) {
    const when = waitS >= 45 ? "about a minute" : `about ${waitS} seconds`;
    const message = err.status === 429
      ? `The site is busy right now. The leaderboard loads by itself in ${when}, with no reload needed.`
      : err.status === 0
        ? `Cannot reach the server. The page keeps trying, ${when} apart, so leave it open.`
        : `The leaderboard could not be loaded. The page tries again in ${when}.`;
    placeholderRow(el.overallBody, 5, message);
    for (const bench of BENCH_KEYS) {
      if (ladders[bench]) placeholderRow(ladders[bench].tbody, 6, message);
    }
    el.statUpdated.textContent = "not loaded";
  }

  function scheduleRefresh() {
    setInterval(() => {
      if (Date.now() < state.pollAfter) return;
      if (document.visibilityState === "visible") refresh();
    }, CONFIG.REFRESH_MS);
  }

  // ---------------------------------------------------------------------------
  // Upload dialog
  // ---------------------------------------------------------------------------
  function submitLabel(entries) {
    if (!entries || !entries.length) return "Submit";
    if (entries.length === 2) {
      const rep = entries.map((e) => !!state.mine[e.benchmark]);
      if (rep[0] && rep[1]) return "Replace both results";
      if (!rep[0] && !rep[1]) return "Submit both results";
      const parts = entries.map((e) => `${state.mine[e.benchmark] ? "replace" : "submit"} ${e.benchmark}`);
      return (parts[0][0].toUpperCase() + parts[0].slice(1)) + ", " + parts[1];
    }
    const b = entries[0].benchmark;
    return state.mine[b] ? `Replace my Benchmark ${b} result` : `Submit Benchmark ${b} result`;
  }

  function resetUploadDialog() {
    state.pending = null;
    state.pendingFile = null;
    state.fileSeq++;
    el.fileInput.value = "";
    el.dropzoneFile.textContent = "";
    el.validationBox.hidden = true;
    el.validationBox.replaceChildren();
    el.validationBox.className = "validation";
    el.warnBox.hidden = true;
    el.warnBox.replaceChildren();
    el.previewBox.hidden = true;
    el.previewEntries.replaceChildren();
    el.btnSubmitUpload.disabled = true;
    el.btnSubmitUpload.textContent = "Submit";
    el.uploadTitle.textContent = "Upload predictions";
    el.dialogNote.textContent = storageOk
      ? "Your browser remembers this upload so you can replace or delete it later."
      : "This browser blocks site storage. After a reload you will not be able to edit or delete these results.";
  }

  // ---------------------------------------------------------------------------
  // Dialog focus
  //
  // showModal() moves focus into the dialog and makes the rest of the page
  // inert, so the trap and Escape come for free. What is not free is the way
  // back: the spec restores focus to whatever was focused when the dialog
  // opened, and that element is often gone by then, because the ten-second
  // poll rebuilds the status bar the Replace / Delete / Upload buttons live in.
  // A detached element is not focusable, so focus would fall to <body>. Each
  // dialog therefore remembers its opener and falls back to a button that is
  // always there.
  // ---------------------------------------------------------------------------
  function restoreFocus(opener, fallback) {
    const target = (opener && document.body.contains(opener)) ? opener : fallback;
    if (target && typeof target.focus === "function") target.focus();
  }

  // "Upload predictions" is a link on the guide and assignment pages, so the
  // dialog has to be reachable by URL: /#upload. Closing it takes the fragment
  // back out with replaceState, which leaves no extra Back step behind.
  const UPLOAD_HASH = "#upload";
  function dropUploadHash() {
    if ((window.location.hash || "").toLowerCase() !== UPLOAD_HASH) return;
    try {
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
    } catch (_) { /* ignore */ }
  }

  let uploadOpener = null;
  function openUploadDialog(opener) {
    if (Date.now() >= DEADLINE_MS) {
      showToast("Submissions closed on 10 September 2026.", "error");
      return;
    }
    uploadOpener = opener || null;
    resetUploadDialog();
    if (!el.uploadDialog.open) el.uploadDialog.showModal();
  }

  // What the box last said about the FILE itself, so a refusal that never even
  // looked at the file (a 429) can add its line without wiping the list the
  // student is working from.
  let fileProblems = [];

  function showValidation(errors, { title = null, okMessage = "", keep = false } = {}) {
    if (!keep) fileProblems = errors.slice();
    const box = el.validationBox;
    box.replaceChildren();
    box.hidden = false;
    if (errors.length) {
      box.className = "validation error";
      const heading = document.createElement("strong");
      heading.textContent = title || (errors.length === 1 ? "The file is not valid:" : `The file is not valid (${errors.length} problems):`);
      const ul = document.createElement("ul");
      for (const e of errors) { const li = document.createElement("li"); li.textContent = e; ul.appendChild(li); }
      box.append(heading, ul);
    } else {
      box.className = "validation ok";
      box.textContent = okMessage;
    }
  }

  function showWarnings(warnings) {
    el.warnBox.replaceChildren();
    el.warnBox.hidden = warnings.length === 0;
    if (!warnings.length) return;
    const heading = document.createElement("strong");
    heading.textContent = "Check this before you submit:";
    const ul = document.createElement("ul");
    for (const w of warnings) { const li = document.createElement("li"); li.textContent = w; ul.appendChild(li); }
    el.warnBox.append(heading, ul);
  }

  function showPreview(entries) {
    el.previewEntries.replaceChildren();
    for (const e of entries) {
      const wrap = document.createElement("div");
      wrap.className = "preview-row";
      const h = document.createElement("h4");
      h.textContent = `Benchmark ${e.benchmark}`;
      wrap.appendChild(h);
      const dl = document.createElement("dl");
      dl.className = "preview-grid";
      const add = (k, v) => {
        const dt = document.createElement("dt"); dt.textContent = k;
        const dd = document.createElement("dd"); dd.textContent = v;
        dl.append(dt, dd);
      };
      add("Name", e.name);
      add("Predictions", `${e.predictions.length.toLocaleString()} rows, ` +
        `${new Set(e.predictions.map((p) => p.intent)).size} distinct categories`);
      add("Time per message", `${fmtLatency(e[TIME_FIELD])} ms`);
      wrap.appendChild(dl);
      const current = state.mine[e.benchmark];
      if (current) {
        const delta = document.createElement("p");
        delta.className = "preview-delta";
        delta.textContent = `replaces your current Benchmark ${e.benchmark} result (accuracy ${fmtPct(current.metric)})`;
        wrap.appendChild(delta);
      }
      el.previewEntries.appendChild(wrap);
    }
    el.previewBox.hidden = false;
  }

  function runValidation(fileName, text) {
    const { clean, errors } = parseSubmissionFile(fileName, text);
    if (errors.length) { showValidation(errors); showWarnings([]); return; }
    state.pending = clean;
    const rows = clean.reduce((n, e) => n + e.predictions.length, 0);
    showValidation([], { okMessage: `Read ${rows.toLocaleString()} predictions. Press Submit and the site will score them.` });
    showWarnings([]);
    showPreview(clean);
    el.btnSubmitUpload.disabled = false;
    el.btnSubmitUpload.textContent = submitLabel(clean);
  }

  async function handleFile(file) {
    const seq = ++state.fileSeq;
    el.previewBox.hidden = true;
    el.warnBox.hidden = true;
    state.pending = null;
    state.pendingFile = null;
    el.btnSubmitUpload.disabled = true;
    el.btnSubmitUpload.textContent = "Submit";
    if (!file) {
      el.dropzoneFile.textContent = "";
      showValidation(["No file received. Drop the .json file you produced."]);
      return;
    }
    el.dropzoneFile.textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
    if (file.size > CONFIG.MAX_FILE_BYTES) {
      showValidation([`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Predictions for both benchmarks are well under 1 MB.`]);
      return;
    }
    let text;
    try { text = await file.text(); }
    catch (e) { if (seq === state.fileSeq) showValidation([`Could not read the file: ${e.message}`]); return; }
    if (seq !== state.fileSeq) return;
    state.pendingFile = { name: file.name, text };
    runValidation(file.name, text);
  }

  function setSubmitting(on) {
    state.submitting = on;
    el.btnSubmitUpload.disabled = on;
    el.btnCancelUpload.disabled = on;
    el.btnCloseUpload.disabled = on;
    if (on) el.btnSubmitUpload.textContent = "Submitting…";
    else el.btnSubmitUpload.textContent = state.pending ? submitLabel(state.pending) : "Submit";
  }

  async function submitPending() {
    if (!state.pending || state.submitting) return;
    setSubmitting(true);
    try {
      const res = await api("PUT", "/api/submissions/mine", state.pending);
      setSubmitting(false);
      el.uploadDialog.close();
      await refresh({ silent: false });
      const scored = (res.submissions || []).map((x) => `Benchmark ${x.benchmark}: ${fmtPct(x.metric)}`).join(", ");
      showToast(scored ? `Scored. ${scored}` : "Submission recorded.", "success");
    } catch (err) {
      setSubmitting(false);
      const details = err.details && err.details.length ? err.details : [err.message];
      if (err.status === 429) {
        // Nothing looked at the file this time, so everything the box already
        // said about it is still true. The wait goes on top; the rest stays.
        const kept = fileProblems.length
          ? ["Still to fix from the last attempt:"].concat(fileProblems) : [];
        if (el.uploadDialog.open) {
          showValidation(details.concat(kept), { title: "Not sent. The site is busy:", keep: true });
        } else {
          showToast(`Submission failed: ${details[0]}`, "error");
        }
        el.btnSubmitUpload.disabled = false;
        return;
      }
      const title = err.status === 422 ? "The server could not score this file:"
        : err.status === 409 || err.status === 507 ? "Submission refused:" : "Could not submit:";
      if (el.uploadDialog.open) showValidation(details, { title });
      else showToast(`Submission failed: ${details[0]}`, "error");
      el.btnSubmitUpload.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Delete (both benchmarks at once)
  // ---------------------------------------------------------------------------
  // A submission file always carries both benchmarks, so the caller's rows live
  // and die together: one DELETE clears the lot.
  let deleteOpener = null;
  function openDeleteDialog(opener) {
    deleteOpener = opener || null;
    el.deleteTitle.textContent = "Delete your results?";
    el.deleteHint.textContent = "This removes your rows from both ladders, Benchmark A and Benchmark B. You can upload a new file at any time.";
    if (!el.deleteDialog.open) el.deleteDialog.showModal();
  }
  async function deleteMine() {
    el.btnConfirmDelete.disabled = true;
    try {
      await api("DELETE", "/api/submissions/mine");
      el.deleteDialog.close();
      await refresh({ silent: false });
      showToast("Your results were deleted.", "success");
    } catch (err) {
      el.deleteDialog.close();
      // Same reason as the load path: err.message is the summary, details is
      // the sentence a student can act on ("Wait 43 seconds and try again.").
      const details = err.details && err.details.length ? err.details : [err.message];
      showToast(`Delete failed: ${details[0]}`, "error");
      refresh();
    } finally {
      el.btnConfirmDelete.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  function showToast(message, kind = "") {
    el.toast.className = `toast show ${kind}`.trim();
    el.toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.classList.remove("show"); }, 4500);
  }

  // ---------------------------------------------------------------------------
  // Ladder sections from the template
  // ---------------------------------------------------------------------------
  function initLadders() {
    const template = $("#ladder-template");
    for (const bench of BENCHMARKS) {
      const section = $(`#benchmark-${bench.key.toLowerCase()}`);
      section.appendChild(template.content.cloneNode(true));
      section.querySelector(".ladder-title").textContent = bench.label;
      section.querySelector(".ladder-sub").textContent = bench.sub;
      section.querySelector(".table-scroll").setAttribute("aria-label", `${bench.label} ladder table`);
      const btnUpload = section.querySelector(".ladder-upload");
      btnUpload.textContent = "Upload predictions";
      btnUpload.addEventListener("click", () => openUploadDialog(btnUpload));
      const dom = {
        section,
        tbody: section.querySelector("tbody"),
        headers: section.querySelectorAll("th[data-key]"),
        countNote: section.querySelector(".ladder-count"),
        btnLabelAll: section.querySelector(".btn-label-all"),
      };
      ladders[bench.key] = dom;
      plots[bench.key] = {
        host: section.querySelector(".plot-host"),
        empty: section.querySelector(".plot-placeholder"),
        tip: section.querySelector(".plot-tooltip"),
        index: new Map(),
        lastKey: null,
      };
      plots[bench.key].empty.textContent = `The plot appears with the first ${bench.label} result.`;
      wireSort(dom.headers, bench.key, () => renderLadderTable(bench.key));
      dom.btnLabelAll.addEventListener("click", () => {
        const total = allPersonKeys();
        const all = total.size > 0 && state.labeled.size >= total.size;
        if (all) state.labeled.clear();
        else for (const pk of total) state.labeled.add(pk);
        updateLabelAllButtons();
        syncCheckboxes();
        relayoutNames();
      });
      dom.tbody.addEventListener("mouseover", (e) => {
        const tr = e.target.closest("tr[data-pk]");
        if (tr) plotSpotlight(tr.dataset.pk, true, bench.key);
      });
      dom.tbody.addEventListener("mouseleave", () => plotSpotlight(spotlightPk, false));
    }
    el.overallBody.addEventListener("mouseover", (e) => {
      const tr = e.target.closest("tr[data-pk]");
      if (tr) plotSpotlight(tr.dataset.pk, true, null);
    });
    el.overallBody.addEventListener("mouseleave", () => plotSpotlight(spotlightPk, false));
  }

  // ---------------------------------------------------------------------------
  // Benchmark tabs (the Overall table stays pinned above them)
  //
  // URL policy: the address bar is written only by a real user action. Loading
  // the page never rewrites it, so "/" stays "/". Clicking or arrowing to a tab
  // is navigation a reader expects Back to undo, so it gets its own history
  // entry via pushState and popstate/hashchange put the widget back in sync.
  // ---------------------------------------------------------------------------
  let activeTab = null;
  const tabHash = (bench) => "#benchmark-" + bench.toLowerCase();
  function benchFromHash(hash) {
    const m = /^#benchmark-([a-z])$/i.exec(hash || "");
    const key = m ? m[1].toUpperCase() : null;
    return BENCH_KEYS.includes(key) ? key : null;   // #benchmark-z falls through
  }

  // Reflect a benchmark in the widget. Never touches history: callers decide.
  function activateTab(bench, focus) {
    if (!BENCH_KEYS.includes(bench)) bench = BENCH_KEYS[0];
    activeTab = bench;
    for (const key of BENCH_KEYS) {
      const selected = key === bench;
      el.tabs[key].setAttribute("aria-selected", String(selected));
      el.tabs[key].tabIndex = selected ? 0 : -1;
      ladders[key].section.hidden = !selected;
    }
    if (focus) el.tabs[bench].focus();
    renderPlot(bench);   // the panel was display:none, so its plot deferred
  }

  // A user picked this tab: reflect it and record it in history.
  function selectTab(bench, focus) {
    const changed = bench !== activeTab;
    activateTab(bench, focus);
    if (!changed) return;   // re-clicking the open tab must not stack entries
    try { history.pushState({ bench }, "", tabHash(bench)); } catch (_) { /* ignore */ }
  }

  // A deep link lands on a panel that was `hidden` while the browser did its
  // own scroll-to-fragment, so the browser could not scroll to it. Do it here,
  // once at boot and once more after the first data render moved things down.
  let deepLinkPending = false;
  function scrollToTabs() {
    const tablist = $(".bench-tabs");
    if (tablist && typeof tablist.scrollIntoView === "function") tablist.scrollIntoView({ block: "start" });
  }

  function initTabs() {
    for (const key of BENCH_KEYS) {
      el.tabs[key].addEventListener("click", () => selectTab(key, false));
      el.tabs[key].addEventListener("keydown", (e) => {
        const i = BENCH_KEYS.indexOf(key);
        const last = BENCH_KEYS.length - 1;
        let next = null;
        if (e.key === "ArrowRight") next = BENCH_KEYS[(i + 1) % BENCH_KEYS.length];
        else if (e.key === "ArrowLeft") next = BENCH_KEYS[(i + last) % BENCH_KEYS.length];
        else if (e.key === "Home") next = BENCH_KEYS[0];
        else if (e.key === "End") next = BENCH_KEYS[last];
        if (next === null) return;         // everything else keeps its default
        e.preventDefault();
        selectTab(next, true);             // focus follows selection
      });
    }

    // Back / Forward, and any link or hand edit that changes the fragment.
    const tablist = $(".bench-tabs");
    const syncFromURL = () => {
      // Follow focus only when the reader is already inside the tab strip, so
      // selection and focus stay together there; a Back press from anywhere
      // else on the page must not yank focus up to the tabs.
      const inside = !!(tablist && tablist.contains(document.activeElement));
      const bench = benchFromHash(window.location.hash);
      if (bench) { activateTab(bench, inside); return; }
      // Only an empty fragment means "the default tab". Other anchors
      // (#overall, #main, #upload) are ordinary page anchors: leave the widget
      // where the reader put it.
      if (!window.location.hash) activateTab(BENCH_KEYS[0], inside);
    };
    window.addEventListener("popstate", syncFromURL);
    window.addEventListener("hashchange", syncFromURL);

    // First paint: read the URL, write nothing back to it. A missing or
    // unknown fragment simply leaves the default tab selected.
    const deep = benchFromHash(window.location.hash);
    activateTab(deep || BENCH_KEYS[0], false);
    if (deep) { deepLinkPending = true; scrollToTabs(); }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function wireEvents() {
    wireSort(el.overallTable.querySelectorAll("th[data-key]"), "overall", renderOverallTable);

    el.btnOpenUpload.addEventListener("click", () => openUploadDialog(el.btnOpenUpload));
    el.btnCloseUpload.addEventListener("click", () => el.uploadDialog.close());
    el.btnCancelUpload.addEventListener("click", () => el.uploadDialog.close());
    el.uploadDialog.addEventListener("close", () => {
      restoreFocus(uploadOpener, el.btnOpenUpload);
      uploadOpener = null;
      dropUploadHash();
    });
    el.deleteDialog.addEventListener("close", () => {
      restoreFocus(deleteOpener, el.btnOpenUpload);
      deleteOpener = null;
    });
    el.btnSubmitUpload.addEventListener("click", submitPending);
    el.fileInput.addEventListener("change", () => {
      const file = el.fileInput.files[0];
      el.fileInput.value = "";
      handleFile(file);
    });
    $("#upload-form").addEventListener("submit", (e) => e.preventDefault());

    ["dragenter", "dragover"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); el.dropzone.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); el.dropzone.classList.remove("dragover");
    }));
    el.dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(file);
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    el.btnCancelDelete.addEventListener("click", () => el.deleteDialog.close());
    el.btnConfirmDelete.addEventListener("click", deleteMine);

    for (const dlg of [el.uploadDialog, el.deleteDialog]) {
      dlg.addEventListener("click", (e) => { if (e.target === dlg && !state.submitting) dlg.close(); });
    }
    el.uploadDialog.addEventListener("cancel", (e) => { if (state.submitting) e.preventDefault(); });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { for (const bench of BENCH_KEYS) renderPlot(bench); }, 150);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() >= state.pollAfter) refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Deadline countdown
  // ---------------------------------------------------------------------------
  // Submissions close at the end of 10 September 2026, Czech time. September is
  // CEST (UTC+2), so local midnight is 22:00 UTC — one instant for everyone.
  const DEADLINE_MS = Date.UTC(2026, 8, 10, 22, 0, 0);

  function startCountdown() {
    const card = $("#countdown-card");
    const num = { d: $("#cd-days"), h: $("#cd-hours"), m: $("#cd-mins"), s: $("#cd-secs") };
    if (!card || !num.d || !num.h || !num.m || !num.s) return;
    const pad = (n) => String(n).padStart(2, "0");
    let timer = null;
    const tick = () => {
      const left = Math.floor((DEADLINE_MS - Date.now()) / 1000);
      if (left < 0) {
        $("#countdown-label").textContent = "Submissions are closed";
        $("#deadline-countdown").hidden = true;
        $("#countdown-sub").textContent = "The deadline was 10 September 2026";
        if (el.btnOpenUpload) {
          el.btnOpenUpload.disabled = true;
          el.btnOpenUpload.title = "The deadline was 10 September 2026";
        }
        if (timer) clearInterval(timer);
        return;
      }
      num.d.textContent = String(Math.floor(left / 86400));
      num.h.textContent = pad(Math.floor(left / 3600) % 24);
      num.m.textContent = pad(Math.floor(left / 60) % 60);
      num.s.textContent = pad(left % 60);
    };
    tick();
    if (Date.now() < DEADLINE_MS) timer = setInterval(tick, 1000);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  initLadders();
  wireEvents();
  initTabs();
  if ((window.location.hash || "").toLowerCase() === UPLOAD_HASH) openUploadDialog(el.btnOpenUpload);
  renderMyStatus();
  refresh({ silent: false });
  scheduleRefresh();
  startCountdown();
  if (document.fonts) {
    const remeasure = () => { for (const bench of BENCH_KEYS) { plots[bench].lastKey = null; renderPlot(bench); } };
    if (document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(remeasure);
    if (document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", remeasure);
  }

  // exposed for debugging / tests in the console
  window.Leaderboard = { parseSubmissionFile, computeRanks, overallStandings, plotLayout, placeLabels, CONFIG };
})();
