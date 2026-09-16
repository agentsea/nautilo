import { useMemo, type ReactNode, type ReactElement } from "react";
import type { RoomMemberDto } from "@nautilo/types";
import { MessageAuthorProvider } from "../../../components/conversation";
import { buildAuthorLabels } from "./agent-author-label";

/**
 * D352 — single shared author/member scope for any `Conversation` mount.
 *
 * Both the center room chat (`SlackShapeRoom`) and the right-panel reader-rail
 * chat (the work-surface sidecar in `workbench-shell`) wrap `<Conversation/>`
 * in this so the `@`-mention picker, agent identity (name+avatar), and
 * multi-human peer labels all resolve from the same roster. Derives the
 * `userId → displayName` label map once per `members` change.
 *
 * Before D352 only `SlackShapeRoom` supplied this context; the reader-rail
 * mount was bare, so `AuthorContext` was null → `members=[]`/`labels={}` and
 * mentions went inert + every agent collapsed to the viewer's default. This
 * component is the explicit fix; `Conversation`'s own self-source fallback is
 * the safety net for any future un-wrapped mount.
 */
export function RoomAuthorScope({
  members,
  children,
}: {
  readonly members: readonly RoomMemberDto[];
  readonly children: ReactNode;
}): ReactElement {
  const labels = useMemo(() => buildAuthorLabels(members), [members]);
  return (
    <MessageAuthorProvider labels={labels} members={members}>
      {children}
    </MessageAuthorProvider>
  );
}
