import assert from "node:assert/strict";
import test from "node:test";
import { isIdentityProviderUrl, isSignInUrl } from "../src/ntulearn/urls.mjs";

test("an address at the identity provider is where a person is still needed", () => {
  assert.equal(
    isIdentityProviderUrl("https://login.microsoftonline.com/15ce9348/saml2?SAMLRequest=abc"),
    true,
  );
  assert.equal(
    isIdentityProviderUrl("https://idp.ntu.edu.sg/idp/profile/SAML2/Redirect/SSO"),
    true,
  );
});

test("anywhere else is a sign-in that has not arrived rather than one that needs a person", () => {
  assert.equal(isIdentityProviderUrl("https://ntulearn.ntu.edu.sg/ultra/course"), false);
  assert.equal(isIdentityProviderUrl("/ultra/course"), false);
  assert.equal(isIdentityProviderUrl("about:blank"), false);
});

test("a lapsed session shows as a sign-in at either end of the round trip", () => {
  assert.equal(isSignInUrl("https://idp.ntu.edu.sg/idp/profile/SAML2/Redirect/SSO"), true);
  assert.equal(
    isSignInUrl("https://ntulearn.ntu.edu.sg/webapps/login/?new_loc=%2Fbbcswebdav%2Fxid-1_1"),
    true,
  );
  assert.equal(isSignInUrl("https://ntulearn.ntu.edu.sg/auth-saml/saml/login?apId=_100_1"), true);
});

test("the resource itself is not a sign-in", () => {
  assert.equal(isSignInUrl("https://ntulearn.ntu.edu.sg/bbcswebdav/xid-1234_1"), false);
  assert.equal(isSignInUrl("/ultra/courses/_1_1/outline"), false);
  assert.equal(isSignInUrl("not a url at all"), false);
});

// The hostname decides, so neither a provider's name appearing elsewhere in the address nor a
// lookalike host reads as the provider itself.
test("only the host counts", () => {
  assert.equal(isIdentityProviderUrl("https://evil.example/login.microsoftonline.com"), false);
  assert.equal(isIdentityProviderUrl("https://login.microsoftonline.com.evil.example/x"), false);
  assert.equal(isIdentityProviderUrl("not a url at all"), false);
});
