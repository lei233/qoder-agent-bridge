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
  mechanics, Runner process details, and manual Runner timeout plumbing.

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

## Runtime requirements

The installable Skill distribution currently targets Linux hosts and requires:

- Node.js `>=22.18.0`;
- Git; and
- a locally installed and authenticated Qoder CLI.

Make `qodercli` available on `PATH`, or configure its absolute path through
`QODERCLI_PATH`.

`pnpm`, TypeScript, the workspace packages, and this repository are build-time
requirements only. They are not required by an installed release Skill.

## Install the Skill

The supported installable artifact is the `qoder-agent-v<version>.zip` asset
attached to a GitHub Release. The ZIP contains exactly one top-level
`qoder-agent/` directory with `SKILL.md`, authored references and agent metadata,
the three standalone scripts, and `manifest.json`.

Extract that ZIP and copy the resulting directory into the desired Codex Skills
location. For a project-local installation:

```sh
mkdir -p /path/to/project/.codex/skills
unzip qoder-agent-v0.1.0.zip
cp -R qoder-agent /path/to/project/.codex/skills/qoder-agent
```

For personal use, copy `qoder-agent/` to `~/.codex/skills/` or the configured
Codex Skills directory.

Do not install from GitHub's automatically generated source ZIP/tar archives.
Those archives contain repository source, not the generated standalone Skill
distribution.

The former `qoder-worker` compatibility Skill has been removed. If an older
installation still contains `qoder-worker/`, remove that directory manually;
there is no compatibility shim in current releases.

## Build an installable Skill from source

The authored Skill source is only `skill/qoder-agent/SKILL.md`,
`skill/qoder-agent/agents/**`, and `skill/qoder-agent/references/**`. Generated
standalone scripts never live in that source tree.

From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm skill:build
pnpm skill:validate
```

The generated installable directory is `dist/skills/qoder-agent/`. To create the
same ZIP shape used for releases, run:

```sh
pnpm skill:pack
```

This writes `dist/releases/qoder-agent-v<version>.zip`. Local builds do not
require GitHub Actions.

## Task-aware CLI

Inside an installed Skill, the normal entry point is
`scripts/qoder_agent_task.mjs`. For examples below, point `QODER_AGENT_SKILL` at
the installed directory. In a source checkout after `pnpm skill:build`, use
`$PWD/dist/skills/qoder-agent`.

```sh
QODER_AGENT_SKILL=/absolute/path/to/qoder-agent
```

Start an isolated Task from the authorized host directory:

```sh
node "$QODER_AGENT_SKILL/scripts/qoder_agent_task.mjs" start \
  --cwd /absolute/authorized/project
```

Record the returned `taskStatePath`, then obtain the Task-facing workspace
disclosure:

```sh
node "$QODER_AGENT_SKILL/scripts/qoder_agent_task.mjs" inspect \
  --task /absolute/path/to/task.json
```

The normal Skill surface uses `workspace.cwd`, `workspace.changedFiles`,
`workspace.includedData`, and `retryEligibility`; it does not require callers to
carry Worktree session paths or phases.

Run one approved bounded delegation brief:

```sh
node "$QODER_AGENT_SKILL/scripts/qoder_agent_task.mjs" run \
  --task /absolute/path/to/task.json \
  --prompt-file /absolute/path/to/delegation-brief.md
```

Every Task-managed Runner Invocation is pinned to the Runner's existing one-hour
maximum safety ceiling. The Task CLI exposes neither a long-task mode nor a
manual timeout option. When a user explicitly identifies an Invocation as long
running, only Codex's terminal blocking-wait policy changes so the same Task CLI
call stays logically blocked instead of becoming a background polling workflow.
See `protocol.md` below.

After a successful Invocation, freeze an immutable Candidate:

```sh
node "$QODER_AGENT_SKILL/scripts/qoder_agent_task.mjs" candidate \
  --task /absolute/path/to/task.json
```

After independent review and separate approval, apply the exact Candidate ID:

```sh
node "$QODER_AGENT_SKILL/scripts/qoder_agent_task.mjs" apply \
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
  evidence and the pre-MCP blocking command-session waiting contract.

## Low-level compatibility

The distributed `run_qoder.mjs` and `qoder_worktree.mjs` executables remain
available for mechanical diagnosis. Full `task get` output is also a diagnostic
surface. The low-level Runner CLI may expose timeout controls that the normal
Task CLI intentionally does not. Diagnostic surfaces must not be used to bypass
Task locking, Candidate identity, explicit approvals, retry policy, or a
fail-closed result.

## Development checks

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm skill:check
pnpm skill:pack
```

The maintained implementation is TypeScript under `packages/core` and
`packages/cli`. `pnpm build` builds package outputs only. `pnpm skill:build`
assembles `dist/skills/qoder-agent/` from authored Skill files plus three
independently bundled standalone scripts. `dist/` is generated and ignored by
Git; do not commit generated Skill bundles back into `skill/qoder-agent/`.

## Release model

`package.json.version` is the sole release version authority. A formal release
is triggered only by pushing the exact `v<version>` tag, including prerelease
versions such as `v0.2.0-beta.1`. The tag must point at the clean checkout being
built. The release workflow rebuilds and validates the distribution, creates
only the installable Skill ZIP, attaches it to a draft GitHub Release, and then
publishes the release.

Repository **Release immutability must be enabled** before publishing formal
releases. The workflow verifies the published release with GitHub CLI and will
fail rather than treat a mutable release as valid. Source archives generated by
GitHub are repository snapshots and are not release artifacts for Skill
installation.

## Architecture checkpoint

Before implementing a SQLite Task Manager, daemon, or MCP interface, read
[docs/task-core-migration-evaluation.md](docs/task-core-migration-evaluation.md).
The next architecture problem is durable operation semantics—idempotency,
expected versions, execution fencing, durable Runner completion, operation
journaling, and crash reconciliation—not another expansion of pure Task Core.

## License

MIT. See [LICENSE](LICENSE).
