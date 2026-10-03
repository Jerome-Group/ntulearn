# Gallery announcement Close retains a context read guard

Gallery discovery may dismiss only one visible product dialog with the exact New Course Announcement
heading and dedicated Close new announcements modal button. A normal bounded button click leaves Mark
as read untouched. Unknown, authentication, consent, malformed or multiple dialogs are never dismissed.
An unconfirmed close or read guard leaves discovery incomplete. Existing pagination/displayed-count
reconciliation remains the authority; successful navigation claims no media or transcript quality.

A generic dismiss/force click would accept unknown UI semantics and risk marking announcements read.
The narrow control is necessary but not sufficient: before clicking, install a retained owned-browser-
context request guard that aborts non-GET/HEAD NTULearn requests. Requests allowed onward use fallback,
never continue, preserving lower route handlers. Malformed methods or routing errors fail closed.
Keep only fixed diagnostic codes; do not retain request URLs, headers, payloads or browser logs.

## Consequences

Guard state belongs to the browser context through a WeakMap and is not removed after one close.
Known service workers require refusal because context routing cannot establish their request coverage;
positive absence is checked before close and afterward. Browser/security settings remain unchanged.
This covers the owned context's intercepted requests, with no guarantee over arbitrary other contexts,
external page-route overrides, newly registered/unknown detached workers or previously dispatched
requests. The repository currently installs no conflicting page routes. The mechanism neither assumes
nor changes the semantics of a chained external handler. A guard failure or unconfirmed Close remains
sticky for that context; later Gallery reads refuse before navigation until the owned context closes.

Bounded waits bound the caller's wait; they do not prove physical settlement or cancellation of external
browser activity. The sticky refusal prevents a timed-out Close from permitting later navigation.
The existing owned-session cleanup path remains responsible for browser termination and cleanup
uncertainty. Incomplete offline adapters may authorize no dismissal and leave ordinary Gallery reading
unchanged. Fixtures use fake pages/contexts established before calls; author checks launch no browser,
use no production session and reach no network. Actual Owner discovery qualification is separate.

## Revisit when

The product changes its exact heading/accessible Close control or requires a mutation to dismiss it.
Never widen recognition or request methods silently to restore apparent discovery completeness.
