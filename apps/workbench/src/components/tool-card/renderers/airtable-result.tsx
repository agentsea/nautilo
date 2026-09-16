import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { DataGrid, type Column, type SortColumn } from "react-data-grid";
import type { ConnectedAppToolReceipt } from "@nautilo/types";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { apiClient } from "../../../lib/api";
import { desktopAPI } from "../../../lib/desktop";
import { sendOrdinaryRoomMessage } from "../../../lib/ordinary-room-message";
import { parseConnectedAppReceipt } from "./connected-app-receipt";
import type { ToolRenderer, ToolRendererProps } from "./types";

type AirtableRecord = Readonly<{
  id: string;
  fields: Readonly<Record<string, unknown>>;
  createdTime?: string;
  commentCount?: number;
}>;

type AirtableBase = Readonly<{
  id: string;
  name: string;
  permissionLevel?: string;
}>;

type AirtableField = Readonly<{
  id: string;
  name: string;
  type?: string;
  description?: string;
  options?: unknown;
}>;

type AirtableTable = Readonly<{
  id: string;
  name: string;
  description?: string;
  fields: readonly AirtableField[];
  views?: readonly Readonly<Record<string, unknown>>[];
}>;

const ACTION_LABELS: Readonly<Record<string, string>> = {
  "airtable.create_base": "Created base",
  "airtable.create_field": "Created field",
  "airtable.create_records": "Created records",
  "airtable.create_table": "Created table",
  "airtable.delete_base": "Deleted base",
  "airtable.delete_records": "Deleted records",
  "airtable.get_base_collaborators": "Base access",
  "airtable.get_base_schema": "Base schema",
  "airtable.get_record": "Airtable record",
  "airtable.list_bases": "Airtable bases",
  "airtable.list_records": "Airtable records",
  "airtable.update_field": "Updated field",
  "airtable.update_records": "Updated records",
  "airtable.update_table": "Updated table",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isAirtableId(value: unknown, prefix: "app" | "tbl" | "rec"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}[A-Za-z0-9]+$`, "u").test(value);
}

function parseAirtableReceipt(
  toolName: string | undefined,
  resultText: string | undefined,
): ConnectedAppToolReceipt | null {
  if (!toolName?.startsWith("airtable_")) return null;
  const receipt = parseConnectedAppReceipt(toolName, resultText);
  return receipt?.providerId === "airtable" ? receipt : null;
}

function readableValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Airtable's AI/computed fields use this provider-internal error object when
  // their source field is blank. It is an empty cell state, not a failed
  // connector invocation, so do not make the whole card look broken.
  if (isRecord(value)
    && value["state"] === "error"
    && value["errorType"] === "emptyDependency"
    && value["value"] === null) {
    return "Waiting for source value";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unrenderable value";
  }
}

function recordsFrom(result: unknown): readonly AirtableRecord[] {
  if (!isRecord(result)) return [];
  const raw = Array.isArray(result["records"])
    ? result["records"]
    : isRecord(result["record"])
      ? [result["record"]]
      : [];
  return raw.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate["id"] !== "string" || !isRecord(candidate["fields"])) {
      return [];
    }
    return [{
      id: candidate["id"],
      fields: candidate["fields"],
      ...(typeof candidate["createdTime"] === "string" ? { createdTime: candidate["createdTime"] } : {}),
      ...(typeof candidate["commentCount"] === "number" ? { commentCount: candidate["commentCount"] } : {}),
    }];
  });
}

function basesFrom(result: unknown): readonly AirtableBase[] {
  if (!isRecord(result) || !Array.isArray(result["bases"])) return [];
  return result["bases"].flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate["id"] !== "string" || typeof candidate["name"] !== "string") {
      return [];
    }
    return [{
      id: candidate["id"],
      name: candidate["name"],
      ...(typeof candidate["permissionLevel"] === "string"
        ? { permissionLevel: candidate["permissionLevel"] }
        : {}),
    }];
  });
}

function fieldsFrom(value: unknown): readonly AirtableField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate["id"] !== "string" || typeof candidate["name"] !== "string") {
      return [];
    }
    return [{
      id: candidate["id"],
      name: candidate["name"],
      ...(typeof candidate["type"] === "string" ? { type: candidate["type"] } : {}),
      ...(typeof candidate["description"] === "string" ? { description: candidate["description"] } : {}),
      ...(candidate["options"] !== undefined ? { options: candidate["options"] } : {}),
    }];
  });
}

function tableFrom(value: unknown): AirtableTable | null {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string") return null;
  return {
    id: value["id"],
    name: value["name"],
    ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
    fields: fieldsFrom(value["fields"]),
    ...(Array.isArray(value["views"])
      ? { views: value["views"].filter(isRecord) }
      : {}),
  };
}

function tablesFrom(result: unknown): readonly AirtableTable[] {
  if (!isRecord(result)) return [];
  const candidates = Array.isArray(result["tables"])
    ? result["tables"]
    : typeof result["id"] === "string" && typeof result["name"] === "string" && Array.isArray(result["fields"])
      ? [result]
      : [];
  return candidates.flatMap((candidate) => {
    const table = tableFrom(candidate);
    return table ? [table] : [];
  });
}

function airtableUrl(args: Record<string, unknown>, result?: unknown): string | null {
  const resultRecord = isRecord(result) ? result : null;
  const nestedBase = resultRecord && isRecord(resultRecord["base"])
    ? resultRecord["base"]
    : null;
  const baseId = isAirtableId(args["baseId"], "app")
    ? args["baseId"]
    : isAirtableId(resultRecord?.["id"], "app")
      ? resultRecord["id"]
      : isAirtableId(nestedBase?.["id"], "app")
        ? nestedBase["id"]
        : null;
  if (!baseId) return null;
  const tableValue = args["tableIdOrName"] ?? args["tableId"];
  const tableId = isAirtableId(tableValue, "tbl") ? tableValue : null;
  const nestedRecord = resultRecord && isRecord(resultRecord["record"])
    ? resultRecord["record"]
    : null;
  const recordValue = args["recordId"] ?? nestedRecord?.["id"];
  const recordId = isAirtableId(recordValue, "rec") ? recordValue : null;
  return `https://airtable.com/${baseId}${tableId ? `/${tableId}` : ""}${tableId && recordId ? `/${recordId}` : ""}`;
}

async function openExternal(url: string): Promise<void> {
  if (desktopAPI?.browserControl?.openExternal) {
    await desktopAPI.browserControl.openExternal({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function OpenInAirtableButton({ url }: { url: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="rounded border border-border px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-foreground/5"
        onClick={() => {
          setFailed(false);
          void openExternal(url).catch(() => setFailed(true));
        }}
      >
        Open in Airtable
      </button>
      {failed ? <p role="status" className="mt-1 text-xs text-tool-error">Airtable could not be opened.</p> : null}
    </div>
  );
}

function ReceiptFooter({ receipt }: { receipt: ConnectedAppToolReceipt }): ReactElement {
  return (
    <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-[0.65rem] text-foreground-dim">
      <span>Execution receipt: {receipt.executionId}</span>
      {receipt.effect === "write" ? (
        receipt.reconciliation?.status === "confirmed" ? (
          <span className="text-tool-success">Reconciled: {receipt.reconciliation.executionId}</span>
        ) : receipt.reconciliation?.status === "unconfirmed" ? (
          <span className="text-tool-error">Reconciliation unconfirmed — do not retry</span>
        ) : (
          <span>Write completed; no reconciliation receipt was required.</span>
        )
      ) : null}
    </footer>
  );
}

function RecordDetails({ record }: { record: AirtableRecord }): ReactElement {
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="airtable-record-details">
      {Object.entries(record.fields).map(([name, value]) => (
        <div key={name} className="min-w-0 rounded border border-border bg-background px-2.5 py-2">
          <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-foreground-dim">{name}</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">{readableValue(value)}</dd>
        </div>
      ))}
      {record.createdTime ? (
        <div className="rounded border border-border bg-background px-2.5 py-2">
          <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-foreground-dim">Created</dt>
          <dd className="mt-1 text-xs text-foreground">{record.createdTime}</dd>
        </div>
      ) : null}
      {record.commentCount !== undefined ? (
        <div className="rounded border border-border bg-background px-2.5 py-2">
          <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-foreground-dim">Comments</dt>
          <dd className="mt-1 text-xs text-foreground">{record.commentCount}</dd>
        </div>
      ) : null}
    </div>
  );
}

function compareRows(a: AirtableRecord, b: AirtableRecord, key: string): number {
  const left = key === "__record" ? a.id : readableValue(a.fields[key]);
  const right = key === "__record" ? b.id : readableValue(b.fields[key]);
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function AirtableRecordGrid({ records }: { records: readonly AirtableRecord[] }): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortColumns, setSortColumns] = useState<readonly SortColumn[]>([]);
  const columns = useMemo<readonly Column<AirtableRecord>[]>(() => {
    const fieldNames = Array.from(new Set(records.flatMap((record) => Object.keys(record.fields))));
    return [
      {
        key: "__record",
        name: "Record",
        frozen: true,
        resizable: true,
        sortable: true,
        width: 170,
        renderCell: ({ row }) => (
          <button
            type="button"
            className="w-full truncate text-left font-mono text-[0.7rem] text-accent hover:underline"
            title={row.id}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedId((current) => current === row.id ? null : row.id);
            }}
          >
            {row.id}
          </button>
        ),
      },
      ...fieldNames.map((name): Column<AirtableRecord> => ({
        key: name,
        name,
        minWidth: 140,
        width: 200,
        resizable: true,
        sortable: true,
        renderCell: ({ row }) => (
          <span className="block whitespace-pre-wrap break-words py-1" title={readableValue(row.fields[name])}>
            {readableValue(row.fields[name])}
          </span>
        ),
      })),
    ];
  }, [records]);
  const sortedRecords = useMemo(() => {
    const sort = sortColumns[0];
    if (!sort) return records;
    return [...records].sort((a, b) => {
      const order = compareRows(a, b, sort.columnKey);
      return sort.direction === "ASC" ? order : -order;
    });
  }, [records, sortColumns]);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const gridHeight = Math.min(420, 44 + Math.max(records.length, 1) * 40);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded border border-border bg-background">
        <DataGrid
          aria-label="Airtable records"
          className="airtable-result-grid"
          columns={columns}
          rows={sortedRecords}
          rowKeyGetter={(row) => row.id}
          rowHeight={40}
          headerRowHeight={44}
          defaultColumnOptions={{ resizable: true, sortable: true }}
          sortColumns={sortColumns}
          onSortColumnsChange={setSortColumns}
          onCellClick={({ row }) => setSelectedId((current) => current === row.id ? null : row.id)}
          style={{ height: gridHeight }}
        />
      </div>
      <p className="text-[0.65rem] text-foreground-dim">Select a row or record ID to inspect every returned field.</p>
      {selected ? (
        <section className="space-y-2 rounded border border-border bg-background-element/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <h5 className="font-mono text-xs font-semibold text-foreground">{selected.id}</h5>
            <button type="button" className="text-xs text-foreground-muted hover:text-foreground" onClick={() => setSelectedId(null)}>Close</button>
          </div>
          <dl><RecordDetails record={selected} /></dl>
        </section>
      ) : null}
    </div>
  );
}

function AirtableBases({ bases }: { bases: readonly AirtableBase[] }): ReactElement {
  const [failedId, setFailedId] = useState<string | null>(null);
  if (bases.length === 0) return <p className="text-xs text-foreground-muted">No accessible Airtable bases were returned.</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="airtable-bases">
      {bases.map((base) => (
        <article key={base.id} className="rounded border border-border bg-background px-3 py-2.5">
          <p className="break-words text-xs font-semibold text-foreground">{base.name}</p>
          <p className="mt-0.5 font-mono text-[0.65rem] text-foreground-dim">{base.id}</p>
          {base.permissionLevel ? <p className="mt-1 text-[0.65rem] text-foreground-muted">{base.permissionLevel}</p> : null}
          {isAirtableId(base.id, "app") ? (
            <button
              type="button"
              className="mt-2 text-xs font-medium text-accent hover:underline"
              onClick={() => {
                setFailedId(null);
                void openExternal(`https://airtable.com/${base.id}`).catch(() => setFailedId(base.id));
              }}
            >
              Open in Airtable
            </button>
          ) : null}
          {failedId === base.id ? <p role="status" className="mt-1 text-xs text-tool-error">Airtable could not be opened.</p> : null}
        </article>
      ))}
    </div>
  );
}

function AirtableTables({ tables }: { tables: readonly AirtableTable[] }): ReactElement {
  if (tables.length === 0) return <p className="text-xs text-foreground-muted">No Airtable tables were returned.</p>;
  return (
    <div className="space-y-2" data-testid="airtable-tables">
      {tables.map((table) => (
        <details key={table.id} className="rounded border border-border bg-background px-3 py-2.5">
          <summary className="cursor-pointer list-none">
            <span className="text-xs font-semibold text-foreground">{table.name}</span>
            <span className="ml-2 text-[0.65rem] text-foreground-dim">
              {table.fields.length} {table.fields.length === 1 ? "field" : "fields"}
              {table.views ? ` · ${table.views.length} ${table.views.length === 1 ? "view" : "views"}` : ""}
            </span>
          </summary>
          {table.description ? <p className="mt-2 text-xs text-foreground-muted">{table.description}</p> : null}
          <div className="mt-2 overflow-x-auto rounded border border-border">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-background-element/60 text-[0.65rem] uppercase tracking-wide text-foreground-dim">
                <tr><th className="px-2 py-2">Field</th><th className="px-2 py-2">Type</th><th className="px-2 py-2">ID</th></tr>
              </thead>
              <tbody>
                {table.fields.map((field) => (
                  <tr key={field.id} className="border-t border-border align-top">
                    <td className="px-2 py-2">
                      <span className="font-medium text-foreground">{field.name}</span>
                      {field.description ? <span className="mt-0.5 block text-foreground-muted">{field.description}</span> : null}
                      {field.options !== undefined ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[0.65rem] font-medium text-accent">Field options</summary>
                          <pre className="mt-1 max-w-xl whitespace-pre-wrap break-words rounded bg-background-element/40 p-2 text-[0.65rem] text-foreground-muted">
                            {readableValue(field.options)}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-foreground-muted">{field.type ?? "—"}</td>
                    <td className="px-2 py-2 font-mono text-[0.65rem] text-foreground-dim">{field.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.views && table.views.length > 0 ? (
            <section className="mt-3 space-y-1.5">
              <h6 className="text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">Views</h6>
              {table.views.map((view, index) => {
                const viewId = nonEmptyString(view["id"]);
                const viewName = nonEmptyString(view["name"]) ?? `View ${index + 1}`;
                const viewType = nonEmptyString(view["type"]);
                return (
                  <details key={viewId ?? `${viewName}-${index}`} className="rounded border border-border bg-background-element/20 px-2.5 py-2">
                    <summary className="cursor-pointer text-xs text-foreground">
                      <span className="font-medium">{viewName}</span>
                      {viewType ? <span className="ml-2 text-foreground-muted">{viewType}</span> : null}
                    </summary>
                    <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      {Object.entries(view).map(([key, value]) => (
                        <div key={key} className="min-w-0 rounded bg-background px-2 py-1.5">
                          <dt className="text-[0.6rem] font-medium uppercase tracking-wide text-foreground-dim">{key}</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-[0.65rem] text-foreground-muted">{readableValue(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                );
              })}
            </section>
          ) : null}
        </details>
      ))}
    </div>
  );
}

function SafeResultDetails({ result }: { result: unknown }): ReactElement {
  if (!isRecord(result)) return <p className="text-xs text-foreground-muted">Airtable completed the request.</p>;
  return (
    <dl className="grid gap-2 sm:grid-cols-2" data-testid="airtable-result-details">
      {Object.entries(result).map(([key, value]) => (
        <div key={key} className="min-w-0 rounded border border-border bg-background px-2.5 py-2">
          <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-foreground-dim">{key}</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">{readableValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function AirtableContinuation({
  receipt,
  args,
  event,
}: {
  receipt: ConnectedAppToolReceipt;
  args: Record<string, unknown>;
  event: ToolRendererProps["event"];
}): ReactElement | null {
  const { activeRoomId } = useRoomNavigation();
  const [state, setState] = useState<"ready" | "sending" | "sent" | "error">("ready");
  const sentRef = useRef(false);
  const result = isRecord(receipt.result) ? receipt.result : null;
  const offset = nonEmptyString(result?.["offset"]);
  const canContinue = receipt.operationId === "airtable.list_bases" || receipt.operationId === "airtable.list_records";
  const continueRead = useCallback(() => {
    if (!offset || !activeRoomId || sentRef.current || !canContinue) return;
    sentRef.current = true;
    setState("sending");
    const nextArgs = { ...args, offset };
    const content = [
      `Continue the exact read-only ${receipt.operationId} request with its returned Airtable offset.`,
      `Arguments: ${JSON.stringify(nextArgs)}`,
      "Use only the already-active Airtable operation, show the next page in the same native Airtable result grid, and do not perform any write.",
    ].join("\n");
    void sendOrdinaryRoomMessage(apiClient, activeRoomId, {
      content,
      ...(event?.authorAgentId ? { uiSelectedBotActorId: event.authorAgentId } : {}),
    }).then(() => setState("sent")).catch(() => {
      sentRef.current = false;
      setState("error");
    });
  }, [activeRoomId, args, canContinue, event?.authorAgentId, offset, receipt.operationId]);

  if (!offset || !canContinue) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={state === "sending" || state === "sent"}
        className="rounded border border-border px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={continueRead}
      >
        {state === "sending" ? "Loading next page…" : state === "sent" ? "Next page requested" : "Load next page"}
      </button>
      {state === "error" ? <p role="status" className="text-xs text-tool-error">The continuation could not be sent. Try again.</p> : null}
    </div>
  );
}

function AirtableResultBody(props: ToolRendererProps): ReactElement {
  if (!props.resultText && (props.state === "pending" || props.state === "running")) {
    return <div role="status" className="border-t border-border px-3 py-3 text-xs text-foreground-muted">Working in Airtable…</div>;
  }
  const receipt = parseAirtableReceipt(props.toolName, props.resultText);
  if (!receipt) {
    return (
      <div role="status" className="border-t border-border px-3 py-3 text-xs text-foreground-muted">
        Airtable did not return a displayable result. No provider response data was shown.
      </div>
    );
  }
  const records = recordsFrom(receipt.result);
  const bases = basesFrom(receipt.result);
  const tables = tablesFrom(receipt.result);
  const url = airtableUrl(props.args, receipt.result);
  const label = ACTION_LABELS[receipt.operationId] ?? "Airtable result";
  return (
    <div className="space-y-3 border-t border-border p-3" data-testid="airtable-result">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-foreground">{label}</p>
          <p className="mt-0.5 text-[0.65rem] text-foreground-dim">
            {receipt.effect === "write" ? "Approved write completed in Airtable." : "Read directly from your connected Airtable account."}
          </p>
        </div>
        {url ? <OpenInAirtableButton url={url} /> : null}
      </header>
      {records.length > 0 ? <AirtableRecordGrid records={records} />
        : receipt.operationId === "airtable.list_records" ? <p className="text-xs text-foreground-muted">No Airtable records matched this request.</p>
        : receipt.operationId === "airtable.list_bases" ? <AirtableBases bases={bases} />
        : tables.length > 0 ? <AirtableTables tables={tables} />
        : <SafeResultDetails result={receipt.result} />}
      <AirtableContinuation receipt={receipt} args={props.args} event={props.event} />
      <ReceiptFooter receipt={receipt} />
    </div>
  );
}

function collapsedSummary(input: {
  args: Record<string, unknown>;
  resultText: string | undefined;
  state: ToolRendererProps["state"];
}): string {
  if (!input.resultText && (input.state === "pending" || input.state === "running")) return "Airtable · working";
  const receipt = parseAirtableReceipt(
    typeof input.args["__toolName"] === "string" ? input.args["__toolName"] : undefined,
    input.resultText,
  );
  if (!receipt) return "Airtable";
  const records = recordsFrom(receipt.result);
  if (records.length > 0) return `${records.length} Airtable ${records.length === 1 ? "record" : "records"}`;
  const bases = basesFrom(receipt.result);
  if (receipt.operationId === "airtable.list_bases") return `${bases.length} Airtable ${bases.length === 1 ? "base" : "bases"}`;
  const tables = tablesFrom(receipt.result);
  if (tables.length > 0) return `${tables.length} Airtable ${tables.length === 1 ? "table" : "tables"}`;
  return ACTION_LABELS[receipt.operationId] ?? "Airtable";
}

export const airtableResultRenderer: ToolRenderer = {
  sealedResultParser: true,
  autoExpandOnResult: true,
  collapsedSummary: ({ args, resultText, state }) => {
    // ToolRenderer's compact callback does not carry toolName. The operation is
    // still inside the sealed receipt, so derive it before applying the same
    // summary logic used by the expanded renderer.
    let toolName: string | undefined;
    try {
      const value: unknown = resultText ? JSON.parse(resultText) : null;
      if (isRecord(value) && typeof value["operationId"] === "string") {
        toolName = value["operationId"].replace(/\./gu, "_");
      }
    } catch {
      // A malformed or truncated receipt fails closed below.
    }
    return collapsedSummary({ args: { ...args, __toolName: toolName }, resultText, state });
  },
  ExpandedBody: AirtableResultBody,
};
