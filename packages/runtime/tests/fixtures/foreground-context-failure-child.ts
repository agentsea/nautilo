import { buildTranscriptContext } from "../../src/context/build-transcript-context.ts";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";

const kind = process.argv[2];
const failure = new StrictShadowEnforcementError({
  boundaryId: "conversation.read.foreground_journal",
  family: "record",
  operation: "read_repair",
  actorClass: "agent",
  state: "failed",
  reason: "integrity_failure",
  retryable: false,
  policyRevision: 2,
});
let drained = false;
const slow = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  drained = true;
};
const outcome = await buildTranscriptContext({
  scope: { kind: "room", roomId: "fixture-room", ownerId: "fixture-human" },
}, {
  readRoomTranscript: async () => {
    if (kind === "transcript") throw failure;
    await slow();
    return [];
  },
  readSubagentTranscript: () => Promise.resolve([]),
  readRoomJournal: async () => {
    if (kind === "journal") throw failure;
    if (kind === "transcript") await slow();
    return { rollup: null, events: [] };
  },
  ...(kind === "policy" ? {
    readRoomContextPolicy: () => Promise.reject(failure),
  } : {}),
}).then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({
  originalError: error === failure,
  drained,
}));
console.log(JSON.stringify(outcome));
process.exit("originalError" in outcome && outcome.originalError && outcome.drained ? 0 : 1);
