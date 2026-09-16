import { describe, expect, test } from "bun:test";
import type { CommandModule } from "yargs";
import yargs from "yargs";

import { destroyModule } from "../../src/commands/destroy.ts";

function parserWithRecordedDestroy(argv: readonly string[], onDestroy: () => void) {
  const command: CommandModule = {
    ...destroyModule,
    handler: () => onDestroy(),
  };
  return yargs(argv)
    .scriptName("nautilo")
    .strict()
    .exitProcess(false)
    .command(command)
    .fail((message, error) => {
      throw error ?? new Error(message);
    });
}

describe("destroy argument boundary", () => {
  test("rejects an unknown flag before the destruction handler can run", async () => {
    let destructionCalls = 0;
    const parser = parserWithRecordedDestroy(
      ["destroy", "--hard", "--unexpected-flag"],
      () => { destructionCalls += 1; },
    );

    let failure: unknown;
    try {
      await parser.parseAsync();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Unknown argument: unexpected-flag");
    expect(destructionCalls).toBe(0);
  });

  test("rejects an extra positional argument before the destruction handler can run", async () => {
    let destructionCalls = 0;
    const parser = parserWithRecordedDestroy(
      ["destroy", "garbage"],
      () => { destructionCalls += 1; },
    );

    let failure: unknown;
    try {
      await parser.parseAsync();
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe("Unknown argument: garbage");
    expect(destructionCalls).toBe(0);
  });

  test("accepts the explicit automation acknowledgement and invokes destroy once", async () => {
    let destructionCalls = 0;
    const parser = parserWithRecordedDestroy(
      ["destroy", "--hard", "--yes"],
      () => { destructionCalls += 1; },
    );

    await parser.parseAsync();
    expect(destructionCalls).toBe(1);
  });
});
