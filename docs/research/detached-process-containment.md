# Independently detached subprocesses need platform containment

The portable media runner proves cleanup of its original owned POSIX process group. It cannot
prove termination of arbitrary descendants that create another session, close inherited streams
and outlive their parent. This is a boundary inferred from the interfaces below and reproduced
by bounded synthetic timeout/checkpoint fixtures; it is not a claim that every OS forbids stronger
supervision. The universal criterion in [issue163](https://github.com/Jerome-Group/ntulearn/issues/163)
remains unticked and open.

## Ownership disappears before polling

A non-Windows Node child spawned with `detached: true` starts a new session/group; ignoring its
streams lets it outlive its parent. Node's `close` concerns direct-child exit and stdio closure,
not historical ancestry. Numeric PID signalling can target a reused PID. After an unobserved
fork detaches and is reparented, a userspace ancestry snapshot has no mandatory ownership link;
checking identity and then signalling also leaves a race. More frequent polling cannot prove
completeness. These conclusions follow from [Node26.4 child-process semantics](https://nodejs.org/download/release/v26.4.0/docs/api/child_process.html#optionsdetached),
its [signal/PID-reuse warning](https://nodejs.org/download/release/v26.4.0/docs/api/child_process.html#subprocesskillsignal),
and [Apple session creation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html).

Apple's XNU process-event filter rejects recursive `NOTE_TRACK`, `NOTE_TRACKERR` and `NOTE_CHILD`
requests with `ENOTSUP`. A native kqueue wrapper therefore does not supply the missing recursive
tracker. See [Apple's implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_event.c#L1037).
This source inspection does not assert a checksum or behavior of the installed kernel.

## Narrower designs and deployment boundary

Cooperative registration before descendants start work can supervise repository-controlled
children. Arbitrary external programs need not retain that channel or token. A PID file, token
scan or presently matching parent ID cannot independently authorize signalling an unseen process.

Linux can provide stronger ownership when an exclusive delegated cgroup exists before launch,
children inherit membership and migration/escape is prevented. Its `cgroup.kill` handles concurrent
forking. That requires a different deployment/containment contract; it is not stock macOS or a
portable Node change. See [kernel cgroup v2 ownership and delegation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
No native helper, OS grant, security change or service installation is introduced here.

## Acceptance and repeatable evidence

`node --test test/media-process-boundary.test.mjs` checks timeout and checkpoint with ignored and
inherited streams. It records `originalGroup: passed` and `independentlyDetached: failed/unsupported`:
the original group stops, the escape remains alive, and an unrelated owned sentinel stays
unsignalled. Fixtures self-expire and clean only positively registered owned identities. A green
test verifies this report and isolation; it does not turn the universal termination criterion green.

An inherited pipe can keep direct-child `close` pending after group disappearance, so bounded
confirmation stays globally unsafe. A detached process with ignored streams supplies no such
warning. Unconfirmed cleanup retains the exact initiating failure in non-enumerable
`originalReason` and preserves independent cleanup `cause`; `MEDIA_PROCESS_CLEANUP` and
`globalSafety` still prevent normal checkpoint recovery. Do not infer descendant absence from
the original group's absence or signal other same-user processes to fill missing evidence.

For proposed platform adapters, macOS27 descendant-scoped Endpoint Security changes the
prerequisite analysis but does not supply a qualified subtree-kill guarantee here. The
[source-cited design evaluation](platform-containment-design.md) compares it with authority-separated
Linux containment and records required launch, migration, failure and confirmation evidence.
