/* Ostr-AI 2026 leaderboard — front-end logic (no dependencies).
 *
 * - Fetches rows from /api/submissions and renders a sortable table.
 * - Parses & validates a .csv / .json submission entirely in the browser,
 *   then PUTs it to /api/submissions/mine.
 * - Identity = random owner token in localStorage. The server marks rows that
 *   belong to this token with `mine: true`, so the owner can re-upload or delete.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    METRIC_LABEL: "Accuracy",        // shown in the column header and status line
    METRIC_HIGHER_IS_BETTER: true,   // rank #1 = highest metric (set false for loss/error metrics)
    REFRESH_MS: 10000,               // background refresh interval
    MAX_NAME_LEN: 80,
    MAX_ABS_NUMBER: 1e15,
    MAX_FILE_BYTES: 64 * 1024,
  };

  // Keep in sync with app.py (validate_entry) and submit_readme.md
  const FIELDS = ["name", "metric", "avg_time_s"];
  const STRING_FIELDS = ["name"];
  const NUMBER_FIELDS = ["metric", "avg_time_s"];
  const NON_NEGATIVE_FIELDS = ["avg_time_s"];
  const FIELD_LABELS = {
    name: "Name", metric: CONFIG.METRIC_LABEL, avg_time_s: "Avg time (s)",
  };

  const TOKEN_KEY = "ostrai_owner_token";

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    tbody: $("#leaderboard-body"),
    headers: Array.from(document.querySelectorAll("#leaderboard thead th[data-key]")),
    statCount: $("#stat-count"),
    statUpdated: $("#stat-updated"),
    myStatus: $("#my-status"),
    footnote: $("#table-footnote"),
    metricHeader: $("#metric-header"),
    btnOpenUpload: $("#btn-open-upload"),
    btnLabelAll: $("#btn-label-all"),
    uploadDialog: $("#upload-dialog"),
    uploadTitle: $("#upload-title"),
    btnCloseUpload: $("#btn-close-upload"),
    btnCancelUpload: $("#btn-cancel-upload"),
    btnSubmitUpload: $("#btn-submit-upload"),
    fileInput: $("#file-input"),
    dropzone: $("#dropzone"),
    dropzoneFile: $("#dropzone-file"),
    validationBox: $("#validation-box"),
    previewBox: $("#preview-box"),
    previewGrid: $("#preview-grid"),
    dialogNote: $("#dialog-note"),
    deleteDialog: $("#delete-dialog"),
    btnCancelDelete: $("#btn-cancel-delete"),
    btnConfirmDelete: $("#btn-confirm-delete"),
    toast: $("#toast"),
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    rows: [],                 // rows from the server, in rank order
    mine: null,               // this browser's row, if any
    sortKey: "rank",
    sortDir: "asc",
    pending: null,            // validated entry waiting to be submitted
    refreshTimer: null,
    labeled: new Set(),       // row ids whose names are drawn on the plot (checkboxes)
    refreshSeq: 0,            // ignore responses of older in-flight refreshes
    fileSeq: 0,               // ignore results of superseded file reads
    submitting: false,        // the upload dialog cannot be dismissed while a PUT is in flight
    statusShape: null,        // "mine|storageOk" shape of #my-status, to update text in place
    statusNodes: null,
    lastTableKey: null,       // skip tbody rebuilds when nothing changed (keeps checkbox focus)
  };

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
  let storageOk = true;      // false when the browser blocks localStorage (private mode, locked-down lab PCs)
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
  // Parsing: CSV / JSON  ->  plain object with the 5 canonical keys
  // ---------------------------------------------------------------------------
  // "Avg time (s)", "avg_time_s", "AVG-TIME-S" all normalize to "avgtimes"
  const stripBOM = (s) => s.replace(/^\uFEFF/, "");
  const normalizeHeader = (h) => stripBOM(String(h)).toLowerCase().replace(/[^a-z0-9]/g, "");
  const CANONICAL_BY_NORMALIZED = {
    ...Object.fromEntries(FIELDS.map((f) => [normalizeHeader(f), f])),
    accuracy: "metric",                       // "Accuracy" column header
    avgtimeexamples: "avg_time_s",            // "Avg time / example (s)"
    avgtimeperexamples: "avg_time_s",
    averagetimeperexamples: "avg_time_s",
    averagetimeperexample: "avg_time_s",
  };

  function detectDelimiter(headerLine) {
    let best = ",", bestCount = -1;
    for (const d of [",", ";", "\t"]) {
      const n = headerLine.split(d).length - 1;
      if (n > bestCount) { best = d; bestCount = n; }
    }
    return best;
  }

  // Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). Returns array of rows (arrays).
  function parseCSV(text, delimiter) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    // drop completely empty lines
    return rows.filter((r) => r.some((v) => v.trim() !== ""));
  }

  function objectFromCSV(text) {
    text = stripBOM(text);
    const headerLine = text.split(/\r?\n/).find((l) => l.trim() !== "") || "";
    const delimiter = detectDelimiter(headerLine);
    const rows = parseCSV(text, delimiter);
    if (rows.length === 0) return { errors: ["The file is empty."] };
    if (rows.length < 2) return { errors: ["Missing data row: the file needs a header line and exactly one data line."] };

    const errors = [];
    if (rows.length > 2) errors.push(`Expected exactly one data row, found ${rows.length - 1}.`);
    const header = rows[0].map((h) => h.trim());
    const values = rows[1].map((v) => v.trim());
    if (values.length !== header.length) {
      errors.push(`The data row has ${values.length} value(s) but the header has ${header.length} column(s). Check the delimiter and quoting.`);
      return { errors };
    }

    const obj = {};
    const unknown = [];
    const seen = new Set();
    header.forEach((h, i) => {
      const key = CANONICAL_BY_NORMALIZED[normalizeHeader(h)];
      if (!key) { unknown.push(h || `(empty column ${i + 1})`); return; }
      if (seen.has(key)) { errors.push(`Duplicate column '${h}'.`); return; }
      seen.add(key);
      obj[key] = NUMBER_FIELDS.includes(key) ? parseNumberString(values[i]) : values[i];
    });
    if (unknown.length) errors.push("Unexpected column(s): " + unknown.map((u) => `'${u}'`).join(", "));
    return { obj, errors };
  }

  // Numbers must use a dot as decimal separator, no thousands separators.
  // Returns a finite number, or the original string so validation can explain the problem.
  function parseNumberString(raw) {
    const s = String(raw).trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return s;
    return Number(s);
  }

  function objectFromJSON(text) {
    let data;
    try { data = JSON.parse(stripBOM(text)); }
    catch (e) { return { errors: [`Invalid JSON: ${e.message}`] }; }
    if (Array.isArray(data)) {
      if (data.length !== 1) return { errors: [`Expected a single object (or an array with exactly one object), found an array of ${data.length}.`] };
      data = data[0];
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { errors: ["The JSON must be an object with the keys name, metric, avg_time_s."] };
    }
    const errors = [];
    const obj = {};
    const unknown = [];
    const seen = new Set();
    for (const [k, v] of Object.entries(data)) {
      const key = CANONICAL_BY_NORMALIZED[normalizeHeader(k)];
      if (!key) { unknown.push(k); continue; }
      if (seen.has(key)) { errors.push(`Duplicate key '${k}'.`); continue; }
      seen.add(key);
      // numeric strings ("0.93") are accepted for number fields as a convenience; everything else as-is
      obj[key] = (NUMBER_FIELDS.includes(key) && typeof v === "string") ? parseNumberString(v) : v;
    }
    if (unknown.length) errors.push("Unexpected key(s): " + unknown.map((u) => `'${u}'`).join(", "));
    return { obj, errors };
  }

  // ---------------------------------------------------------------------------
  // Validation (mirrors app.py:validate_entry)
  // ---------------------------------------------------------------------------
  const describe = (v) => {
    if (v === null) return "null";
    if (Array.isArray(v)) return "a list";
    if (typeof v === "object") return "an object";
    if (typeof v === "string") return `'${v.length > 40 ? v.slice(0, 40) + "…" : v}'`;
    return String(v);
  };

  function validateEntry(obj) {
    const errors = [];
    const clean = {};
    for (const f of STRING_FIELDS) {
      const v = obj[f];
      if (v === undefined) { errors.push(`Missing column '${f}'.`); continue; }
      if (typeof v !== "string") { errors.push(`'${f}' must be text, got ${describe(v)}.`); continue; }
      const s = v.trim().replace(/\s+/g, " ");
      if (!s) { errors.push(`'${f}' must not be empty.`); continue; }
      if (s.length > CONFIG.MAX_NAME_LEN) { errors.push(`'${f}' must be at most ${CONFIG.MAX_NAME_LEN} characters.`); continue; }
      if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(s)) { errors.push(`'${f}' contains invisible or control characters.`); continue; }
      clean[f] = s;
    }
    for (const f of NUMBER_FIELDS) {
      const v = obj[f];
      if (v === undefined) { errors.push(`Missing column '${f}'.`); continue; }
      if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > CONFIG.MAX_ABS_NUMBER) {
        const hint = typeof v === "string" && /\d,\d/.test(v) ? " (use a dot as decimal separator, no thousands separators)" : "";
        errors.push(`'${f}' must be a number such as 0.93, got ${describe(v)}${hint}.`);
        continue;
      }
      if (NON_NEGATIVE_FIELDS.includes(f) && v < 0) { errors.push(`'${f}' must be >= 0.`); continue; }
      if (f === "metric" && (v < 0 || v > 1)) { errors.push("'metric' must be between 0 and 1 — accuracy as a fraction (93.12 % is 0.9312)."); continue; }
      clean[f] = v;
    }
    return { clean: errors.length ? null : clean, errors };
  }

  function parseSubmissionFile(name, text) {
    const lower = name.toLowerCase();
    let parsed;
    if (lower.endsWith(".json")) parsed = objectFromJSON(text);
    else if (lower.endsWith(".csv")) parsed = objectFromCSV(text);
    else return { clean: null, errors: ["Unsupported file type: please upload a .csv or .json file."] };

    const errors = [...parsed.errors];
    if (!parsed.obj) return { clean: null, errors };
    const v = validateEntry(parsed.obj);
    errors.push(...v.errors);
    return { clean: errors.length ? null : v.clean, errors };
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const fmtNumber = (x, maxFrac) => {
    const n = Number(x);
    if (n !== 0 && Math.abs(n) < 10 ** -maxFrac) return n.toExponential(2);   // 0.0004 -> "4.00e-4", never "0"
    return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac, useGrouping: false });
  };
  const fmtMetric = (x) => fmtNumber(x, 6);
  const fmtTime = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return "–";
    if (n === 0) return "0";
    if (Math.abs(n) >= 1) return fmtNumber(n, 3);
    if (Math.abs(n) < 1e-4) return n.toExponential(2);
    return String(+n.toPrecision(3));   // 0.0021 vs 0.0024 stay distinguishable
  };
  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "–";
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  const fmtClock = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // ---------------------------------------------------------------------------
  // Ranking & sorting
  // ---------------------------------------------------------------------------
  // Returns rows sorted by rank (best first) with a `rank` property.
  // Competition ranking: equal metric -> equal rank (1, 2, 2, 4).
  function computeRanks(rows) {
    const dir = CONFIG.METRIC_HIGHER_IS_BETTER ? -1 : 1;
    const sorted = [...rows].sort((a, b) =>
      dir * (a.metric - b.metric) ||                    // better metric first
      (a.avg_time_s - b.avg_time_s) ||                  // tie-break: faster inference
      String(a.submitted_at).localeCompare(String(b.submitted_at)));  // then earlier submission
    let lastRank = 0;
    return sorted.map((r, i) => {
      const prev = sorted[i - 1];
      const rank = prev && prev.metric === r.metric ? lastRank : i + 1;
      lastRank = rank;
      return { ...r, rank };
    });
  }

  function sortRows(rows) {
    const { sortKey, sortDir } = state;
    if (sortKey === "rank" && sortDir === "asc") return rows;   // already in rank order (with tie-breaks)
    const sign = sortDir === "asc" ? 1 : -1;
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
      let c;
      if (typeof a[sortKey] === "number") c = a[sortKey] - b[sortKey];
      else c = collator.compare(String(a[sortKey]), String(b[sortKey]));
      if (c === 0) c = sign * (ia - ib);   // keep rank order among equals, whichever direction
      return sign * c;
    }).map(([r]) => r);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function td(className, text) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function renderTable() {
    const rows = sortRows(state.rows);
    const key = `${state.sortKey}|${state.sortDir}|` +
      rows.map((r) => `${r.id},${r.name},${r.metric},${r.avg_time_s},${r.rank},${r.mine ? 1 : 0},${r.submitted_at}`).join(";");
    if (key === state.lastTableKey) return;
    state.lastTableKey = key;
    const frag = document.createDocumentFragment();
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "placeholder-row";
      const cell = td(null, "No submissions yet — be the first to upload one.");
      cell.colSpan = el.headers.length + 1;
      tr.appendChild(cell);
      frag.appendChild(tr);
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      if (r.mine) tr.classList.add("mine");
      const checkCell = document.createElement("td");
      checkCell.className = "check";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "name-check";
      check.checked = state.labeled.has(r.id);
      check.setAttribute("aria-label", `Show ${r.name} on the plot`);
      check.addEventListener("change", () => setLabeled(r.id, check.checked));
      checkCell.appendChild(check);
      tr.appendChild(checkCell);
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
      tr.appendChild(td("num", fmtMetric(r.metric)));
      tr.appendChild(td("num", fmtTime(r.avg_time_s)));
      const dateCell = td("date", fmtDate(r.submitted_at));
      dateCell.title = r.submitted_at;
      tr.appendChild(dateCell);
      frag.appendChild(tr);
    }
    el.tbody.replaceChildren(frag);

    for (const th of el.headers) {
      const active = th.dataset.key === state.sortKey;
      th.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
    }
    el.footnote.textContent = `Rank is by ${CONFIG.METRIC_LABEL.toLowerCase()} (${CONFIG.METRIC_HIGHER_IS_BETTER ? "higher" : "lower"} is better); equal accuracies share a rank and are listed by average time per example. Click a column header to sort.`;
  }

  function renderMyStatus() {
    const m = state.mine;
    const shape = `${m ? "mine" : "none"}|${storageOk}`;
    const summary = m ? ` — ${CONFIG.METRIC_LABEL.toLowerCase()} ${fmtMetric(m.metric)}, rank #${m.rank}` : "";
    el.btnOpenUpload.textContent = m ? "Edit / re-upload" : "Upload submission";

    if (shape === state.statusShape && state.statusNodes) {
      // same structure: update the text only (keeps keyboard focus on Edit/Delete, no live-region rebuild)
      if (m) {
        state.statusNodes.name.textContent = m.name;
        state.statusNodes.summary.textContent = summary;
      }
      return;
    }
    state.statusShape = shape;
    const box = el.myStatus;
    box.replaceChildren();
    box.className = "status-right my-status";
    state.statusNodes = null;

    if (!m) {
      const span = document.createElement("span");
      span.textContent = "You have not submitted yet.";
      box.appendChild(span);
    } else {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "your submission";
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = m.name;
      const summaryNode = document.createTextNode(summary);
      text.append(strong, summaryNode);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn-ghost btn-sm";
      edit.textContent = "Edit / re-upload";
      edit.addEventListener("click", openUploadDialog);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm";
      del.textContent = "Delete";
      del.addEventListener("click", () => el.deleteDialog.showModal());
      box.append(badge, text, edit, del);
      state.statusNodes = { name: strong, summary: summaryNode };
    }
    if (!storageOk) {
      const warn = document.createElement("span");
      warn.className = "storage-warning";
      warn.textContent = "Your browser blocks site storage: after a reload you will not be able to edit or delete your row.";
      box.appendChild(warn);
    }
  }

  function renderStats() {
    el.statCount.textContent = String(state.rows.length);
    el.statUpdated.textContent = fmtClock(new Date());
  }


  // ---------------------------------------------------------------------------
  // Plot: accuracy (%) vs. average time per example — SVG scatter, no libraries
  // ---------------------------------------------------------------------------
  const SVG_NS = "http://www.w3.org/2000/svg";
  const plotHost = $("#plot");
  const plotEmpty = $("#plot-empty");
  const plotTooltip = $("#plot-tooltip");

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
  const fmtTickX = (v) => (v >= 1 ? +v.toPrecision(6) : +v.toPrecision(3)).toString();

  const LABEL_H = 13;
  // Collision-free name placement: labels avoid OTHER LABELS and EVERY DOT.
  // Forward pass only moves labels down, reverse pass only moves them up, and
  // each obstacle can trigger at most once per label (targets are fixed values),
  // so both passes terminate by construction. A label that cannot fit anywhere
  // is hidden — its dot keeps the hover tooltip.
  function placeLabels(points, widthOf, M, iw, ih, width, dots) {
    const obstacles = dots || points;
    const top = M.t + 10, bottom = M.t + ih - 2;
    const ASC = 9, DESC = 3, DOT = 7;    // label text box: [ly-ASC, ly+DESC]; dot box: x,y +- DOT
    for (const p of points) {
      const w = widthOf(p);
      p.side = p.x + 9 + w > width - 2 ? -1 : 1;
      if (p.side === -1 && p.x - 9 - w < 2) p.side = 1;
      p.hideLabel = false;
    }
    const span = (p) => {
      const w = widthOf(p);
      return p.side === 1 ? [p.x + 9, p.x + 9 + w] : [p.x - 9 - w, p.x - 9];
    };
    const overlapsX = (p, x0, x1) => { const [s0, s1] = span(p); return s0 < x1 && x0 < s1; };
    const overlaps = (a, b) => { const [b0, b1] = span(b); return overlapsX(a, b0, b1); };
    const inDotBand = (p, d) => overlapsX(p, d.x - DOT, d.x + DOT) && p.ly - ASC < d.y + DOT && d.y - DOT < p.ly + DESC;

    const pts = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
    pts.forEach((p, i) => {
      p.ly = Math.max(p.y + 4, top);
      let moved = true, guard = 0;
      while (moved && ++guard <= obstacles.length + i + 2) {
        moved = false;
        for (let j = 0; j < i; j++) {
          if (overlaps(p, pts[j]) && p.ly < pts[j].ly + LABEL_H) { p.ly = pts[j].ly + LABEL_H; moved = true; }
        }
        for (const d of obstacles) {
          if (inDotBand(p, d)) { p.ly = d.y + DOT + ASC + 0.5; moved = true; }   // clear below the dot
        }
      }
    });
    // Reverse pass: clamp to the bottom edge, propagate the constraint upward,
    // and dodge dots upward too.
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      p.ly = Math.min(p.ly, bottom);
      let moved = true, guard = 0;
      while (moved && ++guard <= obstacles.length + pts.length + 2) {
        moved = false;
        for (let j = i + 1; j < pts.length; j++) {
          const q = pts[j];
          if (!q.hideLabel && overlaps(p, q) && p.ly > q.ly - LABEL_H) { p.ly = q.ly - LABEL_H; moved = true; }
        }
        for (const d of obstacles) {
          if (inDotBand(p, d)) { p.ly = d.y - DOT - DESC - 0.5; moved = true; }  // clear above the dot
        }
      }
      if (p.ly < top) { p.hideLabel = true; p.ly = top; }
    }
  }

  // Pure geometry (no DOM) so it can be unit-tested: points, ticks, label spots.
  function plotLayout(rows, width, height) {
    const M = { l: 58, r: 34, t: 34, b: 48 };
    const iw = Math.max(60, width - M.l - M.r);
    const ih = Math.max(60, height - M.t - M.b);
    const xs = rows.map((r) => r.avg_time_s);
    const ys = rows.map((r) => r.metric * 100);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const xlog = xmin > 0 && xmax / xmin > 25;      // wide time ranges read better on a log axis
    let x0, x1, xTicks;
    if (xlog) {
      x0 = Math.floor(Math.log10(xmin));
      x1 = Math.ceil(Math.log10(xmax));
      if (x1 === x0) x1 += 1;
      xTicks = [];
      for (let e = x0; e <= x1; e++) xTicks.push(+(10 ** e).toPrecision(12));
    } else {
      x0 = 0;
      x1 = niceStep(Math.max(xmax, 1e-9) * 1.05);
      xTicks = linearTicks(0, x1, 5);
    }
    const xPos = (v) => M.l + ((xlog ? Math.log10(v) : v) - x0) / (x1 - x0) * iw;
    let ymin = Math.floor(Math.min(...ys)) - 2, ymax = Math.ceil(Math.max(...ys)) + 2;
    if (ymax - ymin < 6) { ymin -= 2; ymax += 2; }
    ymin = Math.max(0, ymin); ymax = Math.min(100, ymax);
    const yTicks = linearTicks(ymin, ymax, 5);
    const yPos = (v) => M.t + (1 - (v - ymin) / (ymax - ymin)) * ih;

    const points = rows.map((r) => ({
      row: r,
      x: xPos(r.avg_time_s),
      y: yPos(r.metric * 100),
    }));
    return { M, iw, ih, width, height, xlog, xTicks, yTicks, xPos, yPos, points };
  }

  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showPlotTip(p, target) {
    const box = plotTooltip.offsetParent || plotTooltip.parentElement;
    const boxRect = box.getBoundingClientRect();
    const r = target.getBoundingClientRect();          // handles svg scaling & padding
    const cx = r.left + r.width / 2 - boxRect.left;
    const cy = r.top + r.height / 2 - boxRect.top;
    plotTooltip.textContent = `${p.row.name} — ${fmtNumber(p.row.metric * 100, 2)} %, ${fmtTime(p.row.avg_time_s)} s/example`;
    plotTooltip.hidden = false;
    const half = plotTooltip.offsetWidth / 2;
    plotTooltip.style.left = `${Math.min(Math.max(cx, half + 2), boxRect.width - half - 2)}px`;
    plotTooltip.style.top = `${cy}px`;
    plotTooltip.classList.toggle("below", cy < 46);
  }
  function hidePlotTip() { plotTooltip.hidden = true; }

  let lastPlotKey = null;

  function renderPlot() {
    if (!plotHost) return;
    const rows = state.rows;
    if (!rows.length) {
      lastPlotKey = "empty";
      plotIndex = new Map();
      plotHost.replaceChildren();
      plotEmpty.hidden = false;
      hidePlotTip();
      return;
    }
    plotEmpty.hidden = true;
    const width = Math.max(320, plotHost.clientWidth || 640);
    const key = width + "|" + [...state.labeled].sort().join(",") + "|" +
      rows.map((r) => `${r.id},${r.name},${r.metric},${r.avg_time_s},${r.mine ? 1 : 0}`).join(";");
    if (key === lastPlotKey) return;                          // nothing changed: keep tooltip & focus alive
    if (plotHost.contains(document.activeElement)) return;    // keyboard user inside the plot: retry next refresh
    lastPlotKey = key;
    hidePlotTip();
    const height = Math.round(Math.min(400, Math.max(280, width * 0.42)));
    const L = plotLayout(rows, width, height);
    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`, height, role: "group",
      "aria-label": `${CONFIG.METRIC_LABEL} versus average time per example — the same data as the table above.`,
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
    svg.appendChild(svgEl("text", { x: 10, y: 16, class: "plot-axis-title plot-axis-title-y" }, `Test ${CONFIG.METRIC_LABEL.toLowerCase()} (%)`));
    svg.appendChild(svgEl("text", { x: L.M.l + L.iw / 2, y: L.height - 8, class: "plot-axis-title" },
      `Average time per example (s)${L.xlog ? " — log scale" : ""}`));
    const leaderGroup = svgEl("g", {});   // painted before (under) the dots
    svg.appendChild(leaderGroup);
    plotIndex = new Map();
    for (const p of L.points) {
      const mine = p.row.mine;
      const dot = svgEl("circle", { cx: p.x, cy: p.y, r: 5, class: "plot-dot" + (mine ? " mine" : "") });
      svg.appendChild(dot);
      const hit = svgEl("circle", {
        cx: p.x, cy: p.y, r: 12, class: "plot-hit", tabindex: "0",
        "aria-label": `${p.row.name}: ${fmtNumber(p.row.metric * 100, 2)} percent, ${fmtTime(p.row.avg_time_s)} seconds per example`,
      });
      const over = () => { dot.classList.add("hot"); showPlotTip(p, hit); };
      const out = () => { dot.classList.remove("hot"); hidePlotTip(); };
      hit.addEventListener("pointerenter", over);
      hit.addEventListener("pointerleave", out);
      hit.addEventListener("focus", over);
      hit.addEventListener("blur", out);
      svg.appendChild(hit);
      plotIndex.set(p.row.id, { p, dot });
    }
    // names for the checked rows: place with estimated widths first…
    const named = L.points.filter((p) => state.labeled.has(p.row.id));
    const estWidth = (p) => 10 + (p.row.name.length + (p.row.mine ? 6 : 0)) * 7;
    placeLabels(named, estWidth, L.M, L.iw, L.ih, width, L.points);
    // A name that had to move away from its dot gets a thin leader line back to it.
    const applyLabelGeom = (p, node, leader) => {
      node.style.display = p.hideLabel ? "none" : "";
      node.setAttribute("x", p.x + 9 * p.side);
      node.setAttribute("y", p.ly);
      node.classList.toggle("left", p.side === -1);
      const displaced = Math.abs(p.ly - 4 - p.y) > 8;
      if (p.hideLabel || !displaced) { leader.style.display = "none"; return; }
      leader.style.display = "";
      leader.setAttribute("x1", p.x + 6 * p.side);
      leader.setAttribute("y1", p.y + Math.sign(p.ly - 4 - p.y) * 4);
      leader.setAttribute("x2", p.x + 8 * p.side);
      leader.setAttribute("y2", p.ly - 4);
    };
    const labelNodes = new Map();
    for (const p of named) {
      const node = svgEl("text", {
        class: "plot-name" + (p.row.mine ? " mine" : ""),
      }, p.row.name + (p.row.mine ? " (you)" : ""));
      const leader = svgEl("line", { class: "plot-leader" });
      leaderGroup.appendChild(leader);
      labelNodes.set(p, { node, leader });
      svg.appendChild(node);
      applyLabelGeom(p, node, leader);
    }
    plotHost.replaceChildren(svg);
    // …then re-place with the REAL rendered text widths, so names can never
    // touch even when the estimate under-measures wide glyphs. Both passes run
    // in the same task, so only the final layout is ever painted.
    if (named.length) {
      try {
        const measured = new Map();
        for (const [p, { node }] of labelNodes) {
          const w = node.getComputedTextLength();
          measured.set(p, w > 0 ? w + 9 : estWidth(p));
        }
        placeLabels(named, (p) => measured.get(p), L.M, L.iw, L.ih, width, L.points);
        for (const [p, { node, leader }] of labelNodes) applyLabelGeom(p, node, leader);
      } catch (_) { /* getComputedTextLength unsupported: estimated layout stands */ }
    }
  }

  function updateLabelAllButton() {
    const total = state.rows.length;
    el.btnLabelAll.disabled = total === 0;
    el.btnLabelAll.textContent = total > 0 && state.labeled.size === total ? "Hide names" : "Show all names";
  }

  function setLabeled(id, on) {
    if (on) state.labeled.add(id); else state.labeled.delete(id);
    updateLabelAllButton();
    renderPlot();
  }

  // Table row hover spotlights the matching dot (and names it).
  let plotIndex = new Map();
  let spotlightId = null;
  function plotSpotlight(id, on) {
    if (on && spotlightId === id) return;
    if (spotlightId) {
      const prev = plotIndex.get(spotlightId);
      if (prev) prev.dot.classList.remove("hot");
    }
    spotlightId = on ? id : null;
    const entry = on ? plotIndex.get(id) : null;
    if (!entry) { hidePlotTip(); return; }
    entry.dot.classList.add("hot");
    showPlotTip(entry.p, entry.dot);
  }

  let plotResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(plotResizeTimer);
    plotResizeTimer = setTimeout(renderPlot, 150);
  });

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  async function refresh({ silent = true } = {}) {
    const seq = ++state.refreshSeq;
    try {
      const data = await api("GET", "/api/submissions");
      if (seq !== state.refreshSeq) return;            // a newer refresh already landed
      state.rows = computeRanks(data.submissions || []);
      state.mine = state.rows.find((r) => r.mine) || null;
      const ids = new Set(state.rows.map((r) => r.id));
      for (const id of state.labeled) if (!ids.has(id)) state.labeled.delete(id);
      updateLabelAllButton();
      renderTable();
      renderMyStatus();
      renderStats();
      renderPlot();
    } catch (err) {
      if (seq !== state.refreshSeq) return;
      if (!silent) showToast(`Could not load the leaderboard: ${err.message}`, "error");
      else el.statUpdated.textContent = "offline";
    }
  }

  function scheduleRefresh() {
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, CONFIG.REFRESH_MS);
  }

  // ---------------------------------------------------------------------------
  // Upload dialog
  // ---------------------------------------------------------------------------
  function submitLabel() { return state.mine ? "Replace my submission" : "Submit"; }

  function resetUploadDialog() {
    state.pending = null;
    state.fileSeq++;
    el.fileInput.value = "";
    el.dropzoneFile.textContent = "";
    el.validationBox.hidden = true;
    el.validationBox.replaceChildren();
    el.validationBox.className = "validation";
    el.previewBox.hidden = true;
    el.previewGrid.replaceChildren();
    el.btnSubmitUpload.disabled = true;
    el.btnSubmitUpload.textContent = submitLabel();
    el.uploadTitle.textContent = state.mine ? "Re-upload your submission" : "Upload submission";
    el.dialogNote.textContent = !storageOk
      ? "Storage is blocked in this browser — you will not be able to edit or delete this row after a reload."
      : state.mine
        ? "This will replace your current row on the leaderboard."
        : "Your browser remembers this upload so you can edit or delete it later.";
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

  function showPreview(entry) {
    el.previewGrid.replaceChildren();
    for (const f of FIELDS) {
      const dt = document.createElement("dt"); dt.textContent = FIELD_LABELS[f];
      const dd = document.createElement("dd");
      dd.textContent = NUMBER_FIELDS.includes(f) ? (f === "metric" ? fmtMetric(entry[f]) : fmtTime(entry[f])) : entry[f];
      el.previewGrid.append(dt, dd);
    }
    el.previewBox.hidden = false;
  }

  async function handleFile(file) {
    const seq = ++state.fileSeq;
    el.previewBox.hidden = true;
    state.pending = null;
    el.btnSubmitUpload.disabled = true;
    if (!file) {
      el.dropzoneFile.textContent = "";
      showValidation(["No file received — drop a single .csv or .json file."]);
      return;
    }
    el.dropzoneFile.textContent = `${file.name} (${file.size.toLocaleString()} bytes)`;
    if (file.size > CONFIG.MAX_FILE_BYTES) {
      showValidation([`File is too large (${file.size.toLocaleString()} bytes). A submission is a single row and should be well under 1 KB.`]);
      return;
    }
    let text;
    try { text = await file.text(); }
    catch (e) { if (seq === state.fileSeq) showValidation([`Could not read the file: ${e.message}`]); return; }
    if (seq !== state.fileSeq) return;          // another file was chosen (or the dialog was reset) meanwhile
    const { clean, errors } = parseSubmissionFile(file.name, text);
    if (errors.length) { showValidation(errors); return; }
    state.pending = clean;
    showValidation([], { okMessage: "Looks good — review the parsed values below and press Submit." });
    showPreview(clean);
    el.btnSubmitUpload.disabled = false;
  }

  function setSubmitting(on) {
    state.submitting = on;
    el.btnSubmitUpload.disabled = on;
    el.btnCancelUpload.disabled = on;
    el.btnCloseUpload.disabled = on;
    el.btnSubmitUpload.textContent = on ? "Submitting…" : submitLabel();
  }

  async function submitPending() {
    if (!state.pending || state.submitting) return;
    setSubmitting(true);
    try {
      const res = await api("PUT", "/api/submissions/mine", state.pending);
      setSubmitting(false);
      el.uploadDialog.close();
      await refresh({ silent: false });
      showToast(res.created ? "Submission added to the leaderboard." : "Submission updated.", "success");
    } catch (err) {
      setSubmitting(false);
      el.btnSubmitUpload.disabled = !state.pending;
      // 422 = server-side validation, 409 = duplicate person, 507 = board full, 0 = network, 5xx = server
      const details = err.details && err.details.length ? err.details : [err.message];
      const title = err.status === 422 ? "The server rejected the file:" : err.status === 409 || err.status === 507 ? "Submission refused:" : "Could not submit:";
      if (el.uploadDialog.open) showValidation(details, { title });   // a toast would be hidden behind the modal
      else showToast(`Submission failed: ${details[0]}`, "error");
    }
  }

  async function deleteMine() {
    el.btnConfirmDelete.disabled = true;
    try {
      await api("DELETE", "/api/submissions/mine");
      el.deleteDialog.close();
      await refresh({ silent: false });
      showToast("Your submission was deleted.", "success");
    } catch (err) {
      el.deleteDialog.close();
      showToast(`Delete failed: ${err.message}`, "error");
      refresh();
    } finally {
      el.btnConfirmDelete.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Toast (kept in the DOM so the live region reliably announces)
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  function showToast(message, kind = "") {
    el.toast.className = `toast show ${kind}`.trim();
    el.toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.classList.remove("show"); }, 4500);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function wireEvents() {
    el.metricHeader.textContent = CONFIG.METRIC_LABEL;

    for (const th of el.headers) {
      th.querySelector(".sort-btn").addEventListener("click", () => {
        const key = th.dataset.key;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          // sensible default direction per column
          state.sortDir = (key === "metric" && CONFIG.METRIC_HIGHER_IS_BETTER) || key === "submitted_at" ? "desc" : "asc";
        }
        renderTable();
      });
    }

    el.btnOpenUpload.addEventListener("click", openUploadDialog);
    el.btnCloseUpload.addEventListener("click", () => el.uploadDialog.close());
    el.btnCancelUpload.addEventListener("click", () => el.uploadDialog.close());
    el.btnSubmitUpload.addEventListener("click", submitPending);
    el.fileInput.addEventListener("change", () => {
      const file = el.fileInput.files[0];
      el.fileInput.value = "";       // so picking the same (fixed) file again fires 'change'
      handleFile(file);
    });
    // the form never submits the classic way (Enter key etc.)
    $("#upload-form").addEventListener("submit", (e) => e.preventDefault());

    // drag & drop (and never let the browser navigate to a dropped file)
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

    // close dialogs when clicking on the backdrop (not while a submission is in flight)
    for (const dlg of [el.uploadDialog, el.deleteDialog]) {
      dlg.addEventListener("click", (e) => { if (e.target === dlg && !state.submitting) dlg.close(); });
    }
    el.uploadDialog.addEventListener("cancel", (e) => { if (state.submitting) e.preventDefault(); });   // Escape key

    el.btnLabelAll.addEventListener("click", () => {
      if (state.labeled.size === state.rows.length && state.rows.length > 0) state.labeled.clear();
      else state.rows.forEach((r) => state.labeled.add(r.id));
      updateLabelAllButton();
      for (const box of el.tbody.querySelectorAll("input.name-check")) {
        const tr = box.closest("tr[data-id]");
        if (tr) box.checked = state.labeled.has(tr.dataset.id);
      }
      renderPlot();
    });

    // hovering a table row spotlights its dot on the plot
    el.tbody.addEventListener("mouseover", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) plotSpotlight(tr.dataset.id, true);
    });
    el.tbody.addEventListener("mouseleave", () => plotSpotlight(spotlightId, false));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  wireEvents();
  renderMyStatus();
  refresh({ silent: false });
  scheduleRefresh();
  // Web fonts load asynchronously: label widths measured against the fallback
  // font are stale once IBM Plex swaps in, so lay the plot out again then.
  if (document.fonts) {
    const remeasure = () => { lastPlotKey = null; renderPlot(); };
    if (document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(remeasure);
    if (document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", remeasure);
  }

  // exposed for debugging / tests in the console
  window.Leaderboard = { parseSubmissionFile, validateEntry, computeRanks, plotLayout, placeLabels, CONFIG };
})();
