import { describe, expect, test } from "bun:test";
import yargs from "yargs";

import { selfUpdateModule } from "../../src/commands/self-update.ts";

describe("self-update parser", () => {
  for (const mode of ["check", "rollback"] as const) {
    test(`accepts --${mode} without treating the other false option as a conflict`, async () => {
      const failures: string[] = [];
      const command = {
        ...selfUpdateModule,
        handler: () => undefined,
      };

      await yargs(["self-update", `--${mode}`])
        .exitProcess(false)
        .fail((message) => failures.push(message))
        .command(command)
        .parseAsync();

      expect(failures).toEqual([]);
    });
  }
});
