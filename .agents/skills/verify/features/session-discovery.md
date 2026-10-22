# Session and course discovery

The Owner signs in through Chrome and lists courses visible to that student. The session remains a private browser profile.

## Sub-features

- `login` opens Chrome, lets the Owner complete SSO/MFA, then closes after Enter.
- `discover` lists the saved student's visible course memberships with availability and closes its client.
- `refusal` rejects missing configuration before either handler can launch a browser.

## How to get to it (user POV)

- Owner runs `npm run login`, completes NTU sign-in, returns after Courses appears, and presses Enter.
- Owner runs `npm run discover`.

## Driving it with drive.mjs

Preconditions: offline boundary proof needs no credentials. The full journey needs Owner invocation, installed Chrome, private course configuration, a private `0700` profile, NTU access, and any required SSO/MFA.

- **Attempt the real routes.** Run `node .agents/skills/verify/scripts/drive.mjs session`. It invokes `node src/cli.mjs login` and `node src/cli.mjs discover`, each with a different absent temporary configuration.
- **Refusal proof.** Each exits `1` with the configuration-copy action. The fixture stays empty; no profile, destination, or state is created. The CLI loads configuration before invoking either handler.
- **Full journey.** Record `verified-unreachable` with the two attempted commands and the Owner/auth prerequisites above. Only an Owner-run login plus discovery report can prove the actual session route.

## Gotchas

- Never copy, print, or inspect the real profile's contents. Directory metadata is the offline boundary.
- After an authorized saved-session read times out at the identity provider, the agent runs `npm run login` before declaring expiry. If Courses appears without input, press Enter, let the window close, and retry the read. Hand credentials, MFA, or CAPTCHA steps to the Owner. The offline helper does not attempt this authenticated diagnosis.
- Missing-config refusal proves no authenticated behavior. A course not returned by NTULearn is not evidence of an empty course.
- Sources: [CLI ordering](../../../../src/cli.mjs), [configuration](../../../../src/config.mjs), [session](../../../../src/ntulearn/session.mjs), [client](../../../../src/ntulearn/client.mjs), [session decision](../../../../docs/adr/0004-the-session-is-a-signed-in-browser-profile.md).
