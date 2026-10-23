import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentName,
  attachmentsOf,
  itemPresentationOf,
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
  assert.deepEqual(itemPresentationOf({ contentDetail: { lti: { url: "/webapps/tool" } } }), {
    kind: "external-link",
    url: "https://ntulearn.ntu.edu.sg/webapps/tool",
  });
  assert.deepEqual(
    itemPresentationOf({ contentDetail: { link: { url: "https://example.org/x" } } }),
    { kind: "external-link", url: "https://example.org/x" },
  );
  assert.deepEqual(
    itemPresentationOf({ contentDetail: { lti: { placement: { launchLink: "/launch" } } } }),
    { kind: "external-link", url: "https://ntulearn.ntu.edu.sg/launch" },
  );
  assert.deepEqual(itemPresentationOf({ contentDetail: { unknown: { launchLink: "/tool" } } }), {
    kind: "external-link",
    url: "https://ntulearn.ntu.edu.sg/tool",
  });
  assert.equal(itemPresentationOf({}), null);
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
  assert.deepEqual(itemPresentationOf(scorm), {
    kind: "external-link",
    url:
      "https://ntulearn.ntu.edu.sg/webapps/scor-scormengine-BB5/delivery" +
      "?action=launchPackage&content_id=_1_1",
  });
});

const ASSESSMENT = {
  id: "assessment",
  contentHandler: "resource/x-bb-asmt-test-link",
  genericReadOnlyData: { dueDate: "2026-10-30T23:59:00+08:00" },
  contentDetail: {
    "resource/x-bb-asmt-test-link": {
      test: {
        assessment: {
          description: "Hidden description",
          instructions: "Hidden instructions",
          showDescription: false,
          showInstructions: false,
        },
        gradingColumn: { dueDate: "2026-10-01T00:00:00.000Z" },
      },
    },
  },
};
const COURSE_LINK = {
  id: "source",
  contentHandler: "resource/x-bb-courselink",
  contentDetailUrl: "/learn/api/v1/courses/synthetic/contents/target",
  contentDetail: {
    "resource/x-bb-courselink": {
      courseContent: "source",
      linkSourceTable: "CONTENT",
      linkSourceId: "target",
    },
  },
};

test("projects only the personal due instant and course outline for an assessment", () => {
  assert.deepEqual(itemPresentationOf(ASSESSMENT, { courseId: "synthetic" }), {
    kind: "assessment-card",
    dueDate: "2026-10-30T15:59:00.000Z",
    courseUrl: "https://ntulearn.ntu.edu.sg/ultra/courses/synthetic/outline",
  });
});

test("refuses absent or invalid personal dates without falling back to grading dates", () => {
  for (const dueDate of [
    undefined,
    null,
    1_800_000_000_000,
    "",
    "tomorrow",
    "2026-10-30",
    "2026-10-30T15:59:00",
    "2026-02-29T15:59:00Z",
    "2026-04-31T15:59:00Z",
    "2026-13-01T15:59:00Z",
    "2026-10-30T24:00:00Z",
    "2026-10-30T15:60:00Z",
    "2026-10-30T15:59:60Z",
    "2026-10-30T15:59:00+24:00",
    "2026-10-30T15:59:00Z extra",
  ]) {
    assert.equal(
      itemPresentationOf(
        { ...ASSESSMENT, genericReadOnlyData: { dueDate } },
        { courseId: "synthetic" },
      ),
      null,
      String(dueDate),
    );
  }
  const leapDay = { ...ASSESSMENT, genericReadOnlyData: { dueDate: "2028-02-29T00:00:00Z" } };
  assert.equal(
    itemPresentationOf(leapDay, { courseId: "synthetic" }).dueDate,
    "2028-02-29T00:00:00.000Z",
  );
});

test("requires the assessment handler, test detail and course identity", () => {
  assert.equal(itemPresentationOf(ASSESSMENT), null);
  assert.equal(itemPresentationOf(ASSESSMENT, { courseId: "" }), null);
  assert.equal(
    itemPresentationOf({ ...ASSESSMENT, contentDetail: {} }, { courseId: "synthetic" }),
    null,
  );
  assert.equal(
    itemPresentationOf({ ...ASSESSMENT, contentHandler: "unknown" }, { courseId: "synthetic" }),
    null,
  );
  for (const test of [null, [], "assessment", true]) {
    assert.equal(
      itemPresentationOf(
        { ...ASSESSMENT, contentDetail: { "resource/x-bb-asmt-test-link": { test } } },
        { courseId: "synthetic" },
      ),
      null,
    );
  }
});

test("projects only validated same-course link identity and outline navigation", () => {
  const expected = {
    kind: "course-link",
    targetContentId: "target",
    courseUrl: "https://ntulearn.ntu.edu.sg/ultra/courses/synthetic/outline",
  };
  assert.deepEqual(itemPresentationOf(COURSE_LINK, { courseId: "synthetic" }), expected);
  assert.deepEqual(
    itemPresentationOf(
      {
        ...COURSE_LINK,
        contentDetailUrl:
          "https://ntulearn.ntu.edu.sg/learn/api/v1/courses/synthetic/contents/target",
      },
      { courseId: "synthetic" },
    ),
    expected,
  );
  const encoded = {
    ...COURSE_LINK,
    contentDetailUrl: "/learn/api/v1/courses/synthetic%20course/contents/target%20item",
    contentDetail: {
      "resource/x-bb-courselink": {
        ...COURSE_LINK.contentDetail["resource/x-bb-courselink"],
        linkSourceId: "target item",
      },
    },
  };
  assert.deepEqual(itemPresentationOf(encoded, { courseId: "synthetic course" }), {
    ...expected,
    targetContentId: "target item",
    courseUrl: "https://ntulearn.ntu.edu.sg/ultra/courses/synthetic%20course/outline",
  });
});

test("refuses inconsistent, cross-course, ambiguous and malformed course-link targets", () => {
  const detail = COURSE_LINK.contentDetail["resource/x-bb-courselink"];
  for (const changed of [
    { courseContent: "other-source" },
    { linkSourceId: "source" },
    { linkSourceId: "" },
    { linkSourceId: null },
    { linkSourceId: "different-target" },
    { linkSourceTable: "FORUM" },
  ]) {
    assert.equal(
      itemPresentationOf(
        {
          ...COURSE_LINK,
          contentDetail: { "resource/x-bb-courselink": { ...detail, ...changed } },
        },
        { courseId: "synthetic" },
      ),
      null,
    );
  }
  for (const contentDetailUrl of [
    undefined,
    "",
    "/learn/api/v1/courses/another-course/contents/target",
    "/learn/api/v1/courses/synthetic/contents/another-target",
    "/learn/api/v1/courses/synthetic/contents/target/extra",
    "/learn/api/v1/courses/synthetic/contents/target/",
    "/wrong/../learn/api/v1/courses/synthetic/contents/target",
    "/learn/api/v1/courses/synthetic/contents/target?expand=anything",
    "/learn/api/v1/courses/synthetic/contents/target?",
    "/learn/api/v1/courses/synthetic/contents/target#section",
    "/learn/api/v1/courses/synthetic/contents/target#",
    "/learn/api/v1/courses/synthetic/contents/%ZZ",
    "https://example.test/learn/api/v1/courses/synthetic/contents/target",
    "https://student@ntulearn.ntu.edu.sg/learn/api/v1/courses/synthetic/contents/target",
    "http://ntulearn.ntu.edu.sg/learn/api/v1/courses/synthetic/contents/target",
  ]) {
    assert.equal(
      itemPresentationOf({ ...COURSE_LINK, contentDetailUrl }, { courseId: "synthetic" }),
      null,
      String(contentDetailUrl),
    );
  }
  assert.equal(itemPresentationOf(COURSE_LINK), null);
  assert.equal(
    itemPresentationOf(
      {
        ...COURSE_LINK,
        contentDetailUrl: "/learn/api/v1/courses/synthetic/contents/tar\nget",
        contentDetail: { "resource/x-bb-courselink": { ...detail, linkSourceId: "tar\nget" } },
      },
      { courseId: "synthetic" },
    ),
    null,
  );
});

test("keeps folders body-only and targetless links without a presentation", () => {
  assert.equal(
    itemPresentationOf(
      {
        ...ASSESSMENT,
        contentDetail: { ...ASSESSMENT.contentDetail, folder: { isFolder: true, url: "/launch" } },
      },
      { courseId: "synthetic" },
    ),
    null,
  );
  assert.equal(
    itemPresentationOf(
      {
        contentHandler: "resource/x-bb-externallink",
        contentDetail: { "resource/x-bb-externallink": {} },
      },
      { courseId: "synthetic" },
    ),
    null,
  );
  assert.deepEqual(
    itemPresentationOf(
      {
        ...ASSESSMENT,
        genericReadOnlyData: {},
        contentDetail: { "resource/x-bb-asmt-test-link": { url: "/launch" } },
      },
      { courseId: "synthetic" },
    ),
    { kind: "external-link", url: "https://ntulearn.ntu.edu.sg/launch" },
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
