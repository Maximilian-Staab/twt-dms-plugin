{
  # twtBar — TrackWorkTime bar widget for DankMaterialShell.
  #
  # Module-only flake: the NixOS module takes `lib` from the importing
  # system, so no nixpkgs input is pinned here (nothing to go stale, no
  # version skew with the consumer's nixpkgs).
  description = "twtBar — TrackWorkTime bar widget for DankMaterialShell";

  outputs = { self }: {
    nixosModules.twt = import ./nix/twtbar-nixos.nix;
    nixosModules.twtBar = self.nixosModules.twt;
    nixosModules.default = self.nixosModules.twt;
  };
}
