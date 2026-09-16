import type { ResolvedInstance } from "@nautilo/config";
import { httpsMode } from "./https-mode.ts";
import type { ComposeDriverProfile } from "./types.ts";

export interface BuildCaddyfileInput {
  profile: ComposeDriverProfile;
  inst: ResolvedInstance;
  acmeEmail: string;
}

/**
 * Pure mapper: (profile, inst, acmeEmail) → Caddyfile text.
 *
 * Two vhosts when https=letsencrypt:
 *   {$NAUTILO_DOMAIN}        → nautilo-server:3001
 *   auth.{$NAUTILO_DOMAIN}   → logto:{$NAUTILO_DEPLOY_LOGTO_PORT}
 *
 * The acme_ca directive is emitted ONLY when profile.acme_staging===true.
 * Caddy defaults to the LE production endpoint when acme_ca is omitted.
 *
 * Caddy interpolates {$VAR} placeholders from compose env at startup.
 */
export function buildCaddyfile(input: BuildCaddyfileInput): string {
  const mode = httpsMode(input.profile);
  switch (mode) {
    case "off":
      throw new Error("buildCaddyfile: https=off profiles do not use Caddy");
    case "letsencrypt": {
      return [
        "{",
        "    email {$ACME_EMAIL}",
        ...(input.profile.acme_staging === true
          ? ["    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory"]
          : []),
        "    servers :443 {",
        "        protocols h1 h2",
        "    }",
        "}",
        "",
        "{$NAUTILO_DOMAIN} {",
        // Clients with a cached H3 Alt-Svc mapping must be told to drop it;
        // Electron's direct HTTP/3 asset path is unstable while HTTP/2 is not.
        '    header Alt-Svc "clear"',
        // M201 — compress responses to the browser (coolwsd's multi-MB
        // bundle.js/css + WASM). The office proxy forwards engine assets
        // decompressed, so without this they cross the WAN uncompressed;
        // `encode` shrinks them ~6-8× on the wire. Skips already-encoded +
        // tiny bodies automatically.
        //
        // SSE exclusion: the @sse matcher catches the artifact-events stream
        // (and any future SSE path). SSE responses must NOT be compressed
        // (gzip requires buffering the whole response) and MUST have
        // flush_interval -1 so Caddy forwards each event immediately instead
        // of holding it in a buffer. Without this, artifact loading times out
        // (~15-16s) because the event stream never reaches the browser.
        "    @sse path /api/workspace/artifacts/events*",
        "    reverse_proxy @sse nautilo-server:3001 {",
        "        flush_interval -1",
        "    }",
        "    encode zstd gzip",
        "    reverse_proxy nautilo-server:3001",
        "}",
        "",
        "auth.{$NAUTILO_DOMAIN} {",
        '    header Alt-Svc "clear"',
        "    reverse_proxy logto:{$NAUTILO_DEPLOY_LOGTO_PORT}",
        "}",
        "",
      ].join("\n");
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`buildCaddyfile: unhandled https mode ${String(_exhaustive)}`);
    }
  }
}
