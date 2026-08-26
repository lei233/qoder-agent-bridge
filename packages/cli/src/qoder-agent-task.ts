#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_TIMEOUT_MS,
  PROMPT_LIMIT_BYTES,
  type RunnerEnvelope,
  type Task,
} from "@qoder-agent-bridge/core";
import {
  EmbeddedTaskHost,
  TaskHostError,
  discardPreparedSuccessorRetry,
  inspectTaskWorkspace,
  normalizeHostError,
  prepareSuccessorRetry,
  runPreparedSuccessorRetry,
  type InvocationOperationResult,
  type SkillBridgeDependencies,
  type TaskResolutionResult,
  type TaskRunnerOptions,
} from "./task-host";

export type TaskCommand =
  | "start"
  | "inspect"
  | "run"
  | "candidate"
  | "repair"
  | "prepare-retry"
  | "retry"
  | "discard-retry"
  | "apply"
  | "discard"
  | "fail"
  | "get";

interface ParsedBase {
  command: TaskCommand;
}

export type ParsedTaskArgs =
  | (ParsedBase & { command: "start"; cwd: string })
  | (ParsedBase & { command: "run" | "repair"; task: string; runner: TaskRunnerOptions })
  | (ParsedBase & {
      command: "retry";
      task: string;
      strategy: "continue";
      worktree: "current";
      preparation: undefined;
      runner: TaskRunnerOptions;
    })
  | (ParsedBase & {
      command: "retry";
      task: string;
      strategy: "restart";
      worktree: "successor";
      preparation: string;
      runner: TaskRunnerOptions;
    })
  | (ParsedBase & {
      command: "discard-retry";
      task: string;
      preparation: string;
    })
  | (ParsedBase & {
      command: "inspect" | "prepare-retry" | "candidate" | "discard" | "fail" | "get";
      task: string;
    })
  | (ParsedBase & { command: "apply"; task: string; candidate: string });

const TASK_COMMANDS: readonly TaskCommand[] = [
  "start",
  "inspect",
  "run",
  "candidate",
  "repair",
  "prepare-retry",
  "retry",
  "discard-retry",
  "apply",
  "discard",
  "fail",
  "get",
];

const VALUE_OPTIONS = new Set([
  "--cwd",
  "--task",
  "--prompt",
  "--prompt-file",
  "--qodercli-path",
  "--model",
  "--max-model-request-retries",
  "--strategy",
  "--worktree",
  "--preparation",
  "--candidate",
]);
const FLAG_OPTIONS = new Set<string>();

function isTaskCommand(value: string | undefined): value is TaskCommand {
  return value !== undefined && TASK_COMMANDS.includes(value as TaskCommand);
}

function requireValue(values: Record<string, string>, option: string): string {
  const value = values[option];
  if (value === undefined || value.trim() === "") {
    throw new TaskHostError("invalid_input", `${option} is required and must be non-empty.`);
  }
  return value;
}

function rejectOptions(
  values: Record<string, string>,
  flags: Set<string>,
  allowedValues: readonly string[],
  allowedFlags: readonly string[] = [],
): void {
  const allowedValueSet = new Set(allowedValues);
  for (const option of Object.keys(values)) {
    if (!allowedValueSet.has(option)) {
      throw new TaskHostError("invalid_input", `${option} is not valid for this Task command.`);
    }
  }
  const allowedFlagSet = new Set(allowedFlags);
  for (const flag of flags) {
    if (!allowedFlagSet.has(flag)) {
      throw new TaskHostError("invalid_input", `${flag} is not valid for this Task command.`);
    }
  }
}

function runnerOptions(values: Record<string, string>): TaskRunnerOptions {
  const prompt = values["--prompt"];
  const promptFile = values["--prompt-file"];
  if ((prompt === undefined) === (promptFile === undefined)) {
    throw new TaskHostError(
      "invalid_input",
      "Exactly one of --prompt or --prompt-file is required for Task execution.",
    );
  }
  if (prompt !== undefined) {
    if (prompt.trim() === "") {
      throw new TaskHostError("invalid_input", "--prompt must be non-empty.");
    }
    if (Buffer.byteLength(prompt, "utf8") > PROMPT_LIMIT_BYTES) {
      throw new TaskHostError("invalid_input", "--prompt exceeds the 64 KiB limit.");
    }
  }
  if (promptFile !== undefined && promptFile.trim() === "") {
    throw new TaskHostError("invalid_input", "--prompt-file must be non-empty.");
  }
  return {
    prompt,
    promptFile,
    qodercliPath: values["--qodercli-path"],
    model: values["--model"],
    // Task-managed execution has one Runner safety ceiling. "Long task" is a
    // Codex host-tool waiting policy and never changes this value.
    timeoutMs: String(MAX_TIMEOUT_MS),
    maxModelRequestRetries: values["--max-model-request-retries"],
  };
}

function parseRetryStrategy(values: Record<string, string>): {
  strategy: "continue" | "restart";
  worktree: "current" | "successor";
} {
  const strategy = values["--strategy"];
  const worktree = values["--worktree"];
  if (strategy !== undefined && worktree !== undefined) {
    throw new TaskHostError("invalid_input", "Use either --strategy or --worktree, not both.");
  }
  if (strategy === "continue") return { strategy, worktree: "current" };
  if (strategy === "restart") return { strategy, worktree: "successor" };
  if (strategy !== undefined) {
    throw new TaskHostError("invalid_input", "--strategy must be either continue or restart.");
  }
  if (worktree === "current") return { strategy: "continue", worktree };
  if (worktree === "successor") return { strategy: "restart", worktree };
  if (worktree !== undefined) {
    throw new TaskHostError("invalid_input", "--worktree must be either current or successor.");
  }
  throw new TaskHostError("invalid_input", "Retry requires --strategy continue or restart.");
}

function taskSummary(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    version: task.version,
    lifecycle: task.lifecycle,
    outcome: task.outcome,
    operability: task.operability,
    blockReason: task.blockReason,
    activeInvocationId: task.activeInvocationId,
    activeCandidateId: task.activeCandidateId,
    appliedCandidateId: task.appliedCandidateId,
  };
}

function runnerEvidence(runner: RunnerEnvelope | null): Record<string, unknown> | null {
  if (runner === null) return null;
  return {
    protocolVersion: runner.protocolVersion,
    runnerVersion: runner.runnerVersion,
    status: runner.status,
    exitCode: runner.exitCode,
    signal: runner.signal,
    durationMs: runner.durationMs,
    timedOut: runner.timedOut,
    retryable: runner.retryable,
    stdout: runner.stdout,
    stderr: runner.stderr,
    stdoutTruncated: runner.stdoutTruncated,
    stderrTruncated: runner.stderrTruncated,
    qoderOutput: runner.qoderOutput,
    error: runner.error,
  };
}

function invocationEvidence(result: InvocationOperationResult): Record<string, unknown> {
  return {
    task: taskSummary(result.task),
    invocationId: result.invocationId,
    resultRef: result.resultRef,
    runner: runnerEvidence(result.runner),
    hostError: result.hostError,
  };
}

function resolutionEvidence(result: TaskResolutionResult): Record<string, unknown> {
  return {
    task: taskSummary(result.task),
    cleanupIncomplete: result.cleanupIncomplete,
    cleanupIssues: result.cleanupIssues.map((issue) => ({ error: issue.error })),
  };
}

export function parseTaskArgs(argv: string[]): ParsedTaskArgs {
  const command = argv[0];
  if (!isTaskCommand(command)) {
    throw new TaskHostError(
      "invalid_input",
      "Use start, inspect, run, candidate, repair, prepare-retry, retry, discard-retry, apply, discard, fail, or get.",
    );
  }

  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) {
      throw new TaskHostError("invalid_input", "Unsupported or misplaced Task argument.");
    }
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) {
        throw new TaskHostError("invalid_input", `${option} was provided more than once.`);
      }
      flags.add(option);
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) {
      throw new TaskHostError("invalid_input", "Unsupported or misplaced Task argument.");
    }
    if (Object.hasOwn(values, option)) {
      throw new TaskHostError("invalid_input", `${option} was provided more than once.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new TaskHostError("invalid_input", `${option} is missing its value.`);
    }
    values[option] = value;
    index += 1;
  }

  const runnerValues = [
    "--task",
    "--prompt",
    "--prompt-file",
    "--qodercli-path",
    "--model",
    "--max-model-request-retries",
  ] as const;

  if (command === "start") {
    rejectOptions(values, flags, ["--cwd"]);
    return { command, cwd: requireValue(values, "--cwd") };
  }
  if (command === "run" || command === "repair") {
    rejectOptions(values, flags, runnerValues);
    return {
      command,
      task: requireValue(values, "--task"),
      runner: runnerOptions(values),
    };
  }
  if (command === "retry") {
    rejectOptions(values, flags, [...runnerValues, "--strategy", "--worktree", "--preparation"]);
    const task = requireValue(values, "--task");
    const parsedStrategy = parseRetryStrategy(values);
    if (parsedStrategy.strategy === "continue") {
      if (values["--preparation"] !== undefined) {
        throw new TaskHostError("invalid_input", "--preparation is valid only for restart retry.");
      }
      return {
        command,
        task,
        strategy: "continue",
        worktree: "current",
        preparation: undefined,
        runner: runnerOptions(values),
      };
    }
    return {
      command,
      task,
      strategy: "restart",
      worktree: "successor",
      preparation: requireValue(values, "--preparation"),
      runner: runnerOptions(values),
    };
  }
  if (command === "discard-retry") {
    rejectOptions(values, flags, ["--task", "--preparation"]);
    return {
      command,
      task: requireValue(values, "--task"),
      preparation: requireValue(values, "--preparation"),
    };
  }
  if (command === "apply") {
    rejectOptions(values, flags, ["--task", "--candidate"]);
    return {
      command,
      task: requireValue(values, "--task"),
      candidate: requireValue(values, "--candidate"),
    };
  }

  rejectOptions(values, flags, ["--task"]);
  return { command, task: requireValue(values, "--task") };
}

export async function executeTaskCommand(
  argv: string[],
  options: {
    host?: EmbeddedTaskHost;
    signal?: AbortSignal;
    skillBridgeDependencies?: SkillBridgeDependencies;
  } = {},
): Promise<Record<string, unknown>> {
  const parsed = parseTaskArgs(argv);
  const host = options.host ?? new EmbeddedTaskHost();
  const bridgeDependencies = options.skillBridgeDependencies ?? {};

  if (parsed.command === "start") {
    const result = await host.start(parsed.cwd);
    return {
      status: "succeeded",
      operation: "start",
      taskStatePath: result.taskStatePath,
      task: taskSummary(result.task),
    };
  }
  if (parsed.command === "inspect") {
    const result = await inspectTaskWorkspace(parsed.task, bridgeDependencies);
    return {
      status: "succeeded",
      operation: "inspect",
      task: taskSummary(result.task),
      workspace: result.workspace,
      retryEligibility: result.retryEligibility,
    };
  }
  if (parsed.command === "get") {
    return { status: "succeeded", operation: "get", task: await host.get(parsed.task) };
  }
  if (parsed.command === "run") {
    const result = await host.run(parsed.task, parsed.runner, options.signal);
    return {
      status: result.runner?.status === "succeeded" ? "succeeded" : "failed",
      operation: "run",
      ...invocationEvidence(result),
    };
  }
  if (parsed.command === "candidate") {
    const result = await host.candidate(parsed.task);
    return {
      status: "succeeded",
      operation: "candidate",
      task: taskSummary(result.task),
      candidate: result.candidate,
    };
  }
  if (parsed.command === "repair") {
    const result = await host.repair(parsed.task, parsed.runner, options.signal);
    return {
      status: result.runner?.status === "succeeded" ? "succeeded" : "failed",
      operation: "repair",
      ...invocationEvidence(result),
    };
  }
  if (parsed.command === "prepare-retry") {
    const result = await prepareSuccessorRetry(parsed.task, bridgeDependencies);
    return { status: "succeeded", operation: "prepare-retry", ...result };
  }
  if (parsed.command === "retry") {
    const result =
      parsed.strategy === "continue"
        ? await host.retry(parsed.task, "current", parsed.runner, options.signal)
        : await runPreparedSuccessorRetry(
            parsed.task,
            parsed.preparation,
            parsed.runner,
            options.signal,
            bridgeDependencies,
          );
    return {
      status: result.runner?.status === "succeeded" ? "succeeded" : "failed",
      operation: "retry",
      strategy: parsed.strategy,
      ...invocationEvidence(result),
    };
  }
  if (parsed.command === "discard-retry") {
    await discardPreparedSuccessorRetry(parsed.task, parsed.preparation, bridgeDependencies);
    return {
      status: "succeeded",
      operation: "discard-retry",
      preparationId: parsed.preparation,
    };
  }
  if (parsed.command === "apply") {
    const result = await host.apply(parsed.task, parsed.candidate);
    return { status: "succeeded", operation: "apply", ...resolutionEvidence(result) };
  }
  if (parsed.command === "discard") {
    const result = await host.discard(parsed.task);
    return { status: "succeeded", operation: "discard", ...resolutionEvidence(result) };
  }
  const result = await host.fail(parsed.task);
  return { status: "succeeded", operation: "fail", ...resolutionEvidence(result) };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => controller.abort("SIGINT");
  const onSigterm = () => controller.abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    try {
      const result = await executeTaskCommand(argv, { signal: controller.signal });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === "failed" || result.cleanupIncomplete === true) {
        process.exitCode = 1;
      }
    } catch (error) {
      const normalized = normalizeHostError(error);
      process.stdout.write(`${JSON.stringify({ status: "failed", error: normalized })}\n`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
