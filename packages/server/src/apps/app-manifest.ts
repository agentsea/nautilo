import {
  OFFICE_TRANSFORM_FORMATS,
  OFFICE_TRANSFORM_OPERATIONS,
} from "@nautilo/config/officecli";
import { isCapabilitySlug } from "@nautilo/types";
import { z } from "zod";

const MINI_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ACCESS_LEVEL = z.enum(["none", "read", "readwrite"]);
const CREATE_ACTION_SURFACE = z.enum(["workspace", "currentFolder"]);

const TOOL_RUNTIME = z.literal("server");
const TOOL_IMPACT = z.enum(["read-only", "low", "high", "destructive"]);
const TOOL_APPROVAL_MODE = z.enum(["static", "hybrid"]);
const TOOL_RESULT_SCAN_POLICY = z.enum(["always", "on-suspicious", "never"]);
const OFFICE_TRANSFORM_FORMAT = z.enum(OFFICE_TRANSFORM_FORMATS);
const OFFICE_TRANSFORM_OPERATION = z.enum(OFFICE_TRANSFORM_OPERATIONS);

const FORBIDDEN_TOOL_MODULE_SEGMENTS = new Set([
  ".cache",
  "node_modules",
  "dist",
  "build",
  "out",
]);

const HANDLER_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

const JSON_SCHEMA_MAX_DEPTH = 10;
const JSON_SCHEMA_MAX_PROPERTIES = 64;
const JSON_SCHEMA_MAX_ENUM_VALUES = 128;
const JSON_SCHEMA_MAX_REQUIRED = 64;
const JSON_SCHEMA_MAX_ONE_OF_BRANCHES = 16;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function getRelativeAppPathValidationError(value: string, field: string): string | null {
  if (value.length === 0) {
    return `${field} must not be empty`;
  }
  if (hasControlChars(value)) {
    return `${field} contains control characters`;
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return `${field} must be a relative path`;
  }
  const segments = value.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    return `${field} must not contain parent traversal`;
  }
  return null;
}

function validateRelativeAppPath(value: string, ctx: z.RefinementCtx, field: string): void {
  const error = getRelativeAppPathValidationError(value, field);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
}

export function getToolModulePathValidationError(value: string): string | null {
  const relativeError = getRelativeAppPathValidationError(value, "module");
  if (relativeError) return relativeError;

  const segments = value.split(/[/\\]/);
  for (const segment of segments) {
    if (FORBIDDEN_TOOL_MODULE_SEGMENTS.has(segment)) {
      return "module must not reference generated, cache, or dependency paths";
    }
  }
  return null;
}

function validateToolModulePath(value: string, ctx: z.RefinementCtx, field: string): void {
  const error = getToolModulePathValidationError(value);
  if (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: field === "module" ? error : `${field}: ${error}`,
    });
  }
}

function validateToolHandlerName(value: string, ctx: z.RefinementCtx, field: string): void {
  if (value.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must not be empty` });
    return;
  }
  if (hasControlChars(value) || /\s/.test(value) || /[[\]{}]/.test(value) || value.includes("..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must be a safe identifier or dot path`,
    });
    return;
  }
  if (!HANDLER_IDENTIFIER_PATTERN.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must be a safe identifier or dot path`,
    });
  }
}

function walkBoundedJsonSchemaNode(
  node: unknown,
  depth: number,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
  insideOneOf = false,
): void {
  if (depth > JSON_SCHEMA_MAX_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inputSchema exceeds maximum nesting depth",
      path,
    });
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inputSchema contains an invalid nested schema node",
      path,
    });
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith("$")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema must not use ${key}`,
        path: [...path, key],
      });
    }
  }

  for (const combiner of ["anyOf", "allOf", "not", "if", "then", "else"] as const) {
    if (combiner in record) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema must not use ${combiner} in V1`,
        path: [...path, combiner],
      });
    }
  }

  if ("const" in record) {
    const value = record["const"];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema.const must be a JSON scalar",
        path: [...path, "const"],
      });
    }
  }

  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (
      key in record &&
      (typeof record[key] !== "number" ||
        !Number.isSafeInteger(record[key]) ||
        record[key] < 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema.${key} must be a non-negative integer`,
        path: [...path, key],
      });
    }
  }
  for (const [minKey, maxKey] of [
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minimum", "maximum"],
  ] as const) {
    const min = record[minKey];
    const max = record[maxKey];
    if (
      min !== undefined &&
      max !== undefined &&
      typeof min === "number" &&
      typeof max === "number" &&
      min > max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema.${minKey} must not exceed ${maxKey}`,
        path,
      });
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (key in record && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema.${key} must be a finite number`,
        path: [...path, key],
      });
    }
  }

  if ("oneOf" in record) {
    const oneOf = record["oneOf"];
    if (insideOneOf) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema must not nest oneOf",
        path: [...path, "oneOf"],
      });
      return;
    }
    if (Object.keys(record).some((key) => key !== "oneOf")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema oneOf must not be mixed with sibling schema keywords",
        path,
      });
    }
    if (
      !Array.isArray(oneOf) ||
      oneOf.length < 2 ||
      oneOf.length > JSON_SCHEMA_MAX_ONE_OF_BRANCHES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema.oneOf must contain 2–${JSON_SCHEMA_MAX_ONE_OF_BRANCHES} branches`,
        path: [...path, "oneOf"],
      });
      return;
    }

    const discriminatorValues = new Set<string>();
    let discriminatorKey: "kind" | "op" | null = null;
    for (let i = 0; i < oneOf.length; i++) {
      const branchPath = [...path, "oneOf", i];
      const branch: unknown = (oneOf as unknown[])[i];
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputSchema.oneOf branches must be object schemas",
          path: branchPath,
        });
        continue;
      }
      const branchRecord = branch as Record<string, unknown>;
      const properties = branchRecord["properties"];
      const required = branchRecord["required"];
      const propertyRecord =
        properties && typeof properties === "object" && !Array.isArray(properties)
          ? properties as Record<string, unknown>
          : {};
      const discriminatorKeys = (["kind", "op"] as const).filter((key) => {
        const schema = propertyRecord[key];
        return Boolean(schema) && typeof schema === "object" && !Array.isArray(schema) &&
          typeof (schema as Record<string, unknown>)["const"] === "string";
      });
      const branchDiscriminatorKey = discriminatorKeys.length === 1
        ? discriminatorKeys[0]
        : undefined;
      const discriminatorSchema = branchDiscriminatorKey
        ? propertyRecord[branchDiscriminatorKey] as Record<string, unknown>
        : null;
      const discriminator = discriminatorSchema?.["const"];
      if (
        branchRecord["type"] !== "object" ||
        branchRecord["additionalProperties"] !== false
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputSchema.oneOf branches must be strict object schemas",
          path: branchPath,
        });
      }
      if (
        !branchDiscriminatorKey ||
        !Array.isArray(required) ||
        !required.includes(branchDiscriminatorKey) ||
        typeof discriminator !== "string" ||
        discriminator.length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'inputSchema.oneOf branches require one common required string const discriminator property named "kind" or "op"',
          path: branchPath,
        });
      } else if (discriminatorKey !== null && discriminatorKey !== branchDiscriminatorKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputSchema.oneOf branches must use the same discriminator property",
          path: [...branchPath, "properties", branchDiscriminatorKey],
        });
      } else if (discriminatorValues.has(discriminator)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `inputSchema.oneOf discriminator value "${discriminator}" is duplicated`,
          path: [...branchPath, "properties", branchDiscriminatorKey, "const"],
        });
      } else {
        discriminatorKey ??= branchDiscriminatorKey;
        discriminatorValues.add(discriminator);
      }
      walkBoundedJsonSchemaNode(branch, depth + 1, branchPath, ctx, true);
    }
    return;
  }

  if ("enum" in record) {
    const enumValues = record["enum"];
    if (!Array.isArray(enumValues)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema.enum must be an array",
        path: [...path, "enum"],
      });
    } else if (enumValues.length > JSON_SCHEMA_MAX_ENUM_VALUES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema.enum exceeds maximum allowed values",
        path: [...path, "enum"],
      });
    }
  }

  if ("properties" in record) {
    const properties = record["properties"];
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema.properties must be an object",
        path: [...path, "properties"],
      });
    } else {
      const propertyRecord = properties as Record<string, unknown>;
      const propertyKeys = Object.keys(propertyRecord);
      if (propertyKeys.length > JSON_SCHEMA_MAX_PROPERTIES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputSchema.properties exceeds maximum allowed properties",
          path: [...path, "properties"],
        });
      }
      for (const propertyKey of propertyKeys) {
        walkBoundedJsonSchemaNode(propertyRecord[propertyKey], depth + 1, [...path, "properties", propertyKey], ctx, insideOneOf);
      }
    }
  }

  if ("required" in record) {
    const required = record["required"];
    if (!Array.isArray(required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputSchema.required must be an array",
        path: [...path, "required"],
      });
    } else {
      if (required.length > JSON_SCHEMA_MAX_REQUIRED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputSchema.required exceeds maximum allowed entries",
          path: [...path, "required"],
        });
      }
      for (let i = 0; i < required.length; i++) {
        if (typeof required[i] !== "string") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "inputSchema.required entries must be strings",
            path: [...path, "required", i],
          });
        }
      }
    }
  }

  if ("items" in record) {
    const items = record["items"];
    if (Array.isArray(items)) {
      if (items.length > JSON_SCHEMA_MAX_PROPERTIES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputSchema tuple items exceed maximum allowed entries",
          path: [...path, "items"],
        });
      }
      for (let i = 0; i < items.length; i++) {
        walkBoundedJsonSchemaNode(items[i], depth + 1, [...path, "items", i], ctx, insideOneOf);
      }
    } else {
      walkBoundedJsonSchemaNode(items, depth + 1, [...path, "items"], ctx, insideOneOf);
    }
  }
}

function validateBoundedToolInputSchema(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inputSchema must be a JSON object",
      path,
    });
    return;
  }

  const schema = value as Record<string, unknown>;
  if (schema["type"] !== "object") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'inputSchema.type must be "object"',
      path: [...path, "type"],
    });
  }

  if (!("additionalProperties" in schema) || schema["additionalProperties"] !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inputSchema.additionalProperties must be false",
      path: [...path, "additionalProperties"],
    });
  }

  walkBoundedJsonSchemaNode(schema, 0, path, ctx);
}

function sanitizeForGeneratedToolName(value: string): string {
  return value.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

export function generateMiniAppAgentToolName(appId: string, toolId: string): string {
  return `app_${sanitizeForGeneratedToolName(appId)}__${sanitizeForGeneratedToolName(toolId)}`;
}

function validateExtension(value: string, ctx: z.RefinementCtx): void {
  if (!value.startsWith(".")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "extension must start with '.'" });
    return;
  }
  if (value.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "extension must include a suffix" });
    return;
  }
  if (value.includes("/") || value.includes("\\") || hasControlChars(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "extension must not contain path separators or control characters",
    });
  }
}

function validateMimeType(value: string, ctx: z.RefinementCtx): void {
  if (value.length === 0 || hasControlChars(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mimeType must be a non-empty string without control characters",
    });
  }
}

const relativeAppPathSchema = z
  .string()
  .superRefine((value, ctx) => validateRelativeAppPath(value, ctx, "path"));

const toolModulePathSchema = z
  .string()
  .superRefine((value, ctx) => validateToolModulePath(value, ctx, "module"));

function validateFilename(value: string, ctx: z.RefinementCtx): void {
  if (value.trim().length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "defaultFilename must not be empty" });
    return;
  }
  if (value.includes("/") || value.includes("\\") || value === "." || value === ".." || hasControlChars(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "defaultFilename must be a basename without path separators",
    });
  }
}

const CreateActionSchema = z
  .object({
    id: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "id must match [a-z0-9][a-z0-9-]{0,63}"),
    label: z.string().min(1),
    defaultFilename: z.string().superRefine(validateFilename),
    mimeType: z.string().superRefine((value, ctx) => validateMimeType(value, ctx)),
    targetSurfaces: z.array(CREATE_ACTION_SURFACE).min(1),
    template: z
      .object({
        kind: z.literal("file"),
        path: relativeAppPathSchema,
      })
      .strict(),
    openAfterCreate: z.boolean().optional(),
  })
  .strict();

const ContentAssociationSchema = z
  .object({
    id: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "id must match [a-z0-9][a-z0-9-]{0,63}"),
    kind: z.literal("html-script-json"),
    scriptId: z.string().min(1),
    scriptType: z.string().superRefine((value, ctx) => validateMimeType(value, ctx)),
    match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

const MiniAppAgentToolManifestSchema = z
  .object({
    id: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "id must match [a-z0-9][a-z0-9-]{0,63}"),
    title: z.string().min(1).optional(),
    description: z.string().min(1),
    runtime: TOOL_RUNTIME,
    module: toolModulePathSchema,
    handler: z.string().superRefine((value, ctx) => validateToolHandlerName(value, ctx, "handler")),
    inputSchema: z.unknown().superRefine((value, ctx) => {
      validateBoundedToolInputSchema(value, ctx, ["inputSchema"]);
    }),
    impact: TOOL_IMPACT,
    requiredCapability: z.union([z.null(), z.string()]).optional(),
    approvalMode: TOOL_APPROVAL_MODE.optional(),
    resultScanPolicy: TOOL_RESULT_SCAN_POLICY.optional(),
    officeTransform: z
      .object({
        format: OFFICE_TRANSFORM_FORMAT,
        operation: OFFICE_TRANSFORM_OPERATION,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((tool, ctx) => {
    if (tool.requiredCapability === undefined) return;
    if (tool.requiredCapability === null) return;
    if (!isCapabilitySlug(tool.requiredCapability)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requiredCapability must be a canonical capability slug or null",
        path: ["requiredCapability"],
      });
    }
  });

const CONVERSION_SURFACE = z.enum(["workspace", "currentFolder"]);

const ConversionFromSchema = z
  .object({
    extensions: z
      .array(z.string().superRefine((value, ctx) => validateExtension(value, ctx)))
      .optional(),
    mimeTypes: z
      .array(z.string().superRefine((value, ctx) => validateMimeType(value, ctx)))
      .optional(),
  })
  .strict()
  .superRefine((from, ctx) => {
    const hasExt = (from.extensions?.length ?? 0) > 0;
    const hasMime = (from.mimeTypes?.length ?? 0) > 0;
    if (!hasExt && !hasMime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must include at least one extension or mimeType",
      });
    }
  });

const ConversionToSchema = z
  .object({
    extension: z.string().superRefine((value, ctx) => validateExtension(value, ctx)),
    mimeType: z.string().superRefine((value, ctx) => validateMimeType(value, ctx)),
  })
  .strict();

const ConversionImportSchema = z
  .object({
    id: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "id must match [a-z0-9][a-z0-9-]{0,63}"),
    label: z.string().min(1),
    from: ConversionFromSchema,
    sourceSurfaces: z.array(CONVERSION_SURFACE).min(1),
    tool: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "tool must match [a-z0-9][a-z0-9-]{0,63}"),
    target: z
      .object({
        surface: CONVERSION_SURFACE,
        extension: z.string().superRefine((value, ctx) => validateExtension(value, ctx)),
      })
      .strict(),
    openAfterImport: z.boolean().optional(),
  })
  .strict();

const ConversionExportSchema = z
  .object({
    selectWorkspaceDestination: z.boolean().optional(),
    prepareInApp: z.boolean().optional(),
    id: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "id must match [a-z0-9][a-z0-9-]{0,63}"),
    label: z.string().min(1),
    to: ConversionToSchema,
    tool: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "tool must match [a-z0-9][a-z0-9-]{0,63}"),
    targetSurfaces: z.array(CONVERSION_SURFACE).min(1),
  })
  .strict();

const ConversionsSchema = z
  .object({
    import: z.array(ConversionImportSchema).optional(),
    export: z.array(ConversionExportSchema).optional(),
  })
  .strict();

// This is a bounded request only. It deliberately carries no module path,
// handler, or other executable reference; the server's boot registry decides
// whether an app receives a live-review implementation.
const LiveReviewRequestSchema = z
  .object({
    enabled: z.literal(true),
  })
  .strict();

const MiniAppManifestSchema = z
  .object({
    id: z
      .string()
      .regex(MINI_APP_ID_PATTERN, "id must match [a-z0-9][a-z0-9-]{0,63}"),
    name: z.string().min(1),
    // D344 — optional one-line description shown in the Apps panel rows.
    description: z.string().min(1).max(280).optional(),
    display: z
      .object({
        groupId: z.string().min(1).max(80).optional(),
        groupName: z.string().min(1).max(80).optional(),
        groupOrder: z.number().int().optional(),
        appOrder: z.number().int().optional(),
        defaultCollapsed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    version: z.string().min(1),
    entry: relativeAppPathSchema,
    html: relativeAppPathSchema,
    styles: z.array(relativeAppPathSchema).optional(),
    fileAssociations: z
      .object({
        extensions: z
          .array(z.string().superRefine((value, ctx) => validateExtension(value, ctx)))
          .optional(),
        mimeTypes: z
          .array(z.string().superRefine((value, ctx) => validateMimeType(value, ctx)))
          .optional(),
      })
      .strict(),
    capabilities: z
      .object({
        document: z
          .object({
            artifact: ACCESS_LEVEL.optional(),
            currentFolder: ACCESS_LEVEL.optional(),
          })
          .strict()
          .optional(),
        state: ACCESS_LEVEL.optional(),
        office: z.enum(["none", "convert"]).optional(),
      })
      .strict(),
    agent: z
      .object({
        contextProvider: z.string().min(1).optional(),
        instructions: z.string().min(1).max(12_000).optional(),
        tools: z.array(MiniAppAgentToolManifestSchema).optional(),
      })
      .strict()
      .optional(),
    liveReview: LiveReviewRequestSchema.optional(),
    createActions: z.array(CreateActionSchema).optional(),
    contentAssociations: z.array(ContentAssociationSchema).optional(),
    conversions: ConversionsSchema.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const toolIds = new Set((manifest.agent?.tools ?? []).map((t) => t.id));
    const conversions = manifest.conversions;
    if (conversions) {
      const checkGroup = (
        entries: Array<{ id: string; tool: string }> | undefined,
        direction: "import" | "export",
      ): void => {
        if (!entries) return;
        const seen = new Set<string>();
        entries.forEach((entry, i) => {
          if (seen.has(entry.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `duplicate conversions.${direction} id: ${entry.id}`,
              path: ["conversions", direction, i, "id"],
            });
          }
          seen.add(entry.id);
          if (!toolIds.has(entry.tool)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `conversions.${direction}[${i}].tool references unknown agent tool id: ${entry.tool}`,
              path: ["conversions", direction, i, "tool"],
            });
          }
        });
      };
      checkGroup(conversions.import, "import");
      checkGroup(conversions.export, "export");
    }

    const tools = manifest.agent?.tools;
    if (!tools || tools.length === 0) return;

    const seenIds = new Set<string>();
    const seenGeneratedNames = new Set<string>();
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i]!;
      if (
        tool.officeTransform !== undefined &&
        manifest.capabilities.office !== "convert"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "officeTransform requires capabilities.office to be convert",
          path: ["agent", "tools", i, "officeTransform"],
        });
      }
      if (seenIds.has(tool.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate agent tool id: ${tool.id}`,
          path: ["agent", "tools", i, "id"],
        });
      }
      seenIds.add(tool.id);

      const generatedName = generateMiniAppAgentToolName(manifest.id, tool.id);
      if (seenGeneratedNames.has(generatedName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `generated tool name collision: ${generatedName}`,
          path: ["agent", "tools", i, "id"],
        });
      }
      seenGeneratedNames.add(generatedName);
    }
  });

export type MiniAppAgentToolManifest = z.infer<typeof MiniAppAgentToolManifestSchema>;
export type MiniAppManifest = z.infer<typeof MiniAppManifestSchema>;

export type MiniAppManifestValidationResult =
  | { ok: true; manifest: MiniAppManifest }
  | { ok: false; error: string };

export function parseMiniAppManifestJson(raw: unknown): MiniAppManifestValidationResult {
  return validateMiniAppManifest(raw);
}

export function validateMiniAppManifest(raw: unknown): MiniAppManifestValidationResult {
  const parsed = MiniAppManifestSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  const message = issue?.message ?? "invalid manifest";
  return { ok: false, error: `${path}${message}` };
}

export function isSafeMiniAppId(value: string): boolean {
  return MINI_APP_ID_PATTERN.test(value);
}
