import assert from "node:assert/strict";
import test from "node:test";
import { isIdentityProviderUrl } from "../src/ntulearn/urls.mjs";

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

// The hostname decides, so neither a provider's name appearing elsewhere in the address nor a
// lookalike host reads as the provider itself.
test("only the host counts", () => {
  assert.equal(isIdentityProviderUrl("https://evil.example/login.microsoftonline.com"), false);
  assert.equal(isIdentityProviderUrl("https://login.microsoftonline.com.evil.example/x"), false);
  assert.equal(isIdentityProviderUrl("not a url at all"), false);
});
