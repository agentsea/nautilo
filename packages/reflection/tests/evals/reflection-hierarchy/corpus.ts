import { CANDIDATE_POLICY_V1 } from "../../../src/organizer/candidate-policy";
import { REFLECTION_HIERARCHY_CORPUS_SCHEMA } from "./types";

export const REFLECTION_HIERARCHY_CORPUS = Object.freeze({
  schema: REFLECTION_HIERARCHY_CORPUS_SCHEMA,
  version: "2026-08-21.1",
  policyVersion: CANDIDATE_POLICY_V1.version,
  promptVersion: "hierarchy-organizer-v1",
  scenarios: Object.freeze([
    ["postgres-neon-decision", "PostgreSQL and Neon arguments retain their final decision."],
    ["valuable-independent-leaf", "A useful leaf remains searchable without a forced parent."],
    ["emergent-depth", "Recursive synthesis creates useful depth without predefined levels."],
    ["cross-room-exact-intersection", "Cross-Room publication uses the exact audience intersection."],
    ["preserved-disagreement", "Conflicting evidence is retained without false consensus."],
    ["single-current-parent", "A Record cannot acquire a second current semantic parent."],
    ["immutable-correction", "Corrected evidence creates immutable successor history."],
    ["partial-dependency-loss", "Remaining evidence supports a truthful replacement."],
    ["total-dependency-loss", "All-support loss sunsets without replacement."],
    ["scheduled-old-record", "Scheduled paging considers unchanged retained Records."],
    ["no-change-convergence", "Repeated unchanged work creates no new graph state."],
    ["search-redundancy", "One utility order suppresses redundant ancestor/descendant hits."],
    ["deep-evidence-retrieval", "Budgeted continuation traces a deep result to leaves."],
    ["multi-attached-memory", "An authored Memory leaf unions valid attachment audiences."],
    ["invocation-namespace-authority", "Requester-private access cannot enter shared-Room semantics."],
  ] as const),
});
