# Biscotti on Omarchy

Runs Biscotti inside a headless x86_64 NixOS QEMU/KVM VM (4 vCPU, 8 GiB RAM, 40 GiB disk) with nested AMD-V KVM for Firecracker task VMs.

The VM uses user-mode networking with localhost SSH forwarding (`127.0.0.1:2222 -> 22`) and joins your Tailscale tailnet as its own machine (`biscotti`), so it never touches Omarchy's host Tailscale, Eats' Funnel on `:8443`, or Listen's containers.

## 1. Install QEMU + OVMF on Omarchy

```bash
ssh -t ass@100.77.114.41 'sudo pacman -S --needed qemu-base edk2-ovmf'
```

## 2. Build the NixOS image on Omarchy

Builds inside a `nixos/nix` Docker container using `/dev/kvm` (no host Nix install):

```bash
ssh ass@100.77.114.41 '~/apps/biscotti/infra/omarchy/build-image.sh'
```

## 3. Install and start the VM service

```bash
ssh -t ass@100.77.114.41 'sudo ~/apps/biscotti/infra/omarchy/install.sh'
```

## 4. Verify the VM (from your Mac)

```bash
infra/omarchy/verify.sh
```

## 5. Provide settings and finish bootstrap (from your Mac)

Copy your filled `core/host/.env.example` into the VM:

```bash
ssh -J ass@100.77.114.41 -p 2222 biscotti@127.0.0.1 \
  'sudo mkdir -p /var/lib/biscotti && sudo sh -c "umask 077 && cat > /var/lib/biscotti/.env"' < my.env
```

`biscotti-setup.service` will pick up `.env`, build the Docker image and Firecracker desktop snapshot, and text you a Tailscale login URL. Approve the node in Tailscale, and Biscotti will text you when ready.

## Updating in place

Push changes to your fork, then update from your Mac:

```bash
ssh -J ass@100.77.114.41 -p 2222 biscotti@127.0.0.1 \
  'sudo nixos-rebuild switch --flake github:andreicstoica/biscotti#omarchy'
```
