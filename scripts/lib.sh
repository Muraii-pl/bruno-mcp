# Wspólne funkcje dla skryptów instalacyjnych (source, nie uruchamiać bezpośrednio).

if [ -t 1 ]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLD=$'\e[1m'; C_RST=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLD=""; C_RST=""
fi

info() { printf '%s==>%s %s\n' "$C_BLD" "$C_RST" "$*"; }
ok()   { printf '%s ✔%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s !%s %s\n' "$C_YLW" "$C_RST" "$*" >&2; }
die()  { printf '%s ✘%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Katalog repo bruno-mcp (rodzic katalogu scripts/)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_node() {
  have node || die "Brak Node.js (wymagane >= 20)."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node.js $major — wymagane >= 20."
  have npm || die "Brak npm."
}

# ask "Pytanie" "domyślna" → odpowiedź na stdout. Bez terminala zwraca domyślną.
ask() {
  local q="$1" def="${2:-}" ans
  if [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then read -r -p "$q [$def]: " ans </dev/tty; else read -r -p "$q: " ans </dev/tty; fi
  printf '%s' "${ans:-$def}"
}

# ask_secret "Pytanie" → odpowiedź bez echa
ask_secret() {
  local q="$1" ans
  [ -t 0 ] || { printf ''; return; }
  read -r -s -p "$q: " ans </dev/tty; echo >&2
  printf '%s' "$ans"
}

# confirm "Pytanie" [t|n] → 0 gdy tak
confirm() {
  local q="$1" def="${2:-n}" ans hint="[t/N]"
  [ "$def" = "t" ] && hint="[T/n]"
  if [ ! -t 0 ]; then [ "$def" = "t" ]; return; fi
  read -r -p "$q $hint " ans </dev/tty
  ans="${ans:-$def}"
  [[ "$ans" =~ ^[tTyY] ]]
}

# json_escape "tekst" → tekst jako literał JSON (z cudzysłowami)
json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
