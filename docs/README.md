# Qoder Agent and Worker Skills

Codex remains the planning, review, retry-policy, and acceptance authority;
Qoder receives one bounded task brief inside an isolated Task workspace.
`qoder-worker` is a compatibility entry point that delegates through
`qoder-agent`; it is not a native Codex subagent.

## Operating contract

- Use `qoder_agent_task.mjs` for the normal code-changing lifecycle:
  `start -> inspect -> run -> candidate -> repair/retry -> apply/discard`.
- Keep the host boundary inherited from the Codex session. Declare a narrower
  task modification scope in the brief; never widen the host boundary merely to
  expose more context.
- Use the Task-facing `workspace.cwd` and `workspace.includedData` disclosure for
  context selection and external-data approval. Do not depend on Worktree
  session paths or phases.
- Write generated or multiline briefs with a non-shell file-writing tool. Never
  interpolate them into a shell command; inline `--prompt` is compatibility
  only.
- Keep prompts free of tokens, passwords, API keys, and other credentials.
- Treat Task/Runner JSON as execution evidence, not as a replacement for
  independently reviewing the immutable Candidate patch and tests.
- Task-managed Runner Invocations use one uniform safety ceiling. The Task CLI
  has no long-task or manual-timeout mode. If the user explicitly classifies an
  Invocation as long running, only Codex's pre-MCP terminal blocking-wait budget
  changes; the Task CLI command and Runner ceiling do not.
- Stop on Runner failure. Never retry automatically. Continue partial work only
  when Skill policy accepts it and `retryEligibility.current` allows the
  mechanical path; otherwise use an explicitly prepared restart workspace.
- Apply only the exact reviewed Candidate ID after separate user approval.
- `run_qoder.mjs`, `qoder_worktree.mjs`, and full `task get` remain low-level
  compatibility/diagnostic surfaces and must not bypass Task locking or
  fail-closed results.

## Installation

Copy both Skill directories to either:

- `<project>/.codex/skills/qoder-agent/` for project-local use;
- `<project>/.codex/skills/qoder-worker/` for the worker-style alias; or
- `~/.codex/skills/qoder-agent/` and `qoder-worker/` for personal use.

`qoder-agent` contains `SKILL.md`, `agents/openai.yaml`, Task workflow
references, and generated standalone executables under `scripts/`. Their
TypeScript sources live in `packages/core` and `packages/cli`; regenerate the
`.mjs` artifacts with `pnpm skill:build` instead of editing them directly.

## Verification evidence

The deterministic suite covers Runner construction/safety, Worktree isolation,
Task state transitions, immutable Candidate/Invocation artifacts, fail-closed
locking, retry strategies, and Skill-facing Task surface behavior. A real Qoder
run remains opt-in and should use a disposable repository followed by
independent source diff/status checks.

## Task Core checkpoint

After the four-step migration, read
[`task-core-migration-evaluation.md`](task-core-migration-evaluation.md) before
starting any SQLite, daemon, or MCP Task Manager implementation. The checkpoint
records what orchestration leakage was removed, how Candidate/apply identity
improved, what durability gaps remain, and why Task Manager requires a separate
operation-semantics design rather than further expansion of pure Task Core.
