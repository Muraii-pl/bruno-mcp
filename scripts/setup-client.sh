#!/usr/bin/env bash
# Konfiguracja developera do serwera bruno-mcp w trybie central.
#
#   scripts/setup-client.sh --url https://bruno-mcp.firma.pl/mcp --repo ~/work/serwis   # .mcp.json w repo
#   scripts/setup-client.sh --url https://bruno-mcp.firma.pl/mcp --global               # Claude Code, scope user
#
# Sekrety (GITLAB_TOKEN, KC_USER, KC_PASSWORD) nie trafiają do .mcp.json — tam są tylko ${ZMIENNE}.
# Z --save-env skrypt zapisuje je do ~/.config/bruno-mcp/env (chmod 600) i dopina do ~/.bashrc / ~/.zshrc.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

URL=""
REPO=""
GLOBAL=0
SAVE_ENV=0
NAME="bruno"
# zmienne Bruno przekazywane nagłówkami X-Bru-Env-* (nazwy jak w {{process.env.X}} kolekcji)
BRU_VARS=(KC_USER KC_PASSWORD)

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --global) GLOBAL=1; shift ;;
    --save-env) SAVE_ENV=1; shift ;;
    --name) NAME="$2"; shift 2 ;;
    --vars) IFS=, read -r -a BRU_VARS <<<"$2"; shift 2 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      echo; echo "  --name <nazwa>   nazwa serwera (domyślnie bruno)"
      echo "  --vars A,B       zmienne X-Bru-Env-* (domyślnie KC_USER,KC_PASSWORD)"
      exit 0 ;;
    *) die "Nieznana opcja: $1" ;;
  esac
done

have node || die "Brak Node.js (potrzebny do zapisu JSON)."
[ -n "$URL" ] || URL="$(ask "Adres serwera MCP (https://…/mcp)" "")"
[ -n "$URL" ] || die "Podaj --url"
[[ "$URL" == https://* ]] || warn "Adres nie jest HTTPS — tokeny GitLab pójdą otwartym tekstem."
[ "$GLOBAL" = 1 ] || [ -n "$REPO" ] || REPO="$(ask "Repo, w którym zapisać .mcp.json" "$PWD")"

# ---------- konfiguracja serwera (z placeholderami ${VAR}) ----------
SERVER_JSON="$(URL="$URL" VARS="${BRU_VARS[*]}" node -e '
  const headers = { Authorization: "Bearer ${GITLAB_TOKEN}" };
  for (const v of process.env.VARS.split(" ").filter(Boolean))
    headers["X-Bru-Env-" + v.replace(/_/g, "-")] = "${" + v + "}";
  process.stdout.write(JSON.stringify({ type: "http", url: process.env.URL, headers }));
')"

if [ "$GLOBAL" = 1 ]; then
  have claude || die "Brak polecenia 'claude'."
  claude mcp remove --scope user "$NAME" >/dev/null 2>&1 || true
  claude mcp add-json --scope user "$NAME" "$SERVER_JSON"
  ok "Claude Code (scope user): '$NAME' → $URL"
  warn "Uwaga: to nadpisuje lokalny tryb '$NAME' w scope user. Dla obu naraz użyj --name bruno-firma."
else
  REPO="$(cd "$REPO" && pwd)" || die "Brak katalogu $REPO"
  CFG="$REPO/.mcp.json"
  [ -f "$CFG" ] && cp "$CFG" "$CFG.bak"
  CFG="$CFG" NAME="$NAME" SERVER_JSON="$SERVER_JSON" node -e '
    const fs = require("fs"); const f = process.env.CFG;
    const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8") || "{}") : {};
    cfg.mcpServers ??= {};
    cfg.mcpServers[process.env.NAME] = JSON.parse(process.env.SERVER_JSON);
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
  '
  ok "Zapisano $CFG (bez sekretów — można commitować)"
fi

# ---------- zmienne środowiskowe ----------
ALL_VARS=(GITLAB_TOKEN "${BRU_VARS[@]}")

if [ "$SAVE_ENV" = 1 ]; then
  ENV_DIR="$HOME/.config/bruno-mcp"; ENV_FILE="$ENV_DIR/env"
  mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
  umask 077
  {
    echo "# bruno-mcp — sekrety dla .mcp.json (generowane przez setup-client.sh)"
    for v in "${ALL_VARS[@]}"; do
      cur="${!v:-}"
      if [[ "$v" == *PASSWORD* || "$v" == *TOKEN* ]]; then
        val="$(ask_secret "$v${cur:+ (Enter = obecna wartość)}")"
      else
        val="$(ask "$v" "$cur")"
      fi
      val="${val:-$cur}"
      printf 'export %s=%q\n' "$v" "$val"
    done
  } >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  ok "Zapisano $ENV_FILE"

  LINE="[ -f \"$ENV_FILE\" ] && . \"$ENV_FILE\"   # bruno-mcp"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$ENV_FILE" "$rc" || { printf '\n%s\n' "$LINE" >>"$rc"; ok "Dopisano do $rc"; }
  done
  echo "   Otwórz nowy terminal (albo: . $ENV_FILE) przed uruchomieniem Claude Code."
else
  missing=()
  for v in "${ALL_VARS[@]}"; do [ -n "${!v:-}" ] || missing+=("$v"); done
  if [ ${#missing[@]} -gt 0 ]; then
    warn "Nieustawione zmienne: ${missing[*]}"
    echo "   Ustaw je w ~/.bashrc / ~/.zshrc albo uruchom ponownie z --save-env."
    echo "   GITLAB_TOKEN: Personal access token ze scope 'api' i 'write_repository'."
  else
    ok "Zmienne ${ALL_VARS[*]} są ustawione"
  fi
fi

# ---------- test połączenia ----------
if [ -n "${GITLAB_TOKEN:-}" ] && have curl; then
  BASE="${URL%/mcp}"
  if curl -fsS --max-time 5 "$BASE/health" >/dev/null 2>&1; then ok "Serwer odpowiada: $BASE/health"
  else warn "Nie udało się połączyć z $BASE/health (VPN? adres?)"; fi
fi
