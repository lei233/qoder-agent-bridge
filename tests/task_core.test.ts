import { describe, expect, it } from "vitest";
import {
  assertTaskInvariants,
  attachInitialWorktreeSession,
  blockTask,
  createTask,
  finishInvocation,
  freezeCandidate,
  resolveApplied,
  resolveDiscarded,
  resolveFailed,
  startInitial,
  startRepair,
  startRetry,
  unblockTask,
  type Candidate,
  type Task,
} from "@qoder-agent-bridge/core";

function bootstrap() {
  return attachInitialWorktreeSession(createTask({ id: "task-1" }), {
    id: "wt-1",
    statePath: "/tmp/wt-1/session.json",
    predecessorId: null,
  });
}

function successfulInitial() {
  return finishInvocation(startInitial(bootstrap(), { invocationId: "inv-1" }), {
    invocationId: "inv-1",
    status: "succeeded",
    resultRef: "/tmp/task/invocations/inv-1/result.json",
  });
}

function failedInitial() {
  return finishInvocation(startInitial(bootstrap(), { invocationId: "inv-1" }), {
    invocationId: "inv-1",
    status: "failed",
    resultRef: "/tmp/task/invocations/inv-1/result.json",
  });
}

function candidate(id = "candidate-1", invocationId = "inv-1", worktreeId = "wt-1"): Candidate {
  return {
    id,
    producingInvocationId: invocationId,
    worktreeSessionId: worktreeId,
    baselineTree: "tree-1",
    patchPath: `/tmp/task/candidates/${id}.patch`,
    patchSha256: `sha-${id}`,
    changedFiles: ["a.ts", "b.ts"],
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

describe("Task Core", () => {
  it("creates a legal bootstrap task", () => {
    const task = createTask({ id: "task-1" });
    expect(task).toMatchObject({
      schemaVersion: 1,
      version: 0,
      lifecycle: "open",
      outcome: null,
      operability: "normal",
      activeInvocationId: null,
      activeCandidateId: null,
      activeWorktreeSessionId: null,
      invocations: [],
      worktreeSessions: [],
      candidates: [],
    });
    expect(() => assertTaskInvariants(task)).not.toThrow();
  });

  it("attaches exactly one initial worktree and increments version once", () => {
    const task = bootstrap();
    expect(task.version).toBe(1);
    expect(task.activeWorktreeSessionId).toBe("wt-1");
    expect(task.worktreeSessions).toHaveLength(1);
    expect(() =>
      attachInitialWorktreeSession(task, {
        id: "wt-2",
        statePath: "/tmp/wt-2/session.json",
        predecessorId: null,
      }),
    ).toThrow(/already attached/);
  });

  it("allows only one initial invocation and one active invocation", () => {
    const running = startInitial(bootstrap(), { invocationId: "inv-1" });
    expect(running.version).toBe(2);
    expect(running.activeInvocationId).toBe("inv-1");
    expect(() => startInitial(running, { invocationId: "inv-2" })).toThrow(/active invocation/);

    const finished = finishInvocation(running, {
      invocationId: "inv-1",
      status: "failed",
      resultRef: "/tmp/task/invocations/inv-1/result.json",
    });
    expect(finished.version).toBe(3);
    expect(finished.lifecycle).toBe("open");
    expect(finished.activeInvocationId).toBeNull();
    expect(() => startInitial(finished, { invocationId: "inv-2" })).toThrow(/already exists/);
  });

  it("maintains the ordered invocation predecessor chain", () => {
    const retried = startRetry(failedInitial(), {
      invocationId: "inv-2",
      worktree: { type: "current" },
    });
    expect(retried.invocations[1]).toMatchObject({
      id: "inv-2",
      kind: "retry",
      predecessorInvocationId: "inv-1",
      worktreeSessionId: "wt-1",
    });
  });

  it("freezes an immutable candidate only after success", () => {
    const source = candidate();
    const task = freezeCandidate(successfulInitial(), source);
    source.changedFiles.push("later.ts");
    expect(task.activeCandidateId).toBe("candidate-1");
    expect(task.candidates[0]?.changedFiles).toEqual(["a.ts", "b.ts"]);
    expect(() => freezeCandidate(task, candidate("candidate-2"))).toThrow(/already produced/);
    expect(() => freezeCandidate(failedInitial(), candidate())).toThrow(/must have succeeded/);
  });

  it("rejects empty, duplicate, and non-canonical candidate changedFiles", () => {
    const task = successfulInitial();
    expect(() => freezeCandidate(task, { ...candidate(), changedFiles: [] })).toThrow(/non-empty/);
    expect(() => freezeCandidate(task, { ...candidate(), changedFiles: ["a.ts", "a.ts"] })).toThrow(/unique/);
    expect(() => freezeCandidate(task, { ...candidate(), changedFiles: ["b.ts", "a.ts"] })).toThrow(/canonically ordered/);
  });

  it("starts repair only after success with an active candidate and clears it", () => {
    const reviewed = freezeCandidate(successfulInitial(), candidate());
    const repaired = startRepair(reviewed, { invocationId: "inv-2" });
    expect(repaired.activeCandidateId).toBeNull();
    expect(repaired.activeInvocationId).toBe("inv-2");
    expect(repaired.invocations.at(-1)).toMatchObject({
      kind: "repair",
      predecessorInvocationId: "inv-1",
      worktreeSessionId: "wt-1",
    });
    expect(repaired.candidates).toHaveLength(1);
    expect(() => startRepair(successfulInitial(), { invocationId: "inv-2" })).toThrow(/active candidate/);
  });

  it("retries a failed invocation on the current worktree without appending a session", () => {
    const failed = failedInitial();
    const retried = startRetry(failed, {
      invocationId: "inv-2",
      worktree: { type: "current" },
    });
    expect(retried.version).toBe(failed.version + 1);
    expect(retried.worktreeSessions).toHaveLength(1);
    expect(retried.activeWorktreeSessionId).toBe("wt-1");
    expect(retried.invocations.at(-1)?.worktreeSessionId).toBe("wt-1");
  });

  it("atomically retries a failed invocation on an immediate successor worktree", () => {
    const failed = failedInitial();
    const retried = startRetry(failed, {
      invocationId: "inv-2",
      worktree: {
        type: "successor",
        session: {
          id: "wt-2",
          statePath: "/tmp/wt-2/session.json",
          predecessorId: "wt-1",
        },
      },
    });
    expect(retried.version).toBe(failed.version + 1);
    expect(retried.worktreeSessions).toHaveLength(2);
    expect(retried.activeWorktreeSessionId).toBe("wt-2");
    expect(retried.invocations.at(-1)).toMatchObject({
      kind: "retry",
      worktreeSessionId: "wt-2",
      predecessorInvocationId: "inv-1",
    });
  });

  it("rejects retry unless the predecessor failed and there is no active candidate", () => {
    expect(() =>
      startRetry(successfulInitial(), { invocationId: "inv-2", worktree: { type: "current" } }),
    ).toThrow(/failed predecessor/);

    const malformed = freezeCandidate(successfulInitial(), candidate());
    expect(() =>
      startRetry(malformed, { invocationId: "inv-2", worktree: { type: "current" } }),
    ).toThrow(/no active candidate/);
  });

  it("binds applied outcome permanently to the active candidate", () => {
    const task = freezeCandidate(successfulInitial(), candidate());
    expect(() => resolveApplied(task, "other")).toThrow(/not active/);
    const applied = resolveApplied(task, "candidate-1");
    expect(applied).toMatchObject({
      lifecycle: "closed",
      outcome: "applied",
      appliedCandidateId: "candidate-1",
      activeCandidateId: null,
    });
    expect(applied.candidates).toHaveLength(1);
    expect(() => startRepair(applied, { invocationId: "inv-2" })).toThrow(/closed/);
  });

  it("supports explicit discard independently of resource cleanup", () => {
    const discarded = resolveDiscarded(freezeCandidate(successfulInitial(), candidate()));
    expect(discarded).toMatchObject({
      lifecycle: "closed",
      outcome: "discarded",
      activeCandidateId: null,
      appliedCandidateId: null,
    });
  });

  it("only resolveFailed closes a task as failed", () => {
    const failedInvocation = failedInitial();
    expect(failedInvocation.lifecycle).toBe("open");
    expect(failedInvocation.outcome).toBeNull();
    const failedTask = resolveFailed(failedInvocation);
    expect(failedTask).toMatchObject({ lifecycle: "closed", outcome: "failed" });
  });

  it("blocks and unblocks only an idle open task", () => {
    const task = bootstrap();
    const blocked = blockTask(task, "manual diagnosis required");
    expect(blocked).toMatchObject({ operability: "blocked", blockReason: "manual diagnosis required" });
    expect(() => startInitial(blocked, { invocationId: "inv-1" })).toThrow(/blocked/);
    const normal = unblockTask(blocked);
    expect(normal).toMatchObject({ operability: "normal", blockReason: null });
  });

  it("increments version exactly once for each successful mutation", () => {
    let task = createTask({ id: "task-1" });
    expect(task.version).toBe(0);
    task = attachInitialWorktreeSession(task, {
      id: "wt-1",
      statePath: "/tmp/wt-1/session.json",
      predecessorId: null,
    });
    expect(task.version).toBe(1);
    task = startInitial(task, { invocationId: "inv-1" });
    expect(task.version).toBe(2);
    task = finishInvocation(task, {
      invocationId: "inv-1",
      status: "succeeded",
      resultRef: "/tmp/task/invocations/inv-1/result.json",
    });
    expect(task.version).toBe(3);
    task = freezeCandidate(task, candidate());
    expect(task.version).toBe(4);
    task = startRepair(task, { invocationId: "inv-2" });
    expect(task.version).toBe(5);
  });

  it("rejects malformed rehydrated task histories", () => {
    const valid = successfulInitial();
    const brokenInvocation = structuredClone(valid) as Task;
    brokenInvocation.invocations[0]!.kind = "retry";
    expect(() => assertTaskInvariants(brokenInvocation)).toThrow(/first invocation must be initial/);

    const brokenWorktree = structuredClone(valid) as Task;
    brokenWorktree.activeWorktreeSessionId = "missing";
    expect(() => assertTaskInvariants(brokenWorktree)).toThrow(/lineage tip/);

    const runningWithoutActive = structuredClone(startInitial(bootstrap(), { invocationId: "inv-1" })) as Task;
    runningWithoutActive.activeInvocationId = null;
    expect(() => assertTaskInvariants(runningWithoutActive)).toThrow(/running invocation must be active/);
  });
});
