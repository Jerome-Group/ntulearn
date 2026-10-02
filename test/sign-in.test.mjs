import assert from "node:assert/strict";
import test from "node:test";
import { signInStalled } from "../src/ntulearn/sign-in.mjs";

test("authentication diagnostics remove URL credentials, query and fragment", () => {
  for (const url of [
    "https://user:password@login.microsoftonline.com/login?SAMLRequest=SECRET#FRAGMENT",
    "https://user:password@ntulearn.ntu.edu.sg/auth?code=SECRET#FRAGMENT",
    "not a URL SECRET",
  ]) {
    const diagnostic = signInStalled(url, 60_000);
    assert.match(diagnostic, /npm run login/);
    for (const secret of ["password", "SECRET", "FRAGMENT", "user:"])
      assert.equal(diagnostic.includes(secret), false);
  }
});
