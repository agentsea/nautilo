import { _electron as electron } from "playwright";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { docks, views, type LabBridge, type LabCommand } from "./contract.ts";
import { place } from "./geometry.ts";

declare global { interface Window { genieLab: LabBridge } }
const require = createRequire(import.meta.url);
const output = process.env["GENIE_LAB_SCREENSHOTS"];
if (output) await mkdir(output, { recursive: true });
const started = performance.now();
const app = await electron.launch({ executablePath: require("electron") as string, args: [join(dirname(fileURLToPath(import.meta.url)), "dist/main.cjs")] });
const page = await app.firstWindow();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
async function command(c: LabCommand) {
  await page.evaluate(value => window.genieLab.command(value), c);
  if ("value" in c) await page.waitForFunction(value => window.genieLab.getState().then(state => state[value.type] === value.value), c);
}
async function geometry() {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return { bounds: win.getBounds(), work: screen.getDisplayMatching(win.getBounds()).workArea };
  });
}
try {
  await page.locator(".companion").waitFor();
  console.log("First visible surface ms:", Math.round(performance.now() - started));
  let cases = 0;
  for (const view of views) for (const dock of docks) {
    await command({ type: "view", value: view });
    await command({ type: "dock", value: dock });
    const { bounds, work } = await geometry();
    assert.deepEqual(bounds, place(view, dock, bounds, work));
    cases++;
  }
  console.log("Native view/dock geometry cases:", cases);
  await command({ type: "view", value: "prompt" });
  const input = page.getByRole("textbox", { name: "Message draft" });
  await input.fill("A draft that survives collapse");
  await command({ type: "view", value: "orb" });
  assert.equal(await page.locator(".companion-identity, .companion-composer").count(), 0);
  await page.getByRole("button", { name: "Expand Genie", exact: true }).click();
  await page.locator(".companion-chat").waitFor();
  assert.equal(await input.inputValue(), "A draft that survives collapse");
  await input.press("Enter");
  await page.getByText("A draft that survives collapse", { exact: true }).waitFor();
  await command({ type: "view", value: "chat" });
  await page.getByText("A draft that survives collapse", { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
  await page.bringToFront();
  await page.keyboard.press("Meta+1");
  await page.locator(".companion-orb").waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.genieLab.getState().then(s => s.state === "listening"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".static-orb").waitFor();
  assert.equal(await page.locator("canvas").count(), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const sandboxed = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === "Tab").every(metric => metric.sandboxed));
  assert.equal(sandboxed, true);
  assert.equal(await page.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require), "undefined");
  assert.equal(await page.evaluate(async () => { try { await fetch("https://example.com"); return "allowed"; } catch { return "blocked"; } }), "blocked");
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: "microphone" as PermissionName })).state), "denied");
  // Switch each real rendering implementation and capture only the owned window.
  for (const visual of ["nautilo", "persona"] as const) {
    await command({ type: "visual", value: visual });
    await command({ type: "state", value: "listening" });
    await page.locator("canvas").waitFor();
    await page.waitForTimeout(1000);
    if (output) await page.screenshot({ path: join(output, `genie-lab-${visual}-orb.png`), omitBackground: true });
  }
  for (const view of ["prompt", "chat"] as const) {
    await command({ type: "view", value: view });
    if (output) await page.screenshot({ path: join(output, `genie-lab-${view}.png`), omitBackground: true });
  }
  await page.reload();
  await page.locator(".companion-chat").waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: shared drafts, text-free compact mode, keyboard, reduced motion, isolation, denied mic/network, both visuals, reload, one window.");
} finally { await app.close(); }
