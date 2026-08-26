import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WorktreeSession } from "@qoder-agent-bridge/core";
import {
  EmbeddedTaskHost,
  normalizeHostError,
  type EmbeddedTaskHostDependencies,
} from "../packages/cli/src/task-host";

const fixtures: string[] = [];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function taskRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qoder-task-start-test-"));
  fixtures.push(root);
  return root;
}

function preparedSession(statePath: string, cwd: string): WorktreeSession {
  const sessionRoot = join(cwd, "fake-session");
  return {
    version: 2,
    phase: "prepared",
    sessionRoot,
    statePath,
    sourceRoot: cwd,
    sourceCwd: cwd,
    worktreeRoot: join(sessionRoot, "worktree"),
    worktreeCwd: join(sessionRoot, "worktree"),
    baseCommit: "deadbeef",
    baselineTree: "deadbeef",
    baselinePatchPath: join(sessionRoot, "source-baseline.patch"),
    reviewPatchPath: join(sessionRoot, "qoder-only.patch"),
    reviewAttempt: 0,
    retryOf: null,
    includedIgnoredArtifacts: null,
  };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("EmbeddedTaskHost start lifecycle", () => {
  it("removes the Task root when failure is proven to occur before Worktree preparation", async () => {
    const root = await taskRoot();
    const host = new EmbeddedTaskHost({
      createTaskRoot: async () => root,
      createId: (() => {
        throw new Error("simulated task creation failure");
      }) as NonNullable<EmbeddedTaskHostDependencies["createId"]>,
      prepareWorktree: async () => {
        throw new Error("must not be called");
      },
    });

    await expect(host.start("/unused")).rejects.toThrow(/simulated task creation failure/);
    expect(await exists(root)).toBe(false);
  });

  it("preserves a locatable Task root when prepareWorktree fails before returning cleanup evidence", async () => {
    const root = await taskRoot();
    const host = new EmbeddedTaskHost({
      createTaskRoot: async () => root,
      prepareWorktree: async () => {
        throw new Error("simulated prepare failure");
      },
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    let thrown: unknown;
    try {
      await host.start("/unused");
    } catch (error) {
      thrown = error;
    }
    const normalized = normalizeHostError(thrown);
    expect(normalized).toMatchObject({
      code: "start_state_ambiguous",
      diagnosticRef: expect.any(String),
    });
    expect(await exists(root)).toBe(true);
    expect(await exists(join(root, "task.json.lock"))).toBe(true);

    const diagnostic = JSON.parse(await readFile(normalized.diagnosticRef!, "utf8")) as Record<
      string,
      unknown
    >;
    expect(diagnostic).toMatchObject({
      version: 1,
      operation: "start",
      createdAt: "2026-08-26T00:00:00.000Z",
      taskStatePath: join(root, "task.json"),
      originalError: { code: "internal_error", message: "simulated prepare failure" },
      cleanupError: {
        code: "cleanup_unproven",
        message:
          "prepareWorktree failed before returning a session, so Host cannot prove its internal cleanup completed.",
      },
    });
  });

  it("removes the Task root when a returned Worktree can be cleaned after later start failure", async () => {
    const root = await taskRoot();
    const missingStatePath = join(root, "missing-session.json");
    let disposed = false;
    const host = new EmbeddedTaskHost({
      createTaskRoot: async () => root,
      prepareWorktree: async () => preparedSession(missingStatePath, root),
      disposeWorktree: async (statePath, discard) => {
        expect(statePath).toBe(missingStatePath);
        expect(discard).toBe(true);
        disposed = true;
      },
    });

    await expect(host.start(root)).rejects.toThrow();
    expect(disposed).toBe(true);
    expect(await exists(root)).toBe(false);
  });

  it("preserves Task root, lock, and diagnostic when cleanup of a returned Worktree fails", async () => {
    const root = await taskRoot();
    const missingStatePath = join(root, "missing-session.json");
    const host = new EmbeddedTaskHost({
      createTaskRoot: async () => root,
      prepareWorktree: async () => preparedSession(missingStatePath, root),
      disposeWorktree: async () => {
        throw new Error("simulated cleanup failure");
      },
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    let thrown: unknown;
    try {
      await host.start(root);
    } catch (error) {
      thrown = error;
    }
    const normalized = normalizeHostError(thrown);
    expect(normalized).toMatchObject({
      code: "start_state_ambiguous",
      diagnosticRef: expect.any(String),
    });
    expect(await exists(root)).toBe(true);
    expect(await exists(join(root, "task.json.lock"))).toBe(true);

    const diagnostic = JSON.parse(await readFile(normalized.diagnosticRef!, "utf8")) as Record<
      string,
      unknown
    >;
    expect(diagnostic).toMatchObject({
      operation: "start",
      preparedWorktreeStatePath: missingStatePath,
      cleanupError: { code: "internal_error", message: "simulated cleanup failure" },
    });
  });
});
