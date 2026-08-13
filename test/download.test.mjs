import assert from "node:assert/strict";
import test from "node:test";
import { downloadedType, downloadRefusal } from "../src/ntulearn/download.mjs";

const PDF = { fileName: "05 Week 1.pdf", mimeType: "application/pdf" };
const RESOURCE_URL = "https://ntulearn.ntu.edu.sg/bbcswebdav/xid-1234_1";

test("the file itself is not refused", () => {
  assert.equal(
    downloadRefusal({
      attachment: PDF,
      url: RESOURCE_URL,
      contentType: "application/pdf",
    }),
    null,
  );
});

test("a web page where a file was expected is refused, and names the file", () => {
  const refusal = downloadRefusal({
    attachment: PDF,
    url: RESOURCE_URL,
    contentType: "text/html; charset=UTF-8",
  });
  assert.match(refusal, /05 Week 1\.pdf/);
  assert.match(refusal, /text\/html/);
});

// A `200` from the identity provider is a sign-in page, so it says which session to renew rather
// than describing the bytes — and it is asked first, because that page is HTML too and the other
// refusal would otherwise answer for it.
test("a response from the identity provider is refused as an expired session", () => {
  const refusal = downloadRefusal({
    attachment: PDF,
    url: "https://login.microsoftonline.com/15ce9348/saml2?SAMLRequest=abc",
    contentType: "text/html",
  });
  assert.match(refusal, /npm run login/);
  assert.doesNotMatch(refusal, /text\/html/);
});

test("an expired session is told from a page that is merely the wrong bytes", () => {
  const expired = downloadRefusal({
    attachment: PDF,
    url: "https://idp.ntu.edu.sg/idp/profile/SAML2/Redirect/SSO",
    contentType: "text/html",
  });
  const wrong = downloadRefusal({ attachment: PDF, url: RESOURCE_URL, contentType: "text/html" });
  assert.notEqual(expired, wrong);
  assert.doesNotMatch(wrong, /npm run login/);
});

// NTULearn's own session can lapse without the round trip through NTU's identity provider ever
// starting: the redirect stops at Blackboard's sign-in page, on NTULearn's own host.
test("a sign-in page on NTULearn's own host is an expired session too", () => {
  const refusal = downloadRefusal({
    attachment: PDF,
    url: "https://ntulearn.ntu.edu.sg/webapps/login/?new_loc=%2Fbbcswebdav%2Fxid-1234_1",
    contentType: "text/html",
  });
  assert.match(refusal, /npm run login/);
  // The address is the page, not the query string carrying the whole way back.
  assert.doesNotMatch(refusal, /new_loc/);
});

// An attachment names itself in whichever of four fields its kind of attachment uses, and states
// its type with the same `; charset=…` an arriving header carries, so both sides are read alike.
test("an attachment that is itself a web page is not refused for arriving as one", () => {
  for (const attachment of [
    { fileName: "Reading list.html", mimeType: "" },
    { fileName: "Reading list.HTM", mimeType: "application/octet-stream" },
    { fileName: "reading-list", mimeType: "text/html" },
    { linkName: "Reading list.html" },
    { displayName: "Reading list.xhtml" },
    { linkName: "reading-list", mimeType: "Text/HTML; charset=UTF-8" },
  ]) {
    assert.equal(
      downloadRefusal({ attachment, url: RESOURCE_URL, contentType: "text/html; charset=UTF-8" }),
      null,
    );
  }
});

// The header is a claim NTULearn writes in whatever case it likes, and one it sometimes omits.
// Absence is not evidence of the wrong bytes, so it is not refused on.
test("the header decides regardless of case, and is not required", () => {
  assert.match(
    downloadRefusal({ attachment: PDF, url: RESOURCE_URL, contentType: "TEXT/HTML" }),
    /05 Week 1\.pdf/,
  );
  assert.equal(downloadRefusal({ attachment: PDF, url: RESOURCE_URL, contentType: "" }), null);
  assert.equal(
    downloadRefusal({ attachment: PDF, url: RESOURCE_URL, contentType: undefined }),
    null,
  );
});

// `fileSize` is absent or wrong often enough to cry wolf (ADR-0005), so nothing here reads it.
test("a file whose size NTULearn misreports is judged the same way", () => {
  const attachment = { ...PDF, fileSize: 0 };
  assert.equal(
    downloadRefusal({ attachment, url: RESOURCE_URL, contentType: "application/pdf" }),
    null,
  );
  assert.match(
    downloadRefusal({ attachment, url: RESOURCE_URL, contentType: "text/html" }),
    /05 Week 1\.pdf/,
  );
});

// What a run saw is the `content-type` that came back; NTULearn's claim is evidence of nothing but
// itself, and the two are only ever interesting where they differ (#60).
test("the type a download arrived with is what is recorded", () => {
  assert.deepEqual(downloadedType(PDF, { "content-type": "application/octet-stream" }), {
    mimeType: "application/octet-stream",
    claimedMimeType: "application/pdf",
  });
});

// A charset says how the type was sent rather than what it is, so it is no disagreement — and
// where there is none there is no second field to read.
test("a claim the download bore out is not kept a second time", () => {
  assert.deepEqual(downloadedType(PDF, { "content-type": "application/pdf; charset=binary" }), {
    mimeType: "application/pdf; charset=binary",
  });
});

// NTULearn writes the word `undefined` where it has no value, so a claim that reads as supplied
// until it is asked for is no claim to hold against what arrived.
test("a claim NTULearn never made is not recorded as a disagreement", () => {
  assert.deepEqual(downloadedType({ fileName: "notes", mimeType: "undefined" }, {}), {
    mimeType: null,
  });
});
