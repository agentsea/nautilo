import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { D581_METADATA_WRITERS, REVIEWED_D581_SOURCE_ALARMS } from "../../baseline/reviewed-d581-research-continuity";
import { CURRENT_SOURCE_ALARM_REVIEWS, inspectSourceAlarmReviews } from "../../src/node/source-alarm-review";
import { discoverDatabaseWriterInventory } from "../../src/node/database-writer-inventory";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const root = resolve(import.meta.dir, "../../../..");
const load = (path: string) => readFile(resolve(root, path), "utf8");
const normalize = (value: string) => value.replace(/\s+/g, " ");

/** Read actual call arguments; only the exact reviewed conditional spread is accepted. */
function updates(source: string, symbol: string) {
  const ast = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === symbol);
  if (!fn?.body) throw new Error(`Missing reviewed writer ${symbol}`);
  const writes: Array<{ table: string; fields: string[]; values: string[] }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "set") {
      const update = node.expression.expression;
      if (!ts.isCallExpression(update) || !ts.isPropertyAccessExpression(update.expression) || update.expression.name.text !== "update") throw new Error("Unreviewed set receiver");
      const payload = node.arguments[0];
      if (!payload || !ts.isObjectLiteralExpression(payload)) throw new Error("Unreviewed indirect write payload");
      const fields: string[] = [], values: string[] = [];
      for (const property of payload.properties) {
        if (ts.isSpreadAssignment(property) && symbol === "resumeSecurityResearchRun"
          && normalize(property.expression.getText(ast)) === "(input.deliveryOnly ? {} : { lastError: null })") {
          fields.push("lastError"); values.push("clear lastError only outside delivery retry");
          continue;
        }
        if (!ts.isPropertyAssignment(property)) throw new Error("Unreviewed spread or shorthand write payload");
        fields.push(property.name.getText(ast)); values.push(normalize(property.initializer.getText(ast)));
      }
      writes.push({ table: update.arguments[0]!.getText(ast) === "taskRuns" ? "task_runs" : update.arguments[0]!.getText(ast), fields, values });
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return { writes, body: normalize(fn.body.getText(ast)) };
}

test("D581 writes only the fifteen reviewed metadata projections into existing plaintext column debt", async () => {
  expect(D581_METADATA_WRITERS).toHaveLength(15);
  const functions = new Map(D581_METADATA_WRITERS.map((writer) => [`${writer.path}#${writer.symbol}`, writer]));
  let observed = 0;
  for (const { path, symbol } of functions.values()) {
    const { writes, body } = updates(await load(path), symbol);
    expect(writes.map(({ table, fields }) => ({ table, fields }))).toEqual(
      D581_METADATA_WRITERS.filter((writer) => writer.path === path && writer.symbol === symbol).map(({ table, fields }) => ({ table, fields: [...fields] })),
    );
    observed += writes.length;
    if (symbol !== "holdSecurityResearchDesktop") expect(body).toContain('.for("update")');
    for (const write of writes) for (const field of write.fields) {
      const column = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      expect(BASELINE_REGISTRY.debt.some((debt) => debt.locator === `public.${write.table}.${column}`)).toBe(true);
    }
    expect(writes.flatMap((write) => write.fields)).not.toContain("resultText");
    if (symbol === "holdSecurityResearchDesktop") {
      expect(body).toContain('eq(tasks.id, taskId), eq(tasks.status, "paused"), eq(tasks.lastError, DESKTOP_WAIT_TEXT)');
    } else if (symbol === "recoverSecurityResearchContextFailure") {
      expect(body).toContain("current.ownerId !== task.ownerId");
      expect(body).toContain("run.id !== eligible.id");
      expect(body).toContain("run.graphThreadId !== eligible.graphThreadId || run.modelId !== eligible.modelId");
    } else if (symbol === "resumeReconnectedSecurityResearch") {
      expect(body).toContain("await assertSecurityResearchResumeBinding");
      expect(body).toContain("userId: task.ownerId");
      expect(body).toContain('binding.status !== "available"');
      expect(body).toContain('savedRun.lastError !== SECURITY_RESEARCH_DESKTOP_WAIT');
    } else if (symbol !== "transitionTaskLifecyclePaused") {
      expect(body).toContain("task.ownerId !== input.ownerId");
      expect(body).toContain("eq(taskRuns.id, input.taskRunId)");
      expect(body).toContain("eq(taskRuns.taskId, task.id)");
    } else {
      expect(body).toContain('TERMINAL_TASK_STATUSES.includes');
      expect(body).toContain('latest?.status === "running" || latest?.status === "awaiting"');
      expect(body).toContain('eq(taskRuns.taskId, taskId)');
    }
  }
  expect(observed).toBe(15);
  const writers = await discoverDatabaseWriterInventory(root, { tasks: "public.tasks", taskRuns: "public.task_runs" });
  const scoped = writers.filter((writer) => writer.path === "packages/runtime/src/tasks/security-report-recovery.ts"
    || writer.path === "packages/db/src/queries/tasks.ts" && writer.symbol === "transitionTaskLifecyclePaused");
  expect(scoped.map((writer) => writer.locator).sort()).toEqual(D581_METADATA_WRITERS.map((writer) =>
    `${writer.path}#${writer.symbol}:update:public.${writer.table}:1`).sort());

});


test("D581 write review rejects unknown spreads and additional fields remain visible", () => {
  const source = (payload: string) => `function resumeSecurityResearchRun() { tx.update(taskRuns).set(${payload}); }`;
  expect(() => updates(source('{ status: "running", ...input }'), "resumeSecurityResearchRun")).toThrow("Unreviewed spread");
  expect(() => updates(source('{ status: "running", ...(input.deliveryOnly ? {} : { lastError: input.error }) }'), "resumeSecurityResearchRun")).toThrow("Unreviewed spread");
  expect(updates(source('{ status: "running", resultText: input.result }'), "resumeSecurityResearchRun").writes[0]!.fields).toContain("resultText");
});

test("D581 retained error fields carry fixed control state, never graph results or provider exceptions", async () => {
  const source = await load("packages/runtime/src/tasks/security-report-recovery.ts");
  expect(source).toContain('const SECURITY_REPORT_DELIVERY_PAUSED_TEXT = "Investigation saved; Resume retries report delivery."');
  expect(source).toContain('SECURITY_REPORT_DELIVERY_PENDING = "SECURITY_REPORT_DELIVERY_PENDING"');
  const parked = updates(source, "parkSecurityReportDelivery").writes;
  expect(parked[0]!.values).toEqual(['"paused"', "SECURITY_REPORT_DELIVERY_PENDING"]);
  expect(parked[1]!.values).toEqual(['"paused"', "SECURITY_REPORT_DELIVERY_PAUSED_TEXT", "null", "null", "new Date()"]);
  expect(updates(source, "pauseSecurityResearchResume").writes[0]!.values).toEqual([
    '"paused"', "null", "null", "new Date()",
    '`Investigation saved. Reconnect the same Desktop and authorized folder, then Resume (${input.reason}).`',
  ]);
  const dispatch = await load("packages/runtime/src/tasks/dispatch-task-run.ts");
  expect(dispatch).toContain("fireLockId: task.fireLockId, reason: restoredResearchBinding.status");
  expect(dispatch.match(/\bpauseSecurityResearchResume\(/g)).toHaveLength(1);
  const resume = updates(source, "resumeSecurityResearchRun");
  expect(resume.body).toContain("run.graphThreadId !== input.threadId || run.modelId !== input.modelId");
  expect(resume.body).toContain("input.deliveryOnly && !isSecurityReportDeliveryRetry(run)");
  expect(resume.writes[0]!.values).toEqual(['"running"', "clear lastError only outside delivery retry"]);
  expect(resume.writes[1]!.values).toEqual(['"running"', "null", "new Date()"]);
});

test("D581 reviews only the new recovery log while keeping all actual logger calls visible", async () => {
  const source = await load("packages/agent/src/utils/chat-model-invocation.ts");
  const ast = ts.createSourceFile("invocation.ts", source, ts.ScriptTarget.Latest, true);
  const expressions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "log") {
      const argument = node.arguments[0];
      if (argument && ts.isTemplateExpression(argument) && argument.head.text.includes("Reduced research context")) {
        expressions.push(...argument.templateSpans.map((span) => span.expression.getText(ast)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(expressions).toEqual(["currentModelId", "source"]);
  expect(source).toContain('source: "preflight" | "provider";');
  expect(source).toContain("const modelConfig = getModelById(currentModelId)");
  const scan = await scanSourceAlarms({ repoRoot: root, scanRoots: ["packages/agent/src/utils"] });
  const alarms = scan.alarms.filter((alarm) => alarm.path === "packages/agent/src/utils/chat-model-invocation.ts");
  expect(alarms).toHaveLength(17);
  expect(scan.errors).toEqual([]);
  expect(REVIEWED_D581_SOURCE_ALARMS).toHaveLength(1);
  expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(REVIEWED_D581_SOURCE_ALARMS[0]!);
  expect(inspectSourceAlarmReviews(alarms).errors.filter((error) => error.includes("chat-model-invocation.ts"))).toEqual([]);
});
