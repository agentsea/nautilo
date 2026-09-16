import { defineConformanceTests } from "../../src/conformance/suite.ts";
import { matrix } from "../../src/testing/matrix.ts";

// Run the full conformance battery against every matrix row. Passing across
// all rows is the interchangeability contract for the swap axes.
for (const config of matrix) {
  defineConformanceTests(config);
}
