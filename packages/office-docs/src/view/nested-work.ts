/** A suspended parent resumes only after its nested operation finishes. */
export type NestedWork<T> = Generator<NestedWork<T>, T, T>;

/** Run depth-first work without spending one JavaScript call frame per table. */
export function completeNestedWork<T>(root: NestedWork<T>): T {
  const stack = [root];
  let result: T = undefined as T;
  while (stack.length > 0) {
    const step = stack[stack.length - 1].next(result);
    if (step.done) {
      result = step.value;
      stack.pop();
    } else {
      stack.push(step.value);
    }
  }
  return result;
}
