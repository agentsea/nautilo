import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export type ProtocolSurface =
  | "client_request"
  | "response"
  | "client_notification"
  | "server_request"
  | "server_notification"
  | "thread_item";

export interface ProtocolInventoryEntry {
  surface: ProtocolSurface;
  name: string;
  generatedFile: string;
}

export interface ProtocolInventory {
  schemaVersion: 1;
  entries: ProtocolInventoryEntry[];
  counts: Record<ProtocolSurface, number>;
}

const UNION_FILES = [
  {
    file: "ClientRequest.ts",
    surface: "client_request",
    discriminator: "method",
  },
  {
    file: "ClientNotification.ts",
    surface: "client_notification",
    discriminator: "method",
  },
  {
    file: "ServerRequest.ts",
    surface: "server_request",
    discriminator: "method",
  },
  {
    file: "ServerNotification.ts",
    surface: "server_notification",
    discriminator: "method",
  },
  {
    file: join("v2", "ThreadItem.ts"),
    surface: "thread_item",
    discriminator: "type",
  },
] as const satisfies ReadonlyArray<{
  file: string;
  surface: ProtocolSurface;
  discriminator: "method" | "type";
}>;

const SURFACES: readonly ProtocolSurface[] = [
  "client_request",
  "response",
  "client_notification",
  "server_request",
  "server_notification",
  "thread_item",
];

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function listFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files.sort();
}

function unionEntries(
  typescriptRoot: string,
  file: string,
  surface: ProtocolSurface,
  discriminator: "method" | "type",
): ProtocolInventoryEntry[] {
  const absoluteFile = join(typescriptRoot, file);
  if (!existsSync(absoluteFile)) {
    throw new Error(`Required generated union is missing: ${file}`);
  }

  const source = readFileSync(absoluteFile, "utf8");
  const expression = new RegExp(`"${discriminator}"\\s*:\\s*"([^"]+)"`, "g");
  const names = [...source.matchAll(expression)].map((match) => match[1]!);
  const uniqueNames = [...new Set(names)];

  if (uniqueNames.length === 0) {
    throw new Error(`Generated union has no ${discriminator} members: ${file}`);
  }

  return uniqueNames.map((name) => ({
    surface,
    name,
    generatedFile: toPortablePath(file),
  }));
}

function responseEntries(typescriptRoot: string): ProtocolInventoryEntry[] {
  return listFiles(typescriptRoot)
    .filter((file) => file.endsWith("Response.ts"))
    .map((file) => {
      const generatedFile = toPortablePath(relative(typescriptRoot, file));
      const name = basename(file, ".ts");

      return { surface: "response" as const, name, generatedFile };
    });
}

export function collectProtocolInventory(
  typescriptRoot: string,
): ProtocolInventory {
  const entries = [
    ...UNION_FILES.flatMap(({ file, surface, discriminator }) =>
      unionEntries(typescriptRoot, file, surface, discriminator),
    ),
    ...responseEntries(typescriptRoot),
  ].sort(
    (left, right) =>
      left.surface.localeCompare(right.surface) ||
      left.name.localeCompare(right.name) ||
      left.generatedFile.localeCompare(right.generatedFile),
  );

  const duplicateKeys = entries
    .map((entry) => `${entry.surface}:${entry.name}`)
    .filter((key, index, all) => all.indexOf(key) !== index);
  if (duplicateKeys.length > 0) {
    throw new Error(
      `Duplicate protocol inventory members: ${[...new Set(duplicateKeys)].join(", ")}`,
    );
  }

  const counts = Object.fromEntries(
    SURFACES.map((surface) => [
      surface,
      entries.filter((entry) => entry.surface === surface).length,
    ]),
  ) as Record<ProtocolSurface, number>;

  for (const surface of SURFACES) {
    if (counts[surface] === 0) {
      throw new Error(`Protocol inventory surface is empty: ${surface}`);
    }
  }

  return { schemaVersion: 1, entries, counts };
}
