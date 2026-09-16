import type { CoverageSurface } from "../model";

export const DTO_TRANSPORTS = [
  "http",
  "ws",
  "sse",
  "relay",
  "app_bridge",
] as const;

export type DtoTransport = (typeof DTO_TRANSPORTS)[number];

export type DtoDirection =
  | "request_response"
  | "client_to_server"
  | "server_to_client"
  | "produced"
  | "accepted"
  | "app_to_host"
  | "host_to_app"
  | "accepted_arbitrary"
  | "produced_arbitrary"
  | "client_to_server_arbitrary"
  | "server_to_client_arbitrary"
  | "app_to_host_arbitrary"
  | "host_to_app_arbitrary"
  | "declared_arbitrary";

export type DtoInventoryObservation = {
  readonly id: string;
  readonly surface: Extract<CoverageSurface, "wire">;
  readonly locator: string;
  readonly transport: DtoTransport;
  readonly direction: DtoDirection;
  readonly contract: string;
  readonly sourcePath: string;
  /**
   * Deterministic, reviewable request/response/event payload shapes. These are
   * part of the observation identity contract: a closed DTO field or type
   * change must create declaration drift just like an open payload change.
   */
  readonly structuralSignatures: readonly string[];
  /**
   * Exact leaf paths whose source type is deliberately open (`unknown`,
   * `unknown[]`, or `Record<string, unknown>`). These paths are observations,
   * not classifications: a declaration must name a closed schema for each.
   */
  readonly arbitraryPayloads: readonly string[];
};

export type DtoArbitraryPayloadDeclaration = {
  readonly path: string;
} & (
  | {
      readonly schema: string;
      readonly debtId?: never;
    }
  | {
      readonly schema?: never;
      readonly debtId: string;
    }
);

export type DtoDeclaration = {
  readonly observationId: string;
  readonly locator: string;
  readonly structuralSignatures?: readonly string[];
  readonly arbitraryPayloads: readonly DtoArbitraryPayloadDeclaration[];
};

export type DtoDeclarationAuditResult =
  | {
      readonly ok: true;
      readonly counts: {
        readonly observations: number;
        readonly declarations: number;
        readonly arbitraryPayloads: number;
      };
    }
  | { readonly ok: false; readonly errors: readonly string[] };

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    else seen.add(value);
  }
  return [...duplicate].sort();
}

function exactPayloadPath(path: string): boolean {
  return path.length > 0
    && path.trim() === path
    && !path.includes("*")
    && !path.endsWith(".")
    && !path.startsWith(".");
}

function concreteSchema(schema: string): boolean {
  const normalized = schema.toLowerCase();
  return normalized.length >= 3
    && !/\s/.test(schema)
    && !normalized.includes("*")
    && !normalized.includes("unknown")
    && normalized !== "any"
    && normalized !== "json"
    && !normalized.startsWith("record<string,");
}

function concreteDebtId(debtId: unknown): boolean {
  return typeof debtId === "string"
    && /^debt[.][a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(debtId);
}

/**
 * Compare mechanical observations with Human-reviewed declarations. This is
 * intentionally strict: missing/stale/duplicate declarations and any open
 * payload without an exact closed schema are blocking results.
 */
export function auditDtoDeclarations(input: {
  readonly observations: readonly DtoInventoryObservation[];
  readonly declarations: readonly DtoDeclaration[];
}): DtoDeclarationAuditResult {
  const errors: string[] = [];

  for (const id of duplicates(input.observations.map((item) => item.id))) {
    errors.push(`duplicate DTO observation id: ${id}`);
  }
  for (const locator of duplicates(input.observations.map((item) => item.locator))) {
    errors.push(`duplicate DTO observation locator: ${locator}`);
  }
  for (const id of duplicates(input.declarations.map((item) => item.observationId))) {
    errors.push(`duplicate DTO declaration id: ${id}`);
  }
  for (const locator of duplicates(input.declarations.map((item) => item.locator))) {
    errors.push(`duplicate DTO declaration locator: ${locator}`);
  }

  const observationById = new Map(input.observations.map((item) => [item.id, item]));
  const declarationById = new Map(input.declarations.map((item) => [item.observationId, item]));
  for (const observation of [...input.observations].sort((left, right) =>
    left.locator.localeCompare(right.locator, "en")
  )) {
    if (!declarationById.has(observation.id)) {
      errors.push(`missing DTO declaration: ${observation.locator}`);
    }
  }
  for (const declaration of [...input.declarations].sort((left, right) =>
    left.locator.localeCompare(right.locator, "en")
  )) {
    if (!observationById.has(declaration.observationId)) {
      errors.push(`stale DTO declaration: ${declaration.locator}`);
    }
  }

  for (const declaration of input.declarations) {
    const observed = observationById.get(declaration.observationId);
    if (!observed) continue;
    if (declaration.locator !== observed.locator) {
      errors.push(`${declaration.observationId}: declaration locator does not match observation`);
      continue;
    }

    const declaredSignatures = declaration.structuralSignatures ?? [];
    for (const signature of duplicates(declaredSignatures)) {
      errors.push(`${observed.locator}: duplicate structural signature: ${signature}`);
    }
    const expectedSignatures = new Set(observed.structuralSignatures);
    const actualSignatures = new Set(declaredSignatures);
    for (
      const signature of [...expectedSignatures]
        .filter((item) => !actualSignatures.has(item))
    ) {
      errors.push(`${observed.locator}: missing structural signature: ${signature}`);
    }
    for (
      const signature of [...actualSignatures]
        .filter((item) => !expectedSignatures.has(item))
    ) {
      errors.push(`${observed.locator}: stale structural signature: ${signature}`);
    }

    const declaredPaths = declaration.arbitraryPayloads.map((item) => item.path);
    for (const path of [...new Set(declaredPaths.filter((item) => !exactPayloadPath(item)))].sort()) {
      errors.push(`${observed.locator}: arbitrary payload path must be exact: ${path}`);
    }
    for (const path of duplicates(declaredPaths)) {
      errors.push(`${observed.locator}: duplicate arbitrary payload declaration: ${path}`);
    }
    for (const item of declaration.arbitraryPayloads) {
      if ("schema" in item && typeof item.schema === "string") {
        if (!concreteSchema(item.schema)) {
          errors.push(`${observed.locator}: schema must be concrete for ${item.path}`);
        }
      } else if (!concreteDebtId(
        (item as { readonly debtId?: unknown }).debtId,
      )) {
        errors.push(`${observed.locator}: schema must be concrete for ${item.path}`);
      }
    }

    const expectedPaths = new Set(observed.arbitraryPayloads);
    const actualPaths = new Set(declaredPaths);
    for (const path of [...expectedPaths].filter((item) => !actualPaths.has(item)).sort()) {
      errors.push(`${observed.locator}: missing arbitrary payload declaration: ${path}`);
    }
    for (const path of [...actualPaths].filter((item) => !expectedPaths.has(item)).sort()) {
      errors.push(`${observed.locator}: unexpected arbitrary payload declaration: ${path}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    counts: {
      observations: input.observations.length,
      declarations: input.declarations.length,
      arbitraryPayloads: input.declarations.reduce(
        (count, declaration) => count + declaration.arbitraryPayloads.length,
        0,
      ),
    },
  };
}
