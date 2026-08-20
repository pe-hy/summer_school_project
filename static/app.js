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
    METRIC_LABEL: "Metric",          // shown in the column header
    METRIC_HIGHER_IS_BETTER: true,   // rank #1 = highest metric (set false for loss/error metrics)
    REFRESH_MS: 10000,               // background refresh interval
    MAX_NAME_LEN: 80,
    MAX_ABS_NUMBER: 1e15,
    MAX_FILE_BYTES: 64 * 1024,
  };

  // Keep in sync with app.py (validate_entry) and submit_readme.md
  const FIELDS = ["name", "metric", "test_time_s"];
  const STRING_FIELDS = ["name"];
  const NUMBER_FIELDS = ["metric", "test_time_s"];
  const NON_NEGATIVE_FIELDS = ["test_time_s"];
  const FIELD_LABELS = {
    name: "Name", metric: CONFIG.METRIC_LABEL, test_time_s: "Test time (s)",
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
    refreshSeq: 0,            // ignore responses of older in-flight refreshes
    fileSeq: 0,               // ignore results of superseded file reads
    submitting: false,        // the upload dialog cannot be dismissed while a PUT is in flight
    statusShape: null,        // "mine|storageOk" shape of #my-status, to update text in place
    statusNodes: null,
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
  // "Test time (s)", "test_time_s", "TEST-TIME-S" all normalize to "testtimes"
  const stripBOM = (s) => s.replace(/^\uFEFF/, "");
  const normalizeHeader = (h) => stripBOM(String(h)).toLowerCase().replace(/[^a-z0-9]/g, "");
  const CANONICAL_BY_NORMALIZED = Object.fromEntries(FIELDS.map((f) => [normalizeHeader(f), f]));

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
      return { errors: ["The JSON must be an object with the keys name, metric, test_time_s."] };
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
  const fmtTime = (x) => fmtNumber(x, 3);
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
      (a.test_time_s - b.test_time_s) ||                // tie-break: faster inference
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
    const frag = document.createDocumentFragment();
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "placeholder-row";
      const cell = td(null, "No submissions yet — be the first to upload one.");
      cell.colSpan = el.headers.length;
      tr.appendChild(cell);
      frag.appendChild(tr);
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
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
      tr.appendChild(td("num", fmtMetric(r.metric)));
      tr.appendChild(td("num", fmtTime(r.test_time_s)));
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
    el.footnote.textContent = `Rank is by ${CONFIG.METRIC_LABEL.toLowerCase()} (${CONFIG.METRIC_HIGHER_IS_BETTER ? "higher" : "lower"} is better); equal metrics share a rank and are listed by test time. Click a column header to sort.`;
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
  // Data loading
  // ---------------------------------------------------------------------------
  async function refresh({ silent = true } = {}) {
    const seq = ++state.refreshSeq;
    try {
      const data = await api("GET", "/api/submissions");
      if (seq !== state.refreshSeq) return;            // a newer refresh already landed
      state.rows = computeRanks(data.submissions || []);
      state.mine = state.rows.find((r) => r.mine) || null;
      renderTable();
      renderMyStatus();
      renderStats();
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

  // exposed for debugging / tests in the console
  window.Leaderboard = { parseSubmissionFile, validateEntry, computeRanks, CONFIG };
})();
