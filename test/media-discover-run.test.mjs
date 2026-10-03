import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate, setTimeout } from "node:timers";
import { join } from "node:path";
import { chromium } from "playwright";
import { courseAnnouncementFixture } from "./fixtures/course-announcement.mjs";
let originalLaunch;
test.before(() => {
  originalLaunch = chromium.launchPersistentContext;
  chromium.launchPersistentContext = () => {
    throw new Error("Offline browser guard");
  };
});
test.after(() => {
  chromium.launchPersistentContext = originalLaunch;
});
const { runMediaDiscovery } = await import("../src/media/discover-run.mjs");
const { mediaSafetyPath } = await import("../src/media/safety.mjs");
const { mediaQueueLockPath } = await import("../src/media/lock.mjs");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-discovery-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const courses = ["A", "B"].map((key) => ({
    key,
    courseId: key,
    mediaMode: "active",
    destination: join(root, key),
  }));
  const config = {
    courses,
    statePath: join(root, "state.json"),
    profilePath: join(root, "profile"),
  };
  const events = [];
  let active = 0;
  const deps = {
    admission: async () => {},
    open: async (_profile, options) => {
      assert.equal(options.signalOwner, "caller");
      assert.equal(active, 0);
      active++;
      const ordinal = events.filter((e) => e.startsWith("open")).length;
      events.push(`open${ordinal}`);
      return {
        ordinal,
        close: async () => {
          events.push(`close${ordinal}`);
          active--;
        },
      };
    },
    discover: async ({ client, course }) => {
      events.push(`read${course.key}`);
      return {
        complete: client.ordinal !== 0,
        verdict: client.ordinal ? "green" : "red",
        queue: [],
        diagnostic: { code: "GALLERY_NOTICE_WRITE_BLOCKED" },
      };
    },
    writeQueue: async ({ course }) => {
      assert.equal(active, 0);
      events.push(`write${course.key}`);
      return { path: "synthetic-private-queue" };
    },
    writeStatus: async () => null,
  };
  return { root, config, deps, events };
}
test("blocked first context stays red; positive close precedes writes and independent next context", async (t) => {
  const f = await fixture(t);
  const result = await runMediaDiscovery({ config: f.config, key: "all" }, f.deps);
  assert.equal(result.exitCode, 1);
  assert.equal(result.courses.length, 2);
  assert.equal(result.courses[0].complete, false);
  assert.equal(result.courses[1].complete, true);
  assert.deepEqual(f.events, [
    "open0",
    "readA",
    "close0",
    "writeA",
    "open1",
    "readB",
    "close1",
    "writeB",
  ]);
  await assert.rejects(readFile(join(mediaQueueLockPath(f.config.statePath), "owner.json")), {
    code: "ENOENT",
  });
});
test("pending close prevents all later open/write until positive settlement", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const open = f.deps.open;
  f.deps.open = async (...args) => {
    const c = await open(...args);
    const close = c.close;
    c.close = async () => {
      entered();
      await pending;
      await close();
    };
    return c;
  };
  const running = runMediaDiscovery({ config: f.config, key: "all" }, f.deps);
  await started;
  assert.deepEqual(f.events, ["open0", "readA"]);
  release();
  await running;
  assert.equal(f.events.at(-1), "writeB");
});
for (const failure of ["reject", "timeout", "startup"])
  test(`${failure} cleanup stops batch, retains barrier, refuses next admission`, async (t) => {
    const f = await fixture(t);
    if (failure === "startup")
      f.deps.open = async () => {
        throw Object.assign(new Error("PRIVATE secret"), { code: "NTULEARN_BROWSER_CLEANUP" });
      };
    else {
      const open = f.deps.open;
      f.deps.open = async (...args) => {
        const c = await open(...args);
        c.close = async () => {
          if (failure === "reject") throw new Error("PRIVATE secret");
          await new Promise(() => {});
        };
        return c;
      };
    }
    const result = await runMediaDiscovery(
      { config: f.config, key: "all" },
      { ...f.deps, closeTimeoutMs: 10 },
    );
    assert.equal(result.failureCode, "MEDIA_BROWSER_CLEANUP");
    assert.equal(result.globalStop, true);
    assert.equal(result.safetyBarrier, "retained");
    assert.equal(result.notAttempted.length, 1);
    assert.equal(
      f.events.some((e) => e.startsWith("write") || e === "open1"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret/);
    assert.equal(
      JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
      "MEDIA_BROWSER_CLEANUP",
    );
    let opened = 0;
    const next = await runMediaDiscovery(
      { config: f.config, key: "all" },
      {
        ...f.deps,
        admission: undefined,
        open: async () => {
          opened++;
          throw new Error();
        },
      },
    );
    assert.equal(next.failureCode, "MEDIA_SAFETY_BARRIER");
    assert.equal(opened, 0);
  });
test("barrier storage failure preserves cleanup priority and containment action", async (t) => {
  const f = await fixture(t);
  const occupied = join(f.root, "occupied");
  await writeFile(occupied, "retained");
  f.config.statePath = join(occupied, "state.json");
  const result = await runMediaDiscovery(
    { config: f.config, key: "all" },
    {
      ...f.deps,
      lock: async ({ run }) => run(),
      open: async () => {
        throw Object.assign(new Error("PRIVATE"), { code: "NTULEARN_BROWSER_CLEANUP" });
      },
    },
  );
  assert.equal(result.failureCode, "MEDIA_SAFETY_BARRIER_WRITE");
  assert.equal(result.cleanup, "unconfirmed");
  assert.equal(result.cleanupCode, "MEDIA_BROWSER_CLEANUP");
  assert.match(result.action, /containment/);
  assert.equal(await readFile(occupied, "utf8"), "retained");
});

test("abort during startup waits returned client closure and never reads/writes/opens another", async (t) => {
  const f = await fixture(t);
  const controller = new globalThis.AbortController();
  let release, started;
  const ready = new Promise((resolve) => {
      started = resolve;
    }),
    pending = new Promise((resolve) => {
      release = resolve;
    });
  const open = f.deps.open;
  f.deps.open = async (...args) => {
    started();
    await pending;
    return open(...args);
  };
  const running = runMediaDiscovery(
    { config: f.config, key: "all", signal: controller.signal },
    f.deps,
  );
  await ready;
  controller.abort();
  assert.deepEqual(f.events, []);
  release();
  const result = await running;
  assert.equal(result.failureCode, "MEDIA_INTERRUPTED");
  assert.equal(result.cleanup, "confirmed");
  assert.deepEqual(f.events, ["open0", "close0"]);
  assert.equal(result.notAttempted.length, 1);
});
test("abort during course read settles close before queue-lock release and digest", async (t) => {
  const f = await fixture(t);
  const controller = new globalThis.AbortController();
  let finishRead, readStarted, finishClose, closeStarted;
  const reading = new Promise((resolve) => {
      readStarted = resolve;
    }),
    readPending = new Promise((resolve) => {
      finishRead = resolve;
    });
  const closing = new Promise((resolve) => {
      closeStarted = resolve;
    }),
    closePending = new Promise((resolve) => {
      finishClose = resolve;
    });
  f.deps.discover = async () => {
    readStarted();
    await readPending;
    return { complete: true, queue: [] };
  };
  const open = f.deps.open;
  f.deps.open = async (...args) => {
    const c = await open(...args);
    const close = c.close;
    c.close = async () => {
      closeStarted();
      await closePending;
      await close();
    };
    return c;
  };
  const running = runMediaDiscovery(
    { config: f.config, key: "all", signal: controller.signal },
    f.deps,
  );
  await reading;
  controller.abort();
  finishRead();
  await closing;
  assert.ok(await readFile(join(mediaQueueLockPath(f.config.statePath), "owner.json")));
  assert.equal(
    f.events.some((e) => e.startsWith("write")),
    false,
  );
  finishClose();
  const result = await running;
  assert.equal(result.failureCode, "MEDIA_INTERRUPTED");
  assert.equal(result.exitCode, 1);
  await assert.rejects(readFile(join(mediaQueueLockPath(f.config.statePath), "owner.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(f.events, ["open0", "close0"]);
});
test("cleanup barrier is durable BEFORE queue lock release", async (t) => {
  const f = await fixture(t);
  let held = true,
    observed = false;
  const result = await runMediaDiscovery(
    { config: f.config, key: "all" },
    {
      ...f.deps,
      lock: async ({ run }) => {
        try {
          return await run();
        } finally {
          assert.equal(observed, true);
          held = false;
        }
      },
      open: async () => {
        throw Object.assign(new Error("PRIVATE"), { code: "NTULEARN_BROWSER_CLEANUP" });
      },
      persistBarrier: async ({ statePath, error }) => {
        assert.equal(held, true);
        await (
          await import("../src/media/safety.mjs")
        ).persistMediaSafetyBarrier({ statePath, error });
        observed = true;
      },
    },
  );
  assert.equal(result.safetyBarrier, "retained");
  assert.equal(held, false);
});
test("course refusal and disabled course are accounted; disabled course opens no browser", async (t) => {
  const f = await fixture(t);
  const { CourseRefused } = await import("../src/ntulearn/read.mjs");
  f.config.courses.push({ key: "OFF", courseId: "OFF", mediaMode: "off" });
  const discover = f.deps.discover;
  f.deps.discover = async (args) => {
    if (args.course.key === "A") throw new CourseRefused("PRIVATE access refusal");
    if (args.course.key === "OFF") {
      assert.equal(args.client, null);
      return { complete: true, skipped: true, queue: [] };
    }
    return discover(args);
  };
  const result = await runMediaDiscovery({ config: f.config, key: "all" }, f.deps);
  assert.equal(result.refused.length, 1);
  assert.equal(result.courses.length, 2);
  assert.equal(result.notAttempted.length, 0);
  assert.equal(f.events.filter((e) => e.startsWith("open")).length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test("saved-session failure stops remaining courses with actionable login diagnostic and no raw exception", async (t) => {
  const f = await fixture(t);
  const result = await runMediaDiscovery(
    { config: f.config, key: "all" },
    {
      ...f.deps,
      open: async () => {
        throw new Error("PRIVATE signed URL token=secret");
      },
    },
  );
  assert.equal(result.failureCode, "MEDIA_DISCOVERY_FAILED");
  assert.match(result.action, /npm run login/);
  assert.equal(result.notAttempted.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret/);
});
test("canonical startup uses caller signal ownership behind an installed actual-browser stub", async (t) => {
  const f = await fixture(t);
  let options;
  const prior = chromium.launchPersistentContext;
  chromium.launchPersistentContext = (_path, value) => {
    options = value;
    throw new Error("Offline browser guard");
  };
  try {
    const result = await runMediaDiscovery(
      { config: f.config, key: "all" },
      { ...f.deps, open: undefined },
    );
    assert.equal(result.status, "failed");
    assert.equal(options.handleSIGINT, false);
    assert.equal(options.handleSIGTERM, false);
  } finally {
    chromium.launchPersistentContext = prior;
  }
});

test("incomplete isolated discovery retains checkpoint/job/source bytes and pilot mode through actual queue writer", async (t) => {
  const f = await fixture(t);
  const { writeMediaQueue, mediaQueuePath } = await import("../src/media/queue.mjs");
  const course = f.config.courses[0];
  course.mediaMode = "pilot";
  await mkdir(course.destination);
  const raw = join(course.destination, "transcript.raw.json"),
    edited = join(course.destination, "Student.transcript.md");
  await writeFile(raw, "original raw source");
  await writeFile(edited, "student edits");
  const appearance = {
    recordingId: "content-tree:A:fixture",
    provider: "direct",
    sourceKind: "content-tree",
    title: "Lecture",
    placement: { destination: course.destination, statusPath: "Lecture.media-status.md" },
    stage: "failed",
    attempts: 3,
    retryable: false,
    checkpoint: { kind: "retained" },
  };
  await writeMediaQueue({
    statePath: f.config.statePath,
    course,
    discovery: { complete: true, queue: [appearance] },
  });
  const path = mediaQueuePath(f.config.statePath, course.key),
    before = JSON.parse(await readFile(path));
  const result = await runMediaDiscovery(
    { config: f.config, key: "A" },
    { ...f.deps, writeQueue: undefined },
  );
  assert.equal(result.exitCode, 1);
  const after = JSON.parse(await readFile(path));
  assert.equal(after.complete, false);
  assert.deepEqual(after.queue, before.queue);
  assert.equal(course.mediaMode, "pilot");
  assert.equal(await readFile(raw, "utf8"), "original raw source");
  assert.equal(await readFile(edited, "utf8"), "student edits");
});

test("abort closes actual workflow's pending API read and waits its rejection before release", async (t) => {
  const f = await fixture(t),
    controller = new globalThis.AbortController();
  let entered, rejectRead;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.deps.discover = undefined;
  const context = { route: async () => {}, serviceWorkers: () => [] };
  f.deps.open = async () => ({
    withBrowserPage: async (read) => read({ context: () => context }),
    readCourse: async () => {
      entered();
      return new Promise((_resolve, reject) => {
        rejectRead = reject;
      });
    },
    close: async () => {
      f.events.push("close");
      rejectRead(new Error("Owned context closed"));
    },
  });
  const running = runMediaDiscovery(
    { config: f.config, key: "all", signal: controller.signal },
    f.deps,
  );
  await started;
  controller.abort();
  const result = await running;
  assert.equal(result.failureCode, "MEDIA_INTERRUPTED");
  assert.equal(result.cleanup, "confirmed");
  assert.deepEqual(f.events, ["close"]);
  assert.equal(result.notAttempted.length, 1);
});
test("a read unconfirmed after positive close retains barrier; late result never publishes or opens next context", async (t) => {
  const f = await fixture(t),
    controller = new globalThis.AbortController();
  let entered, late;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    pending = new Promise((resolve) => {
      late = resolve;
    });
  f.deps.discover = async () => {
    entered();
    return pending;
  };
  const running = runMediaDiscovery(
    { config: f.config, key: "all", signal: controller.signal },
    { ...f.deps, closeTimeoutMs: 10 },
  );
  await started;
  controller.abort();
  const result = await running;
  assert.equal(result.failureCode, "MEDIA_BROWSER_CLEANUP");
  assert.equal(result.safetyBarrier, "retained");
  assert.equal(result.cleanup, "unconfirmed");
  late({ complete: true, queue: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events, ["open0", "close0"]);
  assert.equal(result.notAttempted.length, 1);
  assert.equal(
    JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
    "MEDIA_BROWSER_CLEANUP",
  );
});

test("canonical startup cleanup timeout retains barrier despite abort and late close", async (t) => {
  const f = await fixture(t),
    controller = new globalThis.AbortController();
  let entered,
    release,
    closes = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const prior = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async () => ({
    pages: () => [
      {
        on() {},
        goto: async () => {
          throw new Error("synthetic sign-in failure");
        },
      },
    ],
    close: async () => {
      closes++;
      entered();
      await pending;
    },
  });
  try {
    const running = runMediaDiscovery(
      { config: f.config, key: "all", signal: controller.signal },
      { ...f.deps, open: undefined, closeTimeoutMs: 20 },
    );
    await started;
    controller.abort();
    const outcome = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    release();
    const final = await running;
    assert.notEqual(outcome, null, "allocated startup context cleanup must be bounded");
    assert.equal(final.failureCode, "MEDIA_BROWSER_CLEANUP");
    assert.equal(final.cleanup, "unconfirmed");
    assert.equal(final.safetyBarrier, "retained");
    assert.equal(closes, 1);
    assert.deepEqual(f.events, []);
    const barrier = await readFile(mediaSafetyPath(f.config.statePath), "utf8");
    const refused = await runMediaDiscovery(
      { config: f.config, key: "all" },
      { ...f.deps, admission: undefined },
    );
    assert.equal(refused.failureCode, "MEDIA_SAFETY_BARRIER");
    assert.equal(await readFile(mediaSafetyPath(f.config.statePath), "utf8"), barrier);
    assert.deepEqual(f.events, []);
  } finally {
    release();
    chromium.launchPersistentContext = prior;
  }
});

for (const boundary of ["startup", "read"]) {
  test(`concurrent abort cannot mask typed ${boundary} cleanup failure`, async (t) => {
    const f = await fixture(t),
      controller = new globalThis.AbortController();
    const failure = Object.assign(new Error("private cleanup cause"), {
      code: "NTULEARN_BROWSER_CLEANUP",
    });
    if (boundary === "startup")
      f.deps.open = async () => {
        controller.abort();
        throw failure;
      };
    else
      f.deps.discover = async () => {
        controller.abort();
        throw failure;
      };
    const report = await runMediaDiscovery(
      { config: f.config, key: "all", signal: controller.signal },
      f.deps,
    );
    assert.equal(report.failureCode, "MEDIA_BROWSER_CLEANUP");
    assert.equal(report.cleanup, "unconfirmed");
    assert.equal(report.globalStop, true);
    assert.equal(report.safetyBarrier, "retained");
    assert.equal(report.notAttempted.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /private cleanup cause/);
    assert.equal(
      f.events.some((e) => e.startsWith("write") || e === "open1"),
      false,
    );
  });
}

test("ordinary canonical startup cleanup retains default pending-close semantics", async (t) => {
  const f = await fixture(t);
  const { openSignedInContext } = await import("../src/ntulearn/session.mjs");
  let entered,
    release,
    settled = false;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    pending = new Promise((resolve) => {
      release = resolve;
    });
  const prior = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async (_path, options) => {
    assert.equal(options.handleSIGINT, undefined);
    return {
      pages: () => [
        {
          on() {},
          goto: async () => {
            throw new Error("synthetic login");
          },
        },
      ],
      close: async () => {
        entered();
        await pending;
      },
    };
  };
  try {
    const running = openSignedInContext(f.config.profilePath).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await started;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(settled, false);
    release();
    assert.equal((await running).message, "synthetic login");
  } finally {
    release();
    chromium.launchPersistentContext = prior;
  }
});

for (const closeBoundary of ["context", "page"])
  test(`observed supplied-route discovery cannot publish or open another course after owned ${closeBoundary} close failure`, async (t) => {
    const f = await fixture(t);
    f.deps.discover = undefined;
    let opened = 0,
      writes = 0;
    f.deps.open = async () => {
      opened++;
      const pageFixture = courseAnnouncementFixture();
      const url =
        "https://ntulearn.ntu.edu.sg/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=placement&content_id=gallery&course_id=A&wrapped=true";
      pageFixture.page.goto = async (supplied) => {
        assert.equal(supplied, url);
        await pageFixture.send("GET", supplied);
      };
      pageFixture.page.close = async () => {
        if (closeBoundary === "page") {
          await pageFixture.send("POST");
          throw new Error("Synthetic page closure uncertainty");
        }
      };
      return {
        withBrowserPage: async (read) => {
          try {
            return await read(pageFixture.page);
          } finally {
            await pageFixture.page.close();
          }
        },
        readCourse: async () => ({
          course: { id: "A" },
          items: [
            {
              id: "gallery",
              title: "Media Gallery",
              contentDetail: {
                lti: { launchLink: url, placement: { id: "placement", launchLink: url } },
              },
            },
          ],
        }),
        close: async () => {
          if (closeBoundary === "context") throw new Error("Synthetic uncertain closure");
        },
      };
    };
    f.deps.writeQueue = async () => {
      writes++;
    };
    const result = await runMediaDiscovery({ config: f.config, key: "all" }, f.deps);
    assert.equal(result.failureCode, "MEDIA_BROWSER_CLEANUP");
    assert.equal(result.cleanup, "unconfirmed");
    assert.equal(result.globalStop, true);
    assert.equal(result.safetyBarrier, "retained");
    assert.equal(opened, 1);
    assert.equal(writes, 0);
    assert.equal(result.notAttempted.length, 1);
    assert.equal(
      JSON.parse(await readFile(mediaSafetyPath(f.config.statePath))).code,
      "MEDIA_BROWSER_CLEANUP",
    );
  });
