# Nintendo Switch Image Converter (NSIC)

NSIC is a **macOS ARM64** desktop app that builds user-provided NSP, NSZ, XCI
and XCZ content into one XCI and can verify the completed image. Its primary
workflow is base + update + DLC for local MeloNX use.

The UI follows [PS4 FFPFSC](https://github.com/SadykovIV/PS4pkg_to_ffpfsc):
source → discovered contents → options → log and verifiable output.

> [!WARNING]
> A successful build and static verification do not guarantee that a specific
> game launches in MeloNX. NSIC does not change TITLE IDs. Safe modification
> mode preserves the original base and update while rebuilding the selected
> DLC PublicData/Meta NCAs, so those two signatures are expected to change.

## Highlights

- file selection, recursive folder scanning and drag-and-drop;
- base/update/DLC classification and mixed-title protection;
- protection against combining the mutually exclusive It Takes Two
  entitlements: the full-game set keeps `010092A0172E5001` and excludes Friends
  Pass `010092A0172E5002`;
- XCI output with firmware patching disabled by default;
- optional delta exclusion and signature verification for unmodified XCI;
  modified DLC builds use complete internal IVFC verification instead;
- a MeloNX-tested safe mode for Unreal Engine localizations: PAK/UTOC/UCAS
  assets from `<TITLE ID>/romfs` are embedded into an explicitly selected
  DLC plugin without rebuilding base, update, or other DLC;
- staged progress, throughput, ETA, logs and cancellation;
- explicit temporary storage behavior for compressed inputs and NCA rebuilding;
- Russian and English UI;
- user-supplied keys and an external backend are never committed or bundled.

## Setup

1. Open **Settings** and import your legally obtained `prod.keys`.
2. Import `nscb_rust-macos-arm64` or explicitly download it from the author's release.
3. To embed a localization, also import ARM64 `hactool` and a patched `hacPack`
   binary, then choose the modification folder and a compatible Unreal plugin
   DLC carrier (`.uplugin` plus an original `.pak`). Apply the
   [NSIC patch](patches/hacpack-nsic.patch) using the
   [build instructions](docs/HACPACK.md) before building hacPack; it fixes
   encryption of sections larger than 4 GiB and accepts real SDK versions above
   0.x.
4. Add one game's base, newest update and DLC files.
5. Choose the output directory and click **Build XCI**.

NSIC runs [cxfcxf/nscb_rust](https://github.com/cxfcxf/nscb_rust) as a separate
tool. It is not included in NSIC source or release artifacts. As of 2026-08-04,
that repository has no explicit license file, so redistribution is intentionally
disabled pending an upstream license or direct permission.

The optional modification pipeline invokes external
[hactool](https://github.com/SciresM/hactool) (ISC) and
[hacPack](https://github.com/DarkUnixOs/hacPack) (GPL-2.0). Users import these
tools manually; NSIC does not redistribute them.

NSIC runs a complete hactool IVFC check after rebuilding the selected DLC
PublicData NCA and stops before XCI creation unless levels 0–5 all pass. This
layout was validated on MeloNX with It Takes Two: the Full Game entitlement is
recognized and the embedded Russian audio PAK loads without rebuilding Program.
After the merge, NSIC scans the final XCI inventory and requires exactly one
expected base title and one copy of every selected DLC title.

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
