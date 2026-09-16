/** Minimal local logger — no @nautilo/logger dependency. */

export const logger = {
  info(message: string, ...args: unknown[]): void {
    console.log(`[cloudconvert] ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(`[cloudconvert] ${message}`, ...args);
  },
  debug(message: string, ...args: unknown[]): void {
    if (process.env["DEBUG"]?.includes("cloudconvert")) {
      console.debug(`[cloudconvert] ${message}`, ...args);
    }
  },
  error(message: string, ...args: unknown[]): void {
    console.error(`[cloudconvert] ${message}`, ...args);
  },
};
