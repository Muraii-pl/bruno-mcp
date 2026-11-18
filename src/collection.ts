/**
 * Operacje na repo z kolekcjami Bruno (worktree sesji).
 * Ścieżki są względem roota repo. Konwencje jak w istniejących kolekcjach:
 *  - plik = <nazwa>.bru, meta.name = nazwa (np. findByUid)
 *  - każdy folder ma folder.bru (meta name/seq + auth: inherit)
 *  - seq wspólne dla requestów i podfolderów w danym folderze
 *  - URL = baza wykryta z sąsiednich requestów (np. {{host}}:{{zuulPort}}) + ścieżka
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Block, dictBlock, parseBru, readDict, serializeBru, textBlock } from "./bru.js";

const exec = promisify(execFile);
export const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
type Method = (typeof METHODS)[number];

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/** Ścieżka w obrębie repo — blokuje wyjście poza nie (../) i katalog .git. */
export function inside(root: string, rel: string): string {
  const p = path.resolve(root, rel.replace(/^\/+/, ""));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`Ścieżka poza repozytorium: ${rel}`);
  if (path.relative(root, p).split(path.sep).includes(".git")) throw new Error("Katalog .git jest niedostępny");
  return p;
}

const relPath = (repo: string, p: string) => path.relative(repo, p).split(path.sep).join("/") || ".";

function fileName(name: string): string {
  const s = name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error("Pusta nazwa requestu");
  return s;
}

/** Najbliższy katalog w górę (do roota repo) zawierający bruno.json. */
export async function findCollectionRoot(repo: string, from: string): Promise<string | null> {
  let dir = from;
  while (true) {
    if (await exists(path.join(dir, "bruno.json"))) return dir;
    if (dir === repo) return null;
    const up = path.dirname(dir);
    if (up === dir || !up.startsWith(repo)) return null;
    dir = up;
  }
}

async function readBlocks(file: string): Promise<Block[]> {
  return parseBru(await fs.readFile(file, "utf8"));
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "environments") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.name.endsWith(".bru") && e.name !== "collection.bru" && e.name !== "folder.bru") out.push(full);
  }
  return out;
}

/** Następny seq w folderze: max z requestów i folder.bru podfolderów + 1. */
async function nextSeq(dir: string): Promise<number> {
  let max = 0;
  if (!(await exists(dir))) return 1;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    let f: string | null = null;
    if (e.isFile() && e.name.endsWith(".bru") && e.name !== "folder.bru" && e.name !== "collection.bru") f = path.join(dir, e.name);
    if (e.isDirectory() && (await exists(path.join(dir, e.name, "folder.bru")))) f = path.join(dir, e.name, "folder.bru");
    if (!f) continue;
    const meta = readDict((await readBlocks(f)).find((b) => b.name === "meta"));
    max = Math.max(max, Number(meta.seq) || 0);
  }
  return max + 1;
}

/** Tworzy brakujące foldery (z folder.bru) od roota repo do `dir`. Zwraca utworzone. */
async function ensureFolders(repo: string, dir: string): Promise<string[]> {
  const created: string[] = [];
  const parts = path.relative(repo, dir).split(path.sep).filter(Boolean);
  let cur = repo;
  for (const part of parts) {
    const next = path.join(cur, part);
    if (!(await exists(next))) {
      const seq = await nextSeq(cur);
      await fs.mkdir(next);
      const inCollection = await findCollectionRoot(repo, cur);
      if (inCollection) {
        await fs.writeFile(
          path.join(next, "folder.bru"),
          serializeBru([dictBlock("meta", { name: part, seq }), dictBlock("auth", { mode: "inherit" })]),
        );
      }
      created.push(relPath(repo, next));
    }
    cur = next;
  }
  return created;
}

/** Baza URL (np. "{{host}}:{{zuulPort}}") — najczęstsza w folderze, potem w całej kolekcji. */
async function detectUrlBase(repo: string, dir: string): Promise<string> {
  const baseOf = (url: string): string | null => {
    const m = url.match(/^(https?:\/\/[^/]+|(?:\{\{[^}]+\}\}|[^/{])+)(?=\/|$)/);
    return m ? m[1] : null;
  };
  const scopes: string[] = [];
  for (let d = dir; d.startsWith(repo); d = path.dirname(d)) {
    if (await exists(d)) scopes.push(d);
    if (d === repo) break;
  }
  for (const scope of scopes) {
    const counts = new Map<string, number>();
    const files = (await fs.readdir(scope)).filter((f) => f.endsWith(".bru") && f !== "folder.bru" && f !== "collection.bru");
    const all = scope === scopes[scopes.length - 1] ? await walk(scope) : files.map((f) => path.join(scope, f));
    for (const f of all.slice(0, 500)) {
      const req = (await readBlocks(f)).find((b) => (METHODS as readonly string[]).includes(b.name));
      const b = baseOf(readDict(req).url ?? "");
      if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return "{{baseUrl}}";
}

// ---------------------------------------------------------------- write ops
// Każda zwraca { message, summary } — summary trafia do commita i opisu MR.

export type WriteResult = { message: string; summary: string };

export type EndpointInput = {
  folder: string;
  name: string;
  method: Method;
  path?: string;
  url?: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  jsonBody?: string;
  postResponseVars?: Record<string, string>;
  description?: string;
  assertions?: Record<string, string>;
  tests?: string;
  overwrite?: boolean;
};

export async function addEndpoint(repo: string, i: EndpointInput): Promise<WriteResult> {
  if (!i.url && !i.path) throw new Error("Podaj path (np. /njord/api/deposit/create) albo pełny url");
  const dir = inside(repo, i.folder);
  const file = path.join(dir, `${fileName(i.name)}.bru`);
  const rel = relPath(repo, file);

  let body: string | undefined;
  if (i.jsonBody) {
    try {
      body = JSON.stringify(JSON.parse(i.jsonBody), null, 2);
    } catch {
      throw new Error("jsonBody nie jest poprawnym JSON-em");
    }
  }

  const tests = i.tests?.trim();
  if (tests) {
    try {
      new Function("test", "expect", "res", "req", "bru", tests); // tylko kontrola składni, bez wykonania
    } catch (e) {
      throw new Error(`tests: błąd składni JS — ${e instanceof Error ? e.message : e}`);
    }
  }
  const hasAsserts = i.assertions && Object.keys(i.assertions).length > 0;

  const existed = await exists(file);
  if (existed && !i.overwrite) throw new Error(`Plik już istnieje: ${rel} (użyj overwrite: true albo write_bru)`);

  let url = i.url;
  if (!url) {
    const p = i.path!.startsWith("/") ? i.path! : "/" + i.path!;
    url = (await detectUrlBase(repo, dir)) + p;
  }
  const hasQuery = i.query && Object.keys(i.query).length > 0;
  if (hasQuery && !url.includes("?")) url += "?" + Object.entries(i.query!).map(([k, v]) => `${k}=${v}`).join("&");
  const pathParamNames = [...url.split("?")[0].matchAll(/\/:(\w+)/g)].map((m) => m[1]);

  const created = await ensureFolders(repo, dir);
  let seq: string | number = await nextSeq(dir);
  if (existed) {
    const oldMeta = readDict((await readBlocks(file)).find((b) => b.name === "meta"));
    if (oldMeta.seq) seq = oldMeta.seq;
  }

  const blocks: Block[] = [
    dictBlock("meta", { name: i.name, type: "http", seq }),
    dictBlock(i.method, { url, body: body ? "json" : "none", auth: "inherit" }),
  ];
  if (hasQuery) blocks.push(dictBlock("params:query", i.query!));
  if (pathParamNames.length)
    blocks.push(dictBlock("params:path", Object.fromEntries(pathParamNames.map((p) => [p, i.pathParams?.[p] ?? ""]))));
  if (i.headers && Object.keys(i.headers).length) blocks.push(dictBlock("headers", i.headers));
  if (body) blocks.push(textBlock("body:json", body));
  if (i.postResponseVars && Object.keys(i.postResponseVars).length)
    blocks.push(dictBlock("vars:post-response", i.postResponseVars));
  if (hasAsserts) blocks.push(dictBlock("assert", i.assertions!));
  if (tests) blocks.push(textBlock("tests", tests));
  if (i.description) blocks.push(textBlock("docs", i.description.trim()));

  await fs.writeFile(file, serializeBru(blocks));
  const shownPath = url.replace(/^(https?:\/\/[^/]+|(?:\{\{[^}]+\}\}|[^/{])+)(?=\/)/, "");
  return {
    message:
      `Zapisano ${rel}\nURL: ${url}` +
      (created.length ? `\nUtworzono foldery: ${created.join(", ")}` : "") +
      (!i.description ? "\nUwaga: brak opisu (description) — dopisz go przez add_endpoint z overwrite albo write_bru." : "") +
      (!hasAsserts && !tests ? "\nUwaga: brak testów (assertions/tests)." : "\nSprawdź testy: run_endpoint na tym pliku."),
    summary: `${existed ? "zmieniono" : "dodano"} \`${i.method.toUpperCase()} ${shownPath}\` → \`${rel}\``,
  };
}

/** Zapis surowej treści .bru — do zmian, których nie obejmuje add_endpoint (skrypty, testy, asercje…). */
export async function writeBru(repo: string, file: string, content: string): Promise<WriteResult> {
  if (!file.endsWith(".bru")) throw new Error("Plik musi mieć rozszerzenie .bru");
  const full = inside(repo, file);
  const blocks = parseBru(content);
  const base = path.basename(full);
  if (base !== "collection.bru" && !blocks.some((b) => b.name === "meta"))
    throw new Error("Treść nie wygląda na plik .bru (brak bloku meta { ... })");
  const existed = await exists(full);
  await ensureFolders(repo, path.dirname(full));
  await fs.writeFile(full, content.endsWith("\n") ? content : content + "\n");
  const rel = relPath(repo, full);
  return { message: `Zapisano ${rel}`, summary: `${existed ? "edycja" : "nowy plik"} \`${rel}\`` };
}

export async function removeBru(repo: string, file: string): Promise<WriteResult> {
  const full = inside(repo, file);
  if (!full.endsWith(".bru") || !(await exists(full))) throw new Error(`Nie ma takiego pliku: ${file}`);
  if (["collection.bru", "folder.bru"].includes(path.basename(full)))
    throw new Error("Nie usuwam collection.bru ani folder.bru — usuń requesty z folderu, folder zniknie z nimi.");
  await fs.rm(full);
  // pusty folder (zostało tylko folder.bru) → usuń
  const dir = path.dirname(full);
  const left = await fs.readdir(dir);
  if (dir !== repo && left.every((f) => f === "folder.bru")) await fs.rm(dir, { recursive: true });
  const rel = relPath(repo, full);
  return { message: `Usunięto ${rel}`, summary: `usunięto \`${rel}\`` };
}

// ---------------------------------------------------------------- read ops

export async function listEndpoints(repo: string, folder = ".", filter?: string): Promise<string> {
  const dir = inside(repo, folder);
  if (!(await exists(dir))) throw new Error(`Nie ma folderu ${folder}`);
  const rows: string[] = [];
  for (const f of (await walk(dir)).sort()) {
    const blocks = await readBlocks(f);
    const meta = readDict(blocks.find((b) => b.name === "meta"));
    const req = blocks.find((b) => (METHODS as readonly string[]).includes(b.name));
    const line = `${(req?.name ?? "?").toUpperCase().padEnd(7)} ${readDict(req).url ?? ""}  —  ${meta.name ?? ""}  [${relPath(repo, f)}]`;
    if (!filter || line.toLowerCase().includes(filter.toLowerCase())) rows.push(line);
  }
  return rows.length ? rows.join("\n") : "Brak requestów.";
}

export async function readBru(repo: string, file: string): Promise<string> {
  const full = inside(repo, file);
  if (!full.endsWith(".bru") && !full.endsWith(".json")) throw new Error("Odczyt tylko plików .bru / bruno.json");
  return fs.readFile(full, "utf8");
}

async function hasBru(dir: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && (e.name.endsWith(".bru") || e.name === "bruno.json")) return true;
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && (await hasBru(path.join(dir, e.name), depth + 1)))
      return true;
  }
  return false;
}

export async function listFolders(repo: string): Promise<string> {
  const out: string[] = [];
  async function rec(dir: string, depth: number) {
    for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "environments") continue;
      const full = path.join(dir, e.name);
      if (!(await hasBru(full))) continue;
      const n = (await fs.readdir(full)).filter((f) => f.endsWith(".bru") && f !== "folder.bru").length;
      const mark = (await exists(path.join(full, "bruno.json"))) ? "  [kolekcja]" : "";
      out.push(`${"  ".repeat(depth)}${e.name}/  (${n} req.)${mark}`);
      if (depth < 4 && e.name !== "environments") await rec(full, depth + 1);
    }
  }
  const rootMark = (await exists(path.join(repo, "bruno.json"))) ? " [kolekcja]" : "";
  out.push(`./${rootMark}`);
  await rec(repo, 1);
  return out.join("\n");
}

// ---------------------------------------------------------------- run

export type RunOptions = {
  target: string;
  env?: string;
  maxBodyChars: number;
  includeHeaders: boolean;
  secrets: Record<string, string>; // trafia do process.env bru — tylko w pamięci
};

export async function runEndpoint(repo: string, o: RunOptions): Promise<{ text: string; isError: boolean }> {
  const full = inside(repo, o.target);
  if (!(await exists(full))) throw new Error(`Nie ma ${o.target}`);
  const colRoot = await findCollectionRoot(repo, (await fs.stat(full)).isDirectory() ? full : path.dirname(full));
  if (!colRoot) throw new Error(`${o.target} nie leży w żadnej kolekcji (brak bruno.json w katalogach nadrzędnych)`);
  const target = path.relative(colRoot, full) || ".";
  const env = await resolveEnv(colRoot, o.env);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bruno-mcp-"));
  try {
    const reportFile = path.join(tmp, "report.json");
    const bruCmd = process.env.BRU_BIN ? [process.env.BRU_BIN] : ["npx", "-y", "@usebruno/cli"];
    const args = [...bruCmd.slice(1), "run", target, ...(env ? ["--env", env] : []), "--reporter-json", reportFile];
    const { stdout, stderr } = await exec(bruCmd[0], args, {
      cwd: colRoot,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...o.secrets },
    }).catch((e: any) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) }));

    if (!(await exists(reportFile))) {
      let hint = "";
      const envDir = path.join(colRoot, "environments");
      if (await exists(envDir)) {
        const envs = (await fs.readdir(envDir)).filter((f) => f.endsWith(".bru")).map((f) => f.slice(0, -4));
        hint = `\nDostępne środowiska: ${envs.join(", ")}`;
      }
      return { text: stripAnsi([stdout, stderr].filter(Boolean).join("\n")).trim() + hint, isError: true };
    }
    const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
    return { text: (env ? `Środowisko: ${env}\n` : "Bez środowiska\n") + formatReport(report, o), isError: false };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function listEnvs(colRoot: string): Promise<string[]> {
  const dir = path.join(colRoot, "environments");
  if (!(await exists(dir))) return [];
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".bru")).map((f) => f.slice(0, -4)).sort();
}

/** Podane → domyślne z DEFAULT_RUN_ENV → "local" → jedyne istniejące. Brak środowisk = uruchomienie bez --env. */
async function resolveEnv(colRoot: string, requested?: string): Promise<string | undefined> {
  const envs = await listEnvs(colRoot);
  if (requested) {
    if (envs.length && !envs.includes(requested))
      throw new Error(`Nie ma środowiska "${requested}". Dostępne: ${envs.join(", ")}`);
    return requested;
  }
  const preferred = process.env.DEFAULT_RUN_ENV;
  if (preferred && envs.includes(preferred)) return preferred;
  if (envs.includes("local")) return "local";
  if (envs.length === 1) return envs[0];
  if (envs.length === 0) return undefined;
  throw new Error(`Wybierz środowisko (parametr env). Dostępne: ${envs.join(", ")}`);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fmtBody(data: unknown, max: number): string {
  if (data === undefined || data === null || data === "") return "(puste)";
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s.length > max ? s.slice(0, max) + `\n… (przycięto, całość: ${s.length} znaków — zwiększ maxBodyChars)` : s;
}

function fmtHeaders(h: Record<string, unknown> | undefined): string {
  return Object.entries(h ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

function formatReport(report: any, opts: { maxBodyChars: number; includeHeaders: boolean }): string {
  const iterations: any[] = Array.isArray(report) ? report : [report];
  const out: string[] = [];
  for (const it of iterations) {
    const results: any[] = it.results ?? [];
    const s = it.summary ?? {};
    const summaryIdx = out.length;
    out.push("");
    let nOk = 0, nWarn = 0, nFail = 0;
    const perBody =
      results.length > 1 ? Math.max(Math.min(500, opts.maxBodyChars), Math.floor(opts.maxBodyChars / results.length)) : opts.maxBodyChars;

    for (const r of results) {
      const req = r.request ?? {};
      const res = r.response ?? {};
      const checks = [
        ...(r.assertionResults ?? []).map((a: any) => ({ name: `${a.lhsExpr ?? ""} ${a.rhsExpr ?? ""}`.trim(), ...a })),
        ...(r.testResults ?? []),
        ...(r.preRequestTestResults ?? []),
        ...(r.postResponseTestResults ?? []),
      ];
      const failed = !!r.error || (r.status && !["pass", "skipped"].includes(r.status)) || checks.some((c: any) => c.status !== "pass");
      const httpBad = typeof res.status === "number" && res.status >= 400;
      const icon = r.status === "skipped" ? "–" : failed ? "✗" : httpBad ? "⚠" : "✓";
      if (icon === "✓") nOk++;
      else if (icon === "⚠") nWarn++;
      else if (icon === "✗") nFail++;

      const statusTxt = res.status ? `${res.status} ${res.statusText ?? ""}`.trim() : "brak odpowiedzi";
      const meta = [res.responseTime != null ? `${res.responseTime} ms` : null, res.size != null ? `${res.size} B` : null]
        .filter(Boolean)
        .join(", ");
      out.push(`\n${icon} ${req.method ?? "?"} ${req.url ?? ""} → ${statusTxt}${meta ? ` (${meta})` : ""}  [${r.test?.filename ?? r.path ?? ""}]`);
      if (r.error) out.push(`  Błąd: ${typeof r.error === "string" ? r.error : JSON.stringify(r.error)}`);
      if (res.status === 401)
        out.push(
          "  Podpowiedź: 401 zwykle oznacza brak tokena — sprawdź dane logowania przekazywane w nagłówkach X-Bru-Env-* " +
            "w konfiguracji MCP oraz ustawienia auth kolekcji dla wybranego środowiska.",
        );
      if (res.status === 403) out.push("  Podpowiedź: 403 — token jest, ale użytkownik nie ma wymaganej roli.");
      for (const c of checks) {
        const okc = c.status === "pass";
        out.push(`  ${okc ? "✓" : "✗"} ${c.description ?? c.name ?? "test"}${!okc && c.error ? ` — ${c.error}` : ""}`);
      }
      if (opts.includeHeaders) {
        const rqh = fmtHeaders(req.headers);
        const rsh = fmtHeaders(res.headers);
        if (rqh) out.push(`  Nagłówki requestu:\n${rqh}`);
        if (rsh) out.push(`  Nagłówki odpowiedzi:\n${rsh}`);
      }
      if (opts.maxBodyChars > 0 && res.status) out.push("  Body odpowiedzi:\n" + fmtBody(res.data, perBody));
    }
    out[summaryIdx] =
      `Podsumowanie: ${results.length} request(ów) — ✓ ${nOk} OK` +
      (nWarn ? `, ⚠ ${nWarn} z kodem HTTP 4xx/5xx` : "") +
      (nFail ? `, ✗ ${nFail} nieudanych (błąd/asercja/test)` : "") +
      (s.totalAssertions ? ` · asercje ${s.passedAssertions}/${s.totalAssertions}` : "") +
      (s.totalTests ? ` · testy ${s.passedTests}/${s.totalTests}` : "");
  }
  return out.join("\n");
}
