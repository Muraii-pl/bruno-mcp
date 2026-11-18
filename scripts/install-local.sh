#!/usr/bin/env bash
# Instalacja bruno-mcp w trybie local (stdio) dla Claude Code i/lub Cursora.
#
#   scripts/install-local.sh                 # build + rejestracja w Claude Code (scope user)
#   scripts/install-local.sh --cursor        # dodatkowo ~/.cursor/mcp.json
#   scripts/install-local.sh --with-bru      # dodatkowo npm i -g @usebruno/cli
#
# Skrypt jest idempotentny: ponowne uruchomienie przebudowuje i nadpisuje wpis.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

NAME="bruno"
DO_CLAUDE=1
DO_CURSOR=0
WITH_BRU=0
BRUNO_DIR=""
RUN_ENV=""

usage() {
  cat <<EOF
Użycie: $0 [opcje]

  --name <nazwa>       nazwa serwera MCP (domyślnie: bruno)
  --cursor             zarejestruj też w Cursorze (~/.cursor/mcp.json)
  --no-claude          nie rejestruj w Claude Code
  --with-bru           zainstaluj globalnie Bruno CLI (@usebruno/cli) i używaj go zamiast npx
  --bruno-dir <ścieżka> stała ścieżka kolekcji względem roota repo (BRUNO_DIR)
  --env <nazwa>        domyślne środowisko dla run_endpoint (DEFAULT_RUN_ENV)
  -h, --help           pomoc
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --cursor) DO_CURSOR=1; shift ;;
    --no-claude) DO_CLAUDE=0; shift ;;
    --with-bru) WITH_BRU=1; shift ;;
    --bruno-dir) BRUNO_DIR="$2"; shift 2 ;;
    --env) RUN_ENV="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Nieznana opcja: $1" ;;
  esac
done

require_node
have git || die "Brak gita (tryb local wykrywa root projektu przez git)."

# ---------- build ----------
info "Instaluję zależności i buduję ($PROJECT_DIR)"
cd "$PROJECT_DIR"
npm ci --no-audit --no-fund
npm run build
[ -f dist/server.js ] || die "Build nie wygenerował dist/server.js"
chmod +x dist/server.js
ok "Zbudowano dist/server.js"

# ---------- Bruno CLI ----------
if [ "$WITH_BRU" = 1 ]; then
  info "Instaluję Bruno CLI globalnie"
  npm install -g @usebruno/cli || die "Nie udało się zainstalować @usebruno/cli (może potrzebny prefix npm w \$HOME?)"
fi
BRU_BIN=""
if have bru; then
  BRU_BIN="$(command -v bru)"
  ok "Bruno CLI: $BRU_BIN ($(bru --version 2>/dev/null || echo '?'))"
else
  warn "Brak 'bru' w PATH — run_endpoint pobierze Bruno CLI przez npx przy pierwszym użyciu (wolniej). Użyj --with-bru."
fi

# ---------- konfiguracja serwera ----------
NODE_BIN="$(command -v node)"
SERVER_JS="$PROJECT_DIR/dist/server.js"

# env jako obiekt JSON
ENV_JSON="$(BRU_BIN="$BRU_BIN" BRUNO_DIR="$BRUNO_DIR" RUN_ENV="$RUN_ENV" node -e '
  const e = {};
  if (process.env.BRU_BIN) e.BRU_BIN = process.env.BRU_BIN;
  if (process.env.BRUNO_DIR) e.BRUNO_DIR = process.env.BRUNO_DIR;
  if (process.env.RUN_ENV) e.DEFAULT_RUN_ENV = process.env.RUN_ENV;
  process.stdout.write(JSON.stringify(e));
')"
SERVER_JSON="$(NODE_BIN="$NODE_BIN" SERVER_JS="$SERVER_JS" ENV_JSON="$ENV_JSON" node -e '
  process.stdout.write(JSON.stringify({
    type: "stdio",
    command: process.env.NODE_BIN,
    args: [process.env.SERVER_JS, "--local"],
    env: JSON.parse(process.env.ENV_JSON),
  }));
')"

# ---------- Claude Code ----------
if [ "$DO_CLAUDE" = 1 ]; then
  if have claude; then
    info "Rejestruję '$NAME' w Claude Code (scope user)"
    claude mcp remove --scope user "$NAME" >/dev/null 2>&1 || true
    claude mcp add-json --scope user "$NAME" "$SERVER_JSON"
    ok "Claude Code: '$NAME' → $SERVER_JS --local"
  else
    warn "Brak polecenia 'claude' — pomijam Claude Code. Ręcznie:"
    echo "    claude mcp add-json --scope user $NAME '$SERVER_JSON'"
  fi
fi

# ---------- Cursor ----------
if [ "$DO_CURSOR" = 1 ]; then
  CURSOR_CFG="$HOME/.cursor/mcp.json"
  info "Rejestruję '$NAME' w Cursorze ($CURSOR_CFG)"
  mkdir -p "$HOME/.cursor"
  [ -f "$CURSOR_CFG" ] && cp "$CURSOR_CFG" "$CURSOR_CFG.bak"
  CFG="$CURSOR_CFG" NAME="$NAME" SERVER_JSON="$SERVER_JSON" node -e '
    const fs = require("fs");
    const f = process.env.CFG;
    let cfg = {};
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, "utf8").trim();
      if (raw) cfg = JSON.parse(raw);
    }
    cfg.mcpServers ??= {};
    const s = JSON.parse(process.env.SERVER_JSON);
    delete s.type;
    cfg.mcpServers[process.env.NAME] = s;
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
  '
  ok "Cursor: zapisano (kopia poprzedniej wersji: $CURSOR_CFG.bak)"
fi

echo
ok "Gotowe. Otwórz Claude Code w projekcie z kolekcją Bruno i sprawdź: /mcp albo 'claude mcp list'."
echo "   Po 'git pull' w $PROJECT_DIR uruchom ten skrypt ponownie (przebudowa)."
