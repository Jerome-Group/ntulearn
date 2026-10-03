import assert from "node:assert/strict";
import test from "node:test";
import { discoverContentRecordings } from "../src/media/discovery.mjs";

const KALTURA = "https://media.example.test/p/123/sp/12300/embedIframeJs/uiconf_id/7/entry_id/";

test("classifies each Kaltura content-tree appearance without persisting its expiring URL", () => {
  const course = {
    key: "MH2100",
    courseId: "_9_1",
    destination: "/courses/MH2100/NTULearn",
  };
  const snapshot = {
    items: [
      {
        id: "root",
        parentId: null,
        position: 0,
        title: "Lectures",
        contentHandler: "resource/x-bb-folder",
      },
      {
        id: "attachment-item",
        parentId: "root",
        position: 0,
        title: "Week 1",
        contentHandler: "resource/x-bb-file",
      },
      {
        id: "embedded-item",
        parentId: "root",
        position: 2,
        title: "Week 2",
        contentHandler: "resource/x-bb-document",
        body: {
          displayText: `<iframe src="${KALTURA}embedded?ks=secret-embedded"></iframe>`,
        },
      },
      {
        id: "external-item",
        parentId: "root",
        position: 4,
        title: "Week 3",
        contentHandler: "resource/x-bb-externallink",
        contentDetail: {
          "resource/x-bb-externallink": { url: `${KALTURA}external?ks=secret-external` },
        },
      },
      {
        id: "launch-item",
        parentId: "root",
        position: 6,
        title: "Week 4",
        contentHandler: "resource/x-bb-lti-launch",
        contentDetail: {
          "resource/x-bb-lti-launch": {
            placement: { launchLink: `${KALTURA}launch?ks=secret-launch` },
          },
        },
      },
      {
        id: "repeat-item",
        parentId: "root",
        position: 8,
        title: "Week 5",
        contentHandler: "resource/x-bb-document",
        body: { displayText: `<a href="${KALTURA}embedded?ks=secret-repeat">same entry</a>` },
      },
    ],
  };

  const recordings = discoverContentRecordings({
    course,
    snapshot,
    attachmentsByItem: new Map([
      [
        "attachment-item",
        [
          {
            fileName: "Week 1.mp4",
            mimeType: "video/mp4",
            resourceUrl: `${KALTURA}attachment?ks=secret-attachment`,
          },
        ],
      ],
    ]),
  });

  assert.deepEqual(
    recordings.map(({ sourceKind }) => sourceKind),
    ["attachment", "embedded-player", "external-link", "launch-link", "external-link"],
  );
  assert.deepEqual(
    recordings.map(({ providerReference }) => providerReference),
    ["entry:attachment", "entry:embedded", "entry:external", "entry:launch", "entry:embedded"],
  );
  assert.equal(new Set(recordings.map(({ recordingId }) => recordingId)).size, recordings.length);
  assert.equal(recordings[0].placement.trail, "Lectures");
  assert.equal(recordings[0].placement.videoAlreadyPresent, true);
  assert.equal(recordings[0].placement.videoPath, "01 Lectures/01 Week 1.mp4");
  assert.equal(
    recordings[0].placement.formattedTranscriptPath,
    "01 Lectures/01 Week 1.transcript.md",
  );
  assert.equal(recordings[1].placement.videoPath, "01 Lectures/03 Week 2.mp4");

  const serialized = JSON.stringify(recordings);
  assert.doesNotMatch(serialized, /secret-/);
  assert.doesNotMatch(serialized, /https?:\/\//);
});

test("deduplicates repeated Kaltura surfaces inside one content item but not placements", () => {
  const item = {
    id: "item-1",
    parentId: null,
    position: 0,
    title: "Lecture",
    contentHandler: "resource/x-bb-document",
    body: {
      rawText: [
        `<a href="${KALTURA}shared?ks=one">one</a>`,
        `<iframe src="${KALTURA}shared?ks=two"></iframe>`,
      ].join("\n"),
    },
  };
  const course = { key: "MH2100", courseId: "_9_1", destination: "/courses/MH2100" };

  const recordings = discoverContentRecordings({
    course,
    snapshot: { items: [item] },
    attachmentsByItem: new Map(),
  });

  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].providerReference, "entry:shared");
});

test("classifies YouTube and direct recordings while ignoring ordinary course links", () => {
  const course = { key: "MH2100", courseId: "_9_1", destination: "/courses/MH2100" };
  const snapshot = {
    items: [
      {
        id: "youtube",
        parentId: null,
        position: 0,
        title: "YouTube lecture",
        contentHandler: "resource/x-bb-document",
        body: {
          displayText: '<iframe src="https://www.youtube.com/watch?v=lecture123"></iframe>',
        },
      },
      {
        id: "direct",
        parentId: null,
        position: 1,
        title: "Direct lecture",
        contentHandler: "resource/x-bb-document",
        body: {
          displayText:
            '<video src="https://cdn.example.test/lecture.mp4?signature=secret"></video>',
        },
      },
      {
        id: "ordinary",
        parentId: null,
        position: 2,
        title: "Reading",
        contentHandler: "resource/x-bb-externallink",
        contentDetail: { link: { url: "https://example.test/reading" } },
      },
      {
        id: "opaque",
        parentId: null,
        position: 3,
        title: "Opaque player",
        contentHandler: "resource/x-bb-lti-launch",
        contentDetail: {
          lti: { placement: { launchLink: "https://player.example.test/lecture" } },
        },
      },
      {
        id: "direct-link",
        parentId: null,
        position: 4,
        title: "Direct linked lecture",
        contentHandler: "resource/x-bb-document",
        body: {
          displayText: '<a href="https://cdn.example.test/linked-lecture.webm">watch</a>',
        },
      },
    ],
  };

  const recordings = discoverContentRecordings({
    course,
    snapshot,
    attachmentsByItem: new Map([
      [
        "youtube",
        [
          {
            fileName: "captions.vtt",
            mimeType: "text/vtt",
            resourceUrl: "/bbcswebdav/captions.vtt",
          },
        ],
      ],
      [
        "direct",
        [
          {
            fileName: "lecture-audio.m4a",
            mimeType: "audio/mp4",
            resourceUrl: "/bbcswebdav/lecture-audio.m4a",
          },
        ],
      ],
    ]),
  });

  assert.deepEqual(
    recordings.map(({ provider, sourceKind }) => [provider, sourceKind]),
    [
      ["unsupported", "attachment"],
      ["youtube", "embedded-player"],
      ["direct", "attachment"],
      ["direct", "embedded-player"],
      ["unsupported", "launch-link"],
      ["direct", "external-link"],
    ],
  );
  assert.equal(recordings[1].providerReference, "youtube:lecture123");
  assert.match(recordings[2].providerReference, /^direct:/);
  assert.match(recordings[3].providerReference, /^direct:/);
  assert.equal(recordings[2].mediaType, "audio");
  assert.match(recordings[4].limitation, /unsupported/i);
  assert.equal(
    recordings.some(({ title }) => title === "Reading"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(recordings), /signature=secret/);
});

test("keeps repeated YouTube appearances as separate recordings", () => {
  const course = { key: "MH2100", courseId: "_9_1", destination: "/courses/MH2100" };
  const youtube = "https://youtu.be/repeated123?si=secret";
  const recordings = discoverContentRecordings({
    course,
    snapshot: {
      items: [
        {
          id: "first",
          position: 0,
          title: "First appearance",
          contentHandler: "resource/x-bb-document",
          body: { displayText: `<a href="${youtube}">watch</a>` },
        },
        {
          id: "second",
          position: 1,
          title: "Second appearance",
          contentHandler: "resource/x-bb-document",
          body: { displayText: `<a href="${youtube}">watch again</a>` },
        },
      ],
    },
  });

  assert.equal(recordings.length, 2);
  assert.deepEqual(
    recordings.map(({ recordingId, providerReference }) => [recordingId, providerReference]),
    [
      ["content-tree:_9_1:first:youtube:repeated123", "youtube:repeated123"],
      ["content-tree:_9_1:second:youtube:repeated123", "youtube:repeated123"],
    ],
  );
});

test("keeps known external-tool shapes visible as retryable appearances", () => {
  const course = { key: "ML0004-TUT", courseId: "_2711874_1", destination: "/courses/ML0004-TUT" };
  const recordings = discoverContentRecordings({
    course,
    snapshot: {
      items: [
        {
          id: "external-tools",
          position: 0,
          title: "External tools",
          contentHandler: "resource/x-bb-document",
          contentDetail: {
            feedback: {
              launchLink: "https://app.feedbackfruits.com/activity/feedback-1?token=secret",
            },
            turnitin: {
              launchLink: "https://www.turnitin.com/assignment/turnitin-1?state=secret",
            },
            ordinary: { url: "https://www.turnitin.com/help/article-42" },
          },
        },
      ],
    },
  });

  assert.deepEqual(
    recordings.map(({ provider, providerName, providerShape, retryable, sourceKind }) => [
      provider,
      providerName,
      providerShape,
      retryable,
      sourceKind,
    ]),
    [
      ["unsupported", "FeedbackFruits", "feedbackfruits", true, "launch-link"],
      ["unsupported", "Turnitin", "turnitin", true, "launch-link"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(recordings), /https?:\/\/|secret/);
});

test("keeps positively identified document attachments visible as excluded non-recordings", () => {
  const recordings = discoverContentRecordings({
    course: { key: "CC0015", courseId: "_9_1", destination: "/courses/CC0015" },
    snapshot: {
      items: [
        {
          id: "reading",
          position: 0,
          title: "Reading",
          contentHandler: "resource/x-bb-document",
        },
      ],
    },
    attachmentsByItem: new Map([
      [
        "reading",
        [
          {
            fileName: "week-1.pdf",
            mimeType: "application/pdf",
            resourceUrl: "/bbcswebdav/week-1.pdf?signature=secret",
          },
        ],
      ],
    ]),
  });

  assert.deepEqual(
    recordings.map(({ provider, providerName, providerShape, retryable, sourceKind }) => [
      provider,
      providerName,
      providerShape,
      retryable,
      sourceKind,
    ]),
    [["unsupported", "NTULearn file", "ntulearn-file", false, "attachment"]],
  );
  assert.doesNotMatch(JSON.stringify(recordings), /https?:\/\/|signature=secret/);
});

test("prefers a launch shape when detail fields repeat one provider address", () => {
  const recordings = discoverContentRecordings({
    course: { key: "CC0015", courseId: "_9_1", destination: "/courses/CC0015" },
    snapshot: {
      items: [
        {
          id: "repeated-link",
          position: 0,
          title: "Peer feedback",
          contentHandler: "resource/x-bb-document",
          contentDetail: {
            ordinary: {
              url: "https://app.feedbackfruits.com/activity/feedback-1?token=secret",
            },
            launch: {
              launchLink: "https://app.feedbackfruits.com/activity/feedback-1?token=secret",
            },
          },
        },
      ],
    },
  });

  assert.deepEqual(
    recordings.map(({ providerName, sourceKind }) => [providerName, sourceKind]),
    [["FeedbackFruits", "launch-link"]],
  );
});

test("distinct players in one item have stable unique artifact paths", () => {
  const course = { key: "TEST", courseId: "_1_1", destination: "/fixture/course" };
  const urls = [
    "https://www.youtube.com/embed/abcdefghijk",
    "https://www.youtube.com/embed/lmnopqrstuv",
  ];
  const discover = (links) =>
    discoverContentRecordings({
      course,
      snapshot: {
        items: [
          {
            id: "_2_1",
            title: "Lectures",
            position: 0,
            body: { rawText: links.map((url) => `<iframe src="${url}"></iframe>`).join("") },
          },
        ],
      },
    });
  const first = discover(urls);
  assert.equal(new Set(first.map((item) => item.placement.formattedTranscriptPath)).size, 2);
  assert.equal(new Set(first.map((item) => item.placement.videoPath)).size, 2);
  assert.deepEqual(
    first.map((item) => item.placement).sort((a, b) => a.videoPath.localeCompare(b.videoPath)),
    discover([...urls].reverse())
      .map((item) => item.placement)
      .sort((a, b) => a.videoPath.localeCompare(b.videoPath)),
  );
});

test("mixed attachments retain independent document and nested media appearances", () => {
  const course = { key: "fixture", courseId: "_fixture_1", destination: "/fixture/course" };
  const snapshot = { items: [{ id: "item", title: "Resources", position: 0 }] };
  const discover = () =>
    discoverContentRecordings({
      course,
      snapshot,
      attachmentsByItem: new Map([
        [
          "item",
          [
            {
              resourceUrl: "/bbcswebdav/notes.pdf",
              mimeType: "application/pdf",
              fileName: "notes.pdf",
            },
            {
              file: {
                resourceUrl: "/bbcswebdav/lecture.mp4",
                mimeType: "video/mp4",
                fileName: "lecture.mp4",
              },
            },
          ],
        ],
      ]),
    });
  const first = discover();
  assert.deepEqual(
    first.map((job) => job.disposition),
    ["non-recording", "recording"],
  );
  assert.equal(new Set(first.map((job) => job.recordingId)).size, 2);
  assert.equal(new Set(first.map((job) => job.placement.formattedTranscriptPath)).size, 2);
  assert.deepEqual(discover(), first);
});

test("session path rotation stays private and preserves queue ownership", async (t) => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeMediaQueue, updateMediaQueueJob } = await import("../src/media/queue.mjs");
  const root = await mkdtemp(join(tmpdir(), "ntulearn-session-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, address, independent] of [
    ["entry", (token) => `https://media.kaltura.test/entry_id/stable/ks/${token}/player`, true],
    ["encoded", (token) => `https://media.kaltura.test/entry_id/stable/%6bs/${token}/player`, true],
    [
      "encoded-value",
      (token) =>
        `https://media.kaltura.test/entry_id/stable/ks/${token}%2Fsynthetic-private-tail-${token}/player`,
      true,
    ],
    ["path", (token) => `https://media.kaltura.test/api/ks/${token}/player`, false],
    ["direct", (token) => `https://video.test/api/ks/${token}/lecture.mp4`, false],
    ["unknown", (token) => `https://tool.test/api/ks/${token}/launch`, false],
  ]) {
    const destination = join(root, name);
    await mkdir(destination);
    const course = { key: name, courseId: "synthetic-course", destination };
    const statePath = join(destination, "state.json");
    const discover = (token) =>
      discoverContentRecordings({
        course,
        snapshot: {
          items: [
            {
              id: "item",
              position: 0,
              title: "Lecture",
              body: { displayText: `<iframe src="${address(token)}"></iframe>` },
            },
          ],
        },
      });
    const first = discover("synthetic-private-A");
    const second = discover("synthetic-private-B");
    assert.equal(first.length, 1);
    assert.equal(JSON.stringify(first).includes("synthetic-private"), false, name);
    assert.equal(first[0].recordingId, second[0].recordingId, name);
    assert.equal(first[0].candidateReference, second[0].candidateReference, name);
    assert.equal(first[0].disposition, independent ? "recording" : "unresolved");
    const publish = (queue) =>
      writeMediaQueue({
        statePath,
        course,
        discovery: { complete: true, verdict: "green", queue },
      });
    const saved = await publish(first);
    const sourcePath = join(destination, "owned-source.json");
    await writeFile(sourcePath, "Synthetic preserved source bytes");
    const editedPath = join(destination, first[0].placement.formattedTranscriptPath);
    await writeFile(editedPath, "Student-owned edited derivative");
    const artifacts = { rawTranscript: sourcePath, formattedTranscript: editedPath };
    const checkpoint = { at: "2026-10-03T00:00:00Z", reason: "Synthetic checkpoint" };
    await updateMediaQueueJob({
      statePath,
      courseKey: name,
      course,
      recordingId: first[0].recordingId,
      update: { stage: "failed", attempts: 3, artifacts, checkpoint },
    });
    await publish(second);
    const queueBytes = await readFile(saved.path, "utf8");
    const queue = JSON.parse(queueBytes).queue;
    assert.equal(queue.length, 1);
    assert.deepEqual(queue[0].artifacts, artifacts);
    assert.deepEqual(queue[0].checkpoint, checkpoint);
    assert.equal(queue[0].attempts, 3);
    assert.deepEqual(queue[0].placement, first[0].placement);
    assert.equal(await readFile(sourcePath, "utf8"), "Synthetic preserved source bytes");
    assert.equal(await readFile(editedPath, "utf8"), "Student-owned edited derivative");
    assert.equal(queueBytes.includes("synthetic-private"), false);
    assert.equal((await readFile(saved.statusPath, "utf8")).includes("synthetic-private"), false);
    assert.equal(
      (await readFile(join(destination, first[0].placement.statusPath), "utf8")).includes(
        "synthetic-private",
      ),
      false,
    );
  }
});

test("a hostname named ks remains a safe direct media authority", () => {
  const queue = discoverContentRecordings({
    course: { key: "synthetic", courseId: "course", destination: "/synthetic" },
    snapshot: {
      items: [
        {
          id: "item",
          title: "Lecture",
          position: 0,
          body: { displayText: '<iframe src="https://ks/lecture.mp4"></iframe>' },
        },
      ],
    },
  });
  assert.equal(queue[0].provider, "direct");
  assert.equal(queue[0].disposition, "recording");
  assert.equal(queue[0].providerReference, "direct:ks/lecture.mp4");
});

test("discovers folder bodies and typed detail media without losing document evidence", () => {
  const course = { key: "fixture", courseId: "fixture", destination: "/fixture/course" };
  const items = [
    {
      id: "folder",
      title: "Lectures",
      position: 0,
      contentHandler: "resource/x-bb-folder",
      body: { rawText: '<a href="https://youtu.be/abc123xyz89?token=fixture-secret">Watch</a>' },
    },
    {
      id: "video",
      title: "Lecture",
      position: 1,
      contentDetail: {
        link: {
          url: "https://example.test/opaque?signature=fixture-secret",
          mimeType: "video/mp4",
        },
      },
    },
    {
      id: "document",
      title: "Notes",
      position: 2,
      contentDetail: {
        link: { url: "https://example.test/notes", mimeType: "application/pdf" },
      },
    },
  ];
  const queue = discoverContentRecordings({ course, snapshot: { items } });
  assert.deepEqual(
    queue.map((job) => job.disposition),
    ["recording", "recording", "non-recording"],
  );
  assert.equal(queue[0].placement.formattedTranscriptPath, "01 Lectures/01 Lectures.transcript.md");
  assert.equal(queue[1].provider, "direct");
  assert.equal(queue[1].mediaType, "video");
  assert.doesNotMatch(JSON.stringify(queue), /fixture-secret|signature=|token=|https?:/);
  assert.deepEqual(discoverContentRecordings({ course, snapshot: { items } }), queue);
});

test("quoted and unquoted embedded media preserve MIME and stable identity", () => {
  const course = { key: "fixture", courseId: "fixture", destination: "/fixture/course" };
  const discover = (body) =>
    discoverContentRecordings({
      course,
      snapshot: { items: [{ id: "item", title: "Lecture", position: 0, body: { rawText: body } }] },
    });
  const quoted = discover(
    '<video src="https://example.test/opaque?signature=fixture-secret" type="video/mp4"></video>',
  );
  const unquoted = discover(
    "<video src=https://example.test/opaque?signature=another-secret type=video/mp4></video>",
  );
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].disposition, "recording");
  assert.equal(quoted[0].provider, "direct");
  assert.equal(quoted[0].classificationEvidence, "media");
  assert.deepEqual(unquoted, quoted);
  assert.equal(discover("<audio src=/lecture.mp3></audio>")[0].mediaType, "audio");
  assert.doesNotMatch(JSON.stringify(quoted), /fixture-secret|signature=|https?:/);
});

test("addressless and malformed embeds remain explicit unresolved appearances", () => {
  const course = { key: "fixture", courseId: "fixture", destination: "/fixture/course" };
  for (const body of [
    '<iframe data-bbfile="not-json fixture-secret"></iframe>',
    "<video></video>",
    '<iframe data-bbfile="null"></iframe>',
    '<a data-bbfile="not-json">Watch</a>',
    "<a data-bbfile=null>Watch</a>",
  ]) {
    const input = {
      course,
      snapshot: { items: [{ id: "item", title: "Lecture", position: 0, body: { rawText: body } }] },
    };
    const queue = discoverContentRecordings(input);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].disposition, "unresolved");
    assert.equal(queue[0].provider, "unsupported");
    assert.match(queue[0].limitation, /Inspect.*NTULearn/);
    assert.doesNotMatch(JSON.stringify(queue), /fixture-secret|not-json/);
    assert.deepEqual(discoverContentRecordings(input), queue);
    assert.deepEqual(
      discoverContentRecordings({
        ...input,
        snapshot: {
          items: [{ ...input.snapshot.items[0], body: { rawText: body, displayText: body } }],
        },
      }),
      queue,
    );
  }
});

test("native wrappers with child source addresses do not invent unresolved media", () => {
  const queue = discoverContentRecordings({
    course: { key: "fixture", courseId: "fixture", destination: "/fixture/course" },
    snapshot: {
      items: [
        {
          id: "item",
          title: "Lecture",
          position: 0,
          body: { rawText: "<video controls><source src=/lecture.mp4 type=video/mp4></video>" },
        },
      ],
    },
  });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].disposition, "recording");
});

test("typed conflicts and session-dependent media remain unresolved", () => {
  const course = { key: "fixture", courseId: "fixture", destination: "/fixture/course" };
  for (const body of [
    "<video src=/lecture.pdf type=video/mp4></video>",
    "<video src=/media/ks/fixture-secret/lecture type=video/mp4></video>",
    "<iframe src=/opaque type=unknown></iframe>",
  ]) {
    const queue = discoverContentRecordings({
      course,
      snapshot: { items: [{ id: "item", title: "Lecture", position: 0, body: { rawText: body } }] },
    });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].disposition, "unresolved");
    assert.doesNotMatch(JSON.stringify(queue), /fixture-secret/);
  }
});

test("unquoted watch query preserves provider identity across signed URL rotation", () => {
  const course = { key: "fixture", courseId: "fixture", destination: "/fixture/course" };
  for (const [tag, attribute] of [
    ["iframe", "src"],
    ["a", "href"],
  ]) {
    const discover = (body) =>
      discoverContentRecordings({
        course,
        snapshot: {
          items: [{ id: "item", title: "Lecture", position: 0, body: { rawText: body } }],
        },
      });
    const quoted = discover(
      `<${tag} ${attribute}="https://www.youtube.com/watch?v=abc123xyz89&amp;token=fixture-secret"></${tag}>`,
    );
    const unquoted = discover(
      `<${tag} ${attribute}=https://www.youtube.com/watch?v=abc123xyz89&amp;token=rotated-secret></${tag}>`,
    );
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0].provider, "youtube");
    assert.deepEqual(unquoted, quoted);
    assert.doesNotMatch(JSON.stringify(unquoted), /fixture-secret|rotated-secret|token=|https?:/);
  }
});

test("addressless and invalid typed content details stay unresolved without source payloads", () => {
  const course = { key: "fixture", courseId: "fixture", destination: "/fixture/course" };
  for (const descriptor of [
    { mimeType: "video/mp4" },
    { mimeType: "video/mp4", url: 17 },
    { contentType: "audio/mp4", url: "" },
    { type: "video/mp4", url: { private: "fixture-secret" } },
  ]) {
    const input = {
      course,
      snapshot: {
        items: [
          { id: "item", title: "Lecture", position: 0, contentDetail: { media: descriptor } },
        ],
      },
    };
    const queue = discoverContentRecordings(input);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].disposition, "unresolved");
    assert.equal(queue[0].provider, "unsupported");
    assert.match(queue[0].limitation, /Inspect.*NTULearn/);
    assert.deepEqual(discoverContentRecordings(input), queue);
    assert.doesNotMatch(JSON.stringify(queue), /fixture-secret|"url"|"private"/);
  }
});
