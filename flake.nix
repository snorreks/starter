# The pinned development environment for Linux and macOS.
#
# Why a flake: a starter that documents "install Bun, Moon, Wrangler, Biome,
# Playwright, SOPS, age…" gets six of those and not the seventh, and the
# failure surfaces as a broken browser lane rather than as a missing
# prerequisite. This pins them.
#
# Two profiles, because the needs are not nested the way they look:
#
#   minimal   web work. install, unit tests, lint, build. No browser.
#   default   the above, plus a Chromium linked against this Nix store.
#
# What is deliberately NOT here:
#
#   * Wrangler, Drizzle Kit, Playwright CLI, Biome, Moon, TypeScript.
#     Those are pinned by the workspace lockfile and must resolve through
#     `node_modules/.bin`. A second copy on PATH is how a local run validates
#     against version X while CI runs version Y. `setup` installs them and
#     `doctor` proves which one is on PATH. See docs/toolchain.md.
#
#   * Remote credentials. No token, no account id, no age recipient that could
#     read a secret. Nothing here decrypts anything, and `.envrc` does not either.
#
# Versions come from config/toolchain.json, the one place a pin is written.
# `bun run setup:doctor` fails when this file and that one disagree.

{
  description = "Starter development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      pins = builtins.fromJSON (builtins.readFile ./config/toolchain.json);

      # `x86_64-darwin` is deliberately absent.
      #
      # nixpkgs dropped Intel macOS support in 26.11, so evaluating this flake for
      # that platform fails with a message about release notes rather than about
      # anything in this repository. Listing it would make `nix flake show
      # --all-systems` fail on a machine that only wanted to see the tree.
      #
      # On an Intel Mac, point the input at the last branch carrying it:
      #
      #   inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
      #
      # which receives security fixes until the end of 2026. docs/platforms.md
      # says the same, so the limitation is documented where a reader would look.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forEachSystem = f:
        nixpkgs.lib.genAttrs systems (system:
          let
            pkgs = nixpkgs.legacyPackages.${system};

            # ── what each profile adds ──────────────────────────────────────
            # The tools that install, develop, check, and reach a provider with.
            # `nodejs_22` is here because `wrangler dev` and Vite both shell out
            # to Node; workerd ships inside the workspace's wrangler package, so
            # this is not a second wrangler.
            corePackages = with pkgs; [
              bun
              nodejs_22
              git
              cacert
              gh
              sops
              age
              jq
              ripgrep
              fd
              nix-direnv
            ];

            # ── the browser ─────────────────────────────────────────────────
            # Playwright's own `playwright install chromium` downloads a Linux
            # build linked against glibc and fixed `.so` names. On NixOS those
            # names are versioned suffixes under /nix/store, so the download
            # fails at `error while loading shared libraries: libgbm.so.1` — the
            # exact failure a starter should never tell a Nix user to ignore.
            #
            # This browser is linked against the same store the shell uses, so it
            # resolves its own libraries without LD_LIBRARY_PATH.
            browser = pkgs.chromium;

            # ── one shell, profiles below ────────────────────────────────
            mkShellFor = extraPackages:
              pkgs.mkShell {
                # Watching the pin file means a version bump invalidates the
                # cached environment instead of being silently reused.
                inputsFrom = [ pinsFile ];

                packages = extraPackages;

                shellHook = ''
                  # Point the browser lanes at this store's Chromium rather than
                  # at a downloaded copy. `doctor` checks this resolves.
                  export PLAYWRIGHT_BROWSERS_PATH="${browser}/bin"
                  export CHROMIUM_PATH="${browser}/bin/chromium"
                '';
              };

            # Rendered into the store and watched by nix-direnv. Change a pin in
            # config/toolchain.json, and the environment is rebuilt rather than
            # restored from a cache that no longer matches.
            pinsFile = pkgs.writeText "starter-toolchain.json" (builtins.toJSON {
              inherit (pins) bun playwright;
            });
          in
          f {
            inherit pkgs corePackages browser pinsFile mkShellFor;
          });
    in
    {
      # ── one shell, two profiles ─────────────────────────────────────────
      devShells = forEachSystem ({ mkShellFor, corePackages, browser, ... }: {
        minimal = mkShellFor corePackages;

        default = mkShellFor (corePackages ++ [ browser ]);
      });

      # Chromium, so a caller can reach it without the shell's env:
      # `nix run .#chromium -- --version`
      packages = forEachSystem ({ pkgs, browser, ... }: {
        inherit (pkgs) bun sops age gh;
        inherit browser;
      });

      formatter = forEachSystem ({ pkgs, ... }: { inherit (pkgs) nixpkgs-fmt; });
    };
}