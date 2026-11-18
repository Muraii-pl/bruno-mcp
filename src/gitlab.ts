/** Minimalny klient GitLab REST API v4 — wywołania tokenem użytkownika. */
import { settings } from "./settings.js";

export type GitlabUser = { id: number; username: string; name: string; email: string };
export type MergeRequest = { iid: number; web_url: string; state: string; title: string };

export class GitlabError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${settings.gitlabUrl}/api/v4${path}`, {
    method,
    headers: { "PRIVATE-TOKEN": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new GitlabError(res.status, `GitLab ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const project = () => `/projects/${encodeURIComponent(settings.gitlabProject)}`;

export async function currentUser(token: string): Promise<GitlabUser> {
  const u = await api<any>(token, "GET", "/user");
  return {
    id: u.id,
    username: u.username,
    name: u.name || u.username,
    email: u.commit_email || u.public_email || u.email || `${u.username}@users.noreply.gitlab`,
  };
}

/** Sprawdza, czy użytkownik ma co najmniej rolę Developer (30) w projekcie z kolekcjami. */
export async function assertCanPush(token: string): Promise<void> {
  const p = await api<any>(token, "GET", project());
  const level = Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
  if (level < 30) throw new GitlabError(403, `Brak uprawnień Developer w projekcie ${settings.gitlabProject}`);
}

export async function createMergeRequest(
  token: string,
  sourceBranch: string,
  title: string,
  description: string,
): Promise<MergeRequest> {
  return api<MergeRequest>(token, "POST", `${project()}/merge_requests`, {
    source_branch: sourceBranch,
    target_branch: settings.targetBranch,
    title,
    description,
    remove_source_branch: true,
  });
}

export async function getMergeRequest(token: string, iid: number): Promise<MergeRequest> {
  return api<MergeRequest>(token, "GET", `${project()}/merge_requests/${iid}`);
}

export async function updateMergeRequest(
  token: string,
  iid: number,
  fields: { title?: string; description?: string },
): Promise<MergeRequest> {
  return api<MergeRequest>(token, "PUT", `${project()}/merge_requests/${iid}`, fields);
}
