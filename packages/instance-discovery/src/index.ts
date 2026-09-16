/**
 * Browser-safe surface: pure helpers + table formatting (no `fs`, no mDNS).
 * Node consumers import `@nautilo/instance-discovery/node` for
 * `listLocalInstances` + `browseLocalInstances`.
 */
export * from "./types";
export * from "./instance-ids";
export * from "./merge-picker-candidates";
export { formatLocalInstancesTable } from "./format-local-instances-table";
