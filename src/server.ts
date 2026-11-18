#!/usr/bin/env node
/**
 * bruno-mcp — dwa tryby:
 *  - central (domyślny): serwer HTTP dla repo z kolekcjami w GitLabie, zmiany jako MR-y.
 *    Klient łączy się na /mcp z nagłówkiem Authorization: Bearer <GitLab token>.
 *  - local (`--local` albo MODE=local): stdio, pliki w bieżącym projekcie, bez gita.
 */
import http from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { settings, validateCentralSettings } from "./settings.js";
import { initRepo } from "./git.js";
import { currentUser, assertCanPush, GitlabError } from "./gitlab.js";
import { Session } from "./session.js";
import { buildServer } from "./tools.js";

type Entry = { session: Session; transport: StreamableHTTPServerTransport; tokenHash: Buffer };
const sessions = new Map<string, Entry>();

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a);
const hash = (t: string) => createHash("sha256").update(t).digest();

function tokenFrom(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const pt = req.headers["private-token"];
  return typeof pt === "string" && pt ? pt : null;
}

/** Nagłówki X-Bru-Env-KC-USER: jan → process.env.KC_USER dla bru (tylko w pamięci sesji). */
function secretsFrom(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith("x-bru-env-") && typeof v === "string" && v) out[k.slice(10).toUpperCase().replace(/-/g, "_")] = v;
  }
  return out;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}
const rpcError = (res: http.ServerResponse, status: number, message: string) =>
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    status === 401 ? { "WWW-Authenticate": 'Bearer realm="bruno-mcp"' } : {});

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new Error("Body za duże");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  const token = tokenFrom(req);
  if (!token) return rpcError(res, 401, "Brak tokena GitLab (Authorization: Bearer <token>)");

  const body = req.method === "POST" ? await readBody(req) : undefined;
  const sid = req.headers["mcp-session-id"];

  // istniejąca sesja — token musi być ten sam, którym ją otwarto
  if (typeof sid === "string") {
    const entry = sessions.get(sid);
    if (!entry) return rpcError(res, 404, "Sesja wygasła lub serwer był restartowany — połącz się ponownie");
    const h = hash(token);
    if (h.length !== entry.tokenHash.length || !timingSafeEqual(h, entry.tokenHash))
      return rpcError(res, 403, "Token nie pasuje do sesji");
    entry.session.lastActivity = Date.now();
    return entry.transport.handleRequest(req, res, body);
  }

  if (req.method !== "POST" || !isInitializeRequest(body)) return rpcError(res, 400, "Brak mcp-session-id");

  // nowa sesja: weryfikacja w GitLabie
  let user;
  try {
    user = await currentUser(token);
    await assertCanPush(token);
  } catch (e) {
    const status = e instanceof GitlabError && (e.status === 401 || e.status === 403) ? e.status : 502;
    log("auth failed:", e instanceof Error ? e.message : e);
    return rpcError(res, status, status === 502 ? "GitLab niedostępny" : e instanceof Error ? e.message : "Brak dostępu");
  }

  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { session, transport, tokenHash: hash(token) });
      log(`session ${id} opened by @${user.username} → ${session.branch}`);
    },
  });
  const session = new Session(randomUUID(), user, token, secretsFrom(req));
  await session.start();

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.delete(id)) {
      log(`session ${id} closed (@${user.username})`);
      session.close().catch((e) => log("cleanup error:", e));
    }
  };

  await buildServer(session).connect(transport);
  await transport.handleRequest(req, res, body);
}

async function main() {
  if (process.argv.includes("--local") || process.env.MODE === "local") {
    const { runLocal } = await import("./local.js");
    return runLocal();
  }
  validateCentralSettings();
  log(`init repo ${settings.gitlabProject} → ${settings.dataDir}`);
  await initRepo();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true, sessions: sessions.size });
      if (url.pathname === "/mcp") return await handleMcp(req, res);
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      log("request error:", e);
      if (!res.headersSent) rpcError(res, 500, e instanceof Error ? e.message : "Błąd serwera");
    }
  });

  // zamykanie bezczynnych sesji (branch i MR zostają w GitLabie)
  setInterval(() => {
    const limit = Date.now() - settings.sessionIdleMinutes * 60_000;
    for (const [id, e] of sessions) {
      if (e.session.lastActivity < limit) {
        log(`session ${id} idle → closing`);
        e.transport.close().catch(() => undefined);
      }
    }
  }, 60_000).unref();

  const shutdown = async () => {
    log("shutting down");
    server.close();
    await Promise.allSettled([...sessions.values()].map((e) => e.transport.close()));
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(settings.port, () => log(`bruno-mcp listening on :${settings.port}/mcp`));
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
