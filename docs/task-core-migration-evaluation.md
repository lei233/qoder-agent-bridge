# Task Core Migration Evaluation

This document is the explicit checkpoint for the Task Core / Embedded Host
milestone. It evaluates the architecture before any Task Manager, SQLite,
daemon, or MCP work begins.

## Scope evaluated

The migration has four layers:

1. permanent pure Task Core domain semantics;
2. a temporary file-backed Embedded Task Host with fail-closed locking,
   Task-owned diagnostics, and immutable Task-owned artifacts;
3. a task-aware CLI used by the Qoder Skill; and
4. a reduced Skill-facing surface that keeps policy / approval / review above
   the mechanical execution boundary.

The existing one-shot Runner and Worktree Core remain the mechanical execution
and isolation implementations. They are owned below the Host rather than
reimplemented by the Skill.

The intended ownership is now:

```text
Skill decides policy.
CLI presents commands.
EmbeddedTaskHost owns execution/orchestration.
Task Core owns state semantics.
Runner and Worktree own mechanics.
```

## Question 1: Did Task Core reduce orchestration leakage?

Yes, materially.

### Before the migration

The Skill directly coordinated details such as:

- Runner invocation syntax;
- Worktree prepare/inspect/diff/reopen/apply/dispose commands;
- Worktree session paths and retry-of lineage;
- the temporary Qoder execution cwd as plumbing between commands;
- manual Runner timeout values and internal model-request retry controls;
- explicit Qoder executable overrides;
- host terminal wait timings used to keep long CLI calls blocking; and
- recovery-vs-retry vocabulary tied to Worktree mechanics.

Those details made the Skill a second orchestration implementation.

### At the Embedded Host milestone

The normal Skill workflow depends on Task-facing evidence such as:

```text
taskStatePath
workspace.cwd
workspace.changedFiles
workspace.includedData
retryEligibility
preparationId
Candidate identity
Task/Invocation result evidence
```

It no longer owns or selects:

```text
Worktree statePath
Worktree root
Worktree phase
Git-index status plumbing
retryOf paths
prepared successor session paths
reopen mechanics
Runner cwd/executable plumbing
legacy Runner recovery hints
Runner timeout milliseconds
Runner internal model-request retry count
process-group / PID / kill mechanics
```

Task execution policy is a Host deployment concern. `QODER_TASK_TIMEOUT_MS` and
`QODER_TASK_MAX_MODEL_REQUEST_RETRIES` may configure the Host, while individual
Task invocations and the Skill cannot override them. Invalid non-empty deployment
overrides silently fall back to defaults; the actual policy and fallback evidence
are recorded only in the immutable Invocation result artifact, not in Task Core
state or normal Skill-facing JSON.

The Qoder executable is likewise resolved by the trusted deployment / Runner
path rather than supplied by a normal Task invocation. `model` remains an
Invocation-level execution preference.

One host-mechanical compatibility shim intentionally remains: while Codex calls
the Task CLI through a terminal rather than a native Task/MCP tool, the caller
keeps the original Task CLI command logically blocking on one terminal session.
There is no ordinary-vs-explicit-long Task classification. The current adapter
profile uses one non-trivial startup yield followed, when necessary, by the
longest reasonable same-session blocking wait supported by the host. It must not
start duplicate Task commands, run concurrent Task inspection, or turn a live
session into short-frequency polling.

Those wait values are adapter policy only. They are not Runner timeout semantics,
Task execution policy, or Task-domain state. A future MCP Task tool with native
long-lived calls or progress delivery should delete this shim rather than copy
its constants into Task Core or a Task Manager.

The remaining `workspace.cwd` disclosure is intentional. The Skill needs one
concrete filesystem boundary for policy responsibilities that should not move
into Task Core:

- external-data disclosure;
- context selection relative to the execution workspace; and
- independent verification/check execution.

That path is a Task-facing disclosure, not a value the Skill passes back into
Runner or Worktree execution.

### Result

The Skill is now a policy / approval / review layer rather than a mechanical
Task executor. Low-level Runner and Worktree commands and full `task get` output
remain compatibility/diagnostic surfaces, not normal lifecycle dependencies.

## Question 2: Did Candidate/apply identity improve?

Yes.

The pre-Task workflow reviewed a generated Qoder-only patch and later asked the
Worktree coordinator to apply its current review patch. The Skill had to preserve
the association between the reviewed patch and the later apply operation.

The Task workflow makes that identity explicit and durable:

- each successful review freeze creates an immutable Candidate record;
- the Candidate records producing Invocation, workspace lineage, baseline tree,
  immutable patch path, SHA-256, changed files, and creation time;
- only the active Candidate may be applied;
- repair invalidates the active Candidate without mutating Candidate history;
- apply requires the exact Candidate ID approved by the user;
- the Host verifies the immutable Candidate hash and byte identity against the
  actual Worktree review patch before source modification; and
- terminal `appliedCandidateId` persists which Candidate produced the applied
  outcome.

This removes a major identity ambiguity: "the patch we reviewed" and "the patch
the coordinator will apply" are connected by a first-class Task entity and
checked bytes rather than convention alone.

## Question 3: Did retry semantics become clearer without weakening policy?

Yes.

Task Core has one failed-Invocation follow-up concept: `retry`. The Skill still
owns the policy choice:

```text
continue -> reuse the current trustworthy workspace
restart  -> use an explicitly prepared successor workspace
```

Restart retry now has one supported lifecycle:

```text
prepare successor
-> policy / disclosure / approval
-> run prepared successor
```

`EmbeddedTaskHost` owns that prepared successor end to end: preparation,
ownership validation, Task-version/staleness validation, workspace-drift
validation, Runner execution, immutable result persistence, Task commit, and
explicit discard. The Skill Bridge does not execute Runner, write Invocation
result artifacts, call `finishInvocation`, or attach successor Worktree state.

The old one-step Host successor retry compatibility path has been removed.
Continue retry remains on the current workspace and uses the same Host invocation
execution/result/commit pipeline as initial run, repair, and prepared restart.

The simplification is therefore orchestration cleanup, not a weaker retry
policy. Task-level retry remains intentionally separate from Runner-internal
model-request retries configured by the Host deployment.

## Question 4: Are start and commit failure boundaries solved well enough for this milestone?

They are fail-closed enough for the Embedded Host milestone, but they are not a
Task Manager durability design.

`EmbeddedTaskHost.start()` no longer permits a newly created Task root to become
unlocatable. Failures are handled by evidence:

- if failure is proven to occur before Worktree side effects, the Task root is
  removed;
- if a returned Worktree exists and cleanup is proven successful, the Task root
  is removed; and
- if Worktree cleanup or side-effect state cannot be proven, the Task root and
  lock are preserved and the caller receives a Task-owned `diagnosticRef`.

The diagnostic artifact records only the minimum evidence needed to locate the
Task and understand the original/cleanup errors. It does not capture prompts,
stdout, full environment variables, credentials, or secrets.

For Runner-owning operations, one Host pipeline owns the durable running
Invocation, deployment policy injection, Runner execution, immutable result
artifact, `finishInvocation`, final Task save, and fail-closed handling when the
commit result is ambiguous.

The Embedded Host also provides useful single-process safety:

- exclusive fail-closed Task mutation locks;
- no automatic stale-lock reclamation;
- immutable Invocation result and Candidate artifacts;
- atomic file replacement for Task state;
- preserved locks when external side effects cannot be proven; and
- terminal outcome persistence before best-effort cleanup where appropriate.

It intentionally does **not** provide the mechanisms required for a durable
multi-request Task Manager:

- operation journal / write-ahead external-side-effect intent;
- automatic crash reconciliation;
- request idempotency;
- expected-version concurrency API;
- execution fencing;
- durable Runner completion sink independent of the caller process;
- PID/process-tree ownership or live reattachment;
- project registry/security boundary; or
- multi-manager/shared-database semantics.

A file lock that intentionally becomes stale is an acceptable fail-closed
milestone behavior. It is not a production Task Manager recovery design.

## Question 5: Should SQLite / daemon / MCP start immediately after this milestone?

Not as incremental Embedded Host work.

The milestone achieves the intended boundary:

- one Task-domain implementation;
- durable Candidate/apply identity;
- explicit Invocation/workspace lineage;
- Host-owned Runner execution policy and orchestration;
- a task-aware execution facade;
- a Skill that remains policy / approval / review oriented; and
- preservation of the existing Runner/Worktree safety path.

The next architecture step should be a separate Task Manager durability design.
In particular, settle the transaction boundary between authoritative metadata
and external side effects before choosing SQLite tables or MCP methods.

A future design should specify at least:

```text
request_id idempotency
expected_version semantics
execution lease/fence identity
Runner durable completion contract
operation journal states
write-ahead intent ordering
crash reconciliation rules
project_id authorization boundary
artifact ownership/retention
manager restart behavior
```

The MCP design should also replace the temporary terminal blocking shim with a
native long-lived Task invocation/progress contract. That replacement is an
adapter/API concern; the wait-budget constants should not migrate into the
durable Task model.

Only after those semantics are explicit should SQLite schema, daemon APIs, or
MCP Tasks integration be implemented.

## Persistence compatibility

The current `task.json` `schemaVersion = 1` is an internal persistence format for
the Embedded Host milestone, not a long-term public compatibility contract.
Compatible changes may remain v1. An incompatible persisted-state change must
bump the schema and fail closed when an older open Task is encountered. This
milestone does not introduce an automatic migration framework.

That is why the milestone intentionally does not generalize current Worktree and
Candidate path references into future Task Manager workspace/artifact domains,
and does not add Invocation approved-input hashes prematurely.

## Residual debt after the Embedded Host milestone

The following are acceptable residuals for this checkpoint:

- full Task state intentionally contains Worktree session paths because the
  Embedded Host needs durable lineage references;
- low-level Runner and Worktree CLIs remain supported for compatibility and
  diagnosis;
- `workspace.cwd` remains visible to the Skill for disclosure/context/checks;
- Codex still needs one same-session blocking terminal adapter shim until a
  native MCP Task tool replaces it;
- stale locks and ambiguous diagnostics require manual diagnosis rather than
  automatic reconciliation; and
- `task.json` remains a temporary internal file-backed persistence format.

These belong to the next Task Manager durability design rather than another
round of expanding EmbeddedTaskHost or moving mechanics back into Skill / Task
CLI.

## Milestone conclusion

The architecture now has the intended separation:

```text
Skill policy / approval / review
    -> Task CLI
        -> EmbeddedTaskHost application/orchestration
            -> Task Core state semantics
            -> Runner + Worktree mechanical truth
```

The milestone should end with full validation and generated Skill artifact
freshness. After that, the next phase should begin as a separate Task Manager
durability design rather than continuing to grow EmbeddedTaskHost.
