import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentName,
  attachmentsOf,
  externalLinkOf,
  isAttachedFile,
  isFile,
  isFolder,
  kindOf,
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

test("says what an item is, in a word where a student would not read the handler", () => {
  assert.equal(kindOf({ contentHandler: "resource/x-bb-asmt-test-link" }), "Test");
  assert.equal(kindOf({ contentHandler: "resource/x-bb-assignment" }), "Assignment");
  assert.equal(kindOf({ contentHandler: "resource/x-plugin-scormengine" }), "SCORM package");
  assert.equal(kindOf({ contentHandler: "resource/x-bb-courselink" }), "resource/x-bb-courselink");
  assert.equal(kindOf({}), "Unknown");
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

test("asks the element first, then the viewer link, then the snapshot", () => {
  const all = encode({
    resourceUrl: "/bbcswebdav/snapshot",
    viewerUrl: "https://ntulearn.ntu.edu.sg/bbcswebdav/viewer?render=inline",
  });
  const [fromElement] = attachmentsOf({
    body: { rawText: `<a data-bbfile="${all}" href="/bbcswebdav/live"></a>` },
  });
  assert.equal(fromElement.resourceUrl, "/bbcswebdav/live");

  const [fromViewer] = attachmentsOf({ body: { rawText: `<a data-bbfile="${all}"></a>` } });
  assert.equal(fromViewer.resourceUrl, "https://ntulearn.ntu.edu.sg/bbcswebdav/viewer");

  const snapshotOnly = encode({ resourceUrl: "/bbcswebdav/snapshot" });
  const [fromSnapshot] = attachmentsOf({
    body: { rawText: `<a data-bbfile="${snapshotOnly}"></a>` },
  });
  assert.equal(fromSnapshot.resourceUrl, "/bbcswebdav/snapshot");
});

// The shape that made every one of the ten reported failures: the snapshot points at a resource
// id that is gone, and the element points at the file NTULearn actually serves.
test("takes the live link over a resourceUrl left behind by a replaced file", () => {
  const encoded = encode({
    linkName: "2026 CAO Mentorship Programmes - Overview to Students.pdf",
    resourceUrl:
      "https://ntulearn.ntu.edu.sg/bbcswebdav/pid-5965241-dt-content-rid-58357318_1/xid-58357318_1",
  });
  const [attachment] = attachmentsOf({
    body: {
      rawText:
        `<a data-bbfile="${encoded}" ` +
        `href="https://ntulearn.ntu.edu.sg/bbcswebdav/pid-5965241-dt-content-rid-64341018_1/xid-64341018_1"></a>`,
    },
  });

  assert.match(attachment.resourceUrl, /rid-64341018_1/);
});

// A `/sessions/<id>/…` value was never durable: it belongs to the authoring session that wrote it.
test("takes the live link over an upload URL from the authoring session", () => {
  const encoded = encode({
    fileName: "Copyright_NTULearn.jpg",
    resourceUrl: "https://ntulearn.ntu.edu.sg/sessions/53/53FBC8F0/dd257e7a/Copyright_NTULearn.jpg",
  });
  const [attachment] = attachmentsOf({
    body: { rawText: `<img data-bbfile="${encoded}" src="/bbcswebdav/xid-64475503_1" />` },
  });

  assert.equal(attachment.resourceUrl, "/bbcswebdav/xid-64475503_1");
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

// A SCORM package is a launch rather than a file, so the link is the whole of what can be kept.
test("a launch address is a link, whichever of NTULearn's names it arrives under", () => {
  const scorm = {
    contentHandler: "resource/x-plugin-scormengine",
    contentDetail: {
      "resource/x-plugin-scormengine": {
        launchUrl: "/webapps/scor-scormengine-BB5/delivery?action=launchPackage&content_id=_1_1",
      },
    },
  };
  assert.equal(
    externalLinkOf(scorm),
    "https://ntulearn.ntu.edu.sg/webapps/scor-scormengine-BB5/delivery" +
      "?action=launchPackage&content_id=_1_1",
  );
});

// The reasoning #77 got wrong, kept as a test even though #78 measured its population at zero: a
// body may link the very file the sync is downloading, and a note keyed on the HTML alone cannot
// tell that from a file nothing fetches. `docs/adr/0011` is why nothing calls this yet.
const OWN = "/bbcswebdav/pid-111-dt-content-rid-222_1/xid-222_1";
const SAME_FILE_OTHER_ADDRESS = "/bbcswebdav/pid-999-dt-content-rid-222_1/xid-222_1";
const ANOTHER_FILE = "/bbcswebdav/pid-333-dt-content-rid-444_1/xid-444_1";
const attached = [{ resourceUrl: OWN }];

test("an item whose attached file is also linked in its body is not a missing file", () => {
  assert.equal(isAttachedFile(attached, OWN), true);
});

test("the same file at a second address is still the same file", () => {
  assert.equal(isAttachedFile(attached, SAME_FILE_OTHER_ADDRESS), true);
});

test("a query string is a display option rather than another file", () => {
  assert.equal(isAttachedFile(attached, `${OWN}?view=inline`), true);
  assert.equal(isAttachedFile([{ resourceUrl: `${OWN}?download=1` }], OWN), true);
});

test("an address the item does not carry is not one of its attachments", () => {
  assert.equal(isAttachedFile(attached, ANOTHER_FILE), false);
  assert.equal(isAttachedFile([], OWN), false);
});

// The two shapes a note must never reach. #78 counted 202 of the first and none of the second
// across thirteen courses, and neither is a file this item carries.
test("a link out, and a link to another page of the course, are not attachments", () => {
  assert.equal(isAttachedFile(attached, "https://example.com/paper.pdf"), false);
  assert.equal(
    isAttachedFile(attached, "https://ntulearn.ntu.edu.sg/ultra/courses/_1_1/outline"),
    false,
  );
});

test("an address NTULearn never supplied matches nothing", () => {
  assert.equal(isAttachedFile(attached, undefined), false);
  assert.equal(isAttachedFile(attached, ""), false);
  assert.equal(isAttachedFile(attached, "undefined"), false);
  assert.equal(isAttachedFile([{ resourceUrl: undefined }], "not a url at all"), false);
});
