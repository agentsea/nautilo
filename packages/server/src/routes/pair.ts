import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

export interface PairRouteDeps {
  certsDir: string;
  hostname: string;
  port: number;
}

type PairingCode = {
  code: string;
  expiresAt: number;
  used: boolean;
};

const activeCodes = new Map<string, PairingCode>();
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [code, entry] of activeCodes) {
    if (entry.expiresAt < now || entry.used) {
      activeCodes.delete(code);
    }
  }
}

export function pairRoutes(app: FastifyInstance, deps: PairRouteDeps) {
  const { certsDir, hostname, port } = deps;

  // -------------------------------------------------------------------------
  // POST /api/pair/generate — owner generates a one-time pairing code
  // -------------------------------------------------------------------------

  app.post("/api/pair/generate", async (request, reply) => {
    if (request.policyContext?.actorRole !== "owner") {
      return reply.status(401).send({ error: "Authentication required" });
    }

    cleanExpired();

    const code = generateCode();
    activeCodes.set(code, {
      code,
      expiresAt: Date.now() + CODE_TTL_MS,
      used: false,
    });

    const scheme = "http"; // pairing page served over HTTP (cert not installed yet)
    const url = `${scheme}://${hostname}:${port}/pair/${code}`;

    return reply.send({ code, url });
  });

  // -------------------------------------------------------------------------
  // GET /pair/:code — the pairing page (served over HTTP)
  // -------------------------------------------------------------------------

  app.get<{ Params: { code: string } }>("/pair/:code", async (request, reply) => {
    const { code } = request.params;
    const entry = activeCodes.get(code);

    if (!entry || entry.used || entry.expiresAt < Date.now()) {
      return reply.status(410).type("text/html").send(
        "<html><body style='font-family:system-ui;background:#12141a;color:#e8e8ec;display:flex;justify-content:center;align-items:center;height:100vh'>" +
        "<div style='text-align:center'><h2>Link expired</h2><p>Ask the owner to generate a new pairing code.</p></div>" +
        "</body></html>"
      );
    }

    entry.used = true;

    const ua = (request.headers["user-agent"] ?? "").toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua);
    const isAndroid = /android/.test(ua);

    const certUrl = `/pair/${code}/cert`;
    const profileUrl = `/pair/${code}/profile`;
    const httpsUrl = `https://${hostname}:${port}`;

    let installButton: string;
    let instructions: string;

    if (isIOS) {
      installButton = `<a href="${profileUrl}" style="display:inline-block;background:#4f8ff7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1.1rem">Install Certificate Profile</a>`;
      instructions = `<p style="margin-top:1rem;color:#999">After tapping, go to <strong>Settings → General → VPN & Device Management</strong> to complete installation. Then enable trust in <strong>Settings → General → About → Certificate Trust Settings</strong>.</p>`;
    } else if (isAndroid) {
      installButton = `<a href="${certUrl}" style="display:inline-block;background:#4CAF50;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1.1rem">Install Certificate</a>`;
      instructions = `<p style="margin-top:1rem;color:#999">Your device will open the certificate installer automatically. Name it "Nautilo" and tap OK.</p>`;
    } else {
      installButton = `<a href="${certUrl}" download="nautilo-ca.crt" style="display:inline-block;background:#7c4dff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1.1rem">Download Certificate</a>`;
      instructions = `<p style="margin-top:1rem;color:#999"><strong>macOS:</strong> Double-click the downloaded file → Keychain Access → mark as "Always Trust"<br><strong>Windows:</strong> Double-click → Install Certificate → Local Machine → Trusted Root CAs</p>`;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Nautilo</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#12141a;color:#e8e8ec;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem">
<div style="max-width:420px;text-align:center">
  <div style="font-size:2.5rem;margin-bottom:0.5rem">🔐</div>
  <h1 style="font-size:1.5rem;font-weight:600;margin:0 0 0.5rem">Connect to Nautilo</h1>
  <p style="color:#999;margin:0 0 1.5rem">Install this certificate so your device trusts your Nautilo server. This is a one-time step.</p>
  ${installButton}
  ${instructions}
  <p style="margin-top:2rem;color:#666;font-size:0.85rem">After installing, visit:<br><a href="${httpsUrl}" style="color:#4f8ff7">${httpsUrl}</a></p>
</div>
</body>
</html>`;

    return reply.type("text/html").send(html);
  });

  // -------------------------------------------------------------------------
  // GET /pair/:code/cert — download the CA certificate
  // -------------------------------------------------------------------------

  app.get<{ Params: { code: string } }>("/pair/:code/cert", async (_request, reply) => {
    try {
      const caCert = readFileSync(join(certsDir, "ca.crt"));
      return reply
        .header("Content-Type", "application/x-x509-ca-cert")
        .header("Content-Disposition", 'attachment; filename="nautilo-ca.crt"')
        .send(caCert);
    } catch {
      return reply.status(500).send({ error: "Certificate not found" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /pair/:code/profile — iOS .mobileconfig profile
  // -------------------------------------------------------------------------

  app.get<{ Params: { code: string } }>("/pair/:code/profile", async (_request, reply) => {
    try {
      const caCertPem = readFileSync(join(certsDir, "ca.crt"), "utf-8");
      const certBase64 = caCertPem
        .replace("-----BEGIN CERTIFICATE-----", "")
        .replace("-----END CERTIFICATE-----", "")
        .replace(/\s/g, "");

      const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>nautilo-ca.crt</string>
      <key>PayloadContent</key>
      <data>${certBase64}</data>
      <key>PayloadDescription</key>
      <string>Adds the Nautilo local CA certificate</string>
      <key>PayloadDisplayName</key>
      <string>Nautilo Local CA</string>
      <key>PayloadIdentifier</key>
      <string>dev.nautilo.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${crypto.randomUUID()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Nautilo Network Certificate</string>
  <key>PayloadDescription</key>
  <string>Trust your local Nautilo server for secure connections.</string>
  <key>PayloadIdentifier</key>
  <string>dev.nautilo.profile</string>
  <key>PayloadOrganization</key>
  <string>Nautilo</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${crypto.randomUUID()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;

      return reply
        .header("Content-Type", "application/x-apple-aspen-config")
        .header("Content-Disposition", 'attachment; filename="nautilo.mobileconfig"')
        .send(profile);
    } catch {
      return reply.status(500).send({ error: "Certificate not found" });
    }
  });
}
