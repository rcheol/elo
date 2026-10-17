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
  assert.match(await ranking.locator(`#historyList [data-match-id="${savedId}"] a[href*="/live/replay.html"]`).textContent(), /상세 기록/);
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
  // Older APKs may still send the legacy video command; their links remain readable.
  const linked = await page.request.post(`${origin}/api/live/sessions/${stored.id}/commands`, { data: {
    operationId: crypto.randomUUID(), expectedRevision: stored.revision, type: "video", capturedAt: Date.now(),
    youtubeUrl: "https://youtu.be/nf_W8XZa_mg", videoOffsetSeconds: 3625,
  } });
  assert.equal(linked.status(), 200);
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
  // The same scoring workflow now lives in the homepage, without an iframe or a second login.
  const home = await context.newPage();
  const homeErrors = [];
  home.on("console", (message) => { if (message.type() === "error" && !message.text().includes("net::ERR_FAILED")) homeErrors.push(message.text()); });
  home.on("pageerror", (error) => errors.push(error.message));
  await home.route("https://unpkg.com/**", (route) => route.abort());
  await home.goto(origin);
  await home.waitForFunction(() => window.badmintonEloAppReady);
  await home.locator("honey-live #pointA:enabled").waitFor();
  assert.equal(await home.locator("honey-live iframe").count(), 0);
  assert.equal(await home.locator("honey-live #overlayUrl").inputValue(), fixedUrl);
  assert.equal(await home.locator("honey-live #video").isVisible(), false);
  assert.equal(await home.locator("#videoMatchPanel").getAttribute("open"), null);
  await home.locator("honey-live #pointA").click();
  await home.locator("honey-live #pointB:enabled").click();
  for (const width of [320, 390, 1365]) {
    await home.setViewportSize({ width, height: 900 });
    await home.locator("#broadcastTitle").scrollIntoViewIfNeeded();
    assert.ok(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const controlBounds = await home.locator("honey-live .score-controls").boundingBox();
    const aBounds = await home.locator("honey-live #pointA").boundingBox();
    const bBounds = await home.locator("honey-live #pointB").boundingBox();
    assert.ok(aBounds.x + aBounds.width <= bBounds.x);
    assert.ok(bBounds.x + bBounds.width <= controlBounds.x + controlBounds.width + 1);
    await home.screenshot({ path: fileURLToPath(new URL(`homepage-broadcast-${width}.png`, output)) });
  }
  await home.locator("honey-live #finish").click();
  await home.locator("honey-live #matchEnded").check();
  await home.locator("honey-live #endConfirm").click();
  await home.locator("honey-live #new:visible").waitFor();
  await home.waitForFunction(() => document.querySelectorAll("#historyList [data-match-id]").length === 2);
  const newMatchId = await home.locator("honey-live #replay").getAttribute("href").then((href) => new URL(href, origin).searchParams.get("match"));
  const newPoints = JSON.parse(api.db.prepare("SELECT value FROM live_sessions WHERE match_id=?").get(newMatchId).value).events.filter((event) => event.type === "point" && !event.undone);
  assert.equal(newPoints.length, 3);
  const detail = await context.newPage();
  detail.on("pageerror", (error) => errors.push(error.message));
  await detail.route("https://www.youtube.com/iframe_api", (route) => route.fulfill({ contentType: "text/javascript", body: `
    window.YT = { Player: class {
      constructor(id, options) { setTimeout(() => options.events.onReady(), 0); }
      loadVideoById(options) { window.lastSeek = options; }
      cueVideoById() {}
      pauseVideo() {}
      getCurrentTime() { return 0; }
      getPlayerState() { return 2; }
    } }; window.onYouTubeIframeAPIReady();
  ` }));
  await detail.goto(`${origin}/live/replay.html?match=${newMatchId}`);
  await detail.locator("#videoForm:visible").waitFor();
  assert.equal(await detail.locator("#timeline li").count(), 3);
  await detail.locator('[name="youtubeUrl"]').fill("https://youtu.be/nf_W8XZa_mg");
  await detail.locator("#saveVideo").click();
  await detail.waitForFunction(() => document.querySelector("#saveStatus").textContent.includes("저장되었습니다"));
  assert.match(await detail.locator("#videoNotice").textContent(), /자동 시간 조회 미설정/);
  assert.equal(await detail.locator("#timeline a").count(), 0, "no invented video time when automatic lookup is unavailable");
  await detail.locator('[name="timingMode"]').selectOption("manual");
  await detail.locator('[name="videoOffsetSeconds"]').fill("123.5");
  await detail.locator("#saveVideo").click();
  await detail.locator("#timeline button:enabled").first().waitFor();
  await detail.locator('[data-team="A"]').click();
  assert.equal(await detail.locator("#timeline li").count(), 1);
  assert.match(await detail.locator("#timeline li").textContent(), /A팀 득점/);
  await detail.locator('[data-team="B"]').click();
  assert.equal(await detail.locator("#timeline li").count(), 2);
  const bPoint = newPoints.find((event) => event.team === "B");
  assert.match(await detail.locator("#timeline a").first().getAttribute("href"), new RegExp(`&t=${Math.floor(bPoint.elapsedMs / 1000 + 123.5)}s$`));
  await detail.locator("#playAll").click();
  assert.equal(await detail.evaluate(() => window.lastSeek.startSeconds), Math.max(0, bPoint.elapsedMs / 1000 + 123.5 - 8));
  await detail.reload();
  await detail.locator("#timeline button:enabled").first().waitFor();
  assert.equal(await detail.locator("#timeline li").count(), 3);
  for (const width of [320, 390, 1365]) {
    await detail.setViewportSize({ width, height: 900 });
    assert.ok(await detail.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await detail.screenshot({ path: fileURLToPath(new URL(`match-details-${width}.png`, output)), fullPage: true });
  }
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.route("https://www.youtube.com/**", (route) => route.abort());
  await guestPage.goto(`${origin}/live/replay.html?match=${newMatchId}`);
  await guestPage.locator("#timeline li").first().waitFor();
  assert.equal(await guestPage.locator("#videoForm").isVisible(), false);
  assert.equal(await guestPage.locator("#timeline a").count(), 3);
  await guestPage.route("https://unpkg.com/**", (route) => route.abort());
  await guestPage.goto(origin);
  await guestPage.waitForFunction(() => document.querySelector("honey-live")?.shadowRoot?.querySelector("#status")?.textContent.includes("로그인"));
  assert.equal(await guestPage.locator("honey-live #setup").isVisible(), false);
  await guest.close();
  const manualResponse = await home.request.post(`${origin}/api/matches`, { data: {
    teamA: ["p1", "p2"], teamB: ["p3", "p4"], scoreA: 21, scoreB: 19, playedAt: new Date().toISOString(),
  } });
  assert.equal(manualResponse.status(), 201);
  const manualMatch = (await manualResponse.json()).matches.find((match) => !match.liveSessionId);
  await detail.goto(`${origin}/live/replay.html?match=${manualMatch.id}`);
  await detail.locator("#matchSummary:visible").waitFor();
  assert.equal(await detail.locator("#emptyTimeline").isVisible(), true);
  assert.equal(await detail.locator("#timeline li").count(), 0);
  assert.equal(await detail.locator("#videoForm").isVisible(), true);
  assert.equal(await detail.locator("#timingFields").isVisible(), false);
  await home.locator("honey-live #new").click();
  assert.equal(await home.locator("honey-live #overlayUrl").inputValue(), fixedUrl);
  assert.equal(await home.locator("honey-live #setup").isVisible(), true);
  api.db.prepare("UPDATE users SET role='admin' WHERE id='test-owner'").run();
  await home.reload();
  await home.waitForFunction(() => window.badmintonEloAppReady);
  assert.equal(await home.locator("#historyList .history-detail-link").count(), 3, JSON.stringify(homeErrors));
  for (const width of [320, 390, 1365]) {
    await home.setViewportSize({ width, height: 900 });
    await home.locator("#historyTitle").scrollIntoViewIfNeeded();
    assert.ok(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await home.screenshot({ path: fileURLToPath(new URL(`homepage-history-admin-${width}.png`, output)) });
  }
  assert.deepEqual(errors, []);
  console.log("Live UI: homepage scoring, save/retry/reload, fixed scoreboard, late video attachment, unknown timing, team filters, exact seeks and guest permissions passed at 320/390/1365px");
} finally { await browser.close(); await new Promise((resolve) => api.server.close(resolve)); api.db.close(); }
