import type { ChatModel } from "./types";

/** Shared test-only state kept outside the universal-provider module so partial mocks stay valid. */
let stubModel: ChatModel | null = null;

export function setStubModelForTests(model: ChatModel | null): void {
  if (process.env["NAUTILO_TEST_MODE"] !== "stub") {
    throw new Error("Stub model seam requires NAUTILO_TEST_MODE=stub");
  }
  stubModel = model;
}

export function hasStubModelForTests(): boolean {
  return process.env["NAUTILO_TEST_MODE"] === "stub" && stubModel !== null;
}

export function getStubModelForTests(): ChatModel | null {
  return hasStubModelForTests() ? stubModel : null;
}
