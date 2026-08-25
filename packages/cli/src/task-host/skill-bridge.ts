import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  disposeWorktree,
  executeRunner,
  finishInvocation,
  inspectWorktree,
  prepareWorktree,
  startRetry,
  type ParsedRunnerArgs,
  type RunnerExecution,
  type Task,
  type WorktreeSession,
  type WorktreeSessionRef,
} from "@qoder-agent-bridge/core";
import { TaskHostError, normalizeHostError } from "./errors";
import { acquireTaskLock, type TaskLock } from "./lock";
import { TASK_INVOCATION_DIR, TASK_RETRY_PREPARATION_DIR, TaskFileStore } from "./store";
import type { InvocationOperationResult, TaskRunnerOptions } from "./host";

const PREPARED_RETRY_METADATA_VERSION = 2 as const;
const PREPARATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface PreparedRetryMetadata {
  version: typeof PREPARED_RETRY_METADATA_VERSION;
  preparationId: string;
  taskStatePath: string;
  taskId: string;
  taskVersion: number;
  predecessorWorktreeSessionId: string;
  predecessorStatePath: string;
  successorStatePath: string;
}

export interface TaskWorkspaceDisclosure {
  cwd: string;
  changedFiles: string[];
  includedData: WorktreeSession["includedIgnoredArtifacts"];
}

export interface RetryEligibility {
  current: boolean;
  blockers: string[];
}

export interface TaskWorkspaceInspection {
  task: Task;
  workspace: TaskWorkspaceDisclosure;
  retryEligibility: RetryEligibility;
}

export interface PreparedSuccessorRetry {
  preparationId: string;
  taskId: string;
  taskVersion: number;
  workspace: TaskWorkspaceDisclosure;
}

export interface SkillBridgeDependencies {
  executeRunner?: typeof executeRunner;
  inspectWorktree?: typeof inspectWorktree;
  prepareWorktree?: typeof prepareWorktree;
  disposeWorktree?: typeof disposeWorktree;
  createId?: (prefix: "inv" | "wt") => string;
  createPreparationId?: () => string;
}

function activeWorktree(task: Task): WorktreeSessionRef {
  if (task.activeWorktreeSessionId === null) {
    throw new TaskHostError("worktree_missing", "Task has no active WorktreeSession.");
  }
  const ref = task.worktreeSessions.find((item) => item.id === task.activeWorktreeSessionId);
  if (ref === undefined) {
    throw new TaskHostError(
      "invalid_task_state",
      "Active WorktreeSession reference does not resolve.",
    );
  }
  return ref;
}

function ensurePrepared(session: WorktreeSession, operation: string): void {
  if (session.phase !== "prepared") {
    throw new TaskHostError(
      "worktree_not_prepared",
      `${operation} requires a prepared WorktreeSession.`,
    );
  }
}

function uniquePreflightInvocationId(task: Task): string {
  const used = new Set([
    ...task.invocations.map((item) => item.id),
    ...task.worktreeSessions.map((item) => item.id),
    ...task.candidates.map((item) => item.id),
  ]);
  let id = "__qoder_agent_retry_preflight__";
  while (used.has(id)) {
    id += "_";
  }
  return id;
}

function assertRetryPreconditions(task: Task): void {
  startRetry(task, {
    invocationId: uniquePreflightInvocationId(task),
    worktree: { type: "current" },
  });
}

function retryEligibility(
  task: Task,
  inspection: Awaited<ReturnType<typeof inspectWorktree>>,
): RetryEligibility {
  const blockers: string[] = [];
  try {
    assertRetryPreconditions(task);
  } catch {
    blockers.push("task_retry_not_allowed");
  }
  if (inspection.session.phase !== "prepared") {
    blockers.push("workspace_not_prepared");
  }
  if (inspection.indexModified) {
    blockers.push("git_index_modified");
  }
  return { current: blockers.length === 0, blockers };
}

function workspaceDisclosure(
  inspection: Awaited<ReturnType<typeof inspectWorktree>>,
): TaskWorkspaceDisclosure {
  return {
    cwd: inspection.session.worktreeCwd,
    changedFiles: inspection.changedFiles,
    includedData: inspection.session.includedIgnoredArtifacts,
  };
}

function runnerArgs(cwd: string, options: TaskRunnerOptions): ParsedRunnerArgs {
  return {
    cwd,
    prompt: options.prompt,
    promptFile: options.promptFile,
    qodercliPath: options.qodercliPath,
    model: options.model,
    timeoutMs: options.timeoutMs,
    maxModelRequestRetries: options.maxModelRequestRetries,
  };
}

function preparationPath(store: TaskFileStore, preparationId: string): string {
  if (!PREPARATION_ID_PATTERN.test(preparationId)) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation ID is invalid.");
  }
  return join(store.taskRoot, TASK_RETRY_PREPARATION_DIR, `${preparationId}.json`);
}

function parsePreparedRetryMetadata(value: unknown): PreparedRetryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
  const metadata = value as Partial<PreparedRetryMetadata>;
  if (
    metadata.version !== PREPARED_RETRY_METADATA_VERSION ||
    typeof metadata.preparationId !== "string" ||
    !PREPARATION_ID_PATTERN.test(metadata.preparationId) ||
    typeof metadata.taskStatePath !== "string" ||
    typeof metadata.taskId !== "string" ||
    !Number.isSafeInteger(metadata.taskVersion) ||
    typeof metadata.predecessorWorktreeSessionId !== "string" ||
    typeof metadata.predecessorStatePath !== "string" ||
    typeof metadata.successorStatePath !== "string"
  ) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
  return metadata as PreparedRetryMetadata;
}

async function readPreparedRetryMetadata(
  store: TaskFileStore,
  preparationId: string,
): Promise<PreparedRetryMetadata> {
  let source: string;
  try {
    source = await readFile(preparationPath(store, preparationId), "utf8");
  } catch {
    throw new TaskHostError(
      "invalid_retry_preparation",
      "Prepared successor retry metadata is missing or unreadable.",
    );
  }
  try {
    const metadata = parsePreparedRetryMetadata(JSON.parse(source) as unknown);
    if (metadata.preparationId !== preparationId) {
      throw new TaskHostError(
        "retry_preparation_mismatch",
        "Retry preparation ID does not match its metadata.",
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof TaskHostError) {
      throw error;
    }
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
}

async function writePreparedRetryMetadata(
  store: TaskFileStore,
  metadata: PreparedRetryMetadata,
): Promise<void> {
  await mkdir(join(store.taskRoot, TASK_RETRY_PREPARATION_DIR), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    preparationPath(store, metadata.preparationId),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function validatePreparationOwnership(
  store: TaskFileStore,
  preparationId: string,
  inspect: typeof inspectWorktree,
): Promise<{
  task: Task;
  predecessorRef: WorktreeSessionRef;
  successor: Awaited<ReturnType<typeof inspectWorktree>>;
  metadata: PreparedRetryMetadata;
}> {
  const metadata = await readPreparedRetryMetadata(store, preparationId);
  if ((await realpath(metadata.taskStatePath)) !== (await realpath(store.taskStatePath))) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry belongs to a different Task state file.",
    );
  }

  const task = await store.load();
  if (task.id !== metadata.taskId) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry belongs to a different Task.",
    );
  }
  const predecessorRef = task.worktreeSessions.find(
    (item) => item.id === metadata.predecessorWorktreeSessionId,
  );
  if (
    predecessorRef === undefined ||
    (await realpath(predecessorRef.statePath)) !== (await realpath(metadata.predecessorStatePath))
  ) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry predecessor is not owned by this Task.",
    );
  }

  const successor = await inspect(metadata.successorStatePath);
  if (
    (await realpath(successor.session.statePath)) !== (await realpath(metadata.successorStatePath))
  ) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry state does not match its Task-owned metadata.",
    );
  }
  if (
    successor.session.retryOf === null ||
    (await realpath(successor.session.retryOf)) !== (await realpath(metadata.predecessorStatePath))
  ) {
    throw new TaskHostError(
      "invalid_worktree_lineage",
      "Prepared successor Worktree does not immediately follow its recorded predecessor.",
    );
  }
  return { task, predecessorRef, successor, metadata };
}

async function validatePreparedRetryForRun(
  store: TaskFileStore,
  preparationId: string,
  inspect: typeof inspectWorktree,
): Promise<{
  task: Task;
  currentRef: WorktreeSessionRef;
  successor: Awaited<ReturnType<typeof inspectWorktree>>;
  metadata: PreparedRetryMetadata;
}> {
  const owned = await validatePreparationOwnership(store, preparationId, inspect);
  if (owned.task.version !== owned.metadata.taskVersion) {
    throw new TaskHostError(
      "retry_preparation_stale",
      "Task state changed after successor retry preparation; prepare a new retry workspace.",
    );
  }
  assertRetryPreconditions(owned.task);
  const currentRef = activeWorktree(owned.task);
  if (currentRef.id !== owned.metadata.predecessorWorktreeSessionId) {
    throw new TaskHostError(
      "retry_preparation_stale",
      "Active Task workspace changed after successor retry preparation.",
    );
  }
  ensurePrepared(owned.successor.session, "Successor retry");
  if (owned.successor.indexModified || owned.successor.hasChanges) {
    throw new TaskHostError(
      "retry_preparation_changed",
      "Prepared retry workspace changed before its approved Runner invocation.",
    );
  }
  return {
    task: owned.task,
    currentRef,
    successor: owned.successor,
    metadata: owned.metadata,
  };
}

async function writeInvocationArtifact(
  store: TaskFileStore,
  invocationId: string,
  execution: RunnerExecution,
): Promise<string> {
  const directory = join(store.taskRoot, TASK_INVOCATION_DIR, invocationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resultPath = join(directory, "result.json");
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        version: 1,
        invocationId,
        stage: "runner",
        exitCode: execution.exitCode,
        envelope: execution.envelope,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return resultPath;
}

async function finishPreparedInvocation(
  store: TaskFileStore,
  lock: TaskLock,
  running: Task,
  invocationId: string,
  execution: RunnerExecution,
): Promise<InvocationOperationResult> {
  try {
    const resultRef = await writeInvocationArtifact(store, invocationId, execution);
    const finished = finishInvocation(running, {
      invocationId,
      status: execution.envelope.status === "succeeded" ? "succeeded" : "failed",
      resultRef,
    });
    await store.save(finished);
    return {
      task: finished,
      invocationId,
      resultRef,
      runner: execution.envelope,
      hostError: null,
    };
  } catch (error) {
    await lock.preserveForDiagnosis();
    throw new TaskHostError(
      "task_commit_ambiguous",
      "Runner completed, but its immutable result or final Task state could not be committed. The Task lock was preserved for diagnosis.",
      { invocationId, error: normalizeHostError(error) },
    );
  }
}

export async function inspectTaskWorkspace(
  taskStatePath: string,
  dependencies: SkillBridgeDependencies = {},
): Promise<TaskWorkspaceInspection> {
  const inspect = dependencies.inspectWorktree ?? inspectWorktree;
  const store = new TaskFileStore(taskStatePath);
  const lock = await acquireTaskLock(store.taskStatePath);
  try {
    const task = await store.load();
    const ref = activeWorktree(task);
    const result = await inspect(ref.statePath);
    return {
      task,
      workspace: workspaceDisclosure(result),
      retryEligibility: retryEligibility(task, result),
    };
  } finally {
    await lock.release();
  }
}

export async function prepareSuccessorRetry(
  taskStatePath: string,
  dependencies: SkillBridgeDependencies = {},
): Promise<PreparedSuccessorRetry> {
  const inspect = dependencies.inspectWorktree ?? inspectWorktree;
  const prepare = dependencies.prepareWorktree ?? prepareWorktree;
  const dispose = dependencies.disposeWorktree ?? disposeWorktree;
  const createPreparationId = dependencies.createPreparationId ?? (() => `retry-${randomUUID()}`);
  const store = new TaskFileStore(taskStatePath);
  const lock = await acquireTaskLock(store.taskStatePath);
  let successor: WorktreeSession | null = null;
  try {
    const task = await store.load();
    assertRetryPreconditions(task);
    const currentRef = activeWorktree(task);
    const current = await inspect(currentRef.statePath);
    ensurePrepared(current.session, "Successor retry preparation");
    if (current.indexModified) {
      throw new TaskHostError(
        "git_index_modified",
        "Successor retry preparation refuses a workspace whose Git index was modified.",
      );
    }

    successor = await prepare(current.session.sourceCwd, currentRef.statePath);
    const predecessorStatePath = await realpath(currentRef.statePath);
    const successorStatePath = await realpath(successor.statePath);
    if (
      successor.retryOf === null ||
      (await realpath(successor.retryOf)) !== predecessorStatePath
    ) {
      throw new TaskHostError(
        "invalid_worktree_lineage",
        "Prepared successor Worktree does not immediately follow the active Task workspace.",
      );
    }

    const preparationId = createPreparationId();
    if (!PREPARATION_ID_PATTERN.test(preparationId)) {
      throw new TaskHostError(
        "invalid_retry_preparation",
        "Generated retry preparation ID is invalid.",
      );
    }
    const metadata: PreparedRetryMetadata = {
      version: PREPARED_RETRY_METADATA_VERSION,
      preparationId,
      taskStatePath: await realpath(store.taskStatePath),
      taskId: task.id,
      taskVersion: task.version,
      predecessorWorktreeSessionId: currentRef.id,
      predecessorStatePath,
      successorStatePath,
    };
    await writePreparedRetryMetadata(store, metadata);
    const result: PreparedSuccessorRetry = {
      preparationId,
      taskId: task.id,
      taskVersion: task.version,
      workspace: {
        cwd: successor.worktreeCwd,
        changedFiles: [],
        includedData: successor.includedIgnoredArtifacts,
      },
    };
    successor = null;
    return result;
  } catch (error) {
    if (successor !== null) {
      try {
        await dispose(successor.statePath, true);
      } catch (cleanupError) {
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "successor_cleanup_failed",
          "Successor retry preparation failed and its workspace could not be cleaned. The Task lock was preserved for diagnosis.",
          { error: normalizeHostError(error), cleanupError: normalizeHostError(cleanupError) },
        );
      }
    }
    throw error;
  } finally {
    await lock.release();
  }
}

export async function runPreparedSuccessorRetry(
  taskStatePath: string,
  preparationId: string,
  options: TaskRunnerOptions,
  signal?: AbortSignal,
  dependencies: SkillBridgeDependencies = {},
): Promise<InvocationOperationResult> {
  const inspect = dependencies.inspectWorktree ?? inspectWorktree;
  const execute = dependencies.executeRunner ?? executeRunner;
  const createId = dependencies.createId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  const store = new TaskFileStore(taskStatePath);
  const lock = await acquireTaskLock(store.taskStatePath);
  try {
    const { task, currentRef, successor } = await validatePreparedRetryForRun(
      store,
      preparationId,
      inspect,
    );
    const invocationId = createId("inv");
    const running = startRetry(task, {
      invocationId,
      worktree: {
        type: "successor",
        session: {
          id: createId("wt"),
          statePath: successor.session.statePath,
          predecessorId: currentRef.id,
        },
      },
    });
    try {
      await store.save(running);
    } catch (error) {
      await lock.preserveForDiagnosis();
      throw new TaskHostError(
        "task_commit_ambiguous",
        "Prepared retry workspace could not be attached to Task state safely. The Task lock was preserved for diagnosis.",
        { invocationId, error: normalizeHostError(error) },
      );
    }
    await unlink(preparationPath(store, preparationId)).catch(() => undefined);

    let execution: RunnerExecution;
    try {
      execution = await execute(
        runnerArgs(successor.session.worktreeCwd, options),
        process.env,
        signal,
      );
    } catch (error) {
      await lock.preserveForDiagnosis();
      throw new TaskHostError(
        "runner_state_ambiguous",
        "Runner execution threw outside its result protocol. The Invocation remains running and the Task lock was preserved for diagnosis.",
        { invocationId, error: normalizeHostError(error) },
      );
    }
    return await finishPreparedInvocation(store, lock, running, invocationId, execution);
  } finally {
    await lock.release();
  }
}

export async function discardPreparedSuccessorRetry(
  taskStatePath: string,
  preparationId: string,
  dependencies: SkillBridgeDependencies = {},
): Promise<void> {
  const inspect = dependencies.inspectWorktree ?? inspectWorktree;
  const dispose = dependencies.disposeWorktree ?? disposeWorktree;
  const store = new TaskFileStore(taskStatePath);
  const lock = await acquireTaskLock(store.taskStatePath);
  try {
    const { metadata } = await validatePreparationOwnership(store, preparationId, inspect);
    try {
      await dispose(metadata.successorStatePath, true);
      await unlink(preparationPath(store, preparationId));
    } catch (error) {
      await lock.preserveForDiagnosis();
      throw new TaskHostError(
        "prepared_retry_cleanup_ambiguous",
        "Prepared retry workspace could not be disposed with a proven mechanical result. The Task lock was preserved for diagnosis.",
        { error: normalizeHostError(error) },
      );
    }
  } finally {
    await lock.release();
  }
}
