# Task Core Migration Evaluation

This document is the explicit checkpoint after PR4 of the Task Core migration.
It evaluates the architecture before any Task Manager, SQLite, daemon, or MCP
work begins.

## Scope evaluated

The migration introduced four layers in sequence:

1. permanent pure Task Core domain semantics;
2. a temporary file-backed Embedded Task Host with fail-closed locking and
   immutable Task-owned artifacts;
3. a task-aware CLI used by the Qoder Skill;
4. a reduced Skill-facing surface that hides low-level Worktree and Runner
   orchestration details.

The existing one-shot Runner and Worktree Core remain the mechanical execution
and isolation implementations. They were wrapped rather than rewritten.

## Question 1: Did Task Core reduce orchestration leakage?

Yes, materially, with a small intentional remainder.

### Before the migration

The Skill directly coordinated details such as:

- Runner invocation syntax;
- Worktree prepare/inspect/diff/reopen/apply/dispose commands;
- Worktree session paths and retry-of lineage;
- the temporary Qoder execution cwd as plumbing between commands;
- manual Runner timeout values and Runner process mechanics;
- host terminal wait timings used to keep long CLI calls blocking; and
- recovery-vs-retry vocabulary tied to Worktree mechanics.

Those details were necessary to keep the workflow safe, but they made the Skill
itself a second orchestration implementation.

### After PR4

The normal Skill workflow depends on:

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

It no longer depends on:

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
manual Runner timeout milliseconds
process-group / PID / kill mechanics
```

One host-mechanical compatibility shim intentionally remains: while Codex calls
the Task CLI through a terminal rather than a native Task/MCP tool, the Skill
keeps explicit long `exec_command` / `write_stdin` wait budgets. Those waits are
not Runner timeout semantics and are not Task-domain state. They exist to keep
one Task CLI Invocation logically blocking for long stretches and prevent Codex
from turning an hour-long operation into an asynchronous workflow with repeated
status polling or unrelated reasoning between polls.

The current shim uses the established host budgets:

```text
ordinary:      200000 ms outer / 180000 ms session wait
explicit long: 300000 ms outer / 280000 ms session wait
```

The first terminal round uses a 15000 ms startup yield and then at most one long
wait on the same live session per outer tool call. A future MCP Task tool with
native long-lived blocking/progress semantics should remove this shim rather
than reproducing the constants in Task Core or Task Manager domain state.

The remaining `workspace.cwd` is also intentional. The Skill needs one concrete
filesystem boundary for three policy responsibilities that must not move into
Task Core:

- external-data disclosure;
- context selection relative to the execution workspace; and
- independent verification/check execution.

That path is now a Task-facing disclosure, not a value the Skill must pass into
Runner or Worktree operations.

### Result

The Skill is now primarily a policy layer rather than a second mechanical
coordinator. The pre-MCP blocking terminal shim is adapter debt at the Codex
host boundary, not a second implementation of Task/Runner/Worktree lifecycle.
Low-level commands and full `task get` output remain explicit
compatibility/diagnostic surfaces, not normal lifecycle dependencies.

## Question 2: Did Candidate/apply identity improve?

Yes.

The pre-Task workflow reviewed a generated Qoder-only patch and later asked the
Worktree coordinator to apply its current review patch. Safety checks existed,
but the Skill itself had to preserve the association between the reviewed patch
and the later apply operation.

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

This removes a major identity ambiguity: "the patch we reviewed" and "the
patch the coordinator will apply" are now connected by a first-class Task
entity and checked bytes, rather than convention alone.

## Question 3: Did retry semantics become clearer without weakening policy?

Yes.

Task Core has one failed-Invocation follow-up concept: `retry`. The Skill still
owns the policy choice:

```text
continue  -> reuse trustworthy partial work
restart   -> use a prepared replacement workspace
```

This replaces Task-level `recovery` vocabulary without automatically trusting a
failed Runner result.

PR4 further hides the replacement Worktree session path behind a Task-owned
opaque `preparationId`. The preparation is bound to Task identity/version and
predecessor lineage. Execution rejects stale or drifted preparations, while an
explicit discard can still clean a stale preparation when Task ownership is
provable.

The simplification is therefore vocabulary/orchestration cleanup, not a weaker
retry policy.

## Question 4: Are crash boundaries solved well enough to build Task Manager?

No. They are improved, but deliberately incomplete.

The Embedded Host provides useful single-process safety:

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
prototype behavior. It is not a production Task Manager recovery design.

## Question 5: Should SQLite / daemon / MCP start immediately after PR4?

Not automatically.

The migration achieved its immediate goals:

- one Task-domain implementation;
- durable Candidate/apply identity;
- explicit Invocation/workspace lineage;
- a task-aware execution facade;
- less Skill orchestration leakage; and
- preservation of the existing Runner/Worktree safety path.

Before starting Task Manager implementation, the next architecture step should
be a separate design decision for durable operation semantics. In particular,
settle the transaction boundary between authoritative metadata and external
side effects before choosing SQLite tables or MCP methods.

A sensible next design document should specify at least:

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

The MCP design should also explicitly replace the temporary terminal blocking
shim with a native long-lived Task invocation/progress contract. That replacement
is an adapter/API concern; the wait-budget constants should not migrate into the
durable Task model.

Only after those are explicit should SQLite schema, daemon APIs, or MCP Tasks
integration be implemented.

## Residual debt after PR4

The following are acceptable residuals, not blockers for completing the Task
Core milestone:

- `EmbeddedTaskHost.retry(..., "successor")` still contains the older one-call
  successor strategy for non-Skill callers, while the Skill uses the safer
  prepare/approve/run bridge;
- full Task state intentionally contains Worktree session paths because the Host
  needs durable lineage references;
- low-level Runner and Worktree CLIs remain supported for compatibility and
  diagnosis;
- `workspace.cwd` remains visible to the Skill for disclosure/context/checks;
- Codex still needs explicit long terminal-tool wait budgets to simulate a
  blocking Task call until an MCP Task tool replaces that adapter behavior;
- the Embedded Host duplicates a small amount of Runner-result persistence logic
  in the prepared-restart bridge; and
- stale locks still require manual diagnosis rather than reconciliation.

These should be reconsidered when designing the durable Task Manager, not folded
back into pure Task Core.

## Milestone conclusion

The Task Core milestone is successful enough to stop incremental migration work.
The architecture now has a clearer separation:

```text
Skill policy + temporary Codex terminal blocking shim
    -> task-aware CLI / Embedded Host
        -> Task Core domain semantics
        -> Runner + Worktree mechanical truth
```

The next phase, if pursued, should begin as a new Task Manager durability design
rather than another PR that expands Task Core or teaches the Skill more
mechanical detail.
