/* Tiny Markdown renderer for the site's own documents (guide, assignment).
 * Supports: h1-h3, paragraphs, unordered + ordered lists, pipe tables, fenced
 * code, blockquotes, horizontal rules, inline code / bold / italics / links.
 * All text is HTML-escaped first. Exposes window.renderMarkdown(md) -> html. */
(() => {
  "use strict";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
      /^(https?:\/\/|\/|#|[\w.-]+\/|[\w.-]+\.(csv|json|md|py|tsv))/.test(u) ? `<a href="${u}">${t}</a>` : t);

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
        out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
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
      } else if (/^\s*\d+\.\s+/.test(line) || /^\s*[-*]\s+/.test(line)) {   // lists
        const ordered = /^\s*\d+\.\s+/.test(line);
        const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
        const items = [];
        while (i < lines.length && marker.test(lines[i])) {
          let item = lines[i++].replace(marker, "");
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
                 !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
            item += " " + lines[i++].trim();
          }
          items.push(`<li>${inline(item)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      } else if (line.trim() === "") {
        i++;
      } else {                                                   // paragraph
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== "" &&
               !/^(#{1,3}\s|```|\||\s*[-*]\s+|\s*\d+\.\s+|>|-{3,}\s*$)/.test(lines[i])) {
          buf.push(lines[i++]);
        }
        out.push(`<p>${inline(buf.join(" "))}</p>`);
      }
    }
    return out.join("\n");
  }

  window.renderMarkdown = renderMarkdown;
})();
