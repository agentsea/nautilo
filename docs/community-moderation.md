# Community moderation

The initial controls live in **Server admin → Moderation**. Owners and
delegated moderators see the actions their current grants allow. Grant
administrators manage these permissions through **Server admin → Access
control**, using the existing Roles and Groups.

## Control admission

Select **Enable moderation and joining approval**. This enables the controls
and requires each new applicant to explain their goal in joining. Applicants
remain outside the Server until staff approve their request and they finish
the existing profile/PIN setup. Review requests in **Moderation → Joining requests**
with **Approve** or **Decline**. Search names, handles, or joining messages.
The list scrolls inside a bounded panel; **Previous** and **Next** replace the
page. Search covers pending requests beyond the displayed page.
Approval belongs to that account and Invite;
another account cannot inherit it by using the same link.

Use **Pause new joins** during an incident. Existing members retain access.
Disabling moderation controls preserves bans, the pause, and required
approval. To reopen enrollment, enable the controls and deliberately change
the saved joining policy. Individual Invite revocation remains under
**Server admin → Invites**.

The existing public joining URL remains usable as an application entry point.
The Server checks the current policy again when enrollment completes, so
copied links and older clients cannot bypass review. Browser and connected
Desktop use the Workbench served by that Server.

## Remove a person

In **Moderation → Members**, search a full or partial name or `@handle`.
Select **Add** beside each match. Selected members stay selected when you
search again or change pages. Remove an individual selection with its ×.
Choose **Kick selected** or **Ban selected**, enter a reason, and confirm.
Each member gets a separate result; a protected target or failed action does
not hide the outcomes for the other members. Retry unresolved members without
repeating successful actions.

In chat, the shield dropdown beside the normal message controls offers
**Kick from Server** and **Ban from Server** for identified Human authors when
your current grants allow them. Confirm directly in chat. Opening the menu
checks the target's current permissions; executing the command checks them
again. The Users detail panel also offers **Moderate this person**.

- **Ban from Server** withdraws access and prevents the known login identity
  from returning. Changing that identity's username does not lift its ban.
  Bans from these controls also permanently delete that person's existing
  messages in community/group Rooms and their threads. Private conversations,
  Genie responses, and other people's messages are preserved. If a deleted
  message started a thread, its replies remain accessible beneath a
  **Message removed by moderation** placeholder.
- **Kick from Server** withdraws access. A fresh valid Invite and the current
  joining policy are required to return.
- **Lift ban** removes that restriction. It does not restore membership
  access, lift other restrictions, or enable an independently disabled account.

Confirm the person and action, enter a reason, and select **Confirm**. Protected
targets and changed permissions are checked on the Server. If the response
is lost, **Check result** retrieves the saved receipt and **Retry same action**
reuses its operation identity instead of performing another removal.

A saved ban and completed cleanup are separate states. Access withdrawal
commits before message removal. If removal is interrupted, the interface shows
it as pending and offers **Retry message removal**. Recovery also resumes from
the saved receipt on Server restart. It uses the original ban's cutoff, so
messages sent after a later readmission are not removed by an old cleanup.
The interface reports pending connection/running-work cleanup or audit
recovery explicitly. A new
login identity may belong to the same person without being identifiable as
such; required approval prevents automatic re-entry but cannot guarantee a
reviewer will recognize every evader.

## Private confirmations

After a confirmed in-chat ban or kick, the dialog closes and a toast reports
its result. Pending message cleanup keeps the retry controls available.
The acting moderator also receives a personal confirmation in the Events bell,
labelled **Moderation · Only you**. Other Room members do not receive it.
Delegated moderators use the same grant checks as the action itself. The feed
stores identifiers and the action, never the private reason or note, and retries
reuse the original operation key. Feed recording is best effort and does not
change the committed moderation result or replace its audit record.

## Test and patch

Run the focused unit and component checks from the repository root:

```bash
bun run test:moderation
```

For database and full server-route checks, provision an unused, disposable
local instance with the normal developer tooling, then run:

```bash
bun run infra:start --instance moderation-scratch
bun run test:moderation --integration --instance moderation-scratch
```

Choose a different instance name if it is already used by another checkout.
The runner refuses default, protected, remote, and ambiguous instances, loads
the selected instance's existing service configuration, and runs each test
file in its own process. It does not reset an existing database. A migration
lineage mismatch requires a separate compatible scratch instance.

The integrated journey exercises real route registration, token verification,
grants, review, profile completion, a reusable Invite, ban/kick/lift, existing-session
denial, and pause. Its external identity provider is a test fixture. This is
separate from interactive login and packaged-release acceptance.

For interactive testing, use a separately named populated development clone.
Sign in to that clone, enable the controls, and repeat the journey with test
members. Check an already-open member session as well as reconnecting. Keep
the clone separate from automated fixtures and production. After a source
patch, rebuild Workbench and restart only the selected clone:

```bash
bun run server:stop --instance moderation-ui
bun run dev-stack --instance moderation-ui
```

The first interactive launch needs an existing populated clone or the normal
`--clone-default` developer workflow. The launch command reports its local
URL. Native Mobile actions, Room mute/timeout, shared report actions,
and automated request filtering are outside these initial controls.
