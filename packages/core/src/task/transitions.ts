import { assertTaskInvariants } from "./invariants";
import type { Task } from "./types";

export function applyTaskMutation(task: Task, mutate: (draft: Task) => void): Task {
  assertTaskInvariants(task);
  const next: Task = structuredClone(task);
  mutate(next);
  next.version = task.version + 1;
  assertTaskInvariants(next);
  return next;
}
