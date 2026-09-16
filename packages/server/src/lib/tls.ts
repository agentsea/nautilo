import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

export interface TlsCerts {
  caKey: Buffer;
  caCert: Buffer;
  serverKey: Buffer;
  serverCert: Buffer;
  fingerprint: string;
}

const CA_KEY = "ca.key";
const CA_CERT = "ca.crt";
const SERVER_KEY = "server.key";
const SERVER_CERT = "server.crt";

function sha256Fingerprint(cert: Buffer): string {
  return createHash("sha256").update(cert).digest("hex").match(/.{2}/g)!.join(":");
}

function opensslAvailable(): boolean {
  try {
    execSync("openssl version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function buildSANs(customHostname: string): string {
  const sans = new Set([
    "DNS:localhost",
    `DNS:${customHostname}`,
    `DNS:${hostname()}.local`,
    "DNS:*.local",
    "IP:127.0.0.1",
    "IP:::1",
  ]);
  return [...sans].join(",");
}

function generateCA(certsDir: string): void {
  const keyPath = join(certsDir, CA_KEY);
  const certPath = join(certsDir, CA_CERT);

  execSync(
    `openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 ` +
    `-subj "/CN=Nautilo Local CA" ` +
    `-keyout "${keyPath}" -out "${certPath}"`,
    { stdio: "ignore" },
  );
}

function generateServerCert(certsDir: string, customHostname: string): void {
  const caKeyPath = join(certsDir, CA_KEY);
  const caCertPath = join(certsDir, CA_CERT);
  const keyPath = join(certsDir, SERVER_KEY);
  const certPath = join(certsDir, SERVER_CERT);
  const csrPath = join(certsDir, "server.csr");

  const sans = buildSANs(customHostname);

  // Generate server key + CSR
  execSync(
    `openssl req -new -nodes -newkey rsa:2048 ` +
    `-subj "/CN=${customHostname}" ` +
    `-keyout "${keyPath}" -out "${csrPath}"`,
    { stdio: "ignore" },
  );

  // Sign with CA, including SANs
  execSync(
    `openssl x509 -req -sha256 -days 365 ` +
    `-in "${csrPath}" ` +
    `-CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial ` +
    `-extfile <(echo "subjectAltName=${sans}") ` +
    `-out "${certPath}"`,
    { stdio: "ignore", shell: "/bin/bash" },
  );

  // Clean up CSR
  try { execSync(`rm "${csrPath}" "${join(certsDir, "ca.srl")}"`, { stdio: "ignore" }); } catch { /* best effort */ }
}

/**
 * Ensure a local CA and server certificate exist in certsDir.
 * Generates on first boot, reuses on subsequent boots.
 * The server cert is signed by the local CA — clients that trust the CA
 * will see a green padlock for any cert signed by it.
 *
 * @param certsDir - Directory to store certs (typically ~/.nautilo/certs/)
 * @param customHostname - Friendly hostname for the server (default: "nautilo.local")
 */
export function ensureCerts(
  certsDir: string,
  customHostname: string = "nautilo.local",
): TlsCerts {
  mkdirSync(certsDir, { recursive: true });

  if (!opensslAvailable()) {
    throw new Error(
      "[tls] openssl not found. Install OpenSSL to enable HTTPS.\n" +
      "  macOS: brew install openssl\n" +
      "  Ubuntu: sudo apt install openssl\n" +
      "LAN mode requires TLS; localhost mode runs HTTP and doesn't need openssl.",
    );
  }

  const caKeyPath = join(certsDir, CA_KEY);
  const caCertPath = join(certsDir, CA_CERT);
  const serverKeyPath = join(certsDir, SERVER_KEY);
  const serverCertPath = join(certsDir, SERVER_CERT);

  // Generate CA if missing
  if (!existsSync(caKeyPath) || !existsSync(caCertPath)) {
    generateCA(certsDir);
  }

  // Generate server cert if missing, or regenerate if hostname changed
  let needsServerCert = !existsSync(serverKeyPath) || !existsSync(serverCertPath);

  if (!needsServerCert) {
    // Check if current cert covers the requested hostname
    try {
      const certText = execSync(
        `openssl x509 -in "${serverCertPath}" -noout -ext subjectAltName 2>/dev/null`,
        { encoding: "utf-8" },
      );
      if (!certText.includes(customHostname)) {
        needsServerCert = true;
      }
    } catch {
      needsServerCert = true;
    }
  }

  if (needsServerCert) {
    generateServerCert(certsDir, customHostname);
  }

  const caCert = readFileSync(caCertPath);
  const serverCert = readFileSync(serverCertPath);

  return {
    caKey: readFileSync(caKeyPath),
    caCert,
    serverKey: readFileSync(serverKeyPath),
    serverCert,
    fingerprint: sha256Fingerprint(serverCert),
  };
}

/**
 * Load the CA cert for client-side pinning.
 * Used by API clients to trust the local server.
 */
export function loadCACert(certsDir: string): Buffer | null {
  const caCertPath = join(certsDir, CA_CERT);
  if (!existsSync(caCertPath)) return null;
  return readFileSync(caCertPath);
}
