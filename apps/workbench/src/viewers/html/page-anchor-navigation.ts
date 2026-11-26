/** Fragment links in srcdoc must scroll locally instead of resolving against the host URL. */
export function htmlPageAnchorNavigationScript(): string {
  return `document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = link && link.getAttribute("href");
    if (!href || !href.startsWith("#")) return;
    event.preventDefault();
    if (href === "#") { window.scrollTo(0, 0); return; }
    let id;
    try { id = decodeURIComponent(href.slice(1)); } catch { return; }
    const target = document.getElementById(id) || Array.from(document.getElementsByName(id)).find(element => element.tagName === "A");
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    if (target instanceof HTMLElement) {
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
      }
      target.focus({ preventScroll: true });
    }
  }, true);`;
}
