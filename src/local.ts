/**
 * Tryb local: serwer stdio uruchamiany przez Claude Code / Cursor w katalogu projektu.
 * Pracuje na plikach kolekcji w bieżącym repo — bez gita, bez MR-ów (commit robisz sam).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { WriteResult } from "./collection.js";
import type { Workspace } from "./workspace.js";
import { buildServer } from "./tools.js";

const exec = promisify(execFile);
const log = (...a: unknown[]) => console.error("[bruno-mcp local]", ...a);

async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    return (await exec("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

/** Szuka katalogów z bruno.json (do głębokości 4), pomijając node_modules i ukryte. */
async function findCollections(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && e.name === "bruno.json")) {
    out.push(dir);
    return out; // kolekcje się nie zagnieżdżają
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "dist", "build", "target", "vendor"].includes(e.name))
      await findCollections(path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

/**
 * Root pracy:
 *  - BRUNO_DIR (względem repo) jeśli ustawione,
 *  - jedyna kolekcja znaleziona w repo,
 *  - przy kilku kolekcjach — root repo (ścieżki w narzędziach zaczynają się od folderu kolekcji).
 */
async function resolveRoot(): Promise<{ root: string; repo: string; note: string }> {
  const cwd = process.cwd();
  const repo = (await gitToplevel(cwd)) ?? cwd;
  if (process.env.BRUNO_DIR) {
    const root = path.resolve(repo, process.env.BRUNO_DIR);
    return { root, repo, note: `kolekcja z BRUNO_DIR: ${path.relative(repo, root) || "."}` };
  }
  const cols = await findCollections(repo);
  if (cols.length === 1) return { root: cols[0], repo, note: `kolekcja: ${path.relative(repo, cols[0]) || "."}` };
  if (cols.length > 1)
    return { root: repo, repo, note: `kilka kolekcji: ${cols.map((c) => path.relative(repo, c)).join(", ")} — ścieżki podawaj od roota repo` };
  return { root: repo, repo, note: "brak kolekcji Bruno (bruno.json) — utwórz ją w aplikacji Bruno albo ustaw BRUNO_DIR" };
}

class LocalWorkspace implements Workspace {
  mode = "local" as const;
  secrets: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private root: string, private repo: string, public label: string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  read<T>(fn: (root: string) => Promise<T>): Promise<T> {
    return this.serial(() => fn(this.root));
  }

  write(fn: (root: string) => Promise<WriteResult>): Promise<string> {
    return this.serial(async () => {
      const r = await fn(this.root);
      const prefix = path.relative(this.repo, this.root);
      return `${r.message}${prefix ? `\n(ścieżki względem ${prefix}/)` : ""}\nZapisano w plikach projektu — bez commita.`;
    });
  }
}

export async function runLocal(): Promise<void> {
  const { root, repo, note } = await resolveRoot();
  log(`repo: ${repo}; ${note}`);
  const ws = new LocalWorkspace(root, repo, `bieżący projekt (${path.basename(repo)}; ${note})`);
  await buildServer(ws).connect(new StdioServerTransport());
}
