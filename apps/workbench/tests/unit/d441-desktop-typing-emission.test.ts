import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../");
const conversationSource = readFileSync(join(repoRoot, "src/components/conversation.tsx"), "utf8");
const runtimeSource = readFileSync(join(repoRoot, "src/adapters/nautilo-runtime.tsx"), "utf8");
const typingBusSource = readFileSync(join(repoRoot, "src/modes/rooms/typing/typing-bus.ts"), "utf8");
const composerTypingPingSource = readFileSync(
  join(repoRoot, "src/modes/rooms/typing/use-composer-typing-ping.ts"),
  "utf8",
);
const subthreadSurfaceSource = readFileSync(
  join(repoRoot, "src/modes/rooms/thread-drawer/surfaces/SubthreadSurface.tsx"),
  "utf8",
);

function sliceFunctionBody(name: string): string {
  const start = conversationSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = conversationSource.indexOf("\nfunction ", start + 1);
  return end > start ? conversationSource.slice(start, end) : conversationSource.slice(start);
}

describe("D441 desktop typing emission (source-contract audit)", () => {
  describe("composer call sites", () => {
    test("main Composer imports and calls the shared hook with active room and authenticated label", () => {
      expect(conversationSource).toMatch(
        /import \{ useComposerTypingPing \} from "\.\.\/modes\/rooms\/typing\/use-composer-typing-ping"/,
      );
      const composerBody = sliceFunctionBody("Composer");
      expect(composerBody).toMatch(/useComposerTypingPing\(\{[\s\S]*?rootRef: composerRootRef/);
      expect(composerBody).toMatch(/roomId: activeRoomId/);
      expect(composerBody).toMatch(/displayName: auth\.viewer\.label/);
      expect(composerBody).not.toMatch(/onInput=\{handleComposerInput\}/);
    });

    test("thread Composer uses that same hook with the child Room and authenticated label", () => {
      expect(subthreadSurfaceSource).toMatch(
        /import \{ useComposerTypingPing \} from "\.\.\/\.\.\/typing\/use-composer-typing-ping"/,
      );
      expect(subthreadSurfaceSource).toMatch(
        /useComposerTypingPing\(\{[\s\S]*?roomId: state\.roomId,[\s\S]*?displayName: auth\.viewer\.label/,
      );
    });

    test("ConversationBody keeps inbound typing wired through PresenceTypingStrip", () => {
      const body = sliceFunctionBody("ConversationBody");
      expect(body).toMatch(/useTypingOthers\(/);
      expect(body).toMatch(/<PresenceTypingStrip[\s\S]*?others=\{/);
    });
  });

  describe("use-composer-typing-ping.ts", () => {
    test("owns TYPING_PING_INTERVAL_MS rather than duplicating it in callers", () => {
      expect(composerTypingPingSource).toMatch(
        /import \{ TYPING_PING_INTERVAL_MS \} from "@nautilo\/types"/,
      );
    });

    test("uses a filtered capture-phase native listener, not React/bubble seams", () => {
      expect(composerTypingPingSource).toMatch(/document\.addEventListener\("input", onInput, true\)/);
      expect(composerTypingPingSource).toMatch(/document\.removeEventListener\("input", onInput, true\)/);
      expect(composerTypingPingSource).toMatch(/target instanceof Element/);
      expect(composerTypingPingSource).toMatch(/target\.closest<HTMLElement>\("\[data-nautilo-composer-input\]"\)/);
      expect(composerTypingPingSource).toMatch(/target\.closest<HTMLElement>\("\[contenteditable='true'\]"\)/);
      expect(composerTypingPingSource).toMatch(/root\.contains\(composerInput\)/);
      expect(composerTypingPingSource).toMatch(/composerInput\.contains\(contentEditable\)/);
      expect(composerTypingPingSource).toMatch(/emit\(\)/);
    });

    test("keeps a room-aware throttle so the first edit after A→B is immediately eligible", () => {
      expect(composerTypingPingSource).toMatch(
        /lastPingRef = useRef<\{ roomId: string \| null; lastPingAt: number \}>\(\{/,
      );
      expect(composerTypingPingSource).toMatch(
        /last\.roomId !== current\.roomId\s*\|\|\s*now - last\.lastPingAt >=\s*TYPING_PING_INTERVAL_MS/,
      );
      expect(composerTypingPingSource).toMatch(
        /lastPingRef\.current = \{ roomId: current\.roomId, lastPingAt: now \};\s*requestTypingPing\(\{ roomId: current\.roomId, displayName: current\.displayName \}\)/,
      );
      expect(composerTypingPingSource).toMatch(/contextRef\.current = \{ roomId, displayName \}/);
      expect(composerTypingPingSource).not.toMatch(/lastTypingPingAtRef = useRef\(0\)/);
    });

    test("sends only the safe roomId/displayName request payload", () => {
      const callSite = composerTypingPingSource.match(/requestTypingPing\(\{[\s\S]*?\}\)/);
      expect(callSite).not.toBeNull();
      expect(callSite![0]).not.toMatch(/userId/);
      expect(callSite![0]).not.toMatch(/sessionUserId/);
      expect(callSite![0]).toMatch(/roomId/);
      expect(callSite![0]).toMatch(/displayName/);
    });
  });

  describe("nautilo-runtime.tsx", () => {
    test("imports the outbound sender and committed-message signal from the typing-bus", () => {
      expect(runtimeSource).toMatch(
        /import \{ publishTypingCommitted, setTypingPingSender \} from "\.\.\/modes\/rooms\/typing\/typing-bus"/,
      );
    });

    test("the installed sender gates on wsStateRef.current open state", () => {
      expect(runtimeSource).toMatch(/wsStateRef\.current !== "open"/);
    });

    test("wsRef.current.send sends typing.ping only inside the open gate", () => {
      const installIdx = runtimeSource.indexOf("setTypingPingSender(");
      expect(installIdx).toBeGreaterThanOrEqual(0);
      const block = runtimeSource.slice(installIdx, installIdx + 600);
      expect(block).toMatch(/wsStateRef\.current !== "open"/);
      expect(block).toMatch(/wsRef\.current\.send\(\{/);
      expect(block).toMatch(/type: "typing\.ping"/);
      expect(block).toMatch(/roomId: payload\.roomId/);
      expect(block).toMatch(/displayName: payload\.displayName/);
      expect(block.indexOf('wsStateRef.current !== "open"')).toBeLessThan(block.indexOf("wsRef.current.send("));
    });

    test("clears the sender on unmount and keeps wsStateRef current", () => {
      const installIdx = runtimeSource.indexOf("setTypingPingSender(");
      expect(runtimeSource.slice(installIdx, installIdx + 800)).toMatch(/setTypingPingSender\(null\)/);
      expect(runtimeSource).toMatch(/const wsStateRef = useRef\(wsState\)/);
      expect(runtimeSource).toMatch(/wsStateRef\.current = wsState/);
    });
  });

  describe("typing-bus.ts", () => {
    test("exports the outbound sender API", () => {
      expect(typingBusSource).toMatch(/export function requestTypingPing\(/);
      expect(typingBusSource).toMatch(/export function setTypingPingSender\(/);
      expect(typingBusSource).toMatch(/export function clearTypingPingSender\(/);
    });

    test("the outbound payload literal contains type, roomId, displayName and NOT userId", () => {
      const payloadMatch = typingBusSource.match(/payload: TypingPingOutboundPayload = \{[\s\S]*?\}/);
      expect(payloadMatch).not.toBeNull();
      const payload = payloadMatch![0];
      expect(payload).toMatch(/type:/);
      expect(payload).toMatch(/roomId:/);
      expect(payload).toMatch(/displayName:/);
      expect(payload).not.toMatch(/userId/);
    });
  });
});
