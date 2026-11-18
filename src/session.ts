/** Sesja MCP = jeden użytkownik, jeden worktree, jeden branch, (po pierwszej zmianie) jeden MR. */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { settings } from "./settings.js";
import * as git from "./git.js";
import * as gl from "./gitlab.js";
import type { WriteResult } from "./collection.js";
import type { Workspace } from "./workspace.js";

function branchName(username: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${settings.branchPrefix}/${username}/${stamp}-${randomBytes(2).toString("hex")}`;
}

function plural(n: number): string {
  if (n === 1) return "1 zmiana";
  const d = n % 10, t = n % 100;
  return `${n} ${d >= 2 && d <= 4 && (t < 12 || t > 14) ? "zmiany" : "zmian"}`;
}

export class Session implements Workspace {
  mode = "central" as const;
  label = `repo ${settings.gitlabProject}`;
  dir = "";
  branch = "";
  mr?: gl.MergeRequest;
  changes: string[] = [];
  lastActivity = Date.now();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    public id: string,
    public user: gl.GitlabUser,
    private token: string,
    public secrets: Record<string, string>,
  ) {}

  /** Wywołania narzędzi w jednej sesji wykonywane po kolei. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.lastActivity = Date.now();
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async start(): Promise<void> {
    this.branch = branchName(this.user.username);
    this.dir = path.join(git.sessionsDir(), this.id);
    await git.addWorktree(this.dir, this.branch);
  }

  async close(): Promise<void> {
    if (this.dir) await git.removeWorktree(this.dir, this.branch);
  }

  /** Nowa gałąź od świeżego main — kolejne zmiany pójdą do nowego MR-a. */
  private async restart(): Promise<void> {
    await this.close();
    this.mr = undefined;
    this.changes = [];
    await this.start();
  }

  read<T>(fn: (repo: string) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (!this.mr) await git.refreshIfClean(this.dir);
      return fn(this.dir);
    });
  }

  write(fn: (repo: string) => Promise<WriteResult>): Promise<string> {
    return this.serial(async () => {
      // MR z tej sesji został w międzyczasie zmergowany/zamknięty → zaczynamy nowy
      let note = "";
      if (this.mr) {
        const state = (await gl.getMergeRequest(this.token, this.mr.iid)).state;
        if (state !== "opened") {
          note = `Poprzedni MR !${this.mr.iid} jest już ${state === "merged" ? "zmergowany" : "zamknięty"} — zakładam nowy.\n`;
          await this.restart();
        }
      } else {
        await git.refreshIfClean(this.dir);
      }

      let result: WriteResult;
      try {
        result = await fn(this.dir);
      } catch (e) {
        // cofnij niezatwierdzone zmiany po nieudanej operacji
        await git.git(this.dir, ["checkout", "--", "."]).catch(() => undefined);
        await git.git(this.dir, ["clean", "-fd"]).catch(() => undefined);
        throw e;
      }

      const author = { name: this.user.name, email: this.user.email };
      const committed = await git.commitAll(this.dir, `bruno: ${result.summary.replace(/`/g, "")}`, author);
      if (!committed) return `${note}${result.message}\n(Brak zmian w plikach — nic nie commitowano.)`;

      this.changes.push(result.summary);
      const { conflict } = await git.rebaseAndPush(this.dir, this.branch, this.token, author);

      const description = this.mrDescription();
      if (!this.mr) {
        this.mr = await gl.createMergeRequest(this.token, this.branch, this.mrTitle(), description);
      } else {
        this.mr = await gl.updateMergeRequest(this.token, this.mr.iid, { title: this.mrTitle(), description });
      }
      return (
        `${note}${result.message}\n\n` +
        `MR !${this.mr.iid} (${plural(this.changes.length)}): ${this.mr.web_url}` +
        (conflict ? `\n⚠ Branch ma konflikt z aktualnym ${settings.targetBranch} — do rozwiązania w MR.` : "")
      );
    });
  }

  newMr(): Promise<string> {
    return this.serial(async () => {
      const prev = this.mr;
      await this.restart();
      return prev
        ? `MR !${prev.iid} zostaje bez zmian (${prev.web_url}). Kolejne zmiany trafią do nowego MR-a.`
        : "Nie było jeszcze MR-a w tej sesji — zaczynam od świeżego stanu.";
    });
  }

  status(): Promise<string> {
    return this.serial(async () => {
      if (this.mr) this.mr = await gl.getMergeRequest(this.token, this.mr.iid).catch(() => this.mr!);
      return [
        `Użytkownik: ${this.user.name} (@${this.user.username})`,
        `Branch: ${this.branch}`,
        this.mr ? `MR !${this.mr.iid} [${this.mr.state}]: ${this.mr.web_url}` : "MR: jeszcze nie utworzony (powstanie przy pierwszej zmianie)",
        this.changes.length ? `Zmiany:\n${this.changes.map((c) => "- " + c).join("\n")}` : "Zmiany: brak",
      ].join("\n");
    });
  }

  private mrTitle(): string {
    if (this.changes.length === 1) return `Bruno: ${this.changes[0].replace(/`/g, "")}`;
    return `Bruno: ${plural(this.changes.length)} w kolekcjach (${this.user.username})`;
  }

  private mrDescription(): string {
    return [
      `Zmiany w kolekcjach Bruno od @${this.user.username}, zgłoszone przez serwer MCP.`,
      "",
      ...this.changes.map((c) => `- ${c}`),
      "",
      `_Branch: \`${this.branch}\` · kolejne zmiany z tej samej sesji trafiają do tego MR-a._`,
    ].join("\n");
  }
}
