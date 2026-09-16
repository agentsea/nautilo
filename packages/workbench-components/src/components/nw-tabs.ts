import { LitElement, css, html } from "lit";

export class NwTabs extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .tablist {
      display: flex;
      gap: 0.35rem;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 0.35rem;
      margin-bottom: 0.65rem;
    }
    ::slotted([slot="tab"]) {
      border: 1px solid transparent;
      background: #f1f5f9;
      color: #0f172a;
      padding: 0.35rem 0.65rem;
      border-radius: 8px 8px 0 0;
      cursor: pointer;
      font: inherit;
    }
    ::slotted([slot="tab"][data-active="true"]) {
      background: #fff;
      border-color: #e2e8f0;
      border-bottom-color: #fff;
      margin-bottom: -1px;
      font-weight: 600;
    }
    .panels ::slotted([slot="panel"]) {
      display: none;
    }
    .panels ::slotted([slot="panel"][data-active="true"]) {
      display: block;
    }
  `;

  #abort?: AbortController;

  override render() {
    return html`
      <div class="wrap" part="tabs">
        <div class="tablist" role="tablist">
          <slot name="tab" @slotchange=${this.#sync}></slot>
        </div>
        <div class="panels" part="panels">
          <slot name="panel" @slotchange=${this.#sync}></slot>
        </div>
      </div>
    `;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => {
      this.#sync();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#abort?.abort();
  }

  #sync = (): void => {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const tabSlot = this.renderRoot.querySelector<HTMLSlotElement>('slot[name="tab"]');
    const panelSlot = this.renderRoot.querySelector<HTMLSlotElement>('slot[name="panel"]');
    if (!tabSlot || !panelSlot) {
      return;
    }

    const tabs = [...tabSlot.assignedElements({ flatten: true })];
    const panels = [...panelSlot.assignedElements({ flatten: true })];

    const tabIds = tabs.map((t) => t.getAttribute("data-tab") ?? "");
    const panelByTab = new Map(
      panels.map((p) => [p.getAttribute("data-tab") ?? "", p] as const),
    );

    const activate = (tabId: string, options?: { silent?: boolean }): void => {
      for (const tab of tabs) {
        const id = tab.getAttribute("data-tab") ?? "";
        tab.setAttribute("data-active", id === tabId ? "true" : "false");
        tab.setAttribute("aria-selected", id === tabId ? "true" : "false");
        tab.setAttribute("tabindex", id === tabId ? "0" : "-1");
      }
      for (const panel of panels) {
        const id = panel.getAttribute("data-tab") ?? "";
        panel.setAttribute("data-active", id === tabId ? "true" : "false");
      }
      if (!options?.silent) {
        this.dispatchEvent(
          new CustomEvent("nw-tabs-change", {
            bubbles: true,
            composed: true,
            detail: { tab: tabId },
          }),
        );
      }
    };

    const initial =
      tabIds.find((id) => {
        const tab = tabs.find((t) => (t.getAttribute("data-tab") ?? "") === id);
        return tab?.getAttribute("data-active") === "true";
      }) ?? tabIds[0] ?? "";

    if (initial) {
      activate(initial, { silent: true });
    }

    for (const tab of tabs) {
      const id = tab.getAttribute("data-tab") ?? "";
      tab.setAttribute("role", "tab");
      if (!panelByTab.has(id)) {
        tab.setAttribute("aria-disabled", "true");
      } else {
        tab.removeAttribute("aria-disabled");
      }
      tab.addEventListener(
        "click",
        () => {
          if (id) {
            activate(id);
          }
        },
        { signal },
      );
    }

    for (const panel of panels) {
      panel.setAttribute("role", "tabpanel");
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-tabs": NwTabs;
  }
}
