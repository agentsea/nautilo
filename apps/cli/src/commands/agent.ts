/**
 * D425 Wave 1A — `nautilo agent export|import`: user-runnable portable Genie
 * profile migration.
 *
 * Export pulls the caller's OWN ID-free semantic profile + raw custom avatar
 * bytes from the source server, generates a fresh DEK + Argon2id recovery
 * slot (real `argon2`), encrypts the framed container locally, and writes a
 * 0600 file atomically. Import reads/decrypts locally, validates the terminal
 * manifest BEFORE any server call, submits a read-only dry-run plan, requires
 * an explicit whole-profile `--on-conflict=source|target` when the target
 * conflicts, stages raw avatar bytes only when the avatar scope is selected,
 * and commits with a secure random idempotency key.
 *
 * Source/target server selection is explicit via the global `--profile` flag
 * (resolved by `requireSessionForActiveProfile` + `resolveServerForCommand`).
 * No passphrase is ever accepted by flag/env/log/output — only an interactive
 * TTY prompt (overridable via a test seam). No auth/account/IDs are
 * transferred; the bundle is ID-free by contract.
 */
import type { CommandModule } from "yargs";
import { randomUUID, createHash } from "node:crypto";
import { NautiloApiClient } from "@nautilo/api-client";
import type { semantic } from "@nautilo/profile-portability";
import {
  CliSessionExpiredError,
  CliSessionMissingError,
  requireSessionForActiveProfile,
} from "../lib/cli-session.ts";
import {
  apiClientOptionsFor,
  resolveServerForCommand,
  type ResolvedServer,
} from "../lib/profile-aware-server.ts";
import {
  ProfileBundleFileError,
  WrongPassphraseError,
  createArgon2idDeriveFn,
  decryptProfileBundleFile,
  deriveDefaultExportFilename,
  encryptProfileBundleFile,
  readProfileBundleFile,
  writeProfileBundleFileAtomically,
  serializeArtifactStream,
  deserializeArtifactStream,
  asyncReaderFromWebStream,
  createFileArtifactStreamIo,
  deriveArtifactSidecarPath,
  headerFromJson,
  generateDek,
  type Argon2idDeriveFn,
  type AvatarMedia,
  type ProfileBundleFile,
  type ArtifactStreamIo,
  type ArtifactStreamSource,
  type AsyncByteReader,
  StreamingArtifactStageSink,
} from "../lib/profile-bundle.ts";

// ---------------------------------------------------------------------------
// Passphrase prompt — TTY only, never flag/env/log/output. Test-overridable.
// ---------------------------------------------------------------------------

let passphraseReader: ((prompt: string) => Promise<string>) | null = null;

/** Tests inject a deterministic passphrase source; production uses the TTY. */
export function setPassphraseReader(fn: ((prompt: string) => Promise<string>) | null): void {
  passphraseReader = fn;
}

async function readPassphraseTty(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error("passphrase prompt requires an interactive TTY"));
      return;
    }

    const rawMode = input.isRaw;
    let value = "";
    let settled = false;

    const restore = (): void => {
      input.off("data", onData);
      input.off("error", onError);
      process.off("SIGINT", onSigint);
      if (input.isRaw !== rawMode) input.setRawMode(rawMode);
      // The prompt resumes stdin to receive raw keystrokes. Leaving it
      // flowing after the final prompt keeps the Bun event loop alive, so a
      // completed export/import appears hung until the user sends Ctrl+C.
      // A CLI command has no later stdin consumer; always pause it on exit.
      input.pause();
    };
    const finish = (result: { readonly value: string } | { readonly error: Error }): void => {
      if (settled) return;
      settled = true;
      restore();
      process.stdout.write("\n");
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onError = (error: Error): void => finish({ error });
    const onSigint = (): void => finish({ error: new Error("passphrase prompt interrupted") });
    const onData = (chunk: string | Buffer): void => {
      const chars = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of chars) {
        if (char === "\u0003") {
          onSigint();
          return;
        }
        if (char === "\r" || char === "\n") {
          // A shell may deliver the Enter that launched this command after
          // raw mode is enabled. An empty password is invalid anyway, so
          // discard that buffered newline and wait for actual input rather
          // than failing the import before the user can type.
          if (value.length === 0) {
            continue;
          }
          finish({ value });
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    process.stdout.write(`${prompt}(input hidden; press Enter): `);
    input.setRawMode(true);
    input.on("data", onData);
    input.once("error", onError);
    process.once("SIGINT", onSigint);
    input.resume();
  });
}

async function readPassphrase(prompt: string): Promise<string> {
  const fn = passphraseReader ?? readPassphraseTty;
  return fn(prompt);
}

// ---------------------------------------------------------------------------
// Argon2id — load the real runtime lazily so tests never touch the binding.
// ---------------------------------------------------------------------------

let argon2idDeriveFn: Argon2idDeriveFn | null = null;

async function getArgon2idDeriveFn(): Promise<Argon2idDeriveFn> {
  if (argon2idDeriveFn) return argon2idDeriveFn;
  const mod = (await import("argon2")).default;
  argon2idDeriveFn = createArgon2idDeriveFn(mod as unknown as Parameters<typeof createArgon2idDeriveFn>[0]);
  return argon2idDeriveFn;
}

/** Tests inject a stand-in KDF; production leaves it null to load `argon2`. */
export function setArgon2idDeriveFn(fn: Argon2idDeriveFn | null): void {
  argon2idDeriveFn = fn;
}

// ---------------------------------------------------------------------------
// Filesystem IO seams — production writes/reads real 0600 files; tests inject
// in-memory implementations so the round-trip needs no real disk.
// ---------------------------------------------------------------------------

let bundleWriter: (path: string, file: ProfileBundleFile) => Promise<void> = (p, f) =>
  writeProfileBundleFileAtomically(p, f);
let bundleReader: (path: string) => Promise<ProfileBundleFile> = (p) => readProfileBundleFile(p);

export function setBundleIo(seams: {
  write?: ((path: string, file: ProfileBundleFile) => Promise<void>) | null;
  read?: ((path: string) => Promise<ProfileBundleFile>) | null;
} | null): void {
  if (seams?.write) bundleWriter = seams.write;
  if (seams?.read) bundleReader = seams.read;
  if (seams === null) {
    bundleWriter = (p, f) => writeProfileBundleFileAtomically(p, f);
    bundleReader = (p) => readProfileBundleFile(p);
  }
}

// ---------------------------------------------------------------------------
// D425 Wave 3 — artifact sidecar IO seam. Production writes/reads a real
// `.artifacts` sidecar file (streamed); tests inject an in-memory store so
// the round-trip needs no real disk.
// ---------------------------------------------------------------------------

let artifactStreamIo: ArtifactStreamIo = createFileArtifactStreamIo();

/** Tests inject an in-memory `ArtifactStreamIo`; production leaves it as the
 *  file-backed implementation. Pass `null` to restore the default. */
export function setArtifactStreamIo(seams: ArtifactStreamIo | null): void {
  artifactStreamIo = seams ?? createFileArtifactStreamIo();
}

function fail(msg: string): void {
  process.stderr.write(`${msg}\n`);
  process.exitCode = 2;
}

function isWholeProfileChoice(v: unknown): v is "source" | "target" {
  return v === "source" || v === "target";
}

/**
 * D425 Wave 1B — a portable private-memory record is `recordKind: "memory"`
 * with `scope: "private"`. The CLI only ever counts / strips these; it never
 * inspects `content` / `createdAt`, so no memory text is read into CLI state
 * or output. Defense-in-depth double-check mirrors the server's
 * `privateMemoryRecordsFromBundle`.
 */
function isPrivateMemoryRecord(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const rec = r as { recordKind?: unknown; scope?: unknown };
  return rec.recordKind === "memory" && rec.scope === "private";
}

function countPrivateMemories(records: readonly unknown[]): number {
  let n = 0;
  for (const r of records) if (isPrivateMemoryRecord(r)) n += 1;
  return n;
}

function pluralMemory(n: number): string {
  return n === 1 ? "private memory" : "private memories";
}

/** Fetch the target server's live instance id via whoami (fresh, authenticated). */
async function fetchDestinationInstanceId(api: NautiloApiClient): Promise<string> {
  const w = await api.whoami();
  if (!w.instanceId || w.instanceId.length === 0) {
    throw new Error("target server returned no instance id; run `nautilo login --profile <new-server>` first");
  }
  return w.instanceId;
}

function buildApiClient(transport: ResolvedServer, accessToken: string): NautiloApiClient {
  const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
  api.setToken(accessToken);
  return api;
}

// ---------------------------------------------------------------------------
// D425 Wave 3 — private-artifact preview / selection / streaming helpers.
//
// The CLI drives the server's OPAQUE selection semantics only: it never
// invents artifact IDs, never uses a path as identity, and never echoes source
// DB IDs / storage URIs. The preview mints a server-bound `selectionPlanToken`
// + per-item opaque `selectionToken`s; the source stream is opened by
// `(selectionPlanToken, selectionToken)`; the bundle's `bytesEntry` is
// `media/artifacts/<selectionToken>.bin` (the opaque id IS the selection
// token — never a path, never a source id).
// ---------------------------------------------------------------------------

/** One eligible artifact collected from the preview, with its page-bound
 *  selection plan token (the snapshot that minted this selection token). */
interface ArtifactInventoryEntry {
  readonly selectionPlanToken: string;
  readonly selectionToken: string;
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
}

type ArtifactPreviewResponse = Awaited<
  ReturnType<NautiloApiClient["previewProfileBundleArtifacts"]>
>;

/** Paginate the source preview until `hasMore` is false and collect the
 *  COMPLETE eligible inventory (opaque tokens + path/mimeType/size). The
 *  server binds the full snapshot per page; each item carries its page's
 *  `selectionPlanToken` so the source stream can be opened later. Large items
 *  are never silently omitted — `totalCount`/`totalBytes` are the full
 *  snapshot totals reported by the server. */
async function collectArtifactInventory(
  api: NautiloApiClient,
  out: (s: string) => void,
  selectionPlanToken?: string,
): Promise<{
  readonly selectionPlanToken: string;
  readonly entries: readonly ArtifactInventoryEntry[];
  readonly totalCount: number;
  readonly totalBytes: number;
}> {
  const entries: ArtifactInventoryEntry[] = [];
  const PAGE = 100;
  let offset = 0;
  let totalCount = 0;
  let totalBytes = 0;
  let hasMore = true;
  let boundPlanToken = selectionPlanToken;
  while (hasMore) {
    const page: ArtifactPreviewResponse = await api.previewProfileBundleArtifacts({
      limit: PAGE,
      offset,
      ...(boundPlanToken === undefined ? {} : { selectionPlanToken: boundPlanToken }),
    });
    if (boundPlanToken !== undefined && page.selectionPlanToken !== boundPlanToken) {
      throw new Error("artifact preview returned an unexpected selection plan");
    }
    boundPlanToken = page.selectionPlanToken;
    totalCount = page.totalCount;
    totalBytes = page.totalBytes;
    out(
      `  page @offset=${page.offset}: ${page.items.length} item(s)` +
        (page.hasMore ? " (more)" : "") +
        "\n",
    );
    for (const item of page.items) {
      out(
        `    token=${item.selectionToken} path=${item.path}` +
          ` type=${item.mimeType} size=${item.size}\n`,
      );
      entries.push({
        selectionPlanToken: page.selectionPlanToken,
        selectionToken: item.selectionToken,
        path: item.path,
        mimeType: item.mimeType,
        size: item.size,
      });
    }
    hasMore = page.hasMore;
    offset += page.items.length;
    if (page.items.length === 0) break;
  }
  if (boundPlanToken === undefined) {
    throw new Error("artifact preview did not return a selection plan");
  }
  return { selectionPlanToken: boundPlanToken, entries, totalCount, totalBytes };
}

/** Resolve the user's selection against the inventory. `all` selects every
 *  item; a repeated-token `subset` selects by opaque token (never by path).
 *  Unknown tokens fail closed. Returns the selected entries (deduped,
 *  order-preserving). */
function resolveArtifactSelection(
  inventory: readonly ArtifactInventoryEntry[],
  opts: { readonly all: boolean; readonly tokens: readonly string[] },
): { readonly selected: readonly ArtifactInventoryEntry[] } {
  if (opts.all) {
    return { selected: inventory };
  }
  if (opts.tokens.length === 0) {
    return { selected: [] };
  }
  const byToken = new Map<string, ArtifactInventoryEntry>();
  for (const e of inventory) byToken.set(e.selectionToken, e);
  const selected: ArtifactInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const t of opts.tokens) {
    const entry = byToken.get(t);
    if (!entry) {
      throw new Error(
        `unknown artifact selection token: ${t} (use a token from the preview; paths are never identity)`,
      );
    }
    if (seen.has(t)) continue;
    seen.add(t);
    selected.push(entry);
  }
  return { selected };
}

/** Stream one artifact's source bytes through a sha256 hasher (pass 1) to
 *  compute the digest + confirm size, without buffering the whole artifact. */
async function hashArtifactSource(
  api: NautiloApiClient,
  entry: ArtifactInventoryEntry,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const res = await api.streamProfileBundleArtifactSource({
    selectionPlanToken: entry.selectionPlanToken,
    selectionToken: entry.selectionToken,
  });
  if (res.body === null || res.body === undefined) {
    throw new Error(`artifact source returned no body for token ${entry.selectionToken}`);
  }
  const reader = asyncReaderFromWebStream(res.body as ReadableStream<Uint8Array>);
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of reader) {
    hash.update(chunk);
    total += chunk.length;
  }
  if (total !== entry.size) {
    throw new Error(
      `artifact ${entry.selectionToken} size drift: preview ${entry.size} vs streamed ${total}`,
    );
  }
  return { sha256: hash.digest("hex"), size: total };
}

/** Open a fresh source stream for one artifact (pass 2) as an `AsyncByteReader`
 *  feeding `serializeArtifactStream`. */
async function openArtifactSourceReader(
  api: NautiloApiClient,
  entry: ArtifactInventoryEntry,
): Promise<AsyncByteReader> {
  const res = await api.streamProfileBundleArtifactSource({
    selectionPlanToken: entry.selectionPlanToken,
    selectionToken: entry.selectionToken,
  });
  if (res.body === null || res.body === undefined) {
    throw new Error(`artifact source returned no body for token ${entry.selectionToken}`);
  }
  return asyncReaderFromWebStream(res.body as ReadableStream<Uint8Array>);
}

function pluralArtifact(n: number): string {
  return n === 1 ? "private artifact" : "private artifacts";
}

function artifactBytesEntry(selectionToken: string): string {
  return `media/artifacts/${selectionToken}.bin`;
}

/**
 * The commit endpoint deliberately stays atomic: it re-embeds every private
 * memory before opening its write transaction. That can take a while, so keep
 * the interactive CLI visibly alive rather than leaving the user at the last
 * staging line with no indication of the remaining phase.
 */
function startCommitProgress(
  out: (s: string) => void,
  work: { readonly privateMemoryCount: number; readonly privateArtifactCount: number },
): () => void {
  if (work.privateMemoryCount === 0 && work.privateArtifactCount === 0) {
    return () => {};
  }
  const phases: string[] = [];
  if (work.privateMemoryCount > 0) {
    phases.push(`re-embedding ${work.privateMemoryCount} ${pluralMemory(work.privateMemoryCount)}`);
  }
  if (work.privateArtifactCount > 0) {
    phases.push(`finalizing ${work.privateArtifactCount} ${pluralArtifact(work.privateArtifactCount)}`);
  }
  const startedAt = Date.now();
  out(`Committing: ${phases.join("; ")}. This can take a few minutes.\n`);
  const timer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    out(`  Still committing (${elapsedSeconds}s elapsed)…\n`);
  }, 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Yargs `.check()` validator (also called directly by tests): a passphrase must
 * never be supplied by flag, and plaintext mode is never permitted. Export uses
 * the passphrase-only variant; import uses the full variant.
 */
export function rejectPassphraseFlag(argv: Record<string, unknown>): true {
  if (Object.prototype.hasOwnProperty.call(argv, "passphrase")) {
    throw new Error("Passphrases are never accepted by flag/env; use the interactive prompt.");
  }
  return true;
}

export function rejectPassphraseAndPlaintextFlags(argv: Record<string, unknown>): true {
  rejectPassphraseFlag(argv);
  if (argv["plaintext"] === true) {
    throw new Error("Plaintext mode is never permitted; bundles are always encrypted.");
  }
  return true;
}

// ---------------------------------------------------------------------------
// `nautilo agent export --profile <src> --out <file>`
// ---------------------------------------------------------------------------

export const agentExportModule: CommandModule = {
  command: "export",
  describe:
    "Export your personal Genie profile to a local encrypted .nautilo-profile bundle.",
  builder: (yargs) =>
    yargs
      .option("out", {
        type: "string",
        describe:
          "Output file path (defaults to a name-derived <handle>.nautilo-profile.json in the cwd)",
      })
      .option("without-memories", {
        type: "boolean",
        default: false,
        describe:
          "Do not export eligible private memories even when the source server advertises them.",
      })
      .option("with-artifacts", {
        type: "boolean",
        default: false,
        describe:
          "Opt in to private-artifact export. Without a selection, lists the COMPLETE eligible artifact inventory (opaque tokens, path/type/size, totals) and exits; pass --artifacts-all or --artifacts <token...> to export a selection.",
      })
      .option("artifacts-all", {
        type: "boolean",
        default: false,
        describe: "With --with-artifacts: export every eligible private artifact.",
      })
      .option("artifacts", {
        type: "array",
        string: true,
        describe:
          "With --with-artifacts: export a subset of eligible private artifacts by repeated opaque selection token (never by path).",
      })
      .option("artifact-plan", {
        type: "string",
        describe:
          "Required with --artifacts <token...>: the selection plan printed by a prior artifact preview.",
      })
      .option("passphrase", {
        type: "string",
        hidden: true,
        describe:
          "Rejected — passphrases are never accepted by flag. Use the interactive prompt.",
      })
      .check((argv) => rejectPassphraseFlag(argv as Record<string, unknown>)),
  handler: async (argv) => {
    process.exitCode = undefined;
    try {
      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = buildApiClient(transport, session.accessToken);

      const exported = await api.exportProfileBundle();
      const records = exported.records as readonly unknown[];

      // D425 Wave 1B — the source server advertises `privateMemories` in
      // `scopes` iff at least one eligible private memory exists, and appends
      // those `recordKind: "memory"` records to `records`. Default: keep them
      // (the bundle carries + re-encrypts them). `--without-memories` strips
      // them so the written bundle is byte-identical to a Wave 1A bundle.
      // The CLI never reads memory content; it only counts / strips by kind.
      const withoutMemories = argv["without-memories"] === true;
      const privateMemoryCount = countPrivateMemories(records);
      const includeMemories = !withoutMemories && privateMemoryCount > 0;
      const bundleRecordsRaw = includeMemories
        ? records
        : records.filter((r) => !isPrivateMemoryRecord(r));
      const reportedMemoryCount = includeMemories ? privateMemoryCount : 0;

      // D425 Wave 3 — private artifacts are OPT IN. Default export never
      // touches them (byte-identical to Wave 1B). `--with-artifacts` runs the
      // server's opaque selection preview; without a selection it lists the
      // COMPLETE inventory (opaque tokens, path/type/size, totals — large
      // items never omitted) and exits. `--artifacts-all` or a repeated-token
      // `--artifacts <token...>` subset streams the selected source bytes into
      // a v2 artifact chunk-media sidecar (no whole-artifact buffering). The
      // CLI never invents artifact IDs and never uses a path as identity — the
      // bundle's `bytesEntry` is `media/artifacts/<selectionToken>.bin`.
      const withArtifacts = argv["with-artifacts"] === true;
      let artifactRecords: readonly semantic.PortableArtifact[] = [];
      let artifactSelection: readonly ArtifactInventoryEntry[] = [];
      if (withArtifacts) {
        const artifactTokens = Array.isArray(argv["artifacts"])
          ? (argv["artifacts"] as readonly string[]).map((t) => String(t)).filter((t) => t.length > 0)
          : [];
        const artifactPlanToken =
          typeof argv["artifact-plan"] === "string" && argv["artifact-plan"].trim().length > 0
            ? argv["artifact-plan"].trim()
            : undefined;
        if (artifactTokens.length > 0 && artifactPlanToken === undefined) {
          throw new Error(
            "artifact subset export requires --artifact-plan <token> from a prior --with-artifacts preview",
          );
        }
        process.stdout.write("Eligible private artifacts (complete inventory):\n");
        const inventory = await collectArtifactInventory(
          api,
          (s) => process.stdout.write(s),
          artifactPlanToken,
        );
        process.stdout.write(
          `  total: ${inventory.totalCount} artifact(s), ${inventory.totalBytes} bytes\n`,
        );
        const selection = resolveArtifactSelection(inventory.entries, {
          all: argv["artifacts-all"] === true,
          tokens: artifactTokens,
        });
        if (selection.selected.length === 0) {
          process.stdout.write(
            `No artifacts selected. Re-run with --artifacts-all, or use --artifact-plan ${inventory.selectionPlanToken} with --artifacts <token...> to export a subset.\n`,
          );
          process.stdout.write(`  selection plan: ${inventory.selectionPlanToken}\n`);
          process.exitCode = 0;
          return;
        }
        artifactSelection = selection.selected;
        // Pass 1: stream each selected source through a sha256 hasher (no
        // buffering) to compute the digest + confirm size. The preview omits
        // sha by contract, so the digest is computed from the byte stream.
        const built: semantic.PortableArtifact[] = [];
        for (const entry of artifactSelection) {
          const { sha256, size } = await hashArtifactSource(api, entry);
          built.push({
            recordKind: "artifact",
            path: entry.path,
            mimeType: entry.mimeType,
            size,
            sha256,
            bytesEntry: artifactBytesEntry(entry.selectionToken),
          });
        }
        artifactRecords = built;
      }
      const artifactCount = artifactRecords.length;
      const artifactBytesTotal = artifactRecords.reduce((sum, a) => sum + a.size, 0);
      const bundleRecords = [
        ...bundleRecordsRaw,
        ...(artifactRecords as readonly unknown[]),
      ];
      const nonMemoryCount = bundleRecords.length - reportedMemoryCount - artifactCount;

      let avatarBytes: Uint8Array | null = null;
      let avatarMedia: AvatarMedia | null = null;
      if (exported.avatarMedia) {
        const blob = await api.downloadProfileBundleMedia(exported.avatarMedia.mediaEntry);
        const buf = new Uint8Array(await blob.arrayBuffer());
        avatarBytes = buf;
        avatarMedia = {
          mediaEntry: exported.avatarMedia.mediaEntry,
          sha256: exported.avatarMedia.sha256,
          mimeType: exported.avatarMedia.mimeType,
          size: exported.avatarMedia.size ?? buf.length,
        };
      }

      const passphraseStr = await readPassphrase("Passphrase: ");
      if (passphraseStr.length === 0) {
        throw new Error("passphrase must not be empty");
      }
      const confirmStr = await readPassphrase("Confirm passphrase: ");
      if (confirmStr !== passphraseStr) {
        throw new Error("passphrases did not match");
      }
      const passphrase = new TextEncoder().encode(passphraseStr);
      // The passphrase bytes travel only into the KDF call below; nothing is logged.

      const argon2id = await getArgon2idDeriveFn();
      // Wave 3: when artifacts are selected, share one fresh DEK between the
      // bundle encryption and the artifact chunk stream so the sidecar is
      // AEAD-encrypted under the same DEK + header digest.
      const dek = artifactCount > 0 ? generateDek() : undefined;
      const file = await encryptProfileBundleFile({
        records: bundleRecords as never,
        bundleId: exported.bundleId,
        avatarBytes,
        avatarMedia,
        passphrase,
        argon2id,
        dek,
      });

      const outPath =
        typeof argv["out"] === "string" && argv["out"].trim().length > 0
          ? argv["out"].trim()
          : deriveDefaultExportFilename(bundleRecords as never);

      let finalFile: ProfileBundleFile = file;
      if (artifactCount > 0) {
        // Pass 2: stream each selected source again into the artifact v2
        // chunk-media sidecar via serializeArtifactStream (no whole-artifact
        // buffering). Bound to the bundle header + shared DEK.
        const header = headerFromJson(file.header);
        const sidecarPath = deriveArtifactSidecarPath(outPath);
        const opened = artifactStreamIo.openWriter(sidecarPath);
        const sources: ArtifactStreamSource[] = [];
        for (const entry of artifactSelection) {
          const reader = await openArtifactSourceReader(api, entry);
          const artifact = artifactRecords.find(
            (a) => a.bytesEntry === artifactBytesEntry(entry.selectionToken),
          )!;
          sources.push({ artifact, reader });
        }
        await serializeArtifactStream({ header, dek: dek!, sources, writer: opened.writer });
        const summary = opened.summary();
        finalFile = { ...file, artifactStream: { mediaVersion: 2, size: summary.size, sha256: summary.sha256 } };
      }

      await bundleWriter(outPath, finalFile);

      const memClause = reportedMemoryCount > 0 ? ` + ${reportedMemoryCount} ${pluralMemory(reportedMemoryCount)}` : "";
      const artClause =
        artifactCount > 0 ? ` + ${artifactCount} ${pluralArtifact(artifactCount)} (${artifactBytesTotal} bytes)` : "";
      process.stdout.write(
        `Exported ${nonMemoryCount} semantic records${
          avatarBytes ? " + custom avatar" : ""
        }${memClause}${artClause} to ${outPath} (mode 0600).\n`,
      );
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        fail("Run `nautilo login --profile <source>` first.");
        return;
      }
      fail(e instanceof Error ? e.message : String(e));
    }
  },
};
// ---------------------------------------------------------------------------
// `nautilo agent import --profile <dst> <file> --dry-run|--apply [--on-conflict=source|target]`
// ---------------------------------------------------------------------------

export const agentImportModule: CommandModule = {
  command: "import <file>",
  describe:
    "Import a local .nautilo-profile bundle into your personal Genie on the target server. Dry-run by default; pass --apply to commit.",
  builder: (yargs) =>
    yargs
      .positional("file", {
        type: "string",
        describe: "Path to the .nautilo-profile.json bundle to import",
      })
      .demandOption("file")
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Submit a read-only dry-run plan and print it (no mutation). Default unless --apply.",
      })
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "Commit the plan after staging. Requires --on-conflict when the target conflicts.",
      })
      .option("on-conflict", {
        type: "string",
        choices: ["source", "target"] as const,
        describe:
          "Whole-profile conflict choice: source (apply the bundle) or target (keep existing). Required when the target conflicts.",
      })
      .option("passphrase", {
        type: "string",
        hidden: true,
        describe: "Rejected — passphrases are never accepted by flag.",
      })
      .option("plaintext", {
        type: "boolean",
        hidden: true,
        describe: "Rejected — plaintext mode is never permitted.",
      })
      .check((argv) => rejectPassphraseAndPlaintextFlags(argv as Record<string, unknown>)),
  handler: async (argv) => {
    process.exitCode = undefined;
    try {
      const filePath = (argv["file"] as string).trim();
      if (filePath.length === 0) {
        throw new Error("file path is required");
      }

      // 1. Read + decrypt + validate the terminal manifest BEFORE any server call.
      const file = await bundleReader(filePath);
      const passphraseStr = await readPassphrase("Passphrase: ");
      if (passphraseStr.length === 0) {
        throw new WrongPassphraseError("passphrase must not be empty");
      }
      const argon2id = await getArgon2idDeriveFn();
      const decrypted = await decryptProfileBundleFile(file, new TextEncoder().encode(passphraseStr), argon2id);

      // 2. Resolve the target server + live destination instance id.
      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = buildApiClient(transport, session.accessToken);
      const destinationInstanceId = await fetchDestinationInstanceId(api);

      // 3. Submit the read-only dry-run plan.
      const explicitChoice = isWholeProfileChoice(argv["on-conflict"]) ? argv["on-conflict"] : undefined;
      const probeChoice = explicitChoice ?? "target";
      const planRes = await api.planProfileBundleImport({
        bundle: decrypted.bundle,
        destinationInstanceId,
        scopes: decrypted.bundle.scopes,
        wholeProfileChoice: probeChoice,
      });
      const plan = planRes.plan;
      const conflicts = plan.conflicts;

      // 4. Require an explicit whole-profile choice when the target conflicts.
      if (conflicts.length > 0 && explicitChoice === undefined) {
        process.stdout.write(
          `${conflicts.length} conflict group(s) detected between the bundle and the target:\n`,
        );
        for (const c of conflicts) {
          process.stdout.write(`  - ${c.group} (would choose ${c.choice})\n`);
        }
        fail(
          "Conflicts detected. Re-run with --on-conflict=source (apply the bundle) or --on-conflict=target (keep the target) to proceed.",
        );
        return;
      }
      const effectiveChoice = explicitChoice ?? "target";

      // 5. Dry-run: print the plan and stop (unless --apply).
      const apply = argv["apply"] === true;
      if (!apply) {
        process.stdout.write(
          `Dry-run plan for ${plan.semanticRoot.slice(0, 12)} (target agent ${plan.targetAgentId}):\n`,
        );
        process.stdout.write(`  choice:    ${effectiveChoice}\n`);
        process.stdout.write(`  scopes:     ${plan.scopes.join(", ")}\n`);
        process.stdout.write(`  conflicts:  ${conflicts.length}\n`);
        process.stdout.write(`  avatar:     ${plan.avatarMedia ? plan.avatarMedia.mediaEntry : "(none)"}\n`);
        if (plan.privateMemoryCount > 0) {
          // Count only — never content / IDs / embeddings (Wave 1B).
          process.stdout.write(`  private memories: ${plan.privateMemoryCount}\n`);
        }
        if (plan.privateArtifactCount > 0) {
          // Count + totals only — never content / storage URIs / source ids (Wave 3).
          process.stdout.write(
            `  private artifacts: ${plan.privateArtifactCount} (${plan.privateArtifactBytes} bytes)\n`,
          );
        }
        if (plan.refused.length > 0 || plan.unknown.length > 0) {
          process.stdout.write(`  refused:    ${plan.refused.join(", ") || "(none)"}\n`);
          process.stdout.write(`  unknown:    ${plan.unknown.join(", ") || "(none)"}\n`);
        }
        process.stdout.write("  (no changes; pass --apply to commit)\n");
        process.exitCode = 0;
        return;
      }

      // 6. Stage raw avatar bytes only when the avatar scope is selected and
      //    the source carries a custom avatar and the choice is "source".
      if (effectiveChoice === "source" && plan.avatarMedia && decrypted.avatarBytes) {
        const staged = await api.stageProfileBundleAvatar({
          planToken: plan.planToken,
          mediaEntry: plan.avatarMedia.mediaEntry,
          // Normalize to a Node Buffer before multipart encoding. The server
          // receives/verifies raw Buffer bytes; passing the decrypted
          // Uint8Array directly through Bun's Blob/FormData boundary can
          // alter the staged byte stream and fail its checksum gate.
          bytes: new Blob([Buffer.from(decrypted.avatarBytes)]),
        });
        process.stdout.write(
          `Staged avatar ${staged.mediaEntry} (${staged.size} bytes, sha256 ${staged.sha256.slice(0, 12)}…)\n`,
        );
      }

      // 6b. D425 Wave 3 (streaming slice) — stage selected private-artifact
      //     bytes when the bundle carries artifact records and the choice is
      //     "source". The sidecar is stream-decrypted via
      //     deserializeArtifactStream (chunk by chunk) and each entry is
      //     staged by its opaque `bytesEntry` (never by path, never by source
      //     id) via a STREAMING target-stage request: decrypted chunks flow
      //     straight from the deserializer sink into the request body, never
      //     collected into a Blob/aggregate buffer. Output is count/totals
      //     only — no artifact content / storage URIs / source ids surface.
      const artifactRecords = decrypted.records.filter(
        (r): r is semantic.PortableArtifact => r.recordKind === "artifact",
      );
      if (effectiveChoice === "source" && artifactRecords.length > 0) {
        if (!file.artifactStream) {
          throw new ProfileBundleFileError(
            "bundle carries artifact records but the artifact sidecar ref is missing",
          );
        }
        const sidecarPath = deriveArtifactSidecarPath(filePath);
        if (!(await artifactStreamIo.exists(sidecarPath))) {
          throw new ProfileBundleFileError(`artifact sidecar not found: ${sidecarPath}`);
        }
        const header = headerFromJson(file.header);
        const sink = new StreamingArtifactStageSink(api, plan.planToken);
        let stagedArtifactBytes = 0;
        try {
          await deserializeArtifactStream({
            header,
            dek: decrypted.dek,
            reader: artifactStreamIo.openReader(sidecarPath),
            sink,
          });
          for (const staged of sink.getResults()) {
            stagedArtifactBytes += staged.size;
          }
        } catch (streamErr) {
          // Terminal manifest / decrypt / chunk error, OR a server-side
          // checksum/size failure surfaced from `closeEntry`. Abort the
          // in-flight streaming requests, then EXPLICITLY clean plan
          // artifact staging on the server. If the cleanup endpoint is
          // unreachable, leave temp state to the plan TTL / commit-time
          // cleanup — made explicit here, never silent.
          await sink.abort().catch(() => {});
          try {
            await api.abortProfileBundleArtifactStaging({ planToken: plan.planToken });
          } catch (cleanupErr) {
            // Explicit deferral: staging cleanup is best-effort; the plan
            // TTL + commit-time spool sweep are the safety net. Surface
            // the original stream error (not the cleanup failure).
            process.stderr.write(
              `warning: artifact staging cleanup failed for plan ${plan.planToken}: ` +
                `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)} ` +
                `(left to plan TTL/journal cleanup)\n`,
            );
          }
          if (streamErr instanceof ProfileBundleFileError) {
            throw streamErr;
          }
          throw new ProfileBundleFileError(
            `artifact staging failed: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
          );
        }
        process.stdout.write(
          `Staged ${artifactRecords.length} ${pluralArtifact(artifactRecords.length)}` +
            ` (${stagedArtifactBytes} bytes)\n`,
        );
      }

      // 7. Commit with a secure random idempotency key.
      const idempotencyKey = randomUUID();
      const stopCommitProgress = effectiveChoice === "source"
        ? startCommitProgress(process.stdout.write.bind(process.stdout), {
            privateMemoryCount: plan.privateMemoryCount,
            privateArtifactCount: plan.privateArtifactCount,
          })
        : () => {};
      let commit: Awaited<ReturnType<NautiloApiClient["commitProfileBundleImport"]>>;
      try {
        commit = await api.commitProfileBundleImport({
          planToken: plan.planToken,
          idempotencyKey,
        });
      } finally {
        stopCommitProgress();
      }

      if (commit.choice === "source") {
        const a = commit.applied;
        const memClause = plan.privateMemoryCount > 0
          ? ` + ${plan.privateMemoryCount} ${pluralMemory(plan.privateMemoryCount)} imported`
          : "";
        const artClause = plan.privateArtifactCount > 0
          ? ` + ${plan.privateArtifactCount} ${pluralArtifact(plan.privateArtifactCount)} imported`
          : "";
        process.stdout.write(
          `Applied source profile → name "${a.name}", handle "${a.handle}"` +
            `${a.handleCustomized ? " (customized)" : ""}` +
            `, avatar ${a.avatar ? a.avatar.kind : "(none)"}${memClause}${artClause}.\n`,
        );
      } else {
        process.stdout.write("Committed with choice=target; target profile unchanged.\n");
      }
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof WrongPassphraseError) {
        fail("Wrong passphrase — could not decrypt the bundle.");
        return;
      }
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        fail("Run `nautilo login --profile <destination>` first.");
        return;
      }
      if (e instanceof ProfileBundleFileError) {
        fail(`Bundle file error: ${e.message}`);
        return;
      }
      fail(e instanceof Error ? e.message : String(e));
    }
  },
};

export const agentModule: CommandModule = {
  command: "agent",
  describe:
    "Portable Genie profile migration: export to / import from a local encrypted bundle.",
  builder: (yargs) =>
    yargs
      .command(agentExportModule)
      .command(agentImportModule)
      .demandCommand(1, "Specify an agent subcommand (export / import)"),
  handler: () => {},
};
