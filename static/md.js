/* Tiny Markdown renderer for the site's own documents (guide, assignment).
 * Supports: h1-h3, paragraphs, unordered + ordered lists, pipe tables, fenced
 * code, blockquotes, horizontal rules, inline code / bold / italics / links.
 * Headings get a slug id so sections of these documents can be linked to.
 * All text is HTML-escaped first. Exposes window.renderMarkdown(md) -> html. */
(() => {
  "use strict";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Link targets we will render as links: absolute http(s), site-relative, a
  // fragment, or a relative path. Everything else (javascript:, data:, vbscript:)
  // renders as plain text. Applied to every link, inline or standalone.
  const SAFE_URL = /^(https?:\/\/|\/|#|[\w.-]+\/|[\w.-]+\.(csv|json|md|py|tsv))/i;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
      SAFE_URL.test(u) ? `<a href="${u}">${t}</a>` : t);

  // Heading slugs: /guide#the-file and the like. Ids are word chars and
  // hyphens only, so they never need escaping, and repeats get a suffix.
  let usedIds = Object.create(null);
  function headingId(text) {
    const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
    let id = base;
    for (let n = 2; usedIds[id]; n++) id = `${base}-${n}`;
    usedIds[id] = true;
    return id;
  }

  function renderMarkdown(md) {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {                                   // fenced code
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {             // horizontal rule
        out.push("<hr>");
        i++;
      } else if (/^#{1,3}\s/.test(line)) {                       // headings
        const level = line.match(/^#+/)[0].length;
        const heading = line.replace(/^#+\s*/, "");
        out.push(`<h${level} id="${headingId(heading)}">${inline(heading)}</h${level}>`);
        i++;
      } else if (/^>/.test(line)) {                              // blockquote
        const buf = [];
        while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      } else if (/^\|/.test(line)) {                             // pipe table
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map(cells);
        out.push('<div class="table-wrap"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          body.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table></div>");
      } else if (/^\s*\d+\.\s+/.test(line) || /^\s*[-*]\s+/.test(line)) {   // lists (one nesting level)
        const ordered = /^\s*\d+\.\s+/.test(line);
        const anyMarker = /^(\s*)(\d+\.|[-*])\s+/;
        const baseIndent = (line.match(/^\s*/) || [""])[0].length;
        const items = [];
        while (i < lines.length) {
          const cur = lines[i];
          const m = cur.match(anyMarker);
          if (m) {
            const indent = m[1].length;
            if (indent > baseIndent && items.length) {
              // nested block: collect everything more indented than the outer list
              const subIndent = indent;
              const sub = [];
              while (i < lines.length && lines[i].trim() !== "" &&
                     ((lines[i].match(/^\s*/) || [""])[0].length > baseIndent)) {
                sub.push(lines[i].slice(Math.min(subIndent, (lines[i].match(/^\s*/) || [""])[0].length)));
                i++;
              }
              items[items.length - 1].sub = (items[items.length - 1].sub || "") + renderMarkdown(sub.join("\n"));
              continue;
            }
            if (indent < baseIndent) break;
            items.push({ text: cur.replace(anyMarker, "") });
            i++;
            continue;
          }
          if (/^\s{2,}\S/.test(cur) && items.length) {   // continuation line
            items[items.length - 1].text += " " + cur.trim();
            i++;
            continue;
          }
          break;
        }
        const lis = items.map((it) => `<li>${inline(it.text)}${it.sub || ""}</li>`).join("");
        out.push(ordered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`);
      } else if (line.trim() === "") {
        i++;
      } else {                                                   // paragraph
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== "" &&
               !/^(#{1,3}\s|```|\||\s*[-*]\s+|\s*\d+\.\s+|>|-{3,}\s*$)/.test(lines[i])) {
          buf.push(lines[i++]);
        }
        const joined = buf.join(" ").trim();
        const lone = joined.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (lone && SAFE_URL.test(lone[2])) out.push(`<p class="md-btn"><a class="btn btn-primary" href="${esc(lone[2])}">${esc(lone[1])}</a></p>`);
        else out.push(`<p>${inline(joined)}</p>`);
      }
    }
    return out.join("\n");
  }

  // Reset the slug table for every document, not for every nested block.
  window.renderMarkdown = (md) => { usedIds = Object.create(null); return renderMarkdown(md); };
})();
