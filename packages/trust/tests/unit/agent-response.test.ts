import { describe, expect, test } from "bun:test";
import { parseAgentMentions } from "../../src/agent-response";

const HANDLE = "Genie";

describe("parseAgentMentions", () => {
  test("strict @handle matches", () => {
    expect(parseAgentMentions("hey @Genie what's up", HANDLE)).toEqual({
      hasMention: true,
      hasSlashCommand: false,
    });
  });

  test("federated @handle@server matches (prefix only)", () => {
    expect(parseAgentMentions("@Genie@nautilo.local please help", HANDLE)).toEqual({
      hasMention: true,
      hasSlashCommand: false,
    });
  });

  test("@everyone does not match", () => {
    expect(parseAgentMentions("@everyone lunch?", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
  });

  test("@channel does not match", () => {
    expect(parseAgentMentions("@channel standup", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
  });

  test("@handle inside code fence does not match", () => {
    expect(
      parseAgentMentions("use ```@Genie``` in docs only", HANDLE),
    ).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
  });

  test("empty content returns no match", () => {
    expect(parseAgentMentions("", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
    expect(parseAgentMentions("   ", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
  });

  test("slash command at start returns hasSlashCommand", () => {
    expect(parseAgentMentions("/status ping", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: true,
    });
  });

  test("slash command not at start returns false", () => {
    expect(parseAgentMentions("please /status later", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
  });

  test("multiple @handle in same message is still one boolean mention", () => {
    expect(parseAgentMentions("@Genie and @Genie again", HANDLE)).toEqual({
      hasMention: true,
      hasSlashCommand: false,
    });
  });

  test("wrong-case handle does not match (case-sensitive)", () => {
    expect(parseAgentMentions("@genie hello", HANDLE)).toEqual({
      hasMention: false,
      hasSlashCommand: false,
    });
  });
});
