import { describe, expect, test } from "bun:test";
import { buildCaddyOverlay } from "../../src/buildCaddyOverlay.ts";

describe("buildCaddyOverlay", () => {
  test("emits Caddy service, volumes, and port suppressions", () => {
    const out = buildCaddyOverlay();
    expect(out).toContain("caddy:");
    expect(out).toContain("image: caddy:2-alpine");
    expect(out).toContain('"80:80"');
    expect(out).toContain('"443:443"');
    expect(out).toContain(
      "${NAUTILO_DEPLOY_CADDYFILE_PATH}:/etc/caddy/Caddyfile:ro",
    );
    expect(out).toContain("caddy_data:");
    expect(out).toContain("caddy_config:");
    expect(out).toContain("nautilo-server:\n    ports: !reset []");
    // Logto core keeps its user-facing reachability. Logto admin stays
    // published on host loopback because bootstrap reaches it through an SSH
    // tunnel. Resetting either here would break an existing supported path.
    expect(out).not.toContain("logto:\n    ports:");
  });
});
