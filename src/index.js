/* 우리반 전시회 · Cloudflare 서버 (Workers 무료 요금제용)
 *
 * 전시회 하나 = Durable Object 하나 (Show). 그 안의 SQLite에 머리글·작품·쪽지·방명록·박수를 저장하고,
 * 같은 전시회에 들어온 아이들은 WebSocket 하나로 친구 위치·쪽지·박수를 실시간으로 주고받아요.
 * 선생님 목록 = Durable Object 하나 (Teacher), "선생님 전용 링크"의 비밀값(tk)으로 찾아요.
 * 전체 목록 = Durable Object 하나 (Registry), 운영자 페이지(admin.html)에서만 봐요.
 * 생성 한도 = 인터넷 주소(IP)마다 Durable Object 하나 (Gate), 하루에 만들 수 있는 전시회 수를 세요.
 *
 * 무료 한도 아끼기
 *  - 화면(public/index.html)도 이 서버가 함께 내보내요. 화면 파일 요청은 무료이고 횟수 제한도 없어요.
 *  - 아이 한 명 입장 = HTTP 1번(작품 전체) + WebSocket 연결 1번. 그 뒤 움직임은 WebSocket 메시지라 20개가 요청 1번으로 계산돼요.
 *  - WebSocket Hibernation API를 써서 조용할 때는 실행 시간이 계산되지 않아요.
 *  - 박수는 메모리에 모았다가 2초마다 한 번에 저장해요(쓰기 행 수 절약).
 *
 * 운영자 키: 대시보드에서 ADMIN_KEY 비밀값을 정하면(README 참고) admin.html을 쓸 수 있어요. 정하지 않으면 운영자 기능은 꺼져 있어요.
 */
import { DurableObject } from "cloudflare:workers";

const CODE_RE = /^[A-Z0-9]{6}$/;
const TK_RE = /^[A-Z0-9]{20,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIMIT = { notes: 600, wall: 300 };     // 전시회 하나에 남는 한마디·쪽지 수 (넘으면 오래된 것부터 지워요)
const MAX_WORKS = 60;                        // 전시회 하나의 작품 수 (화면에서는 30점까지 올려요)
const MAX_SHOW_BYTES = 12 * 1024 * 1024;     // 전시회 하나의 작품 용량 (보통 30점 ≈ 3MB)
const MAX_WORK_BYTES = 400000;               // 작품 하나 (사진은 화면에서 약 110KB로 줄여서 보내요)
const MAX_SOCKETS = 120;                     // 전시회 하나에 동시에 들어올 수 있는 기기 수
const NEW_PER_IP_DAY = 60;                   // 같은 인터넷 주소(학교 하나)에서 하루에 만들 수 있는 전시회 수
const WRONG_KEY_MAX = 20;                    // 한 시간에 관리 코드를 이만큼 틀리면 잠시 잠가요
// 자동 정리 (사람이 관리하지 않아도 저장 공간이 차지 않게)
const DAY = 864e5;
const IDLE_DAYS = 365;                       // 선생님도 아이들도 1년 동안 안 들어온 전시회는 지워요
const EMPTY_DAYS = 365;                      // 작품이 0점인 전시회도 1년 동안 손대지 않으면 지워요 (나중에 쓰려고 만들어 둔 것일 수 있어서 넉넉하게)
const SPACE_LIMIT = 4.2e9;                   // 추정 저장량이 이만큼(무료 5GB의 약 84%)을 넘으면 가장 오래 안 쓴 전시회부터 정리해요
const BYTES_PER_WORK = 115000, BYTES_PER_SHOW = 30000;

const rnd = n => { const r = new Uint32Array(n); crypto.getRandomValues(r); return [...r].map(x => ABC[x % ABC.length]).join(""); };
const json = (o, status = 200) => new Response(typeof o === "string" ? o : JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const err = (code, status = 400) => json({ error: code }, status);
const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const showStub = (env, code) => env.SHOW.get(env.SHOW.idFromName(code), { locationHint: "apac" });
const registry = env => env.REGISTRY.get(env.REGISTRY.idFromName("all"), { locationHint: "apac" });
const idleMs = env => +env.TEST_IDLE_MS || IDLE_DAYS * DAY;     // TEST_로 시작하는 값은 테스트용이에요 (실제로는 정하지 마세요)
const emptyMs = env => +env.TEST_EMPTY_MS || EMPTY_DAYS * DAY;
const isAdmin = (env, k) => typeof env.ADMIN_KEY === "string" && env.ADMIN_KEY.length >= 16 && typeof k === "string" && k === env.ADMIN_KEY;

/* ============================== Worker: 길 안내만 해요 ============================== */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    // 3D 도구(three.js): public 폴더에 파일이 없으면 서버가 대신 받아서 우리 주소로 내보내요 (학교에서 바깥 사이트가 막혀도 열리게)
    if (url.pathname === "/three.min.js") return threeJs(req);
    if (p[0] !== "api") return new Response("페이지를 찾지 못했어요.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    // 다른 사이트에서 이 서버를 몰래 쓰지 못하게: 브라우저가 보낸 요청은 같은 주소에서 온 것만 받아요
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return err("origin", 403);
    try {
      if (p[1] === "ping") return json({ ok: true });
      // POST /api/new → { code, key }  (새 전시회 코드와 관리 키를 서버가 만들어요)
      if (p[1] === "new" && req.method === "POST") {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const g = await env.GATE.get(env.GATE.idFromName(ip)).fetch("https://gate/hit?max=" + NEW_PER_IP_DAY);
        if (g.status === 429) return err("rate", 429);
        for (let k = 0; k < 8; k++) {
          const code = rnd(6), key = rnd(6);
          const r = await showStub(env, code).fetch("https://show/init", { method: "POST", headers: { "x-code": code }, body: JSON.stringify({ key }) });
          if (r.status === 200) return json({ code, key });
          if (r.status !== 409) return err("server", 500);
        }
        return err("code", 500);
      }
      // /api/show/CODE[/list/KIND | /op]   /api/live/CODE (WebSocket)
      if ((p[1] === "show" || p[1] === "live") && CODE_RE.test(p[2] || "")) {
        const code = p[2], rest = p[1] === "live" ? "/live" : "/" + p.slice(3).join("/");
        if (!["/", "/live", "/op", "/state", "/post", "/list/notes", "/list/wall"].includes(rest)) return err("not_found", 404);
        const h = new Headers(req.headers); h.set("x-code", code);
        return showStub(env, code).fetch(new Request("https://show" + (rest === "/" ? "/get" : rest), { method: req.method, headers: h, body: req.method === "POST" ? await req.arrayBuffer() : null }));
      }
      // /api/teacher/TK   (GET 목록 읽기, POST 목록 저장)
      if (p[1] === "teacher" && TK_RE.test(p[2] || "")) {
        const stub = env.TEACHER.get(env.TEACHER.idFromName("t:" + p[2]), { locationHint: "apac" });
        if (req.method !== "GET") return stub.fetch(new Request("https://teacher/", { method: req.method, body: req.method === "POST" ? await req.arrayBuffer() : null }));
        // 목록을 줄 때, 그사이 지워진 전시회(자동 정리·다른 기기에서 지움·운영자가 지움)는 빼고 줘요
        const list = await (await stub.fetch("https://teacher/")).json(), codes = (list.shows || []).map(x => x.code);
        if (!codes.length) return json(list);
        const gone = await (await registry(env).fetch("https://registry/gone?codes=" + codes.join(","))).json();
        if (!gone.length) return json(list);
        list.shows = list.shows.filter(x => !gone.includes(x.code));
        await stub.fetch("https://teacher/", { method: "POST", body: JSON.stringify({ shows: list.shows }) });
        return json(list);
      }
      // GET /api/admin/shows  (운영자: 전체 전시회 목록)
      if (p[1] === "admin" && p[2] === "shows") {
        if (!isAdmin(env, req.headers.get("x-admin"))) return err("admin", 403);
        return registry(env).fetch("https://registry/list");
      }
      return err("not_found", 404);
    } catch (e) {
      // 무료 한도를 넘었을 때도 여기로 와요 (한국 시간 오전 9시에 다시 열려요)
      return err(/limit|exceeded|quota/i.test(String(e && e.message)) ? "quota" : "server", 503);
    }
  },
};

async function threeJs(req) {
  const cache = caches.default, key = new Request("https://woorigallery.cache/three-r128.min.js");
  let r = await cache.match(key);
  if (!r) {
    for (const u of ["https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js", "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js", "https://unpkg.com/three@0.128.0/build/three.min.js"]) {
      try { const f = await fetch(u); if (f.ok) { r = new Response(await f.arrayBuffer(), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } }); await cache.put(key, r.clone()); break; } } catch (_) {}
    }
    if (!r) return new Response("", { status: 404 });
  }
  return r;
}

/* ============================== 전시회 하나 ============================== */
export class Show extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS rows (kind TEXT NOT NULL, id TEXT NOT NULL, v TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id))");
    this.cache = null;   // 아이들이 받아 가는 { head, works } 응답을 메모리에 들고 있어요 (읽기 행 수 절약)
    this.claps = null;   // { 작품id: 숫자 }
    this.pending = new Set(); this.flushT = 0;
    this.wrong = [];     // 관리 코드를 틀린 시각들
    // 아이들 기기가 보내는 연결 확인(ping)은 서버를 깨우지 않고 바로 답해요 (요금·실행 시간 0)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /* --- SQLite 도우미 --- */
  one(kind, id) { const r = this.sql.exec("SELECT v FROM rows WHERE kind = ? AND id = ?", kind, id).toArray()[0]; return r ? r.v : null; }
  put(kind, id, v, ts = 0) { this.sql.exec("INSERT OR REPLACE INTO rows (kind, id, v, ts) VALUES (?, ?, ?, ?)", kind, id, v, ts); }
  del(kind, id) { this.sql.exec("DELETE FROM rows WHERE kind = ? AND id = ?", kind, id); }
  all(kind) { return this.sql.exec("SELECT id, v FROM rows WHERE kind = ? ORDER BY ts, id", kind).toArray(); }
  head() { const v = this.one("m", "head"); return v ? JSON.parse(v) : null; }
  rows(kind) { return this.all(kind).map(r => Object.assign(JSON.parse(r.v), { _id: r.id })); }
  clapMap() { if (!this.claps) { this.claps = {}; for (const r of this.all("c")) this.claps[r.id] = +r.v || 0; } return this.claps; }
  workStats(exceptId) { return this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(v)), 0) AS b FROM rows WHERE kind = 'w' AND id != ?", exceptId || "").one(); }
  // 전체 목록(운영자용)에 알려요. 실패해도 전시회 저장은 그대로 돼요
  async tellRegistry(code, body) { try { await registry(this.env).fetch("https://registry/" + code, { method: "POST", body: JSON.stringify(body) }); } catch (_) {} }

  // 누가 들어오거나 고치면 "마지막 사용일"을 하루에 한 번만 적고, 그날로부터 1년 뒤에 정리 알람을 맞춰요
  async touch(code) {
    const now = Date.now(), every = Math.min(DAY, idleMs(this.env) / 10);
    if (this.seen === undefined) this.seen = +this.one("m", "seen") || 0;
    if (now - this.seen < every) return;
    this.seen = now; this.put("m", "seen", String(now));
    if (this.workStats().n > 0) await this.ctx.storage.setAlarm(now + idleMs(this.env));
    await this.tellRegistry(code, { seen: now });
  }
  // 정리 알람: 빈 전시회는 만든 지 3일, 쓰던 전시회는 마지막 사용 후 1년이 지났으면 지워요
  async alarm() {
    const head = this.head(); if (!head) return;
    const now = Date.now(), n = this.workStats().n, created = +this.one("m", "created") || now, seen = +this.one("m", "seen") || created;
    if (n === 0 && now - created >= emptyMs(this.env)) return this.wipe(head.code, "empty");
    if (n > 0 && now - seen >= idleMs(this.env)) return this.wipe(head.code, "idle");
    await this.ctx.storage.setAlarm(n === 0 ? created + emptyMs(this.env) : seen + idleMs(this.env));
  }
  // 전시회를 지워요. 같은 코드가 다른 전시회에 다시 쓰이지 않게(예전 QR로 남의 전시회에 들어가지 않게) '지움' 표시는 남겨요
  async wipe(code, why) {
    this.broadcast({ t: "gone" });
    for (const w of this.ctx.getWebSockets()) { try { w.close(1000, "gone"); } catch (_) {} }
    this.sql.exec("DELETE FROM rows"); this.cache = null; this.claps = null; this.pending.clear(); this.seen = undefined;
    this.put("m", "gone", JSON.stringify({ why, at: Date.now() }));
    try { await this.ctx.storage.deleteAlarm(); } catch (_) {}
    await this.tellRegistry(code, { deleted: true, why });
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname, code = req.headers.get("x-code") || "";
    if (path === "/init") {
      if (this.one("m", "key") || this.one("m", "gone")) return err("exists", 409);
      const { key } = await req.json();
      this.put("m", "key", key); this.put("m", "created", String(Date.now()));
      await this.ctx.storage.setAlarm(Date.now() + emptyMs(this.env));
      this.put("m", "head", JSON.stringify({ code, name: "", theme: "", intro: "", outro: "", order: [], open: false, updatedAt: Date.now() }));
      this.cache = null;
      await this.tellRegistry(code, { created: Date.now() });
      return json({ ok: true });
    }
    if (path === "/purge" && req.method === "POST") { if (this.head()) await this.wipe(code, "space"); return json({ ok: true }); } // 운영 정리 (바깥에서는 못 불러요)
    if (this.one("m", "gone") && !this.head()) return err("gone", 404);
    if ((path === "/get" || path === "/live") && this.head()) await this.touch(code);
    if (path === "/get" && req.method === "GET") {
      if (!this.cache) {
        const head = this.head(); if (!head) return err("missing", 404);
        const works = {}; for (const r of this.all("w")) works[r.id] = JSON.parse(r.v);
        this.cache = JSON.stringify({ head, works });
      }
      return json(this.cache);
    }
    if (path.startsWith("/list/") && req.method === "GET") {
      const kind = path.slice(6); if (!LIMIT[kind]) return err("kind");
      if (!this.head()) return err("missing", 404);
      return json(this.rows(kind));
    }
    // 실시간 연결(WebSocket)이 막힌 학교·회사 인터넷용 예비 길: 20초마다 한 번 받아 가고, 쪽지·따봉은 보통 요청으로 보내요
    if (path === "/state" && req.method === "GET") {
      if (!this.head()) return err("missing", 404);
      return json({ notes: this.rows("notes"), wall: this.rows("wall"), claps: this.clapMap() });
    }
    if (path === "/post" && req.method === "POST") {
      let b; try { b = JSON.parse(await req.text()); } catch (_) { return err("body"); }
      const now = Date.now(), dev = str(b.dev, 24) || "x";
      this.devs = this.devs || new Map(); this.burst = (this.burst || []).filter(t => now - t < 1000);
      if (this.burst.length >= 15) return err("slow", 429); this.burst.push(now);   // 전시회 하나에 1초 15번까지
      const a = this.devs.get(dev) || { la: 0, lc: 0 }; this.devs.set(dev, a); if (this.devs.size > 500) this.devs.clear();
      if (b.kind === "clap") {
        const head = this.head(); if (!head || head.open === false || !ID_RE.test(b.sid || "") || !(head.order || []).includes(b.sid)) return err("closed", 403);
        if (now - a.lc < 1500) return err("slow", 429); a.lc = now;
        const c = this.clapMap(); c[b.sid] = Math.min(99999, (c[b.sid] || 0) + Math.max(1, Math.min(20, b.n | 0))); this.put("c", b.sid, String(c[b.sid]));
        this.broadcast({ t: "clap", sid: b.sid, n: c[b.sid] }); return json({ ok: true, n: c[b.sid] });
      }
      const fake = { a, send: s => { this._ack = JSON.parse(s); } };
      this._ack = null; await this.addRow(fake, { kind: b.kind, row: b.row, q: 0 }, now);
      return this._ack && this._ack.e ? err(this._ack.e, this._ack.e === "slow" ? 429 : 400) : json({ ok: true });
    }
    if (path === "/live") {
      if (req.headers.get("Upgrade") !== "websocket") return err("upgrade", 426);
      if (!this.head()) return err("missing", 404);
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // 너무 많이 들어오면: 알려 주고 닫아요 (화면은 다시 붙으려고 하지 않아요)
      if (this.ctx.getWebSockets().length > MAX_SOCKETS) { server.send(JSON.stringify({ t: "full" })); server.close(1013, "full"); return new Response(null, { status: 101, webSocket: client }); }
      const me = "p" + rnd(8).toLowerCase();
      server.serializeAttachment({ id: me, p: null, lp: 0, la: 0, lc: 0 });
      const peers = []; for (const w of this.ctx.getWebSockets()) { if (w === server) continue; const a = w.deserializeAttachment(); if (a && a.p) peers.push({ id: a.id, p: a.p }); }
      server.send(JSON.stringify({ t: "init", me, notes: this.rows("notes"), wall: this.rows("wall"), claps: this.clapMap(), peers }));
      return new Response(null, { status: 101, webSocket: client });
    }
    // 선생님(관리 코드) 또는 운영자(운영자 키)만
    if (path === "/op" && req.method === "POST") {
      let b; try { b = JSON.parse(await req.text()); } catch (_) { return err("body"); }
      const now = Date.now(); this.wrong = this.wrong.filter(t => now - t < 3600e3);
      if (this.wrong.length >= WRONG_KEY_MAX) return err("locked", 429);
      const key = this.one("m", "key");
      if (!key) return err("missing", 404);
      const admin = isAdmin(this.env, b.admin);
      if (!admin && (typeof b.key !== "string" || b.key.toUpperCase() !== key)) { this.wrong.push(now); return err("key", 403); }
      if (!admin) await this.touch(code);
      return this.op(b, code, admin);
    }
    return err("not_found", 404);
  }

  async op(b, code, admin) {
    switch (b.op) {
      case "claim": return json(admin ? { head: this.head(), key: this.one("m", "key") } : { head: this.head() });
      case "head": {
        const h = b.head || {}, old = this.head() || {};
        const head = { id: str(h.id, 40), code, name: str(h.name, 40), theme: str(h.theme, 40), intro: str(h.intro, 400), outro: str(h.outro, 400),
          order: (Array.isArray(h.order) ? h.order : []).filter(x => ID_RE.test(String(x))).slice(0, MAX_WORKS), open: h.open !== false, wpath: "", updatedAt: +h.updatedAt || Date.now() };
        this.put("m", "head", JSON.stringify(head)); this.cache = null;
        if (old.open !== head.open) this.broadcast({ t: "open", open: head.open });
        if (old.name !== head.name || old.theme !== head.theme || old.open !== head.open || (old.order || []).length !== head.order.length)
          await this.tellRegistry(code, { name: head.name, theme: head.theme, open: head.open, works: head.order.length, updated: Date.now() });
        return json({ ok: true });
      }
      case "work": {
        if (!ID_RE.test(b.id || "") || !b.work || typeof b.work !== "object") return err("work");
        if (this.workStats().n === 0) { const t = Date.now() + idleMs(this.env); await this.ctx.storage.setAlarm(t); } // 첫 작품: 빈 전시회 정리 알람 대신 1년 알람
        const v = JSON.stringify(b.work); if (v.length > MAX_WORK_BYTES) return err("too_big", 413);
        const s = this.workStats(b.id);
        if (s.n >= MAX_WORKS) return err("works_limit", 413);
        if (s.b + v.length > MAX_SHOW_BYTES) return err("show_full", 413);
        this.put("w", b.id, v); this.cache = null; return json({ ok: true });
      }
      case "unwork": { if (ID_RE.test(b.id || "")) { this.del("w", b.id); this.cache = null; } return json({ ok: true }); }
      case "rm": {
        if (!LIMIT[b.kind] || !ID_RE.test(b.id || "")) return err("rm");
        this.del(b.kind, b.id); this.broadcast({ t: "rm", kind: b.kind, id: b.id }); return json({ ok: true });
      }
      case "delete": { await this.wipe(code, admin ? "admin" : "teacher"); return json({ ok: true }); }
    }
    return err("op");
  }

  broadcast(msg, except) { const s = JSON.stringify(msg); for (const w of this.ctx.getWebSockets()) { if (w === except) continue; try { w.send(s); } catch (_) {} } }

  /* --- 아이들 기기에서 오는 실시간 메시지 --- */
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 2000) return;
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    const a = ws.deserializeAttachment() || {}, now = Date.now();
    if (m.t === "p") { // 내 위치
      if (now - (a.lp || 0) < 150) return;
      const p = m.p || {}; if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
      const l = p.l && typeof p.l === "object" ? p.l : {};
      a.p = { x: +p.x, z: +p.z, r: +p.r || 0, s: +p.s || 0, e: str(p.e, 12), n: str(p.n, 8), l: { s: l.s | 0, h: l.h | 0, hc: l.hc | 0, c: l.c | 0, p: l.p | 0, t: l.t | 0 } };
      a.lp = now; ws.serializeAttachment(a);
      this.broadcast({ t: "p", id: a.id, p: a.p }, ws); return;
    }
    if (m.t === "leave") { if (a.p) { a.p = null; ws.serializeAttachment(a); this.broadcast({ t: "x", id: a.id }, ws); } return; }
    if (m.t === "clap") { // 따봉
      if (now - (a.lc || 0) < 120 || !ID_RE.test(m.sid || "")) return;
      const head = this.head(); if (!head || head.open === false || !(head.order || []).includes(m.sid)) return;
      a.lc = now; ws.serializeAttachment(a);
      const c = this.clapMap(); c[m.sid] = Math.min(99999, (c[m.sid] || 0) + 1); this.pending.add(m.sid);
      this.broadcast({ t: "clap", sid: m.sid, n: c[m.sid] });
      if (!this.flushT) this.flushT = setTimeout(() => this.flush(), 2000);
      return;
    }
    if (m.t === "add") { await this.addRow({ ws, a }, m, now); }
  }
  // 칭찬 한마디(notes) · 방명록 쪽지(wall): WebSocket으로 오든 예비 길(/post)로 오든 같은 규칙
  async addRow(src, m, now) {
    const a = src.a, ws = src.ws;
    {
      const reply = (e) => { try { (ws || src).send(JSON.stringify({ t: "ack", q: m.q, e })); } catch (_) {} };
      const kind = m.kind, r = m.row || {};
      if (!LIMIT[kind]) return reply("kind");
      const head = this.head(); if (!head || head.open === false) return reply("closed");
      if (now - (a.la || 0) < 2500) return reply("slow");
      const text = str(r.text, kind === "notes" ? 60 : 50).trim(), nick = str(r.nick, 8).trim() || "친구";
      if (!text) return reply("empty");
      const row = { text, nick, room: head.code, ts: now }; if (kind === "notes") { if (!ID_RE.test(r.sid || "")) return reply("sid"); row.sid = r.sid; }
      const id = now.toString(36) + rnd(4).toLowerCase();
      this.put(kind, id, JSON.stringify(row), now);
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM rows WHERE kind = ?", kind).one().n;
      if (n > LIMIT[kind]) this.sql.exec("DELETE FROM rows WHERE kind = ? AND id IN (SELECT id FROM rows WHERE kind = ? ORDER BY ts LIMIT ?)", kind, kind, n - LIMIT[kind]);
      a.la = now; if (ws) ws.serializeAttachment(a);
      reply("");
      this.broadcast({ t: "add", kind, row: Object.assign({ _id: id }, row) });
    }
  }
  flush() {
    this.flushT = 0; if (!this.one("m", "key")) { this.pending.clear(); return; } // 그사이 지워진 전시회
    const c = this.clapMap();
    for (const sid of this.pending) this.put("c", sid, String(c[sid] || 0));
    this.pending.clear();
  }
  async webSocketClose(ws, code) { this.left(ws); try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch (_) {} }
  async webSocketError(ws) { this.left(ws); }
  left(ws) { const a = ws.deserializeAttachment(); if (a && a.p) this.broadcast({ t: "x", id: a.id }, ws); if (this.pending.size) { clearTimeout(this.flushT); this.flush(); } }
}

/* ============================== 선생님 한 분의 전시회 목록 ============================== */
export class Teacher extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.sql = ctx.storage.sql; this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"); }
  async fetch(req) {
    if (req.method === "GET") { const r = this.sql.exec("SELECT v FROM kv WHERE k = 'shows'").toArray()[0]; return json(r ? r.v : '{"shows":[]}'); }
    if (req.method === "POST") {
      const t = await req.text(); if (t.length > 200000) return err("too_big", 413);
      let b; try { b = JSON.parse(t); } catch (_) { return err("body"); }
      const shows = (Array.isArray(b.shows) ? b.shows : []).slice(0, 100).filter(s => s && CODE_RE.test(s.code || ""));
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('shows', ?)", JSON.stringify({ shows, updatedAt: Date.now() }));
      return json({ ok: true });
    }
    return err("method", 405);
  }
}

/* ============================== 전체 전시회 목록 (운영자용 + 자동 정리) ============================== */
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS shows (code TEXT PRIMARY KEY, name TEXT, theme TEXT, open INTEGER, works INTEGER, created INTEGER, updated INTEGER, seen INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS gone (code TEXT PRIMARY KEY, why TEXT, at INTEGER)");
  }
  async fetch(req) {
    const url = new URL(req.url), code = url.pathname.slice(1);
    if (code === "list") return json(this.sql.exec("SELECT * FROM shows ORDER BY updated DESC").toArray());
    if (code === "gone") { const want = (url.searchParams.get("codes") || "").split(",").filter(c => CODE_RE.test(c)).slice(0, 200); if (!want.length) return json([]);
      return json(this.sql.exec(`SELECT code FROM gone WHERE code IN (${want.map(() => "?").join(",")})`, ...want).toArray().map(r => r.code)); }
    if (!CODE_RE.test(code) || req.method !== "POST") return err("bad");
    const b = JSON.parse(await req.text()), now = Date.now();
    if (b.deleted) { this.sql.exec("DELETE FROM shows WHERE code = ?", code); this.sql.exec("INSERT OR REPLACE INTO gone (code, why, at) VALUES (?, ?, ?)", code, str(b.why, 20) || "", now); return json({ ok: true }); }
    if (b.created) { this.sql.exec("INSERT OR REPLACE INTO shows (code, name, theme, open, works, created, updated, seen) VALUES (?, '', '', 0, 0, ?, ?, ?)", code, b.created, b.created, b.created); return json({ ok: true }); }
    if (b.seen) { this.sql.exec("UPDATE shows SET seen = ? WHERE code = ?", b.seen, code); return json({ ok: true }); }
    this.sql.exec("INSERT INTO shows (code, name, theme, open, works, created, updated, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, theme = excluded.theme, open = excluded.open, works = excluded.works, updated = excluded.updated",
      code, str(b.name, 40), str(b.theme, 40), b.open ? 1 : 0, b.works | 0, now, b.updated || now, now);
    this.ctx.waitUntil(this.makeRoom(code));
    return json({ ok: true });
  }
  // 저장 공간이 거의 찼으면: 가장 오래 안 쓴 전시회부터 지워서 자리를 만들어요 (방금 고친 전시회는 빼고)
  async makeRoom(except) {
    if (this.busy) return; this.busy = true;
    try {
      const limit = +this.env.TEST_SPACE_LIMIT || SPACE_LIMIT;
      const est = () => { const r = this.sql.exec("SELECT COALESCE(SUM(works), 0) AS w, COUNT(*) AS n FROM shows").one(); return r.w * BYTES_PER_WORK + r.n * BYTES_PER_SHOW; };
      for (let round = 0; round < 5 && est() > limit; round++) {
        const old = this.sql.exec("SELECT code FROM shows WHERE code != ? ORDER BY COALESCE(seen, updated) ASC LIMIT 10", except).toArray();
        if (!old.length) break;
        for (const { code } of old) { if (est() <= limit) break; try { await this.env.SHOW.get(this.env.SHOW.idFromName(code)).fetch("https://show/purge", { method: "POST", headers: { "x-code": code } }); } catch (_) {} this.sql.exec("DELETE FROM shows WHERE code = ?", code); this.sql.exec("INSERT OR REPLACE INTO gone (code, why, at) VALUES (?, 'space', ?)", code, Date.now()); }
      }
    } finally { this.busy = false; }
  }
}

/* ============================== 하루 생성 한도 (인터넷 주소마다) ============================== */
export class Gate extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.sql = ctx.storage.sql; this.sql.exec("CREATE TABLE IF NOT EXISTS g (day TEXT PRIMARY KEY, n INTEGER)"); }
  async fetch(req) {
    const max = +new URL(req.url).searchParams.get("max") || 60, day = kstDay();
    this.sql.exec("DELETE FROM g WHERE day != ?", day);
    const r = this.sql.exec("SELECT n FROM g WHERE day = ?", day).toArray()[0], n = r ? r.n : 0;
    if (n >= max) return err("rate", 429);
    this.sql.exec("INSERT OR REPLACE INTO g (day, n) VALUES (?, ?)", day, n + 1);
    return json({ ok: true, n: n + 1 });
  }
}
