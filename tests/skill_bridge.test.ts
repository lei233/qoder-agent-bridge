import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RUNNER_VERSION,
  disposeWorktree,
  type ParsedRunnerArgs,
  type RunnerEnvelope,
  type RunnerExecution,
} from "@qoder-agent-bridge/core";
import { executeTaskCommand, parseTaskArgs } from "../packages/cli/src/qoder-agent-task";
import {
  EmbeddedTaskHost,
  discardPreparedSuccessorRetry,
  inspectTaskWorkspace,
  prepareSuccessorRetry,
  runPreparedSuccessorRetry,
  type EmbeddedTaskHostDependencies,
  type SkillBridgeDependencies,
} from "../packages/cli/src/task-host";

const fixtures: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "qoder-skill-bridge-test-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Qoder Skill Bridge Test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function envelope(cwd: string, status: "succeeded" | "failed"): RunnerEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runnerVersion: RUNNER_VERSION,
    status,
    cwd,
    executable: "fake-qoder",
    permissionMode: "auto",
    outputFormat: "json",
    exitCode: status === "succeeded" ? 0 : 1,
    signal: null,
    durationMs: 1,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    qoderOutput: { format: "json", raw: "" },
    retryable: false,
    recovery: null,
    error: status === "succeeded" ? undefined : { code: "fake_failure", message: "fake failure" },
  };
}

function deterministicIds(): NonNullable<EmbeddedTaskHostDependencies["createId"]> {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function runnerOptions() {
  return {
    prompt: "continue the bounded task",
    promptFile: undefined,
    qodercliPath: undefined,
    model: undefined,
    timeoutMs: undefined,
    maxModelRequestRetries: undefined,
  };
}

function failedRunner(): (parsed: ParsedRunnerArgs) => Promise<RunnerExecution> {
  return async (parsed) => {
    await writeFile(join(parsed.cwd, "tracked.txt"), "partial-failed\n");
    return { envelope: envelope(parsed.cwd, "failed"), exitCode: 1 };
  };
}

function successfulRunner(): (parsed: ParsedRunnerArgs) => Promise<RunnerExecution> {
  return async (parsed) => {
    await writeFile(join(parsed.cwd, "tracked.txt"), "success\n");
    return { envelope: envelope(parsed.cwd, "succeeded"), exitCode: 0 };
  };
}

async function startFailedTask(source: string) {
  const host = new EmbeddedTaskHost({
    executeRunner: failedRunner(),
    createId: deterministicIds(),
  });
  const started = await host.start(source);
  fixtures.push(started.taskRoot);
  const failed = await host.run(started.taskStatePath, runnerOptions());
  expect(failed.task.invocations.at(-1)?.status).toBe("failed");
  return { host, started, failed };
}

describe("Skill task bridge", () => {
  it("returns a task-facing workspace and retry eligibility without Worktree plumbing", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);

    const inspection = await inspectTaskWorkspace(started.taskStatePath);
    expect(inspection.workspace.changedFiles).toEqual(["tracked.txt"]);
    expect(inspection.retryEligibility).toEqual({ current: true, blockers: [] });
    expect(await readFile(join(inspection.workspace.cwd, "tracked.txt"), "utf8")).toBe(
      "partial-failed\n",
    );
    const serializedWorkspace = JSON.stringify(inspection.workspace);
    expect(serializedWorkspace).not.toContain('"statePath"');
    expect(serializedWorkspace).not.toContain('"worktreeRoot"');
    expect(serializedWorkspace).not.toContain('"qoderCwd"');
    expect(serializedWorkspace).not.toContain('"indexModified"');
    expect(serializedWorkspace).not.toContain('"phase"');

    await host.discard(started.taskStatePath);
  });

  it("uses an opaque Task-owned preparation ID without mutating Task lineage", async () => {
    const source = await createFixture();
    const { host, started, failed } = await startFailedTask(source);

    const prepared = await prepareSuccessorRetry(started.taskStatePath, {
      createPreparationId: () => "prep-1",
    });
    const afterPrepare = await host.get(started.taskStatePath);
    expect(afterPrepare.version).toBe(failed.task.version);
    expect(afterPrepare.worktreeSessions).toHaveLength(1);
    expect(prepared.preparationId).toBe("prep-1");
    expect(await readFile(join(prepared.workspace.cwd, "tracked.txt"), "utf8")).toBe("base\n");
    expect(JSON.stringify(prepared)).not.toContain("StatePath");

    await discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId);
    await host.discard(started.taskStatePath);
  });

  it("attaches and runs only the workspace bound to the approved preparation ID", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath, {
      createPreparationId: () => "prep-1",
    });
    let runnerSaw = "";
    const bridgeDependencies: SkillBridgeDependencies = {
      executeRunner: async (parsed) => {
        expect(parsed.cwd).toBe(prepared.workspace.cwd);
        runnerSaw = await readFile(join(parsed.cwd, "tracked.txt"), "utf8");
        await writeFile(join(parsed.cwd, "tracked.txt"), "successor-success\n");
        return { envelope: envelope(parsed.cwd, "succeeded"), exitCode: 0 };
      },
      createId: (prefix) => (prefix === "inv" ? "inv-successor" : "wt-successor"),
    };

    const retried = await runPreparedSuccessorRetry(
      started.taskStatePath,
      prepared.preparationId,
      runnerOptions(),
      undefined,
      bridgeDependencies,
    );

    expect(runnerSaw).toBe("base\n");
    expect(retried.task.worktreeSessions).toHaveLength(2);
    expect(retried.task.worktreeSessions.at(-1)).toMatchObject({
      id: "wt-successor",
      predecessorId: "wt-1",
    });
    expect(retried.task.invocations.at(-1)).toMatchObject({
      id: "inv-successor",
      kind: "retry",
      status: "succeeded",
      worktreeSessionId: "wt-successor",
    });

    await host.discard(started.taskStatePath);
  });

  it("rejects stale preparation for execution but still allows explicit cleanup", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath, {
      createPreparationId: () => "prep-stale",
    });

    await host.fail(started.taskStatePath);
    await expect(
      runPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId, runnerOptions()),
    ).rejects.toMatchObject({ code: "retry_preparation_stale" });
    await expect(
      discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId),
    ).resolves.toBeUndefined();

    const closed = await host.get(started.taskStatePath);
    await disposeWorktree(closed.worktreeSessions[0]!.statePath, true);
  });

  it("rejects prepared workspace drift before Runner execution", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath, {
      createPreparationId: () => "prep-drift",
    });
    await writeFile(join(prepared.workspace.cwd, "tracked.txt"), "drifted-after-disclosure\n");

    await expect(
      runPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId, runnerOptions()),
    ).rejects.toMatchObject({ code: "retry_preparation_changed" });

    await writeFile(join(prepared.workspace.cwd, "tracked.txt"), "base\n");
    await discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId);
    await host.discard(started.taskStatePath);
  });

  it("preserves the Task lock when prepared-workspace cleanup is ambiguous", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath, {
      createPreparationId: () => "prep-cleanup",
    });

    await expect(
      discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId, {
        disposeWorktree: async () => {
          throw new Error("simulated prepared cleanup failure");
        },
      }),
    ).rejects.toMatchObject({ code: "prepared_retry_cleanup_ambiguous" });
    await expect(host.fail(started.taskStatePath)).rejects.toMatchObject({ code: "task_locked" });

    await unlink(`${started.taskStatePath}.lock`);
    await discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparationId);
    await host.discard(started.taskStatePath);
  });

  it("normal Task CLI results omit low-level Task and Runner mechanics", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: successfulRunner(),
      createId: deterministicIds(),
    });
    const started = await host.start(source);
    fixtures.push(started.taskRoot);

    const inspected = await executeTaskCommand(["inspect", "--task", started.taskStatePath], {
      host,
    });
    expect(JSON.stringify(inspected)).not.toContain('"statePath"');
    expect(JSON.stringify(inspected)).not.toContain('"worktreeSessions"');

    const ran = await executeTaskCommand(
      ["run", "--task", started.taskStatePath, "--prompt", "do it"],
      { host },
    );
    const serialized = JSON.stringify(ran);
    expect(serialized).not.toContain('"cwd"');
    expect(serialized).not.toContain('"executable"');
    expect(serialized).not.toContain('"recovery"');
    expect(serialized).not.toContain('"worktreeSessions"');

    await host.discard(started.taskStatePath);
  });
});

describe("Skill-facing Task CLI parsing", () => {
  it("uses policy strategies and opaque preparation IDs for retry", () => {
    expect(parseTaskArgs(["prepare-retry", "--task", "/tmp/task.json"])).toMatchObject({
      command: "prepare-retry",
    });
    expect(() =>
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--strategy",
        "restart",
        "--prompt",
        "continue",
      ]),
    ).toThrow(/--preparation/);
    expect(
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--strategy",
        "restart",
        "--preparation",
        "prep-1",
        "--prompt",
        "continue",
      ]),
    ).toMatchObject({
      command: "retry",
      strategy: "restart",
      worktree: "successor",
      preparation: "prep-1",
    });
  });

  it("keeps the old worktree selector as a compatibility alias", () => {
    expect(
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--worktree",
        "current",
        "--prompt",
        "continue",
      ]),
    ).toMatchObject({ command: "retry", strategy: "continue", worktree: "current" });
  });

  it("uses one Task-managed Runner ceiling without a long-task CLI mode", () => {
    expect(parseTaskArgs(["run", "--task", "/tmp/task.json", "--prompt", "work"])).toMatchObject({
      command: "run",
      runner: { timeoutMs: String(MAX_TIMEOUT_MS) },
    });
    expect(() =>
      parseTaskArgs(["run", "--task", "/tmp/task.json", "--prompt", "work", "--long-task"]),
    ).toThrow(/Unsupported/);
    expect(() =>
      parseTaskArgs(["run", "--task", "/tmp/task.json", "--prompt", "work", "--timeout-ms", "123"]),
    ).toThrow(/Unsupported/);
  });

  it("rejects Task-level recover and raw prepared-state plumbing", () => {
    expect(() => parseTaskArgs(["recover", "--task", "/tmp/task.json"])).toThrow(/Use start/);
    expect(() =>
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--worktree",
        "successor",
        "--prepared-state",
        "/tmp/session.json",
        "--prompt",
        "continue",
      ]),
    ).toThrow(/Unsupported/);
  });
});
