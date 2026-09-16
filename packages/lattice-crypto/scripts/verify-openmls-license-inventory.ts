import { readFile } from "node:fs/promises";

interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

function identity(value: PackageIdentity): string {
  return `${value.name}@${value.version}`;
}

function compareIdentity(left: PackageIdentity, right: PackageIdentity): number {
  const leftValue = identity(left);
  const rightValue = identity(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

const packageRoot = new URL("../", import.meta.url);
const lock = await readFile(
  new URL("openmls-wasm/Cargo.lock", packageRoot),
  "utf8",
);
const notice = await readFile(
  new URL("THIRD_PARTY_NOTICES.cargo.md", packageRoot),
  "utf8",
);

const locked = lock.split(/\n\[\[package\]\]\n/u)
  .slice(1)
  .flatMap((block): PackageIdentity[] => {
    if (!/^source = "registry\+/mu.test(block)) return [];
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    if (name === undefined || version === undefined) {
      throw new Error("Cargo.lock contains an incomplete registry package");
    }
    return [{ name, version }];
  })
  .sort(compareIdentity);

const noticed = [...notice.matchAll(
  /^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| \[crates\.io\]\(https:\/\/crates\.io\/crates\/([^/]+)\/([^)]+)\) \|$/gmu,
)].map((match): PackageIdentity => {
  const [, name, version, license, sourceName, sourceVersion] = match;
  if (
    name === undefined
    || version === undefined
    || license === undefined
    || sourceName === undefined
    || sourceVersion === undefined
    || license.trim().length === 0
    || sourceName !== name
    || decodeURIComponent(sourceVersion) !== version
  ) {
    throw new Error("Cargo license notice contains an invalid row");
  }
  return { name, version };
}).sort(compareIdentity);

const claimedCount = /Resolved registry packages: ([0-9]+)\./u.exec(notice)?.[1];
if (claimedCount === undefined || Number(claimedCount) !== locked.length) {
  throw new Error(
    "Cargo license notice resolved-package count does not match Cargo.lock",
  );
}
const lockedIds = locked.map(identity);
const noticedIds = noticed.map(identity);
if (
  new Set(lockedIds).size !== lockedIds.length
  || new Set(noticedIds).size !== noticedIds.length
) {
  throw new Error("Cargo lock or license notice contains duplicate identities");
}
if (
  lockedIds.length !== noticedIds.length
  || lockedIds.some((value, index) => value !== noticedIds[index])
) {
  const missing = lockedIds.filter((value) => !noticedIds.includes(value));
  const stale = noticedIds.filter((value) => !lockedIds.includes(value));
  throw new Error(
    `Cargo license inventory drift; missing=${missing.join(",")}; stale=${
      stale.join(",")
    }`,
  );
}

process.stdout.write(
  `OpenMLS Cargo license inventory verified: ${locked.length} registry packages.\n`,
);
