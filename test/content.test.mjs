import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentName,
  attachmentsOf,
  externalLinkOf,
  isFile,
  isFolder,
} from "../src/ntulearn/content.mjs";

test("recognises a folder by either shape NTULearn uses", () => {
  assert.equal(isFolder({ contentHandler: "resource/x-bb-folder" }), true);
  assert.equal(isFolder({ contentDetail: { "resource/x-bb-folder": { isFolder: true } } }), true);
  assert.equal(isFolder({ contentHandler: "resource/x-bb-document" }), false);
  assert.equal(isFolder({}), false);
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
