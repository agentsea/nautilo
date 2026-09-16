import { LitElement, css, html } from "lit";

export class NwList extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .frame {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 0.35rem 0.5rem;
      background: #fff;
    }
    ::slotted(ul) {
      margin: 0;
      padding-left: 0;
      list-style: none;
    }
    ::slotted(li) {
      position: relative;
      padding: 0.35rem 0.35rem 0.35rem 1.75rem;
      border-radius: 6px;
      cursor: pointer;
      user-select: none;
    }
    ::slotted(li:hover) {
      background: #f8fafc;
    }
    ::slotted(li)::before {
      content: "";
      position: absolute;
      left: 0.35rem;
      top: 50%;
      transform: translateY(-50%);
      width: 1rem;
      height: 1rem;
      border: 1px solid #94a3b8;
      border-radius: 3px;
      background: #fff;
      box-sizing: border-box;
    }
    ::slotted(li[data-checked="true"])::before {
      background: #2563eb;
      border-color: #1d4ed8;
      box-shadow: inset 0 0 0 2px #fff;
    }
  `;

  constructor() {
    super();
    this.addEventListener("click", this.#onHostClick);
  }

  override render() {
    return html`<div class="frame" part="frame"><slot></slot></div>`;
  }

  #onHostClick = (event: MouseEvent): void => {
    const path = event.composedPath();
    for (const node of path) {
      if (node === this) {
        break;
      }
      if (node instanceof HTMLLIElement && this.#isSlottedListItem(node)) {
        const wasChecked = node.getAttribute("data-checked") === "true";
        const checked = !wasChecked;
        node.setAttribute("data-checked", checked ? "true" : "false");
        node.setAttribute("aria-checked", checked ? "true" : "false");
        this.dispatchEvent(
          new CustomEvent("nw-list-change", {
            bubbles: true,
            composed: true,
            detail: { id: node.id || "", checked, item: node },
          }),
        );
        return;
      }
    }
  };

  #isSlottedListItem(li: HTMLLIElement): boolean {
    const root = li.parentElement;
    if (!root) {
      return false;
    }
    if (root.tagName === "UL" || root.tagName === "OL") {
      return this.contains(root);
    }
    return false;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "nw-list": NwList;
  }
}
