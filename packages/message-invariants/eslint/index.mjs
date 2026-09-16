import { noNakedMessageConcat } from "./no-naked-message-concat.mjs";
import { noCheckpointHistoryRead } from "./no-checkpoint-history-read.mjs";

/** @type {import("eslint").ESLint.Plugin} */
export default {
  meta: { name: "nautilo-message-invariants" },
  rules: {
    "no-naked-message-concat": noNakedMessageConcat,
    "no-checkpoint-history-read": noCheckpointHistoryRead,
  },
};
