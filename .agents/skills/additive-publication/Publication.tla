------------------------- MODULE Publication -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS ReplaceClaim, TruncateStage
VARIABLES destination, firstOccupant, writers

Ids == 1..3
Bodies == {"A", "B"}
Absent == [kind |-> "Absent", identity |-> "None", bytes |-> "None"]
InitialOccupants == {
    Absent,
    [kind |-> "File", identity |-> "Initial", bytes |-> "A"],
    [kind |-> "File", identity |-> "Initial", bytes |-> "Existing"],
    [kind |-> "Directory", identity |-> "Initial", bytes |-> "None"],
    [kind |-> "Symlink", identity |-> "Initial", bytes |-> "None"]
}
vars == <<destination, firstOccupant, writers>>

Init ==
    /\ destination \in InitialOccupants
    /\ firstOccupant = destination
    /\ writers \in [Ids -> [requested : Bodies, pc : {"Inspect"},
         staged : {"None"}, outcome : {"Pending"}, accepted : {"None"}]]

Inspect(w) ==
    /\ writers[w].pc = "Inspect"
    /\ writers' = [writers EXCEPT ![w].pc =
         CASE destination.kind = "Absent" -> "Stage"
           [] destination.kind = "File" -> "Read"
           [] OTHER -> "Done",
         ![w].outcome = IF destination.kind \in {"Absent", "File"}
                         THEN "Pending" ELSE "Conflict"]
    /\ UNCHANGED <<destination, firstOccupant>>

Read(w) ==
    /\ writers[w].pc = "Read"
    /\ writers' = [writers EXCEPT ![w].pc = "Done",
         ![w].accepted = destination.bytes,
         ![w].outcome = IF destination.bytes = writers[w].requested
                         THEN "Identical" ELSE "Conflict"]
    /\ UNCHANGED <<destination, firstOccupant>>

Stage(w) ==
    /\ writers[w].pc = "Stage"
    /\ writers' = [writers EXCEPT ![w].pc = "Claim",
         ![w].staged = IF TruncateStage THEN "Truncated" ELSE writers[w].requested]
    /\ UNCHANGED <<destination, firstOccupant>>

Claim(w) ==
    /\ writers[w].pc = "Claim"
    /\ IF destination.kind = "Absent" \/ ReplaceClaim
       THEN /\ destination' = [kind |-> "File", identity |-> w, bytes |-> writers[w].staged]
            /\ firstOccupant' = IF firstOccupant.kind = "Absent"
                                 THEN destination' ELSE firstOccupant
            /\ writers' = [writers EXCEPT ![w].pc = "Cleanup",
                 ![w].outcome = "Created", ![w].accepted = writers[w].staged]
       ELSE /\ writers' = [writers EXCEPT ![w].pc = "Reinspect"]
            /\ UNCHANGED <<destination, firstOccupant>>

Reinspect(w) ==
    /\ writers[w].pc = "Reinspect"
    /\ writers' = [writers EXCEPT ![w].pc =
         IF destination.kind = "File" THEN "Reread" ELSE "Cleanup",
         ![w].outcome = IF destination.kind = "File" THEN "Pending" ELSE "Conflict"]
    /\ UNCHANGED <<destination, firstOccupant>>

Reread(w) ==
    /\ writers[w].pc = "Reread"
    /\ writers' = [writers EXCEPT ![w].pc = "Cleanup",
         ![w].accepted = destination.bytes,
         ![w].outcome = IF destination.bytes = writers[w].requested
                         THEN "Identical" ELSE "Conflict"]
    /\ UNCHANGED <<destination, firstOccupant>>

Cleanup(w) ==
    /\ writers[w].pc = "Cleanup"
    /\ writers' = [writers EXCEPT ![w].pc = "Done", ![w].staged = "None"]
    /\ UNCHANGED <<destination, firstOccupant>>

Next == \E w \in Ids : Inspect(w) \/ Read(w) \/ Stage(w) \/ Claim(w)
                        \/ Reinspect(w) \/ Reread(w) \/ Cleanup(w)
Spec == Init /\ [][Next]_vars

FirstOccupantPreserved == firstOccupant.kind = "Absent" \/ destination = firstOccupant
SuccessfulBytesComplete == \A w \in Ids :
    writers[w].outcome \in {"Created", "Identical"} => writers[w].accepted = writers[w].requested
======================================================================
