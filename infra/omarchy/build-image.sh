#!/usr/bin/env bash
# Build the x86_64-linux NixOS qemu-efi image for Omarchy inside a nixos/nix container.
# Idempotent: refuses to overwrite an existing live disk unless --force is passed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-/home/ass/.local/share/biscotti-vm}"
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

if [ -f "$OUT_DIR/biscotti.qcow2" ] && [ "$FORCE" -ne 1 ]; then
  echo "Disk image already exists at $OUT_DIR/biscotti.qcow2 (pass --force to overwrite)."
  exit 0
fi

mkdir -p "$OUT_DIR"

# Persistent Nix store volume so rebuilds reuse cached derivations.
docker volume inspect biscotti-nix-store >/dev/null 2>&1 || docker volume create biscotti-nix-store >/dev/null

docker run --rm \
  --device /dev/kvm:/dev/kvm \
  -v biscotti-nix-store:/nix \
  -v "$REPO_DIR:/src:ro" \
  -v "$OUT_DIR:/out" \
  nixos/nix:latest \
  sh -euo pipefail -c '
    git config --global --add safe.directory /src
    mkdir -p /etc/nix
    printf "experimental-features = nix-command flakes\nsandbox = false\n" > /etc/nix/nix.conf
    nix build /src#packages.x86_64-linux.omarchy-image --out-link /tmp/result
    img=$(find -L /tmp/result -maxdepth 2 -name "*.qcow2" | head -n 1)
    [ -n "$img" ] || { echo "No .qcow2 found in /tmp/result" >&2; ls -la /tmp/result/ >&2; exit 1; }
    cp --reflink=auto "$img" /out/biscotti.qcow2.new
    chmod 644 /out/biscotti.qcow2.new
    mv -f /out/biscotti.qcow2.new /out/biscotti.qcow2
    ls -lh /out/biscotti.qcow2
  '
