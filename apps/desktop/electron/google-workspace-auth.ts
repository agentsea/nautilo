/**
 * M196 — Electron wiring for Google Workspace OAuth (default deps only).
 *
 * Implementation lives in `google-workspace-oauth.ts` (Electron-free, unit-testable).
 */
import { app, shell } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  ensureGogKeyringPasswordEnv,
  GOG_KEYRING_PASSWORD_FILENAME,
  GOOGLE_OAUTH_CLIENT_FILENAME,
  googleWorkspaceAuthStatus as googleWorkspaceAuthStatusImpl,
  googleWorkspaceConnect as googleWorkspaceConnectImpl,
  googleWorkspaceDisconnect as googleWorkspaceDisconnectImpl,
  type GoogleWorkspaceAuthStatus,
  type GoogleWorkspaceAuthStatusArgs,
  type GoogleWorkspaceConnectArgs,
  type GoogleWorkspaceDisconnectArgs,
  type GoogleWorkspaceAuthDeps,
} from "./google-workspace-oauth";
import { runNautiloGogAuthorization } from "./google-workspace-oauth-loopback";

export type {
  GoogleWorkspaceAuthStatus,
  GoogleWorkspaceAuthStatusArgs,
  GoogleWorkspaceConnectArgs,
  GoogleWorkspaceDisconnectArgs,
  GoogleWorkspaceAuthDeps,
};

const execFileAsync = promisify(execFile);

function defaultGoogleOAuthClientPath(userDataPath?: string): string {
  return path.join(userDataPath ?? app.getPath("userData"), GOOGLE_OAUTH_CLIENT_FILENAME);
}

export type GoogleWorkspaceAuthPorts = Pick<
  GoogleWorkspaceAuthDeps,
  "resolveGogBin" | "isGogAuthHealthy"
>;

function createDefaultGoogleWorkspaceAuthDeps(
  ports: GoogleWorkspaceAuthPorts,
): GoogleWorkspaceAuthDeps {
  // Ensure the encrypted file-keyring password is exported before any gog call
  // (auth status/connect/disconnect all spawn gog and inherit process.env).
  ensureGogKeyringPasswordEnv(
    path.join(app.getPath("userData"), GOG_KEYRING_PASSWORD_FILENAME),
    {
      existsSync: fs.existsSync,
      readFileSync: (p) => fs.readFileSync(p, "utf8"),
      writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
      randomPassword: () => randomBytes(32).toString("hex"),
    },
  );
  return {
    fetchImpl: globalThis.fetch,
    writeFile: (filePath, data, opts) => fsp.writeFile(filePath, data, opts),
    execFileAsync,
    existsSync: fs.existsSync,
    resolveGogBin: ports.resolveGogBin,
    isGogAuthHealthy: ports.isGogAuthHealthy,
    authorizeGogAccount: (args) =>
      runNautiloGogAuthorization(args, {
        execFileAsync,
        openExternal: (url) => shell.openExternal(url).then(() => undefined),
      }),
    oauthClientPath: defaultGoogleOAuthClientPath(),
  };
}

/** Fixed Electron auth wiring over the relay-owned gog resolver and cache. */
export function createGoogleWorkspaceAuth(ports: GoogleWorkspaceAuthPorts) {
  return Object.freeze({
    googleWorkspaceAuthStatus: async (
      args: GoogleWorkspaceAuthStatusArgs,
      deps: GoogleWorkspaceAuthDeps = createDefaultGoogleWorkspaceAuthDeps(ports),
    ): Promise<GoogleWorkspaceAuthStatus> =>
      googleWorkspaceAuthStatusImpl(args, deps),
    googleWorkspaceConnect: async (
      args: GoogleWorkspaceConnectArgs,
      deps: GoogleWorkspaceAuthDeps = createDefaultGoogleWorkspaceAuthDeps(ports),
    ): Promise<{ ok: true } | { ok: false; reason: string }> =>
      googleWorkspaceConnectImpl(args, deps),
    googleWorkspaceDisconnect: async (
      args: GoogleWorkspaceDisconnectArgs,
      deps: GoogleWorkspaceAuthDeps = createDefaultGoogleWorkspaceAuthDeps(ports),
    ): Promise<{ ok: true } | { ok: false; reason: string }> =>
      googleWorkspaceDisconnectImpl(args, deps),
  });
}
