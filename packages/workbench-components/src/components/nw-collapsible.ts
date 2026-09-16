import { LitElement, css, html } from "lit";

export class NwCollapsible extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
  };

  declare open: boolean;

  constructor() {
    super();
    this.open = false;
  }

  static override styles = css`
    :host {
      display: block;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #fff;
      overflow: hidden;
    }
    button {
      width: 100%;
      text-align: left;
      border: 0;
      background: #f8fafc;
      padding: 0.65rem 0.85rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    button::after {
      content: "▾";
      opacity: 0.65;
      transition: transform 120ms ease;
    }
    :host([open]) button::after {
      transform: rotate(-180deg);
    }
    .content {
      padding: 0.65rem 0.85rem;
      border-top: 1px solid #e2e8f0;
    }
    .content[hidden] {
      display: none;
    }
  `;

  override render() {
    return html`
      <button
        type="button"
        part="trigger"
        aria-expanded=${this.open ? "true" : "false"}
        @click=${this.#toggle}
      >
        <span><slot name="summary">Details</slot></span>
      </button>
      <div class="content" part="content" ?hidden=${!this.open}>
        <slot></slot>
      </div>
    `;
  }

  #toggle = (): void => {
    this.open = !this.open;
    this.dispatchEvent(
      new CustomEvent("nw-collapsible-toggle", {
        bubbles: true,
        composed: true,
        detail: { open: this.open },
      }),
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-collapsible": NwCollapsible;
  }
}
