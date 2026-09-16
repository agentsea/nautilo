export interface RenderedPageExtractorFixture {
  name: string;
  html: string;
  expected: readonly string[];
  excluded?: readonly string[];
  title?: string;
  application?: boolean;
  accessibilityFallback?: boolean;
  iframeCount?: number;
}

/**
 * Local-only corpus for D504 1.4.1. Markers deliberately model meaningful page
 * facts and known chrome, allowing each reader to be scored without live pages.
 */
export const renderedPageExtractorFixtures: readonly RenderedPageExtractorFixture[] = [
  {
    name: "static article",
    html: `
      <html><head><title>Field Notes</title></head><body>
        <article><h1>Field Notes</h1>
          <p>STATIC_SENTINEL explains the observed result.</p>
          <p>Second paragraph has the conclusion.</p>
        </article>
      </body></html>`,
    expected: ["STATIC_SENTINEL", "conclusion"],
    title: "Field Notes",
  },
  {
    name: "noisy news page",
    html: `
      <html><head><title>Signal report</title></head><body>
        <nav>NOISE_NAV Subscribe breaking sports</nav>
        <aside>NOISE_AD Buy now</aside>
        <main><article><h1>Signal report</h1>
          <p>NEWS_SENTINEL The primary report has useful evidence.</p>
          <p>It ends with a supported conclusion.</p>
        </article></main>
        <footer>NOISE_FOOTER Privacy cookies</footer>
      </body></html>`,
    expected: ["NEWS_SENTINEL", "supported conclusion"],
    excluded: ["NOISE_NAV", "NOISE_AD", "NOISE_FOOTER"],
    title: "Signal report",
  },
  {
    name: "documentation structure",
    html: `
      <html><head><title>API guide</title></head><body><main>
        <h1>API guide</h1>
        <p>DOC_SENTINEL Read the <a href="/reference">reference</a>.</p>
        <h2>Example</h2><pre><code>const answer = 42;</code></pre>
        <table><tr><th>Key</th><th>Value</th></tr><tr><td>mode</td><td>safe</td></tr></table>
      </main></body></html>`,
    expected: [
      "DOC_SENTINEL",
      "[reference](https://example.test/reference)",
      "## Example",
      "const answer = 42",
      "| Key | Value |",
      "safe",
    ],
    title: "API guide",
  },
  {
    name: "commerce layout",
    html: `
      <html><head><title>Orbit keyboard</title></head><body>
        <header>NOISE_HEADER Shop Cart</header><nav>NOISE_NAV Keyboards</nav>
        <main><article><h1>Orbit keyboard</h1>
          <p>COMMERCE_SENTINEL A quiet mechanical keyboard.</p>
          <table><tr><th>Switch</th><th>Weight</th></tr><tr><td>Linear</td><td>760g</td></tr></table>
          <p>Read the <a href="/manual">manual</a>.</p>
          <form>NOISE_PURCHASE Add to cart <button>Buy</button></form>
        </article></main>
        <aside>NOISE_RECOMMENDATION Other products</aside><footer>NOISE_FOOTER Terms</footer>
      </body></html>`,
    expected: ["COMMERCE_SENTINEL", "| Switch | Weight |", "760g", "[manual](https://example.test/manual)"],
    excluded: ["NOISE_HEADER", "NOISE_NAV", "NOISE_PURCHASE", "NOISE_RECOMMENDATION", "NOISE_FOOTER"],
    title: "Orbit keyboard",
  },
  {
    name: "search application",
    html: `
      <html><head><title>Search</title></head><body>
        <main role="search"><h1>Search</h1><p>SEARCH_SENTINEL result one</p></main>
      </body></html>`,
    expected: ["SEARCH_SENTINEL"],
    application: true,
    accessibilityFallback: true,
    title: "Search",
  },
  {
    name: "iframe-heavy host page",
    html: `
      <html><head><title>Frame host</title></head><body>
        <main><p>FRAME_SENTINEL host content</p></main>
        <iframe src="https://example.test/frame"></iframe>
      </body></html>`,
    expected: ["FRAME_SENTINEL"],
    iframeCount: 2,
    accessibilityFallback: true,
    title: "Frame host",
  },
  {
    name: "unicode document",
    html: `
      <html><head><title>日本語</title></head><body><article><h1>日本語</h1>
        <p>UNICODE_SENTINEL café — 東京で研究します。</p>
      </article></body></html>`,
    expected: ["UNICODE_SENTINEL", "café", "東京"],
    title: "日本語",
  },
];

export const emptyRenderedPageFixture = "<html><body><script>ignored()</script></body></html>";
export const malformedRenderedPageFixture = "<main><h1>Malformed</h1><p>MALFORMED_SENTINEL survives <b>broken markup</main>";

/** Generated semantic fixture: 160,000+ characters with stable continuation sentinels. */
export const generatedLongRenderedPageFixture = `
  <html><head><title>Long corpus</title></head><body><article><h1>Long corpus</h1>
    <p>LONG_START_SENTINEL ${"alpha ".repeat(13_500)}</p>
    <p>LONG_MIDDLE_SENTINEL ${"beta ".repeat(13_500)}</p>
    <p>LONG_END_SENTINEL ${"gamma ".repeat(13_500)}</p>
  </article></body></html>`;
