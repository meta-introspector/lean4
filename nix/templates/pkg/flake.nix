{
  description = "My Lean package";

  inputs.lean.url = "github:meta-introspector/lean4?ref=feature/CRQ-016-nixify";
  inputs.flake-utils.url = "github:meta-introspector/flake-utils?ref=feature/CRQ-016-nixify";

  outputs = { self, lean, flake-utils }: flake-utils.lib.eachDefaultSystem (system:
    let
      leanPkgs = lean.packages.${system};
      pkg = leanPkgs.buildLeanPackage {
        name = "MyPackage";  # must match the name of the top-level .lean file
        src = ./.;
      };
    in {
      packages = pkg // {
        inherit (leanPkgs) lean;
      };

      defaultPackage = pkg.modRoot;
    });
}
