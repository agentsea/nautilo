import type {
  BrowserPageExtractionRoot,
  BrowserPageFailure,
  BrowserPageQuality,
} from "./browser-page-reader";

export interface BrowserPageReadFixture {
  name: string;
  /** Requested URL when navigation reaches a distinct final document URL. */
  requestedUrl?: string;
  url: string;
  html: string;
  expected: {
    root: BrowserPageExtractionRoot;
    quality: BrowserPageQuality;
    failure: BrowserPageFailure;
    retains?: string[];
    excludes?: string[];
    occursOnce?: string[];
    truncated?: boolean;
    requestedUrl?: string;
    finalUrl?: string;
  };
}

export const BROWSER_PAGE_READ_FIXTURES: BrowserPageReadFixture[] = [
  {
    name: "static article",
    url: "https://example.test/article",
    html: `<title>Solar Guide</title><article><h1>Solar guide</h1><p>The primary finding is that rooftop solar lowers peak demand.</p><p>It also improves local resilience.</p></article>`,
    expected: {
      root: "article",
      quality: "complete",
      failure: "none",
      retains: ["Solar guide", "lowers peak demand"],
    },
  },
  {
    name: "client-rendered content",
    url: "https://example.test/app",
    html: `<title>Live dashboard</title><main id="root"><h1>Live results</h1><p>Rendered client content is available after hydration.</p></main>`,
    expected: {
      root: "main",
      quality: "complete",
      failure: "none",
      retains: ["Live results", "after hydration"],
    },
  },
  {
    name: "documentation structure",
    url: "https://docs.example.test/setup",
    html: `<title>Setup</title><main><h1>Setup</h1><p>Install the package from the registry.</p><h2>Steps</h2><ol><li>Configure the token.</li><li>Run the service.</li></ol><table><tr><th>Option</th><th>Meaning</th></tr><tr><td>--safe</td><td>Read only</td></tr></table><p>See <a href="/reference">the reference</a>.</p></main>`,
    expected: {
      root: "main",
      quality: "complete",
      failure: "none",
      retains: ["Configure the token", "Option | Meaning", "the reference"],
    },
  },
  {
    name: "nested list continues to later content",
    url: "https://docs.example.test/nested-list",
    html: `<title>Nested lists</title><main><h1>Steps</h1><ul><li>Parent item <ul><li>Nested detail</li></ul></li><li>Second item</li></ul><p>Later content remains readable.</p></main>`,
    expected: {
      root: "main",
      quality: "complete",
      failure: "none",
      retains: [
        "Parent item",
        "Nested detail",
        "Second item",
        "Later content remains readable",
      ],
      occursOnce: ["Nested detail"],
    },
  },
  {
    name: "noisy layout",
    url: "https://news.example.test/story",
    html: `<title>Report</title><header>Home Subscribe</header><nav>Markets Politics Sport</nav><main><article><h1>Report</h1><p>Primary reporting explains the event in detail.</p></article></main><aside>Advertisement Subscribe now</aside><footer>Privacy Subscribe</footer>`,
    expected: {
      root: "article",
      quality: "complete",
      failure: "none",
      retains: ["Primary reporting"],
      excludes: ["Subscribe now", "Privacy"],
    },
  },
  {
    name: "noisy commerce product page",
    url: "https://shop.example.test/products/trail-jacket?color=forest",
    html: `<title>Trail Jacket | Example Outfitters</title><header><p>Free shipping over $50</p><a href="/account">Account</a></header><main><nav class="product-navigation"><a href="/">Home</a><a href="/sale">Sale</a></nav><section><h1>Trail Jacket</h1><p>A weatherproof shell built for three-season hikes.</p><p>$129.00</p><table><tr><th>Material</th><th>Fit</th></tr><tr><td>Recycled nylon</td><td>Regular</td></tr></table><p>Read the <a href="/care">care guide</a>.</p><form><label>Size <select><option>Medium</option></select></label><button>Add to basket</button></form></section><aside><h2>Recommended accessories</h2><p>Camp mug</p></aside><section class="advertisement"><p>Sponsored: buy travel insurance</p></section><section class="cookie-banner"><p>Cookie choices</p><button>Accept all</button></section><footer><p>Terms and returns</p></footer></main>`,
    expected: {
      root: "main",
      quality: "complete",
      failure: "none",
      retains: [
        "Trail Jacket",
        "weatherproof shell",
        "$129.00",
        "Material | Fit",
        "care guide",
      ],
      excludes: [
        "Home",
        "Add to basket",
        "Recommended accessories",
        "Sponsored",
        "Cookie choices",
        "Terms and returns",
      ],
    },
  },
  {
    name: "redirect reports final URL",
    requestedUrl: "https://go.example.test/guide?campaign=summer",
    url: "https://www.example.test/guides/trail-jacket?campaign=summer#details",
    html: `<title>Trail Jacket Guide</title><main><h1>Trail Jacket Guide</h1><p>The final destination explains how to choose the right layer.</p></main>`,
    expected: {
      root: "main",
      quality: "complete",
      failure: "none",
      retains: ["final destination", "right layer"],
      requestedUrl: "https://go.example.test/guide?campaign=summer",
      finalUrl: "https://www.example.test/guides/trail-jacket?campaign=summer",
    },
  },
  {
    name: "boilerplate-heavy body fallback",
    url: "https://example.test/boilerplate",
    html: `<html><head><title>Status</title></head><body><header>${"Subscribe for updates ".repeat(80)}</header><p>Brief useful status.</p><footer>${"Privacy and cookies ".repeat(80)}</footer></body></html>`,
    expected: {
      root: "body",
      quality: "noisy",
      failure: "none",
      retains: ["Brief useful status"],
      excludes: ["Subscribe for updates"],
    },
  },
  {
    name: "long output",
    url: "https://example.test/long",
    html: `<title>Long</title><article><h1>Long report</h1><p>${"important content ".repeat(4_000)}</p></article>`,
    expected: {
      root: "article",
      quality: "partial",
      failure: "none",
      retains: ["Long report"],
      truncated: true,
    },
  },
  {
    name: "iframe limitation",
    url: "https://example.test/embed",
    html: `<title>Embed</title><main><h1>Host page</h1><p>Only host text is available.</p><iframe src="https://frames.example.test/content"></iframe></main>`,
    expected: {
      root: "main",
      quality: "partial",
      failure: "iframe-limited",
      retains: ["Only host text"],
    },
  },
  {
    name: "virtual canvas",
    url: "https://example.test/canvas",
    html: `<title>Chart</title><main data-virtualized="true"><canvas></canvas></main>`,
    expected: {
      root: "main",
      quality: "visual-required",
      failure: "visual-required",
    },
  },
  {
    name: "empty error page",
    url: "https://example.test/error",
    html: `<html><head><title>Unavailable</title></head><body></body></html>`,
    expected: { root: "body", quality: "empty", failure: "empty-dom" },
  },
  {
    name: "challenge",
    url: "https://example.test/check",
    html: `<title>Just a moment... | Cloudflare</title><main><h1>Verify you are human</h1><p>Complete the CAPTCHA to continue.</p><div class="cf-turnstile"></div></main>`,
    expected: {
      root: "main",
      quality: "challenge",
      failure: "challenge",
      retains: ["Verify you are human"],
    },
  },
  {
    name: "article discussing challenge technology",
    url: "https://example.test/cloudflare-article",
    html: `<title>Cloudflare - Encyclopedia</title><article><h1>Cloudflare</h1><p>${"Cloudflare provides security services. Articles may discuss CAPTCHA, reCAPTCHA, hCaptcha, Turnstile, and how sites verify you are human without presenting a challenge. ".repeat(60)}</p></article>`,
    expected: {
      root: "article",
      quality: "partial",
      failure: "none",
      retains: ["Cloudflare provides security services"],
    },
  },
  {
    name: "ordinary page with dormant recaptcha provider script",
    url: "https://www.w3schools.test/html/html_iframe.asp",
    html: `<title>HTML Iframes</title><script src="https://www.google.com/recaptcha/api.js?render=explicit"></script><main><h1>HTML Iframes</h1><p>An HTML iframe is used to display a web page within a web page.</p><a href="/quiztest/quiztest.asp?qtest=HTML">Code Challenge</a></main>`,
    expected: {
      root: "main",
      quality: "complete",
      failure: "none",
      retains: ["HTML Iframes", "display a web page"],
    },
  },
  {
    name: "solved recaptcha demo retains captcha title and widget",
    url: "https://www.google.test/recaptcha/api2/demo",
    html: `<title>ReCAPTCHA demo</title><main><h1>ReCAPTCHA demo</h1><p>${"Readable evidence after verification. ".repeat(20)}</p><div class="g-recaptcha"></div><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe><textarea name="g-recaptcha-response">opaque-response-is-present</textarea></main>`,
    expected: {
      root: "main",
      quality: "partial",
      failure: "iframe-limited",
      retains: ["Readable evidence after verification"],
    },
  },
];
