/** Matches Nest's Logger, so tasks stay plain classes that tests build without Nest. */
export interface Log {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
