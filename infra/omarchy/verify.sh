#!/usr/bin/env bash
# Verifies biscotti-vm infrastructure: host service, SSH, nested KVM VM creation, hugepages, disk resize, and core units.
# Run from your Mac (uses ProxyJump through Omarchy and your local SSH agent) or on Omarchy with `ssh -A`.
set -euo pipefail

OMARCHY_HOST="${OMARCHY_HOST:-ass@100.77.114.41}"
COMMON_SSH=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

if [ "$(hostname)" = "omarchy" ]; then
  run_host() { bash -c "$1"; }
  GUEST_SSH=(ssh "${COMMON_SSH[@]}" -p 2222 biscotti@127.0.0.1)
else
  run_host() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$OMARCHY_HOST" "$1"; }
  GUEST_SSH=(ssh "${COMMON_SSH[@]}" -J "$OMARCHY_HOST" -p 2222 biscotti@127.0.0.1)
fi

state=$(run_host 'systemctl is-active biscotti-vm.service || true')
echo "biscotti-vm.service=$state"
[ "$state" = "active" ] || { echo "FAIL: biscotti-vm.service is $state" >&2; exit 1; }

connected=0
last_err=""
for _ in $(seq 1 30); do
  if err=$("${GUEST_SSH[@]}" true 2>&1); then
    connected=1
    break
  fi
  last_err="$err"
  if printf '%s' "$err" | grep -qi "permission denied"; then
    echo "FAIL: guest SSH authentication failed (run from your Mac or with ssh -A): $err" >&2
    exit 1
  fi
  sleep 2
done
[ "$connected" -eq 1 ] || { echo "FAIL: guest SSH timed out: $last_err" >&2; exit 1; }

"${GUEST_SSH[@]}" '
set -euo pipefail

perl -e '\''
  open(my $f, "+<", "/dev/kvm") or die "open /dev/kvm: $!";
  my $ver = ioctl($f, 0xae00, 0) + 0;
  my $vm  = ioctl($f, 0xae01, 0) + 0;
  die "KVM ioctl failed (ver=$ver vm=$vm)" if $ver != 12 || $vm < 0;
  print "kvm_api=$ver nested_vm_fd=$vm\n";
'\''
firecracker --version | head -n 1

expected_hp=$(sed -n "s/.*hugepages=\([0-9]*\).*/\1/p" /proc/cmdline)
actual_hp=$(cat /proc/sys/vm/nr_hugepages)
echo "nr_hugepages=$actual_hp (expected=$expected_hp)"
[ -n "$expected_hp" ] && [ "$expected_hp" -gt 0 ] && [ "$actual_hp" -eq "$expected_hp" ]

root_gb=$(df -BG --output=size / | tail -n 1 | tr -dc "0-9")
echo "root_gb=${root_gb}G"
[ "$root_gb" -ge 35 ]

for unit in docker.service tailscaled.service biscotti-net.service; do
  s=$(systemctl is-active "$unit" || true)
  echo "$unit=$s"
  [ "$s" = "active" ] || { echo "FAIL: $unit is $s" >&2; exit 1; }
done

setup_state=$(systemctl is-active biscotti-setup.service || true)
echo "biscotti-setup.service=$setup_state"
case "$setup_state" in
  active)     echo "VERIFIED (vm + biscotti active)" ;;
  activating) echo "VERIFIED (vm infrastructure ready; biscotti-setup waiting for /var/lib/biscotti/.env)" ;;
  *)          echo "FAIL: biscotti-setup.service is $setup_state" >&2; exit 1 ;;
esac
'
