---
name: qoder-worker
description: Compatibility entry point for delegating bounded coding tasks to a locally installed Qoder CLI through the co-installed qoder-agent workflow. Use when Codex should invoke Qoder as an external coding worker, compile relevant project context and installed Skill rules into a self-contained task brief, and retain responsibility for task isolation, immutable Candidate review, safe application, and acceptance.
---

# Qoder Worker

Use this compatibility entry point when a task calls Qoder a worker. It routes
through the co-installed `qoder-agent`; it is not a native Codex subagent.

Install `qoder-agent` beside this Skill and make `qodercli` available on `PATH`
or through an absolute `QODERCLI_PATH`. The `qoder-agent` Skill is the sole
authoritative workflow; its task-aware CLI is the normal execution and review
surface.

Before acting, read `qoder-agent/SKILL.md` completely and follow it as the
authoritative workflow. In particular:

- obtain its explicit external-service data authorization even when Brief
  Review is `off`;
- use its Task-owned isolated worktree and context-compilation references when
  triggered;
- invoke its task-aware commands with narrowly scoped host approval;
- preserve its explicit failed-Runner retry policy rather than retrying
  automatically; and
- independently review the immutable Candidate and obtain separate approval
  before apply or Task discard.

Do not duplicate or weaken `qoder-agent` rules, invoke its low-level Runner or
Worktree compatibility commands to bypass Task state, tell Qoder to invoke
Codex Skills, or assume those Skills are installed in Qoder.
