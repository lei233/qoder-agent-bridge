import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
  DEFAULT_TASK_TIMEOUT_MS,
  resolveTaskExecutionPolicy,
} from "../packages/cli/src/task-host/execution-policy";

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
});
