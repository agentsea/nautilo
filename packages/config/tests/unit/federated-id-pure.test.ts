import { describe, test, expect } from "bun:test";
import {
  composeFederatedId,
  parseFederatedId,
} from "@nautilo/config/federated-id-pure";

describe("@nautilo/config/federated-id-pure sub-path", () => {
  test("parseFederatedId parses canonical @handle@server ids", () => {
    expect(parseFederatedId("@sender@nautilo.dev")).toEqual({
      handle: "sender",
      server: "nautilo.dev",
    });
    expect(parseFederatedId("@alex@nautilo.local")).toEqual({
      handle: "alex",
      server: "nautilo.local",
    });
  });

  test("parseFederatedId rejects invalid input", () => {
    expect(parseFederatedId("sender@nautilo.dev")).toBeNull();
    expect(parseFederatedId("@a@b")).toBeNull();
    expect(parseFederatedId("@Alex@nautilo.local")).toBeNull();
    expect(parseFederatedId("")).toBeNull();
  });

  test("composeFederatedId round-trips with parseFederatedId", () => {
    const id = composeFederatedId("sender", "nautilo.dev");
    expect(id).toBe("@sender@nautilo.dev");
    expect(parseFederatedId(id)).toEqual({
      handle: "sender",
      server: "nautilo.dev",
    });
  });
});
