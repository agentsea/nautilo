import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  RELAY_HOST_COMPONENT,
  RELAY_HOST_PROTOCOL_VERSION,
  RelayHostFrameDecoder,
} from "@nautilo/relay";
import { resolveDesktopRelayHostLaunch } from "../../electron/relay-sidecar-client";

const resources = process.env["NAUTILO_PACKAGED_RESOURCES"];
test.skipIf(!resources)("the packaged Bun starts its exact Relay Host and emits a valid ready frame", () => {
  const launch = resolveDesktopRelayHostLaunch({
    isPackaged: true,
    resourcesPath: resources!,
    devVendorRoot: "unused",
  });
  const child = spawnSync(launch.executablePath, [...launch.executableArguments], {
    input: "",
    encoding: "buffer",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr?.toString()).toBe(0);
  const decoder = new RelayHostFrameDecoder();
  const messages = decoder.push(child.stdout);
  decoder.finish();
  expect(messages[0]).toMatchObject({
    kind: "ready",
    component: RELAY_HOST_COMPONENT,
    protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
    hostVersion: launch.hostVersion,
  });
}, 15_000);
