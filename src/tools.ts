/** Definicje narzędzi MCP dla jednej sesji. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as col from "./collection.js";
import { settings } from "./settings.js";
import type { Workspace } from "./workspace.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Błąd: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});
const wrap = <A>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try {
    return ok(await fn(a));
  } catch (e) {
    return fail(e);
  }
};

const CONVENTIONS = `Zanim dodasz request: obejrzyj strukturę (list_folders), istniejące requesty w docelowym folderze (list_endpoints) i jeden z nich w całości (read_bru), żeby trzymać konwencje: krótkie nazwy w camelCase (np. findByUid), ścieżka URL zgodna z sąsiadami, wartości params:path i vars:post-response do łańcuchowania requestów.`;

function instructions(ws: Workspace): string {
  const head =
    ws.mode === "central"
      ? `Serwer kolekcji Bruno (${settings.gitlabProject}). Każda zmiana (add_endpoint, write_bru, remove_bru) jest commitowana na branch tej sesji, a pierwsza otwiera MR w GitLabie do akceptacji — kolejne dopisują się do tego samego MR.`
      : `Kolekcje Bruno w ${ws.label}. Zmiany (add_endpoint, write_bru, remove_bru) są zapisywane bezpośrednio w plikach projektu, bez commita i MR-a — użytkownik commituje sam.`;
  return `${head}\n${CONVENTIONS}`;
}

export function buildServer(s: Workspace): McpServer {
  const server = new McpServer({ name: "bruno-mcp", version: "1.1.0" }, { instructions: instructions(s) });
  const afterWrite = s.mode === "central" ? "Zmiana jest commitowana i trafia do MR-a sesji." : "Zmiana jest zapisywana w plikach projektu.";

  // ------------------------------------------------------------------ odczyt
  server.registerTool(
    "list_folders",
    { title: "Struktura repo", description: "Drzewo folderów repo z kolekcjami (z liczbą requestów).", inputSchema: {} },
    wrap(() => s.read((repo) => col.listFolders(repo))),
  );

  server.registerTool(
    "list_endpoints",
    {
      title: "Lista requestów",
      description: "Requesty w folderze (rekurencyjnie): metoda, URL, nazwa, plik.",
      inputSchema: {
        folder: z.string().default(".").describe("Folder względem roota repo, np. deposit/correction"),
        filter: z.string().optional().describe("Filtr tekstowy po URL/nazwie/pliku"),
      },
    },
    wrap(({ folder, filter }) => s.read((repo) => col.listEndpoints(repo, folder, filter))),
  );

  server.registerTool(
    "read_bru",
    {
      title: "Odczytaj plik .bru",
      description: "Zwraca pełną treść pliku .bru (request, folder.bru, collection.bru) albo bruno.json.",
      inputSchema: { file: z.string().describe("np. deposit/deposit/create.bru") },
    },
    wrap(({ file }) => s.read((repo) => col.readBru(repo, file))),
  );

  // ------------------------------------------------------------------ zapis (→ commit + MR)
  server.registerTool(
    "add_endpoint",
    {
      title: "Dodaj / nadpisz request",
      description:
        "Tworzy request .bru w podanym folderze (brakujące foldery dostają folder.bru). Gdy podasz path, baza URL (np. {{host}}:{{zuulPort}}) jest brana z sąsiednich requestów. Auth dziedziczony. " + afterWrite,
      inputSchema: {
        folder: z.string().describe("Folder docelowy, np. deposit/correction"),
        name: z.string().describe("Nazwa requestu = nazwa pliku, w konwencji repo (np. findByContractUid)"),
        method: z.enum(col.METHODS),
        path: z.string().optional().describe("Ścieżka od bazy, np. /njord/api/deposit/uid/:uid"),
        url: z.string().optional().describe("Albo pełny URL ze zmiennymi (zamiast path)"),
        pathParams: z.record(z.string()).optional().describe('Wartości :param, np. {"uid":"{{depositUid}}"}'),
        query: z.record(z.string()).optional(),
        headers: z.record(z.string()).optional(),
        jsonBody: z.string().optional().describe("Przykładowe body JSON (string)"),
        postResponseVars: z
          .record(z.string())
          .optional()
          .describe('Zmienne do łańcuchowania, np. {"depositUid":"res.body.depositUid"}'),
        description: z.string().optional().describe("Opis do zakładki Docs"),
        overwrite: z.boolean().default(false),
      },
    },
    wrap((i) => s.write((repo) => col.addEndpoint(repo, i))),
  );

  server.registerTool(
    "write_bru",
    {
      title: "Zapisz surowy plik .bru",
      description:
        "Zapisuje pełną treść pliku .bru — do zmian, których nie obejmuje add_endpoint (skrypty, testy, asercje, vars, folder.bru). Najpierw read_bru, potem zapis całości. " + afterWrite,
      inputSchema: {
        file: z.string().describe("np. deposit/deposit/accept.bru"),
        content: z.string().describe("Pełna nowa treść pliku"),
      },
    },
    wrap(({ file, content }) => s.write((repo) => col.writeBru(repo, file, content))),
  );

  server.registerTool(
    "remove_bru",
    {
      title: "Usuń request",
      description: "Usuwa plik requestu (.bru). Pusty folder jest usuwany razem z folder.bru. " + afterWrite,
      inputSchema: { file: z.string() },
    },
    wrap(({ file }) => s.write((repo) => col.removeBru(repo, file))),
  );

  // ------------------------------------------------------------------ uruchamianie
  server.registerTool(
    "run_endpoint",
    {
      title: "Uruchom request",
      description:
        (s.mode === "central"
          ? "Uruchamia request lub folder przez Bruno CLI na serwerze (stan z brancha tej sesji)"
          : "Uruchamia request lub folder przez Bruno CLI lokalnie (dane logowania z .env kolekcji)") +
        " i zwraca status, czas, wyniki asercji/testów i body odpowiedzi.",
      inputSchema: {
        target: z.string().describe("Plik .bru albo folder"),
        env: z
          .string()
          .optional()
          .describe(
            `Środowisko Bruno. Domyślnie: ${settings.defaultRunEnv ? settings.defaultRunEnv + ", potem " : ""}"local", a jeśli jest tylko jedno — to jedno.`,
          ),
        maxBodyChars: z.number().int().min(0).default(4000),
        includeHeaders: z.boolean().default(false),
      },
    },
    async (o) => {
      try {
        const r = await s.read((repo) => col.runEndpoint(repo, { ...o, secrets: s.secrets }));
        return r.isError ? fail(new Error(r.text)) : ok(r.text);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------------------ MR (tylko central)
  if (s.status && s.newMr) {
  const status = s.status.bind(s), newMr = s.newMr.bind(s);
  server.registerTool(
    "mr_status",
    { title: "Status MR-a sesji", description: "Branch, link i stan MR-a oraz lista zmian w tej sesji.", inputSchema: {} },
    wrap(() => status()),
  );

  server.registerTool(
    "new_mr",
    {
      title: "Zacznij nowy MR",
      description: "Zamyka bieżący zestaw zmian (MR zostaje do akceptacji) — kolejne zmiany pójdą do nowego MR-a od świeżego main.",
      inputSchema: {},
    },
    wrap(() => newMr()),
  );
  }

  return server;
}
