# The session is a signed-in browser profile, not a stored cookie

The `Session` is a persistent Chrome profile that Playwright drives. `npm run login` opens a real
window, the student completes NTU's SSO and MFA in it themselves, and Chrome writes whatever it
writes into that profile directory. Every later run relaunches the same profile headless and
reads the XSRF token off the requests the page makes. This repository never parses, stores, or
even looks at a cookie.

It buys one thing: no credential is ever handled by this code. The student's password and their
second factor are typed into NTU's own page in a real browser, and what persists is a directory
the operating system protects, not a value in a file that a stack trace or a `console.log` could
leak.

## Why not an HTTP client with a cookie jar

The lighter design is obvious and would have been much less code: sign in once, keep the session
cookies, send them with `fetch`. It loses on three counts.

**SSO is not a form post.** NTU's sign-in is a redirect chain through an identity provider with a
second factor, and MFA is deliberately hostile to automation. Driving it means either
reimplementing the chain — which breaks whenever the university changes it, silently, mid-term —
or having the student paste cookies out of their own browser's dev tools, which is a worse
security posture taught as a setup step.

**Cookies in a file are a secret this repository would then own.** A cookie jar wants a path, a
format, and a decision about permissions; it gets committed by accident, pasted into an issue,
copied to a second machine. The Chrome profile is `chmod 700` and self-evidently not a document —
nobody has ever opened a pull request pasting one in.

**Blackboard's XSRF token is not a cookie.** It rides on the requests the page makes, so
something has to make them. Reading it off a live page is a few lines; deriving it outside a
browser is reverse engineering with a shelf life.

## What it costs

- **Chrome, and Playwright to drive it.** It is the heaviest dependency here by an order of
  magnitude, it is why CI sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`, and it is why the layering
  rule in `CODING_STANDARDS.md` §6 keeps it out of every module that can be tested.
- **The tool cannot run truly unattended forever.** The university expires the profile, and
  re-authenticating needs a person at the MFA prompt. `npm run sync` on a schedule will go red
  periodically, by design, and the fix is a human running `npm run login`.
- **It is desktop-shaped.** A headless server with no `channel: "chrome"` available cannot run
  this without work, which rules out the obvious "just put it on a cron in the cloud".
- **The profile is a portable session.** Anyone who copies that directory is the student until it
  expires. That is a smaller surface than a password, and it is not nothing.

## Revisit when

- **NTU publishes a real API, or issues personal access tokens.** That removes the reason for all
  of this, and a token in a secret store beats a browser profile on every axis here.
- **A headless-server deployment is actually wanted.** The costs above are the ones to re-argue
  first, and the answer may be that the sync stays on the desktop and only its output is shipped.
- **Playwright's persistent-context behaviour changes** such that the profile is no longer
  reusable across runs, which is the single assumption this whole design rests on.
