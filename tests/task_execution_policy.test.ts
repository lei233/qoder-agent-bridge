import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  RUNNER_VERSION,
  type ParsedRunnerArgs,
  type RunnerEnvelope,
} from "@qoder-agent-bridge/core";
import { parseTaskArgs } from "../packages/cli/src/qoder-agent-task";
import {
  DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
  DEFAULT_TASK_TIMEOUT_MS,
  EmbeddedTaskHost,
  resolveTaskExecutionPolicy,
} from "../packages/cli/src/task-host";

const fixtures: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "qoder-task-policy-test-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Qoder Task Policy Test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function envelope(cwd: string): RunnerEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runnerVersion: RUNNER_VERSION,
    status: "succeeded",
    cwd,
    executable: "fake-qoder",
    permissionMode: "auto",
    outputFormat: "json",
    exitCode: 0,
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
    error: undefined,
  };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Task Host execution policy", () => {
  it("uses Host defaults when deployment overrides are unset or empty", () => {
    expect(resolveTaskExecutionPolicy({})).toEqual({
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      maxModelRequestRetries: DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
      fallbacks: [],
    });
    expect(
      resolveTaskExecutionPolicy({
        QODER_TASK_TIMEOUT_MS: "",
        QODER_TASK_MAX_MODEL_REQUEST_RETRIES: "",
      }),
    ).toEqual({
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      maxModelRequestRetries: DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
      fallbacks: [],
    });
  });

  it("accepts bounded deployment overrides", () => {
    expect(
      resolveTaskExecutionPolicy({
        QODER_TASK_TIMEOUT_MS: "120000",
        QODER_TASK_MAX_MODEL_REQUEST_RETRIES: "5",
      }),
    ).toEqual({
      timeoutMs: 120000,
      maxModelRequestRetries: 5,
      fallbacks: [],
    });
  });

  it("silently falls back on invalid non-empty deployment overrides and records evidence", () => {
    expect(
      resolveTaskExecutionPolicy({
        QODER_TASK_TIMEOUT_MS: "not-a-number",
        QODER_TASK_MAX_MODEL_REQUEST_RETRIES: "999",
      }),
    ).toEqual({
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      maxModelRequestRetries: DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
      fallbacks: [
        "invalid QODER_TASK_TIMEOUT_MS",
        "invalid QODER_TASK_MAX_MODEL_REQUEST_RETRIES",
      ],
    });
  });

  it("injects Host policy into Runner args and immutable Invocation evidence", async () => {
    const source = await createFixture();
    let observed: ParsedRunnerArgs | null = null;
    const host = new EmbeddedTaskHost({
      env: {
        QODER_TASK_TIMEOUT_MS: "invalid",
        QODER_TASK_MAX_MODEL_REQUEST_RETRIES: "999",
        QODER_TIMEOUT_MS: "1",
        QODER_MAX_MODEL_REQUEST_RETRIES: "0",
      },
      executeRunner: async (parsed) => {
        observed = parsed;
        return { envelope: envelope(parsed.cwd), exitCode: 0 };
      },
    });
    const started = await host.start(source);
    fixtures.push(started.taskRoot);

    const result = await host.run(started.taskStatePath, {
      prompt: "make the requested change",
      promptFile: undefined,
      model: "preferred-model",
    });

    expect(observed).toMatchObject({
      qodercliPath: undefined,
      model: "preferred-model",
      timeoutMs: String(DEFAULT_TASK_TIMEOUT_MS),
      maxModelRequestRetries: String(DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES),
    });
    const artifact = JSON.parse(await readFile(result.resultRef, "utf8")) as Record<string, unknown>;
    expect(artifact.executionPolicy).toEqual({
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      maxModelRequestRetries: DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
      fallbacks: [
        "invalid QODER_TASK_TIMEOUT_MS",
        "invalid QODER_TASK_MAX_MODEL_REQUEST_RETRIES",
      ],
    });

    await host.discard(started.taskStatePath);
  });
});

describe("Task execution CLI boundary", () => {
  it("does not expose timeout, internal retry, long-task, or executable overrides", () => {
    const base = ["run", "--task", "/tmp/task.json", "--prompt", "change"];
    expect(() => parseTaskArgs([...base, "--timeout-ms", "1"])).toThrow(/Unsupported/);
    expect(() => parseTaskArgs([...base, "--long-task"])).toThrow(/Unsupported/);
    expect(() => parseTaskArgs([...base, "--max-model-request-retries", "9"])).toThrow(/Unsupported/);
    expect(() => parseTaskArgs([...base, "--qodercli-path", "/tmp/qodercli"])).toThrow(/Unsupported/);
  });

  it("keeps model as an Invocation preference", () => {
    expect(
      parseTaskArgs([
        "run",
        "--task",
        "/tmp/task.json",
        "--prompt",
        "change",
        "--model",
        "preferred-model",
      ]),
    ).toMatchObject({
      command: "run",
      runner: { model: "preferred-model" },
    });
  });
});
