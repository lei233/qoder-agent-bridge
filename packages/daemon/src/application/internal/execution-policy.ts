import {
  DEFAULT_MAX_MODEL_REQUEST_RETRIES,
  MAX_MODEL_REQUEST_RETRIES,
  MAX_TIMEOUT_MS,
} from "@qoder-agent-bridge/core";

export const DEFAULT_TASK_TIMEOUT_MS = MAX_TIMEOUT_MS;
export const DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES = DEFAULT_MAX_MODEL_REQUEST_RETRIES;

export interface TaskExecutionPolicy {
  timeoutMs: number;
  maxModelRequestRetries: number;
  fallbacks: string[];
}

function resolveBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  variableName: string,
): { value: number; fallback: string | null } {
  if (value === undefined || value === "") {
    return { value: defaultValue, fallback: null };
  }

  if (!/^[0-9]+$/.test(value)) {
    return { value: defaultValue, fallback: `invalid ${variableName}` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { value: defaultValue, fallback: `invalid ${variableName}` };
  }

  return { value: parsed, fallback: null };
}

export function resolveTaskExecutionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TaskExecutionPolicy {
  const timeout = resolveBoundedInteger(
    env.QODER_TASK_TIMEOUT_MS,
    DEFAULT_TASK_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    "QODER_TASK_TIMEOUT_MS",
  );
  const retries = resolveBoundedInteger(
    env.QODER_TASK_MAX_MODEL_REQUEST_RETRIES,
    DEFAULT_TASK_MAX_MODEL_REQUEST_RETRIES,
    0,
    MAX_MODEL_REQUEST_RETRIES,
    "QODER_TASK_MAX_MODEL_REQUEST_RETRIES",
  );

  return {
    timeoutMs: timeout.value,
    maxModelRequestRetries: retries.value,
    fallbacks: [timeout.fallback, retries.fallback].filter((item): item is string => item !== null),
  };
}
