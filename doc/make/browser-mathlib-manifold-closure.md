# Browser Mathlib manifold closure

The workflow
[`build-browser-mathlib-manifold-closure.yml`](../../.github/workflows/build-browser-mathlib-manifold-closure.yml)
builds the part of Mathlib needed by
`Mathlib.Geometry.Manifold.IsManifold.Basic`. It does **not** build or claim to
contain all of Mathlib.

This is a sidecar build. The normal `Web Assembly` and `Linux 32bit` CI jobs do
not depend on it, and their artifacts are not modified. The sidecar downloads
both artifacts from the same completed CI run. It uses the native i386 compiler
to build Mathlib at native speed and checks every packaged `.olean` against the
`Init.olean` shipped by the WebAssembly build.

## Reproduce the artifact

1. Fork this repository and run the normal `CI` workflow at the revision you
   want to package. Wait for both `Web Assembly` and `Linux 32bit` to finish.
2. Copy that workflow run's numeric id.
3. Open **Actions → Build browser Mathlib manifold closure → Run workflow** on
   the same revision and enter the run id.
4. Download the artifact named
   `browser-mathlib-manifold-closure-<lean>-<mathlib>`.

The exact Mathlib commit, root module, compatible upstream Lean revision, and
toolchain label live in
[`browser-mathlib-manifold-closure.lock.json`](../../.github/browser-mathlib-manifold-closure.lock.json).
The uploaded `manifest.json` records those pins, all transitive Lake package
revisions, the two input artifact names, every packaged file, and the SHA-256
of each pack. `SHA256SUMS` covers the manifest and packs.

The workflow rejects a run id from another repository, a run not based on the
locked compatible upstream revision, or a run whose `Web Assembly` or `Linux
32bit` job did not succeed. It checks out the run's exact Lean source revision
even when the workflow itself lives on another fork branch or has since
received a packaging-only fix. Ordinary x86-64 Mathlib cache archives are
deliberately not used: this browser build needs pointer-width-compatible
`.olean` files from the exact Lean fork commit.

To package another part of Mathlib, copy the lock and workflow under a name that
describes its root or purpose, then change `mathlib.roots`. Reserve names such
as `build-browser-mathlib.yml` for an artifact that actually contains full
Mathlib.
