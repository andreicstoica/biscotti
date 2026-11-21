#!/usr/bin/env bash
# Verify biscotti-vm on Omarchy: service active, SSH reachable, nested KVM + hugepages + root resize + core units up.
set -euo pipefail

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222)

echo "==> Checking host service"
state=$(systemctl is-active biscotti-vm.service)
[ "$state" = "active" ] || { echo "FAIL: biscotti-vm.service is $state" >&2; exit 1; }

echo "==> Waiting for guest SSH on 127.0.0.1:2222"
for _ in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" biscotti@127.0.0.1 true 2>/dev/null; then
    break
  fi
  sleep 2
done
ssh "${SSH_OPTS[@]}" biscotti@127.0.0.1 true || { echo "FAIL: SSH to guest timed out" >&2; exit 1; }

echo "==> Checking guest invariants"
ssh "${SSH_OPTS[@]}" biscotti@127.0.0.1 '
set -euo pipefail
test -r /dev/kvm && test -w /dev/kvm
huge=$(cat /proc/sys/vm/nr_hugepages)
echo "nr_hugepages=$huge"
[ "$huge" -eq 2560 ]

root_gb=$(df -BG --output=size / | tail -n 1 | tr -dc "0-9")
echo "root_gb=${root_gb}G"
[ "$root_gb" -ge 35 ]

for unit in docker.service tailscaled.service biscotti-net.service; do
  s=$(systemctl is-active "$unit")
  echo "$unit=$s"
  [ "$s" = "active" ]
done

echo "biscotti-setup=$(systemctl is-active biscotti-setup.service || true)"
'
echo "VERIFIED"
