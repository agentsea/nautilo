import { useState } from "react";
import type { ServerModelConfig } from "@nautilo/api-client/browser";
import { formatProviderGroupLabel } from "../../settings/sections/model-browser-helpers";

type CatalogModel = NonNullable<ServerModelConfig["catalogModels"]>[number];

const FEATURE_LABELS = {
  tools: "Tools",
  structuredOutputs: "Structured output",
  reasoning: "Reasoning",
  visualGrounding: "Visual grounding (coordinates)",
  webSearch: "Web search",
  e2ee: "E2EE",
} as const;

function confirmedCapabilities(model: CatalogModel): string[] {
  return [
    ...(model.input.includes("image") ? ["Vision (image input)"] : []),
    ...(model.decision?.operations.map((operation) => operation === "choice" ? "Choice decisions" : operation) ?? []),
    ...Object.entries(FEATURE_LABELS).flatMap(([key, label]) =>
      model.features[key as keyof typeof FEATURE_LABELS] === true ? [label] : []),
  ];
}

function availabilityLabel(availability: string): string {
  switch (availability) {
    case "selectable": return "Available on server";
    case "missing_credentials": return "Missing credential";
    case "routing_filtered": return "Restricted by routing policy";
    case "disabled": return "Unavailable on server";
    case "unknown_model": return "Unknown model";
    default: return availability;
  }
}

export function ModelCatalogTable({ models }: { models: ServerModelConfig["catalogModels"] }) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const visible = models?.filter((model) => [model.id, model.displayName, model.provider,
    formatProviderGroupLabel(model.provider), model.workload, ...confirmedCapabilities(model)]
    .some((value) => value.toLowerCase().includes(search)));

  return (
    <section aria-labelledby="admin-model-catalog-title" className="space-y-3">
      <h3 id="admin-model-catalog-title" className="text-sm font-semibold">Model catalog</h3>
      <p className="text-xs text-foreground-muted">
        Models from the active catalog, including those awaiting credentials. Availability reflects
        server credentials and routing policy; each task also applies its account permissions and
        encryption policy. Decision models accelerate eligible browser work automatically.
      </p>
      {models === undefined ? (
        <p className="text-xs text-foreground-muted">This server does not provide the model catalog view yet.</p>
      ) : (
        <>
          <label className="block text-xs font-semibold" htmlFor="admin-model-catalog-search">Search model catalog</label>
          <input
            id="admin-model-catalog-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Model, provider, workload, or capability…"
            className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
          />
          <p className="text-xs text-foreground-muted" aria-live="polite">{visible?.length} of {models.length} models</p>
          <div className="max-h-96 overflow-auto rounded-md border border-border" tabIndex={0} role="region" aria-label="Model catalog results">
            <table className="w-full min-w-[40rem] text-left text-xs">
              <caption className="sr-only">Catalog models, providers, capabilities and server availability</caption>
              <thead className="sticky top-0 bg-background-panel">
                <tr>{["Model", "Provider", "Capabilities", "Availability"].map((label) => (
                  <th key={label} scope="col" className="px-3 py-2 font-semibold">{label}</th>
                ))}</tr>
              </thead>
              <tbody>
                {visible?.map((model) => (
                  <tr key={model.id} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-3 font-normal">
                      <span className="font-semibold">{model.displayName}</span>
                      <span className="mt-1 block capitalize text-foreground-muted">{model.workload}</span>
                      <span className="mt-1 block break-all text-foreground-muted">{model.id}</span>
                    </th>
                    <td className="px-3 py-3">{formatProviderGroupLabel(model.provider)}</td>
                    <td className="px-3 py-3">
                      <p>{confirmedCapabilities(model).join(" · ") || "No confirmed features"}</p>
                      <p className="mt-1 text-foreground-muted">Input: {model.input.join(", ")} · Output: {model.output.join(", ")}</p>
                      <details className="mt-2 text-foreground-muted">
                        <summary className="cursor-pointer">Capability details</summary>
                        <dl className="mt-1 space-y-1">
                          {Object.entries(FEATURE_LABELS).map(([key, label]) => {
                            const value = model.features[key as keyof typeof FEATURE_LABELS];
                            return <div key={key}><dt className="inline">{label}: </dt><dd className="inline">{
                              value === true ? "Supported" : value === false ? "Not supported" : "Unverified"
                            }</dd></div>;
                          })}
                        </dl>
                      </details>
                    </td>
                    <td className="px-3 py-3">
                      <p>{availabilityLabel(model.availability)}</p>
                      {model.unavailableReason ? <p className="mt-1 text-foreground-muted">{model.unavailableReason}</p> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible?.length === 0 ? <p className="px-3 py-3 text-xs text-foreground-muted">{models.length === 0 ? "No catalog models reported by this server." : "No models match your search."}</p> : null}
          </div>
        </>
      )}
    </section>
  );
}
