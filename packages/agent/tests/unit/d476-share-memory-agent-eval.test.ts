import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { createShareMemoryTool, parseShareMemoryInput } from "../../src/tools/memory/share-memory";
import { createManageMemoryTool } from "../../src/tools/memory/manage-memory";
import { registerAllTools } from "../../src/tools/register-all";
import { buildSystemPrompt } from "../../src/prompts/templates";

/**
 * Deterministic D476 selection fixtures. These are deliberately provider-free:
 * they pin the model-visible `share_memory` contract so a provider/model swap
 * cannot silently turn a public-safe Room copy into legacy attachment.
 */
describe("D476 share_memory agent selection contract", () => {
  test("a named Human uses the unchanged attach shape", () => {
    const selection = parseShareMemoryInput({
      memory_id: "search-result-memory-1",
      target_handle: "casey",
      sensitivity: "normal",
    });

    expect(selection).toEqual({
      ok: true,
      value: {
        memory_id: "search-result-memory-1",
        target_handle: "casey",
        sensitivity: "normal",
      },
    });
  });

  test("an explicitly requested public-safe Room rewrite uses project with cited search_memory ids", () => {
    const selection = parseShareMemoryInput({
      mode: "project",
      source_memory_ids: ["search-result-memory-1", "search-result-memory-2"],
      proposed_content: "Alex created Nautilo. Address him as Alex.",
      target_room_name: "pub-room",
    });

    expect(selection).toEqual({
      ok: true,
      value: {
        mode: "project",
        source_memory_ids: ["search-result-memory-1", "search-result-memory-2"],
        proposed_content: "Alex created Nautilo. Address him as Alex.",
        target_room_name: "pub-room",
      },
    });
  });

  test("an ordinary request to share this existing Memory with a Room defaults to attach", () => {
    const selection = parseShareMemoryInput({
      memory_id: "search-result-memory-1",
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    });

    expect(selection).toEqual({
      ok: true,
      value: {
        memory_id: "search-result-memory-1",
        target: { kind: "room", name: "Project room" },
        sensitivity: "normal",
      },
    });
  });

  test("an ambiguous Room may be retried only with its opaque choice token, never an internal id", () => {
    const selected = parseShareMemoryInput({
      mode: "project",
      source_memory_ids: ["search-result-memory-1"],
      proposed_content: "Alex created Nautilo.",
      target_room_name: "pub-room",
      room_choice_token: "choice-token-returned-by-the-server",
    });
    expect(selected.ok).toBe(true);

    const internalIdAttempt = parseShareMemoryInput({
      mode: "project",
      source_memory_ids: ["search-result-memory-1"],
      proposed_content: "Alex created Nautilo.",
      target_room_name: "pub-room",
      target_room_id: "room-internal-id",
    });
    expect(internalIdAttempt.ok).toBe(false);

    const description = createShareMemoryTool().description;
    expect(description).toContain("Do not ask the Human for opaque IDs");
    expect(description).toContain("target the Room by name");
  });

  test("projection never accepts legacy attachment fields or uncited source-free copies", () => {
    expect(parseShareMemoryInput({
      mode: "project",
      source_memory_ids: ["private-memory-id"],
      proposed_content: "Safe copy.",
      target_room_name: "pub-room",
      memory_id: "private-memory-id",
      target_handle: "casey",
      sensitivity: "normal",
    }).ok).toBe(false);

    expect(parseShareMemoryInput({
      mode: "project",
      proposed_content: "Invented profile.",
      target_room_name: "pub-room",
    }).ok).toBe(false);
  });

  test("the model is told that a Room projection is a sanitized copy, not private-memory attachment", () => {
    const description = createShareMemoryTool().description;

    expect(description).toContain("new, deliberately sanitized or distilled Memory");
    expect(description).toContain("never attaches the private source Memory");
    expect(description).toContain("first search_memory for readable evidence");
    expect(description).toContain("cite at least one returned Memory ID");
  });

  test("ordinary and encrypted-compatible descriptions advertise only their supported attach targets", () => {
    const ordinary = createShareMemoryTool({ ordinaryContentAccessRequired: true });
    const legacy = createShareMemoryTool({ ordinaryContentAccessRequired: false });

    expect(ordinary.description).toContain("person or named Room");
    expect(ordinary.description).toContain('When the Human says "share this Memory," default to attach');
    expect(ordinary.description).toContain("A Room target is still attach, not a reason to project");
    expect(ordinary.description).toContain("Room membership or readability through another source does not replace");
    expect(ordinary.description).toContain("never as fallback for a Room target, denied attach, or unavailable attach");
    expect(legacy.description).toContain("attach gives one named person access");
    expect(legacy.description).toContain("Room attachment is not available here");
    expect(legacy.schema.safeParse({
      memory_id: "search-result-memory-1",
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    }).success).toBe(false);
  });

  test("system guidance separates exact sharing, explicit projection, and Memory tier management", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [
        createShareMemoryTool({ ordinaryContentAccessRequired: true }),
        createManageMemoryTool(),
      ],
    });

    expect(prompt).toContain('When the Human says "share this Memory," use `share_memory` attach');
    expect(prompt).toContain("Use project only when the Human explicitly asks for a new sanitized summary");
    expect(prompt).toContain("Project uses exact-text approval and is never a fallback");
    expect(prompt).toContain("Project has no sensitivity field; its exact proposed text is reviewed directly");
    expect(prompt).toContain("Promote changes only a Memory's recall tier and does not grant anyone access");
    expect(prompt).toContain("saves in the current authorized Memory context");
  });

  test("only one share_memory tool is registered for both modes", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => true });

    const shareMemoryEntries = catalog.query({}).filter((entry) => entry.name === "share_memory");
    expect(shareMemoryEntries).toHaveLength(1);
    expect(shareMemoryEntries[0]).toMatchObject({
      approvalMode: "hybrid",
      requiredCapabilities: ["manage_memories"],
    });
    expect(shareMemoryEntries[0]?.tags)
      .toEqual(["share", "memory", "namespace", "attach", "person", "room", "access", "project"]);
  });
});
