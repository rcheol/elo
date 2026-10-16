import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_TEST_MODULE || "playwright");
import { elapsedTime } from "../surge-deploy/live/timeline.js";
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
  await page.waitForFunction(() => document.querySelector("#overlayUrl").value.includes("#channel/"));
  const fixedUrl = await page.locator("#overlayUrl").inputValue();
  const overlay = await context.newPage();
  await overlay.goto(fixedUrl);
  await overlay.waitForFunction(() => document.querySelector("#status").textContent === "다음 경기 대기");
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
  await page.locator("#matchEnded").check();
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
  assert.equal(await page.locator("#overlayUrl").inputValue(), fixedUrl);
  await overlay.waitForFunction(() => document.querySelector("#scoreA").textContent === "1");
  await overlay.screenshot({ path: fileURLToPath(new URL("overlay.png", output)), omitBackground: true });
  await page.locator("#finish").click();
  assert.equal(await page.locator("#endConfirm").isDisabled(), true);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 0);
  await page.locator("#matchEnded").check();
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
  await overlay.waitForFunction(() => document.querySelector("#status").textContent.includes("경기 종료"));
  assert.equal(finishIds.length, 2); assert.equal(finishIds[0], finishIds[1]);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 1);
  const savedId = api.db.prepare("SELECT id FROM matches").get().id;
  const stored = JSON.parse(api.db.prepare("SELECT value FROM live_sessions WHERE match_id=?").get(savedId).value);
  const savedPoints = stored.events.filter((event) => event.type === "point" && !event.undone);
  assert.equal(await page.locator("#pointTimeline li").count(), 1);
  const originalTimeline = await page.locator("#pointTimeline").textContent();
  assert.match(originalTimeline, /KST/);
  assert.match(originalTimeline, /경기 \d+:\d\d/);
  assert.match(await page.locator("#status").textContent(), /득점 시각 1건 저장됨/);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector("#savedTimeline").hidden);
  assert.equal(await page.locator("#pointTimeline").textContent(), originalTimeline);
  assert.equal(await page.locator("#pointTimeline time").getAttribute("datetime"), new Date(savedPoints[0].capturedAt).toISOString());
  const ranking = await context.newPage();
  await ranking.route("https://unpkg.com/**", (route) => route.abort());
  await ranking.goto(await page.locator("#savedMatch").getAttribute("href").then((href) => origin + href));
  await ranking.waitForFunction(() => window.badmintonEloAppReady);
  assert.equal(await ranking.locator(`#historyList [data-match-id="${savedId}"]`).count(), 1);
  assert.equal(await ranking.locator('#historyList .score-badge').first().textContent(), "1");
  assert.equal(await ranking.locator(`#historyList [data-match-id="${savedId}"] a[href*="/live/replay.html"]`).textContent(), "득점 시각 · 영상 보기");
  await ranking.close();
  const replay = await context.newPage();
  let youtubeRequests = 0;
  replay.on("request", (request) => { if (request.url().includes("youtube.com")) youtubeRequests++; });
  await replay.route("https://www.youtube.com/iframe_api", (route) => route.fulfill({ contentType: "text/javascript", body: `
    window.YT = { Player: class {
      constructor(id, options) { window.videoOptions = options; setTimeout(() => options.events.onReady(), 0); }
      loadVideoById(options) { window.lastSeek = options; }
      pauseVideo() {}
      getCurrentTime() { return 0; }
      getPlayerState() { return 2; }
    } };
    window.onYouTubeIframeAPIReady();
  ` }));
  await replay.goto(origin + await page.locator("#replay").getAttribute("href"));
  await replay.waitForFunction(() => document.querySelector("#timeline")?.children.length === 1);
  assert.match(await replay.locator("#timeline").textContent(), /A팀 득점/);
  assert.match(await replay.locator("#status").textContent(), /1건 저장됨 · 영상 미연결/);
  assert.equal(await replay.locator("#timeline time").getAttribute("datetime"), new Date(savedPoints[0].capturedAt).toISOString());
  assert.equal(youtubeRequests, 0, "a video is not required to read the saved timestamps");
  for (const width of [320, 390, 1365]) {
    await replay.setViewportSize({ width, height: 844 });
    assert.ok(await replay.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await replay.screenshot({ path: fileURLToPath(new URL(`timestamps-no-video-${width}.png`, output)), fullPage: true });
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: fileURLToPath(new URL(`timestamps-saved-${width}.png`, output)), fullPage: true });
  }
  // A video added after saving changes only the video time, not the saved point time.
  await page.locator('[name="youtubeUrl"]').fill("https://youtu.be/nf_W8XZa_mg");
  await page.locator('[name="videoOffsetSeconds"]').fill("3625");
  const linked = page.waitForResponse((response) => response.url().endsWith("/commands") && response.request().postDataJSON()?.type === "video");
  await page.locator('#video button').click();
  assert.equal((await linked).status(), 200);
  await replay.reload();
  await replay.locator("#timeline button:enabled").waitFor();
  const videoTime = savedPoints[0].elapsedMs / 1000 + 3625;
  assert.equal(await replay.locator("#timeline .point-elapsed").textContent(), `경기 ${elapsedTime(savedPoints[0].elapsedMs / 1000)}`);
  assert.equal(await replay.locator("#timeline button").textContent(), `영상 ${elapsedTime(videoTime)}`);
  assert.match(await replay.locator("#timeline a").getAttribute("href"), new RegExp(`&t=${Math.floor(videoTime)}s$`));
  await replay.locator("#timeline button").click();
  assert.equal(await replay.evaluate(() => window.lastSeek.startSeconds), videoTime);
  await replay.locator("#playAll").click();
  assert.equal(await replay.evaluate(() => window.lastSeek.startSeconds), videoTime - 8);
  assert.equal(await replay.locator("#timeline time").getAttribute("datetime"), new Date(savedPoints[0].capturedAt).toISOString());
  await replay.setViewportSize({ width: 320, height: 844 });
  assert.ok(await replay.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await replay.screenshot({ path: fileURLToPath(new URL("timestamps-video-320.png", output)), fullPage: true });
  await replay.evaluate(() => window.videoOptions.events.onError());
  assert.match(await replay.locator("#status").textContent(), /득점 시각 1건 저장됨 · 영상 재생 불가/);
  assert.equal(await replay.locator("#timeline li").count(), 1);
  await replay.close();
  await page.locator("#new").click();
  assert.equal(await page.locator("#overlayUrl").inputValue(), fixedUrl);
  await page.locator('[name="aLeft"]').selectOption("p3");
  await page.locator('[name="aRight"]').selectOption("p4");
  await page.locator('[name="bLeft"]').selectOption("p1");
  await page.locator('[name="bRight"]').selectOption("p2");
  await page.locator('#setup button[type="submit"]').click();
  await overlay.waitForFunction(() => document.querySelector("#status").textContent === "경기 준비");
  assert.equal(await overlay.locator("#scoreA").textContent(), "0");
  assert.match(await overlay.locator("#namesA").textContent(), /테스트 선수 다/);
  await page.locator("#start").click();
  await page.locator("#pointB").click();
  await overlay.waitForFunction(() => document.querySelector("#scoreB").textContent === "1");
  await page.reload();
  await page.waitForFunction(() => !document.querySelector("#pointB").disabled);
  assert.equal(await page.locator("#overlayUrl").inputValue(), fixedUrl);
  assert.equal(overlay.url(), fixedUrl);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 1);
  assert.deepEqual(errors, []);
  console.log("Live UI: timestamp save/retry/reload, no-video ledger, later video linking, exact seek and fixed scoreboard across two games passed at 320/390/1365px");
} finally { await browser.close(); await new Promise((resolve) => api.server.close(resolve)); api.db.close(); }
