import { describe, expect, test } from "bun:test";

import {
  evaluateRailwayTemplateExperiment,
  type RailwayTemplateExperimentContractInput,
  type RailwayTemplateExperimentReasonCode,
} from "../../src/template-contract";

const digest = `registry.nautilo.test:5443/experiments/template-hold@sha256:${"a".repeat(64)}`;

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function fixture(): Mutable<RailwayTemplateExperimentContractInput> {
  const identity = { projectId: "project-1", environmentId: "environment-1", serviceId: "service-1" } as const;
  const volume = { id: "volume-1", mountPath: "/var/lib/template" } as const;
  const domain = { id: "domain-1", kind: "generated" as const, targetPort: 3001 };
  const inventory = [
    { kind: "project" as const, id: identity.projectId },
    { kind: "environment" as const, id: identity.environmentId },
    { kind: "service" as const, id: identity.serviceId },
    { kind: "volume" as const, id: volume.id },
    { kind: "domain" as const, id: domain.id },
  ];
  const variables = [{ key: "GATE1_SECRET", source: "template-generated-secret" as const, referenceScope: "service" as const, rendered: true as const }];
  const provenance = { templateId: "template-1", templateServiceId: "template-service-1", templateThreadSlug: null };
  return {
    expected: {
      identity, imageReference: digest, heldStartCommand: "sleep infinity", volume, domain,
      variables, provenance, receiptOwnedInventory: inventory,
    },
    observed: {
      identity: { ...identity }, source: { kind: "image", imageReference: digest }, startCommand: "sleep infinity",
      mounts: [{ volumeId: volume.id, mountPath: volume.mountPath }], domains: [{ ...domain }],
      variables: [{ ...variables[0]! }], provenance: { ...provenance },
      resources: inventory.map((entry) => ({ ...entry })),
      terminalCleanup: {
        state: "verified-absent", receiptOwnedInventory: inventory.map((entry) => ({ ...entry })),
        projectAbsent: true, survivingResources: [],
      },
    },
  };
}

function evaluate(input: RailwayTemplateExperimentContractInput) {
  return evaluateRailwayTemplateExperiment(input);
}

function expectNoGo(
  input: RailwayTemplateExperimentContractInput,
  code: Exclude<RailwayTemplateExperimentReasonCode, "railway.template-contract.qualified">,
) {
  expect(evaluate(input)).toEqual({ outcome: "no-go", code });
}

describe("evaluateRailwayTemplateExperiment", () => {
  test("qualifies exactly one immutable held-image experiment", () => {
    expect(evaluate(fixture())).toEqual({ outcome: "go", code: "railway.template-contract.qualified" });
  });

  test("accepts a canonical digest reference with a registry port", () => {
    expect(evaluate(fixture()).outcome).toBe("go");
  });

  test("accepts Railway's immutable Docker Hub shorthand and private-template null thread slug", () => {
    const input = fixture();
    input.expected.imageReference = `alpine@sha256:${"a".repeat(64)}`;
    input.observed.source.imageReference = input.expected.imageReference;
    expect(evaluate(input)).toEqual({ outcome: "go", code: "railway.template-contract.qualified" });
  });

  test("rejects tag plus digest and mutable or wrong image sources", () => {
    const tagged = fixture();
    tagged.observed.source.imageReference = digest.replace("/template-hold@", "/template-hold:latest@");
    expectNoGo(tagged, "railway.template-contract.mutable-image");
    const mutable = fixture();
    mutable.observed.source.imageReference = "registry.nautilo.test:5443/experiments/template-hold:latest";
    expectNoGo(mutable, "railway.template-contract.mutable-image");
    const wrong = fixture();
    wrong.observed.source.imageReference = `registry.nautilo.test:5443/experiments/template-hold@sha256:${"b".repeat(64)}`;
    expectNoGo(wrong, "railway.template-contract.mutable-image");
    const repository = fixture();
    repository.observed.source = { kind: "repository", repository: "github.com/nautilo/unsafe" } as unknown as typeof repository.observed.source;
    expectNoGo(repository, "railway.template-contract.source-not-image");
  });

  test("rejects identity and observed resource inventory drift, including unknown, missing, extra, and duplicate resources", () => {
    const identity = fixture(); identity.observed.identity.projectId = "other-project";
    expectNoGo(identity, "railway.template-contract.identity-mismatch");
    const missing = fixture(); missing.observed.resources = missing.observed.resources.slice(1);
    expectNoGo(missing, "railway.template-contract.resource-inventory-mismatch");
    const extra = fixture(); extra.observed.resources = [...extra.observed.resources, { kind: "service", id: "foreign-service" }];
    expectNoGo(extra, "railway.template-contract.resource-inventory-mismatch");
    const duplicate = fixture(); duplicate.observed.resources = [...duplicate.observed.resources, { ...duplicate.observed.resources[0]! }];
    expectNoGo(duplicate, "railway.template-contract.resource-inventory-mismatch");
    const unknown = fixture();
    (unknown.observed.resources as unknown[]).push({ kind: "bucket", id: "unexpected" });
    expectNoGo(unknown, "railway.template-contract.input-invalid");
  });

  test("rejects missing, ambiguous, and mismatched template provenance", () => {
    const mismatched = fixture(); mismatched.observed.provenance.templateThreadSlug = "other-template";
    expectNoGo(mismatched, "railway.template-contract.provenance-invalid");
    const missing = fixture();
    delete (missing.observed.provenance as Record<string, unknown>)["templateServiceId"];
    expectNoGo(missing, "railway.template-contract.input-invalid");
    const ambiguous = fixture();
    (ambiguous.observed.provenance as Record<string, unknown>)["additionalTemplateId"] = "template-2";
    expectNoGo(ambiguous, "railway.template-contract.input-invalid");
  });

  test("rejects held-command, mount, domain, and port drift", () => {
    const command = fixture(); command.observed.startCommand = "bun server.ts";
    expectNoGo(command, "railway.template-contract.held-command-mismatch");
    const mount = fixture(); mount.observed.mounts[0]!.mountPath = "/wrong";
    expectNoGo(mount, "railway.template-contract.volume-mount-mismatch");
    const duplicateMount = fixture(); duplicateMount.observed.mounts = [...duplicateMount.observed.mounts, { ...duplicateMount.observed.mounts[0]! }];
    expectNoGo(duplicateMount, "railway.template-contract.volume-mount-mismatch");
    for (const unsafePath of ["/var/./template", "/var/../template", "/var//template", "/var/template/"]) {
      const unsafeMount = fixture(); unsafeMount.observed.mounts[0]!.mountPath = unsafePath;
      expectNoGo(unsafeMount, "railway.template-contract.volume-mount-mismatch");
    }
    const unsafeExpectedMount = fixture(); unsafeExpectedMount.expected.volume.mountPath = "/var//template";
    expectNoGo(unsafeExpectedMount, "railway.template-contract.input-invalid");
    const domain = fixture(); domain.observed.domains[0]!.id = "other-domain";
    expectNoGo(domain, "railway.template-contract.domain-mismatch");
    const port = fixture(); port.observed.domains[0]!.targetPort = 3002;
    expectNoGo(port, "railway.template-contract.domain-mismatch");
  });

  test("rejects raw, secret-like, duplicate, and drifted variable evidence", () => {
    const literal = fixture();
    (literal.observed.variables[0]! as Record<string, unknown>)["value"] = "SUPER_SECRET";
    expectNoGo(literal, "railway.template-contract.input-invalid");
    const secret = fixture();
    (secret.observed.variables[0]! as Record<string, unknown>)["source"] = "literal";
    expectNoGo(secret, "railway.template-contract.input-invalid");
    const unrendered = fixture();
    (unrendered.observed.variables[0]! as Record<string, unknown>)["rendered"] = false;
    expectNoGo(unrendered, "railway.template-contract.input-invalid");
    const duplicate = fixture(); duplicate.observed.variables = [...duplicate.observed.variables, { ...duplicate.observed.variables[0]! }];
    expectNoGo(duplicate, "railway.template-contract.input-invalid");
    const drifted = fixture(); drifted.observed.variables[0]!.referenceScope = "project";
    expectNoGo(drifted, "railway.template-contract.variable-metadata-invalid");
    const providerReference = fixture();
    providerReference.expected.variables[0]!.source = "provider-reference";
    providerReference.observed.variables[0]!.source = "provider-reference";
    expect(evaluate(providerReference).outcome).toBe("go");
  });

  test("requires independently verified terminal cleanup, never a plan or partial observation", () => {
    const planned = fixture();
    (planned.observed.terminalCleanup as Record<string, unknown>)["state"] = "planned";
    expect(evaluate(planned).outcome).toBe("no-go");
    const notRun = fixture();
    (notRun.observed.terminalCleanup as Record<string, unknown>)["projectAbsent"] = false;
    expect(evaluate(notRun).outcome).toBe("no-go");
    const partial = fixture();
    (partial.observed.terminalCleanup.survivingResources as unknown[]).push({ kind: "service", id: "service-1" });
    expect(evaluate(partial).outcome).toBe("no-go");
    const foreign = fixture(); foreign.observed.terminalCleanup.receiptOwnedInventory = [...foreign.observed.terminalCleanup.receiptOwnedInventory, { kind: "service", id: "foreign-service" }];
    expectNoGo(foreign, "railway.template-contract.cleanup-inventory-invalid");
    const missing = fixture(); missing.observed.terminalCleanup.receiptOwnedInventory = missing.observed.terminalCleanup.receiptOwnedInventory.slice(1);
    expectNoGo(missing, "railway.template-contract.cleanup-inventory-invalid");
    const duplicate = fixture(); duplicate.observed.terminalCleanup.receiptOwnedInventory = [...duplicate.observed.terminalCleanup.receiptOwnedInventory, { ...duplicate.observed.terminalCleanup.receiptOwnedInventory[0]! }];
    expectNoGo(duplicate, "railway.template-contract.cleanup-inventory-invalid");
  });

  test("returns a frozen, redacted result and does not retain mutable caller evidence", () => {
    const input = fixture();
    const result = evaluate(input);
    expect(Object.isFrozen(result)).toBe(true);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      input.expected.identity.projectId, input.expected.imageReference, input.expected.heldStartCommand,
      input.expected.domain.id, input.expected.variables[0]!.key,
    ]) expect(serialized).not.toContain(forbidden);
    input.observed.source.imageReference = "registry.nautilo.test:5443/experiments/template-hold:latest";
    expect(result).toEqual({ outcome: "go", code: "railway.template-contract.qualified" });
    expect(evaluate(input)).toEqual({ outcome: "no-go", code: "railway.template-contract.mutable-image" });
  });
});
