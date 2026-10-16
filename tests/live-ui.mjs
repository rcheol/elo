import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_TEST_MODULE || "playwright");
const serverUrl = new URL("../server.js", import.meta.url);
const source = await readFile(serverUrl, "utf8");
const code = `const process={env:{DATABASE_PATH:':memory:'}};\n` + source.slice(0, source.lastIndexOf("\nstart().catch"))
  .replace("const __filename = fileURLToPath(import.meta.url);", `const __filename = ${JSON.stringify(fileURLToPath(serverUrl))};`)
  .replace(/from "(\.\/[^\"]+)"/g, (_, name) => `from ${JSON.stringify(new URL(name, serverUrl).href)}`)
  + "\nexport {server,db,initDb,initLiveApi};";
const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
api.initDb();
api.db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)").run("test-owner", "demo", "테스트 운영자", "unused", "member", new Date().toISOString());
api.db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES (?,?,?,?)").run("demo-session", "test-owner", Date.now() + 3600000, new Date().toISOString());
for (const [i, name] of ["테스트 선수 가", "테스트 선수 나", "테스트 선수 다", "테스트 선수 라"].entries()) {
  api.db.prepare("INSERT INTO players(id,name,normalized_name,seed_rating,created_at) VALUES (?,?,?,?,?)").run(`p${i + 1}`, name, name, 1500, new Date().toISOString());
}
await api.initLiveApi();
await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.server.address().port}`;
const output = new URL("../tmp/live-ui/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: "sid", value: "demo-session", url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await page.goto(`${origin}/live/control.html`);
  await page.locator('[name="aLeft"]').selectOption("p1");
  await page.locator('[name="aRight"]').selectOption("p2");
  await page.locator('[name="bLeft"]').selectOption("p3");
  await page.locator('[name="bRight"]').selectOption("p4");
  await page.locator('#setup button[type="submit"]').click();
  await page.locator("#start").click();
  await page.locator("#pointA").click();
  await page.waitForFunction(() => document.querySelector("#scoreA").textContent === "1");
  await page.locator("#pointB").click();
  await page.waitForFunction(() => document.querySelector("#scoreB").textContent === "1");
  await page.locator("#finish").click();
  await page.locator("#streamStopped").check();
  await page.locator("#endConfirm").click();
  await page.waitForFunction(() => document.querySelector("#endStatus").textContent.includes("동점"));
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 0);
  await page.locator("#endCancel").click();
  await page.locator("#undo").click();
  await page.waitForFunction(() => document.querySelector("#scoreB").textContent === "0");
  for (const width of [320, 390, 1365]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: fileURLToPath(new URL(`control-${width}.png`, output)), fullPage: true });
  }
  const overlay = await context.newPage();
  await overlay.goto(await page.locator("#overlayUrl").inputValue());
  await overlay.waitForFunction(() => document.querySelector("#scoreA").textContent === "1");
  await overlay.screenshot({ path: fileURLToPath(new URL("overlay.png", output)), omitBackground: true });
  await page.locator('[name="youtubeUrl"]').fill("https://youtu.be/nf_W8XZa_mg");
  await page.locator('[name="videoOffsetSeconds"]').fill("25");
  await page.locator('#video button').click();
  await page.waitForFunction(() => !document.querySelector("#pointA").disabled);
  await page.locator("#finish").click();
  assert.equal(await page.locator("#endConfirm").isDisabled(), true);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 0);
  await page.locator("#streamStopped").check();
  assert.equal(await page.locator("#endConfirm").isEnabled(), true);
  // The server commits, but the phone loses the response. A second tap must not duplicate a match.
  const finishIds = [];
  let loseResponse = true;
  await page.route('**/api/live/sessions/*/commands', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "finish") { await route.continue(); return; }
    finishIds.push(command.operationId);
    if (loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      assert.equal((await response.json()).status, "finished");
      await route.abort();
    } else await route.continue();
  });
  await page.locator("#endConfirm").click();
  await page.waitForFunction(() => document.querySelector("#endStatus").classList.contains("error"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: fileURLToPath(new URL("finish-retry-390.png", output)), fullPage: true });
  assert.equal(await page.locator("#endDialog").isVisible(), true);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 1);
  await page.locator("#endConfirm").click();
  await page.waitForFunction(() => !document.querySelector("#replay").hidden);
  assert.equal(finishIds.length, 2); assert.equal(finishIds[0], finishIds[1]);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 1);
  const savedId = api.db.prepare("SELECT id FROM matches").get().id;
  const ranking = await context.newPage();
  await ranking.route("https://unpkg.com/**", (route) => route.abort());
  await ranking.goto(await page.locator("#savedMatch").getAttribute("href").then((href) => origin + href));
  await ranking.waitForFunction(() => window.badmintonEloAppReady);
  assert.equal(await ranking.locator(`#historyList [data-match-id="${savedId}"]`).count(), 1);
  assert.equal(await ranking.locator('#historyList .score-badge').first().textContent(), "1");
  await ranking.close();
  await page.locator("#replay").click();
  await page.waitForFunction(() => document.querySelector("#timeline")?.children.length === 1);
  assert.match(await page.locator("#timeline").textContent(), /A팀 득점/);
  await page.screenshot({ path: fileURLToPath(new URL("replay.png", output)), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Live UI: scoring, confirmation, lost-save response retry, homepage record and replay passed at 320/390/1365px");
} finally { await browser.close(); await new Promise((resolve) => api.server.close(resolve)); api.db.close(); }
