import { open, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { TaskHostError } from "./errors";

export function lockPathForTask(taskStatePath: string): string {
  return `${resolve(taskStatePath)}.lock`;
}

export class TaskLock {
  readonly path: string;
  #handle: FileHandle | null;
  #preserved = false;

  constructor(path: string, handle: FileHandle) {
    this.path = path;
    this.#handle = handle;
  }

  async preserveForDiagnosis(): Promise<void> {
    this.#preserved = true;
    if (this.#handle !== null) {
      await this.#handle.close().catch(() => undefined);
      this.#handle = null;
    }
  }

  async release(): Promise<void> {
    if (this.#handle !== null) {
      await this.#handle.close().catch(() => undefined);
      this.#handle = null;
    }
    if (!this.#preserved) {
      await unlink(this.path).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      });
    }
  }
}

export async function acquireTaskLock(taskStatePath: string): Promise<TaskLock> {
  const lockPath = lockPathForTask(taskStatePath);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new TaskHostError(
        "task_locked",
        `Task is locked. Stale locks are never reclaimed automatically: ${lockPath}`,
        { lockPath },
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    return new TaskLock(lockPath, handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}
