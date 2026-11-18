{
  description = "Pi Daemon: persistent Pi coding-agent sessions with a mobile web UI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        pi-daemon = pkgs.callPackage ./nix/package.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-daemon;
      });

      overlays.default = final: _prev: {
        pi-daemon = final.callPackage ./nix/package.nix { };
      };

      homeManagerModules = {
        pi-daemon = import ./nix/home-manager.nix self;
        default = self.homeManagerModules.pi-daemon;
      };

      checks = forAllSystems (pkgs: {
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });
    };
}
