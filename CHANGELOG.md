# Changelog

All notable changes to NSIC will be documented here.

## [Unreleased]

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
