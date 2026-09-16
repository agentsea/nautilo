import {
  createHostedDatabaseSecret,
  type HostedAppClusterCredentials,
  type HostedLogtoClusterCredentials,
} from "../utils/hosted-cluster-reconcile";

export type HostedBootstrapEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Stable, non-secret failures emitted by the one-shot bootstrap executable.
 * The actual environment variable values are deliberately never retained in
 * the error message: deployment logs are a receipt surface.
 */
export class HostedBootstrapInputError extends Error {
  constructor(readonly code: HostedBootstrapInputErrorCode) {
    super(code);
    this.name = "HostedBootstrapInputError";
  }
}

export type HostedBootstrapInputErrorCode =
  | "missing-app-postgres-admin-url"
  | "invalid-app-postgres-admin-url"
  | "missing-logto-postgres-admin-url"
  | "invalid-logto-postgres-admin-url"
  | "missing-app-nautilo-db-password"
  | "missing-app-nautilo-agent-db-password"
  | "missing-app-nautilo-crypto-db-password"
  | "missing-logto-db-password";

export interface HostedBootstrapConfig {
  readonly app: {
    readonly adminConnectionUrl: string;
    readonly credentials: HostedAppClusterCredentials;
  };
  readonly logto: {
    readonly adminConnectionUrl: string;
    readonly credentials: HostedLogtoClusterCredentials;
  };
}

function required(
  environment: HostedBootstrapEnvironment,
  name: string,
  code: HostedBootstrapInputErrorCode,
  options: { readonly trim: boolean } = { trim: false },
): string {
  const raw = environment[name];
  if (raw === undefined) throw new HostedBootstrapInputError(code);
  const value = options.trim ? raw.trim() : raw;
  if (value.length === 0) throw new HostedBootstrapInputError(code);
  return value;
}

/** Only complete postgres URIs can be used for this noninteractive job. */
function adminConnectionUrl(value: string, code: HostedBootstrapInputErrorCode): string {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || !parsed.hostname
      || !parsed.username
      || !parsed.password
    ) {
      throw new Error("invalid database URL");
    }
    return value;
  } catch {
    throw new HostedBootstrapInputError(code);
  }
}

/**
 * Read exactly the named variables supplied to the transient platform service.
 * They mirror the Railway topology slots rather than accepting ambiguous
 * DATABASE_URL fallbacks, which prevents accidentally reconciling the wrong
 * cluster when a hosting driver grows additional services.
 */
export function readHostedBootstrapConfig(
  environment: HostedBootstrapEnvironment = process.env,
): HostedBootstrapConfig {
  const appAdminUrl = adminConnectionUrl(
    required(
      environment,
      "APP_POSTGRES_ADMIN_URL",
      "missing-app-postgres-admin-url",
      { trim: true },
    ),
    "invalid-app-postgres-admin-url",
  );
  const logtoAdminUrl = adminConnectionUrl(
    required(
      environment,
      "LOGTO_POSTGRES_ADMIN_URL",
      "missing-logto-postgres-admin-url",
      { trim: true },
    ),
    "invalid-logto-postgres-admin-url",
  );

  return {
    app: {
      adminConnectionUrl: appAdminUrl,
      credentials: {
        nautilo: createHostedDatabaseSecret(required(
          environment,
          "APP_NAUTILO_DB_PASSWORD",
          "missing-app-nautilo-db-password",
        )),
        nautiloAgent: createHostedDatabaseSecret(required(
          environment,
          "APP_NAUTILO_AGENT_DB_PASSWORD",
          "missing-app-nautilo-agent-db-password",
        )),
        nautiloCrypto: createHostedDatabaseSecret(required(
          environment,
          "APP_NAUTILO_CRYPTO_DB_PASSWORD",
          "missing-app-nautilo-crypto-db-password",
        )),
      },
    },
    logto: {
      adminConnectionUrl: logtoAdminUrl,
      credentials: {
        logto: createHostedDatabaseSecret(required(
          environment,
          "LOGTO_DB_PASSWORD",
          "missing-logto-db-password",
        )),
      },
    },
  };
}
