# Nintendo Switch Image Converter (NSIC)

NSIC is a **macOS ARM64** desktop app that builds user-provided NSP, NSZ, XCI
and XCZ content into one XCI and can verify the completed image. Its primary
workflow is base + update + DLC for local MeloNX use.

The UI follows [PS4 FFPFSC](https://github.com/SadykovIV/PS4pkg_to_ffpfsc):
source → discovered contents → options → log and verifiable output.

> [!WARNING]
> A successful build and static verification do not guarantee that a specific
> game launches in MeloNX. NSIC does not change TITLE IDs or bake LayeredFS
> modifications into NCA content.

## Highlights

- file selection, recursive folder scanning and drag-and-drop;
- base/update/DLC classification and mixed-title protection;
- XCI output with firmware patching disabled by default;
- optional delta exclusion and signature verification;
- progress, elapsed time, ETA, logs and cancellation;
- Russian and English UI;
- user-supplied keys and an external backend are never committed or bundled.

## Setup

1. Open **Settings** and import your legally obtained `prod.keys`.
2. Import `nscb_rust-macos-arm64` or explicitly download it from the author's release.
3. Add one game's base, update and DLC files.
4. Choose the output directory and click **Build XCI**.

NSIC runs [cxfcxf/nscb_rust](https://github.com/cxfcxf/nscb_rust) as a separate
tool. It is not included in NSIC source or release artifacts. As of 2026-08-04,
that repository has no explicit license file, so redistribution is intentionally
disabled pending an upstream license or direct permission.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build:arm64
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/RELEASING.md](docs/RELEASING.md), and [SECURITY.md](SECURITY.md).

## License

NSIC source code is ISC licensed. Third-party components retain their own terms.
