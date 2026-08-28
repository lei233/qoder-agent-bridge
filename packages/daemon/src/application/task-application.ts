import { type Task } from "@qoder-agent-bridge/core";
import {
  EmbeddedTaskHost,
  type EmbeddedTaskHostDependencies,
  type CandidateOperationResult,
  type InvocationOperationResult,
  type PreparedSuccessorRetry,
  type TaskResolutionResult,
  type TaskRunnerOptions,
} from "./internal/host";
import {
  inspectTaskWorkspace,
  type TaskWorkspaceInspection,
} from "./internal/skill-bridge";

export type TaskApplicationDependencies = EmbeddedTaskHostDependencies;

/**
 * Transport-independent Task orchestration boundary.
 *
 * PR 1 intentionally keeps the V0.2 file-backed host as an internal adapter.
 * Durable Request/Operation semantics are added in PR 2-3 without changing
 * the CLI-facing application ownership boundary established here.
 */
export class TaskApplication {
  readonly #host: EmbeddedTaskHost;
  readonly #dependencies: TaskApplicationDependencies;

  constructor(dependencies: TaskApplicationDependencies = {}) {
    this.#dependencies = dependencies;
    this.#host = new EmbeddedTaskHost(dependencies);
  }

  start(cwd: string) {
    return this.#host.start(cwd);
  }

  getTask(taskStatePath: string): Promise<Task> {
    return this.#host.get(taskStatePath);
  }

  inspectTask(taskStatePath: string): Promise<TaskWorkspaceInspection> {
    const inspectWorktree = this.#dependencies.inspectWorktree;
    return inspectTaskWorkspace(
      taskStatePath,
      inspectWorktree === undefined ? {} : { inspectWorktree },
    );
  }

  run(taskStatePath: string, options: TaskRunnerOptions): Promise<InvocationOperationResult> {
    return this.#host.run(taskStatePath, options);
  }

  candidate(taskStatePath: string): Promise<CandidateOperationResult> {
    return this.#host.candidate(taskStatePath);
  }

  repair(taskStatePath: string, options: TaskRunnerOptions): Promise<InvocationOperationResult> {
    return this.#host.repair(taskStatePath, options);
  }

  prepareRetry(taskStatePath: string): Promise<PreparedSuccessorRetry> {
    return this.#host.prepareSuccessorRetry(taskStatePath);
  }

  retryContinue(
    taskStatePath: string,
    options: TaskRunnerOptions,
  ): Promise<InvocationOperationResult> {
    return this.#host.retry(taskStatePath, options);
  }

  retryRestart(
    taskStatePath: string,
    preparationId: string,
    options: TaskRunnerOptions,
  ): Promise<InvocationOperationResult> {
    return this.#host.runPreparedSuccessorRetry(taskStatePath, preparationId, options);
  }

  discardRetry(taskStatePath: string, preparationId: string): Promise<void> {
    return this.#host.discardPreparedSuccessorRetry(taskStatePath, preparationId);
  }

  apply(taskStatePath: string, candidateId: string): Promise<TaskResolutionResult> {
    return this.#host.apply(taskStatePath, candidateId);
  }

  discard(taskStatePath: string): Promise<TaskResolutionResult> {
    return this.#host.discard(taskStatePath);
  }

  fail(taskStatePath: string): Promise<TaskResolutionResult> {
    return this.#host.fail(taskStatePath);
  }
}
