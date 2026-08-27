import { EventEmitter } from "node:events";
import { spawnSync, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROMPT_LIMIT_BYTES,
  WINDOWS_COMMAND_LINE_LIMIT_UTF16,
  runQoder,
} from "@qoder-agent-bridge/core";
import { parseRunnerArgs, resultFileForPrompt } from "../packages/cli/src/run-qoder";
import {
  DEFAULT_MAX_MODEL_REQUEST_RETRIES,
  DEFAULT_TIMEOUT_MS,
  FIXED_SAFETY_POLICY,
  HARD_OUTPUT_LIMIT_BYTES,
} from "../packages/core/src/runner/constants";
import {
  buildQoderArgs,
  normalizeCwd,
  parseModelRequestRetries,
  parseTimeout,
  resolveConfig,
  resolveExecutable,
  resolvePrompt,
  validateWindowsCommandLine,
  windowsCommandLineLength,
} from "../packages/core/src/runner/config";
import { redactSecrets } from "../packages/core/src/runner/output";

const runnerPath = fileURLToPath(
  new URL("../dist/skills/qoder-agent/scripts/run_qoder.mjs", import.meta.url),
);

class FakeChild extends EventEmitter {
  pid = 4321;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/qoder-fixture",
    prompt: "Make the requested bounded change.",
    executable: "/tmp/qodercli",
    env: { RUNNER_TEST_ENV: "forwarded" },
    model: undefined,
    timeoutMs: 1000,
    maxModelRequestRetries: DEFAULT_MAX_MODEL_REQUEST_RETRIES,
    signal: undefined,
    ...overrides,
  };
}

function fakeFs(
  cwd = "/tmp/qoder-fixture",
  executablePaths: string[] = ["/tmp/qodercli"],
  promptFiles: Record<string, string | Buffer> = {},
) {
  const executableSet = new Set(executablePaths);
  const promptIdentity = { dev: 1n, ino: 2n };
  const promptStats = (value: string | Buffer) => ({
    ...promptIdentity,
    size: BigInt(Buffer.byteLength(value)),
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  return {
    stat: async (candidate: string) => {
      if (candidate === cwd) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (executableSet.has(candidate)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw new Error("missing");
    },
    access: async () => undefined,
    lstat: async (candidate: string) => {
      const value = promptFiles[candidate];
      if (value !== undefined) return promptStats(value);
      throw new Error("missing");
    },
    open: async (candidate: string) => {
      const value = promptFiles[candidate];
      if (value === undefined) throw new Error("missing");
      const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
      return {
        stat: async () => promptStats(contents),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytesRead = contents.copy(
            buffer,
            offset,
            position,
            Math.min(position + length, contents.length),
          );
          return { bytesRead };
        },
        close: async () => undefined,
      };
    },
    realpath: async (candidate: string) => (candidate === cwd ? "/real/qoder-fixture" : candidate),
  };
}

describe("Runner input and command construction", () => {
  it("requires an absolute cwd and a bounded non-empty prompt", () => {
    expect(() => parseRunnerArgs(["--prompt", "task"])).toThrow(/--cwd is required/);
    expect(() => parseRunnerArgs(["--cwd", "relative", "--prompt", "task"])).not.toThrow();
    expect(
      parseRunnerArgs([
        "--cwd",
        "/tmp",
        "--prompt",
        "task",
        "--qodercli-path",
        "/tmp/qodercli",
        "--timeout-ms",
        "123",
        "--max-model-request-retries",
        "4",
      ]),
    ).toMatchObject({
      qodercliPath: "/tmp/qodercli",
      timeoutMs: "123",
      maxModelRequestRetries: "4",
    });
    expect(() => parseRunnerArgs(["--cwd", "/tmp", "--prompt", " "])).toThrow(/--prompt/);
    expect(() =>
      parseRunnerArgs(["--cwd", "/tmp", "--prompt", "a".repeat(PROMPT_LIMIT_BYTES + 1)]),
    ).toThrow(/64 KiB/);
    expect(() => parseRunnerArgs(["--cwd", "/tmp", "--prompt", "task", "--unknown"])).toThrow(
      /Unsupported/,
    );
    expect(
      parseRunnerArgs(["--cwd", "/tmp", "--prompt-file", "/tmp/delegation-brief.md"]),
    ).toMatchObject({ prompt: undefined, promptFile: "/tmp/delegation-brief.md" });
    expect(() => parseRunnerArgs(["--cwd", "/tmp"])).toThrow(/Exactly one/);
    expect(() =>
      parseRunnerArgs([
        "--cwd",
        "/tmp",
        "--prompt",
        "task",
        "--prompt-file",
        "/tmp/delegation-brief.md",
      ]),
    ).toThrow(/Exactly one/);
  });

  it("constructs a fixed safe Qoder argument array", () => {
    const args = buildQoderArgs({
      cwd: "/real/project",
      prompt: "task --with-dashes",
      model: "test-model",
      maxModelRequestRetries: 3,
    });

    expect(args).toEqual([
      "--print",
      "--cwd",
      "/real/project",
      "--permission-mode",
      "auto",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--max-model-request-retries",
      "3",
      "--model",
      "test-model",
      "--append-system-prompt",
      FIXED_SAFETY_POLICY,
      "--",
      "task --with-dashes",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--tools");
  });

  it("measures and enforces the Windows UTF-16 command-line boundary", () => {
    expect(windowsCommandLineLength("qodercli.exe", [])).toBe("qodercli.exe".length + 1);
    expect(windowsCommandLineLength("q.exe", ["a b"])).toBe('q.exe "a b"'.length + 1);
    expect(windowsCommandLineLength("q.exe", ["😀"])).toBe("q.exe 😀".length + 1);
    expect(windowsCommandLineLength("q.exe", ['a"b\\'])).toBeGreaterThan('q.exe a"b\\'.length + 1);

    expect(() =>
      validateWindowsCommandLine("qodercli.exe", ["a".repeat(WINDOWS_COMMAND_LINE_LIMIT_UTF16)]),
    ).toThrow(/CreateProcessW/);
  });

  it("applies timeout defaults and bounds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(1_800_000);
    expect(parseTimeout(String(DEFAULT_TIMEOUT_MS))).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseTimeout("3600000")).toBe(3_600_000);
    expect(() => parseTimeout("0")).toThrow(/between/);
    expect(() => parseTimeout("3600001")).toThrow(/between/);
    expect(() => parseTimeout("not-a-number")).toThrow(/positive integer/);
  });

  it("bounds Qoder's internal model request retries", () => {
    expect(parseModelRequestRetries("0")).toBe(0);
    expect(parseModelRequestRetries("10")).toBe(10);
    expect(() => parseModelRequestRetries("11")).toThrow(/between 0 and 10/);
    expect(() => parseModelRequestRetries("-1")).toThrow(/integer/);
  });
});

describe("Runner preflight and resolution", () => {
  it("reads a bounded UTF-8 prompt from an absolute regular file", async () => {
    const promptFile = "/tmp/delegation-brief.md";
    const prompt = 'Use literal `backticks`, $(commands), and "quotes".';
    await expect(
      resolvePrompt(
        { prompt: undefined, promptFile },
        fakeFs("/tmp/qoder-fixture", ["/tmp/qodercli"], { [promptFile]: prompt }),
      ),
    ).resolves.toBe(prompt);

    await expect(
      resolvePrompt({ prompt: undefined, promptFile: "relative.md" }, fakeFs()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      resolvePrompt(
        { prompt: undefined, promptFile },
        {
          ...fakeFs(),
          lstat: async () => ({
            dev: 1n,
            ino: 2n,
            size: 1n,
            isFile: () => false,
            isSymbolicLink: () => true,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      resolvePrompt(
        { prompt: undefined, promptFile },
        fakeFs("/tmp/qoder-fixture", ["/tmp/qodercli"], {
          [promptFile]: Buffer.alloc(PROMPT_LIMIT_BYTES + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolvePrompt({ prompt: "inline", promptFile }, fakeFs())).rejects.toThrow(
      /Exactly one/,
    );
    await expect(
      resolvePrompt({ prompt: undefined, promptFile: undefined }, fakeFs()),
    ).rejects.toThrow(/Exactly one/);
  });

  it("rejects oversized prompt files before reading and always closes the handle", async () => {
    const baseFs = fakeFs();
    let readCalled = false;
    let closed = false;
    const promptFile = "/tmp/oversized-brief.md";
    const oversizedStats = {
      dev: 1n,
      ino: 2n,
      size: 10_000_000_000n,
      isFile: () => true,
      isSymbolicLink: () => false,
    };

    await expect(
      resolvePrompt(
        { prompt: undefined, promptFile },
        {
          ...baseFs,
          lstat: async () => oversizedStats,
          open: async () => ({
            stat: async () => oversizedStats,
            read: async () => {
              readCalled = true;
              return { bytesRead: 0 };
            },
            close: async () => {
              closed = true;
            },
          }),
        },
      ),
    ).rejects.toThrow(/64 KiB/);

    expect(readCalled).toBe(false);
    expect(closed).toBe(true);
  });

  it("rejects replacement and growth using one bounded open handle", async () => {
    const baseFs = fakeFs();
    const promptFile = "/tmp/changing-brief.md";
    const pathStats = {
      dev: 1n,
      ino: 2n,
      size: 1n,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    let replacementRead = false;
    let replacementClosed = false;
    await expect(
      resolvePrompt(
        { prompt: undefined, promptFile },
        {
          ...baseFs,
          lstat: async () => pathStats,
          open: async () => ({
            stat: async () => ({ ...pathStats, ino: 3n }),
            read: async () => {
              replacementRead = true;
              return { bytesRead: 0 };
            },
            close: async () => {
              replacementClosed = true;
            },
          }),
        },
      ),
    ).rejects.toThrow(/changed identity/);
    expect(replacementRead).toBe(false);
    expect(replacementClosed).toBe(true);

    const growingContents = Buffer.alloc(PROMPT_LIMIT_BYTES + 1, "a");
    let maximumRequestedRead = 0;
    let growthClosed = false;
    await expect(
      resolvePrompt(
        { prompt: undefined, promptFile },
        {
          ...baseFs,
          lstat: async () => pathStats,
          open: async () => ({
            stat: async () => pathStats,
            read: async (buffer, offset, length, position) => {
              maximumRequestedRead = Math.max(maximumRequestedRead, length);
              return {
                bytesRead: growingContents.copy(
                  buffer,
                  offset,
                  position,
                  Math.min(position + length, growingContents.length),
                ),
              };
            },
            close: async () => {
              growthClosed = true;
            },
          }),
        },
      ),
    ).rejects.toThrow(/64 KiB/);
    expect(maximumRequestedRead).toBeLessThanOrEqual(PROMPT_LIMIT_BYTES + 1);
    expect(growthClosed).toBe(true);
  });

  it("normalizes an existing directory and rejects relative or file paths", async () => {
    const fsApi = fakeFs();
    await expect(normalizeCwd("/tmp/qoder-fixture", fsApi)).resolves.toBe("/real/qoder-fixture");
    await expect(normalizeCwd("relative", fsApi)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      normalizeCwd("/tmp/missing", {
        ...fsApi,
        stat: async () => ({ isDirectory: () => false, isFile: () => true }),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("uses CLI configuration before environment configuration and defaults", async () => {
    const fsApi = fakeFs("/tmp/qoder-fixture", ["/tmp/cli-qoder", "/tmp/env-qoder"]);
    const config = await resolveConfig(
      {
        cwd: "/tmp/qoder-fixture",
        prompt: "task",
        promptFile: undefined,
        qodercliPath: "/tmp/cli-qoder",
        model: "cli-model",
        timeoutMs: "123",
        maxModelRequestRetries: "4",
      },
      {
        PATH: "/tmp",
        QODERCLI_PATH: "/tmp/env-qoder",
        QODER_MODEL: "env-model",
        QODER_TIMEOUT_MS: "456",
        QODER_MAX_MODEL_REQUEST_RETRIES: "5",
      },
      fsApi,
    );

    expect(config).toMatchObject({
      cwd: "/real/qoder-fixture",
      executable: "/tmp/cli-qoder",
      model: "cli-model",
      timeoutMs: 123,
      maxModelRequestRetries: 4,
    });
  });

  it("uses environment configuration before the built-in defaults", async () => {
    const fsApi = fakeFs("/tmp/qoder-fixture", ["/tmp/env-qoder"]);
    const config = await resolveConfig(
      {
        cwd: "/tmp/qoder-fixture",
        prompt: "task",
        promptFile: undefined,
        qodercliPath: undefined,
        model: undefined,
        timeoutMs: undefined,
        maxModelRequestRetries: undefined,
      },
      {
        PATH: "/empty",
        QODERCLI_PATH: "/tmp/env-qoder",
        QODER_MODEL: "env-model",
        QODER_TIMEOUT_MS: "456",
        QODER_MAX_MODEL_REQUEST_RETRIES: "5",
      },
      fsApi,
    );

    expect(config).toMatchObject({
      executable: "/tmp/env-qoder",
      model: "env-model",
      timeoutMs: 456,
      maxModelRequestRetries: 5,
    });
  });

  it("resolves qodercli from PATH without assuming a developer home directory", async () => {
    await expect(
      resolveExecutable(
        undefined,
        { PATH: "/opt/qoder/bin" },
        fakeFs("/tmp/qoder-fixture", ["/opt/qoder/bin/qodercli"]),
      ),
    ).resolves.toBe("/opt/qoder/bin/qodercli");

    await expect(resolveExecutable(undefined, { PATH: "/empty" }, fakeFs())).rejects.toMatchObject({
      code: "executable_not_found",
      message: expect.stringContaining("QODERCLI_PATH"),
    });
  });

  it("resolves a native Windows executable and rejects command shims", async () => {
    await expect(
      resolveExecutable(
        undefined,
        { PATH: "/qoder/bin", PATHEXT: ".CMD;.EXE" },
        fakeFs("/tmp/qoder-fixture", ["/qoder/bin/qodercli.cmd", "/qoder/bin/qodercli.exe"]),
        "win32",
      ),
    ).resolves.toBe("/qoder/bin/qodercli.exe");

    await expect(
      resolveExecutable(
        "/qoder/bin/qodercli.cmd",
        { PATH: "/qoder/bin", PATHEXT: ".CMD;.EXE" },
        fakeFs("/tmp/qoder-fixture", ["/qoder/bin/qodercli.cmd"]),
        "win32",
      ),
    ).rejects.toMatchObject({
      code: "executable_not_found",
      message: expect.stringContaining("native qodercli executable"),
    });
  });

  it("does not fall back when an explicit executable path is invalid", async () => {
    await expect(
      resolveExecutable(
        "/tmp/invalid-qoder",
        { PATH: "/tmp" },
        fakeFs("/tmp/qoder-fixture", ["/tmp/qodercli"]),
      ),
    ).rejects.toMatchObject({ code: "executable_not_found" });
  });
});

describe("Runner process boundary and envelope", () => {
  it("returns a successful bounded envelope without parsing Qoder JSON", async () => {
    const child = new FakeChild();
    const calls: Array<{ executable: string; args: string[]; options: SpawnOptions }> = [];
    const resultPromise = runQoder(fakeConfig(), {
      spawnProcess: (executable: string, args: string[], options: SpawnOptions) => {
        calls.push({ executable, args, options });
        return child;
      },
    });

    child.stdout.emit("data", Buffer.from('{"result":"ok"}'));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      protocolVersion: 1,
      status: "succeeded",
      permissionMode: "auto",
      outputFormat: "json",
      exitCode: 0,
      stdout: '{"result":"ok"}',
      qoderOutput: { format: "json", raw: '{"result":"ok"}' },
    });
    expect(calls[0]?.options).toMatchObject({
      cwd: "/tmp/qoder-fixture",
      env: { RUNNER_TEST_ENV: "forwarded" },
      shell: false,
      detached: true,
      windowsHide: true,
    });
  });

  it("hides the Qoder console and does not detach it on Windows", async () => {
    const child = new FakeChild();
    const calls: Array<{ options: SpawnOptions }> = [];
    const resultPromise = runQoder(fakeConfig(), {
      platform: "win32",
      spawnProcess: (_executable: string, _args: string[], options: SpawnOptions) => {
        calls.push({ options });
        return child;
      },
    });
    child.emit("close", 0, null);
    await resultPromise;

    expect(calls[0]?.options).toMatchObject({ detached: false, windowsHide: true });
  });

  it("rejects an oversized Windows command line before spawning", async () => {
    let spawned = false;
    await expect(
      runQoder(fakeConfig({ prompt: "a".repeat(32_500) }), {
        platform: "win32",
        spawnProcess: () => {
          spawned = true;
          return new FakeChild();
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("Windows") });
    expect(spawned).toBe(false);
  });

  it("returns a non-zero Qoder exit as a failed envelope", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig(), { spawnProcess: () => child });
    child.emit("close", 7, null);
    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      status: "failed",
      exitCode: 7,
      error: { code: "qoder_exit_nonzero" },
    });
  });

  it("classifies exact model queue exhaustion as explicitly recoverable", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig(), { spawnProcess: () => child });
    child.stderr.emit("data", Buffer.from("model queue recovery attempts exceeded"));
    child.emit("close", 1, null);
    const result = await resultPromise;

    expect(result.envelope).toMatchObject({
      status: "failed",
      retryable: true,
      recovery: { strategy: "continue_in_existing_worktree" },
      error: { code: "model_queue_exhausted" },
    });
  });

  it("maps a missing child executable to spawn_error", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig(), { spawnProcess: () => child });
    const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      status: "spawn_error",
      error: { code: "executable_not_found" },
    });
  });

  it("terminates the process group on timeout and escalates after the grace period", async () => {
    const child = new FakeChild();
    const kills: Array<[number, NodeJS.Signals]> = [];
    const resultPromise = runQoder(fakeConfig({ timeoutMs: 5 }), {
      spawnProcess: () => child,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        kills.push([pid, signal]);
        if (signal === "SIGKILL") {
          child.emit("close", null, "SIGKILL");
        }
      },
      terminationGraceMs: 1,
    });
    const result = await resultPromise;

    expect(kills).toEqual([
      [-4321, "SIGTERM"],
      [-4321, "SIGKILL"],
    ]);
    expect(result.envelope).toMatchObject({
      status: "timed_out",
      timedOut: true,
      error: { code: "timed_out" },
    });
  });

  it("terminates the process group when interrupted", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const kills: Array<[number, NodeJS.Signals]> = [];
    const resultPromise = runQoder(fakeConfig({ signal: controller.signal }), {
      spawnProcess: () => child,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        kills.push([pid, signal]);
        child.emit("close", null, "SIGTERM");
      },
    });
    controller.abort("SIGINT");
    const result = await resultPromise;

    expect(kills).toEqual([[-4321, "SIGTERM"]]);
    expect(result.envelope).toMatchObject({ status: "failed", error: { code: "interrupted" } });
  });

  it("terminates a Windows process tree with hidden taskkill processes", async () => {
    const child = new FakeChild();
    const taskkills: Array<{
      executable: string;
      args: string[];
      options: SpawnOptions;
    }> = [];
    const resultPromise = runQoder(fakeConfig({ timeoutMs: 5 }), {
      platform: "win32",
      spawnProcess: () => child,
      spawnTreeKiller: (executable: string, args: string[], options: SpawnOptions) => {
        taskkills.push({ executable, args, options });
        const killer = new EventEmitter();
        if (args.includes("/f")) {
          queueMicrotask(() => child.emit("close", 1, null));
        }
        return killer;
      },
      terminationGraceMs: 1,
    });
    const result = await resultPromise;

    expect(taskkills).toEqual([
      {
        executable: "taskkill.exe",
        args: ["/pid", "4321", "/t"],
        options: { shell: false, windowsHide: true, stdio: "ignore" },
      },
      {
        executable: "taskkill.exe",
        args: ["/pid", "4321", "/t", "/f"],
        options: { shell: false, windowsHide: true, stdio: "ignore" },
      },
    ]);
    expect(result.envelope).toMatchObject({ status: "timed_out", timedOut: true });
  });

  it("truncates output, enforces the hard limit, and redacts credentials", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig({ prompt: "private task" }), {
      spawnProcess: () => child,
      killProcess: () => undefined,
      captureLimitBytes: 8,
      hardOutputLimitBytes: 32,
    });
    child.stdout.emit("data", Buffer.from("1234567890"));
    child.stdout.emit("data", Buffer.from("Bearer abcdefghijk token=secret-value private task"));
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(result.envelope.stdoutTruncated).toBe(true);
    expect(result.envelope.stdout).toContain("output truncated");
    expect(result.envelope.stdout).not.toContain("private task");
    expect(redactSecrets("Authorization: Bearer abcdefghijk api_key=secret-value")).toContain(
      "[REDACTED]",
    );

    const limitedChild = new FakeChild();
    const kills: Array<[number, NodeJS.Signals]> = [];
    const limitedPromise = runQoder(fakeConfig(), {
      spawnProcess: () => limitedChild,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        kills.push([pid, signal]);
        limitedChild.emit("close", null, "SIGTERM");
      },
      captureLimitBytes: 8,
      hardOutputLimitBytes: HARD_OUTPUT_LIMIT_BYTES,
    });
    limitedChild.stdout.emit("data", Buffer.alloc(HARD_OUTPUT_LIMIT_BYTES + 1, "x"));
    const limitedResult = await limitedPromise;

    expect(kills).toEqual([[-4321, "SIGTERM"]]);
    expect(limitedResult.envelope).toMatchObject({
      status: "failed",
      error: { code: "output_limit" },
    });
  });
});

describe("direct execution behavior", () => {
  it("does not start a child process when imported", () => {
    const importScript = `await import(${JSON.stringify(pathToFileURL(runnerPath).href)});`;
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], {
      encoding: "utf8",
    });

    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
  });

  it("emits one envelope for invalid direct input without starting Qoder", () => {
    const executed = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
    const lines = executed.stdout.trim().split("\n");
    const envelope = JSON.parse(lines[0] ?? "{}");

    expect(executed.status).not.toBe(0);
    expect(lines).toHaveLength(1);
    expect(envelope).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
  });

  it("atomically persists the final envelope beside a prompt file", async () => {
    const root = await mkdtemp(join(tmpdir(), "qoder-result-file-test-"));
    try {
      const promptFile = join(root, "delegation-brief.md");
      const resultFile = resultFileForPrompt(promptFile);
      await writeFile(promptFile, "Report the bounded diagnostic result.", { mode: 0o600 });
      await writeFile(resultFile, "stale result", { mode: 0o600 });

      const executed = spawnSync(
        process.execPath,
        [
          runnerPath,
          "--cwd",
          root,
          "--prompt-file",
          promptFile,
          "--qodercli-path",
          process.execPath,
          "--timeout-ms",
          "5000",
        ],
        { encoding: "utf8" },
      );
      const envelope = JSON.parse(executed.stdout.trim());
      const persistedEnvelope = JSON.parse(await readFile(resultFile, "utf8"));

      expect(persistedEnvelope).toEqual(envelope);
      expect((await stat(resultFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "returns invalid_input before Qoder spawn when the Windows command line is too long",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "qoder-windows-command-line-test-"));
      try {
        const promptFile = join(root, "delegation-brief.md");
        await writeFile(promptFile, "a".repeat(32_500), { mode: 0o600 });
        const executed = spawnSync(
          process.execPath,
          [
            runnerPath,
            "--cwd",
            root,
            "--prompt-file",
            promptFile,
            "--qodercli-path",
            process.execPath,
          ],
          { encoding: "utf8" },
        );
        const envelope = JSON.parse(executed.stdout.trim());

        expect(executed.status).not.toBe(0);
        expect(envelope).toMatchObject({
          status: "failed",
          error: { code: "invalid_input", message: expect.stringContaining("CreateProcessW") },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "passes shell metacharacters from a prompt file without executing them",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "qoder-prompt-file-test-"));
      try {
        const marker = join(root, "shell-command-ran");
        const promptFile = join(root, "delegation-brief.md");
        const executable = join(root, "fake-qodercli");
        const prompt = [
          "# Brief",
          "Use `literal backticks` and quotes: \"double\" 'single'.",
          `Never execute $(touch ${marker}).`,
        ].join("\n");
        const expectedHash = createHash("sha256").update(prompt).digest("hex");
        await writeFile(promptFile, prompt, { mode: 0o600 });
        await writeFile(
          executable,
          [
            "#!/usr/bin/env node",
            'const { createHash } = require("node:crypto");',
            'const prompt = process.argv.at(-1) ?? "";',
            'process.stdout.write(JSON.stringify({ hash: createHash("sha256").update(prompt).digest("hex") }));',
          ].join("\n"),
          { mode: 0o700 },
        );
        await chmod(executable, 0o700);

        const executed = spawnSync(
          process.execPath,
          [
            runnerPath,
            "--cwd",
            root,
            "--prompt-file",
            promptFile,
            "--qodercli-path",
            executable,
            "--timeout-ms",
            "5000",
          ],
          { encoding: "utf8" },
        );
        const envelope = JSON.parse(executed.stdout.trim());
        const qoderOutput = JSON.parse(envelope.qoderOutput.raw);
        const resultFile = resultFileForPrompt(promptFile);
        const persistedEnvelope = JSON.parse(await readFile(resultFile, "utf8"));
        const resultFileMode = (await stat(resultFile)).mode & 0o777;

        expect(executed.status).toBe(0);
        expect(executed.stderr).toContain(
          "[run_qoder] running; wait for an explicit exit code and the final JSON envelope on stdout.",
        );
        expect(persistedEnvelope).toEqual(envelope);
        expect(resultFileMode).toBe(0o600);
        expect(qoderOutput).toEqual({ hash: expectedHash });
        await expect(access(marker)).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
