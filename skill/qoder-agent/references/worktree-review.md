# Task-Aware Isolated Qoder Review

Use the task-aware coordinator for every code-changing Qoder task in a Git
worktree. The Task Host wraps the existing isolated Worktree and one-shot Runner
mechanics; it does not change the Skill's review, approval, or retry policy.

## Lifecycle

1. Record source `git status` and relevant diffs without altering the source.
2. Run:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs start \
     --cwd <host-cwd>
   ```

   where `<host-cwd>` is the Codex session's authorized directory, normally the
   repository root. Record the returned `taskStatePath`.

3. Inspect the active WorktreeSession before any external transfer:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs inspect \
     --task <taskStatePath>
   ```

   It returns the active WorktreeSession phase, `statePath`, `worktreeRoot`,
   exact `qoderCwd`, changed files, index status, and
   `includedIgnoredArtifacts`. The initial state must be `prepared`, with no
   Qoder changes and no index modification.

4. A repository-root `.qoderinclude` can select locally available ignored files
   as optional copied, unstaged check inputs. Missing matches are allowed. The
   underlying Worktree v2 session validates its manifest digest and excludes
   selected paths from Candidate patches. Inspect the returned manifest
   information and explicitly disclose selected path categories, file count,
   and bytes before Qoder receives them; configuration is not transfer
   authorization.
5. Compile the delegation brief against the exact current `qoderCwd`, keep the
   narrower `taskScope` separate, apply Brief Review when required, and obtain
   external-data authorization before invoking Runner.
6. Run the initial Invocation:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs run \
     --task <taskStatePath> \
     --prompt-file <absolute-brief-path>
   ```

   Wait for the command's final JSON result under `protocol.md`. A failed Runner
   leaves the Task open and follows [Failed-Runner Retry](#failed-runner-retry).

7. After a successful Invocation, freeze the exact review result:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs candidate \
     --task <taskStatePath>
   ```

   This advances the underlying Worktree review state and creates a Task-owned,
   immutable Candidate patch. Record its `candidate.id`, `patchPath`,
   `patchSha256`, `baselineTree`, and `changedFiles`.

8. Independently inspect the immutable Candidate patch and run relevant checks
   in the active `qoderCwd`. Treat changes outside the brief's narrower
   `taskScope` as out-of-scope even when they are inside `qoderCwd`. Candidate
   identity is authoritative for the eventual apply: do not substitute a later
   mutable worktree diff or another patch with similar content.
9. If the Candidate passes, present the evidence and wait for explicit user
   approval. Apply only the reviewed Candidate ID:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs apply \
     --task <taskStatePath> \
     --candidate <candidate-id>
   ```

   The Host verifies the Task's active Candidate identity, immutable Candidate
   SHA-256, and byte identity with the actual Worktree patch before the existing
   Worktree apply path runs `git apply --check --binary` and modifies the source
   without staging it.

10. If the user explicitly discards the task, run:

    ```sh
    node /path/to/qoder-agent/scripts/qoder_agent_task.mjs discard \
      --task <taskStatePath>
    ```

    The discarded terminal outcome is persisted before cleanup. If cleanup is
    incomplete, report it; never reinterpret cleanup failure as an open Task.

The underlying source may have unrelated staged or unstaged changes. Candidate
application checks only the reviewed Qoder patch and preserves the source index.
Every mutating Task command uses an exclusive fail-closed lock. If a command
preserves a stale lock because an external side effect is mechanically
ambiguous, stop and diagnose rather than replaying the operation.

## Review Corrections

The original explicit data-transfer authorization covers at most two automatic
correction runs after the initial successful Runner execution when independent
review finds only concrete, verifiable, in-scope defects and the objective,
data categories, `hostCwd`, `qoderCwd`, and `taskScope` remain unchanged. Do not
ask for conversational approval solely to start such an in-scope correction.

Prepare a distinct complete correction brief that reissues the original task
plus review findings. Preserve the complete objective, required context,
compiled rules, `taskScope`, acceptance criteria, verification, assumptions,
and stop conditions. Direct Qoder to inspect and repair the existing
uncommitted changes; never send a findings-only brief or rely on prior session
memory.

Run:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs repair \
  --task <taskStatePath> \
  --prompt-file <absolute-correction-brief>
```

The Task Host validates that the previous Invocation succeeded and an active
Candidate exists, invalidates that active Candidate, then reuses the same
WorktreeSession and underlying review-reopen mechanics. Historical Candidate
records remain immutable. After a successful repair, run `candidate` again;
the replacement Candidate gets a new identity and is the only Candidate that
may later be applied.

Reapply Brief Review. Treat external transfer as already authorized only while
all previously authorized fields remain unchanged: `required` uses Brief Review
only, while a precise in-scope `auto` correction needs no preview. Stop without
correction when a finding requires a material user decision, scope expansion,
or a third correction run. Runner failure during correction follows the normal
failure rules below, not the automatic correction allowance. Final Candidate
application always requires explicit user approval.

## Failed-Runner Retry

A failed Runner does not close the Task and does not authorize another Qoder
invocation. Wait until Runner and Qoder have ended, then inspect through the
Task surface:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs inspect \
  --task <taskStatePath>
```

Continue only when:

- `phase === "prepared"`;
- `indexModified === false`;
- every partial edit is explainable and inside `taskScope`;
- the original task, baseline, required context, and acceptance criteria still
  apply; and
- no preserved stale Task lock or other ambiguous mechanical state exists.

Task Core does not decide whether partial work is trustworthy. Codex must choose
one of the following strategies under the existing policy. No retry is automatic.

### Retry the current WorktreeSession

Use this only when the failed partial work is trustworthy enough to continue.
Obtain explicit retry-plus-transfer approval, restating that the same
Task-required private/project content under the same exact `qoderCwd` will be
sent to Qoder. Resolve external prerequisites first and use a distinct complete
retry brief. Change only the objective to make continuation explicit, for
example:

```text
Continue the interrupted bounded task from the existing uncommitted changes in
this worktree. Inspect the current diff before editing and do not restart from
scratch.

Repair incomplete or invalid edits, complete the task, and run the relevant
checks. Do not commit, stage, stash, reset, clean, or modify Git worktree
configuration.
```

Then run:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs retry \
  --task <taskStatePath> \
  --worktree current \
  --prompt-file <absolute-retry-brief>
```

A current retry reuses the active WorktreeSession and preserves its partial
work. Stop if the same hard failure repeats. For the exact retryable
`model_queue_exhausted` Runner code, allow at most one current retry. Do not
broaden permissions or retry automatically.

### Retry on a successor WorktreeSession

Use a successor only for an explicitly chosen clean restart or when the failed
partial work cannot be safely continued. Preparation is deliberately separate
from Runner execution so the Skill can disclose the actual new mechanical
boundary before external transfer.

First prepare the successor locally:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs prepare-retry \
  --task <taskStatePath>
```

This does **not** mutate Task lineage or invoke Qoder. It returns
`preparedStatePath`, exact successor `qoderCwd`, `worktreeRoot`, and
`includedIgnoredArtifacts`, bound to the current `taskId`, `task.version`, and
predecessor WorktreeSession. Inspect the returned data scope and obtain explicit
retry-plus-transfer approval for this exact successor. Rebuild or re-present
the brief when the new `qoderCwd` or included data changes any previewed field.

If approved, run exactly that prepared successor:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs retry \
  --task <taskStatePath> \
  --worktree successor \
  --prepared-state <preparedStatePath> \
  --prompt-file <absolute-retry-brief>
```

The Host rejects the preparation if Task version or active predecessor changed,
or if the prepared Worktree drifted before the run. Only the successful Task
transition attaches the successor WorktreeSession and creates the retry
Invocation.

If the user cancels or does not authorize external transfer, dispose only the
unattached prepared successor without closing the Task:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs discard-retry \
  --task <taskStatePath> \
  --prepared-state <preparedStatePath>
```

Do not silently leave prepared successor sessions behind. If preparation
cleanup itself fails or Task state changed so ownership cannot be proven, stop
for diagnosis.

After any successful retry, continue through `candidate`, independent checks,
review, and explicit Candidate application. The Task-level concept is always
`retry`; do not introduce or invoke a Task-level `recover` command.

## Terminal Failure

A failed Invocation alone is not a terminal failed Task because review policy
may still permit an explicit retry. Use `fail --task <taskStatePath>` only when
Codex has intentionally concluded that the Task is terminally failed and no
active Invocation or Candidate remains. Report retained Worktree resources
separately; terminal outcome and resource cleanup are different facts.

## Stop Conditions

Stop rather than bypassing a condition when:

- the source is not a Git worktree, has no `HEAD` commit, or has unmerged paths;
- `.qoderinclude` selects credentials, secrets, unrelated content, unsafe
  links, or excessive scope;
- a Task inspection reports an unexpected Worktree phase or index modification;
- Runner/Qoder may still be live, or a valid Task/Runner result cannot be
  established;
- a failed-Runner partial diff cannot be fully explained inside `taskScope`;
- a prepared successor no longer matches the Task version or predecessor;
- Candidate generation reports ambiguous Worktree side effects or no immutable
  Candidate can be established;
- the immutable Candidate patch hash or byte identity no longer matches apply
  preconditions;
- source changes make the underlying `git apply --check` fail;
- source application may have happened but Task outcome persistence is
  mechanically ambiguous; or
- a stale Task lock is preserved for diagnosis.

If apply returns `outcome: "applied"` with `cleanupIncomplete: true`, the source
change and Task outcome are successful facts while cleanup is incomplete. Do
not replay apply; report and diagnose cleanup separately.

## Low-Level Compatibility

`run_qoder.mjs` and `qoder_worktree.mjs` remain available as compatibility and
diagnostic tools. The normal Skill workflow above must use Task commands so
Task locking, Invocation lineage, immutable Candidate identity, and terminal
outcomes remain authoritative. Never use low-level commands to bypass a Task
precondition, stale lock, explicit approval, or an ambiguous external side
effect.
