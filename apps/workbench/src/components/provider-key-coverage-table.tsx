import { SquareCheck, X } from "lucide-react";

export interface ProviderKeyCoverageRow {
  functionality: string;
  providers: readonly (readonly [id: string, name: string])[];
}

interface ProviderKeyCoverageTableProps {
  configuredProviderIds: ReadonlySet<string>;
  rows: readonly ProviderKeyCoverageRow[];
}

export function ProviderKeyCoverageTable({
  configuredProviderIds,
  rows,
}: ProviderKeyCoverageTableProps) {
  return (
    <table className="mt-3 w-full table-fixed border-collapse text-left text-xs">
      <thead>
        <tr className="border-b border-border text-foreground-muted">
          <th scope="col" className="w-2/5 pb-2 pr-3 font-medium">
            Functionality
          </th>
          <th scope="col" className="w-3/5 pb-2 font-medium">
            Providers
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ functionality, providers }) => {
          const covered = providers.some(([id]) => configuredProviderIds.has(id));
          return (
            <tr
              key={functionality}
              className="border-b border-border/40 last:border-b-0"
            >
              <th scope="row" className="py-2 pr-3 align-top font-medium text-foreground">
                <span className="flex min-w-0 items-start gap-2">
                  {covered ? (
                    <SquareCheck
                      role="img"
                      aria-label={`${functionality}: supporting API key configured`}
                      className="mt-0.5 size-4 shrink-0 text-[var(--success)]"
                    />
                  ) : (
                    <X
                      role="img"
                      aria-label={`${functionality}: no supporting API key configured`}
                      className="mt-0.5 size-4 shrink-0 text-foreground-dim"
                    />
                  )}
                  <span className="min-w-0 break-words">{functionality}</span>
                </span>
              </th>
              <td className="py-2 align-top">
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {providers.map(([id, name]) => {
                    const configured = configuredProviderIds.has(id);
                    return (
                      <span
                        key={id}
                        aria-label={`${name}: ${configured ? "API key configured" : "API key not configured"}`}
                        className={
                          configured
                            ? "max-w-full break-words rounded-full bg-[var(--success)]/15 px-2 py-0.5 font-medium text-[var(--success)]"
                            : "max-w-full break-words rounded-full bg-background-element px-2 py-0.5 text-foreground-muted"
                        }
                      >
                        {name}
                      </span>
                    );
                  })}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
