import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderCredentialApiError,
  type CredentialMetadata,
  type PersonalProviderCatalogEntry,
} from "@nautilo/api-client/browser";
import {
  PERSONAL_PROVIDER_KEY_CATALOGUE,
  orderProviderKeys,
  personalProviderCapabilitySummary,
  personalProviderWorkflowHint,
  type PersonalProviderCapability,
  type PersonalProviderKeyCatalogueEntry,
} from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { ProviderKeyCoverageTable } from "../../../components/provider-key-coverage-table";
import { PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT } from "../../../lib/caller-model-availability";
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
  | { kind: "signedOut" }
  | { kind: "error"; message: string }
  | {
    kind: "ready";
    credentials: CredentialMetadata[];
    providers: PersonalProviderCatalogEntry[];
    allowPersonalProviderKeys: boolean;
    refreshing?: boolean;
  };

type RowAction =
  | { kind: "idle" }
  | { kind: "busy"; action: "save" | "validate" | "delete" }
  | { kind: "error"; message: string };

interface DeleteConfirmation {
  provider: string;
  credential: CredentialMetadata;
  allowPersonalProviderKeys: boolean;
}

type ProviderRow = PersonalProviderKeyCatalogueEntry & {
  catalogued: boolean;
  available: boolean;
  destination: string | null;
};

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
      case "credential_destination_unavailable":
        return "This provider destination is not configured on the server. Contact the Server operator.";
      case "credential_destination_changed":
        return "The server's provider destination changed. Replace this key before using it again.";
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

function sameCredentialMetadata(left: CredentialMetadata, right: CredentialMetadata): boolean {
  return left.provider === right.provider
    && left.id === right.id
    && left.revision === right.revision
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.validationStatus === right.validationStatus
    && left.validatedAt === right.validatedAt
    && left.requiresReplacement === right.requiresReplacement
    && left.masked === right.masked
    && left.destination === right.destination
    && left.receiptReadStatus === right.receiptReadStatus;
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
  const [confirmDelete, setConfirmDelete] = useState<DeleteConfirmation | null>(null);
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
    if (!preserveMessage) setState((previous) => previous.kind === "ready" && !previous.allowPersonalProviderKeys
      ? { ...previous, refreshing: true }
      : previous.kind === "disabled" ? previous : { kind: "loading" });
    try {
      const result = await credentialApi.listProviderCredentials();
      if (!mountedRef.current || generation !== loadGenerationRef.current) return null;
      if (result.allowPersonalProviderKeys === false) {
        setSecret("");
        setEditingProvider(null);
        setConfirmDelete(null);
        setSavedProvider(null);
        setRowActions({});
      }
      const allowPersonalProviderKeys = result.allowPersonalProviderKeys !== false;
      setConfirmDelete((confirmation) => {
        if (!confirmation || confirmation.allowPersonalProviderKeys !== allowPersonalProviderKeys) return null;
        const current = result.credentials.find((credential) => credential.provider === confirmation.provider);
        return current && sameCredentialMetadata(current, confirmation.credential) ? confirmation : null;
      });
      setState({
        kind: "ready",
        credentials: result.credentials,
        providers: result.providers,
        allowPersonalProviderKeys,
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
      } else if (error !== null && typeof error === "object" && "status" in error && error.status === 401) {
        setSecret("");
        setEditingProvider(null);
        setConfirmDelete(null);
        setSavedProvider(null);
        setRowActions({});
        setState({ kind: "signedOut" });
        return "signedOut" as const;
      } else {
        setState({ kind: "error", message: errorMessage(error, "load") });
        return "error" as const;
      }
    }
  }, [credentialApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const personalKeysDisabled = state.kind === "disabled"
    || (state.kind === "ready" && !state.allowPersonalProviderKeys);

  useEffect(() => {
    const reloadAfterPolicyChange = () => {
      setSecret("");
      setEditingProvider(null);
      setConfirmDelete(null);
      setSavedProvider(null);
      setRowActions({});
      void load();
    };
    const refresh = () => void load();
    window.addEventListener(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT, reloadAfterPolicyChange);
    window.addEventListener("focus", refresh);
    const reloadWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", reloadWhenVisible);
    return () => {
      window.removeEventListener(PERSONAL_PROVIDER_POLICY_CHANGED_EVENT, reloadAfterPolicyChange);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", reloadWhenVisible);
    };
  }, [load]);

  const byProvider = useMemo(
    () => new Map(
      state.kind === "ready"
        ? state.credentials.map((credential) => [credential.provider, credential])
        : [],
    ),
    [state],
  );

  const providerRows = useMemo<ProviderRow[]>(() => {
    const responseProviders = new Map(
      state.kind === "ready" ? state.providers.map((provider) => [provider.id, provider]) : [],
    );
    const cataloguedIds = new Set<string>(PERSONAL_PROVIDER_KEY_CATALOGUE.map((provider) => provider.id));
    const responseIds = new Set<string>([...responseProviders.keys()]
      .filter((id) => id !== "gateway" && id !== "nautilo-gateway"));
    const uncataloguedIds = new Set(
      (state.kind === "ready" ? state.credentials : [])
        .map((credential) => credential.provider)
        .filter((provider) => !cataloguedIds.has(provider) && !responseIds.has(provider)),
    );
    const rows = orderProviderKeys([
      ...PERSONAL_PROVIDER_KEY_CATALOGUE.map((provider) => ({
        ...provider,
        personalCapabilities: state.kind === "ready" ? responseProviders.get(provider.id)?.personalCapabilities ?? [] : provider.personalCapabilities,
        destination: responseProviders.get(provider.id)?.destination ?? null,
        catalogued: true,
        available: state.kind === "ready" && responseIds.has(provider.id),
      })),
      ...(state.kind === "ready" ? state.providers
        .filter((provider) => !cataloguedIds.has(provider.id) && provider.id !== "gateway" && provider.id !== "nautilo-gateway")
        .map((provider) => ({
          ...provider,
          envVar: "",
          category: "llm" as const,
          required: false,
          catalogued: true,
          available: true,
          destination: provider.destination ?? null,
        })) : []),
      ...[...uncataloguedIds].map((provider) => ({
        id: provider,
        name: provider,
        envVar: "",
        category: "llm" as const,
        required: false,
        purpose: "This legacy saved provider is outside the current catalogue. You can delete its saved key.",
        personalCapabilities: [] as const,
        destination: byProvider.get(provider)?.destination ?? null,
        catalogued: false,
        available: false,
      })),
    ]);
    return personalKeysDisabled ? rows.filter((provider) => byProvider.has(provider.id)) : rows;
  }, [byProvider, personalKeysDisabled, state]);

  const personalCapabilityProviders = useMemo(() => {
    const ordered = orderProviderKeys(providerRows).filter((provider) => provider.catalogued);
    const forCapability = (capability: PersonalProviderCapability) => ordered
      .filter((provider) => provider.personalCapabilities.includes(capability))
      .map((provider) => [provider.id, provider.name] as const);
    return {
      chat: forCapability("chat"),
      research: forCapability("research"),
      decision: forCapability("decision"),
      browsing: forCapability("browsing"),
      conversion: forCapability("conversion"),
    };
  }, [providerRows]);

  const configuredPersonalProviderIds = useMemo(() => new Set(
    state.kind === "ready" ? state.credentials
      .filter((credential) => !credential.requiresReplacement
        && credential.validationStatus !== "rejected"
        && Object.values(personalCapabilityProviders).some((providers) =>
          providers.some(([id]) => id === credential.provider)))
      .map((credential) => credential.provider) : [],
  ), [personalCapabilityProviders, state]);

  const setRowAction = (provider: string, action: RowAction) => {
    setRowActions((current) => ({ ...current, [provider]: action }));
  };

  const rereadAfterConflict = async (provider: string, error: unknown, action: "save" | "validate" | "delete") => {
    if (error instanceof ProviderCredentialApiError && (
      error.repair === "reread_metadata"
      || error.error === "personal_credentials_disabled"
      || error.error === "personal_credentials_forbidden"
    ) || (error !== null && typeof error === "object" && "status" in error && error.status === 401)) {
      const result = await load(true);
      if (result === null) return;
      if (result === "disabled" || result === "forbidden" || result === "signedOut") {
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
        || reloadResult === "signedOut"
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

  const remove = async (confirmation: DeleteConfirmation) => {
    const { provider, credential } = confirmation;
    setRowAction(provider, { kind: "busy", action: "delete" });
    try {
      await credentialApi.deleteProviderCredential(provider, { expectedRevision: credential.revision });
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
      description={personalKeysDisabled ? undefined : "Add your own provider keys for supported personal chat, native text Tasks, Research, Decisions, browsing and file conversion. Keys belong to your account on this Server; after saving, only a masked preview is shown."}
      actions={<a className="text-sm font-medium text-primary hover:underline" href="/account/costs">View your costs</a>}
    >
      <div>
          {state.kind === "loading" || (state.kind === "ready" && state.refreshing) ? <p className="mb-4 text-sm text-foreground-muted">Loading saved key status…</p> : null}
          {personalKeysDisabled ? (
            <p role="status" className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-medium text-foreground">
              Personal API keys are disabled on this server.{byProvider.size > 0 ? " Your saved keys won’t be used. You can delete them below." : ""}
            </p>
          ) : null}
          {state.kind === "forbidden" ? (
            <p role="status" className="mb-4 text-sm text-foreground-muted">You do not have permission to manage personal API keys.</p>
          ) : null}
          {state.kind === "signedOut" ? (
            <p role="status" className="mb-4 text-sm text-foreground-muted">Your session ended. Sign in again to manage personal API keys.</p>
          ) : null}
          {state.kind === "error" ? (
            <div className="mb-4 flex flex-col items-start gap-3">
              <p role="alert" className="text-sm text-error">{state.message}</p>
              <Button onClick={() => void load()}>Retry</Button>
            </div>
          ) : null}
          {!personalKeysDisabled ? <><section className="mb-5 border-b border-border pb-5" aria-labelledby="personal-provider-key-coverage-title" data-testid="personal-provider-key-coverage">
            <h3 id="personal-provider-key-coverage-title" className="text-sm font-semibold">API key coverage</h3>
            <p className="mt-1 text-xs text-foreground-muted">Shows which saved keys can fund personal chat, Research, Decisions, browsing and file conversion. Provider and key status remain pending until the server confirms them.</p>
            <ProviderKeyCoverageTable
              configuredProviderIds={configuredPersonalProviderIds}
              rows={[
                { functionality: "Chat", providers: personalCapabilityProviders.chat },
                { functionality: "Research", providers: personalCapabilityProviders.research },
                { functionality: "Decisions", providers: personalCapabilityProviders.decision },
                { functionality: "Browsing", providers: personalCapabilityProviders.browsing },
                { functionality: "File conversion", providers: personalCapabilityProviders.conversion },
              ]}
              unknownStatusLabel={state.kind === "ready"
                ? undefined
                : state.kind === "loading" ? "Checking coverage…" : "Coverage unavailable"}
            />
          </section>
          <p className="mb-4 text-xs text-foreground-muted">
            Model readiness appears in the relevant model selector. Saving a key here only makes it available for eligible personal requests.
          </p></> : null}
          {providerRows.map((provider) => {
            const current = byProvider.get(provider.id);
            const action = rowActions[provider.id] ?? { kind: "idle" };
            const busy = action.kind === "busy";
            const editing = editingProvider === provider.id;
            const deletionEnabled = state.kind === "ready" && !state.refreshing;
            const actionsEnabled = deletionEnabled && !personalKeysDisabled;
            const savedAt = readableTime(current?.updatedAt ?? null);
            const validatedAt = readableTime(current?.validatedAt ?? null);
            return (
              <FieldRow
                key={provider.id}
                label={provider.name}
                htmlFor={`personal-provider-key-${provider.id}`}
                hint={personalKeysDisabled ? `Saved${savedAt ? ` ${savedAt}` : ""}` : (
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
                    {state.kind === "ready"
                      ? current ? `Saved${savedAt ? ` ${savedAt}` : ""}` : "No key saved"
                      : state.kind === "loading" ? "Checking saved status…" : "Saved status unavailable"}
                    {provider.destination ? (
                      <> · Uses <code className="break-all text-[11px]">{provider.destination}</code></>
                    ) : null}
                  </span>
                )}
              >
                <div className="flex flex-col gap-2">
                  {state.kind !== "ready" ? (
                    <StatusPill tone="muted">{state.kind === "loading" ? "Checking status…" : "Status unavailable"}</StatusPill>
                  ) : current && !personalKeysDisabled ? (
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
                      {current.receiptReadStatus === "unavailable" ? (
                        <span className="text-foreground-muted">
                          This key can run eligible requests. Some costs may appear later because it cannot currently read cost receipts.
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {editing && provider.catalogued && !personalKeysDisabled ? (
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
                        disabled={busy || !actionsEnabled}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" loading={busy} disabled={!actionsEnabled} onClick={() => void save(provider.id, current)}>
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
                  ) : confirmDelete?.provider === provider.id && current ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-foreground-muted">Delete this saved key?</span>
                      <Button loading={busy} disabled={!deletionEnabled || busy} onClick={() => void remove(confirmDelete)}>Delete key</Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {!personalKeysDisabled && provider.catalogued && (state.kind !== "ready" || provider.available) ? (
                        <Button disabled={!actionsEnabled || busy} onClick={() => {
                          setEditingProvider(provider.id);
                          setSecret("");
                          setSavedProvider(null);
                        }} ariaLabel={`${current ? "Replace" : "Add"} ${provider.name} key`}>
                          {current ? "Replace" : "Add key"}
                        </Button>
                      ) : null}
                      {!personalKeysDisabled && current && provider.catalogued && provider.available ? (
                          <Button
                            loading={busy && action.action === "validate"}
                            disabled={!actionsEnabled || busy}
                            ariaLabel={`Validate ${provider.name} key`}
                            onClick={() => void validate(provider.id, current)}
                          >
                            Check again
                          </Button>
                      ) : null}
                      {current ? (
                        <Button
                          variant="ghost"
                          disabled={!deletionEnabled || busy}
                          ariaLabel={provider.available || (personalKeysDisabled && provider.catalogued) ? `Delete ${provider.name} key` : `Delete legacy ${provider.name} key`}
                          onClick={() => setConfirmDelete({
                            provider: provider.id,
                            credential: { ...current },
                            allowPersonalProviderKeys: state.kind === "ready" && state.allowPersonalProviderKeys,
                          })}
                        >Delete</Button>
                      ) : null}
                    </div>
                  )}

                  {action.kind === "error" ? (
                    <p role="alert" className="text-xs text-error">{action.message}</p>
                  ) : null}
                  {!personalKeysDisabled && savedProvider === provider.id ? (
                    <p role="status" className="text-xs text-foreground-muted">
                      {current?.validationStatus === "unverified" ? "Key saved. No automatic credential check is available for this provider." : "Key saved. Validation did not make a paid request."}{" "}
                      {provider.catalogued ? <>
                        {personalProviderCapabilitySummary(provider)}{" "}
                        {provider.personalCapabilities.includes("chat") ? (
                          <a className="text-primary hover:underline" href="/settings#model">Choose a model for your Genie.</a>
                        ) : null}{" "}
                        {provider.personalCapabilities.some((capability) => capability === "research" || capability === "decision") ? (
                          <a className="text-primary hover:underline" href="/settings#capability-models">Configure Research and Decision models.</a>
                        ) : null}
                      </> : null}
                    </p>
                  ) : null}
                  {!personalKeysDisabled && provider.catalogued && current && provider.personalCapabilities.length > 0 && personalProviderWorkflowHint(provider.id) ? (
                    <p className="text-xs text-foreground-muted">
                      {personalProviderWorkflowHint(provider.id)}{" "}
                      <a className="text-primary hover:underline" href="/">Open your chats.</a>
                    </p>
                  ) : null}
                  {!personalKeysDisabled && provider.catalogued && savedProvider !== provider.id ? (
                    <p className="text-xs text-foreground-muted">
                      {personalProviderCapabilitySummary(provider)}
                    </p>
                  ) : null}
                </div>
              </FieldRow>
            );
          })}
          {showServerAdminLink && !personalKeysDisabled ? (
            <p className="mt-4 border-t border-border pt-4 text-xs text-foreground-muted">
              Server-funded keys are managed separately in{" "}
              <a className="text-primary hover:underline" href="/admin#provider-credentials">Server Admin</a>.
            </p>
          ) : null}
        </div>
    </SectionCard>
  );
}
