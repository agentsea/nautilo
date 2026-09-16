import { LitElement, css, html } from "lit";

export class NwCard extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    section {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 0.85rem 1rem;
      background: #ffffff;
      box-shadow: 0 1px 2px rgb(15 23 42 / 0.06);
    }
  `;

  override render() {
    return html`<section part="card"><slot></slot></section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-card": NwCard;
  }
}
