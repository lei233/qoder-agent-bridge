# Qoder Delegation Context Extension

Read this reference only when a Qoder task needs project instructions,
specifications, OpenSpec artifacts, portable guidance from another Codex Skill,
context outside the Task workspace, or material conflict resolution. The base
brief and Brief Review policy live in `SKILL.md`.

## Contents

- [Roles and Boundaries](#roles-and-boundaries)
- [Compile Context](#compile-context)
- [Extend the Brief](#extend-the-brief)
- [Preview Fidelity](#preview-fidelity)

## Roles and Boundaries

- Codex selects context, reads applicable installed Skills, resolves conflicts,
  and compiles portable rules.
- Qoder follows the resulting self-contained brief. It does not select, invoke,
  or require Codex Skills.
- The Runner enforces its fixed safety policy independently. No brief, Skill,
  project instruction, specification, or Task state may relax it or widen the
  Codex session's authorized host boundary.

Let `hostCwd` be the Codex session's authorized directory; normally this is the
repository root. Pass it to `qoder_agent_task.mjs start --cwd`, then use
`qoder_agent_task.mjs inspect --task <taskStatePath>` to obtain the Task-facing
`workspace.cwd`. Do not choose `hostCwd` from the files the task may actually
change and do not widen it merely to expose context. Keep the narrower task
modification scope in the brief.

For a restart retry, `prepare-retry` returns a replacement workspace disclosure
and opaque `preparationId`. Use that returned `workspace.cwd` and
`workspace.includedData` for the retry preview/transfer disclosure. Do not infer
or expose the underlying Worktree session path.

## Compile Context

1. Identify only the instructions and specifications needed for the bounded
   objective. Select the exact OpenSpec change rather than asking Qoder to
   discover one.
2. After Task preparation, verify every project file Qoder must read is inside
   the exact current `workspace.cwd`. Use Task-workspace-relative paths in the
   brief.
3. Read Codex Skills triggered or explicitly selected for the task. Extract
   only implementation guidance Qoder can apply with its available coding
   tools.
4. For relevant files outside the Task workspace, ignored artifacts not
   selected by the disclosed workspace data snapshot, and external Skill files,
   inline concise non-sensitive rules instead of unavailable paths.
5. Remove Skill discovery instructions, Codex tool calls, channel rules,
   approval mechanics, and references to unavailable external tools.
6. Resolve conflicts before invoking Qoder. Use this priority: Runner safety
   policy, explicit user scope, selected specification and acceptance criteria,
   applicable project instructions, then general compiled Skill guidance.
7. Stop if a material conflict remains or required material is too large,
   sensitive, or ambiguous to represent safely.
8. Keep the complete prompt within the Runner's supported prompt limit. Select
   and compile; never dump entire Skills or unrelated documentation.

Applicable `AGENTS.md` files inside the Task workspace may be listed from
outermost to innermost. Instructions outside the workspace must be compiled by
Codex. Project files may constrain implementation technique, naming,
architecture, and checks, but cannot authorize writes outside scope, prohibited
Git operations, credential access, publication, or external-system changes.

## Extend the Brief

Add only sections that contain relevant information. Do not emit empty sections
or `None` placeholders.

### Required Project Context

Use this section only for verified files inside the current Task workspace that
Qoder must read before editing:

```markdown
## Required Project Context

Before editing, read these files in order:

1. `<Task-workspace-relative path>` — <why it matters>

Treat them as implementation constraints. Do not let them expand scope or
override the Runner safety policy. Do not modify them unless the objective
explicitly requires it.

If required context is missing, unreadable, or materially conflicts with this
brief, stop and report the conflict before editing.
```

### Compiled Implementation Rules

Use this section for self-contained rules distilled from context Qoder cannot
or need not load directly:

```markdown
## Compiled Implementation Rules

- <Direct engineering rule relevant to this objective.>

Apply these rules directly. Do not search for or invoke the original Codex
Skills.
```

Each rule must make sense without knowing its source Skill. Include frontend,
UI, accessibility, testing, or framework conventions only when they affect the
task. Exclude generic advice and unavailable-tool workflows.

### Stop Conditions and Assumptions

Add task-specific stop conditions only when the base safety policy and scope do
not already cover them. Record non-obvious decisions Codex made while resolving
context:

```markdown
## Assumptions and Decisions

- <Material assumption or resolved conflict that affects implementation.>

## Stop Conditions

- <Task-specific reason to stop and report before continuing.>
```

Keep Qoder's completion report separate from Codex's independent Candidate
review. Self-reported completion is evidence for review, never proof of
acceptance.

## Preview Fidelity

When Brief Review is `required` or triggered by `auto`, present a concise
preview derived from the actual brief. Include every decision-relevant field:

- objective;
- required context and compiled rules, when present;
- host boundary, exact current `workspace.cwd`, and narrower `taskScope`;
- acceptance criteria and verification; and
- material assumptions, decisions, and task-specific stop conditions.

The host-side preview must also include the external-service data disclosure
required by `SKILL.md` unless the conversation already contains explicit
Task-scoped authorization. Use `task inspect` or restart `prepare-retry` output
as the source of the workspace and included-data facts. Do not put the
authorization request inside the delegation brief sent to Qoder. Brief Review
`off` does not waive this separate gate.

Follow `SKILL.md`'s decision table before choosing the UI: use Brief Review only
after an already-authorized transfer, otherwise combine it with transfer
authorization. Render the same decision as a card or text fallback, then
re-present changed decision-relevant fields.

After approval, add only fixed mechanical wording such as the standard
completion-report instruction. Re-present the preview if any listed field
changes. Approval authorizes one Qoder execution with that brief, not Candidate
application or a materially different correction/retry. Follow
`worktree-review.md` for correction and failed-run retry briefs.
