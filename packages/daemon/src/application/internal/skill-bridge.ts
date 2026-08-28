import {
  inspectWorktree,
  startRetry,
  type Task,
  type WorktreeSession,
  type WorktreeSessionRef,
} from "@qoder-agent-bridge/core";
import { TaskHostError } from "./errors";
import { acquireTaskLock } from "./lock";
import { TaskFileStore } from "./store";

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

export interface SkillBridgeDependencies {
  inspectWorktree?: typeof inspectWorktree;
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

function retryEligibility(
  task: Task,
  inspection: Awaited<ReturnType<typeof inspectWorktree>>,
): RetryEligibility {
  const blockers: string[] = [];
  try {
    startRetry(task, {
      invocationId: uniquePreflightInvocationId(task),
      worktree: { type: "current" },
    });
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
