import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tasks } from "./tasks";
import { jobs } from "./jobs";

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    graphThreadId: text("graph_thread_id").notNull(),
    status: text("status", {
      enum: ["running", "awaiting", "paused", "completed", "cancelled", "errored"],
    }).notNull().default("running"),
    modelId: text("model_id"),
    resultText: text("result_text"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [index("task_runs_task_idx").on(t.taskId, t.startedAt)],
);

export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
