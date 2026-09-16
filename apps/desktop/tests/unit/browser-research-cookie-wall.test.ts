import { describe, expect, test } from "bun:test";
import {
  clearRoutineCookieWall,
  clickRoutineCookieControlByLabel,
  looksLikeRoutineCookieWallText,
  selectRoutineCookieControl,
} from "../../electron/browser-research-cookie-wall";

const snapshot = (...controls: string[]) => [
  '- dialog "We use cookies and tracking to manage your privacy choices"',
  ...controls.map((control, index) => `  - button "${control}" [ref=e${index + 1}]`),
].join("\n");

describe("browser research routine cookie walls", () => {
  test("uses the locked least-consent priority, independent of DOM order", () => {
    expect(selectRoutineCookieControl(snapshot("Accept all", "Reject optional", "Continue without accepting")))
      .toMatchObject({ label: "Continue without accepting", ref: "e3", action: "continue_without_accepting" });
    expect(selectRoutineCookieControl(snapshot("Accept all", "Necessary cookies only")))
      .toMatchObject({ label: "Necessary cookies only", ref: "e2", action: "necessary_only" });
    expect(selectRoutineCookieControl(snapshot("Accept cookies", "Reject cookies")))
      .toMatchObject({ label: "Reject cookies", ref: "e2", action: "reject_optional" });
    expect(selectRoutineCookieControl(snapshot("Accept all", "Close")))
      .toMatchObject({ label: "Close", ref: "e2", action: "dismiss" });
    expect(selectRoutineCookieControl(snapshot("Accept all")))
      .toMatchObject({ label: "Accept all", ref: "e1", action: "minimum_acceptance" });
    expect(selectRoutineCookieControl(snapshot("Allow cookies on this device", "Proceed without cookie consent")))
      .toMatchObject({ label: "Proceed without cookie consent", ref: "e2", action: "continue_without_accepting" });
    expect(selectRoutineCookieControl(snapshot("Accept and continue", "Please decline optional analytics cookies")))
      .toMatchObject({ label: "Please decline optional analytics cookies", ref: "e2", action: "reject_optional" });
  });

  test("recognizes a bounded common CMP corpus while preserving the same priority", () => {
    for (const [label, action] of [
      ["Continuar sin aceptar", "continue_without_accepting"],
      ["Tout refuser", "reject_optional"],
      ["Alle Cookies ablehnen", "reject_optional"],
      ["Aceitar apenas cookies necessários", "necessary_only"],
      ["Accetta solo i cookie necessari", "necessary_only"],
      ["Schließen", "dismiss"],
      ["Accepter tous les cookies", "minimum_acceptance"],
    ] as const) {
      expect(selectRoutineCookieControl(snapshot(label))).toMatchObject({ label, action });
    }
  });

  test("does not turn legal, age, account, or purchase consent into routine clicking", () => {
    expect(selectRoutineCookieControl('- dialog "Terms and contract"\n  - button "Accept all terms" [ref=e1]')).toBeUndefined();
    expect(selectRoutineCookieControl('- dialog "Confirm your age"\n  - button "I agree" [ref=e1]')).toBeUndefined();
    expect(selectRoutineCookieControl('- main "Article"\n  - button "Close" [ref=e1]')).toBeUndefined();
    expect(selectRoutineCookieControl('- dialog "Cookie preferences — Verify you are human"\n  - button "Reject all" [ref=e1]')).toBeUndefined();
    expect(looksLikeRoutineCookieWallText("Cookie consent CAPTCHA verification")).toBe(false);
    expect(selectRoutineCookieControl('- dialog "Cookie preferences and terms"\n  - button "Reject all" [ref=e1]'))
      .toMatchObject({ label: "Reject all", action: "reject_optional" });
  });

  test("ignores hidden and disabled controls, and never turns unrelated close buttons into consent", () => {
    const controls = [
      '- dialog "Cookie preferences"',
      '  - button "Reject all" [disabled] [ref=e1]',
      '  - button "Reject optional" [aria-disabled="true"] [ref=e2]',
      '  - button "Necessary cookies only" [hidden] [ref=e3]',
      '  - button "Accept all" [ref=e4]',
    ].join("\n");
    expect(selectRoutineCookieControl(controls)).toMatchObject({ label: "Accept all", ref: "e4", action: "minimum_acceptance" });
    expect(selectRoutineCookieControl('- dialog "Cookie preferences"\n  - button "Close advertisement" [ref=e1]')).toBeUndefined();
    expect(selectRoutineCookieControl('- dialog "Cookie preferences"\n  - button "Accept all" [ref=e1]\n- button "Close" [ref=e2]'))
      .toMatchObject({ label: "Accept all", ref: "e1", action: "minimum_acceptance" });
  });

  test("captures one fixed snapshot and clicks only the selected agent-browser ref", async () => {
    const calls: string[][] = [];
    const result = await clearRoutineCookieWall({
      bin: "/agent-browser",
      cfgPath: "/fixed-config.json",
      session: "fixed-session",
      timeoutMs: 1_000,
      maxBuffer: 1_000_000,
    }, async (_bin, argv) => {
      calls.push(argv);
      if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: snapshot("Accept all", "Reject all"), refs: { e1: {}, e2: {} } } }) };
      return { stdout: JSON.stringify({ success: true }) };
    });

    expect(result).toEqual({ observed: true, acted: true, action: "reject_optional" });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["--config", "/fixed-config.json", "--provider", "nautilo-browser", "--session", "fixed-session", "--json", "snapshot", "--urls"]);
    expect(calls[1]?.slice(-2)).toEqual(["click", "@e2"]);
    expect(calls[2]?.slice(-2)).toEqual(["wait", "750"]);
  });

  test("lets Genie select an unfamiliar exact label only inside a consent surface", async () => {
    const calls: string[][] = [];
    const result = await clickRoutineCookieControlByLabel({
      bin: "/agent-browser", cfgPath: "/fixed-config.json", session: "fixed-session",
      timeoutMs: 1_000, maxBuffer: 1_000_000,
    }, "Privacy, but make it minimal", async (_bin, argv) => {
      calls.push(argv);
      if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- region "Cookie consent" [ref=e1]\n  - button "Privacy, but make it minimal" [ref=e2]\n- button "Privacy, but make it minimal" [ref=e3]' } }) };
      return { stdout: JSON.stringify({ success: true }) };
    });
    expect(result).toEqual({ acted: true });
    expect(calls.find((argv) => argv.includes("click"))?.slice(-2)).toEqual(["click", "@e2"]);
  });

  test("replays a uniquely close consent label when fresh-page wording drifts", async () => {
    const calls: string[][] = [];
    const result = await clickRoutineCookieControlByLabel({
      bin: "/agent-browser", cfgPath: "/fixed-config.json", session: "fixed-session",
      timeoutMs: 1_000, maxBuffer: 1_000_000,
    }, "Reject cookies", async (_bin, argv) => {
      calls.push(argv);
      if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- region "Cookie consent" [ref=e1]\n  - button "Reject optional cookies" [ref=e2]\n- button "Reject optional cookies" [ref=e3]' } }) };
      return { stdout: JSON.stringify({ success: true }) };
    });
    expect(result).toEqual({ acted: true });
    expect(calls.find((argv) => argv.includes("click"))?.slice(-2)).toEqual(["click", "@e2"]);
  });

  test("refuses ambiguous close consent labels instead of guessing", async () => {
    const calls: string[][] = [];
    const result = await clickRoutineCookieControlByLabel({
      bin: "/agent-browser", cfgPath: "/fixed-config.json", session: "fixed-session",
      timeoutMs: 1_000, maxBuffer: 1_000_000,
    }, "Reject cookies", async (_bin, argv) => {
      calls.push(argv);
      if (argv.includes("snapshot")) return { stdout: JSON.stringify({ success: true, data: { snapshot: '- region "Cookie consent" [ref=e1]\n  - button "Reject optional cookies" [ref=e2]\n  - button "Reject analytics cookies" [ref=e3]' } }) };
      return { stdout: JSON.stringify({ success: true }) };
    });
    expect(result).toEqual({ acted: false });
    expect(calls).toHaveLength(1);
  });
});
