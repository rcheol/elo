import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_TEST_MODULE || "playwright");
const html = await readFile(new URL("../surge-deploy/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../surge-deploy/styles.css", import.meta.url), "utf8");
const output = new URL("../tmp/player-registration-ui/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });

try {
  for (const width of [1365, 981, 1024, 1280, 1920, 980, 681, 680, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.route("**/*", (route) => route.abort());
    // Keep the real page grid, but isolate layout tests from APIs and stored accounts.
    const markup = await page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, "text/html");
      doc.querySelectorAll('script, link[rel="stylesheet"]').forEach((el) => el.remove());
      return doc.documentElement.outerHTML;
    }, html);
    await page.setContent(markup);
    await page.addStyleTag({ content: css });
    await page.locator("#playerName").fill("Layout test player");
    await page.locator("#playerRating").fill("1500");
    await page.locator("#playerGender").selectOption("female");

    for (const role of ["admin", "manager"]) {
      await page.locator("#rosterAuthNote").evaluate((el, value) => {
        el.textContent = `${value} account: player registration`;
      }, role);
      const layout = await page.locator("#playerForm").evaluate((form) => {
        const rect = (el) => {
          const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
          return { left, right, top, bottom, width, height };
        };
        return {
          form: rect(form),
          name: rect(form.querySelector("#playerName")),
          fields: [...form.querySelectorAll(":scope > label, :scope > button")].map(rect),
          contents: [...form.querySelectorAll("label > span, input, select, button")].map(rect),
        };
      });
      await page.locator(".roster-panel").screenshot({
        path: fileURLToPath(new URL(`roster-${width}-${role}.png`, output)),
      });
      assert.ok(layout.name.width >= 150, `${width}px ${role}: name field collapsed (${layout.name.width}px)`);
      for (const rect of layout.contents) {
        assert.ok(rect.left >= layout.form.left - 1 && rect.right <= layout.form.right + 1,
          `${width}px ${role}: field extends outside registration form`);
      }
      for (let i = 0; i < layout.fields.length; i += 1) {
        for (const other of layout.fields.slice(i + 1)) {
          const field = layout.fields[i];
          const overlapX = Math.min(field.right, other.right) - Math.max(field.left, other.left);
          const overlapY = Math.min(field.bottom, other.bottom) - Math.max(field.top, other.top);
          assert.ok(overlapX <= 0 || overlapY <= 0, `${width}px ${role}: registration fields overlap`);
        }
      }
    }

    await page.locator("#playerForm").evaluate((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        form.dataset.submitted = "true";
      });
    });
    await page.locator('#playerForm button[type="submit"]').click();
    assert.equal(await page.locator("#playerForm").getAttribute("data-submitted"), "true");
    assert.equal(await page.locator("#playerName").inputValue(), "Layout test player");
    assert.equal(await page.locator("#playerRating").inputValue(), "1500");
    await page.close();
    console.log(`Player registration ${width}px (admin/manager): passed`);
  }
} finally {
  await browser.close();
}
