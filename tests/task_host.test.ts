import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  RUNNER_VERSION,
  WorktreeError,
  applyReviewPatch,
  blockTask,
  disposeWorktree,
  inspectWorktree,
  type ParsedRunnerArgs,
  type RunnerEnvelope,
  type RunnerExecution,
} from "@qoder-agent-bridge/core";
import { parseTaskArgs } from "../packages/cli/src/qoder-agent-task";
import {
  EmbeddedTaskHost,
  TaskFileStore,
  acquireTaskLock,
  type EmbeddedTaskHostDependencies,
} from "../packages/cli/src/task-host";

const fixtures: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "qoder-task-host-test-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Qoder Task Host Test"]);
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

function runnerSequence(
  statuses: ("succeeded" | "failed")[],
  observe?: (parsed: ParsedRunnerArgs, call: number) => Promise<void>,
): (parsed: ParsedRunnerArgs) => Promise<RunnerExecution> {
  let call = 0;
  return async (parsed) => {
    call += 1;
    await observe?.(parsed, call);
    await writeFile(join(parsed.cwd, "tracked.txt"), `run-${call}\n`);
    const status = statuses[call - 1] ?? "succeeded";
    return { envelope: envelope(parsed.cwd, status), exitCode: status === "succeeded" ? 0 : 1 };
  };
}

function runnerOptions() {
  return {
    prompt: "make the requested change",
    promptFile: undefined,
    qodercliPath: undefined,
    model: undefined,
    timeoutMs: undefined,
    maxModelRequestRetries: undefined,
  };
}

async function startTracked(host: EmbeddedTaskHost, source: string) {
  const started = await host.start(source);
  fixtures.push(started.taskRoot);
  return started;
}

describe("Embedded Task Host", () => {
  it("runs, freezes, repairs, replaces the Candidate, and applies exact bytes", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["succeeded", "succeeded"]),
      createId: deterministicIds(),
      now: () => new Date("2026-08-25T00:00:00.000Z"),
    });
    const started = await startTracked(host, source);

    const initial = await host.run(started.taskStatePath, runnerOptions());
    expect(initial.task.invocations.at(-1)?.status).toBe("succeeded");
    expect(await readFile(initial.resultRef, "utf8")).toContain('"stage": "runner"');

    const first = await host.candidate(started.taskStatePath);
    const firstPatch = await readFile(first.candidate.patchPath);
    expect(first.candidate.changedFiles).toEqual(["tracked.txt"]);

    const repaired = await host.repair(started.taskStatePath, runnerOptions());
    expect(repaired.task.invocations.at(-1)).toMatchObject({
      kind: "repair",
      status: "succeeded",
    });
    expect(repaired.task.activeCandidateId).toBeNull();
    expect(repaired.resultRef).not.toBe(initial.resultRef);
    expect(await readFile(initial.resultRef, "utf8")).toContain('"invocationId": "inv-1"');
    expect(await readFile(repaired.resultRef, "utf8")).toContain('"invocationId": "inv-2"');

    const second = await host.candidate(started.taskStatePath);
    expect(second.candidate.id).not.toBe(first.candidate.id);
    expect(await readFile(first.candidate.patchPath)).toEqual(firstPatch);

    const applied = await host.apply(started.taskStatePath, second.candidate.id);
    expect(applied.cleanupIncomplete).toBe(false);
    expect(applied.task).toMatchObject({
      lifecycle: "closed",
      outcome: "applied",
      appliedCandidateId: second.candidate.id,
    });
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("run-2\n");
  });

  it("rejects Candidate freeze before Worktree review when the Invocation failed", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["failed"]),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    const failed = await host.run(started.taskStatePath, runnerOptions());
    const statePath = failed.task.worktreeSessions[0]?.statePath;
    expect(statePath).toBeDefined();

    await expect(host.candidate(started.taskStatePath)).rejects.toThrow(/must have succeeded/);
    const inspection = await inspectWorktree(statePath!);
    expect(inspection.session.phase).toBe("prepared");

    await host.discard(started.taskStatePath);
  });

  it("retries a failed Invocation on the current WorktreeSession", async () => {
    const source = await createFixture();
    let retrySaw = "";
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["failed", "succeeded"], async (parsed, call) => {
        if (call === 2) {
          retrySaw = await readFile(join(parsed.cwd, "tracked.txt"), "utf8");
        }
      }),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    const failed = await host.run(started.taskStatePath, runnerOptions());
    expect(failed.task.lifecycle).toBe("open");
    expect(failed.task.invocations.at(-1)?.status).toBe("failed");

    const retried = await host.retry(started.taskStatePath, "current", runnerOptions());
    expect(retrySaw).toBe("run-1\n");
    expect(retried.task.worktreeSessions).toHaveLength(1);
    expect(retried.task.invocations.at(-1)).toMatchObject({ kind: "retry", status: "succeeded" });
    const candidate = await host.candidate(started.taskStatePath);
    expect(candidate.candidate.changedFiles).toEqual(["tracked.txt"]);
    await host.discard(started.taskStatePath);
  });

  it("retries on an immediate successor without carrying failed partial work", async () => {
    const source = await createFixture();
    let successorSaw = "";
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["failed", "succeeded"], async (parsed, call) => {
        if (call === 2) {
          successorSaw = await readFile(join(parsed.cwd, "tracked.txt"), "utf8");
        }
      }),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    await host.run(started.taskStatePath, runnerOptions());
    const retried = await host.retry(started.taskStatePath, "successor", runnerOptions());

    expect(successorSaw).toBe("base\n");
    expect(retried.task.worktreeSessions).toHaveLength(2);
    expect(retried.task.worktreeSessions[1]).toMatchObject({ predecessorId: "wt-1" });
    expect(retried.task.invocations.at(-1)).toMatchObject({
      kind: "retry",
      worktreeSessionId: "wt-2",
      status: "succeeded",
    });
    await host.discard(started.taskStatePath);
  });

  it("validates Task apply authorization before modifying the source", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["succeeded"]),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    await host.run(started.taskStatePath, runnerOptions());
    const frozen = await host.candidate(started.taskStatePath);

    const store = new TaskFileStore(started.taskStatePath);
    await store.save(blockTask(frozen.task, "manual diagnosis"));
    await expect(host.apply(started.taskStatePath, frozen.candidate.id)).rejects.toThrow(/blocked/);
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("base\n");

    await host.discard(started.taskStatePath);
  });

  it("rejects a changed immutable Candidate artifact before source apply", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["succeeded"]),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    await host.run(started.taskStatePath, runnerOptions());
    const frozen = await host.candidate(started.taskStatePath);
    await writeFile(frozen.candidate.patchPath, "tampered\n");

    await expect(host.apply(started.taskStatePath, frozen.candidate.id)).rejects.toMatchObject({
      code: "candidate_artifact_changed",
    });
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("base\n");

    await host.discard(started.taskStatePath);
  });

  it("resolves applied when Worktree reports cleanup failure after source apply", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["succeeded"]),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    await host.run(started.taskStatePath, runnerOptions());
    const frozen = await host.candidate(started.taskStatePath);
    const cleanupFailureHost = new EmbeddedTaskHost({
      applyReviewPatch: async (statePath) => {
        await applyReviewPatch(statePath);
        throw new WorktreeError("cleanup_failed", "simulated cleanup report");
      },
    });

    const applied = await cleanupFailureHost.apply(started.taskStatePath, frozen.candidate.id);
    expect(applied.cleanupIncomplete).toBe(true);
    expect(applied.task).toMatchObject({
      lifecycle: "closed",
      outcome: "applied",
      appliedCandidateId: frozen.candidate.id,
    });
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("run-1\n");
  });

  it("preserves the Task lock when Worktree apply completion is ambiguous", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["succeeded"]),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    await host.run(started.taskStatePath, runnerOptions());
    const frozen = await host.candidate(started.taskStatePath);
    const ambiguousHost = new EmbeddedTaskHost({
      applyReviewPatch: async () => {
        throw new Error("simulated post-apply state uncertainty");
      },
    });

    await expect(
      ambiguousHost.apply(started.taskStatePath, frozen.candidate.id),
    ).rejects.toMatchObject({
      code: "apply_state_ambiguous",
    });
    await expect(host.get(started.taskStatePath)).resolves.toMatchObject({
      lifecycle: "open",
      activeCandidateId: frozen.candidate.id,
    });
    await expect(host.discard(started.taskStatePath)).rejects.toMatchObject({
      code: "task_locked",
    });

    await unlink(`${started.taskStatePath}.lock`);
    await host.discard(started.taskStatePath);
  });

  it("rejects concurrent and stale-lock mutations while allowing read-only get", async () => {
    const source = await createFixture();
    const host = new EmbeddedTaskHost({
      executeRunner: runnerSequence(["succeeded"]),
      createId: deterministicIds(),
    });
    const started = await startTracked(host, source);
    const lock = await acquireTaskLock(started.taskStatePath);
    await expect(host.get(started.taskStatePath)).resolves.toMatchObject({ id: "task-1" });
    await expect(host.run(started.taskStatePath, runnerOptions())).rejects.toMatchObject({
      code: "task_locked",
    });

    await lock.preserveForDiagnosis();
    await lock.release();
    await expect(host.run(started.taskStatePath, runnerOptions())).rejects.toMatchObject({
      code: "task_locked",
    });
    await expect(host.get(started.taskStatePath)).resolves.toMatchObject({ lifecycle: "open" });
    await unlink(`${started.taskStatePath}.lock`);
    await host.discard(started.taskStatePath);
  });

  it("persists discard before reporting cleanup failure", async () => {
    const source = await createFixture();
    const realHost = new EmbeddedTaskHost({ createId: deterministicIds() });
    const started = await startTracked(realHost, source);
    const failingCleanupHost = new EmbeddedTaskHost({
      disposeWorktree: async () => {
        throw new WorktreeError("cleanup_failed", "simulated cleanup failure");
      },
    });

    const discarded = await failingCleanupHost.discard(started.taskStatePath);
    expect(discarded.cleanupIncomplete).toBe(true);
    expect(discarded.task).toMatchObject({ lifecycle: "closed", outcome: "discarded" });
    await expect(failingCleanupHost.get(started.taskStatePath)).resolves.toMatchObject({
      lifecycle: "closed",
      outcome: "discarded",
    });

    await disposeWorktree(started.statePath, true);
  });
});

describe("Task CLI parsing", () => {
  it("keeps retry strategy explicit and does not expose recover", () => {
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
    expect(() => parseTaskArgs(["recover", "--task", "/tmp/task.json"])).toThrow(/Use start/);
  });
});
