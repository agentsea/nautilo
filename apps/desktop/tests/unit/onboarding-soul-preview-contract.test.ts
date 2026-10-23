import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

test("Desktop Soul generation remains a preview until the wizard saves the profile", () => {
  const source = readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8");
  const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  let handler: ts.Node | undefined;
  function find(node: ts.Node): void {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText(file) === "ipcMain.handle"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "onboarding:generate-soul") {
      handler = node.arguments[1];
    }
    ts.forEachChild(node, find);
  }
  find(file);
  if (!handler) throw new Error("Missing Desktop Soul generation handler");
  const requests: string[] = [];
  function inspect(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "fetch") {
      requests.push(node.arguments[0]?.getText(file) ?? "");
    }
    ts.forEachChild(node, inspect);
  }
  inspect(handler);
  expect(requests).toEqual(["`${serverUrl}/api/profile/generate-soul/stream`"]);
  expect(handler.getText(file)).toContain("return ipcOk({ soulFile: finalSoulFile })");
});
