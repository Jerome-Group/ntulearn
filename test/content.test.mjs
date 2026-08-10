import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentName,
  attachmentsOf,
  externalLinkOf,
  isFile,
  isFolder,
} from "../src/ntulearn/content.mjs";

const encode = (attachment) => JSON.stringify(attachment).replaceAll('"', "&quot;");

test("recognises a folder by either shape NTULearn uses", () => {
  assert.equal(isFolder({ contentHandler: "resource/x-bb-folder" }), true);
  assert.equal(isFolder({ contentDetail: { "resource/x-bb-folder": { isFolder: true } } }), true);
  assert.equal(isFolder({ contentHandler: "resource/x-bb-document" }), false);
  assert.equal(isFolder({}), false);
});

test("treats a Learning Module as a container, so its children are walked", () => {
  const lesson = {
    contentHandler: "resource/x-bb-lesson",
    contentDetail: { "resource/x-bb-lesson": { isLesson: true, isFolder: true } },
  };
  assert.equal(isFolder(lesson), true);
});

test("a detail that is not a container leaves the item one", () => {
  const file = {
    contentHandler: "resource/x-bb-file",
    contentDetail: { "resource/x-bb-file": { file: { permanentUrl: "/bbcswebdav/one" } } },
  };
  assert.equal(isFolder(file), false);
});

test("recognises a file item", () => {
  assert.equal(isFile({ contentHandler: "resource/x-bb-file" }), true);
  assert.equal(isFile({ contentHandler: "resource/x-bb-folder" }), false);
});

test("collects the attached file and the ones embedded in the body", () => {
  const embedded = JSON.stringify({ resourceUrl: "/bbcswebdav/two", fileName: "two.pdf" });
  const attachments = attachmentsOf({
    contentDetail: { "resource/x-bb-file": { file: { permanentUrl: "/bbcswebdav/one" } } },
    body: { rawText: `<a data-bbfile="${embedded.replaceAll('"', "&quot;")}">two</a>` },
  });

  assert.deepEqual(
    attachments.map((attachment) => attachment.resourceUrl),
    ["/bbcswebdav/one", "/bbcswebdav/two"],
  );
});

test("falls back to the viewer link, without its display options, when resourceUrl is absent", () => {
  const encoded = encode({
    linkName: "Handout00.pdf",
    viewerUrl: "https://ntulearn.ntu.edu.sg/bbcswebdav/xid-1?locale=en_US&render=inline",
  });
  const [attachment] = attachmentsOf({ body: { rawText: `<a data-bbfile="${encoded}"></a>` } });

  assert.equal(attachment.resourceUrl, "https://ntulearn.ntu.edu.sg/bbcswebdav/xid-1");
  assert.equal(attachment.linkName, "Handout00.pdf");
});

test("falls back to the element's own link when neither URL is named", () => {
  const encoded = encode({ linkName: "Handout01.pdf" });
  const [attachment] = attachmentsOf({
    body: { rawText: `<a data-bbfile="${encoded}" href="/bbcswebdav/xid-2"></a>` },
  });

  assert.equal(attachment.resourceUrl, "/bbcswebdav/xid-2");
});

test("leaves an outbound link alone, however it is tagged", () => {
  const encoded = encode({ linkName: "Internship" });
  const item = {
    body: { rawText: `<a data-bbfile="${encoded}" href="https://blogs.ntu.edu.sg/x"></a>` },
  };

  assert.deepEqual(attachmentsOf(item), []);
});

test("collects an embed carried on an image as well as on a link", () => {
  const encoded = encode({ fileName: "diagram.png" });
  const [attachment] = attachmentsOf({
    body: { rawText: `<img data-bbfile="${encoded}" src="/bbcswebdav/xid-3" />` },
  });

  assert.equal(attachment.resourceUrl, "/bbcswebdav/xid-3");
});

test("prefers resourceUrl over the links that stand in for it", () => {
  const encoded = encode({
    resourceUrl: "/bbcswebdav/named",
    viewerUrl: "https://ntulearn.ntu.edu.sg/bbcswebdav/viewer?render=inline",
  });
  const [attachment] = attachmentsOf({
    body: { rawText: `<a data-bbfile="${encoded}" href="/bbcswebdav/href"></a>` },
  });

  assert.equal(attachment.resourceUrl, "/bbcswebdav/named");
});

test("keeps an embedded player out, URL or no URL", () => {
  const encoded = encode({
    linkType: "resource/x-bb-blti-link",
    bbtype: "embedded-app",
    title: "Why everyone should know about sustainability",
    resourceUrl: "undefined",
  });
  const item = { body: { rawText: `<a href="undefined" data-bbfile="${encoded}"></a>` } };

  assert.deepEqual(attachmentsOf(item), []);
});

test("ignores a malformed data-bbfile attribute rather than failing the item", () => {
  assert.deepEqual(attachmentsOf({ body: { rawText: '<a data-bbfile="{not json">x</a>' } }), []);
});

test("returns each attachment once, however many times it is referenced", () => {
  const encoded = JSON.stringify({ resourceUrl: "/bbcswebdav/one" }).replaceAll('"', "&quot;");
  const item = {
    body: {
      rawText: `<a data-bbfile="${encoded}"></a>`,
      displayText: `<a data-bbfile="${encoded}"></a>`,
    },
  };
  assert.equal(attachmentsOf(item).length, 1);
});

test("decodes an escaped ampersand without decoding what follows it", () => {
  const encoded = "{&quot;resourceUrl&quot;:&quot;/a?x=1&amp;lt=2&quot;}";
  const [attachment] = attachmentsOf({ body: { rawText: `<a data-bbfile="${encoded}"></a>` } });
  assert.equal(attachment.resourceUrl, "/a?x=1&lt=2");
});

test("names an attachment, falling back until something is available", () => {
  const item = { title: "Unnamed" };
  assert.equal(attachmentName(item, { fileName: "a.pdf", linkName: "b" }), "a.pdf");
  assert.equal(attachmentName(item, { linkName: "b.pdf" }), "b.pdf");
  assert.equal(attachmentName(item, { displayName: "c.pdf" }), "c.pdf");
  assert.equal(attachmentName(item, {}), "Unnamed.bin");
});

test("resolves an external link against the NTULearn origin", () => {
  assert.equal(
    externalLinkOf({ contentDetail: { lti: { url: "/webapps/tool" } } }),
    "https://ntulearn.ntu.edu.sg/webapps/tool",
  );
  assert.equal(
    externalLinkOf({ contentDetail: { link: { url: "https://example.org/x" } } }),
    "https://example.org/x",
  );
  assert.equal(
    externalLinkOf({ contentDetail: { lti: { placement: { launchLink: "/launch" } } } }),
    "https://ntulearn.ntu.edu.sg/launch",
  );
  assert.equal(externalLinkOf({}), null);
});
