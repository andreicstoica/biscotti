#!/usr/bin/env bash
# Idempotently install and start biscotti-vm.service on Omarchy.
# Run as root (sudo infra/omarchy/install.sh).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="${VM_DIR:-/home/ass/.local/share/biscotti-vm}"
DISK_PATH="$VM_DIR/biscotti.qcow2"
DISK_TARGET_BYTES=$((40 * 1024 * 1024 * 1024))
OVMF_CODE="/usr/share/edk2/x64/OVMF_CODE.4m.fd"
OVMF_VARS_SRC="/usr/share/edk2/x64/OVMF_VARS.4m.fd"
OVMF_VARS_DST="$VM_DIR/OVMF_VARS.4m.fd"

# 1. Verify host prerequisites
[ -c /dev/kvm ] || { echo "/dev/kvm missing" >&2; exit 1; }
nested=$(cat /sys/module/kvm_amd/parameters/nested 2>/dev/null || cat /sys/module/kvm_intel/parameters/nested 2>/dev/null || echo 0)
case "$nested" in
  1|Y|y) ;;
  *) echo "Nested KVM is not enabled (got: $nested)" >&2; exit 1 ;;
esac
command -v qemu-system-x86_64 >/dev/null || { echo "Missing qemu-system-x86_64 (install qemu-base)" >&2; exit 1; }
command -v qemu-img >/dev/null || { echo "Missing qemu-img (install qemu-base)" >&2; exit 1; }
[ -f "$OVMF_CODE" ] && [ -f "$OVMF_VARS_SRC" ] || { echo "Missing OVMF firmware under /usr/share/edk2/x64/ (install edk2-ovmf)" >&2; exit 1; }
[ -f "$DISK_PATH" ] || { echo "Missing disk image $DISK_PATH (run infra/omarchy/build-image.sh first)" >&2; exit 1; }

# 2. Prepare VM state dir and UEFI NVRAM (never overwrite existing NVRAM)
install -d -o ass -g ass -m 0750 "$VM_DIR"
if [ ! -f "$OVMF_VARS_DST" ]; then
  install -o ass -g ass -m 0644 "$OVMF_VARS_SRC" "$OVMF_VARS_DST"
fi
chown ass:ass "$DISK_PATH"

# 3. Grow disk to 40 GiB if smaller (only while VM is stopped)
cur_bytes=$(qemu-img info --output=json "$DISK_PATH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["virtual-size"])')
if [ "$cur_bytes" -lt "$DISK_TARGET_BYTES" ]; then
  if systemctl is-active --quiet biscotti-vm.service; then
    systemctl stop biscotti-vm.service
  fi
  sudo -u ass qemu-img resize "$DISK_PATH" 40G
fi

# 4. Install and start systemd unit
install -m 0644 "$SCRIPT_DIR/biscotti-vm.service" /etc/systemd/system/biscotti-vm.service
systemctl daemon-reload
systemctl enable biscotti-vm.service
systemctl restart biscotti-vm.service

echo "biscotti-vm.service is $(systemctl is-active biscotti-vm.service)"
