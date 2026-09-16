import { afterEach, describe, expect, test } from "bun:test";
import type { RecallRecordsPortForState } from "@nautilo/agent";

import {
  foregroundRecordRecallPortForState,
  hasForegroundRecordRecallPortFactory,
  installForegroundRecordRecallPortFactory,
  uninstallForegroundRecordRecallPortFactory,
} from "../../src/reflection/foreground-record-recall";

afterEach(() => uninstallForegroundRecordRecallPortFactory());

describe("foreground Record recall composition", () => {
  test("is absent until the Server installs the exact binding", () => {
    expect(hasForegroundRecordRecallPortFactory()).toBe(false);
    expect(foregroundRecordRecallPortForState({} as never)).toBeUndefined();
  });

  test("forwards only through the installed foreground factory", () => {
    const port = {
      search: async () => ({ status: "ok" as const, records: [] }),
      expand: async () => ({ status: "unavailable" as const, reason: "not_found" as const }),
    };
    const factory: RecallRecordsPortForState = () => port;
    installForegroundRecordRecallPortFactory(factory);
    expect(hasForegroundRecordRecallPortFactory()).toBe(true);
    expect(foregroundRecordRecallPortForState({} as never)).toBe(port);
  });

  test("refuses a second competing owner", () => {
    const first: RecallRecordsPortForState = () => undefined;
    installForegroundRecordRecallPortFactory(first);
    expect(() => installForegroundRecordRecallPortFactory(() => undefined))
      .toThrow("foreground_record_recall_factory_already_installed");
  });
});
