/* Ostr-AI 2026 leaderboard — front-end logic (no dependencies).
 *
 * Two benchmark ladders (A, B) + an overall standing, per the Efficient Intent
 * Classification Challenge. Rows come from /api/submissions; a row's ladder
 * score S = 100*accuracy - log2(latency_ms) is computed by the server.
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
    MAX_ABS_NUMBER: 1e15,
    MAX_FILE_BYTES: 8 * 1024 * 1024,
    TEST_ROWS: { A: 3080, B: 4500 },
    LATENCY_FLOOR_MS: 0.01,   // clamp for the log axis only
  };
  const BENCHMARKS = [
    { key: "A", label: "Benchmark A", sub: "77 intents · one service domain", dotClass: "" },
    { key: "B", label: "Benchmark B", sub: "150 intents · ten service domains", dotClass: "bench-b" },
  ];
  const BENCH_KEYS = BENCHMARKS.map((b) => b.key);

  const PRED_FIELDS = ["benchmark", "id", "intent"];

  const TOKEN_KEY = "ostrai_owner_token";
  const NAME_KEY = "ostrai_name";

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
    nameInput: $("#name-input"),
    latencyInputs: {},
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

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    rows: [],                       // all rows from the server
    ladders: { A: [], B: [] },      // ranked rows per benchmark
    overall: [],                    // ranked overall standings
    mine: { A: null, B: null },     // this browser's row per benchmark
    labeled: new Set(),             // person_keys whose names show on BOTH plots
    seededSelf: false,
    refreshSeq: 0,
    fileSeq: 0,
    submitting: false,
    pending: null,                  // validated entries waiting for submit
    pendingFile: null,              // {name, text} of the parsed file
    deleteBench: null,
    statusKey: null,
    views: {},                      // per-table sort state + caches, filled below
  };
  for (const key of ["overall", "A", "B"]) {
    state.views[key] = { sortKey: "rank", sortDir: "asc", lastTableKey: null };
  }
  const ladders = {};               // per-benchmark DOM refs, filled by initLadders()
  const plots = {};                 // per-benchmark plot state {host, empty, tip, index, lastKey}

  // ---------------------------------------------------------------------------
  // Identity (owner token in localStorage)
  // ---------------------------------------------------------------------------
  function randomToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const TOKEN_OK = (t) => typeof t === "string" && /^[A-Za-z0-9-]{16,64}$/.test(t);
  let storageOk = true;
  function getOwnerToken() {
    let token = null;
    try { token = localStorage.getItem(TOKEN_KEY); } catch (_) { storageOk = false; }
    if (!TOKEN_OK(token)) {
      token = randomToken();
      try {
        localStorage.setItem(TOKEN_KEY, token);
        storageOk = localStorage.getItem(TOKEN_KEY) === token;
      } catch (_) { storageOk = false; }
    }
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
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Parsing: CSV / JSON  ->  1-2 entries with the canonical keys
  // ---------------------------------------------------------------------------
  const stripBOM = (s) => s.replace(/^\uFEFF/, "");
  const normalizeHeader = (h) => stripBOM(String(h)).toLowerCase().replace(/[^a-z0-9]/g, "");
  const CANONICAL_BY_NORMALIZED = {
    benchmark: "benchmark", bench: "benchmark", project: "benchmark", task: "benchmark",
    id: "id", messageid: "id", exampleid: "id", testid: "id",
    intent: "intent", label: "intent", category: "intent", prediction: "intent", predictedintent: "intent",
  };
  // Headers from the OLD schema get a pointed error instead of silent misreads.
  const OLD_SCHEMA = new Set(["metric", "accuracy", "acc", "latencyms", "latency", "avgtimes", "name"]);
  const OLD_SCHEMA_MSG = "This looks like the old results format. Upload your predictions now: one row per test message with the columns benchmark, id, intent. Your name and speed are asked for below.";

  function normalizeBenchmark(v) {   // mirrors app.py normalize_benchmark
    if (typeof v !== "string") return null;
    const key = v.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const b of BENCH_KEYS) {
      const low = b.toLowerCase();
      if ([low, `benchmark${low}`, `bench${low}`, `project${low}`].includes(key)) return b;
    }
    return null;
  }

  function detectDelimiter(headerLine) {
    let best = ",", bestCount = -1;
    for (const d of [",", ";", "\t"]) {
      const n = headerLine.split(d).length - 1;
      if (n > bestCount) { best = d; bestCount = n; }
    }
    return best;
  }

  // Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF).
  function parseCSV(text, delimiter) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += c;
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ""));
  }

  function parseNumberString(raw) {
    const s = String(raw).trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return s;
    return Number(s);
  }

  function rowsFromCSV(text) {
    text = stripBOM(text);
    const headerLine = text.split(/\r?\n/).find((l) => l.trim() !== "") || "";
    const rows = parseCSV(text, detectDelimiter(headerLine));
    if (rows.length === 0) return { errors: ["The file is empty."] };
    if (rows.length < 2) return { errors: ["The file has a header but no predictions."] };

    const header = rows[0].map((h) => h.trim());
    const keys = header.map((h) => {
      const norm = normalizeHeader(h);
      return CANONICAL_BY_NORMALIZED[norm] || (OLD_SCHEMA.has(norm) ? "__old__" : null);
    });
    if (keys.includes("__old__")) return { errors: [OLD_SCHEMA_MSG] };
    const missing = PRED_FIELDS.filter((f) => !keys.includes(f));
    if (missing.length) {
      return { errors: [`Missing column(s): ${missing.join(", ")}. The file needs benchmark, id and intent.`] };
    }
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const values = rows[r];
      if (values.length !== header.length) {
        return { errors: [`Row ${r} has ${values.length} value(s) but the header has ${header.length} column(s).`] };
      }
      const obj = {};
      keys.forEach((k, i) => { if (k) obj[k] = values[i].trim(); });
      out.push(obj);
    }
    return { rows: out, errors: [] };
  }

  function rowsFromJSON(text) {
    let data;
    try { data = JSON.parse(stripBOM(text)); }
    catch (e) { return { errors: [`Invalid JSON: ${e.message}`] }; }
    if (!Array.isArray(data)) return { errors: ["The JSON must be an array of {benchmark, id, intent} objects."] };
    if (!data.length) return { errors: ["The file is empty."] };
    const out = [];
    for (const item of data) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { errors: ["Every entry must be an object with benchmark, id and intent."] };
      }
      const obj = {};
      let sawOld = false;
      for (const [k, v] of Object.entries(item)) {
        const norm = normalizeHeader(k);
        const key = CANONICAL_BY_NORMALIZED[norm];
        if (!key) { if (OLD_SCHEMA.has(norm)) sawOld = true; continue; }
        obj[key] = typeof v === "string" ? v.trim() : v;
      }
      if (sawOld && obj.id === undefined) return { errors: [OLD_SCHEMA_MSG] };
      out.push(obj);
    }
    return { rows: out, errors: [] };
  }

  // Group prediction rows per benchmark and check them before anything is sent.
  function parseSubmissionFile(name, text) {
    const lower = name.toLowerCase();
    let parsed;
    if (lower.endsWith(".json")) parsed = rowsFromJSON(text);
    else if (lower.endsWith(".csv") || lower.endsWith(".tsv")) parsed = rowsFromCSV(text);
    else return { clean: null, errors: ["Unsupported file type: upload a .csv, .tsv or .json file."] };
    if (!parsed.rows) return { clean: null, errors: parsed.errors };

    const byBench = {};
    const errors = [];
    const badBench = new Set();
    for (const row of parsed.rows) {
      const bench = normalizeBenchmark(String(row.benchmark ?? ""));
      if (!bench) { badBench.add(String(row.benchmark ?? "(empty)").slice(0, 20)); continue; }
      const id = Number(row.id);
      if (!Number.isInteger(id)) { errors.push(`Benchmark ${bench}: '${row.id}' is not a whole-number id.`); break; }
      const intent = String(row.intent ?? "").trim();
      if (!intent) { errors.push(`Benchmark ${bench}: id ${id} has no intent.`); break; }
      (byBench[bench] = byBench[bench] || []).push({ id, intent });
    }
    if (badBench.size) {
      errors.push(`The benchmark column must say A or B, found ${[...badBench].slice(0, 3).map((b) => `'${b}'`).join(", ")}.`);
    }
    const benches = Object.keys(byBench).sort();
    if (!errors.length && !benches.length) errors.push("No predictions found in the file.");
    for (const bench of benches) {
      const rows = byBench[bench];
      const ids = new Set(rows.map((r) => r.id));
      if (ids.size !== rows.length) {
        errors.push(`Benchmark ${bench}: ${rows.length - ids.size} duplicate id(s). Predict each test message once.`);
      }
      const expected = CONFIG.TEST_ROWS[bench];
      if (expected && rows.length !== expected) {
        errors.push(`Benchmark ${bench}: ${rows.length.toLocaleString()} predictions, but test.tsv has ${expected.toLocaleString()} messages. Predict every row.`);
      }
    }
    if (errors.length) return { clean: null, errors };
    return { clean: benches.map((bench) => ({ benchmark: bench, predictions: byBench[bench] })), errors: [] };
  }

  // ---------------------------------------------------------------------------
  // Validation (keep in sync with app.py validate_entry / validate_submission)
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Scoring & standings
  // ---------------------------------------------------------------------------
  const fmtPct = (x) => (x === null || x === undefined) ? "—" : (x * 100).toFixed(2) + " %";
  const fmtLatency = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n)) return "—";
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
      (b.metric - a.metric) || (a.latency_ms - b.latency_ms) ||
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
    const us = rows.map((r) => Math.log10(clampL(r.latency_ms)));
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
      x: xPos(r.latency_ms),
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
    P.tip.textContent = `${p.row.name}: ${fmtPct(p.row.metric)}, ${fmtLatency(p.row.latency_ms)} ms/ex`;
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
    const key = width + "|" + rows.map((r) => `${r.id},${r.name},${r.metric},${r.latency_ms},${r.mine ? 1 : 0}`).join(";");
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
  // Tables
  // ---------------------------------------------------------------------------
  function td(className, text) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const DEFAULT_DIR = { metric: "desc", latency_ms: "asc", name: "asc", submitted_at: "desc", rank: "asc", accA: "desc", accB: "desc", accFinal: "desc" };

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
      rows.map((r) => `${r.id},${r.name},${r.metric},${r.latency_ms},${r.rank},${r.mine ? 1 : 0},${r.submitted_at}`).join(";");
    if (key === view.lastTableKey) return;
    view.lastTableKey = key;

    const frag = document.createDocumentFragment();
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "placeholder-row";
      const cell = td(null, `No results on Benchmark ${bench} yet. Be the first to upload one.`);
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
      tr.appendChild(td("num", fmtLatency(r.latency_ms)));
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
    const rows = sortView(state.overall, view);
    const key = `${view.sortKey}|${view.sortDir}|` +
      rows.map((r) => `${r.pk},${r.name},${r.accA},${r.accB},${r.accFinal},${r.rank},${r.mine ? 1 : 0}`).join(";");
    if (key === view.lastTableKey) return;
    view.lastTableKey = key;

    const frag = document.createDocumentFragment();
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "placeholder-row";
      const cell = td(null, "The overall standing appears with the first result.");
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
  function myOverall() {
    return state.overall.find((p) => p.mine) || null;
  }

  function renderMyStatus() {
    if (el.myStatus.contains(document.activeElement)) return;
    const mA = state.mine.A, mB = state.mine.B;
    const ov = myOverall();
    const key = [mA && `${mA.id},${mA.metric},${mA.rank}`, mB && `${mB.id},${mB.metric},${mB.rank}`,
      ov && `${ov.rank},${ov.accFinal}`, storageOk].join("|");
    if (key === state.statusKey) return;
    state.statusKey = key;

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
        if (m) {
          const txt = document.createElement("span");
          txt.append(`${fmtPct(m.metric)} · #${m.rank} `);
          slot.appendChild(txt);
          const rep = document.createElement("button");
          rep.type = "button";
          rep.className = "btn btn-ghost btn-sm";
          rep.textContent = "Replace";
          rep.addEventListener("click", () => openUploadDialog());
          const del = document.createElement("button");
          del.type = "button";
          del.className = "btn btn-ghost btn-sm";
          del.textContent = "Delete";
          del.addEventListener("click", () => openDeleteDialog(bench));
          slot.append(rep, del);
        } else {
          const txt = document.createElement("span");
          txt.className = "slot-missing";
          txt.textContent = "no result, counts as 0 ";
          slot.appendChild(txt);
          const up = document.createElement("button");
          up.type = "button";
          up.className = "btn btn-ghost btn-sm";
          up.textContent = "Upload";
          up.addEventListener("click", () => openUploadDialog());
          slot.appendChild(up);
        }
        box.appendChild(slot);
      }
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
      warn.textContent = "Your browser blocks site storage, so after a reload you will not be able to edit or delete your results.";
      box.appendChild(warn);
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
      const data = await api("GET", "/api/submissions");
      if (seq !== state.refreshSeq) return;
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
      renderOverallTable();
      for (const bench of BENCH_KEYS) {
        renderLadderTable(bench);
        renderPlot(bench);
      }
      renderMyStatus();
      renderStats();
      updateLabelAllButtons();
    } catch (err) {
      if (seq !== state.refreshSeq) return;
      if (!silent) showToast(`Could not load the leaderboard: ${err.message}`, "error");
      else el.statUpdated.textContent = "offline";
    }
  }

  function scheduleRefresh() {
    setInterval(() => {
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
    el.latencyInputs = {};
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
    let remembered = "";
    try { remembered = localStorage.getItem(NAME_KEY) || ""; } catch (_) { /* ignore */ }
    el.nameInput.value = remembered || (state.mine.A || state.mine.B || {}).name || "";
    el.dialogNote.textContent = storageOk
      ? "Your browser remembers this upload so you can replace or delete it later."
      : "Storage is blocked in this browser, so you will not be able to edit these results after a reload.";
  }

  function openUploadDialog() {
    resetUploadDialog();
    el.uploadDialog.showModal();
  }

  function showValidation(errors, { title = null, okMessage = "" } = {}) {
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
    heading.textContent = "Worth a second look (you can still submit):";
    const ul = document.createElement("ul");
    for (const w of warnings) { const li = document.createElement("li"); li.textContent = w; ul.appendChild(li); }
    el.warnBox.append(heading, ul);
  }

  function collectWarnings(entries) {
    const warnings = [];
    if (entries.length === 1) {
      const other = BENCH_KEYS.find((b) => b !== entries[0].benchmark);
      if (!state.mine[other]) {
        warnings.push(`This file covers Benchmark ${entries[0].benchmark} only. Benchmark ${other} still counts as 0 in the overall standing.`);
      }
    }
    return warnings;
  }

  function readName() {
    return (el.nameInput.value || "").trim().replace(/\s+/g, " ").slice(0, CONFIG.MAX_NAME_LEN);
  }

  function readLatency(bench) {
    const input = el.latencyInputs[bench];
    if (!input) return NaN;
    const raw = (input.value || "").trim().replace(",", ".");
    return raw === "" ? NaN : Number(raw);
  }

  // Submit is enabled only once the file, the name and every speed are in place.
  function refreshSubmitState() {
    if (!state.pending) { el.btnSubmitUpload.disabled = true; return; }
    let problem = "";
    if (!readName()) problem = "Type the name that should appear on the board.";
    if (!problem) {
      for (const e of state.pending) {
        const ms = readLatency(e.benchmark);
        if (!Number.isFinite(ms) || ms < 0) { problem = `Type your milliseconds per message for Benchmark ${e.benchmark}.`; break; }
      }
    }
    el.dialogNote.textContent = problem || (storageOk
      ? "Your browser remembers this upload so you can replace or delete it later."
      : "Storage is blocked in this browser, so you will not be able to edit these results after a reload.");
    el.btnSubmitUpload.disabled = Boolean(problem) || state.submitting;
    if (!state.submitting) el.btnSubmitUpload.textContent = submitLabel(state.pending);
  }

  function showPreview(entries) {
    el.previewEntries.replaceChildren();
    el.latencyInputs = {};
    for (const e of entries) {
      const wrap = document.createElement("div");
      wrap.className = "preview-row";
      const h = document.createElement("h4");
      h.textContent = `Benchmark ${e.benchmark}`;
      wrap.appendChild(h);

      const dl = document.createElement("dl");
      dl.className = "preview-grid";
      const dt = document.createElement("dt"); dt.textContent = "Predictions";
      const dd = document.createElement("dd");
      dd.textContent = `${e.predictions.length.toLocaleString()} rows, ` +
        `${new Set(e.predictions.map((p) => p.intent)).size} distinct categories`;
      const dt2 = document.createElement("dt"); dt2.textContent = "Speed";
      const dd2 = document.createElement("dd");
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.01";
      input.min = "0";
      input.className = "latency-input";
      input.placeholder = "7.02";
      input.setAttribute("aria-label", `Milliseconds per message for Benchmark ${e.benchmark}`);
      input.addEventListener("input", refreshSubmitState);
      el.latencyInputs[e.benchmark] = input;
      const unit = document.createElement("span");
      unit.className = "latency-unit";
      unit.textContent = "ms per message";
      dd2.append(input, unit);
      dl.append(dt, dd, dt2, dd2);
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
    showValidation([], { okMessage: `Read ${rows.toLocaleString()} predictions. Add your name and speed below, then press Submit.` });
    showWarnings(collectWarnings(clean));
    showPreview(clean);
    refreshSubmitState();
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
      showValidation(["No file received. Drop a single .csv or .json file."]);
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
    const name = readName();
    try { localStorage.setItem(NAME_KEY, name); } catch (_) { /* ignore */ }
    const body = state.pending.map((e) => ({
      name,
      benchmark: e.benchmark,
      latency_ms: readLatency(e.benchmark),
      predictions: e.predictions,
    }));
    setSubmitting(true);
    try {
      const res = await api("PUT", "/api/submissions/mine", body);
      setSubmitting(false);
      el.uploadDialog.close();
      await refresh({ silent: false });
      const scored = (res.submissions || []).map((x) => `Benchmark ${x.benchmark}: ${fmtPct(x.metric)}`).join(", ");
      showToast(scored ? `Scored. ${scored}` : "Submission recorded.", "success");
    } catch (err) {
      setSubmitting(false);
      const details = err.details && err.details.length ? err.details : [err.message];
      const title = err.status === 422 ? "The server could not score this file:"
        : err.status === 409 || err.status === 507 ? "Submission refused:" : "Could not submit:";
      if (el.uploadDialog.open) showValidation(details, { title });
      else showToast(`Submission failed: ${details[0]}`, "error");
      refreshSubmitState();
    }
  }

  // ---------------------------------------------------------------------------
  // Delete (per benchmark)
  // ---------------------------------------------------------------------------
  function openDeleteDialog(bench) {
    state.deleteBench = bench;
    el.deleteTitle.textContent = `Delete your Benchmark ${bench} result?`;
    el.deleteHint.textContent = `This removes your row from the Benchmark ${bench} ladder (the other benchmark is untouched). You can upload a new file at any time.`;
    el.deleteDialog.showModal();
  }
  async function deleteMine() {
    const bench = state.deleteBench;
    el.btnConfirmDelete.disabled = true;
    try {
      await api("DELETE", `/api/submissions/mine/${bench}`);
      el.deleteDialog.close();
      await refresh({ silent: false });
      showToast(`Your Benchmark ${bench} result was deleted.`, "success");
    } catch (err) {
      el.deleteDialog.close();
      showToast(`Delete failed: ${err.message}`, "error");
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
      btnUpload.addEventListener("click", () => openUploadDialog());
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
  // ---------------------------------------------------------------------------
  let activeTab = "A";
  function activateTab(bench, focus) {
    activeTab = bench;
    for (const key of BENCH_KEYS) {
      const selected = key === bench;
      el.tabs[key].setAttribute("aria-selected", String(selected));
      el.tabs[key].tabIndex = selected ? 0 : -1;
      ladders[key].section.hidden = !selected;
    }
    if (focus) el.tabs[bench].focus();
    try { history.replaceState(null, "", "#benchmark-" + bench.toLowerCase()); } catch (_) { /* ignore */ }
    renderPlot(bench);   // the panel was display:none, so its plot deferred
  }
  function initTabs() {
    for (const key of BENCH_KEYS) {
      el.tabs[key].addEventListener("click", () => activateTab(key, false));
      el.tabs[key].addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const other = BENCH_KEYS[(BENCH_KEYS.indexOf(key) + 1) % BENCH_KEYS.length];
        activateTab(other, true);
      });
    }
    const fromHash = (window.location.hash || "").replace("#benchmark-", "").toUpperCase();
    activateTab(BENCH_KEYS.includes(fromHash) ? fromHash : "A", false);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function wireEvents() {
    wireSort(el.overallTable.querySelectorAll("th[data-key]"), "overall", renderOverallTable);

    el.btnOpenUpload.addEventListener("click", () => openUploadDialog());
    el.nameInput.addEventListener("input", refreshSubmitState);
    el.btnCloseUpload.addEventListener("click", () => el.uploadDialog.close());
    el.btnCancelUpload.addEventListener("click", () => el.uploadDialog.close());
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
      if (document.visibilityState === "visible") refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  initLadders();
  wireEvents();
  initTabs();
  renderMyStatus();
  refresh({ silent: false });
  scheduleRefresh();
  if (document.fonts) {
    const remeasure = () => { for (const bench of BENCH_KEYS) { plots[bench].lastKey = null; renderPlot(bench); } };
    if (document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(remeasure);
    if (document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", remeasure);
  }

  // exposed for debugging / tests in the console
  window.Leaderboard = { parseSubmissionFile, computeRanks, overallStandings, plotLayout, placeLabels, CONFIG };
})();
