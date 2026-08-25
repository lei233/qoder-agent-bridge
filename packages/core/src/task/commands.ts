import { taskAssert } from "./errors";
import { assertCanonicalChangedFiles, assertTaskInvariants } from "./invariants";
import { applyTaskMutation } from "./transitions";
import {
  TASK_SCHEMA_VERSION,
  type Candidate,
  type InvocationStatus,
  type RetryWorktree,
  type Task,
  type WorktreeSessionRef,
} from "./types";

function assertOpen(task: Task) {
  taskAssert(task.lifecycle === "open", "task_closed", "task is closed");
}

function assertNormal(task: Task) {
  taskAssert(task.operability === "normal", "task_blocked", "task is blocked");
}

function assertIdle(task: Task) {
  taskAssert(task.activeInvocationId === null, "invocation_active", "task already has an active invocation");
}

function lastInvocation(task: Task) {
  return task.invocations.at(-1) ?? null;
}

function activeWorktreeId(task: Task) {
  taskAssert(task.activeWorktreeSessionId !== null, "worktree_missing", "task has no active worktree session");
  return task.activeWorktreeSessionId;
}

function assertUniqueId(task: Task, id: string) {
  taskAssert(id.length > 0, "invalid_id", "id must be non-empty");
  taskAssert(
    !task.invocations.some((item) => item.id === id) &&
      !task.worktreeSessions.some((item) => item.id === id) &&
      !task.candidates.some((item) => item.id === id),
    "duplicate_id",
    `id is already in use: ${id}`,
  );
}

export function createTask(input: { id: string }): Task {
  taskAssert(input.id.length > 0, "invalid_id", "task id must be non-empty");
  const task: Task = {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: input.id,
    version: 0,
    lifecycle: "open",
    outcome: null,
    operability: "normal",
    blockReason: null,
    activeInvocationId: null,
    activeCandidateId: null,
    activeWorktreeSessionId: null,
    appliedCandidateId: null,
    invocations: [],
    worktreeSessions: [],
    candidates: [],
  };
  assertTaskInvariants(task);
  return task;
}

export function attachInitialWorktreeSession(task: Task, session: WorktreeSessionRef): Task {
  assertOpen(task);
  assertNormal(task);
  assertIdle(task);
  taskAssert(task.worktreeSessions.length === 0, "worktree_exists", "initial worktree session is already attached");
  taskAssert(task.activeWorktreeSessionId === null, "worktree_exists", "task already has an active worktree session");
  taskAssert(session.predecessorId === null, "invalid_worktree_lineage", "initial worktree session must not have a predecessor");
  assertUniqueId(task, session.id);
  taskAssert(session.statePath.length > 0, "invalid_state_path", "worktree statePath must be non-empty");

  return applyTaskMutation(task, (next) => {
    next.worktreeSessions.push(structuredClone(session));
    next.activeWorktreeSessionId = session.id;
  });
}

export function startInitial(task: Task, input: { invocationId: string }): Task {
  assertOpen(task);
  assertNormal(task);
  assertIdle(task);
  taskAssert(task.invocations.length === 0, "initial_exists", "initial invocation already exists");
  const worktreeSessionId = activeWorktreeId(task);
  assertUniqueId(task, input.invocationId);

  return applyTaskMutation(task, (next) => {
    next.activeCandidateId = null;
    next.invocations.push({
      id: input.invocationId,
      kind: "initial",
      status: "running",
      worktreeSessionId,
      predecessorInvocationId: null,
      resultRef: null,
    });
    next.activeInvocationId = input.invocationId;
  });
}

export function finishInvocation(
  task: Task,
  input: { invocationId: string; status: Exclude<InvocationStatus, "running">; resultRef: string },
): Task {
  assertOpen(task);
  assertNormal(task);
  taskAssert(task.activeInvocationId === input.invocationId, "invocation_not_active", "invocation is not active");
  taskAssert(input.resultRef.length > 0, "invalid_result_ref", "resultRef must be non-empty");
  const index = task.invocations.findIndex((item) => item.id === input.invocationId);
  taskAssert(index >= 0, "invocation_missing", "invocation does not exist");
  taskAssert(task.invocations[index]?.status === "running", "invocation_not_running", "invocation is not running");

  return applyTaskMutation(task, (next) => {
    const invocation = next.invocations[index];
    taskAssert(invocation !== undefined, "invocation_missing", "invocation does not exist");
    invocation.status = input.status;
    invocation.resultRef = input.resultRef;
    next.activeInvocationId = null;
  });
}

export function freezeCandidate(task: Task, candidate: Candidate): Task {
  assertOpen(task);
  assertNormal(task);
  assertIdle(task);
  assertUniqueId(task, candidate.id);
  assertCanonicalChangedFiles(candidate.changedFiles);
  const producer = task.invocations.find((item) => item.id === candidate.producingInvocationId);
  taskAssert(producer !== undefined, "invocation_missing", "candidate producing invocation does not exist");
  taskAssert(producer.status === "succeeded", "invocation_not_succeeded", "candidate producer must have succeeded");
  taskAssert(producer.worktreeSessionId === activeWorktreeId(task), "candidate_not_current", "candidate producer must belong to current worktree");
  taskAssert(candidate.worktreeSessionId === producer.worktreeSessionId, "candidate_worktree_mismatch", "candidate worktree must match producer");
  taskAssert(!task.candidates.some((item) => item.producingInvocationId === producer.id), "candidate_exists", "invocation already produced a candidate");

  return applyTaskMutation(task, (next) => {
    next.candidates.push(structuredClone(candidate));
    next.activeCandidateId = candidate.id;
  });
}

export function startRepair(task: Task, input: { invocationId: string }): Task {
  assertOpen(task);
  assertNormal(task);
  assertIdle(task);
  taskAssert(task.activeCandidateId !== null, "candidate_missing", "repair requires an active candidate");
  const previous = lastInvocation(task);
  taskAssert(previous?.status === "succeeded", "repair_precondition", "repair requires a succeeded predecessor invocation");
  const worktreeSessionId = activeWorktreeId(task);
  taskAssert(previous.worktreeSessionId === worktreeSessionId, "repair_worktree_mismatch", "repair must reuse current worktree");
  assertUniqueId(task, input.invocationId);

  return applyTaskMutation(task, (next) => {
    next.activeCandidateId = null;
    next.invocations.push({
      id: input.invocationId,
      kind: "repair",
      status: "running",
      worktreeSessionId,
      predecessorInvocationId: previous.id,
      resultRef: null,
    });
    next.activeInvocationId = input.invocationId;
  });
}

export function startRetry(
  task: Task,
  input: { invocationId: string; worktree: RetryWorktree },
): Task {
  assertOpen(task);
  assertNormal(task);
  assertIdle(task);
  taskAssert(task.activeCandidateId === null, "candidate_active", "retry requires no active candidate");
  const previous = lastInvocation(task);
  taskAssert(previous?.status === "failed", "retry_precondition", "retry requires a failed predecessor invocation");
  const currentWorktreeId = activeWorktreeId(task);
  assertUniqueId(task, input.invocationId);

  let invocationWorktreeId = currentWorktreeId;
  if (input.worktree.type === "successor") {
    const session = input.worktree.session;
    assertUniqueId(task, session.id);
    taskAssert(session.statePath.length > 0, "invalid_state_path", "worktree statePath must be non-empty");
    taskAssert(session.predecessorId === currentWorktreeId, "invalid_worktree_lineage", "successor worktree must immediately follow current worktree");
    taskAssert(!task.worktreeSessions.some((item) => item.statePath === session.statePath), "duplicate_state_path", "worktree statePath is already attached");
    invocationWorktreeId = session.id;
  }

  return applyTaskMutation(task, (next) => {
    if (input.worktree.type === "successor") {
      next.worktreeSessions.push(structuredClone(input.worktree.session));
      next.activeWorktreeSessionId = input.worktree.session.id;
    }
    next.activeCandidateId = null;
    next.invocations.push({
      id: input.invocationId,
      kind: "retry",
      status: "running",
      worktreeSessionId: invocationWorktreeId,
      predecessorInvocationId: previous.id,
      resultRef: null,
    });
    next.activeInvocationId = input.invocationId;
  });
}

export function resolveApplied(task: Task, candidateId: string): Task {
  assertOpen(task);
  assertNormal(task);
  assertIdle(task);
  taskAssert(task.activeCandidateId === candidateId, "candidate_not_active", "requested candidate is not active");

  return applyTaskMutation(task, (next) => {
    next.appliedCandidateId = candidateId;
    next.activeCandidateId = null;
    next.lifecycle = "closed";
    next.outcome = "applied";
  });
}

export function resolveDiscarded(task: Task): Task {
  assertOpen(task);
  assertIdle(task);
  return applyTaskMutation(task, (next) => {
    next.activeCandidateId = null;
    next.lifecycle = "closed";
    next.outcome = "discarded";
    next.appliedCandidateId = null;
  });
}

export function resolveFailed(task: Task): Task {
  assertOpen(task);
  assertIdle(task);
  const previous = lastInvocation(task);
  taskAssert(previous?.status === "failed", "failed_precondition", "terminal failure requires a failed invocation");
  taskAssert(task.activeCandidateId === null, "candidate_active", "terminal failure requires no active candidate");
  return applyTaskMutation(task, (next) => {
    next.lifecycle = "closed";
    next.outcome = "failed";
    next.appliedCandidateId = null;
  });
}

export function blockTask(task: Task, reason: string): Task {
  assertOpen(task);
  assertIdle(task);
  taskAssert(task.operability === "normal", "already_blocked", "task is already blocked");
  taskAssert(reason.length > 0, "invalid_block_reason", "block reason must be non-empty");
  return applyTaskMutation(task, (next) => {
    next.operability = "blocked";
    next.blockReason = reason;
  });
}

export function unblockTask(task: Task): Task {
  assertOpen(task);
  assertIdle(task);
  taskAssert(task.operability === "blocked", "not_blocked", "task is not blocked");
  return applyTaskMutation(task, (next) => {
    next.operability = "normal";
    next.blockReason = null;
  });
}
