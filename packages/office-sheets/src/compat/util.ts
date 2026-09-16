// Modified by Nautilo: browser-compatible subset used by antlr4ts.
export const inspect = Object.assign(
  (value: unknown): string => String(value),
  { custom: Symbol.for('nodejs.util.inspect.custom') },
);

export function promisify<TArgs extends unknown[], TResult>(
  fn: (...args: [...TArgs, (error: unknown, value: TResult) => void]) => void,
): (...args: TArgs) => Promise<TResult> {
  return (...args) =>
    new Promise<TResult>((resolve, reject) => {
      fn(...args, (error, value) =>
        error
          ? reject(
              error instanceof Error
                ? error
                : new Error(
                    typeof error === 'string' ? error : 'Unknown callback error',
                  ),
            )
          : resolve(value),
      );
    });
}
