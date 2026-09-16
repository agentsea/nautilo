import { LitElement, css, html } from "lit";

export class NwInput extends LitElement {
  static override properties = {
    value: { type: String },
  };

  declare value: string;

  constructor() {
    super();
    this.value = "";
  }

  static override styles = css`
    :host {
      display: block;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      font-size: 0.9rem;
      color: #334155;
    }
    input {
      font: inherit;
      padding: 0.45rem 0.55rem;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      min-width: 12rem;
    }
    input:focus-visible {
      outline: 2px solid #93c5fd;
      outline-offset: 1px;
    }
  `;

  override render() {
    return html`
      <label part="label">
        <span class="label"><slot name="label">Input</slot></span>
        <input
          part="field"
          type="text"
          .value=${this.value}
          @input=${this.#onInput}
        />
      </label>
    `;
  }

  #onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.value = target.value;
    this.dispatchEvent(
      new CustomEvent("nw-input-change", {
        bubbles: true,
        composed: true,
        detail: { value: this.value },
      }),
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-input": NwInput;
  }
}
