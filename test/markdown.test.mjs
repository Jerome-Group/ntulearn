import assert from "node:assert/strict";
import test from "node:test";
import {
  announcementDocument,
  contentDocument,
  courseDocument,
  htmlToMarkdown,
  isoDate,
  isUncopiedDocument,
  syncStamp,
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

const NOTE = (what) => `> **Not copied** — ${what}. Open this item in NTULearn to see it.`;

test("writes down an embedded object where the conversion takes it out", () => {
  assert.equal(
    htmlToMarkdown('<p>Watch this:</p><iframe src="/webapps/blti/launchLink?id=7"></iframe>'),
    `Watch this:\n\n${NOTE("an embedded `iframe` at /webapps/blti/launchLink?id=7")}`,
  );
  assert.equal(
    htmlToMarkdown('<object data="/x/player.swf"></object>'),
    NOTE("an embedded `object` at /x/player.swf"),
  );
  assert.equal(
    htmlToMarkdown('<embed src="/x/clip.mp4">'),
    NOTE("an embedded `embed` at /x/clip.mp4"),
  );
});

test("says so where the object it removed had no address of its own", () => {
  assert.equal(htmlToMarkdown("<iframe></iframe>"), NOTE("an embedded `iframe` with no address"));
});

test("removes what carries nothing a student wants without a word about it", () => {
  assert.equal(htmlToMarkdown("<style>a{}</style><p>text</p>"), "text");
  assert.equal(htmlToMarkdown('<form action="/x"><input name="q"></form><p>text</p>'), "text");
});

test("writes down a file a body links to and NTULearn never called an attachment", () => {
  assert.equal(
    htmlToMarkdown('<a href="/bbcswebdav/pid-1/xid-9">Reading 1</a>'),
    `[Reading 1](/bbcswebdav/pid-1/xid-9)\n\n${NOTE(
      "a file at /bbcswebdav/pid-1/xid-9 that NTULearn did not describe as an attachment",
    )}`,
  );
  assert.equal(
    htmlToMarkdown('<img src="/bbcswebdav/pid-1/xid-9" alt="Diagram">'),
    `![Diagram](/bbcswebdav/pid-1/xid-9)\n\n${NOTE(
      "a file at /bbcswebdav/pid-1/xid-9 that NTULearn did not describe as an attachment",
    )}`,
  );
});

test("says nothing about a link out, or about another page of the course", () => {
  assert.equal(
    htmlToMarkdown('<a href="https://plato.stanford.edu/entries/mill/">Mill</a>'),
    "[Mill](https://plato.stanford.edu/entries/mill/)",
  );
  assert.equal(
    htmlToMarkdown('<a href="/ultra/courses/_123_1/outline">the outline</a>'),
    "[the outline](/ultra/courses/_123_1/outline)",
  );
});

test("says nothing about a file NTULearn did describe, which is already an attachment", () => {
  const html = `<a ${embed({ linkName: "Handout00.pdf" })} href="/bbcswebdav/xid-1"></a>`;
  assert.equal(htmlToMarkdown(html), "[Handout00.pdf](/bbcswebdav/xid-1)");
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

// The overview used to stamp the current time into itself, which made it differ from itself on
// every run and put a permanent floor of one per course under `markdownWritten` (#57, ADR-0008).
test("writes a course overview that is the same twice for the same course", () => {
  const course = { id: "_1_1", displayId: "AB1234", displayName: "Analysis" };

  assert.equal(courseDocument(course), courseDocument(course));
  assert.doesNotMatch(courseDocument(course), /Synced/);
});

test("writes the run's own time down as a stamp of its own", () => {
  const markdown = syncStamp("2026-08-13T09:14:22.481Z");

  assert.match(markdown, /^# Last synced\n/);
  assert.match(markdown, /- Synced: 2026-08-13T09:14:22\.481Z\n/);
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
