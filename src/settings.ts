/** Ustawienia — wyłącznie ze zmiennych środowiskowych. Zmienne GitLaba są wymagane tylko w trybie central. */

const env = (name: string) => process.env[name] ?? "";

export function validateCentralSettings(): void {
  const missing = ["GITLAB_URL", "GITLAB_PROJECT", "GITLAB_READ_TOKEN"].filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Tryb central: brak zmiennych środowiskowych ${missing.join(", ")}`);
}

export const settings = {
  port: Number(process.env.PORT ?? 3000),
  /** np. https://gitlab.twoja-firma.pl */
  gitlabUrl: env("GITLAB_URL").replace(/\/+$/, ""),
  /** ścieżka projektu z kolekcjami, np. platform/api-collections */
  gitlabProject: env("GITLAB_PROJECT"),
  /** token tylko do odczytu repo (deploy token / project access token z read_repository) — do clone/fetch */
  gitlabReadToken: env("GITLAB_READ_TOKEN"),
  /** login do tokena odczytu: dla deploy tokena jego nazwa użytkownika, dla tokenów projektu/grupy dowolny */
  gitlabReadUser: process.env.GITLAB_READ_USER || "oauth2",
  /** opcjonalnie: inny URL klonowania (np. ssh albo wewnętrzny adres); domyślnie <GITLAB_URL>/<PROJECT>.git */
  repoUrl: process.env.GITLAB_REPO_URL,
  targetBranch: process.env.TARGET_BRANCH ?? "main",
  dataDir: process.env.DATA_DIR ?? "/data",
  /** sesja bez aktywności dłużej niż tyle minut jest zamykana (branch i MR zostają w GitLabie) */
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 240),
  /** środowisko Bruno używane domyślnie przez run_endpoint (puste = wybór automatyczny) */
  defaultRunEnv: process.env.DEFAULT_RUN_ENV || undefined,
  /** prefiks branchy tworzonych przez serwer */
  branchPrefix: process.env.BRANCH_PREFIX ?? "bruno",
};

export function repoCloneUrl(): string {
  return settings.repoUrl ?? `${settings.gitlabUrl}/${settings.gitlabProject}.git`;
}
