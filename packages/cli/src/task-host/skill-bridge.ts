import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { TASK_INVOCATION_DIR, TaskFileStore } from "./store";
import type { InvocationOperationResult, TaskRunnerOptions } from "./host";

const PREPARED_RETRY_METADATA_FILE = "task-retry-preparation.json";
const PREPARED_RETRY_METADATA_VERSION = 1 as const;

interface PreparedRetryMetadata {
  version: typeof PREPARED_RETRY_METADATA_VERSION;
  taskStatePath: string;
  taskId: string;
  taskVersion: number;
  predecessorWorktreeSessionId: string;
  predecessorStatePath: string;
  successorStatePath: string;
}

export interface TaskWorktreeInspection {
  task: Task;
  worktreeSessionId: string;
  statePath: string;
  phase: WorktreeSession["phase"];
  worktreeRoot: string;
  qoderCwd: string;
  hasChanges: boolean;
  changedFiles: string[];
  indexModified: boolean;
  includedIgnoredArtifacts: WorktreeSession["includedIgnoredArtifacts"];
}

export interface PreparedSuccessorRetry {
  taskId: string;
  taskVersion: number;
  predecessorWorktreeSessionId: string;
  predecessorStatePath: string;
  preparedStatePath: string;
  worktreeRoot: string;
  qoderCwd: string;
  includedIgnoredArtifacts: WorktreeSession["includedIgnoredArtifacts"];
}

export interface SkillBridgeDependencies {
  executeRunner?: typeof executeRunner;
  inspectWorktree?: typeof inspectWorktree;
  prepareWorktree?: typeof prepareWorktree;
  disposeWorktree?: typeof disposeWorktree;
  createId?: (prefix: "inv" | "wt") => string;
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

function metadataPathForState(statePath: string): string {
  return join(dirname(resolve(statePath)), PREPARED_RETRY_METADATA_FILE);
}

function parsePreparedRetryMetadata(value: unknown): PreparedRetryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
  const metadata = value as Partial<PreparedRetryMetadata>;
  if (
    metadata.version !== PREPARED_RETRY_METADATA_VERSION ||
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

async function readPreparedRetryMetadata(statePath: string): Promise<PreparedRetryMetadata> {
  let source: string;
  try {
    source = await readFile(metadataPathForState(statePath), "utf8");
  } catch {
    throw new TaskHostError(
      "invalid_retry_preparation",
      "Prepared successor retry metadata is missing or unreadable.",
    );
  }
  try {
    return parsePreparedRetryMetadata(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof TaskHostError) {
      throw error;
    }
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
}

async function writePreparedRetryMetadata(
  statePath: string,
  metadata: PreparedRetryMetadata,
): Promise<void> {
  await writeFile(metadataPathForState(statePath), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function validatePreparedRetry(
  store: TaskFileStore,
  preparedStatePath: string,
  inspect: typeof inspectWorktree,
): Promise<{
  task: Task;
  currentRef: WorktreeSessionRef;
  successor: Awaited<ReturnType<typeof inspectWorktree>>;
  metadata: PreparedRetryMetadata;
}> {
  const metadata = await readPreparedRetryMetadata(preparedStatePath);
  const taskStatePath = await realpath(store.taskStatePath);
  if ((await realpath(metadata.taskStatePath)) !== taskStatePath) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry belongs to a different Task state file.",
    );
  }

  const task = await store.load();
  if (task.id !== metadata.taskId || task.version !== metadata.taskVersion) {
    throw new TaskHostError(
      "retry_preparation_stale",
      "Task state changed after successor retry preparation; do not reuse the prepared Worktree.",
    );
  }
  assertRetryPreconditions(task);
  const currentRef = activeWorktree(task);
  if (currentRef.id !== metadata.predecessorWorktreeSessionId) {
    throw new TaskHostError(
      "retry_preparation_stale",
      "Active WorktreeSession changed after successor retry preparation.",
    );
  }
  if ((await realpath(currentRef.statePath)) !== (await realpath(metadata.predecessorStatePath))) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry predecessor does not match the active Task WorktreeSession.",
    );
  }

  const successorStatePath = await realpath(preparedStatePath);
  if (successorStatePath !== (await realpath(metadata.successorStatePath))) {
    throw new TaskHostError(
      "retry_preparation_mismatch",
      "Prepared successor retry state path does not match its host metadata.",
    );
  }
  const successor = await inspect(successorStatePath);
  ensurePrepared(successor.session, "Successor retry");
  if (successor.indexModified || successor.hasChanges) {
    throw new TaskHostError(
      "retry_preparation_changed",
      "Prepared successor Worktree changed before its approved Runner invocation.",
    );
  }
  if (successor.session.retryOf === null) {
    throw new TaskHostError(
      "invalid_worktree_lineage",
      "Prepared successor Worktree did not record its predecessor.",
    );
  }
  if ((await realpath(successor.session.retryOf)) !== (await realpath(currentRef.statePath))) {
    throw new TaskHostError(
      "invalid_worktree_lineage",
      "Prepared successor Worktree does not immediately follow the active Task WorktreeSession.",
    );
  }
  return { task, currentRef, successor, metadata };
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

export async function inspectTaskWorktree(
  taskStatePath: string,
  dependencies: SkillBridgeDependencies = {},
): Promise<TaskWorktreeInspection> {
  const inspect = dependencies.inspectWorktree ?? inspectWorktree;
  const store = new TaskFileStore(taskStatePath);
  const lock = await acquireTaskLock(store.taskStatePath);
  try {
    const task = await store.load();
    const ref = activeWorktree(task);
    const result = await inspect(ref.statePath);
    return {
      task,
      worktreeSessionId: ref.id,
      statePath: result.session.statePath,
      phase: result.session.phase,
      worktreeRoot: result.session.worktreeRoot,
      qoderCwd: result.session.worktreeCwd,
      hasChanges: result.hasChanges,
      changedFiles: result.changedFiles,
      indexModified: result.indexModified,
      includedIgnoredArtifacts: result.session.includedIgnoredArtifacts,
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
        "Successor retry preparation refuses a Worktree whose Git index was modified.",
      );
    }

    successor = await prepare(current.session.sourceCwd, currentRef.statePath);
    const predecessorStatePath = await realpath(currentRef.statePath);
    const successorStatePath = await realpath(successor.statePath);
    if (successor.retryOf === null || (await realpath(successor.retryOf)) !== predecessorStatePath) {
      throw new TaskHostError(
        "invalid_worktree_lineage",
        "Prepared successor Worktree does not immediately follow the active Task WorktreeSession.",
      );
    }

    const metadata: PreparedRetryMetadata = {
      version: PREPARED_RETRY_METADATA_VERSION,
      taskStatePath: await realpath(store.taskStatePath),
      taskId: task.id,
      taskVersion: task.version,
      predecessorWorktreeSessionId: currentRef.id,
      predecessorStatePath,
      successorStatePath,
    };
    await writePreparedRetryMetadata(successorStatePath, metadata);
    const result: PreparedSuccessorRetry = {
      taskId: task.id,
      taskVersion: task.version,
      predecessorWorktreeSessionId: currentRef.id,
      predecessorStatePath,
      preparedStatePath: successorStatePath,
      worktreeRoot: successor.worktreeRoot,
      qoderCwd: successor.worktreeCwd,
      includedIgnoredArtifacts: successor.includedIgnoredArtifacts,
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
          "Successor retry preparation failed and the new Worktree could not be cleaned. The Task lock was preserved for diagnosis.",
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
  preparedStatePath: string,
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
    const { task, currentRef, successor } = await validatePreparedRetry(
      store,
      preparedStatePath,
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
        "Prepared successor Worktree could not be attached to Task state safely. The Task lock was preserved for diagnosis.",
        { invocationId, error: normalizeHostError(error) },
      );
    }
    await unlink(metadataPathForState(preparedStatePath)).catch(() => undefined);

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
  preparedStatePath: string,
  dependencies: SkillBridgeDependencies = {},
): Promise<void> {
  const inspect = dependencies.inspectWorktree ?? inspectWorktree;
  const dispose = dependencies.disposeWorktree ?? disposeWorktree;
  const store = new TaskFileStore(taskStatePath);
  const lock = await acquireTaskLock(store.taskStatePath);
  try {
    await validatePreparedRetry(store, preparedStatePath, inspect);
    await dispose(preparedStatePath, true);
    await unlink(metadataPathForState(preparedStatePath)).catch(() => undefined);
  } finally {
    await lock.release();
  }
}
