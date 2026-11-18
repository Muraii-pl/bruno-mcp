#!/usr/bin/env bash
# Instalacja / aktualizacja serwera bruno-mcp w trybie central (Docker Compose).
#
#   scripts/install-server.sh            # .env (pyta o brakujące wartości) → pull → up → health check
#   scripts/install-server.sh --build    # zamiast pull z registry buduje obraz lokalnie (bruno-mcp:local)
#   scripts/install-server.sh --update   # tylko pull/build + restart, bez pytań o konfigurację
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BUILD=0
UPDATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1; shift ;;
    --update) UPDATE=1; shift ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Nieznana opcja: $1" ;;
  esac
done

have docker || die "Brak dockera."
docker compose version >/dev/null 2>&1 || die "Brak 'docker compose' (plugin Compose v2)."
have curl || die "Brak curl (potrzebny do health checku)."
cd "$PROJECT_DIR"

ENV_FILE="$PROJECT_DIR/.env"

# get_env KEY → wartość z .env (pusta, gdy brak)
get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1 || true; }

# set_env KEY VALUE → podmienia albo dopisuje linię w .env
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^$key=" "$ENV_FILE"; then
    KEY="$key" VAL="$val" awk 'BEGIN{k=ENVIRON["KEY"]; v=ENVIRON["VAL"]} index($0, k"=")==1 {print k"="v; next} {print}' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"; printf '%s=%s\n' "$key" "$val" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}

# ---------- .env ----------
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  ok "Utworzono .env z .env.example"
fi
chmod 600 "$ENV_FILE"

if [ "$UPDATE" = 0 ]; then
  info "Konfiguracja (.env) — Enter zostawia obecną wartość"
  for key in GITLAB_URL GITLAB_PROJECT TARGET_BRANCH DEFAULT_RUN_ENV BRUNO_MCP_PORT; do
    cur="$(get_env "$key")"
    val="$(ask "  $key" "$cur")"
    [ "$val" != "$cur" ] && set_env "$key" "$val"
  done
  if [ "$BUILD" = 0 ]; then
    cur="$(get_env BRUNO_MCP_IMAGE)"
    val="$(ask "  BRUNO_MCP_IMAGE" "$cur")"
    [ "$val" != "$cur" ] && set_env BRUNO_MCP_IMAGE "$val"
  fi
  if [ -z "$(get_env GITLAB_READ_TOKEN)" ]; then
    val="$(ask_secret "  GITLAB_READ_TOKEN (read_repository, nie będzie widoczny)")"
    [ -n "$val" ] && set_env GITLAB_READ_TOKEN "$val"
  else
    ok "GITLAB_READ_TOKEN już ustawiony"
  fi
fi

for key in GITLAB_URL GITLAB_PROJECT GITLAB_READ_TOKEN; do
  [ -n "$(get_env "$key")" ] || die "W .env brakuje $key"
done
case "$(get_env GITLAB_URL)" in *twoja-firma*) die "GITLAB_URL ma wartość przykładową — popraw .env" ;; esac

# ---------- sprawdzenie tokena odczytu ----------
GL_URL="$(get_env GITLAB_URL)"; GL_URL="${GL_URL%/}"
GL_PROJ="$(get_env GITLAB_PROJECT)"
GL_USER="$(get_env GITLAB_READ_USER)"; GL_USER="${GL_USER:-oauth2}"
info "Sprawdzam dostęp do $GL_URL/$GL_PROJ.git"
if have git && GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
     -c "http.extraHeader=Authorization: Basic $(printf '%s:%s' "$GL_USER" "$(get_env GITLAB_READ_TOKEN)" | base64 | tr -d '\n')" \
     ls-remote --heads "$GL_URL/$GL_PROJ.git" >/dev/null 2>&1; then
  ok "Token odczytu działa"
else
  warn "git ls-remote nie przeszedł — sprawdź GITLAB_URL, GITLAB_PROJECT, token (i GITLAB_READ_USER dla deploy tokena)."
  confirm "Kontynuować mimo to?" n || exit 1
fi

# ---------- obraz ----------
if [ "$BUILD" = 1 ]; then
  set_env BRUNO_MCP_IMAGE "bruno-mcp:local"
  info "Buduję obraz bruno-mcp:local"
  docker build -t bruno-mcp:local .
else
  info "Pobieram obraz $(get_env BRUNO_MCP_IMAGE)"
  docker compose pull || die "Pull nie wyszedł (docker login do registry?). Albo użyj --build."
fi

# ---------- start ----------
info "Uruchamiam kontener"
docker compose up -d --pull never

PORT="$(get_env BRUNO_MCP_PORT)"; PORT="${PORT:-3000}"
info "Czekam na http://127.0.0.1:$PORT/health"
for _ in $(seq 1 60); do
  if out="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null)"; then
    ok "Serwer działa: $out"
    echo
    echo "   Następne kroki:"
    echo "   - wystaw /mcp przez HTTPS (nginx: proxy_buffering off, proxy_read_timeout 1h — patrz README)"
    echo "   - developerzy: scripts/setup-client.sh --url https://<twoj-host>/mcp"
    echo "   - logi: docker compose logs -f"
    exit 0
  fi
  sleep 2
done
docker compose logs --tail 50
die "Serwer nie odpowiada na /health po 2 minutach (logi wyżej)."
