import { mountControl } from "./control.js";

// Reuse scoring without duplicate IDs, CSS leaks or nested page scrollbars.
class HoneyLive extends HTMLElement {
  async connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    try {
      const response = await fetch("/live/control.html", { cache: "no-store" });
      if (!response.ok) throw new Error("중계 화면을 불러오지 못했습니다.");
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const main = page.querySelector("main");
      main.querySelector("header").hidden = true;
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/live/live.css";
      root.append(css, main);
      await mountControl(root, true);
    } catch (error) {
      const message = document.createElement("p"); message.textContent = error.message;
      const retry = document.createElement("button"); retry.textContent = "다시 불러오기";
      retry.onclick = () => location.reload();
      root.replaceChildren(message, retry);
    }
  }
}
customElements.define("honey-live", HoneyLive);
