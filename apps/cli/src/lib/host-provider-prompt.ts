import { createInterface } from "node:readline";
import { stdin, stderr } from "node:process";

import { KEY_REGISTRY, type KeyDefinition } from "@nautilo/config-guard";

import {
  RAILWAY_RUNTIME_PROVIDERS,
  type RailwayRuntimeProvider,
} from "./host-provider-config";

const providerSet = new Set<string>(RAILWAY_RUNTIME_PROVIDERS);
const providerDefinitions = new Map<RailwayRuntimeProvider, KeyDefinition>(
  KEY_REGISTRY.flatMap((definition) => providerSet.has(definition.id)
    ? [[definition.id as RailwayRuntimeProvider, definition] as const]
    : []),
);

export interface HostProviderPromptIo {
  readonly write: (value: string) => void;
  readonly readLine: (prompt: string) => Promise<string>;
  /** Must not echo characters or retain a transcript of the returned value. */
  readonly readSecret: (prompt: string) => Promise<string>;
}

export type HostProviderPromptResult =
  | { readonly kind: "detected" }
  | { readonly kind: "toml"; readonly providerConfigPath: string }
  | { readonly kind: "manual"; readonly providers: ReadonlyMap<RailwayRuntimeProvider, string> }
  | { readonly kind: "skip" };

export interface HostProviderPrompter {
  choose(input: {
    readonly detectedProviders: readonly RailwayRuntimeProvider[];
  }): Promise<HostProviderPromptResult>;
  repair(input: {
    readonly providers: readonly RailwayRuntimeProvider[];
  }): Promise<ReadonlyMap<RailwayRuntimeProvider, string> | undefined>;
}

function cancelled(): Error {
  return new Error("Provider input was cancelled");
}

function canonicalProviders(values: string): readonly RailwayRuntimeProvider[] | undefined {
  const requested = values.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  if (requested.length === 0) return [];
  const unique = new Set<RailwayRuntimeProvider>();
  for (const provider of requested) {
    if (!providerSet.has(provider)) return undefined;
    unique.add(provider as RailwayRuntimeProvider);
  }
  return RAILWAY_RUNTIME_PROVIDERS.filter((provider) => unique.has(provider));
}

async function collectSecrets(
  providers: readonly RailwayRuntimeProvider[],
  io: HostProviderPromptIo,
): Promise<ReadonlyMap<RailwayRuntimeProvider, string>> {
  const values = new Map<RailwayRuntimeProvider, string>();
  for (const provider of providers) {
    const definition = providerDefinitions.get(provider);
    if (definition === undefined) throw new Error("Unsupported Railway provider");
    while (true) {
      const value = await io.readSecret(`${definition.name} API key (input hidden): `);
      if (value.length === 0) throw cancelled();
      if (value.trim() === value && definition.formatCheck(value)) {
        values.set(provider, value);
        break;
      }
      // The value itself is deliberately not included in this repair message.
      io.write(`That ${definition.name} key is not in the expected format (${definition.formatHint}). Try again or submit an empty line to cancel.\n`);
    }
  }
  return values;
}

/**
 * Small, hosting-specific prompt flow. It returns values only in memory; the
 * command layer decides whether they can enter the per-launch keychain custody.
 */
export function createHostProviderPrompter(io: HostProviderPromptIo): HostProviderPrompter {
  return {
    async choose(input) {
      const detected = input.detectedProviders.length === 0
        ? "none"
        : input.detectedProviders.join(", ");
      io.write([
        "Provider setup (credentials are never written to files, history, or command output).",
        `Detected supported credentials: ${detected}.`,
        "Choose: [D] use detected  [F] provider TOML file  [M] enter keys now  [S] skip",
      ].join("\n") + "\n");
      const choice = (await io.readLine("Provider source [D/F/M/S]: ")).trim().toLowerCase() || "d";
      if (choice === "d" || choice === "detected") return { kind: "detected" };
      if (choice === "s" || choice === "skip") return { kind: "skip" };
      if (choice === "f" || choice === "file" || choice === "toml") {
        // Config paths are also private controller input: do not put them in
        // terminal scrollback while preserving the existing no-path receipt
        // and output contract.
        const providerConfigPath = (await io.readSecret("Provider TOML path (input hidden): ")).trim();
        if (providerConfigPath.length === 0) throw cancelled();
        return { kind: "toml", providerConfigPath };
      }
      if (choice !== "m" && choice !== "manual") {
        io.write("Choose D, F, M, or S.\n");
        return this.choose(input);
      }
      const selected = canonicalProviders(await io.readLine(
        `Providers to enter (comma-separated: ${RAILWAY_RUNTIME_PROVIDERS.join(", ")}): `,
      ));
      if (selected === undefined) {
        io.write("Use only the listed provider slugs.\n");
        return this.choose(input);
      }
      if (selected.length === 0) return { kind: "skip" };
      return { kind: "manual", providers: await collectSecrets(selected, io) };
    },
    async repair(input) {
      io.write("This interrupted launch needs its original selected provider credentials before it can resume.\n");
      const proceed = (await io.readLine("Enter those keys now? [y/N]: ")).trim().toLowerCase();
      if (proceed !== "y" && proceed !== "yes") return undefined;
      return collectSecrets(input.providers, io);
    },
  };
}

function readVisibleLine(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = createInterface({ input: stdin, output: stderr, terminal: true });
    reader.question(prompt, (answer) => {
      reader.close();
      resolvePromise(answer);
    });
    reader.once("error", reject);
  });
}

/** Read a single terminal line without terminal echo or shell-history involvement. */
export function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new Error("A terminal is required for hidden provider input"));
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Restoring terminal mode is best effort after an input failure.
      }
      // `resume()` above puts the process stream into flowing mode. Return it
      // to a quiescent state so a completed hidden prompt cannot keep the CLI
      // alive; a later readline prompt will resume it when needed.
      stdin.pause();
      stderr.write("\n");
      if (error !== undefined) reject(error);
      else resolvePromise(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of bytes) {
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x03 || byte === 0x04) return finish(cancelled());
        if (byte === 0x08 || byte === 0x7f) {
          const current = Buffer.concat(chunks);
          chunks.length = 0;
          if (current.length > 0) chunks.push(current.subarray(0, -1));
          continue;
        }
        chunks.push(Buffer.from([byte]));
      }
    };
    stderr.write(prompt);
    try {
      stdin.setRawMode(true);
      stdin.on("data", onData);
      stdin.resume();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Hidden provider input failed"));
    }
  });
}

/** Production adapter; prompts intentionally use stderr to preserve JSON stdout. */
export function createProcessHostProviderPrompter(): HostProviderPrompter {
  return createHostProviderPrompter({
    write: (value) => stderr.write(value),
    readLine: readVisibleLine,
    readSecret: readHiddenLine,
  });
}
