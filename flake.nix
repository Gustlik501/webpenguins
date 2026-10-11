{
  description = "web-penguins — xpenguins + xsnow remade for the web";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages =
            [
              # build tooling (esbuild + tsc come from `npm install`); the
              # CDP test harness needs Node >= 22 for global fetch/WebSocket
              pkgs.nodejs_24
              # fetching the original xpenguins/xsnow tarballs into vendor/
              pkgs.curl
              # packing extension/extension.zip
              pkgs.zip
            ]
            # headless browser for tools/test-*.mjs; Chromium rather than
            # branded Chrome, which no longer honours --load-extension
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.chromium ];

          shellHook =
            pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export WP_BROWSER="${pkgs.chromium}/bin/chromium"
            ''
            + ''
              if [ ! -d node_modules ]; then
                echo "web-penguins: run 'npm install' to fetch esbuild + typescript"
              fi
            '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
