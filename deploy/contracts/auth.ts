/**
 * Secret-free desired-state contract for the Logto configuration managed by
 * `bootstrap-logto.ts`. This is intentionally descriptive only: it neither
 * reads instance configuration nor reconciles a running Logto server.
 */
import { createHash } from "node:crypto";
import { DEPENDENCY_PINS } from "../dependency-pins";
import {
  ACCOUNT_CENTER_ENABLE_PATCH_BODY,
  APP_NAMES,
  DESKTOP_POST_LOGOUT_REDIRECT_URIS,
  DESKTOP_REDIRECT_URIS,
  FORGOT_PASSWORD_WEBHOOK_SECRET_KEY,
  LOGTO_ENV_KEY_NAMES,
  LOGTO_RESOURCE_NAME,
  MOBILE_POST_LOGOUT_REDIRECT_URIS,
  MOBILE_REDIRECT_URIS,
  ORG_ROLES_TO_SEED,
  SIGN_IN_EXP_USERNAME_PATCH_BODY,
  TUI_LOOPBACK_REDIRECT_URIS,
  TUI_REDIRECT_URIS,
  WORKBENCH_OIDC_REDIRECT_PATHS,
  WORKBENCH_POST_LOGOUT_REDIRECT_PATHS,
} from "../../bin/nautilo-local/src/bootstrap-logto";
import { LOGTO_HOSTED_BRANDING_RULE_VERSION } from "../../bin/nautilo-local/src/logto-hosted-auth-branding";
import {
  FORGOT_PASSWORD_EMAIL_METHOD,
  HTTP_EMAIL_CONNECTOR_ID,
} from "../../bin/nautilo-local/src/logto-forgot-password-relay";

export const AUTH_CONTRACT_VERSION = 1;
export const URI_DERIVATION_RULE_VERSION = "workbench-origin-aliases-v1";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type AuthContract = Readonly<{
  version: number;
  hash: string;
  managedDesiredStateHash: string;
  logtoEngine: Readonly<{
    image: string;
    minimumVersion: string;
  }>;
  uriDerivationRuleVersion: string;
  requiredEnvKeyNames: readonly string[];
  impact: Readonly<{
    requiresExplicitAuthReconcile: boolean;
    mayAffectExistingSessions: boolean;
  }>;
  desiredState: JsonValue;
}>;

/**
 * Parses the secret-free contract copied into a server image. The release
 * lane fails closed when an image does not contain a structurally valid
 * contract instead of falling back to the CLI's bundled source contract.
 */
export function parseAuthContract(raw: string): AuthContract {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("incoming auth contract is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("incoming auth contract must be an object");
  }
  const contract = value as Record<string, unknown>;
  const logtoEngine = contract["logtoEngine"];
  const impact = contract["impact"];
  const valid =
    typeof contract["version"] === "number" &&
    typeof contract["hash"] === "string" &&
    typeof contract["managedDesiredStateHash"] === "string" &&
    typeof contract["uriDerivationRuleVersion"] === "string" &&
    Array.isArray(contract["requiredEnvKeyNames"]) &&
    contract["requiredEnvKeyNames"].every((key) => typeof key === "string") &&
    logtoEngine !== null &&
    typeof logtoEngine === "object" &&
    typeof (logtoEngine as Record<string, unknown>)["image"] === "string" &&
    typeof (logtoEngine as Record<string, unknown>)["minimumVersion"] === "string" &&
    impact !== null &&
    typeof impact === "object" &&
    typeof (impact as Record<string, unknown>)["requiresExplicitAuthReconcile"] ===
      "boolean" &&
    typeof (impact as Record<string, unknown>)["mayAffectExistingSessions"] ===
      "boolean" &&
    "desiredState" in contract;
  if (!valid) {
    throw new Error("incoming auth contract has an invalid shape");
  }
  return contract as unknown as AuthContract;
}

/** Stable JSON encoding makes hashes independent of object insertion order. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Builds the desired state from bootstrap's exported constants. Never add
 * runtime IDs, URLs, or secret values here: those are instance-specific.
 */
export function buildManagedAuthDesiredState(): JsonValue {
  return {
    applications: [
      {
        key: "workbench",
        name: APP_NAMES.workbench,
        type: "SPA",
        uris: {
          kind: "instance-derived",
          redirectPaths: [...WORKBENCH_OIDC_REDIRECT_PATHS],
          postLogoutPaths: [...WORKBENCH_POST_LOGOUT_REDIRECT_PATHS],
          ruleVersion: URI_DERIVATION_RULE_VERSION,
        },
      },
      {
        key: "tui",
        name: APP_NAMES.tui,
        type: "Native",
        redirectUris: [...TUI_REDIRECT_URIS],
        postLogoutRedirectUris: [],
        customClientMetadata: {
          allowTokenExchange: true,
          isDeviceFlow: true,
        },
      },
      {
        key: "tuiLoopback",
        name: APP_NAMES.tuiLoopback,
        type: "Native",
        redirectUris: [...TUI_LOOPBACK_REDIRECT_URIS],
        postLogoutRedirectUris: [],
      },
      {
        key: "desktop",
        name: APP_NAMES.desktop,
        type: "Native",
        redirectUris: [...DESKTOP_REDIRECT_URIS],
        postLogoutRedirectUris: [...DESKTOP_POST_LOGOUT_REDIRECT_URIS],
      },
      {
        key: "mobile",
        name: APP_NAMES.mobile,
        type: "Native",
        redirectUris: [...MOBILE_REDIRECT_URIS],
        postLogoutRedirectUris: [...MOBILE_POST_LOGOUT_REDIRECT_URIS],
      },
      {
        key: "m2m",
        name: APP_NAMES.m2m,
        type: "MachineToMachine",
      },
    ],
    resource: {
      indicator: { kind: "env-derived", key: "LOGTO_RESOURCE" },
      name: LOGTO_RESOURCE_NAME,
    },
    organizationRoles: [...ORG_ROLES_TO_SEED],
    signInExperience: {
      accountCenter: ACCOUNT_CENTER_ENABLE_PATCH_BODY,
      passwordPolicy: { rejects: { pwned: false } },
      username: SIGN_IN_EXP_USERNAME_PATCH_BODY,
      hostedBranding: {
        requiredFields: ["color", "customCss", "unknownSessionRedirectUrl"],
        ruleVersion: LOGTO_HOSTED_BRANDING_RULE_VERSION,
      },
      forgotPassword: {
        method: FORGOT_PASSWORD_EMAIL_METHOD,
        connector: {
          connectorId: HTTP_EMAIL_CONNECTOR_ID,
          configKeys: ["endpoint", "authorization"],
          enabledWhen: "forgot-password-relay-configured",
        },
      },
    },
  };
}

export function buildAuthContract(): AuthContract {
  const desiredState = buildManagedAuthDesiredState();
  const managedDesiredStateHash = sha256(desiredState);
  const contractBody = {
    version: AUTH_CONTRACT_VERSION,
    managedDesiredStateHash,
    logtoEngine: {
      image: DEPENDENCY_PINS.logto,
      minimumVersion: DEPENDENCY_PINS.logtoImageTag,
    },
    uriDerivationRuleVersion: URI_DERIVATION_RULE_VERSION,
    requiredEnvKeyNames: [
      ...LOGTO_ENV_KEY_NAMES,
      FORGOT_PASSWORD_WEBHOOK_SECRET_KEY,
    ],
    impact: {
      requiresExplicitAuthReconcile: true,
      mayAffectExistingSessions: true,
    },
    desiredState,
  } as const;

  return {
    ...contractBody,
    hash: sha256(contractBody),
  };
}

export function serializeAuthContract(contract = buildAuthContract()): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
