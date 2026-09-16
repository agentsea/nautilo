import { materializeGenerationDirectionBlocks, validateGenerationBrief, type GenerationBrief, type GenerationReference } from "./generation-brief";
import { referenceMentions, setSharedGenerationReferences, sharedGenerationReferences } from "./generator-composer";

/** Scope is projected from existing document ownership, never a second store. */
export type GenerationReferenceScope = "all" | readonly string[];

/** Older scene tools allocated IDs within each scene. Separate only collisions. */
function normalizeGenerationReferenceIds(brief: GenerationBrief): GenerationBrief {
  const used = new Set([...sharedGenerationReferences(brief), ...brief.shots.flatMap(shot => shot.references)].map(reference => reference.id));
  const identities = new Map<string, Map<string, string>>();
  let serial = 1;
  return mapReferences(brief, references => references.map(reference => {
    const identity = JSON.stringify(reference.source ?? [reference.name, reference.mediaKind]);
    const variants = identities.get(reference.id) ?? new Map<string, string>();
    let id = variants.get(identity);
    if (!id) {
      id = reference.id;
      if (variants.size) { do { id = `ref_scope_${serial++}`; } while (used.has(id)); }
      variants.set(identity, id); used.add(id); identities.set(reference.id, variants);
    }
    return id === reference.id ? reference : { ...reference, id };
  }));
}

export function allGenerationReferences(brief: GenerationBrief): GenerationReference[] {
  const current = normalizeGenerationReferenceIds(brief);
  return unique([...sharedGenerationReferences(current), ...current.shots.flatMap(shot => shot.references)]);
}

function unique(references: GenerationReference[]): GenerationReference[] {
  return references.filter((reference, index) => references.findIndex(item => item.id === reference.id) === index);
}

export function sceneGenerationReferences(brief: GenerationBrief, shotId?: string): GenerationReference[] {
  const current = normalizeGenerationReferenceIds(brief);
  return unique([...sharedGenerationReferences(current), ...(current.shots.find(shot => shot.id === shotId)?.references ?? [])]);
}

export function generationReferenceScope(brief: GenerationBrief, id: string): GenerationReferenceScope {
  const current = normalizeGenerationReferenceIds(brief);
  return sharedGenerationReferences(current).some(reference => reference.id === id)
    ? "all" : current.shots.filter(shot => shot.references.some(reference => reference.id === id)).map(shot => shot.id);
}

function mapReferences(brief: GenerationBrief, map: (references: GenerationReference[]) => GenerationReference[]): GenerationBrief {
  const current = materializeGenerationDirectionBlocks(brief);
  return validateGenerationBrief({ ...current,
    blocks: current.blocks.map(block => block.kind === "references" ? { ...block, references: map(block.references ?? []) } : block),
    shots: current.shots.map(shot => ({ ...shot, references: map(shot.references) })),
  });
}

/** Freeze legacy implicit tokens before changing membership or ordering. */
export function preserveGenerationReferenceMentions(brief: GenerationBrief): GenerationBrief {
  const current = normalizeGenerationReferenceIds(brief);
  const library = allGenerationReferences(current);
  const mentions = referenceMentions(library);
  const used = new Set<string>();
  const reserved = new Set([...mentions.values(), ...(JSON.stringify(current).match(/@(Image|Video|Audio)[1-9][0-9]*/gu) ?? [])]);
  for (const reference of library) {
    let token = mentions.get(reference.id)!;
    if (used.has(token)) {
      const prefix = token.replace(/[0-9]+$/u, ""); let index = 1;
      while (reserved.has(`${prefix}${index}`)) index++;
      token = `${prefix}${index}`; mentions.set(reference.id, token); reserved.add(token);
    }
    used.add(token);
  }
  const rewrite = (references: GenerationReference[]) => {
    const previous = referenceMentions(references);
    const tokens = new Map<string, string>();
    for (const reference of references) {
      const old = previous.get(reference.id)!, token = mentions.get(reference.id)!;
      if (tokens.has(old) && tokens.get(old) !== token) throw new Error(`Reference mention ${old} is ambiguous. Remove the conflicting reference before changing its scope.`);
      tokens.set(old, token);
    }
    return (text: string) => text.replace(/@(Image|Video|Audio)[1-9][0-9]*/gu, token => tokens.get(token) ?? token);
  };
  const sharedText = rewrite(sharedGenerationReferences(current));
  const next = mapReferences(current, references => references.map(reference => ({ ...reference, mention: mentions.get(reference.id)! })));
  return validateGenerationBrief({ ...next,
    blocks: next.blocks.map(block => {
      const updated = { ...block };
      for (const field of ["quickBrief", "goal", "continuity", "audio", "exclusions"] as const) if (updated[field] !== undefined) updated[field] = sharedText(updated[field]);
      return updated;
    }),
    shots: next.shots.map(shot => {
      const text = rewrite(sceneGenerationReferences(current, shot.id));
      return { ...shot, description: text(shot.description), framing: text(shot.framing), camera: text(shot.camera), motion: text(shot.motion), audio: text(shot.audio), continuity: text(shot.continuity), exclusions: text(shot.exclusions) };
    }),
  });
}

export function setGenerationReferenceScope(brief: GenerationBrief, id: string, scope: GenerationReferenceScope): GenerationBrief {
  if (scope !== "all" && (!scope.length || scope.some(id => !brief.shots.some(shot => shot.id === id)))) {
    throw new Error("Choose at least one existing scene for this reference.");
  }
  const current = preserveGenerationReferenceMentions(brief);
  const reference = allGenerationReferences(current).find(reference => reference.id === id);
  if (!reference) throw new Error("This reference was removed. Choose a reference again.");
  const next = mapReferences(current, references => references.filter(reference => reference.id !== id));
  return scope === "all" ? setSharedGenerationReferences(next, [...sharedGenerationReferences(next), reference])
    : validateGenerationBrief({ ...next, shots: next.shots.map(shot => scope.includes(shot.id) ? { ...shot, references: [...shot.references, reference] } : shot) });
}

/** Replace/edit a reference in every assigned scene, retaining its identity. */
export function updateScopedGenerationReference(brief: GenerationBrief, id: string, patch: Partial<Omit<GenerationReference, "id" | "mention">>): GenerationBrief {
  const current = preserveGenerationReferenceMentions(brief);
  const reference = allGenerationReferences(current).find(reference => reference.id === id);
  if (!reference) throw new Error("This reference was removed. Choose a reference again.");
  const updated = { ...reference, ...patch };
  if (patch.mediaKind && patch.mediaKind !== reference.mediaKind) updated.mention = nextMention(current, patch.mediaKind);
  return mapReferences(current, references => references.map(item => item.id === id ? { ...item, ...updated } : item));
}

function nextMention(brief: GenerationBrief, kind: GenerationReference["mediaKind"]): string {
  const mediaKind = kind ?? "image";
  const prefix = `@${mediaKind[0]!.toUpperCase()}${mediaKind.slice(1)}`;
  const used = new Set([...referenceMentions(allGenerationReferences(brief)).values(), ...(JSON.stringify(brief).match(/@(Image|Video|Audio)[1-9][0-9]*/gu) ?? [])]);
  let index = 1; while (used.has(`${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}

export function addScopedGenerationReferences(brief: GenerationBrief, additions: readonly GenerationReference[], shotId?: string): GenerationBrief {
  if (shotId && !brief.shots.some(shot => shot.id === shotId)) throw new Error("The scene was removed while choosing references. Choose a scene and add them again.");
  let current = preserveGenerationReferenceMentions(brief);
  for (const addition of additions) {
    const existing = allGenerationReferences(current).find(reference => reference.id === addition.id || (addition.source && JSON.stringify(reference.source) === JSON.stringify(addition.source)));
    if (existing) {
      const scope = generationReferenceScope(current, existing.id);
      if (scope === "all" || (shotId && scope.includes(shotId))) continue;
      current = setGenerationReferenceScope(current, existing.id, shotId ? [...scope, shotId] : "all");
    } else {
      const reference = { ...addition, mention: nextMention(current, addition.mediaKind) };
      current = shotId ? validateGenerationBrief({ ...current, shots: current.shots.map(shot => shot.id === shotId ? { ...shot, references: [...shot.references, reference] } : shot) })
        : setSharedGenerationReferences(current, [...sharedGenerationReferences(current), reference]);
    }
  }
  return current;
}

/** Shared removal affects all scenes; a local removal affects only this scene. */
export function removeScopedGenerationReference(brief: GenerationBrief, id: string, shotId?: string): GenerationBrief {
  const current = preserveGenerationReferenceMentions(brief);
  if (generationReferenceScope(current, id) === "all" || !shotId) return mapReferences(current, references => references.filter(reference => reference.id !== id));
  return validateGenerationBrief({ ...current, shots: current.shots.map(shot => shot.id === shotId ? { ...shot, references: shot.references.filter(reference => reference.id !== id) } : shot) });
}
