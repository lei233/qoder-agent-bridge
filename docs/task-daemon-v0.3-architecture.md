# V0.3 Lazy Task Daemon Architecture

Status: **Normative design gate for PR 1–9**

Target branch: `next`

## 1. Objective

V0.3 moves Task lifecycle ownership out of a single CLI/Agent session into a per-user daemon while keeping Task Core as a pure domain package.

The durable boundary is:

```text
Task state + Request/Operation history
→ survive CLI/daemon restart

active Runner execution
→ does NOT survive daemon death

daemon/client lifecycle
→ must not corrupt committed Task state
→ must not silently replay ambiguous persistent external effects
```

The product path is:

```text
Skill
  ↓
qoder_agent_task CLI
  ↓
DaemonConnector
  ↓
packages/daemon
  ├─ TaskApplication
  ├─ SQLite persistence
  ├─ Request / Operation journal
  ├─ reconciliation
  ├─ Runner ownership
  ├─ HTTP/JSON over UDS
  ├─ singleton/bootstrap
  └─ shutdown API
  ↓
Task Core / Runner / Worktree
```

Dependency direction is `core ← daemon ← cli`. Task Core MUST NOT depend on daemon code, and daemon MUST NOT depend on CLI business implementation.

## 2. Explicit non-goals

V0.3 MUST NOT add:

- durable active Runner execution;
- durable `executions` entity;
- Execution Worker recovery/adoption;
- manager epochs or execution fencing;
- durable mutation queues;
- daemon-global Runner scheduling;
- operation cancellation;
- automatic replay of ambiguous external effects;
- force/ignore ambiguity resolution;
- automatic ProjectSafetyIncident clearing;
- V0.2 Task migration;
- automatic project relocation;
- automatic GC of Request/Operation/artifact/resource history;
- systemd/launchd/Windows-service integration;
- cgroup containment;
- 3-hour idle shutdown.

## 3. Application boundary

All Task business paths MUST go through a transport-independent `TaskApplication`.

```ts
interface TaskApplication {
  submit(command: MutationCommand): Promise<OperationReceipt>;
  getOperation(operationId: string): Promise<OperationView>;
  waitOperation(operationId: string, options?: WaitOptions): Promise<OperationView>;
  getTask(taskId: string): Promise<TaskView>;
  inspectTask(taskId: string): Promise<TaskInspection>;
}
```

Typed methods such as `run`, `repair`, or `apply` are façades over `submit()` and MUST NOT become independent orchestration implementations.

Queries do not create Operations. Every mutation enters the durable Operation boundary.

PR 1 may use an in-process Application implementation. Product runtime after PR 7 is only `CLI → daemon`; embedded execution is not a runtime fallback.

## 4. Request and Operation model

### 4.1 Request

A Request is the logical transport/idempotency identity.

```text
Request
  ├─ rejected
  └─ accepted → Operation
```

`requestId` reuse rules are permanent:

```text
same requestId + same canonical semantic hash
→ return the first stored outcome forever

same requestId + different canonical semantic hash
→ request_id_conflict
```

All semantically parsed mutation Requests, whether accepted or deterministically rejected, are persisted.

The semantic hash MUST be transport independent. It contains only values that change business meaning, for example:

```text
kind
taskId
expectedTaskVersion
semantic arguments
```

It MUST NOT include JSON field order, wait timeout, client metadata, retry timing, or connection identifiers.

Acceptance order is normative:

```text
canonicalize/hash
→ lookup requestId
→ existing same hash: return stored outcome
→ existing different hash: request_id_conflict
→ new request: validate current durable state
```

For an accepted mutation, one SQLite transaction MUST atomically:

1. persist Request;
2. create Operation;
3. acquire all required logical authority.

Returning `OperationReceipt` means durable acceptance is complete.

Deterministic rejection before acceptance MUST NOT create an Operation.

### 4.2 Operation lifecycle

Public states:

```text
accepted
running
blocked
succeeded
failed
abandoned
```

Terminal states are `succeeded | failed | abandoned`.

`blocked` is non-terminal but `waitOperation()` may return it.

Hard recovery invariant:

```text
accepted
→ external effect has definitely not started
```

Before an Operation crosses an external-effect boundary, one transaction MUST persist:

```text
kind-specific effect intent
+ deterministic recovery metadata
+ status = running
```

Only after that transaction commits may the external effect begin.

`running` means the daemon cannot decide replay safety from database state alone; restart requires reconciliation.

`failed` is legal only when the Operation definitely failed and no unresolved external-effect ambiguity remains. Otherwise the Operation MUST be `blocked`.

For terminal Operations, `status`, `result/error`, and `completedAt` are immutable. Reconciliation MUST NOT rewrite a terminal history entry.

Pure DB/domain mutations may complete in one transaction:

```text
accepted
→ Task transition + Operation terminal
```

Business retry after a definite failure uses a new Request/Operation. Transport resend reuses the original `requestId`.

## 5. Mutation authority

At most one non-terminal mutation Operation (`accepted | running | blocked`) may own Task mutation authority for a Task.

This invariant MUST be enforced by SQLite constraints, not only application checks. `tasks.active_operation_id` or any equivalent second authoritative copy is forbidden.

Shared-project mutations additionally require per-project shared-mutation authority. `apply` is shared-project scope.

For a shared-project mutation, acceptance MUST atomically acquire:

```text
per-task authority
+ per-project shared-mutation authority
```

Failure to acquire either is a deterministic rejection and MUST NOT create an accepted Operation. V0.3 does not queue accepted Operations waiting for a project lock.

Different Tasks may run Runner invocations concurrently.

## 6. Task version

`task.version` means committed Task Core domain state only. It increments only on domain transitions.

It MUST NOT increment for Operation status, Runner runtime state, runtime safety metadata, ProjectSafetyIncident lifecycle, or daemon lifecycle.

Expected-version matrix:

| Operation | expectedTaskVersion |
| --- | --- |
| `start` | N/A |
| `run` | optional |
| `repair` | optional |
| `retry continue` | optional |
| `candidate` | required |
| `apply` | required |
| `discard` | required |
| `fail` | required |
| `prepare-retry` | required |
| `retry restart` | required + preparation validation |
| `discard-retry` | required |

## 7. Task and project identity

Canonical managed Task identity is `taskId`.

V0.3 managed Task mutation/query CLI input accepts only `taskId`. `taskStatePath` may remain in the `start` response temporarily as compatibility information but is not accepted as managed identity.

V0.2 Tasks are inspect-only. Continuing work on a legacy Task requires a new V0.3 `start`.

Task registry state is separate from Task Core lifecycle. Registry states are:

```text
provisioning
managed
legacy_readonly
creation_failed
retired
```

`start` is itself a durable Operation. Acceptance preallocates the stable `taskId` and atomically establishes:

```text
Request
Operation(kind=start)
taskId reservation
Task registry(status=provisioning)
project binding
```

A failed `start` never reuses its `taskId`; the registry becomes `creation_failed`/tombstoned.

Each managed Task stores immutable:

```text
project_id
canonical_project_root
```

`project_id` is daemon-assigned stable identity. `canonical_project_root` is the realpath filesystem binding. Caller project context may validate a match but cannot overwrite the persisted binding.

## 8. ProjectSafetyIncident

Shared-project ambiguity has durable project-level consequences.

An ambiguous shared-project Operation creates a stable incident:

```text
incident_id
project_id
source_operation_id
kind
status = open | resolved
evidence metadata/ref
```

Project shared-mutation safety is derived exclusively from:

```text
active shared mutation Operation
→ busy

open ProjectSafetyIncident
→ blocked

neither
→ safe
```

No second authoritative `projects.blocked` flag is allowed.

An Incident can only transition `open → resolved`, and only with evidence re-observed by the daemon.

Resolving an Incident while its source Operation is still blocked uses one transaction to:

1. mark Incident resolved;
2. finalize original Operation to succeeded or failed;
3. apply any required Task domain transition;
4. release Task authority;
5. release project authority.

Abandoning a blocked shared mutation makes the original Operation `abandoned` and Task registry `retired`, but the Incident remains open. Later evidence-backed Incident resolution does not rewrite the abandoned Operation or retired Task.

## 9. Recovery UX

A blocked Operation continues to own Task mutation authority.

V0.3 exposes minimal recovery actions:

- inspect blocked Operation/evidence;
- `resolve(operationId)` — daemon re-observes external state and either succeeds, fails, or remains blocked;
- `abandon(operationId)` — `blocked → abandoned`, Task becomes retired/read-only;
- inspect ProjectSafetyIncident;
- request evidence-backed Incident resolve.

Resolve and abandon are recovery actions on the original durable object; they do not create new Operations.

Caller-supplied arbitrary “proof” and `--force` are forbidden.

## 10. Runner durability and ownership

Runner execution is daemon-lifetime scoped.

```text
daemon alive
→ owns Runner execution

daemon exit/crash
→ owned Runner process tree must terminate

restart
→ stale running Runner Operation
→ failed(interrupted)
```

Runner-related durable metadata lives on the Operation, for example:

```text
invocationId
resultRef
diagnosticRef
runner process marker metadata
```

### 10.1 RunnerProcessGuard

Linux uses a small native helper at:

```text
packages/daemon/native/runner-process-guard
```

The helper only:

- configures `PR_SET_PDEATHSIG`;
- eliminates the parent-death setup race;
- creates the invocation process group/session;
- publishes deterministic process marker data;
- spawns Qoder;
- waits;
- terminates the owned process group with `SIGTERM`, bounded grace, then `SIGKILL`.

Before starting Qoder, the Guard MUST confirm its daemon parent is still the expected parent.

Containment covers only the owned invocation process group. Descendants that intentionally `setsid()`/daemonize out of that group are outside the V0.3 guarantee.

The Guard MUST NOT write SQLite, own durable results, perform reconciliation, or survive/adopt across daemon restart.

### 10.2 Runner process marker

Transitioning a Runner Operation from `accepted → running` first persists launch intent. After the Guard establishes the process group it publishes a deterministic per-operation marker containing at least:

```text
operationId
pid
pgid
process start identity
```

Only then may Qoder start.

On restart, reconciliation validates the marker, ensures the owned process group no longer exists or terminates a residual group, and marks the stale Runner Operation `failed(interrupted)`.

This is cleanup verification, not execution recovery.

## 11. Persistent external effects

Persistent effects (`start`, `apply`, Worktree reset/recreate/replace, `prepare-retry`, etc.) use:

```text
durable intent
→ external effect
→ durable/exact evidence or postcondition
```

Crash reconciliation follows only these branches:

```text
proof effect not started
→ safe continue/retry

exact expected postcondition satisfied
→ finish commit

known safe failure state
→ failed

cannot prove external state
→ blocked
```

Heuristic similarity MUST NOT trigger automatic replay.

## 12. Per-operation crash-semantics matrix

The table below is the normative minimum. Implementation may add finer-grained phases, but may not weaken any proof requirement.

| Kind | effectScope | Version | Acceptance preconditions | Durable intent / deterministic target | External-effect boundary | Proof effect not started | Completion evidence | Crash reconciliation | Safe retry | Task authority | Project authority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `start` | `task_worktree` | N/A | valid canonical project root; no conflicting project binding; request idempotency clear | reserved `taskId`, project binding, provisioning registry, deterministic Worktree target metadata | immediately before first Worktree/project filesystem mutation | no Worktree target/owned state exists and preparation phase marker shows no mutation began | owned prepared Worktree identity + canonical state path + initial Task snapshot validates | not-started → continue; exact prepared target → finish Task creation; known safe failure → `failed` + `creation_failed`; otherwise `blocked` | only if not-started is proven, otherwise new business start after definite failure | start reservation authority | project binding only; no shared-mutation authority unless underlying Worktree primitive touches shared project in a way requiring it |
| `run` | `none` for persistent state; daemon-scoped Runner | optional | managed, non-retired Task; valid current prepared Worktree; no active Task mutation | invocation id + Runner launch intent + marker path | Guard process group established before Qoder starts | Operation still `accepted`, or running marker proves Qoder never started | Runner result artifact atomically published and parsed; Task invocation completion transaction commits | stale running after daemon death → verify/kill process group → `failed(interrupted)` | yes, new Request after interruption/failure | yes | no |
| `repair` | `task_worktree` + daemon-scoped Runner | optional | active candidate and succeeded predecessor; current owned Worktree; Task authority free | invocation id + reopen intent + deterministic Worktree identity; then Runner launch intent | before Worktree reopen mutation; later before Qoder start | reopen phase marker plus exact pre-state proves reopen did not begin | exact reopened Worktree state, then Runner result; Task completion transaction | reopen not-started → continue; exact reopened state → continue to Runner; ambiguous reopen → `blocked`; Runner interruption after safe reopen → `failed(interrupted)` only if Worktree state remains exact/owned | only when durable evidence establishes safe state | yes | no |
| `retry continue` | daemon-scoped Runner | optional | predecessor failed; current Worktree prepared; no active candidate; Task authority free | invocation id + current Worktree identity + Runner launch intent | before Qoder start | Operation accepted / marker proves Qoder not started | Runner result + Task invocation completion | stale running Runner → cleanup marker → `failed(interrupted)` | yes | yes | no |
| `candidate` | `task_artifact` | required | latest producer invocation succeeded; current Worktree reviewable; no index mutation; Task version match | candidate id, deterministic final artifact path, expected Worktree/baseline identity/hash | before creating/publishing artifact temp/final | final artifact absent and temp state is owned/cleanable | valid owned immutable artifact at expected path with exact hash/metadata | final absent → safe retry; exact valid owned artifact → finish DB commit; ownership/hash conflict → `blocked` | yes only when final absent is proven | yes | no |
| `apply` | `shared_project` | required | active candidate; exact immutable candidate hash; review-ready Worktree matches candidate; Task and project authorities free | candidate id/hash, project id/root, exact expected pre-state and postcondition evidence descriptor | before source-project patch application | exact project pre-state still matches recorded expected pre-state and no application marker/evidence exists | exact expected project postcondition, including changed content/tree identity sufficient to distinguish the requested candidate | exact pre-state/no start → safe retry; exact expected postcondition → finish commit; known safe apply failure → `failed`; otherwise `blocked` + ProjectSafetyIncident | only with proof not-started; never on ambiguous state | yes | yes |
| `discard` | `none` | required | open managed Task; version match; Task authority free | pure domain transition | none | N/A | Task snapshot + Operation terminal in same DB transaction | transaction atomicity eliminates intermediate state | new Request only if first was rejected/definitely failed before acceptance | yes | no |
| `fail` | `none` | required | failed predecessor invocation; no active candidate; open Task; version match | pure domain transition | none | N/A | Task snapshot + Operation terminal in same DB transaction | transaction atomicity eliminates intermediate state | same as discard | yes | no |
| `prepare-retry` | `task_worktree` | required | retry preconditions; current Worktree owned/prepared; version match | preparationId, predecessor identity, deterministic successor target metadata, prepared Task version | before successor Worktree create/reset/rebuild | exact absence of successor target/owned mutation marker | owned successor Worktree identity, predecessor link, prepared version and workspace postconditions | not-started → continue; exact successor postcondition → publish preparation; known safe failure → `failed`; uncertainty → `blocked` | only with proof not-started | yes | no |
| `retry restart` | daemon-scoped Runner; consumes prepared task-worktree effect | required + preparation validation | preparationId exists, valid, same Task/version, predecessor/workspace preconditions unchanged; no auto-preparation | invocation id + immutable reference to existing preparation + Runner launch intent | consuming preparation is DB/domain attachment; Qoder boundary occurs only after preparation validation/attachment commits | Runner accepted/marker proves Qoder not started | Task attaches prepared Worktree atomically, then Runner result completes invocation | preparation MUST NOT be recreated automatically; stale Runner → `failed(interrupted)` after marker cleanup; invalid preparation → deterministic reject | Runner may be retried by new business Request only from resulting valid Task state | yes | no |
| `discard-retry` | `none` logical invalidation | required | preparation belongs to Task; version match; not already consumed; Task authority free | preparation id invalidation record/state | none; no destructive Worktree disposal in V0.3 semantics | N/A | invalidation + Operation terminal in one DB transaction | transaction atomicity eliminates intermediate state | new Request only after deterministic rejection/definite failure | yes | no |

### 12.1 Candidate publication protocol

```text
accepted
→ running + deterministic artifact intent
→ write temp
→ validate
→ atomic rename
→ DB commit
```

A final artifact at the deterministic path is usable for recovery only if ownership and exact hash/metadata validate.

### 12.2 Retry preparation protocol

`prepare-retry` may create/rebuild a Worktree and is therefore a persistent task-worktree effect.

A preparation records at least:

```text
preparationId
prepared Task version
predecessor/workspace preconditions
```

`retry --strategy restart` only consumes an existing valid preparation. It MUST NOT recreate preparation automatically.

`discard-retry` invalidates the preparation logically and MUST NOT imply immediate physical resource disposal.

## 13. Cleanup semantics

V0.3 cleanup is deliberately non-destructive by default:

- `discard` is a logical Task transition only;
- `discard-retry` is logical invalidation only;
- `abandon` does not destructively clean resources;
- candidate/result/diagnostic/prepared resources are not automatically deleted;
- Request/Operation history is not automatically GC’d.

Any future cleanup command must independently validate ownership and safety.

## 14. Persistence

SQLite uses `node:sqlite` with Node `>=22.18.0`.

Concrete SQLite driver types such as `DatabaseSync` MUST remain behind a narrow adapter/repository boundary.

Primary durable entities:

```text
tasks
projects
requests
operations
project_safety_incidents
schema_migrations
```

There is no durable `executions` table.

Large artifacts stay on the filesystem.

Task snapshot/version + Operation terminal outcome + authority release MUST commit in the same SQLite transaction.

Reconciliation exists only for OS/filesystem/external-effect boundaries; it MUST NOT compensate for states a single DB transaction could have made atomic.

### 14.1 Schema migration

Only forward-only ordered migrations are supported.

Startup order:

```text
daemon authority lock
→ open DB
→ inspect/migrate schema
→ startup reconciliation
→ READY
```

If the DB schema version is newer than the binary supports, startup fails closed. No downgrade is attempted.

## 15. Daemon lifecycle

The daemon is a per-user singleton, lazily bootstrapped, and remains running until explicit shutdown, crash, or external process termination.

Shutdown semantics:

```text
stop accepting new work
→ terminate all Runner process groups
→ affected Runner Operations = failed(interrupted)
→ allow already-running synchronous persistent mutation handler
   to reach the next safe durable boundary
→ close DB/socket
→ exit
```

There is no drain mode, graceful/force variant, or persistent disabled state.

The next normal CLI command may lazy-bootstrap the daemon again.

## 16. IPC

IPC is HTTP/JSON over Unix Domain Socket and is a thin RPC adapter, not a REST-domain redesign.

Minimum endpoints:

```text
POST /v1/operations
GET  /v1/operations/:id
POST /v1/operations/:id/wait

GET  /v1/tasks/:id
GET  /v1/tasks/:id/inspect

project/incident recovery endpoints
POST /v1/daemon/shutdown
```

Application error taxonomy is independent of HTTP status mapping and includes at least:

```text
request_id_conflict
task_not_found
task_busy
stale_task_version
legacy_task_readonly
task_retired
project_mismatch
invalid_transition
operation_blocked
project_shared_mutation_blocked
daemon_shutting_down
internal_error
```

`project_shared_mutation_blocked` includes `projectId`, `incidentId` or `blockingOperationId`, and `recoveryHint`.

`waitOperation()` uses bounded long-poll and may return on `succeeded | failed | abandoned | blocked`.

Client disconnect does not cancel an accepted Operation.

Reconnect behavior:

```text
submission outcome unknown
→ resend same semantic request with same requestId

OperationReceipt known
→ never resend mutation
→ observe operationId only
```

## 17. Singleton/bootstrap

`bootstrap.lock` and `daemon.lock` have separate meanings:

```text
bootstrap.lock
→ short-lived CLI bootstrap coordination

daemon.lock
→ held for daemon lifetime; singleton authority
```

A held `daemon.lock` with an unavailable socket means unhealthy singleton; the CLI fails closed and MUST NOT start a second daemon.

Bootstrap flow:

```text
probe socket
→ acquire bootstrap.lock
→ probe again
→ validate/cleanup stale runtime state
→ spawn daemon
→ daemon acquires daemon.lock
→ migrate
→ reconcile
→ READY succeeds
→ release bootstrap.lock
```

One CLI invocation gets at most one daemon spawn attempt.

## 18. State/runtime paths and security

Durable state root:

```text
$XDG_STATE_HOME/qoder-agent-bridge/
fallback ~/.local/state/qoder-agent-bridge/
```

Runtime root:

```text
$XDG_RUNTIME_DIR/qoder-agent-bridge/
fallback secure per-uid runtime directory
```

State contains SQLite, Task artifacts, Operation artifacts, and daemon logs. Runtime contains UDS, `bootstrap.lock`, and `daemon.lock`.

Loss of the runtime directory MUST NOT lose durable Task state.

Runtime validation covers owner UID, permissions, symlink safety, socket type, and Unix socket path length.

A stale socket may be unlinked only while holding `bootstrap.lock` and after proving:

```text
daemon.lock has no owner
connect/readiness fails
path owner/type/permissions are safe
```

The Linux-first IPC security boundary relies on secure per-user filesystem ownership/permissions. V0.3 does not add a bearer token.

## 19. Protocol/versioning and packaging

Before business requests, CLI performs readiness/protocol handshake.

Version dimensions are independent:

```text
package version
protocolVersion
schema version
```

Protocol compatibility is explicit and need not require matching package patch versions. Incompatible protocol fails closed; the CLI does not send mutations and does not terminate the unknown daemon.

`packages/daemon` produces an internal daemon executable released with the CLI/runtime. `DaemonConnector` resolves it from a controlled package/runtime location, never by searching arbitrary `$PATH` entries.

## 20. Diagnostics

Daemon process logs are separate from Task/Operation artifacts.

Startup/reconciliation/bootstrap/internal daemon failures go to daemon logs. Task-specific evidence and diagnostics remain in Task/Operation artifact storage.

## 21. PR sequence and merge gates

### Design Gate — architecture document

Gate:

- every mutation in Section 12 has effect scope, expected-version rule, acceptance preconditions, effect boundary, durable intent, deterministic target, proof-not-started, completion evidence, crash outcome, retry condition, and authority requirements;
- Runner and persistent external mutations remain separate recovery classes;
- no revoked durable-worker/fencing/idle-shutdown design is reintroduced.

### PR 1 — `refactor: extract TaskApplication into packages/daemon`

Scope:

- create transport-independent `TaskApplication`;
- route every CLI Task command, including `inspect`, through in-process Application;
- remove CLI orchestration decisions;
- remove client disconnect → Runner abort business coupling;
- no daemon process yet.

Merge gate:

- no CLI Task business path bypasses Application;
- Application has no HTTP/UDS/bootstrap dependency;
- existing behavior remains covered by tests;
- Task Core remains daemon-independent.

### PR 2 — `feat(daemon): add durable state root and SQLite repositories`

Scope: state/runtime paths, narrow `node:sqlite` adapter, forward migrations, Task registry/snapshot/version, Project identity, Request/Operation/Incident repositories, atomic filesystem publication, legacy readonly registry, start provisioning/tombstone model.

Merge gate:

- repositories hide SQLite driver types;
- forward migration and newer-schema fail-closed tests pass;
- taskId tombstones are not reusable;
- project binding is immutable;
- atomic artifact publication primitive is crash-testable.

### PR 3 — `feat(daemon): add request idempotency, operation journal and expected-version`

Scope: immutable Request outcomes, canonical semantic hash, atomic acceptance, authority constraints, lifecycle, expectedVersion matrix, stable errors.

Merge gate:

- same requestId/same hash returns the same stored outcome;
- same requestId/different hash returns conflict;
- rejected Requests are idempotent and create no Operation;
- per-task and shared-project authority are enforced by DB constraints;
- terminal Operation fields are immutable.

### PR 4 — `feat(daemon): own Runner process lifetime and crash interruption`

Scope: native Guard, parent-death race protection, process group/session, launch marker, artifacts, TERM→KILL, shutdown interruption, stale Runner reconciliation hook, deterministic failure injection.

Merge gate:

- CLI disconnect does not terminate Runner;
- daemon shutdown terminates every owned process group;
- daemon SIGKILL causes Guard cleanup of the owned group;
- stale running Runner becomes `failed(interrupted)` after restart verification;
- interrupted Runner permits a new business retry.

### PR 5 — `feat(daemon): add startup reconciliation and external-effect safety`

Scope: reconcile accepted/running/blocked, Candidate, start/worktree, apply, resolve/abandon, retirement, Incidents, project blocking, failure injection.

Merge gate:

- pre-effect crash is safely retryable only with proof-not-started;
- exact postcondition can finish commit;
- unknown external state becomes blocked;
- blocked Operations are never automatically replayed;
- abandon retires Task;
- shared ambiguity creates Incident;
- abandoning Task leaves Incident blocking the project;
- evidence-backed Incident resolve reopens project shared mutation without rewriting terminal history.

### PR 6 — `feat(daemon): add HTTP/JSON-over-UDS server and shutdown API`

Merge gate:

- transport is a thin TaskApplication adapter;
- protocol readiness handshake works;
- long-poll is bounded and returns blocked/terminal states;
- HTTP mapping does not leak into Application errors;
- disconnect does not cancel accepted work;
- shutdown follows Section 15.

### PR 7 — `feat(cli): switch Task CLI to lazy daemon connector/bootstrap`

Merge gate:

- two concurrent first CLI calls spawn only one daemon;
- CLI exit leaves daemon alive;
- requestId is reused only for unknown submission outcome;
- known receipt is observed by operationId only;
- no embedded fallback exists;
- managed Task input is taskId only;
- incompatible protocol fails closed.

### PR 8 — `feat(daemon): harden singleton bootstrap, runtime paths and security`

Merge gate:

- daemon lifetime lock is authoritative;
- unsafe owner/permission/symlink/socket paths refuse startup;
- stale socket cleanup requires bootstrap authority and no daemon lock owner;
- held daemon lock + unavailable socket fails closed;
- fallback runtime directory is per-uid and secure;
- concurrent bootstrap and stale-runtime tests pass.

### PR 9 — `docs/skill: migrate Skill to managed runtime`

Merge gate:

- new Skill flows persist/pass `taskId` only;
- legacy `taskStatePath` is inspect-only;
- Skill contains no socket/PID/bootstrap/daemon lifecycle concepts;
- blocked/Incident recovery guidance maps only to supported CLI actions.

## 22. Release gate

Release requires all per-PR gates plus:

### Bootstrap

- concurrent first invocation starts one daemon;
- daemon survives CLI exit;
- stale socket recovery is safe;
- incompatible protocol fails closed.

### Request/Operation

- accepted and rejected idempotency;
- no duplicate Operation for one requestId;
- Task/project authority constraints enforced;
- terminal Operation immutable.

### Runner

- CLI disconnect does not terminate Runner;
- shutdown terminates owned groups;
- daemon SIGKILL leaves no owned Runner group;
- restart marks stale Runner interrupted;
- new business retry is allowed after interruption.

### External effects

- crash before effect → safe retry only with proof;
- exact postcondition → finish commit;
- unknown → blocked;
- blocked never auto-replays;
- abandon → Task retired;
- shared ambiguity → ProjectSafetyIncident;
- Task abandon does not clear Incident;
- evidence-backed Incident resolve reopens project mutation safety.

### Persistence/security

- Task transition + Operation completion atomic;
- forward migration works;
- newer schema fails closed;
- taskId tombstones never reuse identity;
- project binding is immutable and mismatch rejects;
- legacy Task is inspect-only;
- unsafe runtime ownership/permissions refuse startup.
