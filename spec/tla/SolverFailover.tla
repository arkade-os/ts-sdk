---- MODULE SolverFailover ----
EXTENDS Naturals, FiniteSets

\* Action -> intended source symbol
\* StartAttempt, FailAttempt -> packages/swap/src/client/solverRouting.ts: orderedSolverCandidates / canFailoverQuote
\* Reply, Dispose, ReturnQuote, BeginAccept -> packages/swap/src/client/client.ts: createSwapClient quote / accept / dispose
\* ReadRecord, Persist, Submit, Finish, AcceptError -> packages/swap/src/client/accept.ts: acceptQuote / acceptQuoteBody
CONSTANTS Candidates, Callers, BreakPin, BreakStale, BreakAfterAccept, BreakIdempotency
VARIABLES phase, current, attempts, wire, winner, returned, staleWon,
          accepted, acceptedStarts, starts, lock, pc, observed, localRecord,
          records, recordSolver, funded, nextRecord
vars == <<phase, current, attempts, wire, winner, returned, staleWon,
          accepted, acceptedStarts, starts, lock, pc, observed, localRecord,
          records, recordSolver, funded, nextRecord>>
Solvers == 1..Candidates
RecordIds == 1..Cardinality(Callers)

Init == /\ phase = "preparing"
        /\ current = 1
        /\ attempts = [s \in Solvers |-> "idle"]
        /\ wire = {}
        /\ winner = 0
        /\ returned = 0
        /\ staleWon = FALSE
        /\ accepted = FALSE
        /\ acceptedStarts = 0
        /\ starts = 0
        /\ lock = 0
        /\ pc = [c \in Callers |-> "idle"]
        /\ observed = [c \in Callers |-> 0]
        /\ localRecord = [c \in Callers |-> 0]
        /\ records = {}
        /\ recordSolver = [r \in RecordIds |-> 0]
        /\ funded = {}
        /\ nextRecord = 1

StartAttempt == /\ phase = "preparing"
                /\ current \in Solvers
                /\ attempts[current] = "idle"
                /\ attempts' = [attempts EXCEPT ![current] = "pending"]
                /\ wire' = wire \cup {current}
                /\ starts' = starts + 1
                /\ UNCHANGED <<phase, current, winner, returned, staleWon, accepted,
                     acceptedStarts, lock, pc, observed, localRecord, records, recordSolver, funded, nextRecord>>

FailAttempt == /\ phase = "preparing"
               /\ attempts[current] = "pending"
               /\ attempts' = [attempts EXCEPT ![current] = "closed"]
               /\ current' = current + 1
               /\ phase' = IF current = Candidates THEN "exhausted" ELSE "preparing"
               /\ UNCHANGED <<wire, winner, returned, staleWon, accepted, acceptedStarts,
                    starts, lock, pc, observed, localRecord, records, recordSolver, funded, nextRecord>>

Reply(s) == /\ s \in wire
            /\ wire' = wire \ {s}
            /\ IF phase = "preparing" /\ (BreakStale \/ (s = current /\ attempts[s] = "pending"))
               THEN /\ phase' = "quoted"
                    /\ winner' = s
                    /\ staleWon' = (s # current \/ attempts[s] # "pending")
                    /\ attempts' = [t \in Solvers |-> IF attempts[t] = "pending" THEN "closed" ELSE attempts[t]]
               ELSE /\ UNCHANGED <<phase, winner, staleWon, attempts>>
            /\ UNCHANGED <<current, returned, accepted, acceptedStarts, starts, lock,
                 pc, observed, localRecord, records, recordSolver, funded, nextRecord>>

ReturnQuote == /\ phase = "quoted"
               /\ phase' = "returned"
               /\ returned' = winner
               /\ UNCHANGED <<current, attempts, wire, winner, staleWon, accepted,
                    acceptedStarts, starts, lock, pc, observed, localRecord, records, recordSolver, funded, nextRecord>>

BeginAccept(c) == /\ phase \in {"returned", "accepting", "uncertain", "funded", "done"}
                  /\ pc[c] = "idle"
                  /\ (lock = 0 \/ BreakIdempotency)
                  /\ pc' = [pc EXCEPT ![c] = "reading"]
                  /\ lock' = c
                  /\ accepted' = TRUE
                  /\ acceptedStarts' = IF accepted THEN acceptedStarts ELSE starts
                  /\ phase' = "accepting"
                  /\ UNCHANGED <<current, attempts, wire, winner, returned, staleWon, starts,
                       observed, localRecord, records, recordSolver, funded, nextRecord>>

ReadRecord(c) == /\ pc[c] = "reading"
                 /\ pc' = [pc EXCEPT ![c] = "read"]
                 /\ observed' = [observed EXCEPT ![c] = IF records = {} THEN 0 ELSE CHOOSE r \in records : TRUE]
                 /\ UNCHANGED <<phase, current, attempts, wire, winner, returned, staleWon,
                      accepted, acceptedStarts, starts, lock, localRecord, records, recordSolver, funded, nextRecord>>

Persist(c) == /\ pc[c] = "read"
              /\ observed[c] = 0
              /\ nextRecord \in RecordIds
              /\ records' = records \cup {nextRecord}
              /\ recordSolver' = [recordSolver EXCEPT ![nextRecord] =
                    IF BreakPin THEN (IF returned = Candidates THEN 1 ELSE returned + 1) ELSE returned]
              /\ localRecord' = [localRecord EXCEPT ![c] = nextRecord]
              /\ nextRecord' = nextRecord + 1
              /\ pc' = [pc EXCEPT ![c] = "persisted"]
              /\ UNCHANGED <<phase, current, attempts, wire, winner, returned, staleWon,
                   accepted, acceptedStarts, starts, lock, observed, funded>>

Reuse(c) == /\ pc[c] = "read"
            /\ observed[c] # 0
            /\ localRecord' = [localRecord EXCEPT ![c] = observed[c]]
            /\ pc' = [pc EXCEPT ![c] = "done"]
            /\ lock' = 0
            /\ UNCHANGED <<phase, current, attempts, wire, winner, returned, staleWon,
                 accepted, acceptedStarts, starts, observed, records, recordSolver, funded, nextRecord>>

Submit(c) == /\ pc[c] = "persisted"
             /\ localRecord[c] \in records
             /\ funded' = funded \cup {localRecord[c]}
             /\ pc' = [pc EXCEPT ![c] = "submitted"]
             /\ phase' = "funded"
             /\ UNCHANGED <<current, attempts, wire, winner, returned, staleWon, accepted,
                  acceptedStarts, starts, lock, observed, localRecord, records, recordSolver, nextRecord>>

AcceptError(c) == /\ pc[c] \in {"persisted", "submitted"}
                  /\ pc' = [pc EXCEPT ![c] = "done"]
                  /\ lock' = 0
                  /\ phase' = IF BreakAfterAccept /\ current < Candidates THEN "preparing" ELSE "uncertain"
                  /\ current' = IF BreakAfterAccept /\ current < Candidates THEN current + 1 ELSE current
                  /\ UNCHANGED <<attempts, wire, winner, returned, staleWon,
                       accepted, acceptedStarts, starts, observed, localRecord, records, recordSolver, funded, nextRecord>>

Finish(c) == /\ pc[c] = "submitted"
             /\ pc' = [pc EXCEPT ![c] = "done"]
             /\ phase' = "done"
             /\ lock' = 0
             /\ UNCHANGED <<current, attempts, wire, winner, returned, staleWon, accepted,
                  acceptedStarts, starts, observed, localRecord, records, recordSolver, funded, nextRecord>>

Dispose == /\ phase \in {"preparing", "quoted", "returned", "exhausted"}
           /\ phase' = "disposed"
           /\ attempts' = [s \in Solvers |-> IF attempts[s] = "pending" THEN "closed" ELSE attempts[s]]
           /\ UNCHANGED <<current, wire, winner, returned, staleWon, accepted, acceptedStarts,
                starts, lock, pc, observed, localRecord, records, recordSolver, funded, nextRecord>>

Next == StartAttempt \/ FailAttempt \/ ReturnQuote \/ Dispose
        \/ (\E s \in Solvers : Reply(s))
        \/ (\E c \in Callers : BeginAccept(c) \/ ReadRecord(c) \/ Persist(c) \/ Reuse(c)
                             \/ Submit(c) \/ AcceptError(c) \/ Finish(c))
Spec == Init /\ [][Next]_vars

NoDoubleFunding == Cardinality(funded) <= 1
AcceptedSolverPinned == \A r \in records : recordSolver[r] = returned
StaleResponseCannotWin == ~staleWon
NoFailoverAfterAccept == accepted => (starts = acceptedStarts /\ phase # "preparing")
DisposalClosesAttempts == phase = "disposed" => (\A s \in Solvers : attempts[s] # "pending")
TypeOK == /\ phase \in {"preparing", "quoted", "returned", "accepting", "uncertain", "funded", "done", "exhausted", "disposed"}
          /\ current \in 1..(Candidates + 1)
          /\ attempts \in [Solvers -> {"idle", "pending", "closed"}]
          /\ wire \subseteq Solvers
          /\ winner \in 0..Candidates
          /\ returned \in 0..Candidates
          /\ staleWon \in BOOLEAN
          /\ accepted \in BOOLEAN
          /\ acceptedStarts \in 0..Candidates
          /\ starts \in 0..Candidates
          /\ lock \in Callers \cup {0}
          /\ pc \in [Callers -> {"idle", "reading", "read", "persisted", "submitted", "done"}]
          /\ observed \in [Callers -> RecordIds \cup {0}]
          /\ localRecord \in [Callers -> RecordIds \cup {0}]
          /\ records \subseteq RecordIds
          /\ recordSolver \in [RecordIds -> 0..Candidates]
          /\ funded \subseteq records
          /\ nextRecord \in 1..(Cardinality(Callers) + 1)
====
