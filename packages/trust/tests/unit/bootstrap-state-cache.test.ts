import { describe, expect, test, beforeEach } from "bun:test";
import {
  setBootstrapOwnerId,
  getBootstrapOwnerId,
  setBootstrapOwnerBound,
  isBootstrapOwnerBound,
  setBootstrapOwnerActorId,
  getBootstrapOwnerActorId,
  setBootstrapDefaultAgentId,
  getBootstrapDefaultAgentId,
  _resetBootstrapStateCacheForTests,
} from "../../src/bootstrap-state-cache";

describe("bootstrap-state-cache (D120 A1)", () => {
  beforeEach(() => _resetBootstrapStateCacheForTests());

  test("ownerId — empty before set, round-trips after, last-write-wins", () => {
    expect(getBootstrapOwnerId()).toBe("");
    setBootstrapOwnerId("uuid-owner-1");
    expect(getBootstrapOwnerId()).toBe("uuid-owner-1");
    setBootstrapOwnerId("uuid-owner-2");
    expect(getBootstrapOwnerId()).toBe("uuid-owner-2");
  });

  test("owner binding is explicit and never inferred from the fresh seed owner id", () => {
    setBootstrapOwnerId("bootstrap-seed-user");
    expect(isBootstrapOwnerBound()).toBe(false);
    setBootstrapOwnerBound(true);
    expect(isBootstrapOwnerBound()).toBe(true);
  });

  test("ownerActorId — empty before set, round-trips, last-write-wins", () => {
    expect(getBootstrapOwnerActorId()).toBe("");
    setBootstrapOwnerActorId("actor-1");
    expect(getBootstrapOwnerActorId()).toBe("actor-1");
    setBootstrapOwnerActorId("actor-2");
    expect(getBootstrapOwnerActorId()).toBe("actor-2");
  });

  test("defaultAgentId — empty before set, round-trips, last-write-wins", () => {
    expect(getBootstrapDefaultAgentId()).toBe("");
    setBootstrapDefaultAgentId("agent-1");
    expect(getBootstrapDefaultAgentId()).toBe("agent-1");
    setBootstrapDefaultAgentId("agent-2");
    expect(getBootstrapDefaultAgentId()).toBe("agent-2");
  });

  test("the identity fields are independent", () => {
    setBootstrapOwnerId("owner-x");
    setBootstrapOwnerActorId("actor-x");
    setBootstrapDefaultAgentId("agent-x");
    expect(getBootstrapOwnerId()).toBe("owner-x");
    expect(getBootstrapOwnerActorId()).toBe("actor-x");
    expect(getBootstrapDefaultAgentId()).toBe("agent-x");

    // mutate one, others unchanged
    setBootstrapOwnerId("owner-y");
    expect(getBootstrapOwnerId()).toBe("owner-y");
    expect(getBootstrapOwnerActorId()).toBe("actor-x");
    expect(getBootstrapDefaultAgentId()).toBe("agent-x");
  });

  test("_resetBootstrapStateCacheForTests clears identity and binding state", () => {
    setBootstrapOwnerId("o");
    setBootstrapOwnerActorId("a");
    setBootstrapDefaultAgentId("g");
    setBootstrapOwnerBound(true);
    _resetBootstrapStateCacheForTests();
    expect(getBootstrapOwnerId()).toBe("");
    expect(getBootstrapOwnerActorId()).toBe("");
    expect(getBootstrapDefaultAgentId()).toBe("");
    expect(isBootstrapOwnerBound()).toBe(false);
  });
});
