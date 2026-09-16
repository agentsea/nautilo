# @nautilo/message-invariants — tool_use ↔ tool_result invariant enforcement

**Invariant:** Every `tool_use` block in the conversation history must have exactly one corresponding `tool_result` (`ToolMessage`) for its `tool_call_id` — matching what Anthropic, OpenAI, and LangGraph consumers require.

This package centralizes enforcement of that invariant across nautilo. Call sites wire thin imports at architectural seams; the logic lives here so review answers “is this seam wired?” rather than “where did we duplicate dedupe?”

## Six layers (defense in depth)

| Layer | Package module | Wired at | When enforced | What it catches |
| --- | --- | --- | --- | --- |
| 1 — Stable ToolMessage IDs | `src/stable-ids.ts` | `packages/agent/src/nodes/tools.ts` | Creation time | Duplicate `ToolMessage`s on paths that go through LangGraph’s id-based `messagesStateReducer` |
| 2 — Canonical merge + ESLint | `src/merge.ts` + `eslint/` | Fork splice + root ESLint | Merge / review time | Naked `BaseMessage[]` concat that can duplicate tool results |
| 3 — Validation safety net | `src/validate.ts` | `pre-model.ts`, `history-manager.ts` | Request time | Duplicates from transforms that bypass the reducer |
| 4 — Dev-mode assertions | `src/assert.ts` | `pre-model.ts`, merge sites | Dev / test | Regressions across layers |
| 5 — Integration tests | Package + agent tests | CI | CI time | End-to-end replay of approval / fork paths |
| 6 — DB repair (contingency) | `src/repair.ts` | Admin CLI | Operator time | Legacy corrupted checkpoints |

## Dependencies

The package intentionally avoids depending on nautilo agent, runtime, or trust. It uses **`@langchain/core`** (messages types and `ToolMessage`) as its only runtime dependency so agent and future runtime callers can share helpers without deepening package cycles.

## Implementation

The package exports stable IDs, canonical merge, validation, and development
assertions from `src/index.ts`. The table above describes the intended defense
layers; verify call-site wiring and tests before treating a layer as enforced.
The contingency repair module is not present in this package.

## Why a standalone package

Cross-cutting seams (agent tools node, runtime fork splice, `pre_model`, ESLint) each get a one-line import. Enforcement logic stays in one place so future paths (subagents, multi-agent handoff, LangGraph upgrades) cannot silently reintroduce the invariant bug in a copy-pasted helper.
