import assert from "node:assert/strict";
import test from "node:test";
import {
  announcementDocument,
  contentDocument,
  courseDocument,
  htmlToMarkdown,
  isoDate,
} from "../src/sync/markdown.mjs";

test("converts HTML to Markdown", () => {
  assert.equal(
    htmlToMarkdown("<h1>Week 1</h1><p>Read <b>this</b>.</p>"),
    "# Week 1\n\nRead **this**.",
  );
  assert.equal(htmlToMarkdown("<ul><li>one</li><li>two</li></ul>"), "-   one\n-   two");
  assert.equal(htmlToMarkdown(null), "");
});

test("strips the ways HTML can carry script into a note", () => {
  assert.equal(htmlToMarkdown('<p onclick="steal()">text</p>'), "text");
  assert.equal(htmlToMarkdown("<script>steal()</script><p>text</p>"), "text");
  assert.equal(htmlToMarkdown('<a href="javascript:steal()">link</a>'), "[link](#)");
});

test("collapses runs of blank lines", () => {
  assert.equal(htmlToMarkdown("<p>a</p><br><br><br><p>b</p>"), "a\n\nb");
});

test("writes a course overview that points back at the source", () => {
  const markdown = courseDocument({ id: "_1_1", displayId: "AB1234", displayName: "Analysis" });
  assert.match(markdown, /^# Analysis\n/);
  assert.match(markdown, /- Course ID: AB1234\n/);
  assert.match(
    markdown,
    /- Source: https:\/\/ntulearn\.ntu\.edu\.sg\/ultra\/courses\/_1_1\/outline\n/,
  );
});

test("writes a content item's description, body and link", () => {
  const item = {
    title: "Lecture 1",
    description: "<p>Overview</p>",
    body: { displayText: "<p>Slides attached</p>" },
  };
  assert.equal(
    contentDocument(item, "https://example.org/tool"),
    "# Lecture 1\n\n## Description\n\nOverview\n\n## Content\n\nSlides attached\n\n## External link\n\nhttps://example.org/tool\n",
  );
});

test("writes nothing for an item that carries neither text nor a link", () => {
  assert.equal(contentDocument({ title: "Empty" }), "");
  assert.equal(contentDocument({ title: "Empty", body: { rawText: "<p></p>" } }), "");
});

test("prefers displayText over rawText", () => {
  const item = { title: "T", body: { displayText: "<p>shown</p>", rawText: "<p>raw</p>" } };
  assert.match(contentDocument(item), /shown/);
  assert.doesNotMatch(contentDocument(item), /raw/);
});

test("writes an announcement with both its dates", () => {
  const markdown = announcementDocument({
    title: "Class cancelled",
    createdDate: "2026-03-01T09:00:00.000Z",
    body: { rawText: "<p>No class today.</p>" },
  });
  assert.match(markdown, /^# Class cancelled\n/);
  assert.match(markdown, /- Created: 2026-03-01T09:00:00\.000Z\n/);
  assert.match(markdown, /- Modified: Unknown\n/);
  assert.match(markdown, /No class today\.\n$/);
});

test("normalises a date whichever way NTULearn sends it", () => {
  assert.equal(isoDate("2026-03-01T09:00:00.000Z"), "2026-03-01T09:00:00.000Z");
  assert.equal(isoDate(1_772_000_000_000), "2026-02-25T06:13:20.000Z");
  assert.equal(isoDate(null), null);
  assert.equal(isoDate(undefined), null);
});
