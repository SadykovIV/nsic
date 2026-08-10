# Releasing NSIC for macOS ARM64

## Policy

Release artifacts contain only the NSIC application. They must not contain:

- `prod.keys`, `keys.txt`, `title.keys` or other cryptographic material;
- NSP, NSZ, XCI, XCZ, NCA or NCZ files;
- `nscb_rust` binaries until the upstream project publishes a compatible license
  or grants explicit redistribution permission;
- `hactool` or `hacPack` binaries. They remain manually imported external tools;
  in particular, hacPack is GPL-2.0 and is not distributed in NSIC artifacts.

The textual `patches/hacpack-nsic.patch` source patch may remain in the source
archive under GPL-2.0, but the patched hacPack executable must never enter the
application bundle or release ZIP.

## Local build

```bash
./scripts/build_release_macos_arm64.sh
```

The script runs TypeScript checks, unit tests, Rust tests, an ARM64 Tauri build,
ad-hoc signing, and a forbidden-file audit. Output is placed in `release/`.

## GitHub release

1. Update `CHANGELOG.md` and versions in `package.json`, `src-tauri/Cargo.toml`
   and `src-tauri/tauri.conf.json`.
2. Run the local build on Apple Silicon.
3. Test first launch with an empty NSIC Application Support directory.
4. Test manual keys/backend import, one XCI build, cancellation and verification.
5. Push a signed `vX.Y.Z` tag. The release workflow creates a draft release.
6. Download the artifact, repeat the forbidden-file audit, then publish the draft.

Commercial signing and notarization should be added before recommending normal
double-click installation. Until then, document Control-click → Open.
