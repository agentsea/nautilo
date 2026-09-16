import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setConfigOverrides } from "@nautilo/config";
import {
  parseCloneSource,
  selectCloneMaterialization,
  selectCloneSource,
  selectCloneTarget,
} from "../../src/lib/clone-source-selection";

describe("clone source selection", () => {
  const home = "/tmp/nautilo-clone-selector-home";

  test("resolves only the explicit empty source to canonical default", () => {
    expect(parseCloneSource("")).toEqual({ kind: "canonical-default" });
    expect(selectCloneSource(home, { kind: "canonical-default" })).toEqual({
      kind: "canonical-default",
      instanceId: "",
      root: join(home, ".nautilo"),
    });
  });

  test("keeps literal default as a named source without config alias reuse", () => {
    expect(parseCloneSource("default")).toEqual({
      kind: "named",
      instanceId: "default",
    });
    expect(selectCloneSource(home, parseCloneSource("default"))).toEqual({
      kind: "named",
      instanceId: "default",
      root: join(home, ".nautilo-default"),
    });
    expect(() => parseCloneSource("(default)")).toThrow(
      "Clone source must be a valid nonempty named-instance id",
    );
  });

  test("keeps targets named and resolves both sides without cache or overlay", () => {
    setConfigOverrides({ nautilo_instance_network: { serverPort: 3999 } });
    try {
      expect(selectCloneTarget(home, "tau")).toEqual({
        instanceId: "tau",
        root: join(home, ".nautilo-tau"),
        projectName: "nautilo-tau",
      });
      expect(selectCloneTarget(home, "default")).toEqual({
        instanceId: "default",
        root: join(home, ".nautilo-default"),
        projectName: "nautilo-default",
      });
      expect(() => selectCloneTarget(home, "")).toThrow(
        "Clone target must be a valid nonempty named-instance id",
      );
      expect(selectCloneMaterialization({
        userHome: home,
        source: { kind: "named", instanceId: "qa-source" },
        targetId: "tau",
      })).toEqual({
        source: {
          kind: "named",
          instanceId: "qa-source",
          root: join(home, ".nautilo-qa-source"),
        },
        target: {
          instanceId: "tau",
          root: join(home, ".nautilo-tau"),
          projectName: "nautilo-tau",
        },
      });
    } finally {
      setConfigOverrides({});
    }
  });
});
