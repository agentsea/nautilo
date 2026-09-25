import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { CompanionAudioControls } from "../../src/companion/companion-audio-controls";
import { CompanionSendButton } from "../../src/companion/companion-send-button";
import type { CompanionSnapshot } from "../../../desktop/electron/companion-contract";

const prior = Object.fromEntries(["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
let host: HTMLDivElement;
let root: Root;
const mic = mock(() => {});
const send = mock(() => {});
beforeAll(() => {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  mic.mockClear(); send.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
afterAll(() => {
  for (const [key, descriptor] of Object.entries(prior)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function render(capture: CompanionSnapshot["capture"], hasContent = false, sending = false) {
  act(() => root.render(<><CompanionAudioControls capture={capture} sound={true} onMic={mic} onSound={() => {}} />
    <CompanionSendButton capture={capture} sending={sending} disabled={capture !== "idle" || sending}
      hasContent={hasContent} onSend={send} /></>));
  return host.querySelector<HTMLButtonElement>(".companion-send")!;
}
test("Send stays separate from the mic even with an empty or typed draft", () => {
  let button = render("idle");
  expect(button.getAttribute("aria-label")).toBe("Send to Genie");
  expect(button.disabled).toBe(true);
  const toggle = host.querySelector<HTMLButtonElement>(".companion-mic-toggle")!;
  act(() => toggle.click()); expect(mic).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  button = render("idle", true);
  expect(button.disabled).toBe(false);
  expect(host.querySelector(".companion-mic-toggle")).not.toBeNull();
  act(() => button.click()); expect(send).toHaveBeenCalledTimes(1);
});
test("mic off is available while recording and transcription never claims Sending", () => {
  let button = render("listening");
  expect(button.disabled).toBe(true);
  const toggle = host.querySelector<HTMLButtonElement>(".companion-mic-toggle")!;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  act(() => toggle.click()); expect(mic).toHaveBeenCalledTimes(1);
  button = render("transcribing");
  expect(button.textContent).toBe("Transcribing…"); expect(button.disabled).toBe(true);
  expect(host.querySelector(".companion-mic-toggle")?.getAttribute("aria-pressed")).toBe("false");
  button = render("idle", true, true);
  expect(button.textContent).toBe("Sending…"); expect(button.disabled).toBe(true);
});
