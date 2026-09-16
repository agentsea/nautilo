import { LitElement, css, html } from "lit";

export class NwDoc extends LitElement {
  static override styles = css`
    :host {
      display: block;
      color: #0f172a;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      line-height: 1.55;
      max-width: 72ch;
    }
    article {
      padding: 0.25rem 0;
    }
    ::slotted(h1),
    ::slotted(h2),
    ::slotted(h3) {
      line-height: 1.2;
      margin: 1.25em 0 0.5em;
    }
    ::slotted(h1) {
      font-size: 1.75rem;
    }
    ::slotted(h2) {
      font-size: 1.35rem;
    }
    ::slotted(h3) {
      font-size: 1.15rem;
    }
    ::slotted(p),
    ::slotted(ul),
    ::slotted(ol),
    ::slotted(blockquote),
    ::slotted(pre) {
      margin: 0.65em 0;
    }
    ::slotted(ul),
    ::slotted(ol) {
      padding-left: 1.35em;
    }
    ::slotted(code) {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      padding: 0.1em 0.35em;
      border-radius: 4px;
    }
    ::slotted(pre) {
      background: #0f172a;
      color: #e2e8f0;
      padding: 0.85rem 1rem;
      border-radius: 8px;
      overflow: auto;
    }
  `;

  override render() {
    return html`<article part="body"><slot></slot></article>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-doc": NwDoc;
  }
}
