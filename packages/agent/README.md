# @nautilo/agent

Everything that happens inside a single LangGraph graph run. This is the assistant's brain for one turn of conversation.

## What lives here

- **Graph definitions** — foreground conversation graph (`pre_model → agent → post_model → tools`), worker graph (long-running tasks), and review/learning graph (background memory extraction).
- **Prompt assembly** — system prompt construction, persona injection, model selection.
- **Tool implementations** — purpose-built tools (`manage_memory`, `search_memory`, `session_search`, `prove_it`, etc.), each persona-aware and policy-checked.
- **Memory store primitives** — read/write against Postgres + pgvector for durable memory, session transcripts, and working memory.
- **History processing** — pruning, windowing, and validating conversation history before model calls.

## Dependency rule

`@nautilo/agent` depends on `@nautilo/db`. It **never** depends on `@nautilo/runtime`. The runtime invokes the agent, not the other way around.
