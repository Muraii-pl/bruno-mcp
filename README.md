# bruno-mcp: serwer MCP dla kolekcji Bruno

Dwa tryby z tego samego kodu i z tymi samymi narzędziami:

| | **central** (firma) | **local** (prywatne projekty) |
|---|---|---|
| Uruchomienie | Docker na serwerze, HTTP | Claude Code / Cursor startuje go w projekcie (stdio) |
| Na czym pracuje | klon repo kolekcji w GitLabie | kolekcja w bieżącym repo |
| Zapis | branch, commit, MR do akceptacji | pliki `.bru` prosto na dysk, commitujesz sam |
| Logowanie do API | nagłówki `X-Bru-Env-*` | `.env` w kolekcji (jak w aplikacji Bruno) |
| Dodatkowe narzędzia | `mr_status`, `new_mr` | brak |

Który serwer działa, wynika z `.mcp.json`. Szczegóły w sekcji [Dwa serwery naraz](#dwa-serwery-naraz-firma--prywatne).

---

## Tryb central

Serwer MCP (HTTP) działający w Dockerze na serwerze firmowym. Trzyma klon repo z kolekcjami Bruno
i pozwala developerom (przez Claude Code / Cursor) przeglądać, dodawać, edytować i uruchamiać requesty.
**Każda zmiana trafia do GitLaba jako MR do akceptacji**, nigdy wprost na `main`.

```
Claude Code (dev A) ──┐   Authorization: Bearer <token GitLab A>
Claude Code (dev B) ──┼──► bruno-mcp (Docker) ──► worktree A → branch bruno/a/… → MR !12 (autor: A)
                      │         │                  worktree B → branch bruno/b/… → MR !13 (autor: B)
                      │         └── bru run (na branchu sesji) ──► API dev / Keycloak
```

## Jak to działa

- **Sesja = rozmowa w Claude Code.** Każda sesja dostaje własny worktree i branch
  `bruno/<login>/<data>-<id>` od najnowszego `main`. Sesje nie przeszkadzają sobie nawzajem.
- **Jeden MR na sesję.** Pierwsza zmiana robi commit, push i otwiera MR. Kolejne zmiany z tej samej rozmowy
  dopisują commity do tego samego MR-a, a jego tytuł i opis (lista zmian) są aktualizowane.
- **Autor = developer.** Łączy się swoim tokenem GitLab, więc commity i MR są podpisane jego nazwiskiem,
  a uprawnienia są jak w GitLabie (wymagana rola co najmniej Developer w projekcie kolekcji).
- **MR zmergowany w trakcie sesji?** Następna zmiana sama zaczyna nowy branch od świeżego `main` i nowy MR.
- Przed każdym pushem branch jest rebase'owany na aktualny `main`. Przy konflikcie push idzie bez rebase'u,
  a MR pokazuje konflikt.
- Sesja bez aktywności przez `SESSION_IDLE_MINUTES` (domyślnie 4 h) jest zamykana. Branch i MR zostają w GitLabie.

## Narzędzia

| Narzędzie | Co robi |
|---|---|
| `list_folders` | drzewo folderów repo z liczbą requestów |
| `list_endpoints` | requesty w folderze: metoda, URL, nazwa, plik (z filtrem) |
| `read_bru` | pełna treść pliku `.bru` / `bruno.json` |
| `add_endpoint` | nowy request w konwencji repo (→ commit + MR) |
| `write_bru` | zapis całego pliku `.bru`: skrypty, testy, asercje, `folder.bru` (→ commit + MR) |
| `remove_bru` | usunięcie requestu, pusty folder znika razem z nim (→ commit + MR) |
| `run_endpoint` | `bru run` pliku/folderu na branchu sesji: status, czas, asercje, body |
| `mr_status` | branch, link i stan MR-a, lista zmian |
| `new_mr` | kolejne zmiany pójdą do nowego MR-a |

`add_endpoint` trzyma się konwencji istniejących kolekcji:
- plik = `<name>.bru`, `meta.name` = nazwa (np. `findByContractUid`)
- brakujące foldery dostają `folder.bru` (`meta` + `auth: inherit`)
- `seq` = następny w folderze, wspólny dla requestów i podfolderów
- podajesz `path` (np. `/njord/api/deposit/correction/contract/:contractUid`), a baza URL
  (`{{host}}:{{zuulPort}}`) jest brana z sąsiednich requestów
- `pathParams` (np. `{"uid": "{{depositUid}}"}`), `postResponseVars` (np. `{"depositUid": "res.body.depositUid"}`),
  `jsonBody`, `query`, `headers`, `description` (zakładka Docs)
- auth zawsze `inherit`

## Wdrożenie

### 1. GitLab

- **Token odczytu dla serwera** (`GITLAB_READ_TOKEN`): Project access token w projekcie kolekcji
  ze scope `read_repository` i rolą Reporter. Albo deploy token: wtedy ustaw też `GITLAB_READ_USER`.
- **Każdy developer**: Personal access token ze scope **`api`** (tworzenie MR) i **`write_repository`** (push).
- Zalecane w projekcie kolekcji: chroniony `main` i wymagane zatwierdzenie MR.

### 2. Obraz

`.gitlab-ci.yml` buduje obraz i wypycha go do GitLab Container Registry projektu
(`:latest` z domyślnego brancha, `:<tag>` z tagów). Lokalnie: `docker build -t bruno-mcp .`

### 3. Serwer

```bash
cp .env.example .env      # uzupełnij GITLAB_READ_TOKEN
# w docker-compose.yml: GITLAB_URL, GITLAB_PROJECT, image
docker compose up -d
curl http://127.0.0.1:3000/health
```

Wystaw serwer **tylko przez HTTPS** (nginx / Traefik), bo w nagłówkach idą tokeny.
Dla nginx wyłącz buforowanie na `/mcp`:

```nginx
location /mcp {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

Wszystkie zmienne:

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `GITLAB_URL` | wymagane | np. `https://gitlab.twoja-firma.pl` |
| `GITLAB_PROJECT` | wymagane | ścieżka projektu z kolekcjami, np. `platform/api-collections` |
| `GITLAB_READ_TOKEN` | wymagane | token do clone/fetch |
| `GITLAB_READ_USER` | `oauth2` | login do tokena (dla deploy tokena: jego nazwa) |
| `GITLAB_REPO_URL` | `<GITLAB_URL>/<PROJECT>.git` | inny adres klonowania (np. wewnętrzny) |
| `TARGET_BRANCH` | `main` | branch docelowy MR-ów |
| `DEFAULT_RUN_ENV` | — | domyślne środowisko dla `run_endpoint` (bez tego: `local` albo jedyne istniejące) |
| `SESSION_IDLE_MINUTES` | `240` | po ilu minutach bezczynności sesja jest zamykana |
| `BRANCH_PREFIX` | `bruno` | prefiks branchy |
| `PORT` | `3000` | |

### 4. Developerzy

W **każdym repo serwisu** (albo raz globalnie, w `~/.claude.json`), plik `.mcp.json`:

```json
{
  "mcpServers": {
    "bruno": {
      "type": "http",
      "url": "https://bruno-mcp.twoja-firma.pl/mcp",
      "headers": {
        "Authorization": "Bearer ${GITLAB_TOKEN}",
        "X-Bru-Env-KC-USER": "${KC_USER}",
        "X-Bru-Env-KC-PASSWORD": "${KC_PASSWORD}"
      }
    }
  }
}
```

Każdy ustawia u siebie zmienne środowiskowe `GITLAB_TOKEN`, `KC_USER` i `KC_PASSWORD`
(np. w `~/.zshrc`). Plik `.mcp.json` nie zawiera sekretów, więc można go commitować.

## Logowanie w `run_endpoint`

Nagłówek `X-Bru-Env-<NAZWA>` trafia do Bruno CLI jako zmienna procesu `<NAZWA>`
(myślniki są zamieniane na `_`). Kolekcja czyta ją przez `{{process.env.NAZWA}}`.
Przykład: `X-Bru-Env-KC-USER: jan` daje `{{process.env.KC_USER}}`.

- Wartości są trzymane tylko w pamięci sesji, nie trafiają na dysk ani do logów.
- Gdy developer nie poda nagłówków, `bru` dostaje zmienne serwera, np. konto techniczne z `.env`.
- Używajcie nazw zgodnych z tym, jak Wasza kolekcja odwołuje się do `process.env`.

`run_endpoint` działa na **branchu sesji**, więc nowy request można odpalić przed merge'em.

## Bezpieczeństwo

- Token GitLab jest sprawdzany przy otwarciu sesji (`/user` i rola w projekcie). Każde kolejne
  żądanie musi przyjść z tym samym tokenem (inaczej 403).
- Tokeny nie są zapisywane w konfiguracji git. Idą jako nagłówek tylko dla danego polecenia
  i są maskowane w błędach.
- Ścieżki są ograniczone do repo (bez `../` i `.git`). Zapis tylko plików `.bru`.
- Serwer nigdy nie pushuje na `main`, tylko na własne branche `bruno/…`.

## Tryb local

Instalacja globalna (dla wszystkich Twoich projektów):

```bash
# z repo na GitHubie (buduje się przy instalacji)
claude mcp add --scope user bruno -- npx -y github:twoj-login/bruno-mcp --local

# albo z lokalnego klonu
git clone … ~/tools/bruno-mcp && cd ~/tools/bruno-mcp && npm install
claude mcp add --scope user bruno -- node ~/tools/bruno-mcp/dist/server.js --local
```

Bruno CLI jest pobierane przez `npx` przy pierwszym `run_endpoint`. Żeby było szybciej, zainstaluj je globalnie
(`npm i -g @usebruno/cli`) i dodaj do polecenia `-e BRU_BIN=bru`.

Jak serwer znajduje kolekcję:
1. `BRUNO_DIR` (ścieżka względem roota repo), jeśli ustawione, np. `-e BRUNO_DIR=api/bruno`,
2. w przeciwnym razie szuka `bruno.json` w repo (do 4 poziomów, bez `node_modules`, `dist` itp.).
   Jeśli jest jedna kolekcja, ścieżki w narzędziach są względem niej. Jeśli kilka, ścieżki są względem roota repo.

Serwer startuje z dowolnego podkatalogu projektu, bo root repo wykrywa przez `git`.

`run_endpoint` wybiera środowisko tak: parametr `env`, potem `DEFAULT_RUN_ENV`, potem `local`,
a jeśli w kolekcji jest tylko jedno środowisko, to to jedno. Dane logowania bierze z `.env` w kolekcji
(`{{process.env.X}}`), tak jak aplikacja Bruno.

## Dwa serwery naraz: firma + prywatne

Claude Code przy **tej samej nazwie** serwera bierze konfigurację projektu (`.mcp.json` w repo)
przed konfiguracją użytkownika (`--scope user`). Dlatego:

- **u siebie raz:** `bruno` w trybie local, globalnie (polecenie wyżej),
- **w repo firmowych:** commitowany `.mcp.json`, który pod tą samą nazwą wskazuje serwer central:

```json
{
  "mcpServers": {
    "bruno": {
      "type": "http",
      "url": "https://bruno-mcp.twoja-firma.pl/mcp",
      "headers": {
        "Authorization": "Bearer ${GITLAB_TOKEN}",
        "X-Bru-Env-KC-USER": "${KC_USER}",
        "X-Bru-Env-KC-PASSWORD": "${KC_PASSWORD}"
      }
    }
  }
}
```

W repo firmowym zmiany idą przez MR, a w prywatnym projekcie od razu do plików. Decyduje katalog,
w którym otwierasz Claude Code. Sprawdzisz to poleceniem `/mcp` w Claude Code albo `claude mcp list`.

Jeśli wolisz mieć oba serwery naraz pod różnymi nazwami (np. `bruno-firma` i `bruno`), dodaj firmowy
też globalnie. Model zobaczy wtedy dwa zestawy narzędzi, więc mów mu wprost, którego użyć.

## Rozwój

```bash
npm install
GITLAB_URL=… GITLAB_PROJECT=… GITLAB_READ_TOKEN=… DATA_DIR=./data npm run dev   # central
(cd ~/jakis-projekt && npx tsx ~/tools/bruno-mcp/src/server.ts --local)              # local
```

Kod: `src/server.ts` (wybór trybu, HTTP + sesje), `src/local.ts` (tryb local), `src/workspace.ts` (wspólny interfejs),
`src/session.ts` (branch/commit/MR), `src/git.ts`,
`src/gitlab.ts`, `src/collection.ts` (operacje na .bru + raport z `bru run`), `src/tools.ts` (definicje narzędzi).
