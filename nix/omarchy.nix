{ lib, modulesPath, vms, ... }:
{
  imports = [ "${modulesPath}/profiles/qemu-guest.nix" ];

  # Nested KVM faults 4K guest pages slowly on first touch; pre-reserve 2M hugepages for all Firecracker slots.
  boot.kernelParams = [ "console=ttyS0" "hugepagesz=2M" "hugepages=${toString (vms.slots * vms.memMiB / 2)}" ];

  # Match the qemu-efi image layout so `nixos-rebuild switch --flake .#omarchy` can update in place.
  fileSystems."/" = lib.mkDefault { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; autoResize = true; };
  fileSystems."/boot" = lib.mkDefault { device = "/dev/disk/by-label/ESP"; fsType = "vfat"; };
  boot.loader.systemd-boot.enable = lib.mkDefault true;

  users.users.biscotti.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGEZ8trnUCNZA2Trfml1USsXBc585i+7anP4hzCrgJla"
  ];

  # Upstream biscotti-upgrade pulls github:lucasgelfond/biscotti/v<tag>#<target>, which has no #omarchy target.
  systemd.timers.biscotti-upgrade.enable = lib.mkForce false;
}
