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
  taskAssert(
    Number.isSafeInteger(task.version) && task.version >= 0,
    "invalid_task",
    "task version must be a non-negative safe integer",
  );

  taskAssert(task.lifecycle === "open" || task.lifecycle === "closed", "invalid_task", "invalid lifecycle");
  taskAssert(task.operability === "normal" || task.operability === "blocked", "invalid_task", "invalid operability");
  taskAssert(
    task.outcome === null ||
      task.outcome === "applied" ||
      task.outcome === "discarded" ||
      task.outcome === "failed",
    "invalid_task",
    "invalid outcome",
  );
  taskAssert(
    task.operability === "blocked"
      ? task.blockReason !== null && task.blockReason.length > 0
      : task.blockReason === null,
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
  assertUnique([...invocationIds, ...worktreeIds, ...candidateIds], "entity ids");

  const invocationById = new Map(task.invocations.map((item) => [item.id, item]));
  const worktreeById = new Map(task.worktreeSessions.map((item) => [item.id, item]));
  const candidateById = new Map(task.candidates.map((item) => [item.id, item]));

  for (const [index, session] of task.worktreeSessions.entries()) {
    assertNonEmpty(session.id, "worktree session id");
    assertNonEmpty(session.statePath, "worktree session statePath");
    if (index === 0) {
      taskAssert(
        session.predecessorId === null,
        "invalid_task",
        "first worktree session must have no predecessor",
      );
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
    taskAssert(
      worktreeById.has(invocation.worktreeSessionId),
      "invalid_task",
      "invocation worktreeSessionId must resolve",
    );
    taskAssert(
      invocation.status === "running" ||
        invocation.status === "succeeded" ||
        invocation.status === "failed",
      "invalid_task",
      "invalid invocation status",
    );
    taskAssert(
      invocation.status === "running"
        ? invocation.resultRef === null
        : invocation.resultRef !== null && invocation.resultRef.length > 0,
      "invalid_task",
      "invocation resultRef must agree with status",
    );

    if (index === 0) {
      taskAssert(invocation.kind === "initial", "invalid_task", "first invocation must be initial");
      taskAssert(
        invocation.predecessorInvocationId === null,
        "invalid_task",
        "first invocation must have no predecessor",
      );
      taskAssert(
        invocation.worktreeSessionId === task.worktreeSessions[0]?.id,
        "invalid_task",
        "initial invocation must use the initial worktree session",
      );
      continue;
    }

    const previous = task.invocations[index - 1];
    taskAssert(previous !== undefined, "invalid_task", "invocation predecessor must exist");
    taskAssert(invocation.kind !== "initial", "invalid_task", "only the first invocation may be initial");
    taskAssert(
      invocation.predecessorInvocationId === previous.id,
      "invalid_task",
      "invocation lineage must be an ordered single chain",
    );

    if (invocation.kind === "repair") {
      taskAssert(previous.status === "succeeded", "invalid_task", "repair predecessor must have succeeded");
      taskAssert(
        invocation.worktreeSessionId === previous.worktreeSessionId,
        "invalid_task",
        "repair must reuse predecessor worktree",
      );
      taskAssert(
        task.candidates.some((candidate) => candidate.producingInvocationId === previous.id),
        "invalid_task",
        "repair predecessor must have produced a candidate",
      );
    } else {
      taskAssert(previous.status === "failed", "invalid_task", "retry predecessor must have failed");
      const sameWorktree = invocation.worktreeSessionId === previous.worktreeSessionId;
      const previousWorktreeIndex = task.worktreeSessions.findIndex(
        (session) => session.id === previous.worktreeSessionId,
      );
      const successor = task.worktreeSessions[previousWorktreeIndex + 1];
      taskAssert(
        sameWorktree || successor?.id === invocation.worktreeSessionId,
        "invalid_task",
        "retry must use predecessor worktree or its immediate successor",
      );
    }
  }

  const initialCount = task.invocations.filter((item) => item.kind === "initial").length;
  taskAssert(initialCount <= 1, "invalid_task", "task may contain at most one initial invocation");

  for (let index = 1; index < task.worktreeSessions.length; index += 1) {
    const session = task.worktreeSessions[index];
    const predecessor = task.worktreeSessions[index - 1];
    taskAssert(session !== undefined && predecessor !== undefined, "invalid_task", "worktree lineage is incomplete");
    taskAssert(
      task.invocations.some(
        (invocation, invocationIndex) =>
          invocation.kind === "retry" &&
          invocation.worktreeSessionId === session.id &&
          task.invocations[invocationIndex - 1]?.worktreeSessionId === predecessor.id,
      ),
      "invalid_task",
      "successor worktree session must be introduced by retry",
    );
  }

  const running = task.invocations.filter((item) => item.status === "running");
  taskAssert(running.length <= 1, "invalid_task", "task may contain at most one running invocation");
  if (task.activeInvocationId === null) {
    taskAssert(running.length === 0, "invalid_task", "running invocation must be active");
  } else {
    taskAssert(
      running.length === 1 && running[0]?.id === task.activeInvocationId,
      "invalid_task",
      "activeInvocationId must identify the unique running invocation",
    );
  }

  if (task.worktreeSessions.length === 0) {
    taskAssert(
      task.activeWorktreeSessionId === null,
      "invalid_task",
      "bootstrap task cannot have an active worktree session",
    );
    taskAssert(task.invocations.length === 0, "invalid_task", "invocation requires a worktree session");
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
    taskAssert(
      invocation !== undefined,
      "invalid_task",
      "candidate producingInvocationId must resolve",
    );
    taskAssert(
      invocation.status === "succeeded",
      "invalid_task",
      "candidate producing invocation must have succeeded",
    );
    taskAssert(
      worktreeById.has(candidate.worktreeSessionId),
      "invalid_task",
      "candidate worktreeSessionId must resolve",
    );
    taskAssert(
      invocation.worktreeSessionId === candidate.worktreeSessionId,
      "invalid_task",
      "candidate worktree must match producing invocation",
    );
    taskAssert(
      !producedBy.has(candidate.producingInvocationId),
      "invalid_task",
      "one invocation may produce at most one candidate",
    );
    producedBy.add(candidate.producingInvocationId);
  }

  if (task.activeCandidateId !== null) {
    const candidate = candidateById.get(task.activeCandidateId);
    taskAssert(candidate !== undefined, "invalid_task", "activeCandidateId must resolve");
    taskAssert(
      candidate.id === task.candidates.at(-1)?.id,
      "invalid_task",
      "active candidate must be the most recently frozen candidate",
    );
    taskAssert(
      candidate.worktreeSessionId === task.activeWorktreeSessionId,
      "invalid_task",
      "active candidate must belong to current worktree",
    );
  }

  if (task.outcome === "applied") {
    taskAssert(
      task.appliedCandidateId !== null && candidateById.has(task.appliedCandidateId),
      "invalid_task",
      "applied task must identify an existing candidate",
    );
  } else {
    taskAssert(
      task.appliedCandidateId === null,
      "invalid_task",
      "only applied tasks may retain appliedCandidateId",
    );
  }

  if (task.lifecycle === "closed") {
    taskAssert(
      task.activeInvocationId === null,
      "invalid_task",
      "closed task cannot have an active invocation",
    );
    taskAssert(
      task.activeCandidateId === null,
      "invalid_task",
      "closed task cannot have an active candidate",
    );
  }
}
