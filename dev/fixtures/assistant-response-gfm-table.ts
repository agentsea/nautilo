/** One cross-client corpus for D531 parser, streaming, and native layout proof. */
export const ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE = `Here is the comparison before the table.

| Left item | Center status | Right count | Rich content | Optional |
| :--- | :---: | ---: | --- | --- |
| [Nautilo](https://nautilo.ai) | \`ready\` | 42 | A deliberately wide cell whose text must remain readable and reachable without widening the surrounding transcript. | |
| Plain value | centered | 7 | Short note | present |

The prose after the table remains ordinary Markdown.

- Closing list item with **emphasis**.`;

export const ASSISTANT_RESPONSE_GFM_TABLE_PARTIAL =
  ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE.slice(
    0,
    ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE.indexOf("\n| :---"),
  );
