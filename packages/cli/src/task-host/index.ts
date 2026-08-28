import {
  TaskApplication,
  type TaskApplicationDependencies,
  type TaskRunnerOptions,
} from "@qoder-agent-bridge/daemon";

/**
 * PR 1 compatibility adapter. The CLI and existing tests may keep the old
 * symbol while all orchestration is owned by TaskApplication in packages/daemon.
 */
export class EmbeddedTaskHost extends TaskApplication {
  override run(taskStatePath: string, options: TaskRunnerOptions, _clientSignal?: AbortSignal) {
    return super.run(taskStatePath, options);
  }

  override repair(taskStatePath: string, options: TaskRunnerOptions, _clientSignal?: AbortSignal) {
    return super.repair(taskStatePath, options);
  }

  retry(taskStatePath: string, options: TaskRunnerOptions, _clientSignal?: AbortSignal) {
    return super.retryContinue(taskStatePath, options);
  }

  runPreparedSuccessorRetry(
    taskStatePath: string,
    preparationId: string,
    options: TaskRunnerOptions,
    _clientSignal?: AbortSignal,
  ) {
    return super.retryRestart(taskStatePath, preparationId, options);
  }

  get(taskStatePath: string) {
    return super.getTask(taskStatePath);
  }

  prepareSuccessorRetry(taskStatePath: string) {
    return super.prepareRetry(taskStatePath);
  }

  discardPreparedSuccessorRetry(taskStatePath: string, preparationId: string) {
    return super.discardRetry(taskStatePath, preparationId);
  }
}

export type EmbeddedTaskHostDependencies = TaskApplicationDependencies;
export type SkillBridgeDependencies = TaskApplicationDependencies;

export function inspectTaskWorkspace(
  taskStatePath: string,
  dependencies: SkillBridgeDependencies = {},
) {
  return new TaskApplication(dependencies).inspectTask(taskStatePath);
}

export {
  TaskApplication,
  TaskHostError,
  normalizeHostError,
  DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
  DEFAULT_TASK_TIMEOUT_MS,
  resolveTaskExecutionPolicy,
  acquireTaskLock,
  lockPathForTask,
  TaskLock,
  TASK_CANDIDATE_DIR,
  TASK_INVOCATION_DIR,
  TASK_RETRY_PREPARATION_DIR,
  TASK_ROOT_PREFIX,
  TASK_STATE_FILE,
  TaskFileStore,
  createTaskRoot,
  parseTaskState,
  type CandidateOperationResult,
  type CleanupIssue,
  type InvocationOperationResult,
  type NormalizedHostError,
  type PreparedSuccessorRetry,
  type RetryEligibility,
  type StartTaskResult,
  type TaskApplicationDependencies,
  type TaskExecutionPolicy,
  type TaskResolutionResult,
  type TaskRunnerOptions,
  type TaskWorkspaceDisclosure,
  type TaskWorkspaceInspection,
} from "@qoder-agent-bridge/daemon";
