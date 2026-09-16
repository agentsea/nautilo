import type { VerifiedReleaseManifest } from "@nautilo/hosting";

import {
  buildRailwayTopology,
  RAILWAY_LOGTO_PORT,
  RAILWAY_NAUTILO_PORT,
  type RailwayFinalServiceName,
} from "./topology";

export const RAILWAY_HELD_TEMPLATE_SCHEMA_VERSION = 1 as const;

export const RAILWAY_HELD_TEMPLATE_SECRET_FUNCTION = "${{ secret(48) }}" as const;

export const RAILWAY_LOGTO_SEED_HOLD_COMMAND =
  "node -e \"setInterval(() => {}, 2147483647)\"" as const;

export const RAILWAY_LOGTO_HOLD_COMMAND =
  "node -e \"const http=require('http');http.createServer((_q,r)=>{r.writeHead(503,{'content-type':'text/plain; charset=utf-8'});r.end('Nautilo setup is waiting for the administrator CLI.');}).listen(4301,'::');setInterval(()=>{},2147483647)\"" as const;

export const RAILWAY_NAUTILO_HOLD_COMMAND =
  "bun -e \"Bun.serve({hostname:'::',port:3001,fetch(){return new Response('Finish setting up Nautilo with the administrator CLI.',{status:200,headers:{'content-type':'text/plain; charset=utf-8'}})}});await new Promise(()=>{})\"" as const;

/** The template uses its existing Logto/Node image only to serve the held landing page. */
export const RAILWAY_NAUTILO_SETUP_HOLD_COMMAND =
  "node -e \"require('http').createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/plain; charset=utf-8'});r.end('Finish setting up Nautilo with the administrator CLI.');}).listen(3001,'::')\"" as const;

export type RailwayHeldTemplateServiceMode =
  | "database-normal"
  | "held-idle"
  | "held-listener"
  | "held-landing";

export interface RailwayHeldTemplateVariable {
  readonly key: string;
  readonly value: string;
  readonly custody: "safe-literal" | "template-generated-secret";
}

export interface RailwayHeldTemplateService {
  readonly name: RailwayFinalServiceName;
  readonly image: string;
  readonly mode: RailwayHeldTemplateServiceMode;
  readonly startCommand: string | null;
  readonly healthcheckPath: "/health" | null;
  readonly variables: readonly RailwayHeldTemplateVariable[];
}

export interface RailwayHeldTemplateScaffold {
  readonly schemaVersion: typeof RAILWAY_HELD_TEMPLATE_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly services: readonly RailwayHeldTemplateService[];
  readonly volumes: readonly {
    readonly logicalName: string;
    readonly service: "app-postgres" | "logto-postgres" | "nautilo-server";
    readonly mountPath: "/var/lib/postgresql/data" | "/var/lib/nautilo";
  }[];
  readonly domains: readonly {
    readonly logicalName: "logto-public" | "nautilo-public";
    readonly service: "logto" | "nautilo-server";
    readonly targetPort: 4301 | 3001;
  }[];
  readonly prohibitedOrdinaryStarts: readonly ["logto-seed", "logto", "nautilo-server"];
}

export type RailwayHeldTemplateCompilation =
  | Readonly<{ readonly ok: true; readonly scaffold: RailwayHeldTemplateScaffold }>
  | Readonly<{ readonly ok: false; readonly code: "railway.template-held-scaffold.invalid-release" }>;

const IMAGE = /@sha256:[a-f0-9]{64}$/;

const secret = (key: string): RailwayHeldTemplateVariable => ({
  key,
  value: RAILWAY_HELD_TEMPLATE_SECRET_FUNCTION,
  custody: "template-generated-secret",
});

const literal = (key: string, value: string): RailwayHeldTemplateVariable => ({
  key,
  value,
  custody: "safe-literal",
});

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Compile the exact private-template composer intent from an already verified
 * release. Railway starts template sources immediately, so only PostgreSQL may
 * use its ordinary image command. The other three services are deliberately
 * held until the receipt-backed adopter replaces their commands and variables.
 */
export function compileRailwayHeldTemplateScaffold(
  manifest: VerifiedReleaseManifest,
): RailwayHeldTemplateCompilation {
  const built = buildRailwayTopology(manifest);
  if (!built.ok || built.topology.qualifications.length !== 0) {
    return deepFreeze({ ok: false as const, code: "railway.template-held-scaffold.invalid-release" as const });
  }
  const topology = built.topology;
  const expectedNames: readonly RailwayFinalServiceName[] = [
    "app-postgres",
    "logto-postgres",
    "logto-seed",
    "logto",
    "nautilo-server",
  ];
  const byName = new Map(topology.finalServices.map((service) => [service.name, service]));
  if (topology.finalServices.length !== expectedNames.length
    || expectedNames.some((name) => !byName.has(name))
    || topology.finalServices.some((service) => !IMAGE.test(service.image))
    || topology.mounts.length !== 3
    || topology.generatedPublicDomains.length !== 2) {
    return deepFreeze({ ok: false as const, code: "railway.template-held-scaffold.invalid-release" as const });
  }

  const appPostgres = byName.get("app-postgres")!;
  const logtoPostgres = byName.get("logto-postgres")!;
  const logtoSeed = byName.get("logto-seed")!;
  const logto = byName.get("logto")!;
  if (logtoSeed.image !== logto.image
    || !topology.mounts.some((mount) => mount.logicalName === "app-postgres-data" && mount.service === "app-postgres" && mount.mountPath === "/var/lib/postgresql/data")
    || !topology.mounts.some((mount) => mount.logicalName === "logto-postgres-data" && mount.service === "logto-postgres" && mount.mountPath === "/var/lib/postgresql/data")
    || !topology.mounts.some((mount) => mount.logicalName === "nautilo-data" && mount.service === "nautilo-server" && mount.mountPath === "/var/lib/nautilo")
    || !topology.generatedPublicDomains.some((domain) => domain.logicalName === "logto-public" && domain.service === "logto" && domain.targetPort === RAILWAY_LOGTO_PORT)
    || !topology.generatedPublicDomains.some((domain) => domain.logicalName === "nautilo-public" && domain.service === "nautilo-server" && domain.targetPort === RAILWAY_NAUTILO_PORT)) {
    return deepFreeze({ ok: false as const, code: "railway.template-held-scaffold.invalid-release" as const });
  }

  return deepFreeze({
    ok: true,
    scaffold: {
      schemaVersion: RAILWAY_HELD_TEMPLATE_SCHEMA_VERSION,
      releaseId: topology.releaseId,
      services: [
        {
          name: "app-postgres",
          image: appPostgres.image,
          mode: "database-normal",
          startCommand: null,
          healthcheckPath: null,
          variables: [
            literal("PGDATA", "/var/lib/postgresql/data/pgdata"),
            literal("POSTGRES_USER", "postgres"),
            secret("POSTGRES_PASSWORD"),
            secret("NAUTILO_TEMPLATE_APP_DB_PASSWORD"),
            secret("NAUTILO_TEMPLATE_AGENT_DB_PASSWORD"),
            secret("NAUTILO_TEMPLATE_CRYPTO_DB_PASSWORD"),
          ],
        },
        {
          name: "logto-postgres",
          image: logtoPostgres.image,
          mode: "database-normal",
          startCommand: null,
          healthcheckPath: null,
          variables: [
            literal("PGDATA", "/var/lib/postgresql/data/pgdata"),
            literal("POSTGRES_USER", "postgres"),
            secret("POSTGRES_PASSWORD"),
            secret("NAUTILO_TEMPLATE_LOGTO_DB_PASSWORD"),
          ],
        },
        {
          name: "logto-seed",
          image: logtoSeed.image,
          mode: "held-idle",
          startCommand: RAILWAY_LOGTO_SEED_HOLD_COMMAND,
          healthcheckPath: null,
          variables: [],
        },
        {
          name: "logto",
          image: logto.image,
          mode: "held-listener",
          startCommand: RAILWAY_LOGTO_HOLD_COMMAND,
          healthcheckPath: null,
          variables: [secret("NAUTILO_TEMPLATE_LOGTO_HANDOFF_TOKEN")],
        },
        {
          name: "nautilo-server",
          // A published template must not retain a retired Nautilo runtime.
          // Adoption attaches the currently verified stable runtime before start.
          image: logto.image,
          mode: "held-landing",
          startCommand: RAILWAY_NAUTILO_SETUP_HOLD_COMMAND,
          healthcheckPath: "/health",
          variables: [
            literal("PORT", `${RAILWAY_NAUTILO_PORT}`),
            secret("NAUTILO_BOOTSTRAP_TOKEN"),
            secret("NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET"),
          ],
        },
      ],
      volumes: topology.mounts.map((mount) => ({ ...mount })),
      domains: topology.generatedPublicDomains.map((domain) => ({ ...domain })),
      prohibitedOrdinaryStarts: ["logto-seed", "logto", "nautilo-server"],
    },
  });
}
