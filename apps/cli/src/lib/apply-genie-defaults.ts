import { randomUUID } from "node:crypto";
import type { AgentPhotoSelectionTargetDto } from "@nautilo/types";
import type { GenieAvatarValue, GenieBlock, NautiloApiClient } from "@nautilo/api-client";
import { ApiError, setupStatusResponseSchema } from "@nautilo/api-client";
import {
  mapGenieToProfileInput,
  resolveGenieDefaultVoice,
  type GenieResolvedIdentity,
} from "./genie-mapping.ts";
import { randomizeGenie, type ResolvedProviderEntry } from "./genie-randomize.ts";
import type { ResolvedSetupTemplate } from "../setup-template/loader.ts";
import { transportFetch, type ResolvedServer } from "./profile-aware-server.ts";

export type GenieSetupArgv = {
  randomizeGenie?: boolean | undefined;
  seed?: number | undefined;
  forceGenie?: boolean | undefined;
};

function effectiveGenieBlock(
  template: ResolvedSetupTemplate,
  argv: GenieSetupArgv,
): GenieBlock | undefined {
  if (argv.randomizeGenie) {
    return {
      ...(template.genie ?? {}),
      mode: "randomize",
    } as GenieBlock;
  }
  return template.genie;
}

function blockToIdentity(block: GenieBlock): GenieResolvedIdentity {
  if (block.mode !== "explicit") {
    throw new Error("internal: expected explicit genie block");
  }
  return {
    name: block.name,
    voice: block.voice,
    defaultModel: block.defaultModel,
    personality: block.personality,
    avatar: block.avatar,
  };
}

async function getSetupStatusWithBearer(
  transport: ResolvedServer,
  bearer: string,
): Promise<ReturnType<typeof setupStatusResponseSchema.parse>> {
  const res = await transportFetch(transport, "/api/setup/status", {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = json as { error?: string };
    throw new ApiError(
      res.status,
      body.error ?? `GET /api/setup/status failed: ${res.status}`,
    );
  }
  return setupStatusResponseSchema.parse(json);
}

async function putVoiceDefaultWithBearer(
  transport: ResolvedServer,
  bearer: string,
  ref: { voiceId: string; voiceName: string },
): Promise<void> {
  const res = await transportFetch(transport, "/api/profile/voices/default", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(ref),
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PUT /api/profile/voices/default failed: ${res.status}`,
    );
  }
}

async function putProfileWithBearer(
  transport: ResolvedServer,
  bearer: string,
  data: Record<string, unknown>,
): Promise<void> {
  // D120 A1.6 — canonical owner gate + cache-backed policy resolver
  // accept the post-claim redeem bearer for PUT /api/profile (D119 §1
  // retired the loopback-only POST setup genie bridge).
  const res = await transportFetch(transport, "/api/profile", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `PUT /api/profile failed: ${res.status}`);
  }
}

async function resolveAvatarTarget(
  api: NautiloApiClient,
  prompt: string,
): Promise<AgentPhotoSelectionTargetDto> {
  const created = await api.generateAgentPhotoLibraryEntries(
    { prompt, count: 1 },
    { idempotencyKey: randomUUID(), origin: "cli_setup" },
  );
  const entryId = created.entryIds[0];
  if (!entryId) throw new ApiError(502, "Agent photo generation returned no owned entry");
  return { kind: "entry", entryId };
}

async function resolveAvatarForBearer(
  api: NautiloApiClient,
  avatar: GenieAvatarValue | undefined,
): Promise<AgentPhotoSelectionTargetDto | null> {
  if (!avatar || avatar.kind === "skip") return null;
  if (avatar.kind === "preset") {
    return { kind: "preset", presetId: avatar.presetId };
  }
  return resolveAvatarTarget(api, avatar.generatePrompt);
}

/**
 * Apply Genie defaults during `nautilo setup` (§14.1). Uses an explicit bearer
 * from claim redeem so `PUT /api/profile` is not sent without `Authorization`.
 */
export async function applyGenieDefaults(args: {
  transport: ResolvedServer;
  api: NautiloApiClient;
  template: ResolvedSetupTemplate;
  argv: GenieSetupArgv;
  /** Redeem handoff bearer; when null, falls back to `api.getToken()` if set. */
  redeemBearer: string | null;
}): Promise<void> {
  const block = effectiveGenieBlock(args.template, args.argv);
  if (!block || block.mode === "skip") return;

  const bearer = args.redeemBearer ?? args.api.getToken();
  if (!bearer) {
    const status = await args.api.getSetupStatus();
    if (status.viewer?.genieCustomized && !args.argv.forceGenie) {
      process.stderr.write(
        "Genie already customized; pass --force-genie to overwrite.\n",
      );
      return;
    }
    process.stderr.write(
      "[setup] genie defaults skipped (no bearer; sign in and use /genie or run setup against a fresh-unclaimed instance)\n",
    );
    return;
  }

  const status = await getSetupStatusWithBearer(args.transport, bearer);
  if (status.viewer?.genieCustomized && !args.argv.forceGenie) {
    process.stderr.write(
      "Genie already customized; pass --force-genie to overwrite.\n",
    );
    return;
  }

  let resolved: GenieResolvedIdentity;
  if (block.mode === "randomize") {
    const providers = args.template.providers as ResolvedProviderEntry[];
    const seed =
      args.argv.seed ??
      (block.seed !== undefined ? block.seed : undefined);
    resolved = randomizeGenie(block, providers, seed);
  } else {
    resolved = blockToIdentity(block);
  }

  args.api.setToken(bearer);
  const avatarTarget = await resolveAvatarForBearer(args.api, resolved.avatar);
  const payload = mapGenieToProfileInput(resolved);
  const defaultVoice = resolveGenieDefaultVoice(resolved);
  try {
    await putProfileWithBearer(args.transport, bearer, payload);
    if (avatarTarget) {
      const current = await args.api.getAgentPhotoLibraryCurrent();
      await args.api.selectAgentPhotoLibraryEntry(
        {
          target: avatarTarget,
          expectedSelectionRevision: current.scope.selectionRevision,
        },
        { idempotencyKey: randomUUID(), origin: "cli_setup" },
      );
    }
    if (defaultVoice) {
      await putVoiceDefaultWithBearer(args.transport, bearer, defaultVoice);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      process.stderr.write(
        "[setup] genie defaults skipped (redeem bearer rejected by /api/profile; sign in to Workbench and run /genie to apply Genie defaults)\n",
      );
      return;
    }
    throw e;
  }
}
