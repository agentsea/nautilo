import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type FormElement = {
  type?: string;
  id?: string;
  attributes?: {
    label?: string;
    options?: Array<{ label?: string; required?: boolean }>;
  };
  validations?: { required?: boolean };
};

type IssueForm = {
  name?: string;
  description?: string;
  body?: FormElement[];
};

const root = resolve(import.meta.dir, "../../..");
const bugPath = resolve(
  root,
  ".github/ISSUE_TEMPLATE/01-reproducible-defect.yml",
);
const proposalPath = resolve(
  root,
  ".github/ISSUE_TEMPLATE/02-problem-proposal.yml",
);
const configPath = resolve(root, ".github/ISSUE_TEMPLATE/config.yml");
const contributingPath = resolve(root, "CONTRIBUTING.md");
const implementationPrPath = resolve(root, ".github/pull_request_template.md");
const specPrPath = resolve(
  root,
  ".github/PULL_REQUEST_TEMPLATE/specification.md",
);
const specPath = resolve(root, "docs/contributing/spec-template.md");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function parseForm(path: string): IssueForm {
  return Bun.YAML.parse(read(path)) as IssueForm;
}

function ids(form: IssueForm): Set<string> {
  return new Set(
    (form.body ?? []).flatMap((element) => (element.id ? [element.id] : [])),
  );
}

describe("public contribution governance", () => {
  test("issue forms use valid top-level structure and unique field IDs", () => {
    for (const path of [bugPath, proposalPath]) {
      const form = parseForm(path);
      expect(form.name?.length).toBeGreaterThan(3);
      expect(form.description?.length).toBeGreaterThan(0);
      expect(form.body?.length).toBeGreaterThan(0);

      const fieldIds = (form.body ?? []).flatMap((element) =>
        element.id ? [element.id] : [],
      );
      expect(new Set(fieldIds).size).toBe(fieldIds.length);
      expect(fieldIds.every((id) => /^[a-zA-Z0-9_-]+$/.test(id))).toBe(true);
    }
  });

  test("the bounded defect form asks for reproducible, redacted evidence", () => {
    const form = parseForm(bugPath);
    const fieldIds = ids(form);

    for (const required of [
      "preflight",
      "version",
      "surface",
      "reproduction",
      "expected",
      "observed",
      "environment",
      "diagnostics",
      "recovery",
    ]) {
      expect(fieldIds.has(required)).toBe(true);
    }

    expect(read(bugPath)).toMatch(
      /remove secrets|redacted|Do not report vulnerabilities/i,
    );
  });

  test("integration and UI proposals cannot omit their shaping evidence lanes", () => {
    const form = parseForm(proposalPath);
    const fieldIds = ids(form);

    for (const required of [
      "public_problem",
      "outcome",
      "why_now",
      "current_state",
      "proposed_shape",
      "boundaries",
      "trust_and_failure",
      "interaction_evidence",
      "integration_contract",
      "completion_evidence",
      "stewardship",
    ]) {
      expect(fieldIds.has(required)).toBe(true);
    }

    const proposal = read(proposalPath);
    expect(proposal).toMatch(
      /Connection ownership.*secret lifecycle.*data boundary/is,
    );
    expect(proposal).toMatch(/journeys.*wireframes.*accessibility/is);
    expect(proposal).toMatch(/not authorize an implementation PR/i);
  });

  test("the chooser disables blank contributor issues and points only to canonical HTTPS help", () => {
    const config = Bun.YAML.parse(read(configPath)) as {
      blank_issues_enabled?: boolean;
      contact_links?: Array<{ url?: string }>;
    };

    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links?.length).toBe(2);
    for (const link of config.contact_links ?? []) {
      expect(link.url).toMatch(/^https:\/\/nautilo\.ai\//);
      expect(link.url).not.toMatch(/staging|preview|ondigitalocean|example/i);
    }
  });

  test("typo, integration, and UI fixture paths resolve to the intended gates", () => {
    const guidance = read(contributingPath);

    expect(guidance).toMatch(
      /Typo, broken link, isolated test correction[\s\S]*small ordinary pull request/,
    );
    expect(guidance).toMatch(
      /New direction, integration[\s\S]*problem proposal and spec-only pull request/,
    );
    expect(guidance).toMatch(
      /UI, UX, or mobile workflow[\s\S]*spec, and interaction evidence/,
    );
    expect(guidance).toMatch(
      /Large unsolicited implementation[\s\S]*line-by-line review/i,
    );
  });

  test("PR templates preserve the proposal-before-implementation contract", () => {
    const implementation = read(implementationPrPath);
    const specification = read(specPrPath);
    const spec = read(specPath);

    expect(implementation).toMatch(
      /Public problem:[\s\S]*Proposal issue:[\s\S]*Approved spec:/,
    );
    expect(implementation).toMatch(
      /Material deviations return to spec review/i,
    );
    expect(specification).toMatch(/contains no production implementation/i);
    expect(specification).toMatch(/Decision: `PENDING`/);
    expect(spec).toMatch(
      /PROPOSED[\s\S]*APPROVED FOR PROTOTYPE[\s\S]*APPROVED FOR IMPLEMENTATION/,
    );
  });

  test("public governance artifacts contain no internal planning identifiers", () => {
    const paths = [
      contributingPath,
      bugPath,
      proposalPath,
      configPath,
      implementationPrPath,
      specPrPath,
      specPath,
    ];
    const forbidden =
      /\b[DM]\d{3}\b|nautilo-docs|planning\/sprints|tasks\/ISSUE|private repositories/i;

    for (const path of paths) {
      expect(read(path)).not.toMatch(forbidden);
    }
  });
});
