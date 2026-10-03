import assert from "node:assert/strict";
import test from "node:test";
import {
  courseAnnouncementFixture,
  ANNOUNCEMENT_COURSE as COURSE,
} from "./fixtures/course-announcement.mjs";
import { readKalturaMediaGallery } from "../src/media/gallery-browser.mjs";
import { discoverCourseMedia } from "../src/media/workflow.mjs";
import { observedGalleryLaunch } from "../src/media/gallery-launch.mjs";

const LINK =
  "https://ntulearn.ntu.edu.sg/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=fixture-placement&content_id=fixture-gallery&course_id=_fixture_1&wrapped=true";
function snapshot() {
  return {
    course: { id: COURSE.courseId },
    items: [
      {
        id: "fixture-gallery",
        title: "Media Gallery",
        contentHandler: "resource/x-bb-lti-launch",
        contentDetail: {
          "resource/x-bb-lti-launch": {
            launchLink: LINK,
            placement: { id: "fixture-placement", launchLink: LINK },
          },
        },
      },
    ],
  };
}
test("observed current Gallery launch opens directly before any outline goto or trigger control", async () => {
  const f = courseAnnouncementFixture();
  const navigations = [];
  f.page.goto = async (url) => {
    navigations.push(url);
    assert.equal(url, LINK);
    await f.send("GET", url);
  };
  const result = await readKalturaMediaGallery({
    page: f.page,
    course: COURSE,
    snapshot: snapshot(),
  });
  assert.equal(result.complete, true);
  assert.deepEqual(navigations, [LINK]);
  assert.equal(f.state.close, 0);
  assert.equal(f.state.gallery, 0);
  assert.equal(f.state.fallback, 1);
});
test("metadata read has positive guard before its single canonical snapshot and cannot bypass blocked write", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  let forwarded = 0,
    reads = 0,
    attachments = 0;
  await assert.rejects(
    discoverCourseMedia({
      course: COURSE,
      client: {
        withBrowserPage: async (read) => read(f.page),
        readCourse: async () => {
          reads++;
          if (f.state.handler) await f.send("POST");
          else forwarded++;
          return snapshot();
        },
        readAttachments: async () => {
          attachments++;
          return [];
        },
      },
    }),
    { code: "GALLERY_NOTICE_WRITE_BLOCKED" },
  );
  assert.equal(reads, 1);
  assert.equal(forwarded, 0);
  assert.equal(attachments, 0);
  assert.equal(f.state.abort, 1);
});
const detail = (s) => s.items[0].contentDetail["resource/x-bb-lti-launch"];
const replaceLink = (s, value) => {
  detail(s).launchLink = value;
  detail(s).placement.launchLink = value;
};
for (const [name, mutate] of [
  ["foreign origin", (s) => replaceLink(s, LINK.replace("ntulearn.ntu.edu.sg", "foreign.example"))],
  ["foreign course", (s) => replaceLink(s, LINK.replace("_fixture_1", "_foreign_1"))],
  ["foreign content", (s) => replaceLink(s, LINK.replace("fixture-gallery", "foreign-content"))],
  [
    "snapshot course",
    (s) => {
      s.course.id = "_foreign_1";
    },
  ],
  [
    "declared course",
    (s) => {
      detail(s).placement.courseId = "_foreign_1";
    },
  ],
  [
    "declared content",
    (s) => {
      detail(s).contentId = "foreign-content";
    },
  ],
  [
    "declared placement",
    (s) => {
      detail(s).placement.id = "foreign-placement";
    },
  ],
  [
    "absent placement",
    (s) => {
      delete detail(s).placement;
    },
  ],
  [
    "absent placement id",
    (s) => {
      delete detail(s).placement.id;
    },
  ],
  [
    "malformed placement",
    (s) => {
      detail(s).placement = [];
    },
  ],
  [
    "malformed placement id",
    (s) => {
      detail(s).placement.id = 7;
    },
  ],
  [
    "duplicate field conflict",
    (s) => {
      detail(s).placement.launchLink = LINK.replace("fixture-placement", "other-placement");
    },
  ],
  [
    "ambiguous items",
    (s) => {
      s.items.push({ ...s.items[0], id: "second-gallery" });
    },
  ],
  ["signed query", (s) => replaceLink(s, LINK + "&ks=fixture-private")],
  ["encoded signed query", (s) => replaceLink(s, LINK + "&%61ccess_token=fixture-private")],
  ["duplicate query", (s) => replaceLink(s, LINK + "&course_id=_fixture_1")],
  ["unknown endpoint", (s) => replaceLink(s, LINK.replace("launchPlacement", "launchLink"))],
  ["private file", (s) => replaceLink(s, "file:///private/profile/session")],
  ["fragment", (s) => replaceLink(s, LINK + "#fixture-private")],
  ["unobserved wrapped class", (s) => replaceLink(s, LINK.replace("wrapped=true", "wrapped=1"))],
  [
    "unknown launch field",
    (s) => {
      detail(s).launchUrl = LINK;
    },
  ],
  [
    "malformed field",
    (s) => {
      detail(s).launchLink = null;
    },
  ],
  [
    "source bound",
    (s) => {
      s.items = Array(20001).fill(s.items[0]);
    },
  ],
])
  test(`observed launch ${name} refuses without legacy fallback or address retention`, async () => {
    const s = snapshot();
    mutate(s);
    assert.throws(() => observedGalleryLaunch({ snapshot: s, course: COURSE }), {
      code: "GALLERY_LAUNCH_REFUSED",
    });
    const f = courseAnnouncementFixture();
    let navigations = 0;
    f.page.goto = async () => {
      navigations++;
    };
    const result = await readKalturaMediaGallery({ page: f.page, course: COURSE, snapshot: s });
    assert.equal(result.complete, false);
    assert.equal(result.diagnostic.code, "GALLERY_LAUNCH_REFUSED");
    assert.equal(navigations, 0);
    assert.equal(f.state.close, 0);
    assert.equal(f.state.gallery, 0);
    assert.doesNotMatch(
      JSON.stringify(result),
      /fixture-private|fixture-placement|_fixture_1|https:|file:/,
    );
  });
test("equivalent declared fields deduplicate without synthesizing placement or route values", () => {
  const s = snapshot();
  const reversed = new URL(LINK);
  reversed.search = [...reversed.searchParams]
    .reverse()
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  detail(s).placement.launchLink = reversed.href;
  const result = observedGalleryLaunch({ snapshot: s, course: COURSE });
  assert.ok([LINK, reversed.href].includes(result.url));
  assert.equal(detail(s).placement.id, "fixture-placement");
});
test("genuinely absent launch metadata retains legacy Gallery route and existing verifiers", async () => {
  for (const s of [
    undefined,
    { course: { id: COURSE.courseId }, items: [] },
    { ...snapshot(), items: [{ id: "fixture-gallery", title: "Media Gallery" }] },
  ]) {
    const f = courseAnnouncementFixture({ shown: false });
    const navigations = [];
    f.page.goto = async (url) => {
      navigations.push(url);
    };
    assert.equal(
      (await readKalturaMediaGallery({ page: f.page, course: COURSE, snapshot: s })).complete,
      true,
    );
    assert.equal(navigations.length, 1);
    assert.match(navigations[0], /\/outline$/);
    assert.equal(f.state.gallery, 1);
  }
});
test("one guarded canonical snapshot is shared by content and Gallery within one owned page", async () => {
  const f = courseAnnouncementFixture();
  const current = snapshot();
  let snapshots = 0,
    opened = 0,
    closed = 0;
  f.page.goto = async (url) => {
    assert.equal(url, LINK);
    await f.send("GET", url);
  };
  const result = await discoverCourseMedia({
    course: COURSE,
    client: {
      withBrowserPage: async (read) => {
        opened++;
        try {
          return await read(f.page);
        } finally {
          closed++;
        }
      },
      readCourse: async () => {
        assert.equal(f.state.routes, 1);
        snapshots++;
        return current;
      },
      readAttachments: async () => [],
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.galleryCount, 1);
  assert.equal(snapshots, 1);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(f.state.routes, 1);
});
test("known sticky red Gallery retains independently guarded content authority", async () => {
  const f = courseAnnouncementFixture();
  const current = snapshot();
  current.items.push({
    id: "content-lecture",
    title: "Lecture",
    body: { displayText: '<iframe src="https://youtu.be/fixtureLecture"></iframe>' },
  });
  f.page.goto = async () => {
    await f.send("POST");
    throw new Error("private navigation error");
  };
  const result = await discoverCourseMedia({
    course: COURSE,
    client: {
      withBrowserPage: async (read) => read(f.page),
      readCourse: async () => current,
      readAttachments: async () => [],
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.diagnostic.code, "GALLERY_NOTICE_WRITE_BLOCKED");
  assert.equal(
    result.contentRecordings.filter((recording) => recording.provider === "youtube").length,
    1,
  );
  assert.equal(result.galleryCount, 0);
});

for (const [options, code] of [
  [{ workers: [{}] }, "GALLERY_NOTICE_SERVICE_WORKER"],
  [{ guardFailure: true }, "GALLERY_NOTICE_READ_GUARD_FAILED"],
])
  test(`guard refusal ${code} precedes canonical metadata reads`, async () => {
    const f = courseAnnouncementFixture(options);
    let reads = 0;
    await assert.rejects(
      discoverCourseMedia({
        course: COURSE,
        client: {
          withBrowserPage: async (read) => read(f.page),
          readCourse: async () => {
            reads++;
            return snapshot();
          },
        },
      }),
      { code },
    );
    assert.equal(reads, 0);
  });
for (const boundary of ["metadata", "attachment"])
  test(`blocked write takes priority over concurrent ${boundary} error`, async () => {
    const f = courseAnnouncementFixture();
    const fail = async () => {
      await f.send("POST");
      throw new Error("private failure details");
    };
    await assert.rejects(
      discoverCourseMedia({
        course: COURSE,
        client: {
          withBrowserPage: async (read) => read(f.page),
          readCourse: boundary === "metadata" ? fail : async () => snapshot(),
          readAttachments: fail,
        },
      }),
      { code: "GALLERY_NOTICE_WRITE_BLOCKED" },
    );
    assert.equal(f.state.abort, 1);
    assert.equal(f.state.gallery, 0);
  });
test("direct observed route still refuses a displayed count mismatch", async () => {
  const f = courseAnnouncementFixture();
  const frame = f.page.frames()[0],
    original = frame.evaluate;
  frame.evaluate = async () => ({ ...(await original()), displayedCount: 2 });
  let navigations = 0;
  f.page.goto = async () => {
    navigations++;
  };
  const result = await readKalturaMediaGallery({
    page: f.page,
    course: COURSE,
    snapshot: snapshot(),
  });
  assert.equal(result.complete, false);
  assert.equal(result.queue.length, 0);
  assert.equal(navigations, 1);
  assert.equal(f.state.gallery, 0);
});

test("ambient blocked write during positive page close cannot return green", async () => {
  const f = courseAnnouncementFixture({ shown: false });
  await assert.rejects(
    discoverCourseMedia({
      course: COURSE,
      client: {
        readCourse: async () => snapshot(),
        withBrowserPage: async (read) => {
          try {
            return await read(f.page);
          } finally {
            await f.send("POST");
          }
        },
      },
      readGallery: async () => ({ complete: true, recordings: [], queue: [] }),
    }),
    { code: "GALLERY_NOTICE_WRITE_BLOCKED" },
  );
  assert.equal(f.state.abort, 1);
});
for (const callbackFails of [false, true])
  test(`page close uncertainty takes priority over sticky write (callback failed ${callbackFails})`, async () => {
    const f = courseAnnouncementFixture({ shown: false });
    f.page.close = async () => {
      await f.send("POST");
      throw new Error("private page-close details");
    };
    await assert.rejects(
      discoverCourseMedia({
        course: COURSE,
        client: {
          readCourse: async () => snapshot(),
          withBrowserPage: async (read) => {
            try {
              return await read(f.page);
            } finally {
              await f.page.close();
            }
          },
        },
        readGallery: async () => {
          if (callbackFails) {
            await f.send("POST");
            throw new Error("private callback details");
          }
          return { complete: true, recordings: [], queue: [] };
        },
      }),
      { code: "MEDIA_BROWSER_CLEANUP", globalSafety: true },
    );
  });
