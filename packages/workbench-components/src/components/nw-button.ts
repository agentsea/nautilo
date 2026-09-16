import { LitElement, css, html } from "lit";

export class NwButton extends LitElement {
  static override properties = {
    action: { type: String, attribute: "data-action" },
  };

  declare action: string;

  constructor() {
    super();
    this.action = "";
  }

  static override styles = css`
    :host {
      display: inline-block;
    }
    button {
      appearance: none;
      border: 1px solid #1d4ed8;
      background: #2563eb;
      color: #fff;
      font: inherit;
      font-weight: 600;
      padding: 0.45rem 0.85rem;
      border-radius: 8px;
      cursor: pointer;
    }
    button:hover {
      background: #1d4ed8;
    }
    button:active {
      transform: translateY(1px);
    }
    button:focus-visible {
      outline: 2px solid #93c5fd;
      outline-offset: 2px;
    }
  `;

  override render() {
    return html`
      <button type="button" part="control" @click=${this.#emitAction}>
        <slot></slot>
      </button>
    `;
  }

  #emitAction = (): void => {
    this.dispatchEvent(
      new CustomEvent("nw-action", {
        bubbles: true,
        composed: true,
        detail: { action: this.action },
      }),
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-button": NwButton;
  }
}
