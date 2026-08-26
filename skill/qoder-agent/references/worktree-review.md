# Task-Aware Isolated Qoder Review

Use the task-aware coordinator for every code-changing Qoder task. The Task Host
owns isolated workspace mechanics; this reference owns only Skill policy for
review, correction, retry choice, approval, and acceptance.

## Lifecycle

1. Record source `git status` and relevant diffs without altering the source.
2. Start the Task:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs start \
     --cwd <authorized-host-cwd>
   ```

   Record `taskStatePath`.

3. Inspect the Task-facing workspace:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs inspect \
     --task <taskStatePath>
   ```

   Use `workspace.cwd`, `workspace.changedFiles`, `workspace.includedData`, and
   `retryEligibility`. Do not depend on Worktree session paths, phases, index
   flags, or retry-of links.

4. Review `workspace.includedData` before external transfer. A repository
   `.qoderinclude` may select ignored local inputs for checks; project
   configuration is not authorization. Stop on credentials, secrets, unrelated
   data, unsafe links, or excessive scope.
5. Compile the delegation brief against `workspace.cwd`, preserve the narrower
   `taskScope`, apply Brief Review when required, and obtain external-data
   authorization.
6. Run the initial Invocation:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs run \
     --task <taskStatePath> \
     --prompt-file <absolute-brief-path>
   ```

   Keep the Task CLI command unchanged for an explicitly long-running
   Invocation; only the Codex host-tool wait policy changes under `protocol.md`.
   Wait for the final Task JSON there.

7. After a successful Invocation, freeze the review result:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs candidate \
     --task <taskStatePath>
   ```

   Record the Candidate ID, immutable patch path/hash, and changed files.

8. Independently inspect the immutable Candidate patch and run relevant checks
   in `workspace.cwd`. Treat files outside `taskScope` as out of scope even when
   they are inside the Task workspace.
9. If the Candidate passes, present the evidence and wait for explicit user
   approval. Apply only the reviewed Candidate ID:

   ```sh
   node /path/to/qoder-agent/scripts/qoder_agent_task.mjs apply \
     --task <taskStatePath> \
     --candidate <candidate-id>
   ```

10. If the user explicitly discards the task, run:

    ```sh
    node /path/to/qoder-agent/scripts/qoder_agent_task.mjs discard \
      --task <taskStatePath>
    ```

Task locking, Candidate identity verification, source apply preflight, workspace
cleanup, and ambiguous-side-effect handling are Host-owned mechanics. If the
Task CLI preserves a stale lock or reports an unknown result, stop rather than
replaying the operation.

## Review Corrections

The original explicit data-transfer authorization covers at most two automatic
same-scope correction runs after a successful Invocation when independent
review finds only concrete, verifiable defects and all authorized data/scope
facts remain unchanged.

Prepare a distinct complete correction brief that reissues the original task
plus review findings. Preserve objective, required context, compiled rules,
`taskScope`, acceptance criteria, verification, assumptions, and stop
conditions. Never send a findings-only brief or rely on prior Qoder session
memory.

Run:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs repair \
  --task <taskStatePath> \
  --prompt-file <absolute-correction-brief>
```

The Host owns Candidate invalidation and reuse of the existing workspace. After
a successful correction, run `candidate` again and review the replacement
Candidate. Historical Candidate records remain immutable.

Reapply Brief Review when required. Stop without correction when a finding
requires a material user decision, scope expansion, new data category, or a
third correction run. A Runner failure during correction follows the failed-run
policy below. Final Candidate application always requires explicit approval.

## Failed-Runner Retry

A failed Invocation does not close the Task and does not authorize another
Qoder invocation. Inspect again:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs inspect \
  --task <taskStatePath>
```

Before any retry:

- explain every partial change in `workspace.changedFiles` and confirm it is in
  `taskScope`;
- confirm the original task, context, acceptance criteria, and host boundary
  still apply;
- require no preserved stale lock or other ambiguous mechanical result; and
- obtain explicit retry-plus-transfer approval.

Task Core does not decide whether failed partial work is trustworthy. Codex must
choose one of the two policies below. No retry is automatic.

### Continue trustworthy partial work

Use this only when `retryEligibility.current === true` **and** Codex has
independently determined that the partial work is safe and useful to continue.
`retryEligibility` is a mechanical gate, not an acceptance decision.

Resolve external prerequisites first and prepare a distinct complete retry
brief. State that Qoder should continue from the existing partial work, inspect
it before editing, complete the bounded task, run relevant checks, and avoid
prohibited Git operations.

After retry-plus-transfer approval:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs retry \
  --task <taskStatePath> \
  --strategy continue \
  --prompt-file <absolute-retry-brief>
```

Stop if the same hard failure repeats. For the exact retryable
`model_queue_exhausted` Runner error, allow at most one continue retry. Do not
broaden permissions or infer safety merely from `retryable: true`.

### Restart in a replacement workspace

Use restart only when Codex explicitly chooses a clean restart or determines
that failed partial work should not be continued.

Prepare locally first:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs prepare-retry \
  --task <taskStatePath>
```

This does not invoke Qoder or mutate Task Invocation/workspace history. It
returns:

- an opaque `preparationId`;
- the replacement `workspace.cwd`;
- `workspace.includedData`; and
- the Task version used for preparation.

Use that exact Task-facing disclosure for Brief Review and retry-plus-transfer
approval. Do not infer or expose the underlying Worktree session path.

If approved, run:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs retry \
  --task <taskStatePath> \
  --strategy restart \
  --preparation <preparationId> \
  --prompt-file <absolute-retry-brief>
```

The Host rejects stale preparation IDs, Task-version changes, predecessor
changes, or replacement-workspace drift before Runner execution.

If the user cancels or does not authorize transfer, dispose the unattached
preparation without closing the Task:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs discard-retry \
  --task <taskStatePath> \
  --preparation <preparationId>
```

A stale preparation is still explicitly cleanable when Task ownership can be
proven. If cleanup itself is mechanically ambiguous, the Host preserves the
Task lock and the Skill stops for diagnosis.

After any successful retry, continue through `candidate`, independent checks,
review, and explicit Candidate application. The Task-level concept is always
`retry`; never introduce or invoke `recover`.

## Terminal Failure

A failed Invocation alone is not a terminal failed Task because policy may still
permit an explicit retry. Use:

```sh
node /path/to/qoder-agent/scripts/qoder_agent_task.mjs fail \
  --task <taskStatePath>
```

only after Codex intentionally concludes that no retry or Candidate path
remains. Report incomplete cleanup separately from the terminal Task outcome.

## Stop Conditions

Stop rather than bypassing a condition when:

- Task start rejects the source repository state;
- included local data contains credentials, secrets, unrelated content, unsafe
  links, or excessive scope;
- Task inspection or retry preparation reports a blocker that cannot be safely
  resolved;
- Runner/Qoder completion cannot be established from final Task evidence;
- failed partial changes cannot be fully explained inside `taskScope`;
- a retry preparation is stale or its disclosed workspace drifted;
- Candidate generation cannot establish immutable Candidate identity;
- Candidate application reports identity/preflight failure;
- source application may have occurred but the Task outcome is mechanically
  ambiguous; or
- a stale Task lock is preserved for diagnosis.

If apply returns Task outcome `applied` with `cleanupIncomplete: true`, treat the
source change and Task outcome as successful facts and cleanup as separately
incomplete. Never replay apply.

## Low-Level Compatibility

`run_qoder.mjs`, `qoder_worktree.mjs`, and full `task get` remain diagnostic
surfaces. The normal Skill workflow must not depend on their Worktree paths,
phases, index state, process details, timeout controls, or legacy recovery
vocabulary. Never use a low-level command to bypass Task policy or a fail-closed
result.
