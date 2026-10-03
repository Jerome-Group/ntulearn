import assert from "node:assert/strict";
import test from "node:test";
import { preferredCatalogueEdition } from "../src/media/catalogue-editions.mjs";
const a = "a".repeat(64),
  b = "b".repeat(64);
const edition = (path, sha256 = a, kind = "paragraph") => ({
  path,
  sha256,
  kind,
  eligible: true,
  reading: "verified",
});
test("preference groups equal digests deterministically, never newest; distinct candidates require selection", () => {
  const equivalents = [edition("/z"), edition("/a")];
  assert.equal(preferredCatalogueEdition(equivalents).preferred.path, "/a");
  assert.deepEqual(preferredCatalogueEdition(equivalents).preferred.equivalents, ["/z"]);
  assert.equal(preferredCatalogueEdition([edition("/a"), edition("/b", b)]).preferred, null);
  assert.equal(
    preferredCatalogueEdition([edition("/a"), edition("/b", b)], b).preferred.path,
    "/b",
  );
});
test("recovered tier requires eligible evidence and an explicit selection never bypasses failure or tier", () => {
  const valid = edition("/paragraph"),
    recovered = edition("/recovered", b, "recovered");
  assert.equal(preferredCatalogueEdition([valid, recovered]).preferred.kind, "recovered");
  assert.equal(
    preferredCatalogueEdition([valid, { ...recovered, eligible: false }]).preferred.kind,
    "paragraph",
  );
  assert.throws(() => preferredCatalogueEdition([valid, recovered], a), {
    code: "CATALOGUE_SELECTION_INVALID",
  });
  assert.throws(() => preferredCatalogueEdition([{ ...valid, eligible: false }], a), {
    code: "CATALOGUE_SELECTION_INVALID",
  });
});

test("equal paragraph bytes with distinct native/source proof cannot be grouped or selected by ambiguous content digest", () => {
  const first = { ...edition("/a"), equivalence: "c".repeat(64) },
    second = { ...edition("/b"), equivalence: "d".repeat(64) };
  assert.equal(preferredCatalogueEdition([first, second]).preferred, null);
  assert.throws(() => preferredCatalogueEdition([first, second], a), {
    code: "CATALOGUE_SELECTION_INVALID",
  });
  assert.equal(preferredCatalogueEdition([first, second], first.equivalence).preferred.path, "/a");
});
