import { expect, test } from "bun:test";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "../../src/native";
import { COMPUTER_USE_COMPATIBILITY_BASELINE, NATIVE_COMPATIBILITY_SCHEMAS } from "../../src/native-compatibility";
import { computeComputerUseJsonSchemaDigest } from "../../src/schema-digest";

test("retained native schemas preserve exact released digests and the pre-advertisement baseline", () => {
  for (const schema of NATIVE_COMPATIBILITY_SCHEMAS) {
    expect(String(computeComputerUseJsonSchemaDigest(schema.input, schema.result))).toBe(schema.descriptor.schemaDigest);
  }
  const retained = NATIVE_COMPATIBILITY_SCHEMAS.find(schema => schema.descriptor.contractId === "native.observe" && schema.descriptor.contractVersion === 11);
  expect(retained?.descriptor.schemaDigest).toBe("sha256:20f1b4469742bfb39a6d422aa4c7f01addfc75a5bbd86868cc23c5822a433ebe");
  expect(COMPUTER_USE_NATIVE_CONTRACTS.observe.contractVersion).toBe(13);
  const observeV12 = NATIVE_COMPATIBILITY_SCHEMAS.find(schema => schema.descriptor.contractId === "native.observe" && schema.descriptor.contractVersion === 12);
  expect(observeV12?.descriptor.schemaDigest).toBe("sha256:d6c91c8a5248c60ba14b57e36b85a866305970c1456c87188426cac39786d2c7");
  expect(COMPUTER_USE_NATIVE_CONTRACTS.observe.schemaDigest).not.toBe(observeV12?.descriptor.schemaDigest);
  expect(COMPUTER_USE_NATIVE_CONTRACTS.observe.schemaDigest).not.toBe(retained?.descriptor.schemaDigest);
  expect(COMPUTER_USE_COMPATIBILITY_BASELINE.find(contract => contract.contractId === "native.observe")?.contractVersion).toBe(9);
  const doV13 = NATIVE_COMPATIBILITY_SCHEMAS.find(schema => schema.descriptor.contractId === "native.do" && schema.descriptor.contractVersion === 13);
  expect(doV13?.descriptor.schemaDigest).toBe("sha256:02f27a6c99ca195b6af1d5b5edbe14f11d4471dbe1b499ce89c6ebe283587145");
  expect(COMPUTER_USE_NATIVE_CONTRACTS.do.contractVersion).toBe(14);
  expect(COMPUTER_USE_NATIVE_CONTRACTS.do.schemaDigest).not.toBe(doV13?.descriptor.schemaDigest);
});
