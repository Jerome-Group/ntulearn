# The watchdog is a local scheduled two-layer run

The daily run has two layers. The **run** remains `sync -- all` followed by `verify -- all`, with
the behaviour and exit codes recorded in `docs/adr/0012`. The **watchdog** is the surrounding layer:
it checks the Google Drive mount, takes the shared live-process lock, launches and bounds the run,
captures its output, retries only crashes and timeouts, and writes both a dated log and a small
`latest.json` **digest** under the state directory.

The schedule is a macOS LaunchAgent using `StartCalendarInterval` at about 05:00. The example is
`config/com.jerome-group.ntulearn.watchdog.example.plist`; the Owner fills in the machine-specific
Node and repository paths before installing it. A calendar job catches up when the Mac wakes after
the scheduled time, which is why this uses launchd rather than cron.

## Why not cloud cron

The signed-in Chrome profile and the Google Drive mount are local to the machine. A cloud job cannot
open the student's reusable NTULearn session or safely write the configured destinations. This is
the local answer to `docs/adr/0004`'s *Revisit when* entry **"A headless-server deployment is
actually wanted"**: no such deployment is wanted, so the desktop-shaped session stays on the
desktop and launchd owns the schedule.

## Why the layers stay separate

The watchdog reads the run; it does not change what the run means. A completed sync failure stays
red, a lapsed session still points at `npm run login`, and a refused course remains a log-only fact.
The watchdog's durable files make the output useful to a later delivery channel without making that
channel reinterpret NTULearn or the sync.

This answers `docs/adr/0011`'s *Revisit when* entry **"The scheduled run gets a watchdog that reads
what it prints"**. The watchdog is that reader, and `latest.json` is its stable hand-off rather than
a second course-reading authority.

## Refusals

- **Alert-only messaging.** The watchdog writes one digest every day, including green. A missing
  digest then exposes the watchdog's own death without needing an observer for the observer. Delivery
  is a later dumb pipe over `latest.json`, not part of this decision.
- **Retrying reds.** Only a crash or timeout with no usable report is retried, three attempts total.
  A completed red is evidence the run understood and must remain visible under `docs/adr/0012`;
  retrying it would hammer NTULearn while hiding the signal that needs a person.
- **Pre-checks beyond the Drive mount.** The mount check prevents a 05:00 run from creating a
  phantom local destination. More guards can misfire, block a healthy run, and become a second
  interpretation of the run's evidence, so they are not added without a concrete failure to solve.

## Consequences

- A scheduled and a manual run share the same entry point and lock, so the persistent Chrome profile
  is never opened twice by this repository.
- Each run leaves full evidence in `logs/<timestamp>-<uuid>.json`; `latest.json` contains only the
  verdict, message, finish timestamp and pointer a future delivery channel needs. Losing the logs
  costs history, not correctness.
- A session expiry can go **red periodically, by design** (`docs/adr/0004`), and its remedy is still
  a human running `npm run login`.
- If the repository volume is unavailable, launchd cannot start the job at all. The absence of the
  daily digest is therefore itself a signal, and no extra remote observer is introduced to detect it.

## Revisit when

- NTU provides a real API or a headless-server deployment becomes genuinely wanted; reread
  `docs/adr/0004` and reconsider the local session boundary.
- A delivery channel needs a different durable contract, or daily green digests stop being read; the
  alert-only refusal and the meaning of silence then need fresh evidence.
- The Drive mount check proves insufficient, or a concrete false positive justifies one additional
  pre-check; add only the guard whose failure mode is understood.
