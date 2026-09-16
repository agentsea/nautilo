#!/usr/bin/env bun
import { DesktopRelayHost } from "./desktop-host.ts";

const host = new DesktopRelayHost({ input: process.stdin, output: process.stdout });
host.run().catch((error) => {
  process.stderr.write(`[nautilo-relay-host] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
