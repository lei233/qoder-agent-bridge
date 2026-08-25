export const TASK_SCHEMA_VERSION = 1 as const;

export type TaskLifecycle = "open" | "closed";
export type TaskOutcome = null | "applied" | "discarded" | "failed";
export type TaskOperability = "normal" | "blocked";
export type InvocationKind = "initial" | "repair" | "retry";
export type InvocationStatus = "running" | "succeeded" | "failed";

export interface Invocation {
  id: string;
  kind: InvocationKind;
  status: InvocationStatus;
  worktreeSessionId: string;
  predecessorInvocationId: string | null;
  resultRef: string | null;
}

export interface WorktreeSessionRef {
  id: string;
  statePath: string;
  predecessorId: string | null;
}

export interface Candidate {
  id: string;
  producingInvocationId: string;
  worktreeSessionId: string;
  baselineTree: string;
  patchPath: string;
  patchSha256: string;
  changedFiles: string[];
  createdAt: string;
}

export interface Task {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  id: string;
  version: number;
  lifecycle: TaskLifecycle;
  outcome: TaskOutcome;
  operability: TaskOperability;
  blockReason: string | null;
  activeInvocationId: string | null;
  activeCandidateId: string | null;
  activeWorktreeSessionId: string | null;
  appliedCandidateId: string | null;
  invocations: Invocation[];
  worktreeSessions: WorktreeSessionRef[];
  candidates: Candidate[];
}

export type RetryWorktree =
  | { type: "current" }
  | { type: "successor"; session: WorktreeSessionRef };
