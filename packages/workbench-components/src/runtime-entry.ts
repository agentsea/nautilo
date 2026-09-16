import { NwButton } from "./components/nw-button.js";
import { NwCard } from "./components/nw-card.js";
import { NwCollapsible } from "./components/nw-collapsible.js";
import { NwDoc } from "./components/nw-doc.js";
import { NwInput } from "./components/nw-input.js";
import { NwList } from "./components/nw-list.js";
import { NwTabs } from "./components/nw-tabs.js";
import { installNwState } from "./state-bridge-client.js";

export { NwButton, NwCard, NwCollapsible, NwDoc, NwInput, NwList, NwTabs };
export { nwState } from "./state-bridge-client.js";

const definitions: ReadonlyArray<[string, CustomElementConstructor]> = [
  ["nw-doc", NwDoc],
  ["nw-list", NwList],
  ["nw-card", NwCard],
  ["nw-button", NwButton],
  ["nw-input", NwInput],
  ["nw-tabs", NwTabs],
  ["nw-collapsible", NwCollapsible],
];

for (const [name, ctor] of definitions) {
  if (!customElements.get(name)) {
    customElements.define(name, ctor);
  }
}

// D121-P3 — expose window.nwState for the artifact's own JS to call.
installNwState();
