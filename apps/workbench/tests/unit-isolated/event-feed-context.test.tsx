// Initialize the browser before React DOM chooses its event implementations.
import "../bun-dom-preload";
// Register the colocated mounted-provider suite with the isolated unit runner.
await import("../../src/event-feed/event-feed-context.test");
