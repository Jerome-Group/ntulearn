import assert from "node:assert/strict";
import test from "node:test";
import { foundSomethingNew, renderReport } from "../prototype/report.mjs";

const BASE = "https://ntulearn.ntu.edu.sg";

function read(difference = {}) {
  return {
    key: "CC0006",
    course: "Sustainability",
    courseId: "_1_1",
    items: 12,
    unreadableItems: [],
    difference: {
      onPage: { objects: 3, navigation: 8 },
      inWalk: 3,
      onBothSides: 3,
      onlyOnThePage: { objects: [], navigation: [] },
      onlyInTheWalk: [],
      ...difference,
    },
  };
}

const MISSED = {
  url: `${BASE}/bbcswebdav/xid-1_1`,
  address: `${BASE}/bbcswebdav/xid-1_1`,
  kinds: ["iframe"],
  offsite: false,
  fileShaped: true,
  navigation: false,
  carriedBy: [
    {
      kind: "iframe",
      label: "Week 1 recording",
      element: '<iframe src="/bbcswebdav/xid-1_1"></iframe>',
      frame: null,
      itemId: "_2_1",
      itemTitle: "Week 1",
      itemUrl: `${BASE}/ultra/courses/_1_1/outline/file/_2_1`,
    },
  ],
};

test("a course that read cleanly and matched says so without a table of nothing", () => {
  const report = renderReport([read()]);

  assert.match(report, /CC0006/);
  assert.match(report, /Sustainability/);
  assert.doesNotMatch(report, /On the page, not in the walk/);
});

test("an object the walk does not have is named with the element that carried it", () => {
  const report = renderReport([read({ onlyOnThePage: { objects: [MISSED], navigation: [] } })]);

  assert.match(report, /On the page, not in the walk/);
  assert.match(report, /xid-1_1/);
  assert.match(report, /iframe/);
  assert.match(report, /Week 1/);
});

test("an address carried twice on one item is one line about one item", () => {
  const twice = {
    ...MISSED,
    carriedBy: [MISSED.carriedBy[0], { ...MISSED.carriedBy[0], element: "<div></div>" }],
  };
  const report = renderReport([read({ onlyOnThePage: { objects: [twice], navigation: [] } })]);

  assert.equal(report.match(/- on \*\*Week 1\*\*/g).length, 1);
  assert.doesNotMatch(report, /further item/);
});

test("the rest are counted as items rather than as elements", () => {
  const carriedBy = Array.from({ length: 10 }, (_, each) => ({
    ...MISSED.carriedBy[0],
    itemId: `_${each}_1`,
    itemTitle: `Week ${each}`,
  }));
  const many = {
    ...MISSED,
    carriedBy: [...carriedBy, { ...carriedBy[0], element: "<div></div>" }],
  };
  const report = renderReport([read({ onlyOnThePage: { objects: [many], navigation: [] } })]);

  assert.match(report, /and on 7 further items/);
});

test("a course that could not be read is a failure rather than a course with no content", () => {
  const report = renderReport([
    { key: "CC0001", courseId: "_9_1", failure: "The outline never rendered" },
  ]);

  assert.match(report, /could not be read/);
  assert.match(report, /The outline never rendered/);
  assert.doesNotMatch(report, /\b0 objects\b/);
});

test("an item that could not be read is named, so a clean difference is read against it", () => {
  const report = renderReport([
    { ...read(), unreadableItems: [{ url: "/ultra/x", reason: "HTTP 403" }] },
  ]);

  assert.match(report, /HTTP 403/);
});

test("a run is new when the page carried an object the walk has not", () => {
  assert.equal(foundSomethingNew([read()]), false);
  assert.equal(
    foundSomethingNew([read({ onlyOnThePage: { objects: [MISSED], navigation: [] } })]),
    true,
  );
});

test("navigation alone is not a finding", () => {
  const link = { ...MISSED, navigation: true, fileShaped: false, kinds: ["link"] };
  assert.equal(
    foundSomethingNew([read({ onlyOnThePage: { objects: [], navigation: [link] } })]),
    false,
  );
});

test("a course that could not be read fails the run", () => {
  const failed = { key: "CC0001", courseId: "_9_1", failure: "locked out" };
  assert.equal(foundSomethingNew([failed]), true);
});
