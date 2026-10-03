# Which platform can contain detached media subprocesses?

Evaluation for [#210](https://github.com/Jerome-Group/ntulearn/issues/210), 2026-10-03,
against source `d534aa813e30d02e88063bfec3d1b5a9034ebc08`. **Design, not deployment.**

Retain the current macOS original-group contract. For a future strict adapter, the strongest
researched route is an exclusive Linux cgroup with migration authority withheld from the
workload, ownership established before execution, and an independent lifetime owner. That is
a separate local deployment requiring qualification; it cannot run in the current macOS worker.
macOS27 descendant-scoped Endpoint Security is a promising research candidate, but the evidence
below does not qualify it as universal containment. Do not install a helper or silently change
existing jobs to either design.

The proposed caller interface is a named media stage. Its implementation owns command construction
and a privately selected execution adapter. A strict request must refuse before launch if ownership
cannot be enforced. A separately named original-group adapter keeps its narrower guarantee explicit;
no fallback from strict containment is permitted. The universal criterion in
[#163](https://github.com/Jerome-Group/ntulearn/issues/163) remains unticked. Research completion
cannot turn the existing `independentlyDetached: failed/unsupported` verdict green.

## Compare three interfaces

| Design | Caller interface | Depth and trade-off |
| --- | --- | --- |
| Minimal execution | `execute(command, args, limits)` | One lifecycle entrypoint hides platform setup, stop and confirmation. Command construction and tool qualification still recur in callers. |
| Flexible scope | `open(policy)`, `scope.start(spec)`, `scope.close()` | Supports parallel commands and shared budgets; exposes ordering and an async lifecycle every caller must finish. Current worker runs one job at a time, so this flexibility adds obligations without a demonstrated need. |
| Common stage | `run(stage, input, { signal })` | Hides argv, helper resolution, limits and execution behind one interface. Stage profiles need qualification; naming a stage or hashing its executable does not contain its forks. |

Recommend the common stage interface over the minimal execution implementation. This places one
external seam above argv construction and a private adapter seam around OS ownership. Callers
retain Recording/Transcript logic; platform facts concentrate in the execution module. Do not
introduce the flexible scope lifecycle until parallel commands require it.

```js
// Proposed composition; no such factory or CLI option is installed by this research.
const stages = createMediaStageRunner({ verifiedRuntime, execution: qualifiedAdapter });
await stages.run('transcribe', { input: audio, output: transcript }, { signal: checkpoint });
```

## Actual command and verification routes

| Caller | Execution and qualification concern | Existing verification |
| --- | --- | --- |
| `src/media/production-local.mjs` | ffmpeg extraction, whisper transcription, llama formatting; setup-managed artifacts establish identity, not no-detach behavior. Stage deadlines remain 4h, 8h and 20m. | `test/media-production-local.test.mjs`, `test/media-asr.test.mjs`, `test/media-formatter.test.mjs` |
| `src/media/production-remux.mjs` | ffprobe duration and ffmpeg remux. Configured ffprobe is version-probed rather than part of the five artifact hashes. | `test/direct.test.mjs`, `test/media-production.test.mjs`, `test/media-production-kaltura.test.mjs` |
| `src/media/production-youtube.mjs` | Configured yt-dlp metadata/download; helper chain and environment need qualification. | `test/youtube.test.mjs`, `test/media-production.test.mjs` |
| `src/media/runtime-command.mjs`, `src/media/setup.mjs` | Runtime probes and configured `verifyArgs`; direct library calls without owned-group authority intentionally stop only their leader. | `test/media-runtime-command.test.mjs`, `test/media-runtime-verification.test.mjs` |
| `src/media/evaluation.mjs` | Shared runtime runner and optional `/usr/bin/time -l` wrapper; wrapper is another process requiring a qualified profile. | `test/media-evaluation-process.test.mjs`, `test/media-evaluation-fixture.test.mjs` |
| `src/media/process.mjs`, `src/media/production.mjs` | Existing owned-group implementation and composition seam. | `test/media-process.test.mjs`, `test/media-process-boundary.test.mjs` |

These routes test provider/job contracts and composition; they do not certify native helper behavior.

Current yt-dlp calls do not isolate configuration/plugins or pin helper resolution explicitly.
Upstream documents [configuration/plugins and JavaScript runtime options](https://github.com/yt-dlp/yt-dlp/blob/master/README.md)
and [FFmpeg helper lookup/spawning](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/postprocessor/ffmpeg.py).
Inference: a fixed leader allowlist cannot certify that chain. This is an unqualified contract,
not evidence of an installed incident. These moving upstream sources do not identify the installed
version. Existing CLI/config and YouTube behavior remain unchanged during evaluation; future profile
restriction needs its own compatibility decision and actual tool-chain fixtures.

## macOS: available mechanisms and remaining evidence

The [existing ownership research](detached-process-containment.md) records Node26.4/POSIX
session escape, numeric PID reuse and pinned XNU's rejection of recursive kqueue tracking.
Apple's [published launchd manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)
limits ordinary exit cleanup to the same PGID. Inference: launchd registration does not cover a
`setsid` descendant. The published launchd source is historical; current behavior needs qualification.

**macOS27 changes the Endpoint Security prerequisites.** Apple's
[`es_new_descendants_client`](https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client(_:_:))
covers the caller's recursive descendants, including existing ones, and excludes other processes.
It requires the restricted Endpoint Security entitlement, but neither root nor TCC approval.
This must not be confused with the system-wide `es_new_client` requirements described in
[Apple's older explanation](https://developer.apple.com/videos/play/wwdc2020/10159/).
No entitlement was requested and no client was created here.

The same API restricts non-root callers and their descendants from executing setuid/setgid
binaries. Blocked attempts are killed before execution, produce no exec event, and are observed
through `NOTIFY_EXIT`. A candidate profile must qualify its complete helper chain and refuse
chains requiring privilege elevation; this restriction is not permission to add privileges.

New [`es_set_deadline_miss_mode`](https://developer.apple.com/documentation/endpointsecurity/es_set_deadline_miss_mode(_:_:))
can deny missed/dropped AUTH events. Fork remains
[`NOTIFY_FORK`](https://developer.apple.com/documentation/endpointsecurity/es_event_type_notify_fork),
with no AUTH_FORK in the inspected public SDK enum. Inference: denying exec does not prevent a
fork continuing existing code; fail-closed AUTH does not reconstruct a lost fork notification.
Apple's [`seq_num`](https://developer.apple.com/documentation/endpointsecurity/es_message_t/seq_num)
detects delivery gaps; inference: a quiet stream cannot certify trailing loss without later delivery.

[`es_sync_client`](https://developer.apple.com/documentation/endpointsecurity/es_sync_client(_:_:))
orders queued delivery, but its callback also fires on client destruction or immediately for a null
client. It is not subtree emptiness, complete event history or a barrier against future forks.
Detached/reparented scope retention, lost notification recovery and controller death remain unrun.

Apple's [libproc declaration](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h)
and [pinned XNU implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c#L3465)
expose audit-token signalling. This is a useful identity-targeting lead, but the header describes
private interfaces subject to change. It supplies no missing descendant identity. Neither kernel
checksum equivalence nor supported identity signalling was established on the installed OS.

[App Sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)
restricts helper resources; it does not document recursive lifetime containment. Local Apple
`sandbox-exec(1)`/`sandbox_init(3)` manuals and public SDK declarations were read without executing
policies: APIs are deprecated; the SDK27+ named-profile restriction kills a process attempting that
use. This does not establish that custom Seatbelt profiles are removed. Public support for a complete
per-command no-child policy was not established. A no-fork experiment would additionally need
vfork/spawn/IPC-helper coverage, policy-before-execution, thread/runtime compatibility and identity-safe
leader cleanup even if that leader changes PGID. It would intentionally exclude multi-process tools.

Consequently a macOS27 ES adapter is **unimplemented/unqualified**, not absent merely because root
or Full Disk Access are unavailable. Deprecated policy experiments are **unrun**. Neither becomes
a production guarantee through source inspection. Polling, token scans, subreaper-style registration
and cooperative descendants remain narrower than arbitrary external-program containment.

## Linux: strong ownership requires authority separation

The [cgroup v2 contract](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
provides inherited membership, subtree kill with concurrent fork handling, and recursive
`populated=0`. Delegation constrains migration through destination/common-ancestor permissions.
A workload sharing its broker's UID can migrate between writable run/sibling groups inside that
delegation. Inference: a private directory or an empty run group cannot recover historical escape.
Do not kill a shared ancestor containing unrelated work.

Proposed strict deployment: externally provision an exclusive ordinary-domain run group; keep its
broker outside; deny workload authority to migrate out or admit unrelated tasks. Prefer distinct
restricted workload credentials, closed control/privileged FDs and inaccessible manager interfaces.
Namespace-only isolation needs separate proof against leaked outer-namespace FDs and broker access;
[pinned Linux control-file code](https://github.com/torvalds/linux/blob/v6.12/kernel/cgroup/cgroup.c#L4891)
checks open-time credentials. Trusted external migration actors must also be excluded.

A native launcher can use [`clone3(CLONE_INTO_CGROUP|CLONE_PIDFD)`](https://man7.org/linux/man-pages/man2/clone.2.html)
to establish membership and stable child identity before exec. Spawn-then-migrate/SIGSTOP already
allows workload execution and is rejected. An alternative trusted child handshake must not run
workload code before attachment/acknowledgement. [`pidfd` signalling](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)
protects identity; process-group pidfd signalling still does not cover a later `setsid` escape.

Seal new admission, stop the owned subtree, require `populated=0`, and reap the direct child before
safe settlement. Missing/replaced/inaccessible evidence remains unconfirmed. Core ownership is
separate from optional controllers; requested unavailable resource limits must refuse explicitly.
Group emptiness concerns live processes, not pending I/O or data durability.

Cgroups alone do not stop work on broker death. Qualification needs an independent manager,
or a [private PID-namespace lifetime owner](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
with external confirmation. Parent-death signals/subreaper adoption are insufficient substitutes.
Uninterruptible operations can outlast SIGKILL; confirmation expiry must return unsafe rather than
claim a hard cessation deadline. A local Linux VM would require guest binaries, lifecycle/storage
qualification and resource measurement; it is a separate deployment, not a macOS adapter switch.
No remote processing is proposed under ADR0014's local/private-content requirement.

## Lifecycle, errors and compatibility

The proposed execution module validates limits and already-aborted signals, prepares ownership
with a bounded deadline, launches only after enforcement, captures bounded output, then seals/stops,
confirms absence and settles once. Preparation cancellation must not leave an admitted workload.
Even exit-zero cannot settle safely while an owned descendant remains. Platform selection is
composition-only; callers cannot downgrade cleanup or signal arbitrary PIDs.

Prelaunch unsupported/unqualified capability would return proposed `MEDIA_CONTAINMENT_UNAVAILABLE`
with a sanitized prerequisite and zero workloads launched. Postlaunch lost ownership/enforcement or
unconfirmed absence retains existing `MEDIA_PROCESS_CLEANUP`, `globalSafety=true`, exact private
non-enumerable `originalReason` and independent cleanup `cause`. Original timeout/checkpoint/overflow
reason is primary only after confirmed cleanup. No fallback, normal checkpoint recovery, temporary
removal, subsequent job or publication follows unsafe settlement. A future durable recovery latch
must be designed separately; existing worker locks are not evidence of persistent crash containment.

Worker lock ownership stays outside the execution module. Native lifetime enforcement must remain
valid until safe handoff, including worker/controller death; the independent lifetime owner needs
separate startup/termination acceptance. Existing media modes, overnight checkpoints, RAID0/reserve,
runtime verification, Owner-only setup, CLI/config, course boundaries, separate media verdicts,
lexical guards and additive publication remain unchanged. Cessation does not cancel arbitrary
physical I/O, flush writeback or remove existing artifacts. No Chrome profile or destination mounts
are implicitly passed to a future guest/helper; acquisition remains bounded to the student's read view.

Decision logic/output accounting is in-process; synthetic executables/temp files are local test
dependencies. The OS/entitlement/cgroup contract is true external. Deterministic adapters can test
ordering/errors, but cannot certify a kernel guarantee. Production and real bounded fixture adapters
justify a private seam; no generic plug-in framework or speculative port is needed in today's code.

## Staged acceptance and repeatable evidence

1. Keep the existing original-group adapter and command index unchanged. An implementation ticket
   must first specify stage profiles and explicit capability results without enabling strict mode.
2. Qualify one strict adapter in an independently approved environment, one command first. Probe
   actual ownership/enforcement/confirmation support rather than trusting an OS version. Missing
   preparation or requested controller capability must refuse before launch; no installation in
   sync, scheduled commands or ordinary worker execution.
3. Add crash/lost-channel handling, repeated runs and all negative fixtures before allowing strict
   completion. Independently review the exact revision and receipts; only then propose an Owner-run
   rehearsal/live setup with rollback preserving originals, queues and existing runtime.

| Route or scenario | Required evidence | Evaluation verdict |
| --- | --- | --- |
| `node --test test/media-process.test.mjs test/media-process-boundary.test.mjs` | Normal/failure/overflow, exact reasons, timeout/checkpoint, inherited/ignored pipes, live escape and unrelated sentinel | 31 passed/0 skipped in 5955.222ms; original-group evidence passes, detached ownership remains failed/unsupported |
| `npm run check` | Same indexed npm test/lint/format, ESM syntax and contracts used by CI | Required final revision check; recorded on PR |
| Strict preparation/early abort, missing entitlement/delegation/limits | Zero workload admission; bounded actionable refusal | Proposed; native adapter unrun |
| Rapid fork/double-fork/setsid/reparent/stdio close; exit-zero residual child | Complete inherited ownership and confirmed cessation; sentinel unsignalled | Linux/ES/prevention qualification unrun |
| Migration out/in, leaked authority FDs, shared subtree or changed handles | Escape/adoption prevented; unrelated work never becomes kill target | Linux unrun; unsafe configurations must refuse |
| ES queue/trailing loss, AUTH timeout, destroyed/null sync client | Loss latched unsafe; no false emptiness or recovery | macOS27 native client unrun |
| Broker SIGKILL/SIGSTOP, channel/manager loss, confirmation failure, repetition | Independent lifetime owner stops/contains; no normal recovery until separately confirmed | Unrun; ordinary cgroup/locks alone insufficient |
| I/O, mounted private data, natural runtime helper chains | Separate storage/privacy evidence and measured resource effects | Unrun; process evidence makes no such claim |

No native containment, security-policy experiment, entitlement request, service/LaunchAgent change,
installation, VM launch, live course/media command or transcript rewrite occurred. Read-only host
metadata established Darwin27 arm64/Node26.4; public SDK/source/manual inspection does not identify
installed-kernel behavior. Source-cited design is the deliverable; #163 remains open/unticked.
