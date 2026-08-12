const ELEMENT_LIMIT = 300;
const AUTHORITY = [
  "the contents of a cross-origin frame, which the browser will not let this read",
  "anything a page loads only after a click, which this never makes",
  "anything not on a content item — a conversation, a gradebook, a tool outside the outline",
  "anything also carried by the bare course outline, which is subtracted as the application's own" +
    " furniture and would take a genuine object with it",
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
    ...AUTHORITY.map((limit) => `- ${limit}`),
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
      ? [course.key, "—", "—", "—", "—", "**could not be read**"]
      : [
          course.key,
          course.items,
          course.difference.onPage.objects,
          course.difference.inWalk,
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
    ...objects.flatMap((object) => [
      `- \`${object.address}\` — ${object.kinds.join(", ")}${offsite(object)}`,
      ...object.carriedBy.map(
        (carrier) =>
          `  - on **${carrier.itemTitle}** (${carrier.itemUrl})` +
          `${carrier.frame ? ` inside ${carrier.frame}` : ""}` +
          `\n    \`\`\`html\n    ${trimmed(carrier.element)}\n    \`\`\``,
      ),
    ]),
    "",
  ];
}

function missing(attachments) {
  if (!attachments.length) return [];
  return [
    "### In the walk, not on the page",
    "",
    ...table(
      ["File", "Trail", "Address"],
      attachments.map((each) => [each.file, each.trail, `\`${each.url}\``]),
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

function offsite(object) {
  if (!object.offsite) return "";
  return " — off NTULearn, so what it embeds is not readable from here";
}

function trimmed(element) {
  const flat = element.replace(/\s+/g, " ").trim();
  return flat.length > ELEMENT_LIMIT ? `${flat.slice(0, ELEMENT_LIMIT)}…` : flat;
}

function table(headings, rows) {
  return [
    `| ${headings.join(" | ")} |`,
    `| ${headings.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}
