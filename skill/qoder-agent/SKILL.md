---
name: qoder-agent
description: Delegate bounded coding tasks to a locally installed Qoder CLI through a task-aware, isolated review workflow. Use when Codex needs Qoder to edit or test files inside an explicitly trusted Git project while Codex compiles relevant project context into a self-contained brief and retains responsibility for planning, external-data authorization, independent review, retry policy, explicit Candidate application, and acceptance.
---

# Qoder Agent

Delegate one bounded coding task through the bundled task-aware CLI. Treat Codex
as the context compiler, policy authority, and reviewer and Qoder as the bounded
executor. Qoder has no implicit access to Codex Skills or conversation context.

## Keep These Boundaries

- For code-changing Git tasks, use `scripts/qoder_agent_task.mjs` as the normal
  lifecycle surface. It owns Task state, isolated execution workspaces, Runner
  invocations, immutable Candidate identity, retry lineage, and terminal
  apply/discard outcomes.
- Qoder always runs under the existing fixed Runner safety policy. Never weaken
  permission, credential, publication, Git-history, or workspace boundaries.
- Never run Qoder directly in the source worktree. `task start` creates the
  isolated Task and `task inspect` returns the Task-facing workspace disclosure.
- Execute each Task command only with host access already authorized for the
  Codex session. Never request reusable arbitrary Node or shell access.
- Independently inspect the immutable Candidate patch and run relevant checks.
  Qoder's completion report is evidence, not acceptance.
- Apply a passing Candidate only after separate explicit user approval. Never
  automatically apply, discard a Task, retry a failed Invocation, or discard a
  prepared restart.
- Keep `scripts/run_qoder.mjs` and `scripts/qoder_worktree.mjs` only for
  compatibility and diagnosis. Do not reconstruct the normal Skill lifecycle
  from their low-level commands.

## Route to the Authoritative Reference

Load each reference completely when its condition applies.

| Condition                                                                 | Required reference                | Authoritative content                                                     |
| ------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| Any code-changing Git task                                                | `references/worktree-review.md`   | Task lifecycle, Candidate review, correction, retry policy, apply/discard |
| OpenSpec, project rules, external context, or Skill guidance              | `references/delegation-prompt.md` | Context selection, compilation, preview fidelity                          |
| Before a Task command that invokes Qoder, or when interpreting its result | `references/protocol.md`          | Task execution arguments, final evidence, failures, waiting contract      |

For code changes, `worktree-review.md` and `protocol.md` are always required;
`delegation-prompt.md` remains conditional.

## Preserve the Approval Model

Brief Review, external-data authorization, host execution approval, failed-run
retry approval, and Candidate application are distinct decisions.

For each initial or review-driven correction run, choose the required decision
before choosing its UI:

| Brief Review                 | Transfer authorized | Required decision                                     |
| ---------------------------- | ------------------- | ----------------------------------------------------- |
| `off` or no `auto` preview   | no                  | External-data authorization                           |
| `required` or `auto` preview | no                  | Combined Brief Review and external-data authorization |
| `required` or `auto` preview | yes                 | Brief Review only                                     |
| `off` or no `auto` preview   | yes                 | Continue to native host-execution approval            |

Use `request_user_input` when the host exposes it; otherwise ask the same clear,
localized question in text. Proceed only on an unambiguous choice.

The original task-scoped data authorization may cover the initial run plus at
most two same-scope review corrections. It does not cover a failed-run retry,
broader data, credentials, secrets, unrelated files, or Candidate application.

## Authorize External Data Transfer

Treat Qoder as an external service. Before the first Task command that invokes
Qoder, explicitly authorize the data that will be sent:

- the delegation brief;
- task-required private-project files inside the disclosed Task workspace; and
- listed OpenSpec, specification, or compiled project context.

`start`, `inspect`, and `prepare-retry` are local operations and send nothing to
Qoder. Use their Task-facing output to disclose:

- the objective;
- host access boundary;
- exact `workspace.cwd`;
- `workspace.includedData` categories/count/bytes when present;
- narrower `taskScope` and writable paths; and
- exclusions.

Configuration is not authorization. Stop on credentials, secrets, unrelated
content, unsafe links, or excessive scope. Reauthorize before widening the host
or workspace boundary, adding a data category, materially changing objective or
scope, or retrying a failed Invocation.

For a restart retry, `prepare-retry` first creates a local workspace and returns
an opaque `preparationId` plus its disclosure. Obtain retry-plus-transfer
approval for that exact disclosed workspace before invoking Qoder. If approval
is denied, use `discard-retry --preparation <id>`.

## Start and Inspect the Task

Before starting, inspect source `git status` and relevant diffs without
modifying or staging them. Keep expected modification paths as a narrower
`taskScope`; never use that narrower scope to widen the authorized host boundary.

Start:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs start \
  --cwd /absolute/path/to/codex-session-cwd
```

Record only `taskStatePath`. Then inspect:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs inspect \
  --task /absolute/path/to/task.json
```

Use the returned `workspace.cwd`, `workspace.changedFiles`,
`workspace.includedData`, and `retryEligibility`. Do not depend on Worktree
session paths, phases, index flags, or retry-of plumbing; those are Host-owned
mechanics.

The underlying implementation still requires a Git worktree with a `HEAD`
commit and no unmerged paths. For a non-Git or unmerged directory, obtain an
explicit alternate workflow instead of running Qoder in the source silently.

## Build the Delegation Brief

Compile every task into this base contract:

```markdown
# Qoder Delegation Brief v1

## Objective

<One bounded coding objective.>

## Change Scope

Host access boundary: <authorized host cwd>
Task workspace: <workspace.cwd returned by Task CLI>
May modify: <taskScope paths inside the Task workspace>
Must not modify: <unrelated or protected paths>

## Acceptance Criteria

- <Observable outcome.>

## Verification

- <Exact relevant check, or explain why none applies.>

## Completion Report

Report files changed, checks run and their results, and unresolved limitations.
```

Read `references/delegation-prompt.md` only when project instructions,
specifications, OpenSpec, external Skill guidance, or context outside the Task
workspace materially affects the task. Never tell Qoder to invoke a Codex Skill.

## Choose Brief Review

Use the three-state policy:

- `required`: user requests Spec mode or preview;
- `off`: user explicitly skips preview, without skipping any other approval;
- `auto`: preview broad, ambiguous, architectural, migration,
  security-sensitive, dependency/build/deployment, or otherwise material work;
  skip for precise local reversible tasks.

A preview includes objective, selected context/rules, host boundary,
`workspace.cwd`, narrower `taskScope`, acceptance criteria, verification, and
material assumptions or stop conditions. Re-present it after material changes.
Neither preview approval nor transfer authorization permits Candidate apply.

## Write and Run Safely

Write the approved or auto-accepted brief to a private temporary file outside
the Task workspace using a non-shell file-writing tool. Never use shell
interpolation, command substitution, heredocs, or credentials in generated brief
content.

For the initial Invocation:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs run \
  --task /absolute/path/to/task.json \
  --prompt-file /absolute/path/to/delegation-brief.md
```

Use `repair` for an in-scope review correction. After a failed Invocation use
only the explicit retry strategies in `worktree-review.md`:

```text
--strategy continue   # continue trustworthy partial work
--strategy restart    # run an approved prepared replacement workspace
```

Do not use a Task-level `recover` command.

If the user explicitly identifies the delegated Invocation as long running, add
`--long-task`. Do not pass manual timeout values from the Skill and do not infer
long-running status from complexity, repository size, prompt text, or elapsed
time.

Follow `protocol.md` for the command-session waiting contract and Task-facing
Runner evidence. The Task Host owns Runner process, timeout, termination, and
result-persistence mechanics.

## Complete the Review Lifecycle

1. Start the Task and inspect its Task-facing workspace disclosure.
2. Compile the brief and required context against `workspace.cwd`.
3. Apply Brief Review and external-data authorization before invoking Qoder.
4. Run the initial Invocation.
5. Freeze an immutable Candidate with `candidate`.
6. Independently inspect the Candidate patch and run relevant checks in
   `workspace.cwd`.
7. For concrete, verifiable, same-scope defects, use the bounded `repair` flow
   and review the replacement Candidate.
8. On Runner failure, stop. Inspect again and choose retry policy only under
   `worktree-review.md`; never retry automatically.
9. Present only a passing Candidate. Apply its exact Candidate ID only after
   explicit user approval.
10. If the user explicitly discards the work, close the Task through `discard`.

At handoff report Task outcome, Runner status, Candidate ID, actual changed
files, independent checks/results, unresolved limitations, and any incomplete
cleanup or preserved Task lock. If a final Task/Runner result cannot be proven,
treat execution as unknown and stop for diagnosis.

## Compatibility and Diagnosis

`run_qoder.mjs`, `qoder_worktree.mjs`, and the full `task get` representation
remain diagnostic surfaces. They may expose low-level Runner or Worktree facts
that the normal Skill workflow intentionally hides. Never use them to bypass a
Task precondition, stale lock, explicit approval, Candidate identity, or an
ambiguous external side effect.

## Install the Skill

Copy this directory to a project's `.codex/skills/qoder-agent/` or the personal
Codex skills directory. Retain `scripts/`, `references/`, and `agents/`, keep
all three bundled scripts executable, and make `qodercli` available on `PATH`
or through an absolute `QODERCLI_PATH`.
