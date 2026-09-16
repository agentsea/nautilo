import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditDtoDeclarations,
  discoverSseDtoInventory,
  type DtoDeclaration,
  type DtoInventoryObservation,
} from "../../src/node/dto-inventory";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `m220 ${name} `));
  temporaryRoots.push(root);
  return root;
}

function declarationFor(observation: DtoInventoryObservation): DtoDeclaration {
  return {
    observationId: observation.id,
    locator: observation.locator,
    structuralSignatures: observation.structuralSignatures,
    arbitraryPayloads: observation.arbitraryPayloads.map((path) => ({
      path,
      schema: "ClosedEventFieldV1",
    })),
  };
}

async function writeSoulProducer(root: string): Promise<void> {
  const serverRoot = join(root, "packages/server/src");
  await mkdir(serverRoot, { recursive: true });
  await writeFile(join(serverRoot, "profile.ts"), `
    app.post("/api/profile/generate-soul/stream", async (_request, reply) => {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      const writeSse = (_reply: unknown, _event: string, _payload: unknown) => {};
      writeSse(reply, "soul.delta", { text: "private" });
    });
  `);
}

describe("SSE consumer evidence", () => {
  test("raw stream consumers retain their parsed payload shape", async () => {
    const root = await fixtureRoot("raw consumer shape");
    await writeSoulProducer(root);
    const desktopRoot = join(root, "apps/desktop");
    await mkdir(desktopRoot, { recursive: true });
    const consumerFile = join(desktopRoot, "soul.ts");
    await writeFile(consumerFile, `
      function consume(eventName: string, dataText: string): void {
        const data = JSON.parse(dataText) as {
          text?: unknown;
          privateTrace?: unknown;
        };
        if (eventName === "soul.delta" && typeof data.text === "string") {
          use(data.text);
        }
      }
    `);

    const observations = await discoverSseDtoInventory(root);
    const accepted = observations.find((item) =>
      item.locator
        === "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta"
    );

    expect(accepted?.structuralSignatures).toEqual([
      "consumer:apps/desktop/soul.ts#1:event.payload:{privateTrace?:unknown;text?:unknown}",
    ]);
    expect(accepted?.structuralSignatures).not.toContain("event.payload:unknown");

    await writeFile(consumerFile, `
      function consume(eventName: string, dataText: string): void {
        const data = JSON.parse(dataText) as {
          text?: unknown;
          privateTrace?: unknown;
          recoveryPhrase?: unknown;
        };
        if (eventName === "soul.delta" && typeof data.text === "string") {
          use(data.text);
        }
      }
    `);
    const changed = await discoverSseDtoInventory(root);
    const audit = auditDtoDeclarations({
      observations: changed,
      declarations: observations.map(declarationFor),
    });
    expect(audit.ok).toBe(false);
    if (audit.ok) throw new Error("expected raw SSE parser drift");
    expect(audit.errors).toContain(
      "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta: "
        + "missing structural signature: "
        + "consumer:apps/desktop/soul.ts#1:event.payload:"
        + "{privateTrace?:unknown;recoveryPhrase?:unknown;text?:unknown}",
    );
  });

  test("duplicate consumers retain complete deterministic evidence and deletion fails audit", async () => {
    const root = await fixtureRoot("duplicate consumer evidence");
    await writeSoulProducer(root);
    const desktopRoot = join(root, "apps/desktop");
    const workbenchRoot = join(root, "apps/workbench/src");
    await mkdir(desktopRoot, { recursive: true });
    await mkdir(workbenchRoot, { recursive: true });
    await writeFile(join(desktopRoot, "soul.ts"), `
      function consumeFirst(eventName: string, dataText: string): void {
        const data = JSON.parse(dataText) as { text?: unknown };
        if (eventName === "soul.delta") use(data);
      }
      function consumeSecond(eventName: string, dataText: string): void {
        const data = JSON.parse(dataText) as { text?: unknown; localSequence?: number };
        if (eventName === "soul.delta") use(data);
      }
    `);
    const workbenchFile = join(workbenchRoot, "soul.ts");
    await writeFile(workbenchFile, `
      function consume(eventName: string, dataText: string): void {
        const data = JSON.parse(dataText) as { text?: unknown; sequence?: number };
        if (eventName === "soul.delta") use(data);
      }
    `);

    const before = await discoverSseDtoInventory(root);
    const original = before.find((item) =>
      item.locator
        === "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta"
    );
    expect(original?.sourcePath).toBe("apps/desktop/soul.ts");
    expect(original?.structuralSignatures).toEqual([
      "consumer:apps/desktop/soul.ts#1:event.payload:{text?:unknown}",
      "consumer:apps/desktop/soul.ts#2:event.payload:{localSequence?:number;text?:unknown}",
      "consumer:apps/workbench/src/soul.ts#1:event.payload:{sequence?:number;text?:unknown}",
    ]);

    await rm(workbenchFile);
    const after = await discoverSseDtoInventory(root);
    const audit = auditDtoDeclarations({
      observations: after,
      declarations: before.map(declarationFor),
    });

    expect(audit).toEqual({
      ok: false,
      errors: [
        "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta: "
          + "stale structural signature: "
          + "consumer:apps/workbench/src/soul.ts#1:event.payload:"
          + "{sequence?:number;text?:unknown}",
      ],
    });
  });
});
