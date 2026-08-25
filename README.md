# Qoder Agent Bridge

[简体中文](README.zh-CN.md)

Qoder Agent Bridge is a Skill-and-CLI coding harness that lets a main agent
delegate bounded implementation work to a locally installed Qoder CLI while
keeping planning, external-data approval, independent review, retry policy, and
final acceptance with the main agent.

The normal code-changing workflow is Task-aware. The Skill no longer has to
reconstruct execution from separate Runner and Worktree commands:

```text
plan / authorize
      ↓
start → inspect → run → candidate
                   ↓
            independent review
              ↙           ↘
          repair/retry     approve
              ↓              ↓
          candidate        apply
                             or
                           discard
```

## What the Task layer adds

- A permanent pure Task Core for Invocation, Candidate, workspace-lineage, and
  terminal-outcome semantics.
- A file-backed Embedded Task Host with exclusive fail-closed mutation locking.
- Immutable per-Invocation result artifacts and per-Candidate patch artifacts.
- Candidate identity that binds the reviewed patch to the later apply request.
- Explicit failed-run retry policy: continue trustworthy partial work or restart
  in an approved replacement workspace.
- A Task-facing Skill surface that hides Worktree session paths, reopen/retry-of
  mechanics, Runner process details, and manual timeout/polling plumbing.

The existing one-shot Runner and Worktree Core are still the mechanical safety
implementations. They are wrapped and reused rather than replaced.

## Safety and approval model

Codex remains the planner, context compiler, reviewer, retry-policy authority,
and acceptance owner. Qoder is a bounded executor.

- Qoder runs only in an isolated Task workspace for code-changing Git tasks,
  never directly in the source worktree.
- External-data transfer to Qoder requires explicit task-scoped authorization.
- Repository instructions and project files cannot widen the fixed Runner
  safety policy or authorize credentials, publication, or writes outside the
  Task workspace.
- Qoder's completion report is evidence, not acceptance. The main agent reviews
  the immutable Candidate patch and relevant checks independently.
- Applying a Candidate to the source worktree always requires separate explicit
  user approval.
- A failed Invocation never retries automatically. The Skill decides whether
  partial work is trustworthy enough to continue; a clean restart uses a
  separately prepared and approved replacement workspace.
- Ambiguous external side effects fail closed. A preserved Task lock means stop
  and diagnose rather than replay the operation.

## Requirements

- Node.js `>=22.18.0`
- pnpm `9.15.4` or a compatible pnpm 9 release
- A locally installed and authenticated Qoder CLI

Make `qodercli` available on `PATH`, or configure its absolute path through
`QODERCLI_PATH`. On Windows, use the native `qodercli.exe`; shell command shims
are rejected by the Runner safety boundary.

## Install the Skills

For a project-local installation:

```sh
mkdir -p /path/to/project/.codex/skills
cp -R skill/qoder-agent /path/to/project/.codex/skills/qoder-agent
cp -R skill/qoder-worker /path/to/project/.codex/skills/qoder-worker
```

For personal use, copy both directories to `~/.codex/skills/` or the configured
Codex skills directory. `qoder-worker` is a compatibility alias that delegates
to the co-installed `qoder-agent` workflow.

## Task-aware CLI

The Skill normally drives the generated standalone executable
`skill/qoder-agent/scripts/qoder_agent_task.mjs`.

Start an isolated Task from the authorized host directory:

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs start \
  --cwd /absolute/authorized/project
```

Record the returned `taskStatePath`, then obtain the Task-facing workspace
disclosure:

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs inspect \
  --task /absolute/path/to/task.json
```

The normal Skill surface uses `workspace.cwd`, `workspace.changedFiles`,
`workspace.includedData`, and `retryEligibility`; it does not require callers to
carry Worktree session paths or phases.

Run one approved bounded delegation brief:

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs run \
  --task /absolute/path/to/task.json \
  --prompt-file /absolute/path/to/delegation-brief.md
```

When the user explicitly identifies that Invocation as long running, add
`--long-task`; the Task CLI owns the concrete Runner timeout mapping.

After a successful Invocation, freeze an immutable Candidate:

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs candidate \
  --task /absolute/path/to/task.json
```

After independent review and separate approval, apply the exact Candidate ID:

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs apply \
  --task /absolute/path/to/task.json \
  --candidate <candidate-id>
```

Review correction and failed-run retry rules live in
[skill/qoder-agent/references/worktree-review.md](skill/qoder-agent/references/worktree-review.md).
The Task-level retry vocabulary is:

```text
--strategy continue   # continue approved trustworthy partial work
--strategy restart    # use an approved prepared replacement workspace
```

There is no Task-level `recover` command.

## Context-aware delegation

The main agent compiles a self-contained `Qoder Delegation Brief v1` from the
bounded objective, acceptance criteria, relevant project instructions,
specifications/OpenSpec material, and portable guidance from applicable Skills.
Qoder does not need Codex Skills installed and must not be asked to invoke them.

See:

- [skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md) for the authoritative
  collaboration and approval workflow;
- [delegation-prompt.md](skill/qoder-agent/references/delegation-prompt.md) for
  context compilation and preview fidelity;
- [worktree-review.md](skill/qoder-agent/references/worktree-review.md) for
  Candidate review, repair/retry, apply, and discard policy; and
- [protocol.md](skill/qoder-agent/references/protocol.md) for Task-facing Runner
  evidence and the command-session waiting contract.

## Low-level compatibility

The generated `run_qoder.mjs` and `qoder_worktree.mjs` executables remain
available for compatibility and mechanical diagnosis. Full `task get` output is
also a diagnostic surface. They may expose details intentionally hidden from the
normal Skill workflow and must not be used to bypass Task locking, Candidate
identity, explicit approvals, retry policy, or a fail-closed result.

## Development checks

```sh
pnpm install
pnpm format
pnpm typecheck
pnpm test
pnpm lint
pnpm skill:build
pnpm skill:artifacts:check
pnpm skill:check
pnpm build
pnpm format:check
```

The maintained implementation is TypeScript under `packages/core` and
`packages/cli`. `pnpm skill:build` regenerates the committed standalone Skill
executables under `skill/qoder-agent/scripts/`; do not edit those generated
`.mjs` files directly.

## Architecture checkpoint

PR1–PR4 intentionally stop after establishing Task Core, the Embedded Host,
the Task-aware Skill migration, and a reduced Task-facing Skill surface.

Before implementing a SQLite Task Manager, daemon, or MCP interface, read
[docs/task-core-migration-evaluation.md](docs/task-core-migration-evaluation.md).
The next architecture problem is durable operation semantics—idempotency,
expected versions, execution fencing, durable Runner completion, operation
journaling, and crash reconciliation—not another expansion of pure Task Core.

## License

MIT. See [LICENSE](LICENSE).
