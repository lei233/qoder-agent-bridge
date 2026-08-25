export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

export function taskAssert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) {
    throw new TaskError(code, message);
  }
}
