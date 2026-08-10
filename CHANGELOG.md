# Changelog

All notable changes to NSIC will be documented here.

## [0.2] - 2026-08-10

### Added

- Optional safe embedding of Unreal Engine PAK/UTOC/UCAS localizations into an
  explicitly selected DLC plugin carrier.
- Patch folder validation, TITLE ID/carrier ownership matching, and a sidecar
  `.nsic.json` manifest that records the rebuilt DLC and installed assets.
- Manual external `hactool` and `hacPack` imports for the modification pipeline.

### Changed

- The About view identifies the Safe DLC release as version 0.2, so an older
  installed application cannot be mistaken for the current pipeline.
- Progress now reports named stages, backend throughput, and backend ETA when available.
- Temporary-folder help now explains streaming NSP/XCI builds versus NSZ/XCZ
  decompression and modification workspaces.
- Temporary modification workspaces are deleted after success and retained after
  errors for diagnosis, with the temporary keyset always removed.
- Original base/update and non-carrier DLC packages are now passed unchanged to
  the final XCI merge; only the selected carrier DLC is rebuilt.

### Fixed

- Block the mutually exclusive It Takes Two Full Game and Friends Pass
  entitlements from being merged into one image. The verified full-game set
  contains `010092A0172E5001` and excludes `010092A0172E5002`.
- Use the exact XCI path returned by the patched backend instead of relying only
  on an output-directory timestamp scan.
- Verify that the completed XCI contains exactly one base title and every
  selected DLC title before reporting success.
- Preserve the carrier DLC Data and Meta SDK versions when rebuilding it.
- Verify every IVFC level of the rebuilt PublicData NCA before creating an XCI.
- Avoid the immediate MeloNX Unreal `PreInit()` failure caused by collapsing
  base + update + localization into a rebuilt application Program NCA.
- Prefix embedded package assets with the carrier Unreal plugin name so MeloNX
  discovers and mounts them from the DLC plugin PAK directory.
- Skip the generic signature verifier for intentional DLC modifications; it
  cannot validate fakesigned content and otherwise enters an interactive prompt.

## [0.1] - 2026-08-04

### Added

- First public macOS ARM64 release of Nintendo Switch Image Converter.
- Russian and English XCI build workflow.
- Recursive NSP/NSZ/XCI/XCZ discovery and content-set validation.
- External `nscb_rust` import/download, XCI verification and cancellation.
- Persistent output/temp settings and local key management.
- Unit tests, CI, release audit, architecture and security documentation.

### Fixed

- Associate DLC TITLE IDs from the next `0x1000` range with their base application instead of treating them as a second game.
- Keep update/DLC-only sets blocked with the correct missing-base diagnosis.

## [dev] - 2026-08-04

- Initial development build.
