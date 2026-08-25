#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_LIMIT_BYTES } from "@qoder-agent-bridge/core";
import {
  EmbeddedTaskHost,
  TaskHostError,
  discardPreparedSuccessorRetry,
  inspectTaskWorktree,
  normalizeHostError,
  prepareSuccessorRetry,
  runPreparedSuccessorRetry,
  type SkillBridgeDependencies,
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
      worktree: "current";
      preparedState: undefined;
      runner: TaskRunnerOptions;
    })
  | (ParsedBase & {
      command: "retry";
      task: string;
      worktree: "successor";
      preparedState: string;
      runner: TaskRunnerOptions;
    })
  | (ParsedBase & {
      command: "discard-retry";
      task: string;
      preparedState: string;
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
  "--timeout-ms",
  "--max-model-request-retries",
  "--worktree",
  "--prepared-state",
  "--candidate",
]);

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

function rejectOptions(values: Record<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const option of Object.keys(values)) {
    if (!allowedSet.has(option)) {
      throw new TaskHostError("invalid_input", `${option} is not valid for this Task command.`);
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
    timeoutMs: values["--timeout-ms"],
    maxModelRequestRetries: values["--max-model-request-retries"],
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
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined || !VALUE_OPTIONS.has(option)) {
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

  const runnerFlags = [
    "--task",
    "--prompt",
    "--prompt-file",
    "--qodercli-path",
    "--model",
    "--timeout-ms",
    "--max-model-request-retries",
  ] as const;

  if (command === "start") {
    rejectOptions(values, ["--cwd"]);
    return { command, cwd: requireValue(values, "--cwd") };
  }
  if (command === "run" || command === "repair") {
    rejectOptions(values, runnerFlags);
    return {
      command,
      task: requireValue(values, "--task"),
      runner: runnerOptions(values),
    };
  }
  if (command === "retry") {
    rejectOptions(values, [...runnerFlags, "--worktree", "--prepared-state"]);
    const task = requireValue(values, "--task");
    const worktree = requireValue(values, "--worktree");
    if (worktree === "current") {
      if (values["--prepared-state"] !== undefined) {
        throw new TaskHostError(
          "invalid_input",
          "--prepared-state is valid only for successor retry.",
        );
      }
      return {
        command,
        task,
        worktree,
        preparedState: undefined,
        runner: runnerOptions(values),
      };
    }
    if (worktree === "successor") {
      return {
        command,
        task,
        worktree,
        preparedState: requireValue(values, "--prepared-state"),
        runner: runnerOptions(values),
      };
    }
    throw new TaskHostError("invalid_input", "--worktree must be either current or successor.");
  }
  if (command === "discard-retry") {
    rejectOptions(values, ["--task", "--prepared-state"]);
    return {
      command,
      task: requireValue(values, "--task"),
      preparedState: requireValue(values, "--prepared-state"),
    };
  }
  if (command === "apply") {
    rejectOptions(values, ["--task", "--candidate"]);
    return {
      command,
      task: requireValue(values, "--task"),
      candidate: requireValue(values, "--candidate"),
    };
  }

  rejectOptions(values, ["--task"]);
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
    return { status: "succeeded", operation: "start", ...result };
  }
  if (parsed.command === "inspect") {
    const result = await inspectTaskWorktree(parsed.task, bridgeDependencies);
    return { status: "succeeded", operation: "inspect", ...result };
  }
  if (parsed.command === "get") {
    return { status: "succeeded", operation: "get", task: await host.get(parsed.task) };
  }
  if (parsed.command === "run") {
    const result = await host.run(parsed.task, parsed.runner, options.signal);
    return {
      status: result.runner?.status === "succeeded" ? "succeeded" : "failed",
      operation: "run",
      ...result,
    };
  }
  if (parsed.command === "candidate") {
    const result = await host.candidate(parsed.task);
    return { status: "succeeded", operation: "candidate", ...result };
  }
  if (parsed.command === "repair") {
    const result = await host.repair(parsed.task, parsed.runner, options.signal);
    return {
      status: result.runner?.status === "succeeded" ? "succeeded" : "failed",
      operation: "repair",
      ...result,
    };
  }
  if (parsed.command === "prepare-retry") {
    const result = await prepareSuccessorRetry(parsed.task, bridgeDependencies);
    return { status: "succeeded", operation: "prepare-retry", ...result };
  }
  if (parsed.command === "retry") {
    const result =
      parsed.worktree === "current"
        ? await host.retry(parsed.task, "current", parsed.runner, options.signal)
        : await runPreparedSuccessorRetry(
            parsed.task,
            parsed.preparedState,
            parsed.runner,
            options.signal,
            bridgeDependencies,
          );
    return {
      status: result.runner?.status === "succeeded" ? "succeeded" : "failed",
      operation: "retry",
      worktree: parsed.worktree,
      ...result,
    };
  }
  if (parsed.command === "discard-retry") {
    await discardPreparedSuccessorRetry(
      parsed.task,
      parsed.preparedState,
      bridgeDependencies,
    );
    return {
      status: "succeeded",
      operation: "discard-retry",
      preparedState: parsed.preparedState,
    };
  }
  if (parsed.command === "apply") {
    const result = await host.apply(parsed.task, parsed.candidate);
    return { status: "succeeded", operation: "apply", ...result };
  }
  if (parsed.command === "discard") {
    const result = await host.discard(parsed.task);
    return { status: "succeeded", operation: "discard", ...result };
  }
  const result = await host.fail(parsed.task);
  return { status: "succeeded", operation: "fail", ...result };
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
