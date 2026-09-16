import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "../../..");
test("Tart setup consumes an immutable baseline without an official publisher in source", () => {
  const setup = readFileSync(join(root, "scripts/security-test-env/setup-macos.sh"), "utf8");
  expect(setup).toMatch(/BASE_IMAGE_PREBUILT="ghcr\.io\/agentsea\/nautilo-tart-baseline@sha256:[a-f0-9]{64}"/);
  expect(setup).toContain('tart clone "$BASE_IMAGE" "$BASELINE_VM"');
  expect(setup).toContain("bun run writer:prepare");
  for (const removed of ["scripts/security-test-env/build-tart-base-image.sh", "scripts/publication/assert-canonical-source.sh"]) {
    expect(existsSync(join(root, removed))).toBe(false);
  }
  expect(setup).not.toContain("build-tart-base-image.sh");
  expect(readFileSync(join(root, "scripts/security-test-env/README.md"), "utf8")).not.toContain("tart push");
});

test("the paired smoke Relay starts on explicit demand after server readiness", () => {
  const setup = readFileSync(join(root, "scripts/security-test-env/setup-macos.sh"), "utf8");
  const relayStart = setup.indexOf("cat > /Users/admin/Library/LaunchAgents/com.nautilo.relay.plist");
  const relayPlist = setup.slice(relayStart, setup.indexOf("\nPLIST", relayStart));
  expect(relayStart).toBeGreaterThan(0);
  // SuccessfulExit implies RunAtLoad even when its value is false. The fixture
  // must not begin an initial connection/relaunch cycle before the server exists.
  expect(relayPlist).not.toContain("<key>KeepAlive</key>");
  expect(relayPlist).not.toContain("<key>SuccessfulExit</key>");
  expect(relayPlist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  expect(relayPlist).toContain("/etc/nautilo/start-smoke-relay.sh");
  expect(relayPlist).toContain("<key>NODE_ENV</key><string>production</string>");

  const serverStart = setup.indexOf("cat > /Library/LaunchDaemons/com.nautilo.test-server.plist");
  const serverPlist = setup.slice(serverStart, setup.indexOf("\nPLIST", serverStart));
  expect(serverStart).toBeGreaterThan(0);
  expect(serverPlist).toContain("<key>KeepAlive</key>");
  expect(serverPlist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);

  const kickstart = setup.indexOf('launchctl kickstart -kp "gui/$(id -u)/com.nautilo.relay"');
  expect(kickstart).toBeGreaterThan(setup.indexOf('if [ "$HEALTH_OK" -eq 0 ]; then'));
  expect(kickstart).toBeGreaterThan(setup.indexOf('launchctl bootstrap "gui/$(id -u)"'));
  expect(setup).toContain('case "$RELAY_PID" in');
  expect(setup).toContain('grep -Fqx "smoke-relay-pid=$1"');
  expect(setup).toContain('smoke-relay-readiness "$RELAY_PID"');
});
