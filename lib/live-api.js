import crypto from "node:crypto";
import { LiveError, createLiveSession, publicLiveSession, isUuid } from "../surge-deploy/live/engine.js";

export function createLiveApi({ store, authenticate, players, mutate, matchExists, readBody, sendJson }) {
  return async (req, res, url) => {
    const route = url.pathname.slice("/api/live".length);
    const method = req.method;
    const error = (status, code, message) => { throw new LiveError(status, code, message); };
    if (method !== "GET") {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        error(403, "LIVE_ORIGIN", "다른 사이트에서의 조작은 허용되지 않습니다.");
      }
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) error(415, "LIVE_JSON", "JSON 요청이 필요합니다.");
    }
    const channelToken = route.match(/^\/channel-overlay\/([a-f0-9]{48})$/);
    if (method === "GET" && channelToken) {
      const channel = await store.findChannel(channelToken[1]);
      if (!channel) error(404, "LIVE_NOT_FOUND", "점수판을 찾을 수 없습니다.");
      const session = channel.session;
      // Revisions restart at zero for each game; session ID must participate in caching.
      const etag = `"channel-${session?.id || "waiting"}-${session?.revision ?? 0}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: etag });
      res.end(JSON.stringify({ session: session ? publicLiveSession(session, false, true) : null }));
      return;
    }
    const token = route.match(/^\/overlay\/([a-f0-9]{48})$/);
    const replay = route.match(/^\/replay\/([a-f0-9-]{36})$/i);
    if (method === "GET" && (token || replay)) {
      const session = await store.find(token ? "token" : "match_id", token ? token[1] : replay[1]);
      if (!session || (replay && (session.status !== "finished" || !await matchExists(session.matchId)))) {
        error(404, "LIVE_NOT_FOUND", "중계 기록을 찾을 수 없습니다.");
      }
      const etag = `"live-${session.revision}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: etag });
      res.end(JSON.stringify(publicLiveSession(session, false, Boolean(token))));
      return;
    }
    const user = await authenticate(req);
    if (!user) error(401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (method === "GET" && route === "/bootstrap") {
      sendJson(req, res, 200, { user, players: await players(), channelToken: await store.ensureChannel(user.id) }); return;
    }
    if (method === "GET" && route === "/current") {
      const session = await store.find("owner_id", user.id);
      sendJson(req, res, 200, { session: session ? publicLiveSession(session, true) : null }); return;
    }
    if (method === "POST" && route === "/sessions") {
      const input = await readBody(req);
      if (!isUuid(input.id)) error(400, "LIVE_ID", "중계 식별자가 올바르지 않습니다.");
      const session = await store.create(createLiveSession(input, user.id, await players(), input.id, crypto.randomBytes(24).toString("hex")));
      sendJson(req, res, 200, publicLiveSession(session, true)); return;
    }
    const sessionRoute = route.match(/^\/sessions\/([a-f0-9-]{36})(\/commands)?$/i);
    if (sessionRoute && method === "GET" && !sessionRoute[2]) {
      const session = await store.find("id", sessionRoute[1]);
      store.checkOwner(session, user.id);
      sendJson(req, res, 200, publicLiveSession(session, true, url.searchParams.get("compact") === "1")); return;
    }
    if (sessionRoute && method === "POST" && sessionRoute[2]) {
      const command = await readBody(req);
      const session = await mutate(sessionRoute[1], command, user, req);
      sendJson(req, res, 200, publicLiveSession(session, true, url.searchParams.get("compact") === "1")); return;
    }
    error(404, "NOT_FOUND", "요청을 찾을 수 없습니다.");
  };
}
