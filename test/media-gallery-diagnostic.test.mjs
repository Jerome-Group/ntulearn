import assert from "node:assert/strict";
import test from "node:test";
import { galleryFailure, GALLERY_WAIT_LIMITS } from "../src/media/gallery-diagnostic.mjs";

test("Gallery diagnostics select fixed codes and actions without retaining free-text evidence", () => {
  const failure = galleryFailure("GALLERY_PAGINATION_UPDATE_UNCONFIRMED", {
    pagesRead: 2,
    snapshot: {
      displayedCount: 5,
      entries: [
        {
          href: "https://provider.test/ks/synthetic-private",
          title: "Synthetic private title",
          id: "synthetic-private",
        },
      ],
      hasMore: true,
    },
    control: "numbered",
    rawError: "synthetic-private",
    stage: "synthetic-private",
  });
  assert.equal(failure.code, "GALLERY_PAGINATION_UPDATE_UNCONFIRMED");
  assert.equal(failure.diagnostic.stage, "pagination");
  assert.equal(failure.diagnostic.pagesRead, 2);
  assert.equal(failure.diagnostic.observedCount, 1);
  assert.equal(failure.diagnostic.displayedCount, 5);
  assert.equal(failure.diagnostic.hasMore, true);
  assert.equal(failure.diagnostic.control, "numbered");
  assert.equal(failure.diagnostic.source, "student-visible-browser");
  assert.equal(failure.diagnostic.updateTimeoutMs, GALLERY_WAIT_LIMITS.updateTimeoutMs);
  assert.match(failure.message, /retry media discovery/);
  assert.doesNotMatch(JSON.stringify(failure), /synthetic-private|https?:|title|rawError/);
  const unknown = galleryFailure("synthetic-private", {
    stage: "date-enrichment",
    control: "synthetic-private",
    pagesRead: -1,
    displayedCount: 100001,
    observedCount: "42",
    hasMore: "yes",
  });
  assert.equal(unknown.code, "GALLERY_DISCOVERY_FAILED");
  assert.equal(unknown.diagnostic.stage, "date-enrichment");
  for (const field of ["control", "pagesRead", "displayedCount", "observedCount", "hasMore"])
    assert.equal(unknown.diagnostic[field], null);
  assert.doesNotMatch(JSON.stringify(unknown), /synthetic-private/);
});
