import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskHostError } from "./errors";
import { TASK_RETRY_PREPARATION_DIR, type TaskFileStore } from "./store";

const PREPARED_RETRY_METADATA_VERSION = 2 as const;
const PREPARATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface PreparedRetryMetadata {
  version: typeof PREPARED_RETRY_METADATA_VERSION;
  preparationId: string;
  taskStatePath: string;
  taskId: string;
  taskVersion: number;
  predecessorWorktreeSessionId: string;
  predecessorStatePath: string;
  successorStatePath: string;
}

export function assertRetryPreparationId(preparationId: string): void {
  if (!PREPARATION_ID_PATTERN.test(preparationId)) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation ID is invalid.");
  }
}

export function retryPreparationPath(store: TaskFileStore, preparationId: string): string {
  assertRetryPreparationId(preparationId);
  return join(store.taskRoot, TASK_RETRY_PREPARATION_DIR, `${preparationId}.json`);
}

function parsePreparedRetryMetadata(value: unknown): PreparedRetryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
  const metadata = value as Partial<PreparedRetryMetadata>;
  if (
    metadata.version !== PREPARED_RETRY_METADATA_VERSION ||
    typeof metadata.preparationId !== "string" ||
    !PREPARATION_ID_PATTERN.test(metadata.preparationId) ||
    typeof metadata.taskStatePath !== "string" ||
    typeof metadata.taskId !== "string" ||
    !Number.isSafeInteger(metadata.taskVersion) ||
    typeof metadata.predecessorWorktreeSessionId !== "string" ||
    typeof metadata.predecessorStatePath !== "string" ||
    typeof metadata.successorStatePath !== "string"
  ) {
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
  return metadata as PreparedRetryMetadata;
}

export async function readPreparedRetryMetadata(
  store: TaskFileStore,
  preparationId: string,
): Promise<PreparedRetryMetadata> {
  let source: string;
  try {
    source = await readFile(retryPreparationPath(store, preparationId), "utf8");
  } catch {
    throw new TaskHostError(
      "invalid_retry_preparation",
      "Prepared successor retry metadata is missing or unreadable.",
    );
  }
  try {
    const metadata = parsePreparedRetryMetadata(JSON.parse(source) as unknown);
    if (metadata.preparationId !== preparationId) {
      throw new TaskHostError(
        "retry_preparation_mismatch",
        "Retry preparation ID does not match its metadata.",
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof TaskHostError) throw error;
    throw new TaskHostError("invalid_retry_preparation", "Retry preparation metadata is invalid.");
  }
}

export async function writePreparedRetryMetadata(
  store: TaskFileStore,
  metadata: PreparedRetryMetadata,
): Promise<void> {
  assertRetryPreparationId(metadata.preparationId);
  await mkdir(join(store.taskRoot, TASK_RETRY_PREPARATION_DIR), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    retryPreparationPath(store, metadata.preparationId),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

export function preparedRetryMetadata(input: Omit<PreparedRetryMetadata, "version">): PreparedRetryMetadata {
  return { version: PREPARED_RETRY_METADATA_VERSION, ...input };
}
