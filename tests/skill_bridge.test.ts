import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  RUNNER_VERSION,
  disposeWorktree,
  type ParsedRunnerArgs,
  type RunnerEnvelope,
  type RunnerExecution,
} from "@qoder-agent-bridge/core";
import { parseTaskArgs } from "../packages/cli/src/qoder-agent-task";
import {
  EmbeddedTaskHost,
  discardPreparedSuccessorRetry,
  inspectTaskWorktree,
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
  await Promise.all(
    fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
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
    error:
      status === "succeeded" ? undefined : { code: "fake_failure", message: "fake failure" },
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

function successfulPreparedRunner(observe: (cwd: string) => Promise<void>) {
  return async (parsed: ParsedRunnerArgs): Promise<RunnerExecution> => {
    await observe(parsed.cwd);
    await writeFile(join(parsed.cwd, "tracked.txt"), "successor-success\n");
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
  it("inspects failed partial work without advancing Worktree review state", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);

    const inspection = await inspectTaskWorktree(started.taskStatePath);
    expect(inspection).toMatchObject({
      phase: "prepared",
      hasChanges: true,
      changedFiles: ["tracked.txt"],
      indexModified: false,
    });
    expect(await readFile(join(inspection.qoderCwd, "tracked.txt"), "utf8")).toBe(
      "partial-failed\n",
    );

    await host.discard(started.taskStatePath);
  });

  it("prepares a successor for disclosure without mutating Task lineage", async () => {
    const source = await createFixture();
    const { host, started, failed } = await startFailedTask(source);

    const prepared = await prepareSuccessorRetry(started.taskStatePath);
    const afterPrepare = await host.get(started.taskStatePath);
    expect(afterPrepare.version).toBe(failed.task.version);
    expect(afterPrepare.worktreeSessions).toHaveLength(1);
    expect(prepared.predecessorWorktreeSessionId).toBe("wt-1");
    expect(await readFile(join(prepared.qoderCwd, "tracked.txt"), "utf8")).toBe("base\n");

    await discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparedStatePath);
    await expect(access(prepared.preparedStatePath)).rejects.toBeDefined();
    await host.discard(started.taskStatePath);
  });

  it("attaches and runs only the previously disclosed successor Worktree", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath);
    let runnerSaw = "";
    const bridgeDependencies: SkillBridgeDependencies = {
      executeRunner: successfulPreparedRunner(async (cwd) => {
        expect(cwd).toBe(prepared.qoderCwd);
        runnerSaw = await readFile(join(cwd, "tracked.txt"), "utf8");
      }),
      createId: (prefix) => (prefix === "inv" ? "inv-successor" : "wt-successor"),
    };

    const retried = await runPreparedSuccessorRetry(
      started.taskStatePath,
      prepared.preparedStatePath,
      runnerOptions(),
      undefined,
      bridgeDependencies,
    );

    expect(runnerSaw).toBe("base\n");
    expect(retried.task.worktreeSessions).toHaveLength(2);
    expect(retried.task.worktreeSessions.at(-1)).toMatchObject({
      id: "wt-successor",
      predecessorId: "wt-1",
      statePath: prepared.preparedStatePath,
    });
    expect(retried.task.invocations.at(-1)).toMatchObject({
      id: "inv-successor",
      kind: "retry",
      status: "succeeded",
      worktreeSessionId: "wt-successor",
    });

    await host.discard(started.taskStatePath);
  });

  it("rejects a prepared successor after Task state changes", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath);

    await host.fail(started.taskStatePath);
    await expect(
      runPreparedSuccessorRetry(
        started.taskStatePath,
        prepared.preparedStatePath,
        runnerOptions(),
      ),
    ).rejects.toMatchObject({ code: "retry_preparation_stale" });

    await disposeWorktree(prepared.preparedStatePath, true);
    const closed = await host.get(started.taskStatePath);
    await disposeWorktree(closed.worktreeSessions[0]!.statePath, true);
  });

  it("rejects successor drift before the approved Runner invocation", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath);
    await writeFile(join(prepared.qoderCwd, "tracked.txt"), "drifted-after-disclosure\n");

    await expect(
      runPreparedSuccessorRetry(
        started.taskStatePath,
        prepared.preparedStatePath,
        runnerOptions(),
      ),
    ).rejects.toMatchObject({ code: "retry_preparation_changed" });

    await writeFile(join(prepared.qoderCwd, "tracked.txt"), "base\n");
    await discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparedStatePath);
    await host.discard(started.taskStatePath);
  });

  it("preserves the Task lock when prepared-successor cleanup is ambiguous", async () => {
    const source = await createFixture();
    const { host, started } = await startFailedTask(source);
    const prepared = await prepareSuccessorRetry(started.taskStatePath);

    await expect(
      discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparedStatePath, {
        disposeWorktree: async () => {
          throw new Error("simulated prepared cleanup failure");
        },
      }),
    ).rejects.toMatchObject({ code: "prepared_retry_cleanup_ambiguous" });
    await expect(host.fail(started.taskStatePath)).rejects.toMatchObject({ code: "task_locked" });

    await unlink(`${started.taskStatePath}.lock`);
    await discardPreparedSuccessorRetry(started.taskStatePath, prepared.preparedStatePath);
    await host.discard(started.taskStatePath);
  });
});

describe("Skill-facing Task CLI parsing", () => {
  it("requires a disclosed prepared state for successor retry", () => {
    expect(parseTaskArgs(["prepare-retry", "--task", "/tmp/task.json"])).toMatchObject({
      command: "prepare-retry",
    });
    expect(() =>
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--worktree",
        "successor",
        "--prompt",
        "continue",
      ]),
    ).toThrow(/--prepared-state/);
    expect(
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--worktree",
        "successor",
        "--prepared-state",
        "/tmp/successor/session.json",
        "--prompt",
        "continue",
      ]),
    ).toMatchObject({
      command: "retry",
      worktree: "successor",
      preparedState: "/tmp/successor/session.json",
    });
  });

  it("keeps current retry simple and rejects Task-level recover", () => {
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
    ).toMatchObject({ command: "retry", worktree: "current" });
    expect(() =>
      parseTaskArgs([
        "retry",
        "--task",
        "/tmp/task.json",
        "--worktree",
        "current",
        "--prepared-state",
        "/tmp/unused/session.json",
        "--prompt",
        "continue",
      ]),
    ).toThrow(/successor retry/);
    expect(() => parseTaskArgs(["recover", "--task", "/tmp/task.json"])).toThrow(
      /Use start/,
    );
  });
});
