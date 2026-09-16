export { getHostingMode, isCloudMode, type HostingMode } from "./hosting-mode";
export {
  PASSWORD_RECOVERY_DRIVERS,
  getPasswordRecoveryDriver,
  passwordRecoveryUsesOssRelay,
  type PasswordRecoveryDriver,
} from "./password-recovery-driver";

export {
  NautiloConfigSchema,
  type NautiloConfig,
  type NautiloConfigOverrides,
  NautiloUserConfigSchema,
  type NautiloUserConfig,
  type InstanceNetworkConfig,
  type InstanceHostnameConfig,
  normalizeUserConfig,
  setConfigOverrides,
  invalidateRuntimeConfigCache,
  fromRuntimeConfig,
  SecurityLevelSchema,
  DeploymentModeSchema,
  NetworkPolicySchema,
  NetworkAllowRuleSchema,
  ToolExposureModeSchema,
  defaultNetworkPolicyForDeploymentMode,
  resolveServerPosture,
  type ServerPosture,
  type DeploymentMode,
  type SecurityLevel,
  type NetworkPolicy,
  type NetworkAllowRule,
  type ToolExposureMode,
} from "./config";

export {
  type NautiloRuntimePaths,
  resolveNautiloRootDir,
  parseNautiloInstanceId,
  resolveNautiloRuntimePaths,
} from "./runtime-paths";

export { resolveDefaultWorkbenchDist } from "./workbench-dist";

export {
  NAUTILO_INSTANCE_ID_PATTERN,
  isCanonicalNautiloInstanceId,
  validateNautiloInstanceIdValue,
  resolveNautiloStorageRoot,
} from "./instance-id";

export {
  applyInstanceArgFromArgv,
  stripInstancePairFromArgv,
} from "./apply-instance-arg-from-argv";

export {
  resolveInstance,
  resolveInstanceUncached,
  __resetResolvedInstanceForTests,
  writeInstanceJson,
  markDeployConfigConsumed,
  readDeployConfigConsumedAt,
  type ResolvedInstance,
  type ResolveInstanceOptions,
} from "./resolve-instance";

export {
  effectiveServerDisplayHost,
  effectiveServerScheme,
  isLanServerHost,
  resolveEffectiveServerUrl,
} from "./effective-server-url";

/** D112 — instance deployment mode (`instance.json` / `NAUTILO_DEPLOYMENT_MODE`). */
export {
  INSTANCE_DEPLOYMENT_MODES,
  INSTANCE_PORT_BUNDLE_STRIDE,
  INSTANCE_GENERATED_HOST_PORT_BASES,
  DERIVED_INSTANCE_HOST_PORT_BASES,
  type InstanceDeploymentMode,
} from "./instance-defaults";

/** M088B — server-owned artifact byte storage root. */
export {
  getArtifactsRoot,
  getAppsRoot,
  getMediaStorageRoot,
  getProfileAvatarsRoot,
  getServerIconRoot,
  validateArtifactsRootEnv,
  validateMediaStorageRootEnv,
} from "./instance-defaults";
export type { ArtifactsRootValidation, MediaStorageRootValidation } from "./instance-defaults";

export { InstanceJsonSchema, type InstanceJson } from "./resolve-instance-schema";

export {
  deriveComposeContainerBundle,
  type ComposeContainerBundle,
} from "./compose-container-names";

export {
  resolvedInstanceChildEnv,
  officeHostPort,
  collaboraHostPort,
  openConnectorHostPort,
} from "./instance-child-env";

export {
  discoverNautiloLayoutRoots,
  collectClaimedPortsFromSiblingInstances,
  pickFirstNonCollidingPortBundle,
  MAX_PORT_BUNDLE_STRIDE,
  type PortBundle,
  type PickNonCollidingPortBundleOptions,
} from "./sibling-instance-ports";

/** Process-local packaged-CLI seam; ordinary source/npm resolution is the default. */
export { setHostPortLivenessProbeExecutableForProcess } from "./host-port-liveness";

export {
  InstanceAllocationBusyError,
  instanceAllocationLockPath,
  withInstanceAllocationLockSync,
  type InstanceAllocationLockOptions,
} from "./instance-allocation-lock";

export { ensureDirectoryTree } from "./ensure-directory-tree";
export { migrateStorageLayout } from "./migrate-storage-layout";

export {
  type StorageProvider,
  type StorageZoneName,
  type StorageZones,
  type RelayStorageZones,
  type StorageFileStat,
  StorageError,
  StoragePathTraversalError,
  StorageNotFoundError,
  StoragePermissionError,
} from "./storage-provider";

export { LocalStorageProvider } from "./local-storage-provider";
export { createStorageZones, toRelayStorageZones } from "./create-storage-zones";

export {
  composeFederatedId,
  parseFederatedId,
  normalizeHandle,
  validateHandle,
  slugifyToHandle,
  getServerHostname,
  type HandleValidation,
} from "./federated-id";

export {
  ConfigSecretResolutionError,
  connectionRefFromSecretName,
  parseConfigValueRef,
  resolveConfigValueRef,
  secretNameForConnection,
  secretRefForConnection,
  type ConfigSecretResolutionErrorCode,
  type ConfigValueRef,
} from "./secret-ref";

export {
  NAUTILO_DESIGN_TOKENS,
  NAUTILO_BRAND_ACCENT,
  NAUTILO_HOSTED_AUTH_PRIMARY,
  NAUTILO_PRE_AUTH_LAYOUT_TOKENS,
  NAUTILO_THEME_MODES,
  NAUTILO_ONBOARDING_CSS_VAR_NAMES,
  NAUTILO_ONBOARDING_PALETTE_DARK,
  NAUTILO_ONBOARDING_PALETTE_LIGHT,
  formatOnboardingPaletteCssBlock,
  type NautiloDesignTokens,
  type NautiloOnboardingCssVarName,
  type NautiloOnboardingCssVars,
  type NautiloThemeMode,
} from "./design-tokens";

/** D104 Phase 5 — shared product/colors/copy for Logto hosted UI and other surfaces. */
export {
  NAUTILO_PRODUCT_NAME,
  NAUTILO_BRAND_COLOR_PRIMARY_LIGHT,
  NAUTILO_BRAND_COLOR_PRIMARY_DARK,
  NAUTILO_HOSTED_AUTH_COPY,
  NAUTILO_HOSTED_AUTH_CSS_PALETTE,
  NAUTILO_HOSTED_AUTH_CSS_DERIVED,
  NAUTILO_HOSTED_AUTH_CSS_CUSTOM_PROPERTIES,
  formatHostedAuthCssCustomPropertiesBlock,
  hexToRgba,
  getLogtoHostedSignInColorPatch,
} from "./brand-tokens";

export {
  MODEL_ROLE_CANDIDATES,
  candidatesForModelRole,
  type ModelRole,
} from "./model-role-candidates";
