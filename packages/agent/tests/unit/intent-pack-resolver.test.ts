import { describe, expect, test } from "bun:test";
import {
  resolveIntentPacks,
  type IntentPackReason,
  type ToolFamilyName,
} from "../../src/tools/exposure/manifest";

describe("D419 intent-pack resolver", () => {
  test.each([
    ["edit the README file in my workspace", ["filesystem"], ["explicit_filesystem_edit"]],
    ["inspect this repository and fix the failing test", ["filesystem"], ["explicit_development_request"]],
    ["find where this route is implemented", ["filesystem"], ["explicit_development_request"]],
    ["change this across the client and server", ["filesystem"], ["explicit_development_request"]],
    ["inspect this repository and run the tests", ["filesystem", "shell"], ["explicit_development_request"]],
    ["run git status in the current repository", ["shell"], ["explicit_development_request"]],
    ["list open GitHub issues for this repo", ["shell"], ["explicit_development_request"]],
    ["use gh to review pull requests", ["shell"], ["explicit_development_request"]],
    ["use run_shell for this command", ["shell"], ["explicit_development_request"]],
    ["call `run_shell` to execute it", ["shell"], ["explicit_development_request"]],
    ["use SSH to inspect the remote server", ["structured_ssh"], ["explicit_structured_ssh_request"]],
    ["deploy this service with DevOps", ["structured_ssh"], ["explicit_structured_ssh_request"]],
    ["transcribe this MP4 video", ["voice_media"], ["explicit_media_transcription"]],
    ["generate a 10-second video of a moonlit city", ["voice_media"], ["explicit_media_generation"]],
    ["make me a cyberpunk 1980s soundtrack", ["voice_media"], ["explicit_media_generation"]],
    ["compose a musical score for this scene", ["voice_media"], ["explicit_media_generation"]],
    ["launch Spotify and skip this track", [], []],
    ["In TextEdit, create exactly one fresh document and type a sentinel into it", ["filesystem"], ["explicit_filesystem_edit"]],
    ["click Submit in the embedded browser panel", [], []],
    ["create a PowerPoint presentation", ["productivity"], ["explicit_office_document_request"]],
    ["Use Codex to inspect this repository", ["orchestration"], ["explicit_harness_delegation"]],
    ["Delegate this task to the coding harness", ["orchestration"], ["explicit_harness_delegation"]],
  ])("selects only unmistakable %s", (request, families, reasons) => {
    expect(resolveIntentPacks(request)).toEqual({
      families: families as ToolFamilyName[],
      reasons: reasons as IntentPackReason[],
    });
  });

  test.each([
    "Can you help with my files?",
    "What is in my workspace?",
    "I have an audio question.",
    "Which video-generation models are available?",
    "Tell me about soundtrack composition.",
    "Could you use my computer?",
    "Open a website for me.",
    "I need a document.",
    "Please summarize this spreadsheet idea.",
    "Tell me what software development is.",
    "Explain what GitHub is.",
    "How does run_shell work?",
    "Is run_shell tied to workstation mode?",
    "What is SSH?",
    "How does remote server access work?",
    "I have a bug to discuss.",
    "Find me a restaurant nearby.",
    "Search the web for release notes.",
    "Inspect this image.",
    "Look into it.",
    "How does the Codex integration work?",
    "What harnesses are connected?",
  ])("does not pre-activate on vague text: %s", (request) => {
    expect(resolveIntentPacks(request)).toEqual({ families: [], reasons: [] });
  });
});
