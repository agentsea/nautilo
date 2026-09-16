import { describe, expect, test } from "bun:test";
import {
  RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES,
  RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
  RunShellOutputArtifactStore,
  RunShellSanitizedOutputCapture,
  type RunShellOutputOwnerBinding,
} from "../../electron/run-shell-output-continuity";

const OWNER: RunShellOutputOwnerBinding = {
  instanceId: "instance-a",
  userId: "user-a",
  relayId: "relay-a",
  desktopSessionId: "desktop-a",
};

function assertNeverEscapesAnyConsumer(input: string, secret: string): void {
  for (let boundary = 1; boundary < Buffer.byteLength(input, "utf8"); boundary += 1) {
    const raw = Buffer.from(input, "utf8");
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const observed: Buffer[] = [];
    const capture = new RunShellSanitizedOutputCapture([], (stream, bytes, rawBytes) => {
      if (stream === "stdout") observed.push(Buffer.from(bytes));
      draft.append(stream, bytes, rawBytes);
    });
    capture.append("stdout", raw.subarray(0, boundary));
    capture.append("stdout", raw.subarray(boundary));
    capture.finish();
    const artifact = draft.commit();
    const page = store.read({
      reference: artifact.reference,
      owner: OWNER,
      offsetBytes: 0,
      maxBytes: RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
      deleteAfterRead: false,
    });
    expect(page).not.toBeNull();
    expect(Buffer.concat(observed).toString("utf8")).not.toContain(secret);
    expect(capture.result("stdout").text).not.toContain(secret);
    expect(`${page!.stdout}${page!.stderr}`).not.toContain(secret);
    store.clear();
  }
}

describe("D502 run_shell output continuity", () => {
  test("redacts a known secret at every byte boundary on stdout and stderr before every consumer", () => {
    const secret = Buffer.from("cross-boundary-secret");
    for (const stream of ["stdout", "stderr"] as const) {
      for (let boundary = 1; boundary < secret.length; boundary += 1) {
        const store = new RunShellOutputArtifactStore();
        const draft = store.createDraft(OWNER);
        const observed: Buffer[] = [];
        const capture = new RunShellSanitizedOutputCapture([secret], (seenStream, bytes, rawBytes) => {
          if (seenStream === stream) observed.push(Buffer.from(bytes));
          draft.append(seenStream, bytes, rawBytes);
        });
        capture.append(stream, Buffer.concat([Buffer.from("before "), secret.subarray(0, boundary)]));
        capture.append(stream, Buffer.concat([secret.subarray(boundary), Buffer.from(" after")]));
        capture.finish();
        const artifact = draft.commit();
        const retained = store.read({
          reference: artifact.reference,
          owner: OWNER,
          offsetBytes: 0,
          maxBytes: RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
          deleteAfterRead: true,
        });
        const progress = Buffer.concat(observed).toString("utf8");
        const final = capture.result(stream).text;
        const artifactText = `${retained?.stdout ?? ""}${retained?.stderr ?? ""}`;
        expect(progress).not.toContain(secret.toString());
        expect(final).not.toContain(secret.toString());
        expect(artifactText).not.toContain(secret.toString());
        expect(final).toStartWith("before [REDAC");
        expect(final).toEndWith(" after");
        store.clear();
      }
    }
  });

  test("retains only sanitized bytes and pages them under a hard response cap", () => {
    const secret = Buffer.from("artifact-secret-value");
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const capture = new RunShellSanitizedOutputCapture([secret], (stream, bytes, rawBytes) => {
      draft.append(stream, bytes, rawBytes);
    });
    capture.append("stdout", Buffer.concat([
      Buffer.alloc(RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES + 100, 0x61),
      secret,
    ]));
    capture.finish();
    const reference = draft.commit();
    expect(reference.reference).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const first = store.read({
      reference: reference.reference,
      owner: OWNER,
      offsetBytes: 0,
      maxBytes: Number.MAX_SAFE_INTEGER,
      deleteAfterRead: true,
    });
    expect(first).not.toBeNull();
    expect(Buffer.byteLength(`${first!.stdout}${first!.stderr}`)).toBeLessThanOrEqual(
      RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
    );
    expect(first!.nextOffsetBytes).not.toBeNull();
    expect(first!.deleted).toBeFalse();
    expect(`${first!.stdout}${first!.stderr}`).not.toContain(secret.toString());

    const final = store.read({
      reference: reference.reference,
      owner: OWNER,
      offsetBytes: first!.nextOffsetBytes!,
      maxBytes: RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
      deleteAfterRead: true,
    });
    expect(final?.nextOffsetBytes).toBeNull();
    expect(final?.deleted).toBeTrue();
    expect(store.read({
      reference: reference.reference,
      owner: OWNER,
      offsetBytes: 0,
      maxBytes: 16,
      deleteAfterRead: false,
    })).toBeNull();
  });

  test("searches retained stdout and stderr separately with exact stream-local byte offsets", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const stdout = "before café NEEDLE after";
    const stderr = "NEEDLE on stderr";
    draft.append("stdout", Buffer.from(stdout), Buffer.byteLength(stdout));
    draft.append("stderr", Buffer.from(stderr), Buffer.byteLength(stderr));
    const artifact = draft.commit();
    const result = store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.from("NEEDLE"),
      maxMatches: 20,
      contextBytes: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.matches).toHaveLength(2);
    expect(result!.matches[0]).toMatchObject({
      stream: "stdout",
      matchOffsetBytes: Buffer.byteLength("before café "),
      artifactOffsetBytes: Buffer.byteLength("before café "),
      matchBytes: 6,
    });
    expect(result!.matches[1]).toMatchObject({
      stream: "stderr",
      matchOffsetBytes: 0,
      artifactOffsetBytes: Buffer.byteLength(stdout),
      matchBytes: 6,
    });
    expect(result!.matches.map((match) => match.context)).toEqual([
      "afé NEEDLE afte",
      "NEEDLE on s",
    ]);
    expect(result!.totalMatches).toBe(2);
    expect(result!.matchesTruncated).toBeFalse();
    // Search is non-destructive, and the bridge offset re-enters the existing
    // combined stdout-then-stderr page protocol without guessing stdout size.
    expect(store.read({
      reference: artifact.reference,
      owner: OWNER,
      offsetBytes: result!.matches[1]!.artifactOffsetBytes,
      maxBytes: 16,
      deleteAfterRead: false,
    })).toMatchObject({ stderr: "NEEDLE on stderr" });
  });

  test("search is bounded by match, context, and exact serialized response budgets while still counting hits", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    draft.append("stdout", Buffer.alloc(2_000, 0), 2_000);
    const artifact = draft.commit();
    const result = store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.from([0]),
      maxMatches: 20,
      contextBytes: 1024,
    });

    expect(result).not.toBeNull();
    expect(result!.totalMatches).toBe(2_000);
    expect(result!.matchesTruncated).toBeTrue();
    expect(result!.matches.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(result!), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.alloc(0),
      maxMatches: 20,
      contextBytes: 0,
    })).toBeNull();
  });

  test("dense one-MiB literal search counts every hit without materializing every context", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    draft.append("stdout", Buffer.alloc(RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES, 0), RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES);
    const artifact = draft.commit();
    const result = store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.from([0]),
      maxMatches: 1,
      contextBytes: 0,
    });
    expect(result).toMatchObject({
      totalMatches: RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES,
      matchesTruncated: true,
      matches: [{ context: "\u0000" }],
    });
    expect(store.debugSearchCandidateMaterializations()).toBe(1);
  });

  test("search expands context edges to whole UTF-8 code points without exceeding the projector bound", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const output = `😀${"x".repeat(1_022)}NEEDLE${"x".repeat(1_022)}😀`;
    draft.append("stdout", Buffer.from(output), Buffer.byteLength(output));
    const artifact = draft.commit();
    const result = store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.from("NEEDLE"),
      maxMatches: 1,
      contextBytes: 1024,
    });
    expect(result).not.toBeNull();
    expect(result!.matchesTruncated).toBeFalse();
    expect(Buffer.byteLength(result!.matches[0]!.context, "utf8")).toBeLessThanOrEqual((3 * 1024) + 6);
    expect(Buffer.byteLength(JSON.stringify(result!), "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  test("search has no match and shares expiry and ownership denial with paging", async () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    draft.append("stdout", Buffer.from("safe output"), 11);
    const artifact = draft.commit();
    expect(store.search({
      reference: artifact.reference,
      owner: { ...OWNER, userId: "another-user" },
      query: Buffer.from("safe"),
      maxMatches: 20,
      contextBytes: 0,
    })).toBeNull();
    expect(store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.from("missing"),
      maxMatches: 20,
      contextBytes: 0,
    })).toMatchObject({ matches: [], totalMatches: 0, matchesTruncated: false });

    const expiringStore = new RunShellOutputArtifactStore(5);
    const expiringDraft = expiringStore.createDraft(OWNER);
    expiringDraft.append("stdout", Buffer.from("safe output"), 11);
    const expiringArtifact = expiringDraft.commit();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(expiringStore.search({
      reference: expiringArtifact.reference,
      owner: OWNER,
      query: Buffer.from("safe"),
      maxMatches: 20,
      contextBytes: 0,
    })).toBeNull();
  });

  test("search sees only already-redacted retained output and evicted references remain indistinguishable", () => {
    const secret = Buffer.from("search-redaction-secret");
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const capture = new RunShellSanitizedOutputCapture([secret], (stream, bytes, rawBytes) => {
      draft.append(stream, bytes, rawBytes);
    });
    capture.append("stdout", Buffer.concat([Buffer.from("value="), secret]));
    capture.finish();
    const artifact = draft.commit();
    expect(store.search({
      reference: artifact.reference, owner: OWNER, query: secret, maxMatches: 20, contextBytes: 0,
    })).toMatchObject({ matches: [], totalMatches: 0 });
    expect(store.search({
      reference: artifact.reference, owner: OWNER, query: Buffer.from("REDACTED"), maxMatches: 20, contextBytes: 0,
    })?.matches[0]?.context).not.toContain(secret.toString());

    const oneMiB = Buffer.alloc(RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES, 0x61);
    for (let index = 0; index < 8; index += 1) {
      const next = store.createDraft(OWNER);
      next.append("stdout", oneMiB, oneMiB.length);
      next.commit();
    }
    expect(store.search({
      reference: artifact.reference, owner: OWNER, query: Buffer.from("REDACTED"), maxMatches: 20, contextBytes: 0,
    })).toBeNull();
    expect(store.search({
      reference: "z".repeat(43), owner: OWNER, query: Buffer.from("REDACTED"), maxMatches: 20, contextBytes: 0,
    })).toBeNull();
    store.clear();
  });

  test("search reports no hit beyond the sanitized retained-capture ceiling", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const capture = new RunShellSanitizedOutputCapture([], (stream, bytes, rawBytes) => {
      draft.append(stream, bytes, rawBytes);
    });
    const marker = "D505-BEYOND-RETAINED-CAP";
    capture.append("stdout", Buffer.alloc(RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES, 0x61));
    capture.append("stdout", Buffer.from(marker));
    capture.finish();
    const artifact = draft.commit();
    expect(artifact).toMatchObject({
      capturedBytes: RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES,
      totalBytes: RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES + Buffer.byteLength(marker),
      truncated: true,
    });
    expect(store.search({
      reference: artifact.reference,
      owner: OWNER,
      query: Buffer.from(marker),
      maxMatches: 20,
      contextBytes: 0,
    })).toMatchObject({ totalMatches: 0, matches: [], truncated: true });
  });

  test("keeps ordinary short output live even when an Electron env secret is long", () => {
    const observed: Buffer[] = [];
    const capture = new RunShellSanitizedOutputCapture([Buffer.alloc(2048, 0x78)], (_stream, bytes) => {
      observed.push(Buffer.from(bytes));
    });
    capture.append("stdout", Buffer.from("ordinary short output\n"));
    expect(Buffer.concat(observed).toString("utf8")).toBe("ordinary short output\n");
  });

  test("redacts common credential-shaped output at every chunk split before progress, final, and retention", () => {
    const cases = [
      {
        input: "github=ghp_abcdefghijklmnopqrstuvwxyz0123456789 done\n",
        secret: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        input: "openai=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 done\n",
        secret: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        input: "anthropic=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 done\n",
        secret: "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        input: "aws=AKIAABCDEFGHIJKLMNOP done\n",
        secret: "AKIAABCDEFGHIJKLMNOP",
      },
      {
        input: "google=AIzaabcdefghijklmnopqrstuvwxyz012345678 done\n",
        secret: "AIzaabcdefghijklmnopqrstuvwxyz012345678",
      },
      {
        input: "slack=xoxb-abcdefghijklmnopqrstuvwxyz0123456789 done\n",
        secret: "xoxb-abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        input: "stripe=sk_live_abcdefghijklmnopqrstuvwxyz012345 done\n",
        secret: "sk_live_abcdefghijklmnopqrstuvwxyz012345",
      },
      {
        input: "npm=npm_abcdefghijklmnopqrstuvwxyz012345 done\n",
        secret: "npm_abcdefghijklmnopqrstuvwxyz012345",
      },
      {
        input: "huggingface=hf_abcdefghijklmnopqrstuvwxyz012345 done\n",
        secret: "hf_abcdefghijklmnopqrstuvwxyz012345",
      },
      {
        input: "telegram=1234567890:abcdefghijklmnopqrstuvwxyz0123456789 done\n",
        secret: "1234567890:abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        input: "Authorization: Bearer bearer-secret-value-123456\n",
        secret: "bearer-secret-value-123456",
      },
      {
        input: "Authorization: Basic basic-secret-value-123456\n",
        secret: "basic-secret-value-123456",
      },
      {
        input: "database_password=assignment-secret-value-123456\n",
        secret: "assignment-secret-value-123456",
      },
      {
        input: '{"api_key":"json-secret-value-123456"}\n',
        secret: "json-secret-value-123456",
      },
      {
        input: "postgresql://alice:database-url-secret-123456@db.example.test/main\n",
        secret: "database-url-secret-123456",
      },
      {
        input: "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material-123456\n-----END OPENSSH PRIVATE KEY-----\n",
        secret: "private-key-material-123456",
      },
    ];
    for (const candidate of cases) assertNeverEscapesAnyConsumer(candidate.input, candidate.secret);
  });

  test("never emits the tail of overlong GitHub or OpenAI candidates", () => {
    for (const secret of [
      `ghp_${"a".repeat(512)}`,
      `sk-proj-${"b".repeat(512)}`,
    ]) {
      assertNeverEscapesAnyConsumer(`credential=${secret} complete\n`, secret);
    }
  });

  test("bounds an unterminated private-key candidate without leaking it to a later frame", () => {
    const body = "private-key-material-".repeat(1_000);
    const observed: Buffer[] = [];
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const capture = new RunShellSanitizedOutputCapture([], (stream, bytes, rawBytes) => {
      observed.push(Buffer.from(bytes));
      draft.append(stream, bytes, rawBytes);
    });
    capture.append("stdout", Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`));
    capture.append("stdout", Buffer.from("continued-private-key-material"));
    capture.finish();
    const artifact = draft.commit();
    const page = store.read({
      reference: artifact.reference,
      owner: OWNER,
      offsetBytes: 0,
      maxBytes: RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
      deleteAfterRead: false,
    });
    expect(Buffer.concat(observed).toString("utf8")).not.toContain("private-key-material");
    expect(capture.result("stdout").text).not.toContain("private-key-material");
    expect(`${page!.stdout}${page!.stderr}`).not.toContain("private-key-material");
    expect(Buffer.byteLength(Buffer.concat(observed))).toBeGreaterThanOrEqual(8 * 1024);
  });

  test("opaque reference is not authority across instance, user, relay, or desktop session", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    draft.append("stdout", Buffer.from("safe"), 4);
    const reference = draft.commit();

    for (const owner of [
      { ...OWNER, instanceId: "instance-b" },
      { ...OWNER, userId: "user-b" },
      { ...OWNER, relayId: "relay-b" },
      { ...OWNER, desktopSessionId: "desktop-b" },
    ]) {
      expect(store.read({
        reference: reference.reference,
        owner,
        offsetBytes: 0,
        maxBytes: 16,
        deleteAfterRead: false,
      })).toBeNull();
    }
  });

  test("expires and deletes retained output", async () => {
    const store = new RunShellOutputArtifactStore(5);
    const draft = store.createDraft(OWNER);
    draft.append("stdout", Buffer.from("temporary"), 9);
    const reference = draft.commit();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.read({
      reference: reference.reference,
      owner: OWNER,
      offsetBytes: 0,
      maxBytes: 16,
      deleteAfterRead: false,
    })).toBeNull();
  });

  test("malformed UTF-8 flood pages always advance and stays within the returned-text cap", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const invalid = Buffer.alloc(100_000, 0xff);
    draft.append("stdout", invalid, invalid.length);
    const artifact = draft.commit();
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = store.read({
        reference: artifact.reference,
        owner: OWNER,
        offsetBytes: offset,
        maxBytes: RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES,
        deleteAfterRead: false,
      });
      expect(page).not.toBeNull();
      expect(Buffer.byteLength(`${page!.stdout}${page!.stderr}`, "utf8"))
        .toBeLessThanOrEqual(RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES);
      pages += 1;
      if (page!.nextOffsetBytes === null) break;
      expect(page!.nextOffsetBytes).toBeGreaterThan(offset);
      offset = page!.nextOffsetBytes;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1);
  });

  test("keeps artifact byte metadata coherent after UTF-8 replacement expansion", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const capture = new RunShellSanitizedOutputCapture([], (stream, bytes, rawBytes) => {
      draft.append(stream, bytes, rawBytes);
    });
    capture.append("stdout", Buffer.from([0xff, 0xff]));
    capture.finish();
    const artifact = draft.commit();
    expect(artifact.capturedBytes).toBe(6);
    expect(artifact.totalBytes).toBe(6);
    expect(artifact.truncated).toBeFalse();
  });

  test("coalesces a one-byte callback flood into a small bounded block count", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    for (let index = 0; index < 100_000; index += 1) {
      const stream = index % 2 === 0 ? "stdout" : "stderr";
      draft.append(stream, Buffer.from(stream === "stdout" ? "x" : "y"), 1);
    }
    expect(draft.debugRetainedBlockCount()).toBe(2);
    const artifact = draft.commit();
    expect(artifact.capturedBytes).toBe(100_000);
    expect(artifact.totalBytes).toBe(100_000);
    expect(draft.debugRetainedBlockCount()).toBe(0);

    const page = store.read({
      reference: artifact.reference,
      owner: OWNER,
      offsetBytes: 0,
      maxBytes: 32,
      deleteAfterRead: false,
    });
    expect(page?.stdout).toBe("x".repeat(32));
  });

  test("caps each artifact at one MiB while accounting for omitted sanitized bytes", () => {
    const store = new RunShellOutputArtifactStore();
    const draft = store.createDraft(OWNER);
    const flood = Buffer.alloc(RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES * 2, 0x61);
    draft.append("stdout", flood, flood.length);
    const artifact = draft.commit();
    expect(artifact).toMatchObject({
      capturedBytes: RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES,
      totalBytes: RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES * 2,
      truncated: true,
    });
  });

  test("evicts the oldest artifact at the eight MiB global bound", () => {
    const store = new RunShellOutputArtifactStore();
    const references: string[] = [];
    const oneMiB = Buffer.alloc(RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES, 0x61);
    for (let index = 0; index < 9; index += 1) {
      const draft = store.createDraft(OWNER);
      draft.append("stdout", oneMiB, oneMiB.length);
      references.push(draft.commit().reference);
    }
    expect(store.read({
      reference: references[0]!, owner: OWNER, offsetBytes: 0, maxBytes: 4, deleteAfterRead: false,
    })).toBeNull();
    expect(store.read({
      reference: references[1]!, owner: OWNER, offsetBytes: 0, maxBytes: 4, deleteAfterRead: false,
    })).not.toBeNull();
    store.clear();
  });

  test("evicts the oldest artifact at sixteen entries and clear deletes every survivor", () => {
    const store = new RunShellOutputArtifactStore();
    const references: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const draft = store.createDraft(OWNER);
      draft.append("stdout", Buffer.from(String(index)), String(index).length);
      references.push(draft.commit().reference);
    }
    expect(store.read({
      reference: references[0]!, owner: OWNER, offsetBytes: 0, maxBytes: 4, deleteAfterRead: false,
    })).toBeNull();
    expect(store.read({
      reference: references[1]!, owner: OWNER, offsetBytes: 0, maxBytes: 4, deleteAfterRead: false,
    })).not.toBeNull();
    store.clear();
    for (const reference of references.slice(1)) {
      expect(store.read({
        reference, owner: OWNER, offsetBytes: 0, maxBytes: 4, deleteAfterRead: false,
      })).toBeNull();
    }
  });
});
