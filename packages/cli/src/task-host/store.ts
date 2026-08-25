import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertTaskInvariants, type Task } from "@qoder-agent-bridge/core";
import { TaskHostError } from "./errors";

export const TASK_ROOT_PREFIX = "qoder-agent-task-";
export const TASK_STATE_FILE = "task.json";
export const TASK_CANDIDATE_DIR = "candidates";
export const TASK_INVOCATION_DIR = "invocations";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TaskHostError("invalid_task_state", `${field} must be an object.`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TaskHostError("invalid_task_state", `${field} must be a string.`);
  }
  return value;
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, field);
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new TaskHostError("invalid_task_state", `${field} must be a number.`);
  }
  return value;
}

function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TaskHostError("invalid_task_state", `${field} must be an array.`);
  }
  return value;
}

function validateInvocation(value: unknown, index: number): void {
  const item = expectRecord(value, `invocations[${index}]`);
  expectString(item.id, `invocations[${index}].id`);
  expectString(item.kind, `invocations[${index}].kind`);
  expectString(item.status, `invocations[${index}].status`);
  expectString(item.worktreeSessionId, `invocations[${index}].worktreeSessionId`);
  expectNullableString(
    item.predecessorInvocationId,
    `invocations[${index}].predecessorInvocationId`,
  );
  expectNullableString(item.resultRef, `invocations[${index}].resultRef`);
}

function validateWorktreeSession(value: unknown, index: number): void {
  const item = expectRecord(value, `worktreeSessions[${index}]`);
  expectString(item.id, `worktreeSessions[${index}].id`);
  expectString(item.statePath, `worktreeSessions[${index}].statePath`);
  expectNullableString(item.predecessorId, `worktreeSessions[${index}].predecessorId`);
}

function validateCandidate(value: unknown, index: number): void {
  const item = expectRecord(value, `candidates[${index}]`);
  expectString(item.id, `candidates[${index}].id`);
  expectString(item.producingInvocationId, `candidates[${index}].producingInvocationId`);
  expectString(item.worktreeSessionId, `candidates[${index}].worktreeSessionId`);
  expectString(item.baselineTree, `candidates[${index}].baselineTree`);
  expectString(item.patchPath, `candidates[${index}].patchPath`);
  expectString(item.patchSha256, `candidates[${index}].patchSha256`);
  expectString(item.createdAt, `candidates[${index}].createdAt`);
  for (const [fileIndex, path] of expectArray(
    item.changedFiles,
    `candidates[${index}].changedFiles`,
  ).entries()) {
    expectString(path, `candidates[${index}].changedFiles[${fileIndex}]`);
  }
}

export function parseTaskState(value: unknown): Task {
  const task = expectRecord(value, "task");
  expectNumber(task.schemaVersion, "schemaVersion");
  expectString(task.id, "id");
  expectNumber(task.version, "version");
  expectString(task.lifecycle, "lifecycle");
  if (task.outcome !== null) {
    expectString(task.outcome, "outcome");
  }
  expectString(task.operability, "operability");
  expectNullableString(task.blockReason, "blockReason");
  expectNullableString(task.activeInvocationId, "activeInvocationId");
  expectNullableString(task.activeCandidateId, "activeCandidateId");
  expectNullableString(task.activeWorktreeSessionId, "activeWorktreeSessionId");
  expectNullableString(task.appliedCandidateId, "appliedCandidateId");

  for (const [index, item] of expectArray(task.invocations, "invocations").entries()) {
    validateInvocation(item, index);
  }
  for (const [index, item] of expectArray(task.worktreeSessions, "worktreeSessions").entries()) {
    validateWorktreeSession(item, index);
  }
  for (const [index, item] of expectArray(task.candidates, "candidates").entries()) {
    validateCandidate(item, index);
  }

  const parsed = task as unknown as Task;
  try {
    assertTaskInvariants(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task invariants failed.";
    throw new TaskHostError("invalid_task_state", message);
  }
  return structuredClone(parsed);
}

export async function createTaskRoot(baseDirectory = tmpdir()): Promise<string> {
  const root = await mkdtemp(join(baseDirectory, TASK_ROOT_PREFIX));
  await chmod(root, 0o700);
  await Promise.all([
    mkdir(join(root, TASK_CANDIDATE_DIR), { recursive: true, mode: 0o700 }),
    mkdir(join(root, TASK_INVOCATION_DIR), { recursive: true, mode: 0o700 }),
  ]);
  return root;
}

export class TaskFileStore {
  readonly taskStatePath: string;
  readonly taskRoot: string;

  constructor(taskStatePath: string) {
    this.taskStatePath = resolve(taskStatePath);
    this.taskRoot = dirname(this.taskStatePath);
  }

  static forRoot(taskRoot: string): TaskFileStore {
    return new TaskFileStore(join(resolve(taskRoot), TASK_STATE_FILE));
  }

  async load(): Promise<Task> {
    let source: string;
    try {
      source = await readFile(this.taskStatePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new TaskHostError(
          "task_not_found",
          `Task state does not exist: ${this.taskStatePath}`,
        );
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new TaskHostError("invalid_task_state", "Task state is not valid JSON.");
    }
    return parseTaskState(value);
  }

  async save(task: Task): Promise<void> {
    assertTaskInvariants(task);
    await mkdir(this.taskRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.taskStatePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.taskStatePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
