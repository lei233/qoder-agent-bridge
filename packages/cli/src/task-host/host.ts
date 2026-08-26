import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WorktreeError,
  applyReviewPatch,
  attachInitialWorktreeSession,
  createReviewPatch,
  createTask,
  disposeWorktree,
  executeRunner,
  finishInvocation,
  freezeCandidate,
  inspectWorktree,
  prepareWorktree,
  reopenReviewWorktree,
  resolveApplied,
  resolveDiscarded,
  resolveFailed,
  startInitial,
  startRepair,
  startRetry,
  type Candidate,
  type ParsedRunnerArgs,
  type RunnerEnvelope,
  type Task,
  type WorktreeSession,
  type WorktreeSessionRef,
} from "@qoder-agent-bridge/core";
import { TaskHostError, normalizeHostError } from "./errors";
import { resolveTaskExecutionPolicy, type TaskExecutionPolicy } from "./execution-policy";
import { acquireTaskLock, type TaskLock } from "./lock";
import {
  assertRetryPreparationId,
  preparedRetryMetadata,
  readPreparedRetryMetadata,
  retryPreparationPath,
  writePreparedRetryMetadata,
  type PreparedRetryMetadata,
} from "./retry-preparation";
import { TASK_CANDIDATE_DIR, TASK_INVOCATION_DIR, TaskFileStore, createTaskRoot } from "./store";

export interface TaskRunnerOptions {
  prompt: string | undefined;
  promptFile: string | undefined;
  model: string | undefined;
}

export interface PreparedSuccessorRetry {
  preparationId: string;
  taskId: string;
  taskVersion: number;
  workspace: {
    cwd: string;
    changedFiles: string[];
    includedData: WorktreeSession["includedIgnoredArtifacts"];
  };
}

export interface InvocationOperationResult {
  task: Task;
  invocationId: string;
  resultRef: string;
  runner: RunnerEnvelope | null;
  hostError: { code: string; message: string } | null;
}

export interface CandidateOperationResult {
  task: Task;
  candidate: Candidate;
}

export interface CleanupIssue {
  statePath: string;
  error: { code: string; message: string };
}

export interface TaskResolutionResult {
  task: Task;
  cleanupIncomplete: boolean;
  cleanupIssues: CleanupIssue[];
}

export interface StartTaskResult {
  task: Task;
  taskStatePath: string;
  taskRoot: string;
  statePath: string;
  qoderCwd: string;
}

export interface EmbeddedTaskHostDependencies {
  executeRunner?: typeof executeRunner;
  prepareWorktree?: typeof prepareWorktree;
  inspectWorktree?: typeof inspectWorktree;
  createReviewPatch?: typeof createReviewPatch;
  reopenReviewWorktree?: typeof reopenReviewWorktree;
  applyReviewPatch?: typeof applyReviewPatch;
  disposeWorktree?: typeof disposeWorktree;
  createTaskRoot?: typeof createTaskRoot;
  createId?: (prefix: "task" | "inv" | "wt" | "candidate") => string;
  createPreparationId?: () => string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

const SAFE_APPLY_FAILURE_CODES = new Set([
  "invalid_input",
  "invalid_state",
  "review_state_changed",
  "included_artifact_in_patch",
  "apply_conflict",
]);

const SAFE_REOPEN_FAILURE_CODES = new Set([
  "invalid_input",
  "invalid_state",
  "review_state_changed",
]);

function isKnownSafeWorktreeFailure(error: unknown, codes: Set<string>): boolean {
  return error instanceof WorktreeError && codes.has(error.code);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runnerArgs(
  cwd: string,
  options: TaskRunnerOptions,
  executionPolicy: TaskExecutionPolicy,
): ParsedRunnerArgs {
  return {
    cwd,
    prompt: options.prompt,
    promptFile: options.promptFile,
    qodercliPath: undefined,
    model: options.model,
    timeoutMs: String(executionPolicy.timeoutMs),
    maxModelRequestRetries: String(executionPolicy.maxModelRequestRetries),
  };
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

function activeCandidate(task: Task, candidateId: string): Candidate {
  if (task.activeCandidateId !== candidateId) {
    throw new TaskHostError(
      "candidate_not_active",
      "Requested Candidate is not the active Candidate.",
    );
  }
  const candidate = task.candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    throw new TaskHostError("invalid_task_state", "Active Candidate reference does not resolve.");
  }
  return candidate;
}

function ensurePrepared(session: WorktreeSession, operation: string): void {
  if (session.phase !== "prepared") {
    throw new TaskHostError(
      "worktree_not_prepared",
      `${operation} requires the active WorktreeSession to be prepared.`,
    );
  }
}

function candidateFiles(changedFiles: string[]): string[] {
  const canonical = [...new Set(changedFiles)].sort();
  if (
    canonical.length === 0 ||
    canonical.length !== changedFiles.length ||
    canonical.some((path) => path.length === 0)
  ) {
    throw new TaskHostError(
      "invalid_candidate_artifact",
      "Worktree review did not produce a non-empty unique Candidate file set.",
    );
  }
  return canonical;
}

function uniquePreflightInvocationId(task: Task): string {
  const used = new Set([
    ...task.invocations.map((item) => item.id),
    ...task.worktreeSessions.map((item) => item.id),
    ...task.candidates.map((item) => item.id),
  ]);
  let id = "__qoder_agent_retry_preflight__";
  while (used.has(id)) id += "_";
  return id;
}

function assertRetryPreconditions(task: Task): void {
  startRetry(task, {
    invocationId: uniquePreflightInvocationId(task),
    worktree: { type: "current" },
  });
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
  if ((await realpath(successor.session.statePath)) !== (await realpath(metadata.successorStatePath))) {
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
  return { task: owned.task, currentRef, successor: owned.successor, metadata: owned.metadata };
}

export class EmbeddedTaskHost {
  readonly #executeRunner: typeof executeRunner;
  readonly #prepareWorktree: typeof prepareWorktree;
  readonly #inspectWorktree: typeof inspectWorktree;
  readonly #createReviewPatch: typeof createReviewPatch;
  readonly #reopenReviewWorktree: typeof reopenReviewWorktree;
  readonly #applyReviewPatch: typeof applyReviewPatch;
  readonly #disposeWorktree: typeof disposeWorktree;
  readonly #createTaskRoot: typeof createTaskRoot;
  readonly #createId: (prefix: "task" | "inv" | "wt" | "candidate") => string;
  readonly #createPreparationId: () => string;
  readonly #now: () => Date;
  readonly #env: NodeJS.ProcessEnv;

  constructor(dependencies: EmbeddedTaskHostDependencies = {}) {
    this.#executeRunner = dependencies.executeRunner ?? executeRunner;
    this.#prepareWorktree = dependencies.prepareWorktree ?? prepareWorktree;
    this.#inspectWorktree = dependencies.inspectWorktree ?? inspectWorktree;
    this.#createReviewPatch = dependencies.createReviewPatch ?? createReviewPatch;
    this.#reopenReviewWorktree = dependencies.reopenReviewWorktree ?? reopenReviewWorktree;
    this.#applyReviewPatch = dependencies.applyReviewPatch ?? applyReviewPatch;
    this.#disposeWorktree = dependencies.disposeWorktree ?? disposeWorktree;
    this.#createTaskRoot = dependencies.createTaskRoot ?? createTaskRoot;
    this.#createId = dependencies.createId ?? ((prefix) => `${prefix}-${randomUUID()}`);
    this.#createPreparationId = dependencies.createPreparationId ?? (() => `retry-${randomUUID()}`);
    this.#now = dependencies.now ?? (() => new Date());
    this.#env = dependencies.env ?? process.env;
  }

  async #withLock<T>(
    taskStatePath: string,
    operation: (store: TaskFileStore, lock: TaskLock) => Promise<T>,
  ): Promise<T> {
    const store = new TaskFileStore(taskStatePath);
    const lock = await acquireTaskLock(store.taskStatePath);
    try {
      return await operation(store, lock);
    } finally {
      await lock.release();
    }
  }

  async #writeInvocationArtifact(
    store: TaskFileStore,
    invocationId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const directory = join(store.taskRoot, TASK_INVOCATION_DIR, invocationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resultPath = join(directory, "result.json");
    await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return resultPath;
  }

  async #finishPreRunFailure(
    store: TaskFileStore,
    lock: TaskLock,
    task: Task,
    invocationId: string,
    stage: string,
    error: unknown,
  ): Promise<InvocationOperationResult> {
    const normalized = normalizeHostError(error);
    const executionPolicy = resolveTaskExecutionPolicy(this.#env);
    try {
      const resultRef = await this.#writeInvocationArtifact(store, invocationId, {
        version: 1,
        invocationId,
        stage,
        executionPolicy,
        error: normalized,
      });
      const finished = finishInvocation(task, {
        invocationId,
        status: "failed",
        resultRef,
      });
      await store.save(finished);
      return {
        task: finished,
        invocationId,
        resultRef,
        runner: null,
        hostError: normalized,
      };
    } catch (commitError) {
      await lock.preserveForDiagnosis();
      throw new TaskHostError(
        "task_commit_ambiguous",
        "A pre-run failure occurred, but its Invocation result could not be committed safely. The Task lock was preserved for diagnosis.",
        { invocationId, error: normalizeHostError(commitError) },
      );
    }
  }

  async #runStartedInvocation(
    store: TaskFileStore,
    lock: TaskLock,
    task: Task,
    invocationId: string,
    qoderCwd: string,
    options: TaskRunnerOptions,
    signal?: AbortSignal,
  ): Promise<InvocationOperationResult> {
    const executionPolicy = resolveTaskExecutionPolicy(this.#env);
    let execution: Awaited<ReturnType<typeof executeRunner>>;
    try {
      execution = await this.#executeRunner(
        runnerArgs(qoderCwd, options, executionPolicy),
        this.#env,
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

    try {
      const resultRef = await this.#writeInvocationArtifact(store, invocationId, {
        version: 1,
        invocationId,
        stage: "runner",
        executionPolicy,
        exitCode: execution.exitCode,
        envelope: execution.envelope,
      });
      const finished = finishInvocation(task, {
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

  async start(cwd: string): Promise<StartTaskResult> {
    const taskRoot = await this.#createTaskRoot();
    const store = TaskFileStore.forRoot(taskRoot);
    const lock = await acquireTaskLock(store.taskStatePath);
    let prepared: WorktreeSession | null = null;
    let attached = false;
    try {
      let task = createTask({ id: this.#createId("task") });
      await store.save(task);
      prepared = await this.#prepareWorktree(cwd);
      const statePath = await realpath(prepared.statePath);
      task = attachInitialWorktreeSession(task, {
        id: this.#createId("wt"),
        statePath,
        predecessorId: null,
      });
      await store.save(task);
      attached = true;
      return {
        task,
        taskStatePath: store.taskStatePath,
        taskRoot: store.taskRoot,
        statePath,
        qoderCwd: prepared.worktreeCwd,
      };
    } catch (error) {
      if (prepared !== null && !attached) {
        try {
          await this.#disposeWorktree(prepared.statePath, true);
        } catch (cleanupError) {
          await lock.preserveForDiagnosis();
          throw new TaskHostError(
            "start_cleanup_failed",
            "Task start failed after Worktree preparation, and the temporary Worktree could not be cleaned. The lock was preserved for diagnosis.",
            { error: normalizeHostError(error), cleanupError: normalizeHostError(cleanupError) },
          );
        }
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  async get(taskStatePath: string): Promise<Task> {
    return new TaskFileStore(taskStatePath).load();
  }

  async run(
    taskStatePath: string,
    options: TaskRunnerOptions,
    signal?: AbortSignal,
  ): Promise<InvocationOperationResult> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const task = await store.load();
      const ref = activeWorktree(task);
      const inspection = await this.#inspectWorktree(ref.statePath);
      ensurePrepared(inspection.session, "Initial run");
      if (inspection.indexModified || inspection.hasChanges) {
        throw new TaskHostError(
          "worktree_state_changed",
          "Initial Task run requires the prepared Worktree to still match its baseline.",
        );
      }
      const invocationId = this.#createId("inv");
      const running = startInitial(task, { invocationId });
      await store.save(running);
      return this.#runStartedInvocation(
        store,
        lock,
        running,
        invocationId,
        inspection.session.worktreeCwd,
        options,
        signal,
      );
    });
  }

  async candidate(taskStatePath: string): Promise<CandidateOperationResult> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const task = await store.load();
      const ref = activeWorktree(task);
      const inspection = await this.#inspectWorktree(ref.statePath);
      ensurePrepared(inspection.session, "Candidate freeze");
      if (inspection.indexModified) {
        throw new TaskHostError(
          "git_index_modified",
          "Candidate freeze refuses a Worktree whose Git index was modified.",
        );
      }
      if (!inspection.hasChanges) {
        throw new TaskHostError(
          "empty_candidate",
          "An empty Worktree patch does not produce a Candidate.",
        );
      }

      const candidateId = this.#createId("candidate");
      const createdAt = this.#now().toISOString();
      const producingInvocationId = task.invocations.at(-1)?.id ?? "";
      freezeCandidate(task, {
        id: candidateId,
        producingInvocationId,
        worktreeSessionId: ref.id,
        baselineTree: inspection.session.baselineTree,
        patchPath: "task-host-domain-preflight.patch",
        patchSha256: "task-host-domain-preflight",
        changedFiles: ["task-host-domain-preflight"],
        createdAt,
      });

      let review: Awaited<ReturnType<typeof createReviewPatch>>;
      try {
        review = await this.#createReviewPatch(ref.statePath);
      } catch (error) {
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "candidate_review_ambiguous",
          "Candidate review generation did not complete cleanly. The Task lock was preserved because Worktree side effects cannot be proven.",
          { error: normalizeHostError(error) },
        );
      }

      try {
        const changedFiles = candidateFiles(review.changedFiles);
        const patchBytes = await readFile(review.session.reviewPatchPath);
        if (patchBytes.length === 0) {
          throw new TaskHostError(
            "empty_candidate",
            "An empty Worktree patch does not produce a Candidate.",
          );
        }
        const candidatePath = join(store.taskRoot, TASK_CANDIDATE_DIR, `${candidateId}.patch`);
        await mkdir(join(store.taskRoot, TASK_CANDIDATE_DIR), { recursive: true, mode: 0o700 });
        await writeFile(candidatePath, patchBytes, { mode: 0o600, flag: "wx" });
        const frozenBytes = await readFile(candidatePath);
        if (!frozenBytes.equals(patchBytes)) {
          throw new TaskHostError(
            "candidate_artifact_mismatch",
            "Immutable Candidate copy does not match the Worktree review patch.",
          );
        }
        const candidate: Candidate = {
          id: candidateId,
          producingInvocationId,
          worktreeSessionId: ref.id,
          baselineTree: review.session.baselineTree,
          patchPath: candidatePath,
          patchSha256: sha256(frozenBytes),
          changedFiles,
          createdAt,
        };
        const frozen = freezeCandidate(task, candidate);
        await store.save(frozen);
        return { task: frozen, candidate };
      } catch (error) {
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "candidate_commit_ambiguous",
          "Worktree review patch generation succeeded, but the immutable Candidate could not be committed. The Task lock was preserved for diagnosis.",
          { error: normalizeHostError(error) },
        );
      }
    });
  }

  async repair(
    taskStatePath: string,
    options: TaskRunnerOptions,
    signal?: AbortSignal,
  ): Promise<InvocationOperationResult> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const task = await store.load();
      const ref = activeWorktree(task);
      const invocationId = this.#createId("inv");
      const running = startRepair(task, { invocationId });
      await store.save(running);

      let reopened: Awaited<ReturnType<typeof reopenReviewWorktree>>;
      try {
        reopened = await this.#reopenReviewWorktree(ref.statePath);
      } catch (error) {
        if (isKnownSafeWorktreeFailure(error, SAFE_REOPEN_FAILURE_CODES)) {
          return this.#finishPreRunFailure(store, lock, running, invocationId, "reopen", error);
        }
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "repair_reopen_ambiguous",
          "Repair Worktree reopening failed with an unproven mechanical state. The Invocation remains running and the Task lock was preserved for diagnosis.",
          { invocationId, error: normalizeHostError(error) },
        );
      }
      return this.#runStartedInvocation(
        store,
        lock,
        running,
        invocationId,
        reopened.session.worktreeCwd,
        options,
        signal,
      );
    });
  }

  async retry(
    taskStatePath: string,
    options: TaskRunnerOptions,
    signal?: AbortSignal,
  ): Promise<InvocationOperationResult> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const task = await store.load();
      const currentRef = activeWorktree(task);
      const current = await this.#inspectWorktree(currentRef.statePath);
      ensurePrepared(current.session, "Retry");
      if (current.indexModified) {
        throw new TaskHostError(
          "git_index_modified",
          "Retry refuses a Worktree whose Git index was modified.",
        );
      }
      const invocationId = this.#createId("inv");
      const running = startRetry(task, {
        invocationId,
        worktree: { type: "current" },
      });
      await store.save(running);
      return this.#runStartedInvocation(
        store,
        lock,
        running,
        invocationId,
        current.session.worktreeCwd,
        options,
        signal,
      );
    });
  }

  async prepareSuccessorRetry(taskStatePath: string): Promise<PreparedSuccessorRetry> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      let successor: WorktreeSession | null = null;
      try {
        const task = await store.load();
        assertRetryPreconditions(task);
        const currentRef = activeWorktree(task);
        const current = await this.#inspectWorktree(currentRef.statePath);
        ensurePrepared(current.session, "Successor retry preparation");
        if (current.indexModified) {
          throw new TaskHostError(
            "git_index_modified",
            "Successor retry preparation refuses a workspace whose Git index was modified.",
          );
        }

        successor = await this.#prepareWorktree(current.session.sourceCwd, currentRef.statePath);
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

        const preparationId = this.#createPreparationId();
        assertRetryPreparationId(preparationId);
        await writePreparedRetryMetadata(
          store,
          preparedRetryMetadata({
            preparationId,
            taskStatePath: await realpath(store.taskStatePath),
            taskId: task.id,
            taskVersion: task.version,
            predecessorWorktreeSessionId: currentRef.id,
            predecessorStatePath,
            successorStatePath,
          }),
        );
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
            await this.#disposeWorktree(successor.statePath, true);
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
      }
    });
  }

  async runPreparedSuccessorRetry(
    taskStatePath: string,
    preparationId: string,
    options: TaskRunnerOptions,
    signal?: AbortSignal,
  ): Promise<InvocationOperationResult> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const { task, currentRef, successor } = await validatePreparedRetryForRun(
        store,
        preparationId,
        this.#inspectWorktree,
      );
      const invocationId = this.#createId("inv");
      const running = startRetry(task, {
        invocationId,
        worktree: {
          type: "successor",
          session: {
            id: this.#createId("wt"),
            statePath: successor.session.statePath,
            predecessorId: currentRef.id,
          },
        },
      });
      try {
        await store.save(running);
        await unlink(retryPreparationPath(store, preparationId));
      } catch (error) {
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "task_commit_ambiguous",
          "Prepared retry workspace could not be attached and finalized safely. The Task lock was preserved for diagnosis.",
          { invocationId, error: normalizeHostError(error) },
        );
      }

      return this.#runStartedInvocation(
        store,
        lock,
        running,
        invocationId,
        successor.session.worktreeCwd,
        options,
        signal,
      );
    });
  }

  async discardPreparedSuccessorRetry(
    taskStatePath: string,
    preparationId: string,
  ): Promise<void> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const { task, metadata } = await validatePreparationOwnership(
        store,
        preparationId,
        this.#inspectWorktree,
      );
      for (const ref of task.worktreeSessions) {
        if ((await realpath(ref.statePath)) === (await realpath(metadata.successorStatePath))) {
          throw new TaskHostError(
            "retry_preparation_committed",
            "Prepared successor retry workspace is already attached to the Task and cannot be discarded as a preparation.",
          );
        }
      }
      try {
        await this.#disposeWorktree(metadata.successorStatePath, true);
        await unlink(retryPreparationPath(store, preparationId));
      } catch (error) {
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "prepared_retry_cleanup_ambiguous",
          "Prepared retry workspace could not be disposed with a proven mechanical result. The Task lock was preserved for diagnosis.",
          { error: normalizeHostError(error) },
        );
      }
    });
  }

  async apply(taskStatePath: string, candidateId: string): Promise<TaskResolutionResult> {
    return this.#withLock(taskStatePath, async (store, lock) => {
      const task = await store.load();
      const resolved = resolveApplied(task, candidateId);
      const candidate = activeCandidate(task, candidateId);
      const ref = activeWorktree(task);
      const inspection = await this.#inspectWorktree(ref.statePath);
      if (inspection.session.phase !== "review_ready") {
        throw new TaskHostError(
          "worktree_not_review_ready",
          "Apply requires a review-ready Worktree.",
        );
      }
      if (inspection.session.baselineTree !== candidate.baselineTree) {
        throw new TaskHostError(
          "candidate_baseline_mismatch",
          "Candidate baselineTree does not match the active Worktree review.",
        );
      }
      const candidateBytes = await readFile(candidate.patchPath);
      if (sha256(candidateBytes) !== candidate.patchSha256) {
        throw new TaskHostError(
          "candidate_artifact_changed",
          "Immutable Candidate patch bytes no longer match their recorded SHA-256.",
        );
      }
      const currentPatchBytes = await readFile(inspection.session.reviewPatchPath);
      if (
        !currentPatchBytes.equals(candidateBytes) ||
        sha256(currentPatchBytes) !== candidate.patchSha256
      ) {
        throw new TaskHostError(
          "candidate_apply_mismatch",
          "The Worktree patch that would be applied is not byte-identical to the active Candidate.",
        );
      }

      let cleanupIssue: CleanupIssue | null = null;
      try {
        await this.#applyReviewPatch(ref.statePath);
      } catch (error) {
        if (error instanceof WorktreeError && error.code === "cleanup_failed") {
          cleanupIssue = { statePath: ref.statePath, error: normalizeHostError(error) };
        } else if (isKnownSafeWorktreeFailure(error, SAFE_APPLY_FAILURE_CODES)) {
          throw error;
        } else {
          await lock.preserveForDiagnosis();
          throw new TaskHostError(
            "apply_state_ambiguous",
            "Worktree apply failed after its result became mechanically ambiguous. The Task lock was preserved; do not replay apply automatically.",
            { candidateId, error: normalizeHostError(error) },
          );
        }
      }

      try {
        await store.save(resolved);
        return {
          task: resolved,
          cleanupIncomplete: cleanupIssue !== null,
          cleanupIssues: cleanupIssue === null ? [] : [cleanupIssue],
        };
      } catch (error) {
        await lock.preserveForDiagnosis();
        throw new TaskHostError(
          "apply_commit_ambiguous",
          "Source apply completed, but Task outcome could not be committed. The Task lock was preserved; do not replay apply automatically.",
          { candidateId, error: normalizeHostError(error) },
        );
      }
    });
  }

  async discard(taskStatePath: string): Promise<TaskResolutionResult> {
    return this.#withLock(taskStatePath, async (store) => {
      const task = await store.load();
      const resolved = resolveDiscarded(task);
      await store.save(resolved);
      const cleanupIssues: CleanupIssue[] = [];
      for (const ref of [...task.worktreeSessions].reverse()) {
        try {
          await this.#disposeWorktree(ref.statePath, true);
        } catch (error) {
          cleanupIssues.push({ statePath: ref.statePath, error: normalizeHostError(error) });
        }
      }
      return {
        task: resolved,
        cleanupIncomplete: cleanupIssues.length > 0,
        cleanupIssues,
      };
    });
  }

  async fail(taskStatePath: string): Promise<TaskResolutionResult> {
    return this.#withLock(taskStatePath, async (store) => {
      const task = await store.load();
      const resolved = resolveFailed(task);
      await store.save(resolved);
      return { task: resolved, cleanupIncomplete: false, cleanupIssues: [] };
    });
  }
}
