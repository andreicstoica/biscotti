# A QEMU/KVM VM on an x86_64 Linux host (Omarchy ThinkPad, nested AMD-V KVM).
{ lib, modulesPath, vms, ... }:
{
  imports = [ "${modulesPath}/profiles/qemu-guest.nix" ];

  # Task VMs on 2M huge pages, enough for all of them at once: nested, every 4K page a VM first touches is slow.
  boot.kernelParams = [ "console=ttyS0" "hugepagesz=2M" "hugepages=${toString (vms.slots * vms.memMiB / 2)}" ];

  # As the qemu-efi image lays the disk out, so `nixos-rebuild switch --flake .#omarchy` can update the VM in place.
  fileSystems."/" = lib.mkDefault { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; autoResize = true; };
  fileSystems."/boot" = lib.mkDefault { device = "/dev/disk/by-label/ESP"; fsType = "vfat"; };
  boot.loader.systemd-boot.enable = lib.mkDefault true;

  # Owner's SSH key for `ssh -p 2222 biscotti@127.0.0.1` (and over Tailscale once joined).
  users.users.biscotti.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEZ8trnUCNZA2Trfml1USsXBc585i+7anP4hzCrgJla"
  ];

  # Upstream `biscotti-upgrade` pulls `github:lucasgelfond/biscotti/v<tag>#<target>`, which doesn't have `#omarchy`.
  # Update this fork explicitly with `nixos-rebuild switch --flake github:andreicstoica/biscotti#omarchy`.
  systemd.timers.biscotti-upgrade.enable = lib.mkForce false;
}
