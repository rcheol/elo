import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_TEST_MODULE || "playwright");
const source = await readFile(new URL("../surge-deploy/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../surge-deploy/styles.css", import.meta.url), "utf8");
const output = new URL("../tmp/review-ui/", import.meta.url);
await mkdir(output, { recursive: true });
const functions = ["videoReviewTime", "renderVideoRallyReview", "readVideoReviewInput", "updateVideoReviewTotal"].map((name) => {
  const from = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\nfunction ", from + 1);
  assert.ok(from >= 0 && next > from);
  return source.slice(from, next);
}).join("\n");
const job = { id: "ui-test", videoId: "nf_W8XZa_mg", scoreResult: { review: {
  version: 2, startSeconds: 0, endSeconds: 240, startScoreA: 10, startScoreB: 9,
  rallies: Array.from({ length: 12 }, (_, index) => ({
    id: `r${index + 1}`, start: index * 20, end: index * 20 + 15,
    kind: index === 11 ? "gap" : "rally",
    decision: index >= 10 ? "unknown" : index % 2 ? "A" : "B",
    suggested: "B", reason: index >= 10 ? "unobserved_interval" : "two_pass_agreement",
    evidence: "Visible evidence, including a long unbroken value: " + "x".repeat(120),
  })),
} } };
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [320, 390, 1365]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<style>${css}</style><div style="max-width:680px;margin:20px auto;padding:12px;box-sizing:border-box"><h2>랠리 검토</h2><div id="videoAnalysisPanel"></div></div>`);
    await page.addScriptTag({ content: `
      const currentVideoAnalysisJob = ${JSON.stringify(job)};
      let videoReviewDraft = null;
      const $ = (selector) => document.querySelector(selector);
      const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
      ${functions}
      $('#videoAnalysisPanel').innerHTML = renderVideoRallyReview(currentVideoAnalysisJob);
      $('#videoAnalysisPanel').oninput = updateVideoReviewTotal;
      $('#videoAnalysisPanel').onchange = updateVideoReviewTotal;
      updateVideoReviewTotal();
    ` });
    const button = page.locator("[data-video-confirm-score]");
    assert.equal(await button.isDisabled(), true);
    await page.locator('[data-review-decision="r11"]').selectOption("B");
    await page.locator('[data-review-gap-a="r12"]').fill("1");
    await page.locator('[data-review-gap-b="r12"]').fill("0");
    assert.equal(await button.isDisabled(), true);
    await page.locator("#videoReviewCoverage").check();
    assert.equal(await button.isDisabled(), false);
    assert.equal(await page.locator("#videoReviewTotal").textContent(), "16 : 15");
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      list: [document.querySelector('.video-review-list').clientHeight, document.querySelector('.video-review-list').scrollHeight],
      fieldsFit: [...document.querySelectorAll('input,select')].every((el) => el.getBoundingClientRect().right <= innerWidth),
      checkboxHeight: document.querySelector('#videoReviewCoverage').getBoundingClientRect().height,
    }));
    assert.ok(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics));
    assert.ok(metrics.list[1] > metrics.list[0]);
    assert.ok(metrics.fieldsFit);
    assert.equal(metrics.checkboxHeight, 18);
    await page.screenshot({ path: fileURLToPath(new URL(`review-${width}.png`, output)), fullPage: true });
    await page.locator('[data-review-gap-a="r12"]').fill("");
    assert.equal(await button.isDisabled(), true);
    await page.close();
    console.log(`Review UI ${width}px: passed`);
  }
} finally {
  await browser.close();
}
