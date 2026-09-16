import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import { useProfile } from "../../hooks/use-profile";
import { GuestPlaceholder } from "../settings/ui";
import { Button, TextInput } from "../settings/ui";
import {
  customizeSkill,
  deleteSkill,
  fetchSkill,
  fetchSkillToolOptions,
  fetchSkills,
  resetSkill,
  saveSkill,
  setSkillEnabled,
  type SkillDetail,
  type SkillListItem,
  type SkillToolOption,
} from "../../lib/skills-api";
import {
  formatSkillTitle,
  partitionSkills,
  rowAffordances,
  rowKind,
} from "./skills-view-model";

const COLLAPSED_OFFICIAL_KEY = "nautilo.skills.collapsed.official";
const COLLAPSED_YOURS_KEY = "nautilo.skills.collapsed.yours";

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function sourceLabel(source: string): string {
  return source === "agent" ? "Genie" : "you";
}

function skillSourceLine(skill: Pick<SkillListItem, "official" | "source" | "version">): string {
  if (skill.official) {
    return skill.version != null ? `Nautilo · v${skill.version}` : "Nautilo";
  }
  return `by ${sourceLabel(skill.source)}`;
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

function SkillBadge({ badge }: { badge: string }) {
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

function SkillRow({
  skill,
  canEdit,
  busy,
  onToggle,
  onRemove,
  onCustomize,
  onReset,
  onNavigate,
}: {
  skill: SkillListItem;
  canEdit: boolean;
  busy: string | null;
  onToggle: (skill: SkillListItem) => void;
  onRemove: (name: string) => void;
  onCustomize: (name: string) => void;
  onReset: (name: string) => void;
  onNavigate: (name: string) => void;
}) {
  const affordances = rowAffordances(rowKind(skill));
  const isBusy = busy === skill.name;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-accent" aria-hidden="true">
              ✸
            </span>
            <button
              type="button"
              className="truncate text-left text-sm font-semibold hover:text-primary"
              onClick={() => onNavigate(skill.name)}
            >
              {formatSkillTitle(skill.name)}
            </button>
            <code className="shrink-0 text-xs text-foreground-dim">{skill.name}</code>
            {affordances.badge ? <SkillBadge badge={affordances.badge} /> : null}
          </div>
          <p className="mt-1 text-sm text-foreground-muted">{skill.description}</p>
          <p className="mt-1 text-xs text-foreground-dim">
            {skillSourceLine(skill)} · {formatTokenCount(skill.tokenEstimate)} tokens
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ToggleSwitch
            enabled={skill.enabled}
            disabled={!canEdit || !affordances.canToggle || isBusy}
            title={affordances.toggleHint}
            onChange={() => onToggle(skill)}
            label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
          />
          {canEdit ? (
            <div className="flex gap-2 text-xs">
              {affordances.canEdit ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  onClick={() => onNavigate(skill.name)}
                >
                  Edit
                </button>
              ) : affordances.canCustomize ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  onClick={() => onNavigate(skill.name)}
                >
                  View
                </button>
              ) : null}
              {affordances.canCustomize ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  disabled={isBusy}
                  onClick={() => onCustomize(skill.name)}
                >
                  Customize
                </button>
              ) : null}
              {affordances.canReset ? (
                <button
                  type="button"
                  className="text-foreground-muted hover:text-foreground"
                  disabled={isBusy}
                  onClick={() => onReset(skill.name)}
                >
                  Reset to official
                </button>
              ) : null}
              {affordances.canDelete ? (
                <button
                  type="button"
                  className="text-[var(--error)] hover:underline"
                  disabled={isBusy}
                  onClick={() => onRemove(skill.name)}
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

function SkillGroup({
  title,
  skills,
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
  skills: SkillListItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  canEdit: boolean;
  busy: string | null;
  onToggle: (skill: SkillListItem) => void;
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
        {title} ({skills.length})
      </button>
      {!collapsed ? (
        <ul className="divide-y divide-border">
          {skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
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

function SkillsListView({
  skills,
  summary,
  canEdit,
  onRefresh,
}: {
  skills: SkillListItem[];
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
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const { official, yours } = useMemo(() => partitionSkills(filtered), [filtered]);

  const goToSkill = useCallback(
    (name: string) => {
      void navigate(`/skills/${encodeURIComponent(name)}`);
    },
    [navigate],
  );

  const toggleEnabled = async (skill: SkillListItem) => {
    if (!canEdit) return;
    const affordances = rowAffordances(rowKind(skill));
    if (!affordances.canToggle) return;
    setBusy(skill.name);
    setError(null);
    try {
      await setSkillEnabled(skill.name, !skill.enabled);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    if (!canEdit) return;
    if (!window.confirm(`Delete skill "${name}"?`)) return;
    setBusy(name);
    setError(null);
    try {
      await deleteSkill(name);
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
      await customizeSkill(name);
      void navigate(`/skills/${encodeURIComponent(name)}`);
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
      await resetSkill(name);
      void navigate("/skills");
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
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            {summary.enabled} enabled · {summary.disabled} disabled · injected up front when relevant
          </p>
        </div>
        {canEdit ? (
          <Button variant="primary" onClick={() => void navigate("/skills/new")}>
            + New skill
          </Button>
        ) : null}
      </header>

      <TextInput
        value={query}
        onChange={setQuery}
        placeholder="Search skills…"
        ariaLabel="Search skills"
      />

      {error ? (
        <p className="text-sm text-[var(--error)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background-panel">
        {showEmpty ? (
          <p className="px-4 py-8 text-center text-sm text-foreground-muted">
            {skills.length === 0
              ? "No skills yet — create one to package on-demand know-how."
              : "No skills match your search."}
          </p>
        ) : (
          <>
            {official.length > 0 ? (
              <SkillGroup
                title="OFFICIAL · Nautilo"
                skills={official}
                collapsed={officialCollapsed}
                onToggleCollapsed={() => setOfficialCollapsed(!officialCollapsed)}
                canEdit={canEdit}
                busy={busy}
                onToggle={(s) => void toggleEnabled(s)}
                onRemove={(n) => void remove(n)}
                onCustomize={(n) => void customize(n)}
                onReset={(n) => void reset(n)}
                onNavigate={goToSkill}
              />
            ) : null}
            {yours.length > 0 ? (
              <SkillGroup
                title="YOUR SKILLS"
                skills={yours}
                collapsed={yoursCollapsed}
                onToggleCollapsed={() => setYoursCollapsed(!yoursCollapsed)}
                canEdit={canEdit}
                busy={busy}
                onToggle={(s) => void toggleEnabled(s)}
                onRemove={(n) => void remove(n)}
                onCustomize={(n) => void customize(n)}
                onReset={(n) => void reset(n)}
                onNavigate={goToSkill}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SkillsEditorView({
  initial,
  canEdit,
  isNew,
  onSaved,
  onRefresh,
}: {
  initial: SkillDetail | null;
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
  const [requiresTools, setRequiresTools] = useState<string[]>(initial?.requiresTools ?? []);
  const [toolOptions, setToolOptions] = useState<SkillToolOption[]>([]);
  const [toolOptionsLoading, setToolOptionsLoading] = useState(true);
  const [toolOptionsError, setToolOptionsError] = useState<string | null>(null);
  const [toolSearch, setToolSearch] = useState("");
  const [showCapabilities, setShowCapabilities] = useState(false);
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
    setRequiresTools(initial.requiresTools ?? []);
  }, [initial]);

  useEffect(() => {
    let active = true;
    void fetchSkillToolOptions()
      .then((options) => { if (active) setToolOptions(options); })
      .catch((cause: unknown) => {
        if (active) setToolOptionsError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (active) setToolOptionsLoading(false); });
    return () => { active = false; };
  }, []);

  const visibleToolOptions = useMemo(() => {
    const query = toolSearch.trim().toLocaleLowerCase();
    const known = new Set(toolOptions.map((option) => option.name));
    const unavailable = !toolOptionsLoading && !toolOptionsError ? requiresTools
      .filter((name) => !known.has(name))
      .map((name): SkillToolOption => ({
        name,
        label: "Unavailable capability",
        description: "This saved requirement is no longer available. Remove it before saving.",
        category: "unavailable",
      })) : [];
    return [...toolOptions, ...unavailable].filter((option) =>
      !query || option.label.toLocaleLowerCase().includes(query));
  }, [requiresTools, toolOptions, toolOptionsError, toolOptionsLoading, toolSearch]);

  const toggleRequiredTool = (toolName: string): void => {
    setRequiresTools((current) => current.includes(toolName)
      ? current.filter((name) => name !== toolName)
      : [...current, toolName]);
  };

  const tokenEstimate = useMemo(
    () => Math.max(1, Math.ceil(body.length / 4)),
    [body],
  );

  const submit = async () => {
    if (!canEdit || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSkill({
        name: name.trim(),
        description: description.trim(),
        body: body.trim(),
        enabled,
        requiresTools,
      });
      onSaved(saved.name);
      void navigate(`/skills/${encodeURIComponent(saved.name)}`, { replace: true });
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
      await customizeSkill(initial.name);
      onRefresh();
      void navigate(`/skills/${encodeURIComponent(initial.name)}`, { replace: true });
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
      await resetSkill(initial.name);
      onRefresh();
      void navigate(`/skills/${encodeURIComponent(initial.name)}`, { replace: true });
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
          onClick={() => void navigate("/skills")}
        >
          ← Skills
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isNew ? "New skill" : formatSkillTitle(name)}
          </h1>
          {!isNew && name ? (
            <code className="text-xs text-foreground-dim">{name}</code>
          ) : null}
          {initial && affordances.badge ? <SkillBadge badge={affordances.badge} /> : null}
        </div>
      </header>

      {readOnly && initial ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background-panel px-4 py-3 text-sm">
          <p className="text-foreground-muted">
            Official Nautilo skill
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
          <label htmlFor="skill-name" className="text-sm font-medium">
            Name
          </label>
          <TextInput
            id="skill-name"
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
              label="Skill enabled"
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
          <label htmlFor="skill-description" className="text-sm font-medium sm:pt-2">
            Description
          </label>
          <div>
            <TextInput
              id="skill-description"
              value={description}
              onChange={setDescription}
              disabled={fieldsDisabled}
            />
            <p className="mt-1 text-xs text-foreground-dim">
              Shown in the per-turn catalog · ≤1024 chars
            </p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
          <div className="text-sm font-medium sm:pt-2">Needed capabilities</div>
          <div className="space-y-2">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-border bg-background-element px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => setShowCapabilities((value) => !value)}
              disabled={busy || toolOptionsLoading}
              aria-expanded={showCapabilities}
            >
              <span>{requiresTools.length === 0 ? "Let Genie use what is available" : `${requiresTools.length} selected`}</span>
              <span aria-hidden="true">{showCapabilities ? "▴" : "▾"}</span>
            </button>
            <p className="text-xs text-foreground-dim">
              Usually leave this empty—Genie chooses what to use. Select only capabilities this Skill cannot work without.
            </p>
            {showCapabilities ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <TextInput
                  id="skill-capability-search"
                  value={toolSearch}
                  onChange={setToolSearch}
                  placeholder="Search capabilities"
                  disabled={fieldsDisabled}
                />
                {toolOptionsError ? <p className="text-xs text-[var(--error)]">{toolOptionsError}</p> : null}
                {toolOptionsLoading ? <p className="text-sm text-foreground-muted">Loading capabilities…</p> : null}
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {visibleToolOptions.map((option) => (
                    <label key={option.name} className="flex cursor-pointer gap-3 rounded-md px-2 py-2 hover:bg-background-hover">
                      <input
                        type="checkbox"
                        checked={requiresTools.includes(option.name)}
                        onChange={() => toggleRequiredTool(option.name)}
                        disabled={fieldsDisabled}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-sm font-medium">{option.label}</span>
                      </span>
                    </label>
                  ))}
                  {visibleToolOptions.length === 0 && !toolOptionsError && !toolOptionsLoading ? (
                    <p className="px-2 py-3 text-sm text-foreground-muted">No matching capabilities.</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">
            Body (SKILL.md)
            {readOnly ? " · read-only" : null}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={fieldsDisabled}
            rows={14}
            className="w-full rounded-md border border-border bg-background-element px-3 py-2 font-mono text-sm text-foreground placeholder:text-foreground-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            placeholder={"---\nname: teaching-mode\ndescription: ...\n---\n\nWhen the user wants to practice…"}
          />
        </div>

        <p className="text-xs text-foreground-muted">
          Source: {initial ? skillSourceLine(initial) : "you"} ·{" "}
          {formatTokenCount(tokenEstimate)} tokens
        </p>
        <p className="text-xs text-[var(--warning)]">
          ⚠ Instructions only — a skill cannot grant tools or bypass policy.
        </p>

        {error ? (
          <p className="text-sm text-[var(--error)]" role="alert">
            {error}
          </p>
        ) : null}

        {canEdit && !readOnly ? (
          <div className="flex justify-end">
            <Button variant="primary" loading={saving} disabled={toolOptionsLoading} onClick={() => void submit()}>
              Save
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SkillsPage() {
  const auth = useAuth();
  const can = useCan();
  const { response: profileResponse } = useProfile();
  const params = useParams<{ name?: string }>();
  const editorName = params.name;
  const isNew = editorName === "new";

  const canEdit =
    auth.viewer.isVerified &&
    (profileResponse?.viewerRole === "owner" || can("manage_agents"));

  const [list, setList] = useState<SkillListItem[]>([]);
  const [summary, setSummary] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const data = await fetchSkills();
    setList(data.skills);
    setSummary(data.summary);
  }, []);

  const refreshDetail = useCallback(async () => {
    await refreshList();
    if (editorName && editorName !== "new") {
      const skill = await fetchSkill(editorName);
      setDetail(skill);
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
          const skill = await fetchSkill(editorName);
          setDetail(skill);
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
        <GuestPlaceholder what="Skills" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-6 py-10 text-sm text-foreground-muted">Loading skills…</div>
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
      <SkillsEditorView
        initial={isNew ? null : detail}
        canEdit={canEdit}
        isNew={isNew}
        onSaved={() => void refreshList()}
        onRefresh={() => void refreshDetail()}
      />
    );
  }

  return (
    <SkillsListView
      skills={list}
      summary={summary}
      canEdit={canEdit}
      onRefresh={() => void refreshList()}
    />
  );
}
