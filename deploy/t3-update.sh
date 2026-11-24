#!/usr/bin/env bash
# Installs or updates T3 Code (from github.com/pingdotgg/t3code releases) for every member under /opt/devdash/t3code.
# Versioned dirs + an atomic `current` symlink; keeps the previous version for rollback and restarts active member
# devdash-t3@*.service units so they pick up the new binary. Run as root.
# Usage: t3-update.sh [version]   (default: latest GitHub release)
set -euo pipefail
main() {
  [[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }

  local ARCH
  case "$(uname -m)" in
    x86_64|amd64) ARCH="linux-x64" ;;
    aarch64|arm64) ARCH="linux-arm64" ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  local VER="${1:-}"
  if [[ -z $VER ]]; then
    VER=$(curl -fsSL -H "User-Agent: devdash-t3-updater" "https://api.github.com/repos/pingdotgg/t3code/releases/latest" \
      | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); const t = String(d.tag_name || "").replace(/^v/, ""); if (t) process.stdout.write(t);')
  fi
  VER="${VER#v}"
  [[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $VER" >&2; exit 1; }

  local BASE=/opt/devdash/t3code
  local DIR="$BASE/$VER"
  install -d -m 755 "$BASE"

  if ! "$DIR/t3" --version >/dev/null 2>&1; then
    local TMP
    TMP=$(mktemp -d "${BASE}/.download-${VER}.XXXXXX")
    trap 'rm -rf "${TMP:-}"' EXIT
    local URL="https://github.com/pingdotgg/t3code/releases/download/v${VER}/t3-${VER}-${ARCH}.tar.gz"
    echo "downloading $URL"
    curl -fsSL --retry 3 --retry-delay 2 -o "$TMP/t3.tar.gz" "$URL"
    mkdir -p "$TMP/extract"
    tar -xzf "$TMP/t3.tar.gz" -C "$TMP/extract"

    # Handle tarballs that unpack either directly (t3 at root) or inside a single top-level directory.
    local SRC="$TMP/extract"
    if [[ ! -x "$SRC/t3" ]]; then
      local SUB
      SUB=$(find "$TMP/extract" -mindepth 1 -maxdepth 2 -type f -name t3 -printf '%h\n' | head -n 1 || true)
      [[ -n $SUB && -x "$SUB/t3" ]] || { echo "t3 binary not found in archive" >&2; exit 1; }
      SRC="$SUB"
    fi

    rm -rf "$DIR"
    mv "$SRC" "$DIR"
    chown -R root:root "$DIR"
    chmod -R go-w "$DIR"
    chmod 0755 "$DIR/t3"
    "$DIR/t3" --version >/dev/null || { rm -rf "$DIR"; echo "t3 $VER failed self-check: removed it, nothing changed" >&2; exit 1; }
    rm -rf "$TMP"
    trap - EXIT
  fi

  ln -sfn "$DIR" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"

  # Keep the two newest installed versions for rollback.
  ls -1dt "$BASE"/[0-9]*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf

  # Restart active member-owned T3 Code services so they pick up the updated binary.
  local UNITS
  UNITS=$(systemctl list-units --type=service --state=active --plain --no-legend 'devdash-t3@*.service' 2>/dev/null | awk '{print $1}' || true)
  if [[ -n $UNITS ]]; then
    for u in $UNITS; do
      systemctl restart "$u" || echo "warning: failed to restart $u" >&2
    done
  fi

  echo "t3: $("$BASE/current/t3" --version)"
}
main "$@"
