import assert from "node:assert/strict";
import test from "node:test";
import { differenceBetween } from "../prototype/difference.mjs";

const BASE = "https://ntulearn.ntu.edu.sg";

function object(url, kind = "image", extra = {}) {
  return { url, kind, label: "", element: `<${kind}>`, frame: null, ...extra };
}

function attachment(url, file = "Week 1.pdf") {
  return { url, file, trail: "Lectures", path: `01 Lectures/01 ${file}` };
}

test("an address on both sides is on neither difference", () => {
  const difference = differenceBetween({
    objects: [object(`${BASE}/bbcswebdav/xid-1_1`)],
    attachments: [attachment(`${BASE}/bbcswebdav/xid-1_1`)],
  });

  assert.equal(difference.onBothSides, 1);
  assert.deepEqual(difference.onlyOnThePage.objects, []);
  assert.deepEqual(difference.onlyInTheWalk, []);
});

test("a query string is not a difference about a file", () => {
  const difference = differenceBetween({
    objects: [object(`${BASE}/bbcswebdav/xid-1_1?download=true`)],
    attachments: [attachment(`${BASE}/bbcswebdav/xid-1_1`)],
  });

  assert.equal(difference.onBothSides, 1);
});

test("an embedded player the walk never sees is an object, not navigation", () => {
  const player = object("https://ntu.cloud.panopto.eu/Panopto/Pages/Embed.aspx?id=abc", "iframe");
  const difference = differenceBetween({ objects: [player], attachments: [] });

  assert.deepEqual(
    difference.onlyOnThePage.objects.map((each) => each.url),
    [player.url],
  );
  assert.deepEqual(difference.onlyOnThePage.navigation, []);
});

test("a link to another course page is navigation rather than a missing object", () => {
  const difference = differenceBetween({
    objects: [object(`${BASE}/ultra/courses/_1_1/outline`, "link")],
    attachments: [],
  });

  assert.deepEqual(difference.onlyOnThePage.objects, []);
  assert.equal(difference.onlyOnThePage.navigation.length, 1);
});

test("a link into a file address is an object however it was written", () => {
  const difference = differenceBetween({
    objects: [object(`${BASE}/bbcswebdav/pid-1/Week 1.pdf`, "link")],
    attachments: [],
  });

  assert.equal(difference.onlyOnThePage.objects.length, 1);
});

test("an attachment the page does not carry is reported the other way", () => {
  const difference = differenceBetween({
    objects: [],
    attachments: [attachment(`${BASE}/bbcswebdav/xid-9_1`, "Notes.pdf")],
  });

  assert.deepEqual(
    difference.onlyInTheWalk.map((each) => each.file),
    ["Notes.pdf"],
  );
});

test("one address carried by two elements is one object", () => {
  const url = `${BASE}/bbcswebdav/xid-1_1`;
  const difference = differenceBetween({
    objects: [object(url, "image"), object(url, "link")],
    attachments: [],
  });

  assert.equal(difference.onlyOnThePage.objects.length, 1);
  assert.deepEqual(difference.onlyOnThePage.objects[0].kinds, ["image", "link"]);
});

test("an address that is not a URL is classified rather than thrown over", () => {
  const difference = differenceBetween({
    objects: [object("javascript:void(0)", "link"), object("blob:nowhere", "iframe")],
    attachments: [],
  });

  assert.equal(difference.onlyOnThePage.navigation.length, 1);
  assert.equal(difference.onlyOnThePage.objects.length, 1);
});
