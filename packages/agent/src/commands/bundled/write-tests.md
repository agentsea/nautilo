---
name: write-tests
description: Propose or author tests for the referenced code. $ARGUMENTS is the target (function, file, module, or behavior). Cover the happy path, edge cases, and regressions worth pinning.
source: official
version: 1
---
Author tests for the target named in $ARGUMENTS. Use the codebase's existing test framework and conventions; mirror a nearby test file's style. If the target is ambiguous, pick the most reasonable interpretation and say so.

Plan before writing:
1. **Read the target's behavior** — what it does, what it returns, what errors it raises, what side effects it has. Note any branches, null paths, boundary conditions, and concurrent calls.
2. **List the cases worth pinning** before writing any test code. Cover:
   - The happy path (the obvious case the function exists to handle).
   - Boundary / off-by-one cases (empty input, single element, max size, zero, negative).
   - Error and invalid-input cases (bad types, missing fields, unauthorized, not-found).
   - Side effects and ordering (calls the right collaborator, doesn't call the wrong one, idempotency).
   - Any regression you can think of that this code would silently reintroduce.
3. **Write the tests.** Each test should fail for exactly one reason and have a name that says what it asserts. Prefer table-driven tests when the cases share shape. No flaky timing, no real network, no real clock — use the existing fakes/stubs the codebase already has.
4. **Run them** if the codebase gives you a one-line command, and report pass/fail. If you can't run, say so and explain how the user should run them.

Do not write tests that pass regardless of correctness (e.g. asserting a function "doesn't throw" when it should return a specific value). Do not skip the failure-mode cases because they're harder to construct — those are the ones that matter.
