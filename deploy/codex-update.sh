#!/usr/bin/env bash
# Installs or updates OpenAI Codex CLI (standalone package from github.com/openai/codex releases) for every member
# under /opt/devdash/codex. Versioned dirs + an atomic `current` symlink; keeps the previous version for rollback and
# restarts active member devdash-t3@*.service units so T3 Code picks up the updated binary. Run as root.
# Usage: codex-update.sh [version]   (default: latest release)
set -euo pipefail
main() {
  [[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }

  local TARGET
  case "$(uname -m)" in
    x86_64|amd64) TARGET="x86_64-unknown-linux-musl" ;;
    aarch64|arm64) TARGET="aarch64-unknown-linux-musl" ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  local VER="${1:-}"
  if [[ -z $VER ]]; then
    VER=$(curl -fsSL "https://registry.npmjs.org/@openai/codex/latest" \
      | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); if (d.version) process.stdout.write(String(d.version));' 2>/dev/null || true)
  fi
  if [[ -z $VER ]]; then
    VER=$(curl -fsSL -H "User-Agent: devdash-codex-updater" "https://api.github.com/repos/openai/codex/releases/latest" \
      | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); const t = String(d.tag_name || "").replace(/^rust-v|^v/, ""); if (t) process.stdout.write(t);')
  fi
  VER="${VER#rust-v}"
  VER="${VER#v}"
  [[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $VER" >&2; exit 1; }

  local BASE=/opt/devdash/codex
  local DIR="$BASE/$VER"
  install -d -m 755 "$BASE"

  if ! "$DIR/bin/codex" --version >/dev/null 2>&1; then
    local TMP
    TMP=$(mktemp -d "${BASE}/.download-${VER}.XXXXXX")
    trap 'rm -rf "${TMP:-}"' EXIT
    local URL="https://github.com/openai/codex/releases/download/rust-v${VER}/codex-package-${TARGET}.tar.gz"
    echo "downloading $URL"
    curl -fsSL --retry 3 --retry-delay 2 -o "$TMP/codex.tar.gz" "$URL"
    mkdir -p "$TMP/extract"
    tar -xzf "$TMP/codex.tar.gz" -C "$TMP/extract"

    # Handle tarballs that unpack either directly (bin/codex at root) or inside a single top-level directory.
    local SRC="$TMP/extract"
    if [[ ! -x "$SRC/bin/codex" ]]; then
      local SUB
      SUB=$(find "$TMP/extract" -mindepth 1 -maxdepth 2 -type f -path '*/bin/codex' -printf '%h\n' | head -n 1 || true)
      [[ -n $SUB && -x "$SUB/codex" ]] || { echo "bin/codex not found in archive" >&2; exit 1; }
      SRC="$(dirname "$SUB")"
    fi

    rm -rf "$DIR"
    mv "$SRC" "$DIR"
    ln -sfn bin/codex "$DIR/codex"
    chown -R root:root "$DIR"
    chmod -R go-w "$DIR"
    chmod 0755 "$DIR/bin/codex"
    "$DIR/bin/codex" --version >/dev/null || { rm -rf "$DIR"; echo "codex $VER failed self-check: removed it, nothing changed" >&2; exit 1; }
    rm -rf "$TMP"
    trap - EXIT
  fi

  ln -sfn "$DIR" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"

  local LINK=/usr/local/bin/codex
  if [[ ! -e $LINK || "$(readlink -f "$LINK")" == "$BASE"/* ]]; then
    ln -sfn "$BASE/current/bin/codex" "$LINK"
  fi

  # Keep the two newest installed versions for rollback.
  ls -1dt "$BASE"/[0-9]*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf

  # Restart active member-owned T3 Code services so they pick up the updated Codex binary.
  local UNITS
  UNITS=$(systemctl list-units --type=service --state=active --plain --no-legend 'devdash-t3@*.service' 2>/dev/null | awk '{print $1}' || true)
  if [[ -n $UNITS ]]; then
    for u in $UNITS; do
      systemctl restart "$u" || echo "warning: failed to restart $u" >&2
    done
  fi

  echo "codex: $("$BASE/current/bin/codex" --version)"
}
main "$@"
