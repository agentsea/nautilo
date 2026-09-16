/** D508 owner-only `/claim` route: capture, coordinator and passive renderer. */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/use-auth";
import { createOwnerClaimBrowserEffectAdapter } from "../lib/owner-claim-effect-adapter";
import { createOwnerClaimCoordinator } from "../lib/owner-claim-coordinator";
import { ownerClaimQualificationEventSink } from "../lib/owner-claim-qualification-trace";
import {
  createOwnerClaimMachineState,
  type OwnerClaimMachineState,
} from "../lib/owner-claim-machine";
import {
  ownerClaimBootstrapFromSession,
  type OwnerClaimRouteBootstrap,
} from "../lib/owner-claim-entry";
import { OwnerClaimRenderer } from "./owner-claim-renderer";

export type { OwnerClaimRouteBootstrap } from "../lib/owner-claim-entry";

export function OwnerClaimRedeem({ bootstrap: suppliedBootstrap }: { readonly bootstrap?: OwnerClaimRouteBootstrap | null }) {
  const [bootstrap] = useState<OwnerClaimRouteBootstrap>(() => {
    if (suppliedBootstrap !== null && suppliedBootstrap !== undefined) return suppliedBootstrap;
    // Non-production component mounts cannot capture late. They may resume an
    // existing redacted session checkpoint; otherwise recovery is explicit.
    return ownerClaimBootstrapFromSession();
  });
  const navigate = useNavigate();
  const auth = useAuth();
  const sessionRef = useRef(auth.session);
  sessionRef.current = auth.session;
  const adapterRef = useRef<ReturnType<typeof createOwnerClaimBrowserEffectAdapter> | null>(null);
  if (adapterRef.current === null) {
    adapterRef.current = createOwnerClaimBrowserEffectAdapter({
      getSession: () => sessionRef.current,
      navigate: (destination) => { void navigate(destination, { replace: true }); },
    });
  }
  const adapter = adapterRef.current;
  const [machineState, setMachineState] = useState<OwnerClaimMachineState>(() =>
    createOwnerClaimMachineState({ finish: bootstrap.finish }),
  );
  const coordinatorRef = useRef<ReturnType<typeof createOwnerClaimCoordinator> | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createOwnerClaimCoordinator({
      effects: adapter.effects,
      eventSink: ownerClaimQualificationEventSink(),
      initialState: createOwnerClaimMachineState({ finish: bootstrap.finish }),
      onStateChange: (state) => setMachineState(state),
    });
  }
  const coordinator = coordinatorRef.current;
  const pendingCoordinatorDisposalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapDispatchedRef = useRef(false);

  useEffect(() => {
    if (pendingCoordinatorDisposalRef.current !== null) {
      clearTimeout(pendingCoordinatorDisposalRef.current);
      pendingCoordinatorDisposalRef.current = null;
    }
    if (!bootstrapDispatchedRef.current) {
      bootstrapDispatchedRef.current = true;
      if (bootstrap.terminalRecovery) {
        coordinator.dispatch({ type: "terminal-recovery" });
      } else {
        coordinator.dispatch({
          type: "capture",
          outcome: bootstrap.capture === "captured" ? "captured" : bootstrap.capture === "invalid" ? "invalid" : "absent",
        });
        if (bootstrap.checkpoint !== null) coordinator.dispatch({ type: "checkpoint", checkpoint: bootstrap.checkpoint });
      }
    }
    return () => {
      // React StrictMode deliberately performs setup -> cleanup -> setup on
      // the same mounted component. Defer final disposal one task so a
      // superseding setup can cancel it and retain this coordinator; a real
      // unmount has no successor and aborts every in-flight operation on the
      // next task.
      pendingCoordinatorDisposalRef.current = setTimeout(() => coordinator.dispose(), 0);
    };
  }, [bootstrap, coordinator]);

  useEffect(() => {
    coordinator.dispatch({ type: "auth", auth: auth.session.state });
  }, [auth.session.state, coordinator]);

  return (
    <OwnerClaimRenderer
      state={machineState}
      identityName={auth.session.identity?.name}
      initialNewOwnerHandle={adapter.newOwnerHandle()}
      recoveryCodes={adapter.recoveryCodes()}
      onNewOwner={(handle) => {
        adapter.setNewOwnerHandle(handle);
        coordinator.dispatch({ type: "begin-signup" });
      }}
      onResume={() => coordinator.dispatch({ type: "begin-resume" })}
      onSwitchAccount={() => coordinator.dispatch({ type: "switch-account" })}
      onProfile={(profile) => {
        adapter.setProfileInput(profile);
        coordinator.dispatch({ type: "submit-profile" });
      }}
      onRecoveryAcknowledged={() => coordinator.dispatch({ type: "recovery-acknowledged" })}
      onRetry={() => coordinator.dispatch({ type: "retry" })}
    />
  );
}
