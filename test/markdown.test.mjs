import assert from "node:assert/strict";
import test from "node:test";
import {
  announcementDocument,
  contentDocument,
  courseDocument,
  htmlToMarkdown,
  isoDate,
  isUncopiedDocument,
  uncopiedDocument,
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

const embed = (attachment) => `data-bbfile='${JSON.stringify(attachment)}'`;

test("names an attachment link from the embed, NTULearn having left the text empty", () => {
  const html = `<a ${embed({ linkName: "Handout00.pdf" })} href="/bbcswebdav/xid-1"></a>`;
  assert.equal(htmlToMarkdown(html), "[Handout00.pdf](/bbcswebdav/xid-1)");
});

test("gives an embedded player its title and the URL it plays at", () => {
  const html = `<a href="undefined" ${embed({
    title: "Why everyone should know about sustainability (22:29)",
    url: "https://ntulearnv1.ntu.edu.sg/browseandembed/index/media/entryid/0_td7lgutt/",
  })}>undefined</a>`;

  assert.equal(
    htmlToMarkdown(html),
    "[Why everyone should know about sustainability (22:29)]" +
      "(https://ntulearnv1.ntu.edu.sg/browseandembed/index/media/entryid/0_td7lgutt/)",
  );
});

test("prefers the link text NTULearn did supply over the embed's name", () => {
  const html = `<a ${embed({ linkName: "Handout00.pdf" })} href="/bbcswebdav/xid-1">Week 1 notes</a>`;
  assert.equal(htmlToMarkdown(html), "[Week 1 notes](/bbcswebdav/xid-1)");
});

test("falls back through the names an embed may carry", () => {
  const named = (attachment) => htmlToMarkdown(`<a ${embed(attachment)} href="/x"></a>`);

  assert.equal(named({ displayName: "b.pdf" }), "[b.pdf](/x)");
  assert.equal(named({ fileName: "c.pdf" }), "[c.pdf](/x)");
  assert.equal(named({ title: "d" }), "[d](/x)");
  assert.equal(named({}), "[/x](/x)");
});

test("leaves no empty link where the embed offers neither name nor target", () => {
  assert.equal(
    htmlToMarkdown(`<a href="undefined" ${embed({ url: "undefined" })}>undefined</a>`),
    "",
  );
  assert.equal(
    htmlToMarkdown(`<a href="undefined" ${embed({ title: "Video 1" })}>undefined</a>`),
    "Video 1",
  );
});

test("leaves an ordinary link alone", () => {
  assert.equal(
    htmlToMarkdown('<a href="https://example.org/x">read this</a>'),
    "[read this](https://example.org/x)",
  );
});

test("survives a malformed data-bbfile, falling back to the element's own link", () => {
  assert.equal(htmlToMarkdown('<a data-bbfile="{not json" href="/x">text</a>'), "[text](/x)");
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

test("writes down an item there was nothing to copy from", () => {
  const item = {
    title: "⭐Topic 1: Knowledge Check Points",
    contentHandler: "resource/x-bb-asmt-test-link",
  };
  assert.equal(
    uncopiedDocument(item, "Week 1 › Topic 1"),
    "# ⭐Topic 1: Knowledge Check Points\n\n" +
      "- Kind: Test\n" +
      "- Trail: Week 1 › Topic 1\n\n" +
      "This item carries no text, no link and no attachment, so there was nothing to copy. " +
      "Open it in NTULearn.\n\n" +
      "<!-- ntulearn: nothing to copy -->\n",
  );
});

// The mark is addressed to the next run, and the sentence is how the runs before it are still
// recognised — a destination written before the mark existed has to stay correctable (#53).
test("knows its own writing by the mark, and by the sentence that predates it", () => {
  const item = { title: "T", contentHandler: "resource/x-bb-asmt-test-link" };
  assert.equal(isUncopiedDocument(uncopiedDocument(item, "")), true);
  assert.equal(
    isUncopiedDocument("# T\n\n- Kind: Test\n\n<!-- ntulearn: nothing to copy -->\n"),
    true,
  );
  assert.equal(
    isUncopiedDocument(
      "# T\n\n- Kind: Test\n\nThis item carries no text, no link and no attachment, " +
        "so there was nothing to copy. Open it in NTULearn.\n",
    ),
    true,
  );
  assert.equal(
    isUncopiedDocument("# T\n\n## Content\n\nThe week the quiz still had a page\n"),
    false,
  );
  assert.equal(isUncopiedDocument(null), false);
});

test("leaves the trail out of an uncopied item that sits at a course's root", () => {
  const markdown = uncopiedDocument({ title: "T", contentHandler: "x" }, "");
  assert.doesNotMatch(markdown, /Trail/);
  assert.match(markdown, /^# T\n\n- Kind: x\n\n/);
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
