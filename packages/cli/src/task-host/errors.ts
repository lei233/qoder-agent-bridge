export class TaskHostError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TaskHostError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeHostError(error: unknown): { code: string; message: string } {
  if (error instanceof TaskHostError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: "Task host operation failed." };
}
