import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import { useProfile } from "../../hooks/use-profile";
import { GuestPlaceholder } from "../settings/ui";
import { Button, TextInput } from "../settings/ui";
import {
  customizeCommand,
  deleteCommand,
  fetchCommand,
  fetchCommands,
  resetCommand,
  putCommand,
  setCommandEnabled,
  type CommandDetail,
  type CommandListItem,
} from "../../lib/commands-api";
import {
  formatCommandTitle,
  partitionCommands,
  rowAffordances,
  rowKind,
} from "./commands-view-model";

const COLLAPSED_OFFICIAL_KEY = "nautilo.commands.collapsed.official";
const COLLAPSED_YOURS_KEY = "nautilo.commands.collapsed.yours";

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function sourceLabel(source: string): string {
  return source === "agent" ? "Genie" : "you";
}

function commandSourceLine(
  command: Pick<CommandListItem, "official" | "source" | "version">,
): string {
  if (command.official) {
    return command.version != null ? `Nautilo · v${command.version}` : "Nautilo";
  }
  return `by ${sourceLabel(command.source)}`;
}

function readCollapsed(key: string): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return false;
    return v === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key, String(collapsed));
  } catch {
    /* ignore */
  }
}

function useCollapsedGroup(key: string): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const set = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      writeCollapsed(key, next);
    },
    [key],
  );
  return [collapsed, set];
}

function CommandBadge({ badge }: { badge: string }) {
  if (badge === "★ official · customized") {
    return (
      <span className="text-xs">
        <span className="text-accent">★ official</span>
        <span className="text-foreground-dim"> · customized</span>
      </span>
    );
  }
  return <span className="text-xs text-accent">{badge}</span>;
}

function ToggleSwitch({
  enabled,
  disabled,
  title,
  onChange,
  label,
}: {
  enabled: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled ? "true" : "false"}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={[
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        enabled ? "bg-[var(--success)]" : "bg-foreground-muted/40",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
          enabled ? "translate-x-4" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );
}

function CommandRow({
  command,
  canEdit,
  busy,
  onToggle,
  onRemove,
  onCustomize,
  onReset,
  onNavigate,
}: {
  command: CommandListItem;
  canEdit: boolean;
  busy: string | null;
  onToggle: (command: CommandListItem) => void;
  onRemove: (name: string) => void;
  onCustomize: (name: string) => void;
  onReset: (name: string) => void;
  onNavigate: (name: string) => void;
}) {
  const affordances = rowAffordances(rowKind(command));
  const isBusy = busy === command.name;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-accent" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              className="truncate text-left text-sm font-semibold hover:text-primary"
              onClick={() => onNavigate(command.name)}
            >
              {formatCommandTitle(command.name)}
            </button>
            <code className="shrink-0 text-xs text-foreground-dim">{command.name}</code>
            {affordances.badge ? <CommandBadge badge={affordances.badge} /> : null}
          </div>
          <p className="mt-1 text-sm text-foreground-muted">{command.description}</p>
          <p className="mt-1 text-xs text-foreground-dim">
            {commandSourceLine(command)} · {formatTokenCount(command.tokenEstimate)} tokens
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ToggleSwitch
            enabled={command.enabled}
            disabled={!canEdit || !affordances.canToggle || isBusy}
            title={affordances.toggleHint}
            onChange={() => onToggle(command)}
            label={`${command.enabled ? "Disable" : "Enable"} ${command.name}`}
          />
          {canEdit ? (
            <div className="flex gap-2 text-xs">
              {affordances.canEdit ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  onClick={() => onNavigate(command.name)}
                >
                  Edit
                </button>
              ) : affordances.canCustomize ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  onClick={() => onNavigate(command.name)}
                >
                  View
                </button>
              ) : null}
              {affordances.canCustomize ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  disabled={isBusy}
                  onClick={() => onCustomize(command.name)}
                >
                  Customize
                </button>
              ) : null}
              {affordances.canReset ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  disabled={isBusy}
                  onClick={() => onReset(command.name)}
                >
                  Reset to official
                </button>
              ) : null}
              {affordances.canDelete ? (
                <button
                  type="button"
                  className="text-[var(--error)] hover:underline"
                  disabled={isBusy}
                  onClick={() => onRemove(command.name)}
                >
                  Delete
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function CommandGroup({
  title,
  commands,
  collapsed,
  onToggleCollapsed,
  canEdit,
  busy,
  onToggle,
  onRemove,
  onCustomize,
  onReset,
  onNavigate,
}: {
  title: string;
  commands: CommandListItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  canEdit: boolean;
  busy: string | null;
  onToggle: (command: CommandListItem) => void;
  onRemove: (name: string) => void;
  onCustomize: (name: string) => void;
  onReset: (name: string) => void;
  onNavigate: (name: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 border-b border-border bg-background-panel px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground-muted hover:text-foreground"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        {title} ({commands.length})
      </button>
      {!collapsed ? (
        <ul className="divide-y divide-border">
          {commands.map((command) => (
            <CommandRow
              key={command.name}
              command={command}
              canEdit={canEdit}
              busy={busy}
              onToggle={onToggle}
              onRemove={onRemove}
              onCustomize={onCustomize}
              onReset={onReset}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CommandsListView({
  commands,
  summary,
  canEdit,
  onRefresh,
}: {
  commands: CommandListItem[];
  summary: { enabled: number; disabled: number };
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [officialCollapsed, setOfficialCollapsed] = useCollapsedGroup(COLLAPSED_OFFICIAL_KEY);
  const [yoursCollapsed, setYoursCollapsed] = useCollapsedGroup(COLLAPSED_YOURS_KEY);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const { official, yours } = useMemo(() => partitionCommands(filtered), [filtered]);

  const goToCommand = useCallback(
    (name: string) => {
      void navigate(`/commands/${encodeURIComponent(name)}`);
    },
    [navigate],
  );

  const toggleEnabled = async (command: CommandListItem) => {
    if (!canEdit) return;
    const affordances = rowAffordances(rowKind(command));
    if (!affordances.canToggle) return;
    setBusy(command.name);
    setError(null);
    try {
      await setCommandEnabled(command.name, !command.enabled);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    if (!canEdit) return;
    if (!window.confirm(`Delete command "${name}"?`)) return;
    setBusy(name);
    setError(null);
    try {
      await deleteCommand(name);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const customize = async (name: string) => {
    if (!canEdit) return;
    setBusy(name);
    setError(null);
    try {
      await customizeCommand(name);
      void navigate(`/commands/${encodeURIComponent(name)}`);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const reset = async (name: string) => {
    if (!canEdit) return;
    if (
      !window.confirm(
        `Reset "${name}" to the official version? Your customizations will be discarded.`,
      )
    ) {
      return;
    }
    setBusy(name);
    setError(null);
    try {
      await resetCommand(name);
      void navigate("/commands");
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const showEmpty = filtered.length === 0;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Commands</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            {summary.enabled} enabled · {summary.disabled} disabled · slash-commands invoked from the composer
          </p>
        </div>
        {canEdit ? (
          <Button variant="primary" onClick={() => void navigate("/commands/new")}>
            + New command
          </Button>
        ) : null}
      </header>

      <TextInput
        value={query}
        onChange={setQuery}
        placeholder="Search commands…"
        ariaLabel="Search commands"
      />

      {error ? (
        <p className="text-sm text-[var(--error)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background-panel">
        {showEmpty ? (
          <p className="px-4 py-8 text-center text-sm text-foreground-muted">
            {commands.length === 0
              ? "No commands yet — create one to package a reusable slash-command."
              : "No commands match your search."}
          </p>
        ) : (
          <>
            {official.length > 0 ? (
              <CommandGroup
                title="OFFICIAL · Nautilo"
                commands={official}
                collapsed={officialCollapsed}
                onToggleCollapsed={() => setOfficialCollapsed(!officialCollapsed)}
                canEdit={canEdit}
                busy={busy}
                onToggle={(c) => void toggleEnabled(c)}
                onRemove={(n) => void remove(n)}
                onCustomize={(n) => void customize(n)}
                onReset={(n) => void reset(n)}
                onNavigate={goToCommand}
              />
            ) : null}
            {yours.length > 0 ? (
              <CommandGroup
                title="YOUR COMMANDS"
                commands={yours}
                collapsed={yoursCollapsed}
                onToggleCollapsed={() => setYoursCollapsed(!yoursCollapsed)}
                canEdit={canEdit}
                busy={busy}
                onToggle={(c) => void toggleEnabled(c)}
                onRemove={(n) => void remove(n)}
                onCustomize={(n) => void customize(n)}
                onReset={(n) => void reset(n)}
                onNavigate={goToCommand}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function CommandsEditorView({
  initial,
  canEdit,
  isNew,
  onSaved,
  onRefresh,
}: {
  initial: CommandDetail | null;
  canEdit: boolean;
  isNew: boolean;
  onSaved: (name: string) => void;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = initial ? rowKind(initial) : "yours";
  const affordances = rowAffordances(kind);
  const readOnly = !isNew && kind === "official-untouched";
  const fieldsDisabled = !canEdit || readOnly;

  useEffect(() => {
    if (!initial) return;
    setName(initial.name);
    setDescription(initial.description);
    setBody(initial.body);
    setEnabled(initial.enabled);
  }, [initial]);

  const tokenEstimate = useMemo(
    () => Math.max(1, Math.ceil(body.length / 4)),
    [body],
  );

  const submit = async () => {
    if (!canEdit || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putCommand({
        name: name.trim(),
        description: description.trim(),
        body: body.trim(),
        enabled,
      });
      onSaved(saved.name);
      void navigate(`/commands/${encodeURIComponent(saved.name)}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const customize = async () => {
    if (!canEdit || !initial) return;
    setBusy(true);
    setError(null);
    try {
      await customizeCommand(initial.name);
      onRefresh();
      void navigate(`/commands/${encodeURIComponent(initial.name)}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!canEdit || !initial) return;
    if (
      !window.confirm(
        `Reset "${initial.name}" to the official version? Your customizations will be discarded.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resetCommand(initial.name);
      onRefresh();
      void navigate(`/commands/${encodeURIComponent(initial.name)}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto px-6 py-6">
      <header>
        <button
          type="button"
          className="text-sm text-foreground-muted hover:text-foreground"
          onClick={() => void navigate("/commands")}
        >
          ← Commands
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isNew ? "New command" : formatCommandTitle(name)}
          </h1>
          {!isNew && name ? (
            <code className="text-xs text-foreground-dim">{name}</code>
          ) : null}
          {initial && affordances.badge ? <CommandBadge badge={affordances.badge} /> : null}
        </div>
      </header>

      {readOnly && initial ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background-panel px-4 py-3 text-sm">
          <p className="text-foreground-muted">
            Official Nautilo command
            {initial.version != null ? ` · v${initial.version}` : ""} — read-only. Customize to
            make your own editable copy.
          </p>
          {canEdit ? (
            <Button variant="primary" loading={busy} onClick={() => void customize()}>
              Customize
            </Button>
          ) : null}
        </div>
      ) : null}

      {kind === "official-customized" && initial ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background-panel px-4 py-3 text-sm">
          <p className="text-foreground-muted">
            Customized from official
            {initial.version != null ? ` v${initial.version}` : ""}.
          </p>
          {canEdit ? (
            <Button variant="secondary" loading={busy} onClick={() => void reset()}>
              Reset to official
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-4 rounded-lg border border-border bg-background-panel p-4">
        <div className="grid gap-3 sm:grid-cols-[140px_1fr_auto] sm:items-center">
          <label htmlFor="command-name" className="text-sm font-medium">
            Name
          </label>
          <TextInput
            id="command-name"
            value={name}
            onChange={setName}
            disabled={fieldsDisabled || !isNew}
            readOnly={!isNew}
          />
          <div className="flex items-center gap-2 sm:justify-end">
            <span className="text-xs text-foreground-muted">enabled</span>
            <ToggleSwitch
              enabled={enabled}
              disabled={!canEdit || !affordances.canToggle || readOnly}
              title={affordances.toggleHint}
              onChange={setEnabled}
              label="Command enabled"
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
          <label htmlFor="command-description" className="text-sm font-medium sm:pt-2">
            Description
          </label>
          <div>
            <TextInput
              id="command-description"
              value={description}
              onChange={setDescription}
              disabled={fieldsDisabled}
            />
            <p className="mt-1 text-xs text-foreground-dim">
              Shown in the slash-command picker · ≤1024 chars
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">
            Body (COMMAND.md)
            {readOnly ? " · read-only" : null}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={fieldsDisabled}
            rows={14}
            className="w-full rounded-md border border-border bg-background-element px-3 py-2 font-mono text-sm text-foreground placeholder:text-foreground-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            placeholder={"---\nname: summarize\ndescription: ...\n---\n\nSummarize the conversation…"}
          />
          <p className="mt-1 text-xs text-foreground-dim">
            Use $ARGUMENTS to inject the text the user types after the command.
          </p>
        </div>

        <p className="text-xs text-foreground-muted">
          Source: {initial ? commandSourceLine(initial) : "you"} ·{" "}
          {formatTokenCount(tokenEstimate)} tokens
        </p>

        {error ? (
          <p className="text-sm text-[var(--error)]" role="alert">
            {error}
          </p>
        ) : null}

        {canEdit && !readOnly ? (
          <div className="flex justify-end">
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              Save
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CommandsPage() {
  const auth = useAuth();
  const can = useCan();
  const { response: profileResponse } = useProfile();
  const params = useParams<{ name?: string }>();
  const editorName = params.name;
  const isNew = editorName === "new";

  const canEdit =
    auth.viewer.isVerified &&
    (profileResponse?.viewerRole === "owner" || can("manage_agents"));

  const [list, setList] = useState<CommandListItem[]>([]);
  const [summary, setSummary] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [detail, setDetail] = useState<CommandDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const data = await fetchCommands();
    setList(data.commands);
    setSummary(data.summary);
  }, []);

  const refreshDetail = useCallback(async () => {
    await refreshList();
    if (editorName && editorName !== "new") {
      const command = await fetchCommand(editorName);
      setDetail(command);
    }
  }, [editorName, refreshList]);

  useEffect(() => {
    if (!auth.viewer.isVerified) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await refreshList();
        if (editorName && editorName !== "new") {
          const command = await fetchCommand(editorName);
          setDetail(command);
        } else {
          setDetail(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [auth.viewer.isVerified, editorName, refreshList]);

  if (!auth.viewer.isVerified) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <GuestPlaceholder what="Commands" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-6 py-10 text-sm text-foreground-muted">Loading commands…</div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-10 text-sm text-[var(--error)]" role="alert">
        {error}
      </div>
    );
  }

  if (editorName) {
    return (
      <CommandsEditorView
        initial={isNew ? null : detail}
        canEdit={canEdit}
        isNew={isNew}
        onSaved={() => void refreshList()}
        onRefresh={() => void refreshDetail()}
      />
    );
  }

  return (
    <CommandsListView
      commands={list}
      summary={summary}
      canEdit={canEdit}
      onRefresh={() => void refreshList()}
    />
  );
}
