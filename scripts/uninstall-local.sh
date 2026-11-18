#!/usr/bin/env bash
# Usuwa rejestrację bruno-mcp (tryb local) z Claude Code i Cursora. Nie kasuje repo ani dist/.
#   scripts/uninstall-local.sh [--name bruno]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

NAME="bruno"
[ "${1:-}" = "--name" ] && NAME="$2"

if have claude; then
  if claude mcp remove --scope user "$NAME" >/dev/null 2>&1; then ok "Claude Code: usunięto '$NAME'"
  else warn "Claude Code: brak '$NAME' w scope user"; fi
fi

CURSOR_CFG="$HOME/.cursor/mcp.json"
if [ -f "$CURSOR_CFG" ] && have node; then
  if CFG="$CURSOR_CFG" NAME="$NAME" node -e '
    const fs = require("fs"); const f = process.env.CFG;
    const cfg = JSON.parse(fs.readFileSync(f, "utf8") || "{}");
    if (!cfg.mcpServers?.[process.env.NAME]) process.exit(1);
    delete cfg.mcpServers[process.env.NAME];
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
  '; then ok "Cursor: usunięto '$NAME'"; else warn "Cursor: brak '$NAME'"; fi
fi
