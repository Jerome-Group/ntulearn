/**
 * @typedef {{url: string, occurrence: number | null}} Reader
 * @typedef {{kind: "empty"} | {kind: "read", primary: Reader} |
 *   {kind: "compare", primary: Reader, secondary: Reader}} View
 */
export function readingWorkspace(document, searchMaterials) {
  const catalogue = JSON.parse(document.getElementById("catalogue").textContent);
  const limits = catalogue.limits;
  const query = document.getElementById("query");
  const course = document.getElementById("course");
  const state = {
    query: catalogue.query,
    course: "",
    resultPage: 0,
    view: { kind: "empty" },
    queue: [],
  };
  query.value = state.query;

  function invalidQuery() {
    return Array.from(state.query).length > limits.queryCodePoints;
  }

  function material(url) {
    return catalogue.materials.find((entry) => entry.url === url);
  }

  function readable(entry) {
    return entry.kind === "markdown" && entry.text.state === "read";
  }

  function readerMatch(entry) {
    return invalidQuery() ? null : searchMaterials([entry], { query: state.query, limits })[0];
  }

  function selection(url) {
    return { url, occurrence: readerMatch(material(url))?.passages.length ? 0 : null };
  }

  function open(url) {
    if (state.view.kind === "empty") state.view = { kind: "read", primary: selection(url) };
    else if (state.view.kind === "compare" && state.view.secondary.url === url)
      state.view = {
        kind: "compare",
        primary: state.view.secondary,
        secondary: state.view.primary,
      };
    else if (state.view.primary.url !== url) state.view.primary = selection(url);
    render("reader-primary-title");
  }

  function compare(url) {
    const primary = state.view.primary;
    state.view = {
      kind: "compare",
      primary,
      secondary: state.view.secondary?.url === url ? state.view.secondary : selection(url),
    };
    render("reader-secondary-title");
  }

  function announce(message) {
    document.getElementById("workspace-status").textContent = message;
  }

  function addToQueue(url) {
    if (state.queue.includes(url)) {
      announce("This page is already in the reading queue.");
      return;
    }
    if (state.queue.length === limits.queue) {
      announce(
        `The reading queue holds at most ${limits.queue} pages. Remove a page before adding another.`,
      );
      return;
    }
    state.queue.push(url);
    renderQueue();
    announce(`Added ${material(url).name} to the reading queue.`);
  }

  function element(tag, value = "", className = "") {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function button(label, action, { disabled = false, id = "" } = {}) {
    const node = element("button", label);
    node.type = "button";
    node.disabled = disabled;
    if (id) node.id = id;
    node.addEventListener("click", action);
    return node;
  }

  function localLink(entry) {
    const link = element("a", "Open local file");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open local file ${entry.course} / ${entry.path}`);
    return link;
  }

  function renderResults(matches) {
    const results = document.getElementById("results");
    const pages = Math.max(1, Math.ceil(matches.length / limits.resultsPerPage));
    state.resultPage = Math.min(state.resultPage, pages - 1);
    results.replaceChildren();
    const start = state.resultPage * limits.resultsPerPage;
    for (const entry of matches.slice(start, start + limits.resultsPerPage)) {
      const item = element("li", "", "result");
      item.append(
        element("strong", entry.name),
        element("small", `${entry.course} / ${entry.path} · ${entry.kind}`),
        element("p", entry.snippet, "snippet"),
      );
      if (state.query && entry.occurrences.total)
        item.append(
          element(
            "small",
            `${entry.occurrences.total} occurrences in read local text · ${entry.occurrences.omitted} passages omitted`,
          ),
        );
      const actions = element("div", "", "actions");
      if (readable(entry)) {
        const read = button("Read page", () => open(entry.url));
        read.setAttribute("aria-label", `Read ${entry.course} / ${entry.path}`);
        read.setAttribute("aria-pressed", String(state.view.primary?.url === entry.url));
        const compareButton = button("Compare", () => compare(entry.url), {
          disabled: state.view.kind === "empty" || state.view.primary.url === entry.url,
        });
        compareButton.setAttribute("aria-label", `Compare ${entry.course} / ${entry.path}`);
        compareButton.setAttribute("aria-pressed", String(state.view.secondary?.url === entry.url));
        const add = button("Add to queue", () => addToQueue(entry.url));
        add.setAttribute("aria-label", `Add ${entry.course} / ${entry.path} to queue`);
        actions.append(read, compareButton, add);
      }
      actions.append(localLink(entry));
      item.append(actions);
      results.append(item);
    }
    const total = matches.reduce((sum, entry) => sum + entry.occurrences.total, 0);
    const returned = matches.reduce((sum, entry) => sum + entry.occurrences.returned, 0);
    document.getElementById("result-count").textContent =
      `${matches.length} matching saved items / ${catalogue.materials.length} observed. ` +
      (state.query && !invalidQuery()
        ? `${returned} of ${total} occurrences retained in read local text; ${total - returned} omitted. `
        : "") +
      `Page ${state.resultPage + 1} of ${pages}.`;
    document.getElementById("result-page").textContent = `Page ${state.resultPage + 1} of ${pages}`;
    document.getElementById("results-previous").disabled = state.resultPage === 0;
    document.getElementById("results-next").disabled = state.resultPage === pages - 1;
    document.getElementById("no-results").hidden = matches.length > 0 || invalidQuery();
  }

  function renderReader(slot, matches) {
    const selected = state.view[slot];
    const entry = material(selected.url);
    const match = readerMatch(entry);
    const passages = match?.passages ?? [];
    const index = selected.occurrence ?? 0;
    const passage = passages[index];
    const pane = element("article", "", "reader");
    pane.setAttribute(
      "aria-label",
      `${slot === "primary" ? "Primary" : "Comparison"} source ${entry.course} / ${entry.path}`,
    );
    pane.append(
      element(
        "div",
        slot === "primary" ? "Saved page / Plain text" : "Compare / Plain text",
        "eyebrow",
      ),
    );
    const title = element("h3", entry.name);
    title.id = `reader-${slot}-title`;
    title.tabIndex = -1;
    pane.append(title, element("p", `${entry.course} / ${entry.path}`, "muted"), localLink(entry));
    if (!matches.some((result) => result.url === entry.url))
      pane.append(
        element(
          "p",
          invalidQuery()
            ? "Search paused. Correct the query to highlight occurrences."
            : "Outside current filter.",
          "attention",
        ),
      );
    const position = passage
      ? `Occurrence ${index + 1} of ${passages.length} retained · ${match.occurrences.total} total · line ${passage.line}, column ${passage.column}`
      : invalidQuery()
        ? "Correct the query to resume occurrence navigation."
        : entry.text.value
          ? state.query
            ? "No text occurrences for this query in this page."
            : "Whole saved page. Enter a query to navigate occurrences."
          : "Empty Markdown document.";
    pane.append(element("p", position, "occurrence-position"));
    if (match?.occurrences.omitted)
      pane.append(
        element(
          "p",
          `${match.occurrences.omitted} occurrences omitted from navigation. Use a more specific query.`,
          "attention",
        ),
      );
    const actions = element("div", "", "actions");
    for (const [label, direction] of [
      ["Previous occurrence", -1],
      ["Next occurrence", 1],
    ]) {
      const id = `reader-${slot}-${direction < 0 ? "previous" : "next"}`;
      const control = button(
        label,
        () => {
          selected.occurrence = index + direction;
          render(id, slot);
        },
        { disabled: !passage || index + direction < 0 || index + direction >= passages.length, id },
      );
      control.setAttribute("aria-label", `${label} in ${entry.name}`);
      actions.append(control);
    }
    actions.append(button("Add to queue", () => addToQueue(entry.url)));
    if (slot === "secondary")
      actions.append(
        button("Remove comparison", () => {
          state.view = { kind: "read", primary: state.view.primary };
          render("reader-primary-title");
        }),
      );
    pane.append(actions);
    const text = element("pre");
    text.id = `reader-${slot}-text`;
    text.tabIndex = 0;
    if (passage) {
      const mark = element("mark", entry.text.value.slice(passage.start, passage.end));
      mark.id = `reader-${slot}-mark`;
      text.append(
        document.createTextNode(entry.text.value.slice(0, passage.start)),
        mark,
        document.createTextNode(entry.text.value.slice(passage.end)),
      );
    } else text.textContent = entry.text.value;
    pane.append(text);
    return pane;
  }

  function renderReaders(matches) {
    const readers = document.getElementById("readers");
    readers.className = state.view.kind === "compare" ? "readers compare" : "readers";
    readers.replaceChildren();
    if (state.view.kind === "empty") {
      const placeholder = element("article", "", "reader");
      placeholder.append(
        element("h3", "Choose a saved page"),
        element(
          "p",
          "Read the whole page, navigate a phrase, or compare two sources. Attachments use the explicit local-file links.",
        ),
      );
      readers.append(placeholder);
      return;
    }
    readers.append(renderReader("primary", matches));
    if (state.view.kind === "compare") readers.append(renderReader("secondary", matches));
  }

  function nextQueued() {
    const current = state.queue.indexOf(state.view.primary?.url);
    return state.queue[current + 1];
  }

  function renderQueue() {
    const queue = document.getElementById("queue");
    queue.replaceChildren();
    state.queue.forEach((url, index) => {
      const entry = material(url);
      const item = element("li");
      item.append(
        element("strong", entry.name),
        element("small", `${entry.course} / ${entry.path}`),
      );
      const actions = element("div", "", "actions");
      const read = button("Read page", () => open(url), { id: `queue-read-${index}` });
      read.setAttribute("aria-label", `Read queued ${entry.course} / ${entry.path}`);
      actions.append(read);
      for (const [label, direction] of [
        ["Move up", -1],
        ["Move down", 1],
      ]) {
        const target = index + direction;
        const prefix = direction < 0 ? "queue-up" : "queue-down";
        const control = button(
          label,
          () => {
            [state.queue[index], state.queue[target]] = [state.queue[target], state.queue[index]];
            render(`queue-read-${target}`);
            announce(`Moved ${entry.name} to position ${target + 1}.`);
          },
          { disabled: target < 0 || target >= state.queue.length, id: `${prefix}-${index}` },
        );
        control.setAttribute("aria-label", `${label} ${entry.name}`);
        actions.append(control);
      }
      const remove = button("Remove", () => {
        state.queue.splice(index, 1);
        render(
          state.queue.length
            ? `queue-read-${Math.min(index, state.queue.length - 1)}`
            : "queue-heading",
        );
        announce(`Removed ${entry.name} from the reading queue.`);
      });
      remove.setAttribute("aria-label", `Remove ${entry.name} from queue`);
      actions.append(remove);
      item.append(actions);
      queue.append(item);
    });
    document.getElementById("queue-count").textContent =
      `${state.queue.length} of ${limits.queue} pages. Queue order lasts until this page reloads.`;
    document.getElementById("queue-empty").hidden = state.queue.length > 0;
    document.getElementById("queue-next").disabled = !nextQueued();
  }

  function render(focus = "", markSlot = "") {
    const invalid = invalidQuery();
    const error = document.getElementById("query-error");
    error.hidden = !invalid;
    error.textContent = invalid
      ? `Use at most ${limits.queryCodePoints} characters in a query.`
      : "";
    const matches = invalid
      ? []
      : searchMaterials(catalogue.materials, {
          query: state.query,
          course: state.course,
          limits,
        });
    renderResults(matches);
    renderReaders(matches);
    renderQueue();
    const target = document.getElementById(focus);
    if (target && !target.disabled) target.focus();
    else if (markSlot) document.getElementById(`reader-${markSlot}-text`).focus();
    if (markSlot)
      document.getElementById(`reader-${markSlot}-mark`)?.scrollIntoView({ block: "center" });
  }

  query.addEventListener("input", () => {
    state.query = query.value;
    state.resultPage = 0;
    if (state.view.kind !== "empty") state.view.primary.occurrence = invalidQuery() ? null : 0;
    if (state.view.kind === "compare") state.view.secondary.occurrence = invalidQuery() ? null : 0;
    render();
  });
  course.addEventListener("change", () => {
    state.course = course.value;
    state.resultPage = 0;
    render();
  });
  document.getElementById("clear").addEventListener("click", () => {
    query.value = state.query = "";
    course.value = state.course = "";
    state.resultPage = 0;
    render();
    query.focus();
  });
  for (const [id, direction] of [
    ["results-previous", -1],
    ["results-next", 1],
  ])
    document.getElementById(id).addEventListener("click", () => {
      state.resultPage += direction;
      render("results-heading");
    });
  document.getElementById("queue-next").addEventListener("click", () => open(nextQueued()));
  for (const id of ["jump-results", "jump-reader", "jump-queue"])
    document.getElementById(id).addEventListener("click", () => {
      document.getElementById(document.getElementById(id).hash.slice(1)).focus();
    });
  document.getElementById("passage-limit").textContent =
    `Navigation retains up to ${limits.passagesPerDocument} occurrences per page and ${limits.passagesPerSearch} per search. Open readers search their own page independently. Counts cover read local text only.`;
  render();
  document.getElementById("interactive").hidden = false;
  document.getElementById("fallback").hidden = true;
}
