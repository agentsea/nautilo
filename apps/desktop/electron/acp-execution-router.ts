import type {
  AcpRegistrationId,
  RelayAcpContainCommand,
  RelayAcpHostPort,
  RelayAcpHostTransport,
  RelayAcpPrepareCommand,
  RelayAcpReadinessCommand,
  RelayAcpSession,
  RelayAcpStartCommand,
} from "@nautilo/relay";

/** Exact built-in provider dispatch. Registration/disconnect fan out once;
 * every provider-qualified command reaches exactly one host. */
export class ElectronAcpExecutionRouter implements RelayAcpHostPort {
  private session: RelayAcpSession | null = null;
  private transport: RelayAcpHostTransport | null = null;
  private readonly registered = new Set<AcpRegistrationId>();

  constructor(
    private readonly hosts: Readonly<Record<AcpRegistrationId, RelayAcpHostPort>>,
    private readonly options: Readonly<{
      isEnabled?: (registrationId: AcpRegistrationId) => boolean;
    }> = {},
  ) {}

  private enabled(registrationId: AcpRegistrationId): boolean {
    return this.options.isEnabled?.(registrationId) ?? true;
  }

  registrations(): readonly AcpRegistrationId[] {
    return (["hermes-acp", "opencode-acp"] as const).filter((id) => this.enabled(id));
  }

  isReady(): boolean {
    const registrations = this.registrations();
    return registrations.length > 0 && registrations.every((id) => this.hosts[id].isReady?.() === true);
  }

  async onRegistered(session: RelayAcpSession, transport: RelayAcpHostTransport): Promise<void> {
    this.session = session;
    this.transport = transport;
    for (const id of this.registrations()) {
      await this.hosts[id].onRegistered?.(session, transport);
      this.registered.add(id);
    }
  }

  async onDisconnected(): Promise<void> {
    this.session = null;
    this.transport = null;
    this.registered.clear();
    await Promise.all(Object.values(this.hosts).map(async (host) => { await host.onDisconnected?.(); }));
  }

  /** Apply one persisted owner-choice change to the current relay lifecycle. */
  async reconcileRegistration(registrationId: AcpRegistrationId): Promise<void> {
    const active = this.registered.has(registrationId);
    if (!this.enabled(registrationId)) {
      if (active) {
        this.registered.delete(registrationId);
        await this.hosts[registrationId].onDisconnected?.();
      }
      return;
    }
    if (!active && this.session && this.transport) {
      await this.hosts[registrationId].onRegistered?.(this.session, this.transport);
      this.registered.add(registrationId);
    }
  }

  onReadiness(message: RelayAcpReadinessCommand): void | Promise<void> {
    if (!this.enabled(message.registrationId)) {
      this.transport?.send({
        type: "relay:acp-readiness-result",
        requestId: message.requestId,
        scope: message.scope,
        registrationId: message.registrationId,
        state: "unavailable",
      });
      return;
    }
    return this.hosts[message.registrationId].onReadiness?.(message);
  }

  onPrepare(message: RelayAcpPrepareCommand): void | Promise<void> {
    if (!this.enabled(message.registrationId)) return;
    return this.hosts[message.registrationId].onPrepare?.(message);
  }

  onStart(message: RelayAcpStartCommand): void | Promise<void> {
    if (!this.enabled(message.registrationId)) return;
    return this.hosts[message.registrationId].onStart?.(message);
  }

  onContain(message: RelayAcpContainCommand): void | Promise<void> {
    if (!this.enabled(message.registrationId)) return;
    return this.hosts[message.registrationId].onContain?.(message);
  }
}
