# NSIC architecture

## Components

```text
React UI
  ├─ inventory model (pure TypeScript, unit tested)
  ├─ workflow state / progress / ETA
  └─ Tauri invoke and event API
            │
            ▼
Tauri host (Rust)
  ├─ package and Unreal LayeredFS folder inspection
  ├─ persistent settings and imported prod.keys
  ├─ constrained backend download/import
  ├─ patch workspace / overlay / manifest pipeline
  └─ child-process lifecycle and event streaming
            │
            ├──────────────┐
            ▼              ▼
nscb_rust (external)   hactool + hacPack (external)
  ├─ DLC package split    ├─ carrier PublicData extraction
  ├─ XCI merge            └─ carrier PublicData/Meta rebuild
  └─ verification
```

The UI never reads key contents. The Rust host copies a user-selected key into
the application data directory and passes its path to the external process.
Displayed command lines replace that path with `<prod.keys>`.

## Data locations

Tauri resolves the application data directory for identifier
`io.github.sadykoviv.nsic` and stores runtime-only files below `tools/`:

```text
tools/
├── prod.keys                    # user imported; never committed
├── nscb_rust-macos-arm64        # user imported/downloaded; never bundled
├── hactool                      # user imported; never bundled
├── hacpack                      # user imported; never bundled
├── settings.json
└── INFO/MASSVERIFY/             # backend verification reports
```

Game inputs remain in place. Outputs go to the user-selected directory. Plain
NSP/XCI merges can stream directly and may leave the temporary directory empty.
NSZ/XCZ decompression uses it, and modification builds create a named
`nsic-dlc-patch-*` workspace there for the selected DLC RomFS and rebuilt
PublicData/Meta NCAs. Successful builds remove that workspace. Failed builds
retain it for diagnosis after deleting the temporary restricted keyset.

The safe modification pipeline preserves the original base, update, and every
non-carrier DLC. It extracts the user-selected carrier DLC, discovers exactly
one Unreal plugin through its `.uplugin` and original PAK, prefixes the
localization package names with that plugin name, and installs them beside the
original plugin PAK. It then passes the carrier Data/Meta SDK versions to
hacPack and verifies all six PublicData RomFS IVFC levels with hactool before
the final XCI merge. `patches/hacpack-nsic.patch` documents the supported
upstream hacPack adjustments; no hacPack binary is distributed by NSIC.
After the merge, NSIC scans the completed XCI inventory and requires exactly
one expected base title and one copy of every selected DLC title before it
emits the authoritative result path.

## Trust boundaries

- File and folder access begins with a user selection or drag-and-drop.
- Directory scans skip symlink traversal and accept only NSP/NSZ/XCI/XCZ.
- Backend download URLs must start with the official nscb_rust GitHub Releases path.
- Only one backend process may run at a time.
- Firmware patch options are opt-in and not persisted.
- Multiple detected base TITLE IDs block a build.
- Known mutually exclusive entitlement packages block a build. In particular,
  It Takes Two Full Game `010092A0172E5001` and Friends Pass
  `010092A0172E5002` must not be selected together.
- A modification must expose exactly one `<TITLE ID>/romfs` root, contain at
  least one Unreal `.pak`, and use only PAK/UTOC/UCAS/SIG package assets.
- The modification TITLE ID must match the base application. The selected DLC
  carrier TITLE ID is independently mapped back to the same base application.
- ExeFS and arbitrary loose RomFS overlays are rejected by safe mode because the
  working MeloNX path is specifically a DLC-hosted Unreal plugin package.
- Only rebuilt carrier PublicData/Meta NCAs are intentionally fakesigned;
  verification distinguishes decryptable/internal content from original signatures.
- The generic nscb_rust signature verifier is not run for a modified build. Its
  original-signature verdict is undefined for intentional fakesigning and may
  request interactive input; mandatory PublicData IVFC is the safe-mode gate.

## Future extension points

- Replace filename-based fallback classification with structured CNMT/NACP data.
- Add a job model whose manifests can be resumed without persisting secrets.
- Add a signed diagnostic bundle with path redaction.
- Introduce an adapter interface if another appropriately licensed backend becomes available.
