import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderCredentialApiError,
  type CredentialMetadata,
  type PersonalProviderCatalogEntry,
} from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { ProviderKeyCoverageTable } from "../../../components/provider-key-coverage-table";
import { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT } from "../../../lib/caller-model-availability";
import { orderProviderKeys } from "../../../lib/provider-key-display";
import { Button, FieldRow, SectionCard, StatusPill, TextInput } from "../ui";

export { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT };
export const PERSONAL_PROVIDER_POLICY_CHANGED_EVENT =
  "nautilo:personal-provider-policy-changed";

type CredentialApi = Pick<
  typeof apiClient,
  | "listProviderCredentials"
  | "putProviderCredential"
  | "validateProviderCredential"
  | "deleteProviderCredential"
>;

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | {
    kind: "ready";
    credentials: CredentialMetadata[];
    providers: PersonalProviderCatalogEntry[];
  };

type RowAction =
  | { kind: "idle" }
  | { kind: "busy"; action: "save" | "validate" | "delete" }
  | { kind: "error"; message: string };

type ProviderRow = PersonalProviderCatalogEntry & { catalogued: boolean };

const SERVER_ONLY_GATEWAY_PROVIDER_IDS = new Set(["gateway", "nautilo-gateway"]);

function readableTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleString();
}

function statusPill(status: CredentialMetadata["validationStatus"]) {
  switch (status) {
    case "accepted":
      return <StatusPill tone="ok">Accepted</StatusPill>;
    case "rejected":
      return <StatusPill tone="error">Rejected</StatusPill>;
    case "unavailable":
      return <StatusPill tone="warn">Validation unavailable</StatusPill>;
    case "unverified":
      return <StatusPill tone="muted">Not validated</StatusPill>;
  }
}

function errorMessage(error: unknown, action: "load" | "save" | "validate" | "delete"): string {
  if (error instanceof ProviderCredentialApiError) {
    switch (error.error) {
      case "credential_conflict":
        return "This key changed in another tab. Current details were reloaded; try the action again.";
      case "credential_custody_unavailable":
        return "Your saved keys cannot be opened safely right now. Contact the Server operator.";
      case "credential_reenrollment_required":
        return "This key must be replaced after the Server's credential custody was restored.";
      case "personal_credentials_unavailable":
        return "Personal provider keys are temporarily unavailable. Try again.";
      case "personal_credentials_forbidden":
        return "You no longer have permission to manage personal provider keys.";
      case "credential_not_found":
        return "This key no longer exists. Current details were reloaded.";
      case "invalid_provider":
      case "invalid_credential_request":
        return "The provider key request was not accepted. Check the value and try again.";
    }
  }
  if (action === "validate") return "Validation could not be completed. The saved key was kept; try again.";
  if (action === "load") return "Personal provider keys could not be loaded. Try again.";
  return `The key could not be ${action === "save" ? "saved" : "deleted"}. Try again.`;
}

function credentialChanged(): void {
  window.dispatchEvent(new Event(PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT));
}

export interface PersonalProviderKeysSectionProps {
  credentialApi?: CredentialApi;
  showServerAdminLink?: boolean;
}

export function PersonalProviderKeysSection({
  credentialApi = apiClient,
  showServerAdminLink = false,
}: PersonalProviderKeysSectionProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rowActions, setRowActions] = useState<Record<string, RowAction>>({});
  const [savedProvider, setSavedProvider] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (preserveMessage = false) => {
    const generation = ++loadGenerationRef.current;
    if (!preserveMessage) setState({ kind: "loading" });
    try {
      const result = await credentialApi.listProviderCredentials();
      if (!mountedRef.current || generation !== loadGenerationRef.current) return null;
      setState({
        kind: "ready",
        credentials: result.credentials,
        providers: result.providers,
      });
      return "ready" as const;
    } catch (error) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return null;
      if (error instanceof ProviderCredentialApiError && error.error === "personal_credentials_disabled") {
        setSecret("");
        setEditingProvider(null);
        setConfirmDelete(null);
        setSavedProvider(null);
        setRowActions({});
        setState({ kind: "disabled" });
        return "disabled" as const;
      } else if (error instanceof ProviderCredentialApiError && error.error === "personal_credentials_forbidden") {
        setSecret("");
        setEditingProvider(null);
        setConfirmDelete(null);
        setSavedProvider(null);
        setRowActions({});
        setState({ kind: "forbidden" });
        return "forbidden" as const;
      } else {
        setState({ kind: "error", message: errorMessage(error, "load") });
        return "error" as const;
      }
    }
  }, [credentialApi]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const reload = () => {
      setSecret("");
      setEditingProvider(null);
      setConfirmDelete(null);
      setSavedProvider(null);
      setRowActions({});
      void load();
    };
    window.addEventListener(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT, reload);
  }, [load]);

  const byProvider = useMemo(
    () => new Map(
      state.kind === "ready"
        ? state.credentials.map((credential) => [credential.provider, credential])
        : [],
    ),
    [state],
  );

  const personalChatProviders = useMemo(
    () => state.kind === "ready"
      ? orderProviderKeys(state.providers)
        .filter((provider) => !SERVER_ONLY_GATEWAY_PROVIDER_IDS.has(provider.id))
        .filter((provider) => provider.personalCapabilities.includes("chat"))
        .map((provider) => [provider.id, provider.name] as const)
      : [],
    [state],
  );

  const providerRows = useMemo<ProviderRow[]>(() => {
    if (state.kind !== "ready") return [];
    const cataloguedIds = new Set(state.providers.map((provider) => provider.id));
    const uncataloguedIds = new Set(
      state.credentials
        .map((credential) => credential.provider)
        .filter((provider) => !cataloguedIds.has(provider)),
    );
    return orderProviderKeys([
      ...state.providers
        .filter((provider) =>
          !SERVER_ONLY_GATEWAY_PROVIDER_IDS.has(provider.id) || byProvider.has(provider.id))
        .map((provider) => ({ ...provider, catalogued: true })),
      ...[...uncataloguedIds].map((provider) => ({
        id: provider,
        name: provider,
        purpose: "This saved provider is outside the server’s current provider catalogue. You can replace, validate, or delete its key.",
        personalCapabilities: [] as const,
        catalogued: false,
      })),
    ]);
  }, [byProvider, state]);

  const configuredChatProviderIds = useMemo(
    () => new Set(
      state.kind === "ready"
        ? state.credentials
          .filter((credential) =>
            !credential.requiresReplacement
            && credential.validationStatus !== "rejected"
            && personalChatProviders.some(([id]) => id === credential.provider))
          .map((credential) => credential.provider)
        : [],
    ),
    [personalChatProviders, state],
  );

  const setRowAction = (provider: string, action: RowAction) => {
    setRowActions((current) => ({ ...current, [provider]: action }));
  };

  const rereadAfterConflict = async (provider: string, error: unknown, action: "save" | "validate" | "delete") => {
    if (error instanceof ProviderCredentialApiError && (
      error.repair === "reread_metadata"
      || error.error === "personal_credentials_disabled"
      || error.error === "personal_credentials_forbidden"
    )) {
      const result = await load(true);
      if (result === null) return;
      if (result === "disabled" || result === "forbidden") {
        setSecret("");
        setEditingProvider(null);
        setConfirmDelete(null);
        return;
      }
    }
    if (mountedRef.current) setRowAction(provider, { kind: "error", message: errorMessage(error, action) });
  };

  const save = async (provider: string, current: CredentialMetadata | undefined) => {
    const apiKey = secret.trim();
    if (!apiKey) {
      setRowAction(provider, { kind: "error", message: "Enter a provider API key." });
      return;
    }
    setRowAction(provider, { kind: "busy", action: "save" });
    try {
      const result = await credentialApi.putProviderCredential(provider, {
        apiKey,
        ...(current ? { expectedRevision: current.revision } : {}),
      });
      if (!mountedRef.current) return;
      setState((previous) => previous.kind === "ready"
        ? {
          ...previous,
          credentials: [
            ...previous.credentials.filter((item) => item.provider !== provider),
            result.credential,
          ],
        }
        : previous);
      setSecret("");
      setEditingProvider(null);
      setSavedProvider(provider);
      setRowAction(provider, { kind: "idle" });
      credentialChanged();
    } catch (error) {
      setSecret("");
      setEditingProvider(null);
      const reloadResult = await load(true);
      if (
        !mountedRef.current
        || reloadResult === null
        || reloadResult === "disabled"
        || reloadResult === "forbidden"
      ) return;
      if (reloadResult === "error") {
        setState({
          kind: "error",
          message: "We could not confirm whether the key was saved, and current key details could not be reloaded. Retry the read before making another change.",
        });
        return;
      }
      setRowAction(provider, {
        kind: "error",
        message: error instanceof ProviderCredentialApiError && !error.committed
          ? errorMessage(error, "save")
          : "We could not confirm whether the key was saved. Current details were reloaded; check the saved revision before trying again.",
      });
    }
  };

  const validate = async (provider: string, current: CredentialMetadata) => {
    setRowAction(provider, { kind: "busy", action: "validate" });
    try {
      const result = await credentialApi.validateProviderCredential(provider, {
        expectedRevision: current.revision,
      });
      if (!mountedRef.current) return;
      setState((previous) => previous.kind === "ready"
        ? {
          ...previous,
          credentials: previous.credentials.map((item) =>
            item.provider === provider ? result.credential : item),
        }
        : previous);
      setRowAction(provider, { kind: "idle" });
      credentialChanged();
    } catch (error) {
      await rereadAfterConflict(provider, error, "validate");
    }
  };

  const remove = async (provider: string, current: CredentialMetadata) => {
    setRowAction(provider, { kind: "busy", action: "delete" });
    try {
      await credentialApi.deleteProviderCredential(provider, { expectedRevision: current.revision });
      if (!mountedRef.current) return;
      setState((previous) => previous.kind === "ready"
        ? {
          ...previous,
          credentials: previous.credentials.filter((item) => item.provider !== provider),
        }
        : previous);
      setConfirmDelete(null);
      setSavedProvider(null);
      setRowAction(provider, { kind: "idle" });
      credentialChanged();
    } catch (error) {
      setConfirmDelete(null);
      await rereadAfterConflict(provider, error, "delete");
    }
  };

  return (
    <SectionCard
      id="personal-provider-keys"
      title="Personal API keys"
      description="Add your own provider keys to use supported models for personal chat and native tool-free text Tasks. Keys belong to your account on this Server; after saving, only a masked preview is shown."
    >
      {state.kind === "loading" ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : state.kind === "disabled" ? (
        <p role="status" className="text-sm text-foreground-muted">
          Personal keys are disabled on this server.
        </p>
      ) : state.kind === "forbidden" ? (
        <p role="status" className="text-sm text-foreground-muted">
          You are not allowed to set up personal keys.
        </p>
      ) : state.kind === "error" ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-error">{state.message}</p>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      ) : (
        <div>
          <section
            className="mb-5 border-b border-border pb-5"
            aria-labelledby="personal-provider-key-coverage-title"
            data-testid="personal-provider-key-coverage"
          >
            <h3 id="personal-provider-key-coverage-title" className="text-sm font-semibold">
              API key coverage
            </h3>
            <p className="mt-1 text-xs text-foreground-muted">
              Shows saved personal API key coverage, not provider availability. Rejected keys and keys that require replacement do not count as coverage.
            </p>
            <p className="mt-1 text-xs text-foreground-muted">
              Personal keys currently support personal chat and native tool-free text Tasks; other paid capabilities will be added later.
            </p>
            {state.providers.length > 0 ? (
              <ProviderKeyCoverageTable
                configuredProviderIds={configuredChatProviderIds}
                rows={[{ functionality: "Chat", providers: personalChatProviders }]}
              />
            ) : null}
          </section>
          {state.providers.length === 0 ? (
            <p className="mb-4 text-sm text-foreground-muted">
              Provider choices are temporarily unavailable. Saved keys can still be managed below.
            </p>
          ) : null}
          {providerRows.map((provider) => {
            const current = byProvider.get(provider.id);
            const action = rowActions[provider.id] ?? { kind: "idle" };
            const busy = action.kind === "busy";
            const editing = editingProvider === provider.id;
            const savedAt = readableTime(current?.updatedAt ?? null);
            const validatedAt = readableTime(current?.validatedAt ?? null);
            return (
              <FieldRow
                key={provider.id}
                label={provider.name}
                htmlFor={`personal-provider-key-${provider.id}`}
                hint={(
                  <span>
                    {provider.purpose}
                    {provider.signupUrl ? (
                      <>
                        {" · "}
                        <a
                          href={provider.signupUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:text-foreground"
                        >
                          Get a key
                        </a>
                      </>
                    ) : null}
                    {" · "}
                    {current ? `Saved${savedAt ? ` ${savedAt}` : ""} · revision ${current.revision}` : "No key saved"}
                  </span>
                )}
              >
                <div className="flex flex-col gap-2">
                  {current ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                      {statusPill(current.validationStatus)}
                      {current.masked ? (
                        <code className="rounded bg-background-element px-1.5 py-0.5 text-[11px] text-foreground-dim">
                          {current.masked}
                        </code>
                      ) : null}
                      {validatedAt ? <span>Validated {validatedAt}</span> : null}
                      {current.requiresReplacement ? (
                        <span className="font-medium text-error">Replacement required</span>
                      ) : null}
                    </div>
                  ) : null}

                  {editing ? (
                    <div className="flex flex-col gap-2">
                      <TextInput
                        id={`personal-provider-key-${provider.id}`}
                        type="password"
                        value={secret}
                        onChange={(value) => {
                          setSecret(value);
                          setRowAction(provider.id, { kind: "idle" });
                        }}
                        autoComplete="new-password"
                        ariaLabel={`${current ? "Replacement" : "New"} ${provider.name} API key`}
                        placeholder={provider.formatHint}
                        disabled={busy}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" loading={busy} onClick={() => void save(provider.id, current)}>
                          {current ? "Replace key" : "Save key"}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setSecret("");
                            setEditingProvider(null);
                            setRowAction(provider.id, { kind: "idle" });
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : confirmDelete === provider.id && current ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-foreground-muted">Delete this saved key?</span>
                      <Button loading={busy} onClick={() => void remove(provider.id, current)}>Delete key</Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => {
                        setEditingProvider(provider.id);
                        setSecret("");
                        setSavedProvider(null);
                      }} ariaLabel={`${current ? "Replace" : "Add"} ${provider.name} key`}>
                        {current ? "Replace" : "Add key"}
                      </Button>
                      {current ? (
                        <>
                          <Button
                            loading={busy && action.action === "validate"}
                            disabled={busy}
                            ariaLabel={`Validate ${provider.name} key`}
                            onClick={() => void validate(provider.id, current)}
                          >
                            {current.validationStatus === "unavailable" ? "Retry validation" : "Validate"}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            ariaLabel={`Delete ${provider.name} key`}
                            onClick={() => setConfirmDelete(provider.id)}
                          >Delete</Button>
                        </>
                      ) : null}
                    </div>
                  )}

                  {action.kind === "error" ? (
                    <p role="alert" className="text-xs text-error">{action.message}</p>
                  ) : null}
                  {savedProvider === provider.id ? (
                    <p role="status" className="text-xs text-foreground-muted">
                      Key saved.{" "}
                      {provider.catalogued
                        ? provider.personalCapabilities.includes("chat") ? (
                          <a className="text-primary hover:underline" href="/settings#model">Choose a model for your Genie.</a>
                        ) : (
                          "Not used by personal chat or native tool-free text Tasks in this release."
                        )
                        : null}
                    </p>
                  ) : null}
                  {provider.catalogued
                    && !provider.personalCapabilities.includes("chat")
                    && savedProvider !== provider.id ? (
                    <p className="text-xs text-foreground-muted">
                      Not used by personal chat or native tool-free text Tasks in this release.
                    </p>
                  ) : null}
                </div>
              </FieldRow>
            );
          })}
          {showServerAdminLink ? (
            <p className="mt-4 border-t border-border pt-4 text-xs text-foreground-muted">
              Server-funded keys are managed separately in{" "}
              <a className="text-primary hover:underline" href="/admin#provider-credentials">Server Admin</a>.
            </p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
