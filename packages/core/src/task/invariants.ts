import { taskAssert } from "./errors";
import { TASK_SCHEMA_VERSION, type Candidate, type Task } from "./types";

function assertNonEmpty(value: string, field: string) {
  taskAssert(value.length > 0, "invalid_task", `${field} must be non-empty`);
}

function assertUnique(values: string[], field: string) {
  taskAssert(new Set(values).size === values.length, "invalid_task", `${field} must be unique`);
}

export function assertCanonicalChangedFiles(changedFiles: string[]) {
  taskAssert(changedFiles.length > 0, "invalid_candidate", "candidate changedFiles must be non-empty");
  for (const path of changedFiles) {
    assertNonEmpty(path, "candidate changedFiles entry");
  }
  assertUnique(changedFiles, "candidate changedFiles");
  const canonical = [...changedFiles].sort();
  taskAssert(
    canonical.every((path, index) => path === changedFiles[index]),
    "invalid_candidate",
    "candidate changedFiles must be canonically ordered",
  );
}

function assertCandidateShape(candidate: Candidate) {
  assertNonEmpty(candidate.id, "candidate id");
  assertNonEmpty(candidate.producingInvocationId, "candidate producingInvocationId");
  assertNonEmpty(candidate.worktreeSessionId, "candidate worktreeSessionId");
  assertNonEmpty(candidate.baselineTree, "candidate baselineTree");
  assertNonEmpty(candidate.patchPath, "candidate patchPath");
  assertNonEmpty(candidate.patchSha256, "candidate patchSha256");
  assertNonEmpty(candidate.createdAt, "candidate createdAt");
  assertCanonicalChangedFiles(candidate.changedFiles);
}

export function assertTaskInvariants(task: Task): void {
  taskAssert(task.schemaVersion === TASK_SCHEMA_VERSION, "invalid_task", "unsupported task schemaVersion");
  assertNonEmpty(task.id, "task id");
  taskAssert(Number.isSafeInteger(task.version) && task.version >= 0, "invalid_task", "task version must be a non-negative safe integer");

  taskAssert(task.lifecycle === "open" || task.lifecycle === "closed", "invalid_task", "invalid lifecycle");
  taskAssert(task.operability === "normal" || task.operability === "blocked", "invalid_task", "invalid operability");
  taskAssert(
    task.outcome === null || task.outcome === "applied" || task.outcome === "discarded" || task.outcome === "failed",
    "invalid_task",
    "invalid outcome",
  );
  taskAssert(
    task.operability === "blocked" ? task.blockReason !== null && task.blockReason.length > 0 : task.blockReason === null,
    "invalid_task",
    "blockReason must agree with operability",
  );
  taskAssert(
    task.lifecycle === "open" ? task.outcome === null : task.outcome !== null,
    "invalid_task",
    "lifecycle and outcome must agree",
  );

  const invocationIds = task.invocations.map((item) => item.id);
  const worktreeIds = task.worktreeSessions.map((item) => item.id);
  const candidateIds = task.candidates.map((item) => item.id);
  assertUnique(invocationIds, "invocation ids");
  assertUnique(worktreeIds, "worktree session ids");
  assertUnique(candidateIds, "candidate ids");

  const invocationById = new Map(task.invocations.map((item) => [item.id, item]));
  const worktreeById = new Map(task.worktreeSessions.map((item) => [item.id, item]));
  const candidateById = new Map(task.candidates.map((item) => [item.id, item]));

  for (const [index, session] of task.worktreeSessions.entries()) {
    assertNonEmpty(session.id, "worktree session id");
    assertNonEmpty(session.statePath, "worktree session statePath");
    if (index === 0) {
      taskAssert(session.predecessorId === null, "invalid_task", "first worktree session must have no predecessor");
    } else {
      taskAssert(
        session.predecessorId === task.worktreeSessions[index - 1]?.id,
        "invalid_task",
        "worktree session lineage must be an ordered single chain",
      );
    }
  }
  assertUnique(task.worktreeSessions.map((item) => item.statePath), "worktree session state paths");

  for (const [index, invocation] of task.invocations.entries()) {
    assertNonEmpty(invocation.id, "invocation id");
    taskAssert(worktreeById.has(invocation.worktreeSessionId), "invalid_task", "invocation worktreeSessionId must resolve");
    taskAssert(
      invocation.status === "running" || invocation.status === "succeeded" || invocation.status === "failed",
      "invalid_task",
      "invalid invocation status",
    );
    if (index === 0) {
      taskAssert(invocation.kind === "initial", "invalid_task", "first invocation must be initial");
      taskAssert(invocation.predecessorInvocationId === null, "invalid_task", "first invocation must have no predecessor");
    } else {
      taskAssert(invocation.kind !== "initial", "invalid_task", "only the first invocation may be initial");
      taskAssert(
        invocation.predecessorInvocationId === task.invocations[index - 1]?.id,
        "invalid_task",
        "invocation lineage must be an ordered single chain",
      );
    }
  }

  const initialCount = task.invocations.filter((item) => item.kind === "initial").length;
  taskAssert(initialCount <= 1, "invalid_task", "task may contain at most one initial invocation");

  const running = task.invocations.filter((item) => item.status === "running");
  taskAssert(running.length <= 1, "invalid_task", "task may contain at most one running invocation");
  if (task.activeInvocationId === null) {
    taskAssert(running.length === 0, "invalid_task", "running invocation must be active");
  } else {
    taskAssert(running.length === 1 && running[0]?.id === task.activeInvocationId, "invalid_task", "activeInvocationId must identify the unique running invocation");
  }

  if (task.worktreeSessions.length === 0) {
    taskAssert(task.activeWorktreeSessionId === null, "invalid_task", "bootstrap task cannot have an active worktree session");
  } else {
    taskAssert(
      task.activeWorktreeSessionId === task.worktreeSessions.at(-1)?.id,
      "invalid_task",
      "activeWorktreeSessionId must identify the current worktree lineage tip",
    );
  }

  const producedBy = new Set<string>();
  for (const candidate of task.candidates) {
    assertCandidateShape(candidate);
    const invocation = invocationById.get(candidate.producingInvocationId);
    taskAssert(invocation !== undefined, "invalid_task", "candidate producingInvocationId must resolve");
    taskAssert(worktreeById.has(candidate.worktreeSessionId), "invalid_task", "candidate worktreeSessionId must resolve");
    taskAssert(invocation.worktreeSessionId === candidate.worktreeSessionId, "invalid_task", "candidate worktree must match producing invocation");
    taskAssert(!producedBy.has(candidate.producingInvocationId), "invalid_task", "one invocation may produce at most one candidate");
    producedBy.add(candidate.producingInvocationId);
  }

  if (task.activeCandidateId !== null) {
    const candidate = candidateById.get(task.activeCandidateId);
    taskAssert(candidate !== undefined, "invalid_task", "activeCandidateId must resolve");
    const invocation = invocationById.get(candidate.producingInvocationId);
    taskAssert(invocation?.status === "succeeded", "invalid_task", "active candidate must come from a succeeded invocation");
    taskAssert(candidate.worktreeSessionId === task.activeWorktreeSessionId, "invalid_task", "active candidate must belong to current worktree");
  }

  if (task.outcome === "applied") {
    taskAssert(task.appliedCandidateId !== null && candidateById.has(task.appliedCandidateId), "invalid_task", "applied task must identify an existing candidate");
  } else {
    taskAssert(task.appliedCandidateId === null, "invalid_task", "only applied tasks may retain appliedCandidateId");
  }

  if (task.lifecycle === "closed") {
    taskAssert(task.activeInvocationId === null, "invalid_task", "closed task cannot have an active invocation");
    taskAssert(task.activeCandidateId === null, "invalid_task", "closed task cannot have an active candidate");
  }
}
