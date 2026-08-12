const ELEMENT_IN_REPORT = 300;
const ITEMS_IN_REPORT = 3;
const NOT_AUTHORITATIVE_ABOUT = [
  "the contents of a cross-origin frame, which the browser will not let this read",
  "anything a page loads only after a click, which this never makes",
  "anything not on a content item — a conversation, a gradebook, a tool outside the outline",
  "anything the bare outline also carries, or that every item carries and is not shaped like a" +
    " file — both are subtracted as the application's own furniture, and either could take a" +
    " genuine object with it",
  "a `data:` or `blob:` address, which is content inlined into the page rather than a file any" +
    " sync could have brought across",
];

// One document per run, Markdown, so the Owner pastes it back onto #47 whole. It is the whole
// finding and not a summary of one: what the page carried, what each side has that the other does
// not, and every course and item this could not read.
export function renderReport(courses) {
  return [
    "# The rendered page, held against the walk",
    "",
    ...summary(courses),
    "",
    "## What the rendered page is not authoritative about",
    "",
    ...NOT_AUTHORITATIVE_ABOUT.map((limit) => `- ${limit}`),
    "",
    ...courses.flatMap((course) => [...sectionFor(course), ""]),
  ].join("\n");
}

// A course nobody could read fails the run, because the alternative is a run that reports an empty
// course as a clean one — which is the shape a locked-out course takes and the property that
// matters most for a run nobody watches.
export function foundSomethingNew(courses) {
  return courses.some(
    (course) => course.failure || course.difference.onlyOnThePage.objects.length > 0,
  );
}

function summary(courses) {
  const rows = courses.map((course) =>
    course.failure
      ? [course.key, "—", "—", "—", "—", "—", "**could not be read**"]
      : [
          course.key,
          course.items,
          course.difference.onPage.objects,
          course.difference.inWalk,
          course.difference.onBothSides,
          course.difference.onlyOnThePage.objects.length,
          course.difference.onlyInTheWalk.length,
        ],
  );

  return table(
    [
      "Course",
      "Items",
      "Objects on the page",
      "In the walk",
      "On both sides",
      "Only on the page",
      "Only in the walk",
    ],
    rows,
  );
}

function sectionFor(course) {
  if (course.failure) {
    return [
      `## ${course.key} — could not be read`,
      "",
      `\`${course.courseId}\`: ${course.failure}`,
      "",
      "This is a failure and not a course with no content. Nothing below was measured for it.",
    ];
  }

  const { onlyOnThePage, onlyInTheWalk } = course.difference;
  return [
    `## ${course.key} — ${course.course}`,
    "",
    `\`${course.courseId}\`, ${course.items} content items read.`,
    "",
    ...found("On the page, not in the walk", onlyOnThePage.objects),
    ...found("Links on the page the walk does not have", onlyOnThePage.navigation),
    ...missing(onlyInTheWalk),
    ...unreadable(course.unreadableItems),
  ];
}

function found(heading, objects) {
  if (!objects.length) return [];
  return [
    `### ${heading}`,
    "",
    ...objects.flatMap((object) => {
      const items = itemsCarrying(object.carriedBy);
      return [
        `- \`${object.address}\` — ${object.kinds.join(", ")}${shape(object)}`,
        ...items
          .slice(0, ITEMS_IN_REPORT)
          .map(
            (carrier) =>
              `  - on **${carrier.itemTitle}** (${carrier.itemUrl})` +
              `${carrier.label ? `, as “${carrier.label}”` : ""}` +
              `${carrier.frame ? `, inside ${carrier.frame}` : ""}` +
              `\n    \`\`\`html\n    ${trimmed(carrier.element)}\n    \`\`\``,
          ),
        ...alsoOn(items.length),
      ];
    }),
    "",
  ];
}

// One line per item, not per element. An address on a page twice — on the element and on the
// control beside it — is the same finding about the same item, and saying it twice reads as two.
function itemsCarrying(carriers) {
  const byItem = new Map();
  for (const carrier of carriers)
    if (!byItem.has(carrier.itemId)) byItem.set(carrier.itemId, carrier);
  return [...byItem.values()];
}

// An address on many items is shown on a few of them and counted for the rest. The element is what
// diagnoses a finding and it is the same element every time, so the forty-third copy of it costs
// the document the one property it has to have: that the Owner can paste it back whole.
function alsoOn(items) {
  const rest = items - ITEMS_IN_REPORT;
  if (rest <= 0) return [];
  return [`  - and on ${rest} further ${rest === 1 ? "item" : "items"}`];
}

function missing(expected) {
  if (!expected.length) return [];
  return [
    "### In the walk, not on the page",
    "",
    ...table(
      ["What", "Kind", "Trail", "Path", "Address"],
      expected.map((each) => [each.name, each.kind, each.trail, each.path, `\`${each.url}\``]),
    ),
    "",
  ];
}

function unreadable(items) {
  if (!items.length) return [];
  return [
    "### Items that could not be read",
    "",
    ...items.map((item) => `- ${item.url} — ${item.reason}`),
    "",
    "A difference on this course is read against these: an item nobody could open carries objects",
    "neither side counted.",
    "",
  ];
}

// The two things that decide what a finding is for #47: whether a sync could have brought it
// across at all, and whether the address is one NTULearn serves files from.
function shape(object) {
  if (object.offsite) return " — off NTULearn, so whatever it loads is not readable from here";
  return object.fileShaped ? " — a file address" : "";
}

function trimmed(element) {
  const flat = element.replace(/\s+/g, " ").trim();
  return flat.length > ELEMENT_IN_REPORT ? `${flat.slice(0, ELEMENT_IN_REPORT)}…` : flat;
}

function table(headings, rows) {
  return [
    `| ${headings.join(" | ")} |`,
    `| ${headings.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}
