/**
 * Git na serwerze: jedno współdzielone repo (bare) + osobny worktree i branch na każdą sesję.
 * Tokeny nigdy nie są zapisywane w konfiguracji git — idą jako nagłówek tylko dla danego polecenia.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settings, repoCloneUrl } from "./settings.js";

const execP = promisify(execFile);

export const bareRepo = () => path.join(settings.dataDir, "repo.git");
export const sessionsDir = () => path.join(settings.dataDir, "sessions");

/** Globalny mutex dla operacji dotykających współdzielonego repo (fetch, push, worktree add/remove). */
let chain: Promise<unknown> = Promise.resolve();
export function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function authHeader(user: string, token: string): string[] {
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}
const readAuth = () => authHeader(settings.gitlabReadUser, settings.gitlabReadToken);
export const userAuth = (token: string) => authHeader("oauth2", token);

/** Uruchamia git; tokeny z argumentów są maskowane w komunikatach błędów. */
export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await execP("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e: any) {
    const msg = String(e.stderr || e.message).replace(/Basic [A-Za-z0-9+/=]+/g, "Basic ***");
    throw new Error(`git ${args.filter((a) => !a.startsWith("http.extraHeader")).join(" ")}: ${msg.trim()}`);
  }
}

export async function initRepo(): Promise<void> {
  await fs.mkdir(settings.dataDir, { recursive: true });
  // sesje nie przeżywają restartu — sprzątamy stare worktree
  await fs.rm(sessionsDir(), { recursive: true, force: true });
  await fs.mkdir(sessionsDir(), { recursive: true });

  const bare = bareRepo();
  const hasRepo = await fs.access(path.join(bare, "HEAD")).then(() => true, () => false);
  if (!hasRepo) {
    await git(settings.dataDir, [...readAuth(), "clone", "--bare", repoCloneUrl(), bare]);
    await git(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  }
  await git(bare, ["remote", "set-url", "origin", repoCloneUrl()]);
  await git(bare, ["worktree", "prune"]);
  // usuń lokalne branche sesji z poprzedniego uruchomienia
  const branches = (await git(bare, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${settings.branchPrefix}/`]))
    .split("\n")
    .filter(Boolean);
  for (const b of branches) await git(bare, ["branch", "-D", b]).catch(() => undefined);
  await fetchMain();
}

export async function fetchMain(): Promise<void> {
  await git(bareRepo(), [...readAuth(), "fetch", "--prune", "origin"]);
}

export async function addWorktree(dir: string, branch: string): Promise<void> {
  await withRepoLock(async () => {
    await fetchMain();
    await git(bareRepo(), ["worktree", "add", "-b", branch, dir, `origin/${settings.targetBranch}`]);
  });
}

export async function removeWorktree(dir: string, branch: string): Promise<void> {
  await withRepoLock(async () => {
    await git(bareRepo(), ["worktree", "remove", "--force", dir]).catch(() => fs.rm(dir, { recursive: true, force: true }));
    await git(bareRepo(), ["worktree", "prune"]).catch(() => undefined);
    await git(bareRepo(), ["branch", "-D", branch]).catch(() => undefined);
  });
}

export type Author = { name: string; email: string };

/** add + commit; zwraca false, gdy nie było nic do zatwierdzenia. */
export async function commitAll(dir: string, message: string, author: Author): Promise<boolean> {
  await git(dir, ["add", "-A"]);
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status) return false;
  await git(dir, ["commit", "-m", message], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  });
  return true;
}

/**
 * Dociąga najnowszy main i przenosi na niego commity sesji (żeby MR był aktualny),
 * po czym wypycha branch tokenem użytkownika. Przy konflikcie rebase jest porzucany —
 * MR pokaże konflikt do rozwiązania w GitLabie.
 */
export async function rebaseAndPush(dir: string, branch: string, token: string, author: Author): Promise<{ conflict: boolean }> {
  return withRepoLock(async () => {
    await fetchMain();
    let conflict = false;
    try {
      await git(dir, ["rebase", `origin/${settings.targetBranch}`], {
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      });
    } catch {
      conflict = true;
      await git(dir, ["rebase", "--abort"]).catch(() => undefined);
    }
    await git(dir, [...userAuth(token), "push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`]);
    return { conflict };
  });
}

/** Czy sesja ma commity, których nie ma na main. */
export async function hasOwnCommits(dir: string): Promise<boolean> {
  const n = await git(dir, ["rev-list", "--count", `origin/${settings.targetBranch}..HEAD`]);
  return Number(n) > 0;
}

/** Bez własnych commitów: przesuń worktree na najnowszy main (świeży stan przed pierwszą zmianą). */
export async function refreshIfClean(dir: string): Promise<void> {
  await withRepoLock(fetchMain);
  if (!(await hasOwnCommits(dir))) await git(dir, ["reset", "--hard", `origin/${settings.targetBranch}`]);
}
