import { createHash } from "node:crypto";
import { searchMaterials } from "./search.mjs";

const STYLE = `
:root{color-scheme:light;--ink:#172d32;--muted:#536b70;--paper:#f7f5ef;--line:#cbd6d3;--accent:#0b6658;font:16px/1.55 system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}header,main,footer{max-width:1480px;margin:auto;padding:1.5rem 2rem}header{border-bottom:1px solid var(--line)}h1{font-size:clamp(2rem,4vw,3rem);line-height:1.15;margin:.3rem 0}h2{font-size:1.25rem;margin:0 0 .6rem}p{margin:.5rem 0}.eyebrow{font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:750}.muted,small{color:var(--muted)}.toolbar{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(10rem,16rem) auto;gap:1rem;align-items:end;margin:1.5rem 0}label{display:block;font-weight:650}input,select,button{font:inherit;border:1px solid #8a9e99;border-radius:.4rem;padding:.6rem .8rem;background:white;color:var(--ink)}input,select{width:100%;margin-top:.3rem}button,a{touch-action:manipulation}button{cursor:pointer}button:hover{background:#e8f1ed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,pre:focus-visible{outline:3px solid #ac5b08;outline-offset:3px}a{color:var(--accent);overflow-wrap:anywhere}.receipts{display:flex;gap:.75rem;flex-wrap:wrap}.receipt{border:1px solid var(--line);border-radius:.5rem;background:white;padding:.75rem 1rem;flex:1 1 15rem}.receipt strong{display:block}.badge{font-size:.85rem;font-weight:700;color:var(--accent)}.attention{color:#92540b}.desk{display:grid;grid-template-columns:minmax(15rem,34%) minmax(0,1fr);gap:1.25rem;align-items:start}.results{max-height:70vh;overflow:auto;list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}.result{width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:1rem .75rem}.result[aria-pressed=true]{background:#e2ede7;border-left:4px solid var(--accent)}.result strong,.result small{display:block;overflow-wrap:anywhere}.result .snippet{display:block;font-size:.9rem;margin-top:.4rem;color:var(--muted)}.reader{background:white;border:1px solid var(--line);border-radius:.6rem;padding:1.5rem;min-height:27rem;overflow:hidden}.reader pre{white-space:pre-wrap;overflow-wrap:anywhere;font:1rem/1.7 ui-monospace,monospace}.reader h2{overflow-wrap:anywhere}details{margin:.75rem 0}summary{cursor:pointer}details pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem}.error{color:#923d16}footer{border-top:1px solid var(--line);font-size:.85rem}#fallback li{margin:.5rem 0}[hidden]{display:none!important}@media(max-width:720px){header,main,footer{padding:1rem}.toolbar{grid-template-columns:1fr}.desk{grid-template-columns:1fr}.results{max-height:45vh}.reader{min-height:16rem;padding:1rem}.receipts{display:block}.receipt{margin-bottom:.5rem}}`;

export function libraryHtml(catalogue) {
  const data = JSON.stringify(catalogue).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const script = `const searchMaterials = ${searchMaterials.toString()};\n(${readingDesk.toString()})(document);`;
  const csp = `default-src 'none'; script-src '${hash(script)}'; style-src '${hash(STYLE)}'; base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>NTULearn · Local library</title><style>${STYLE}</style></head>
<body><header><div class="eyebrow">NTULearn / Local library</div><h1>Your course reading desk</h1><p class="muted">Search your saved pages. Find an attachment. Keep reading offline.</p><p><small>Private local snapshot. NTULearn was not contacted.</small></p><small>Snapshot ${escapeHtml(catalogue.observedAt)} · ${escapeHtml(catalogue.status)} local scan</small></header>
<main><section aria-label="Course receipts" class="receipts">${catalogue.courses.map(receiptCard).join("")}</section>
${catalogue.diagnostics.map((entry) => `<p class="error">${escapeHtml(entry.message)} ${escapeHtml(entry.action)}</p>`).join("")}
<div id="interactive" hidden><div class="toolbar"><label for="query">Search pages and filenames<input id="query" type="search" placeholder="A phrase, topic, or filename" autocomplete="off"></label><label for="course">Course<select id="course"><option value="">All selected courses</option>${catalogue.courses.map((entry) => `<option value="${escapeHtml(entry.key)}">${escapeHtml(entry.key)}</option>`).join("")}</select></label><button id="clear" type="button">Clear filters</button></div><p id="query-error" class="error" role="alert" hidden></p><p id="result-count" role="status" aria-live="polite"></p><div class="desk"><section aria-label="Search results"><ul id="results" class="results"></ul><p id="no-results" hidden>No results. Try another word or clear the filters.</p></section><article class="reader" aria-label="Document reader"><div id="reader-kind" class="eyebrow">Ready to read</div><h2 id="reader-title">Choose a page or attachment</h2><p id="reader-path" class="muted"></p><a id="open-file" target="_blank" rel="noopener noreferrer" hidden>Open local file</a><pre id="reader-text" tabindex="0">Select a result to read saved Markdown as plain text. Attachments open in your local application.</pre></article></div></div>
<section id="fallback"><h2>Saved material</h2><p>Enable JavaScript to search and read pages here. Local file links remain available below.</p><ul>${catalogue.materials.map((entry) => `<li>${escapeHtml(entry.course)} · <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.path)}</a> · ${escapeHtml(entry.kind)}</li>`).join("")}</ul>${catalogue.materials.length ? "" : "<p>No material found. Inspect the scan observations above.</p>"}</section>
<details><summary>Scan limits and omissions</summary><p>Attachments are searched by filename. Hidden files, source provenance, operational files, temporary publications, nested symlinks, and special files are excluded.</p><pre>${escapeHtml(JSON.stringify({ limits: catalogue.limits, courses: catalogue.courses.map(({ key, scan, counts, exclusions, diagnostics, suppressedDiagnostics }) => ({ key, scan, counts, exclusions, diagnostics, suppressedDiagnostics })) }, null, 2))}</pre></details>
</main><footer><p>This private snapshot contains local course text and file locations. Keep the export outside course destinations and share it only deliberately.</p><p>Receipts describe the latest observed sync attempt. They do not prove upstream completeness, current source revision, or attachment contents. Local links may change after files move.</p></footer>
<script id="catalogue" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

function receiptCard(course) {
  const evidence = course.receipt;
  const value = evidence.value;
  const label = `${evidence.state}${evidence.stale ? " · stale" : ""}`;
  return `<article class="receipt"><strong>${escapeHtml(course.key)}</strong><span class="badge${evidence.action ? " attention" : ""}">${escapeHtml(label)}</span><p>${course.counts.markdown} pages · ${course.counts.attachments} attachments · ${escapeHtml(course.scan)} scan</p><small>Last successful sync ${escapeHtml(value?.lastSuccessfulAt ?? "unknown")}</small>${value ? `<p><small>Latest attempt ${escapeHtml(value.finishedAt ?? value.startedAt)}<br>${value.counts.failures} sync failures · unread ${escapeHtml(value.unread.join(", ") || "none")}</small></p>` : ""}${evidence.state === "running" ? "<p><small>The attempt may be active or interrupted.</small></p>" : ""}${evidence.action ? `<details><summary>Receipt needs attention</summary><p>${escapeHtml(evidence.action)}</p></details>` : ""}</article>`;
}

function readingDesk(document) {
  const catalogue = JSON.parse(document.getElementById("catalogue").textContent);
  const query = document.getElementById("query");
  const course = document.getElementById("course");
  const results = document.getElementById("results");
  let selected = null;
  query.value = catalogue.query;

  function read(material) {
    selected = material.url;
    document.getElementById("reader-kind").textContent =
      material.kind === "markdown" ? "Saved page / Plain text" : "Attachment / Filename only";
    document.getElementById("reader-title").textContent = material.name;
    document.getElementById("reader-path").textContent = `${material.course} / ${material.path}`;
    const link = document.getElementById("open-file");
    link.href = material.url;
    link.hidden = false;
    document.getElementById("reader-text").textContent =
      material.text.state === "read"
        ? material.text.value
        : material.text.state === "filename-only"
          ? "Attachment contents were not read. Open the local file to view it."
          : "This page could not be read. Inspect the scan limits and omissions, then export again.";
    for (const button of results.querySelectorAll("button"))
      button.setAttribute("aria-pressed", String(button.dataset.url === selected));
  }

  function render() {
    const invalid = Array.from(query.value).length > catalogue.limits.queryCodePoints;
    const error = document.getElementById("query-error");
    error.hidden = !invalid;
    error.textContent = invalid
      ? `Use at most ${catalogue.limits.queryCodePoints} characters in a query.`
      : "";
    const matches = invalid
      ? []
      : searchMaterials(catalogue.materials, {
          query: query.value,
          course: course.value,
          limits: catalogue.limits,
        });
    results.replaceChildren();
    for (const material of matches) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result";
      button.dataset.url = material.url;
      button.setAttribute("aria-pressed", String(material.url === selected));
      for (const [tag, value, className] of [
        ["strong", material.name, ""],
        ["small", `${material.course} / ${material.path} · ${material.kind}`, ""],
        ["span", material.snippet, "snippet"],
      ]) {
        const element = document.createElement(tag);
        element.textContent = value;
        element.className = className;
        button.append(element);
      }
      button.addEventListener("click", () => read(material));
      item.append(button);
      results.append(item);
    }
    document.getElementById("result-count").textContent =
      `${matches.length} ${matches.length === 1 ? "result" : "results"} / ${catalogue.materials.length} saved items`;
    document.getElementById("no-results").hidden = matches.length > 0 || invalid;
    if (selected && !matches.some((material) => material.url === selected)) {
      selected = null;
      document.getElementById("reader-kind").textContent = "Ready to read";
      document.getElementById("reader-title").textContent = "Choose a page or attachment";
      document.getElementById("reader-path").textContent = "";
      document.getElementById("reader-text").textContent = "Select a result to read it here.";
      document.getElementById("open-file").hidden = true;
    }
  }
  query.addEventListener("input", render);
  course.addEventListener("change", render);
  document.getElementById("clear").addEventListener("click", () => {
    query.value = "";
    course.value = "";
    render();
    query.focus();
  });
  render();
  document.getElementById("interactive").hidden = false;
  document.getElementById("fallback").hidden = true;
}

function hash(value) {
  return `sha256-${createHash("sha256").update(value).digest("base64")}`;
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}
