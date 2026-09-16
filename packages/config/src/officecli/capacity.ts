/**
 * Semantic transformation intent and the stable profile identities that have a
 * locked product contract. Runtime budget enforcement deliberately lands
 * separately. Manifests declare only semantic intent; trusted host code asks
 * this policy owner for the selected profile.
 */
export const OFFICE_TRANSFORM_FORMATS = ["docx", "xlsx"] as const;
export type OfficeTransformFormat = (typeof OFFICE_TRANSFORM_FORMATS)[number];

export const OFFICE_TRANSFORM_OPERATIONS = ["import", "export", "inspect", "mutate"] as const;
export type OfficeTransformOperation = (typeof OFFICE_TRANSFORM_OPERATIONS)[number];

/**
 * Temporary compatibility envelope for the OfficeCLI runner. This replaces
 * Node's unusable 1 MiB `execFile` default while corpus qualification fixes
 * the production transformation profiles. It is deliberately not a Writer
 * product limit and must not be copied into callers or transport relays.
 */
export const OFFICECLI_STDIO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The runner collects each process stream independently. Keeping the two
 * limits together in this policy owner prevents a second, subtly different
 * clamp appearing at the child-process boundary.
 */
export const OFFICECLI_RUNNER_OUTPUT_LIMITS = Object.freeze({
  stdout: OFFICECLI_STDIO_MAX_BYTES,
  stderr: OFFICECLI_STDIO_MAX_BYTES,
});

export type OfficeCliOutputStage = keyof typeof OFFICECLI_RUNNER_OUTPUT_LIMITS;

export type OfficeTransformIntent = Readonly<{
  format: OfficeTransformFormat;
  operation: OfficeTransformOperation;
}>;

export const OFFICE_TRANSFORMATION_PROFILE_IDS = [
  "writer-import-v1",
  "writer-export-v1",
  "sheets-import-v1",
  "sheets-export-v1",
] as const;

export type OfficeTransformationProfileId =
  (typeof OFFICE_TRANSFORMATION_PROFILE_IDS)[number];

export function isOfficeTransformationProfileId(
  value: string,
): value is OfficeTransformationProfileId {
  return (OFFICE_TRANSFORMATION_PROFILE_IDS as readonly string[]).includes(value);
}

export type OfficeTransformProfileSelection = Readonly<{
  id: OfficeTransformationProfileId;
  intent: OfficeTransformIntent;
}>;

type RegisteredOfficeTransform = Readonly<{
  appId: string;
  toolId: string;
  selection: OfficeTransformProfileSelection;
}>;

const REGISTERED_OFFICE_TRANSFORMS: readonly RegisteredOfficeTransform[] = [
  {
    appId: "nautilo-writer",
    toolId: "import-docx",
    selection: { id: "writer-import-v1", intent: { format: "docx", operation: "import" } },
  },
  {
    appId: "nautilo-writer",
    toolId: "export-docx",
    selection: { id: "writer-export-v1", intent: { format: "docx", operation: "export" } },
  },
  {
    appId: "nautilo-spreadsheet",
    toolId: "import-xlsx",
    selection: { id: "sheets-import-v1", intent: { format: "xlsx", operation: "import" } },
  },
  {
    appId: "nautilo-spreadsheet",
    toolId: "export-xlsx",
    selection: { id: "sheets-export-v1", intent: { format: "xlsx", operation: "export" } },
  },
];

/**
 * Trusted runner/host admission seam. A manifest's semantic declaration is
 * checked against this registry; callers do not derive a profile from tool ids
 * or import a second registry.
 */
export function selectOfficeTransformProfile(input: Readonly<{
  appId: string;
  toolId: string;
  format: OfficeTransformFormat;
  operation: OfficeTransformOperation;
}>): OfficeTransformProfileSelection | undefined {
  const registered = REGISTERED_OFFICE_TRANSFORMS.find(
    (registered) =>
      registered.appId === input.appId &&
      registered.toolId === input.toolId &&
      registered.selection.intent.format === input.format &&
      registered.selection.intent.operation === input.operation,
  );
  if (!registered) return undefined;

  // Do not expose the registry object: admission callers must not be able to
  // mutate the policy selected for later invocations.
  return {
    id: registered.selection.id,
    intent: { ...registered.selection.intent },
  };
}
