import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Clock3, Pencil, ShieldCheck } from "lucide-react";
import type { EnrollmentReviewStatus } from "@nautilo/types";
import { apiClient } from "../lib/api";
import { PreAuthShell } from "../components/pre-auth-shell";
import { Button } from "../pages/settings/ui";

/** This screen collects no PIN and grants no access. The Server independently
 * checks the approval again when publishing the completed enrollment.
 */
export function EnrollmentReviewGate({ token, children }: { token: string; children: ReactNode }) {
  const [review, setReview] = useState<EnrollmentReviewStatus | null>(null);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const current = await apiClient.getEnrollmentReview(token);
      setReview(current); setMessage(current.message ?? "");
    } catch { setError("Could not check your joining request. Please try again."); }
    finally { setBusy(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  if (review && (review.state === "completed" || (!review.paused && (!review.required || review.state === "approved")))) {
    return <>{children}</>;
  }
  const pending = review?.state === "pending";
  const editable = review && (review.state === "not_requested" || (pending && editing));
  return <PreAuthShell title={pending ? "Request sent" : "Join the community"}
    subtitle={pending ? "An administrator will review your request before you can enter." : "Tell us a little about why you would like to join."} scrim="page">
    <div className="mx-auto max-w-md space-y-5 text-left text-sm leading-relaxed">
      {!review && !error && <p role="status">Checking your joining request…</p>}
      {review?.paused && <p>New joins are paused. Existing members can still sign in. Your request will not grant access while joining is paused.</p>}
      {pending && <div className="flex items-center gap-2 rounded-lg border border-border bg-background-element/50 px-4 py-3" role="status">
        <Clock3 aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground-muted" />
        <span className="font-medium">Awaiting approval</span>
      </div>}
      {pending && !editing && <section className="rounded-lg border border-border p-4" aria-label="Your submitted message">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium text-foreground-muted">Your message</h2>
          <button type="button" disabled={busy} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium hover:bg-background-element disabled:opacity-40"
            onClick={() => { setMessage(review.message ?? ""); setEditing(true); }}>
            <Pencil aria-hidden="true" className="h-3 w-3" />Edit message
          </button>
        </div>
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{review.message}</p>
      </section>}
      {review?.state === "rejected" && <p>Your joining request was declined. Contact the community administrators if you believe this was a mistake.</p>}
      {editable && <form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        if (!message.trim() || busy) return;
        setBusy(true); setError(null);
        void apiClient.submitEnrollmentReview(token, message.trim()).then(current => {
          setReview(current); setMessage(current.message ?? ""); setEditing(false);
        }).catch(() => setError("Could not submit your request. Check your connection and try again."))
          .finally(() => setBusy(false));
      }}>
        <label htmlFor="joining-goal" className="block font-medium">What do you want to do in this community?</label>
        <p id="joining-goal-help" className="text-foreground-muted">A sentence or two about what you would like to explore, build, or share.</p>
        <textarea id="joining-goal" aria-describedby="joining-goal-help" required rows={4}
          value={message} onChange={event => setMessage(event.target.value)} disabled={busy}
          className="w-full rounded-md border border-border bg-background-panel p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
        <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy || !message.trim() || (review.state === "pending" && message.trim() === review.message)}>
          {busy ? "Sending…" : pending ? "Save message" : "Request to join"}
        </Button>
        {pending && <Button variant="secondary" disabled={busy} onClick={() => { setMessage(review.message ?? ""); setEditing(false); }}>Cancel</Button>}
        </div>
      </form>}
      {error && <p role="alert">{error}</p>}
      <p className="flex items-start gap-2 text-xs text-foreground-muted"><ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />Only community moderators can read your joining message.</p>
      {!editing && (pending || error || review?.paused || review?.state === "rejected") && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        {pending && <span className="flex items-center gap-1.5 text-xs text-foreground-muted"><Check aria-hidden="true" className="h-3.5 w-3.5" />Your request is saved</span>}
        <Button variant={pending ? "primary" : "secondary"} disabled={busy} onClick={() => { void load(); }}>{busy ? "Checking…" : "Check status"}</Button>
      </div>}
    </div>
  </PreAuthShell>;
}
