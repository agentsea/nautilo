import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Reviewed release risk, not a claim that the affected implementations are safe.
// Changing the wrapper, lock, binary, finding, or compatible candidate requires review.
export const review = {
  reviewedAt: "2026-10-24T00:00:00Z",
  expiresAt: "2026-10-31T00:00:00Z",
  hashes: {
    "openmls-wasm/Cargo.lock":
      "9d02b24f94ad56fd385124672fc98b5a14781614de825ec72e5310d7aae2a806",
    "openmls-wasm/Cargo.toml":
      "703fe5f2d19b8522d26ccd221ef305d71f3527d6e720d959676bf33d654e46be",
    "openmls-wasm/src/lib.rs":
      "b812dff2950491c7f40c8a376c4dae5ffd018ae2697c2cd045acd785ee1ec638",
    "vendor/openmls-wasm/openmls_wasm_bg.wasm":
      "eaf881b96ce5c00e4c95a9f906e68f8611779df3d6f06fe17c45b5174ca7fb4b",
  },
} as const;

type Decision = {
  id: string;
  name: string;
  version: string;
  checksum: string;
  patched: string[];
  cvss: string | null;
};

const availability =
  "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N";
const integrity =
  "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N";
export const decisions: Decision[] = [
  {
    id: "RUSTSEC-2026-0387",
    name: "crypto-bigint",
    version: "0.5.5",
    checksum:
      "0dc92fb57ca44df6db8059111ab3af99a63d5d0f8375d9972e319a379c6bab76",
    patched: [">=0.7.6"],
    cvss: null,
  },
  {
    id: "RUSTSEC-2026-0209",
    name: "libcrux-aesgcm",
    version: "0.0.7",
    checksum:
      "99f2a019dab4097585a7d4f5b9deebe46cd1e628b16a5bc4cb0ce35e1da334e6",
    patched: [],
    cvss: integrity,
  },
  {
    id: "RUSTSEC-2026-0211",
    name: "libcrux-aesgcm",
    version: "0.0.7",
    checksum:
      "99f2a019dab4097585a7d4f5b9deebe46cd1e628b16a5bc4cb0ce35e1da334e6",
    patched: [],
    cvss: integrity,
  },
  {
    id: "RUSTSEC-2026-0124",
    name: "libcrux-chacha20poly1305",
    version: "0.0.7",
    checksum:
      "cc08d044676af21343b32b988411fa98dbb5cf65a03c9df478ced221bbdfdb1b",
    patched: [">=0.0.8"],
    cvss: availability,
  },
  {
    id: "RUSTSEC-2026-0331",
    name: "libcrux-kem",
    version: "0.0.7",
    checksum:
      "12631592f491d22fd1a176d32b2c6edfb673998fd3987e9d95f8fa79ad2a737b",
    patched: [">=0.0.10"],
    cvss: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N",
  },
  {
    id: "RUSTSEC-2026-0330",
    name: "libcrux-kem",
    version: "0.0.7",
    checksum:
      "12631592f491d22fd1a176d32b2c6edfb673998fd3987e9d95f8fa79ad2a737b",
    patched: [">=0.0.10"],
    cvss: "CVSS:4.0/AV:L/AC:L/AT:P/PR:H/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N",
  },
  {
    id: "RUSTSEC-2026-0212",
    name: "libcrux-secrets",
    version: "0.0.5",
    checksum:
      "1ce650f3041b44ba40d4263852347d007cd2cd9d1cc856a6f6c8b2e10c3fd40b",
    patched: [">=0.0.6"],
    cvss: availability,
  },
  {
    id: "RUSTSEC-2026-0207",
    name: "libcrux-sha3",
    version: "0.0.8",
    checksum:
      "b1ae0b7d0e1cc4793a609fd0ff2ca3b3a3fabae523770c619a3d4bc86417b0d7",
    patched: [">=0.0.10"],
    cvss: availability,
  },
  {
    id: "RUSTSEC-2026-0208",
    name: "libcrux-sha3",
    version: "0.0.8",
    checksum:
      "b1ae0b7d0e1cc4793a609fd0ff2ca3b3a3fabae523770c619a3d4bc86417b0d7",
    patched: [">=0.0.10"],
    cvss: availability,
  },
];

const warnings = [
  [
    "RUSTSEC-2024-0384",
    "instant",
    "0.1.13",
    "e0242819d153cba4b4b05a5a8f2a7e9bbf97b6055b2a002b395c96b5ff3c0222",
  ],
  [
    "RUSTSEC-2026-0210",
    "libcrux-aesgcm",
    "0.0.7",
    "99f2a019dab4097585a7d4f5b9deebe46cd1e628b16a5bc4cb0ce35e1da334e6",
  ],
  [
    "RUSTSEC-2026-0173",
    "proc-macro-error2",
    "2.0.1",
    "11ec05c52be0a07b08061f7dd003e7d7092e0472bc731b4af7bb1ef876109802",
  ],
];

// Reviewed stable candidates in the actual supported dependency chains. Any new
// compatible release stops this exception path, even before the review expires.
const candidates = [
  ["openmls", "^0.8.1", "0.8.3"],
  ["openmls_rust_crypto", "^0.5", "0.5.1"],
  ["hpke-rs", "^0.6", "0.6.1"],
  ["hpke-rs-libcrux", "^0.6", "0.6.1"],
  ["hpke-rs-rust-crypto", "^0.6", "0.6.1"],
  ["p256", "^0.13", "0.13.2"],
  ["elliptic-curve", "^0.13.1", "0.13.8"],
  ["crypto-bigint", "^0.5", "0.5.5"],
  ["libcrux-aesgcm", "^0.0.7", "0.0.7"],
  ["libcrux-chacha20poly1305", "^0.0.7", "0.0.7"],
  ["libcrux-kem", "^0.0.7", "0.0.7"],
  ["libcrux-secrets", "=0.0.5", "0.0.5"],
  ["libcrux-sha3", "^0.0.8", "0.0.8"],
] as const;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Malformed audit object",
  );
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value), "Malformed audit array");
  return value;
}

function same(actual: unknown, expected: unknown, message: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

export function validateReview(now: Date, hashes: Record<string, string>) {
  assert(
    now.getTime() >= Date.parse(review.reviewedAt) &&
      now.getTime() < Date.parse(review.expiresAt),
    "OpenMLS exception review is expired or not yet valid",
  );
  for (const [path, hash] of Object.entries(review.hashes)) {
    same(hashes[path], hash, `OpenMLS reviewed bytes changed: ${path}`);
  }
}

function identity(value: unknown) {
  const finding = object(value);
  const advisory = object(finding["advisory"]);
  const pkg = object(finding["package"]);
  const versions = object(finding["versions"]);
  same(
    pkg["source"],
    "registry+https://github.com/rust-lang/crates.io-index",
    "Unreviewed package registry",
  );
  same(pkg["replace"], null, "Unreviewed package replacement");
  same(advisory["package"], pkg["name"], "Advisory package mismatch");
  same(advisory["withdrawn"], null, "Withdrawn advisory requires review");
  same(versions["unaffected"], [], "Changed unaffected range requires review");
  return { finding, advisory, pkg, versions };
}

export function evaluateAudit(input: unknown) {
  const report = object(input);
  const database = object(report["database"]);
  assert(
    typeof database["last-commit"] === "string" &&
      /^[0-9a-f]{40}$/.test(database["last-commit"]),
    "Missing advisory database identity",
  );
  const settings = object(report["settings"]);
  for (const key of ["ignore", "target_arch", "target_os"])
    same(
      settings[key],
      [],
      "Audit must scan the complete lock without ignores or target filters",
    );
  same(settings["severity"], null, "Audit must retain every severity");
  same(
    settings["informational_warnings"],
    ["unmaintained", "unsound", "notice"],
    "Audit warnings were filtered",
  );
  const vulnerabilities = object(report["vulnerabilities"]);
  const findings = array(vulnerabilities["list"]);
  same(vulnerabilities["count"], findings.length, "Audit count mismatch");
  same(
    vulnerabilities["found"],
    findings.length > 0,
    "Audit found flag mismatch",
  );
  const used = new Set<string>();
  for (const raw of findings) {
    const { advisory, pkg, versions } = identity(raw);
    const decision = decisions.find((entry) => entry.id === advisory["id"]);
    assert(
      decision && !used.has(decision.id),
      "Unreviewed or duplicate Rust vulnerability",
    );
    same(
      [
        pkg["name"],
        pkg["version"],
        pkg["checksum"],
        versions["patched"],
        advisory["cvss"],
        advisory["informational"],
      ],
      [
        decision.name,
        decision.version,
        decision.checksum,
        decision.patched,
        decision.cvss,
        null,
      ],
      `Changed Rust finding requires review: ${decision.id}`,
    );
    used.add(decision.id);
  }
  same(
    used.size,
    decisions.length,
    "Unused exception requires removal and review",
  );
  const seenWarnings = new Set<string>();
  for (const [kind, values] of Object.entries(object(report["warnings"]))) {
    same(kind, "unmaintained", "Unreviewed Rust warning category");
    for (const raw of array(values)) {
      const { finding, advisory, pkg, versions } = identity(raw);
      const expected = warnings.find(([id]) => id === advisory["id"]);
      assert(
        expected && !seenWarnings.has(expected[0]!),
        "Unreviewed or duplicate Rust warning",
      );
      same(
        [advisory["id"], pkg["name"], pkg["version"], pkg["checksum"]],
        expected,
        "Changed Rust warning requires review",
      );
      same(
        [
          finding["kind"],
          advisory["informational"],
          advisory["cvss"],
          versions["patched"],
        ],
        [kind, kind, null, []],
        "Changed Rust warning disposition",
      );
      seenWarnings.add(expected[0]!);
    }
  }
  same(
    seenWarnings.size,
    warnings.length,
    "Missing reviewed warning requires review",
  );
  return {
    exceptions: [...used],
    visibleWarnings: [...seenWarnings],
    expiresAt: review.expiresAt,
    database,
  };
}

export function verifyCandidate(
  raw: string,
  name: string,
  requirement: string,
  expected: string,
) {
  const releases = raw
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  const stable: string[] = [];
  for (const release of releases) {
    same(release["name"], name, "Registry package identity mismatch");
    assert(
      typeof release["vers"] === "string" &&
        /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(release["vers"]),
      "Malformed registry version",
    );
    assert(
      typeof release["yanked"] === "boolean" &&
        typeof release["cksum"] === "string" &&
        /^[0-9a-f]{64}$/.test(release["cksum"]),
      "Incomplete registry metadata",
    );
    if (
      !release["yanked"] &&
      !release["vers"].includes("-") &&
      Bun.semver.satisfies(release["vers"], requirement)
    )
      stable.push(release["vers"]);
  }
  same(
    stable.sort(Bun.semver.order).at(-1),
    expected,
    `Compatible candidate changed; patch or review required: ${name}`,
  );
  return createHash("sha256").update(raw).digest("hex");
}

async function main() {
  const reportPath = process.argv[2];
  assert(reportPath, "Usage: bun openmls-audit-policy.ts raw-cargo-audit.json");
  const packageRoot = new URL("../", import.meta.url);
  const hashes: Record<string, string> = {};
  for (const path of Object.keys(review.hashes))
    hashes[path] = createHash("sha256")
      .update(await readFile(new URL(path, packageRoot)))
      .digest("hex");
  validateReview(new Date(), hashes);
  const decision = evaluateAudit(
    JSON.parse(await readFile(reportPath, "utf8")),
  );
  const indexes = [];
  for (const [name, requirement, expected] of candidates) {
    const path =
      name.length === 1
        ? `1/${name}`
        : name.length === 2
          ? `2/${name}`
          : name.length === 3
            ? `3/${name[0]}/${name}`
            : `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
    const url = `https://index.crates.io/${path}`;
    // One bounded metadata request, no stale fallback or automatic retry. This
    // is an audit infrastructure deadline, never an exception to a finding.
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    assert(
      response.status === 200,
      `Fresh supported registry unavailable: ${name}`,
    );
    indexes.push({
      name,
      requirement,
      candidate: expected,
      url,
      indexSha256: verifyCandidate(
        await response.text(),
        name,
        requirement,
        expected,
      ),
    });
  }
  console.log(
    JSON.stringify(
      { checkedAt: new Date().toISOString(), ...decision, hashes, indexes },
      null,
      2,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
