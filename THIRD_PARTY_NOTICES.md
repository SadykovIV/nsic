# Third-party notices

NSIC is an independent project and is not affiliated with Nintendo, the MeloNX
project, or the projects listed below. Nintendo Switch and related names are
trademarks of their respective owners.

## nscb-desktop

Parts of the Tauri process integration and command mapping were adapted from
[cxfcxf/nscb-desktop](https://github.com/cxfcxf/nscb-desktop), whose package
manifest declares the ISC license. NSIC retains attribution and distributes its
own source under ISC.

## nscb_rust

[cxfcxf/nscb_rust](https://github.com/cxfcxf/nscb_rust) is an optional external
runtime backend. It is not copied into this repository or NSIC release artifacts.
As of 2026-08-04 the repository does not expose an explicit license file; no
redistribution permission is assumed.

## hactool

[SciresM/hactool](https://github.com/SciresM/hactool) is an optional external
tool used to extract and verify the selected DLC PublicData RomFS. It is ISC
licensed and is not bundled with NSIC.

## hacPack

[DarkUnixOs/hacPack](https://github.com/DarkUnixOs/hacPack) is an optional
external GPL-2.0 tool used to rebuild modified DLC PublicData/Meta NCA and NSP
content. NSIC does not copy, link, or redistribute hacPack binaries; users
import their own binary.
`patches/hacpack-nsic.patch` contains modification instructions for hacPack and
is provided under GPL-2.0. A hacPack build produced with that patch remains
GPL-2.0 and is not part of NSIC release artifacts.

## NSC_Builder

[julesontheroad/NSC_BUILDER](https://github.com/julesontheroad/NSC_BUILDER)
documents the multi-content XCI/NSP workflow and is MIT licensed. NSIC does not
embed the NSC_Builder source tree.

## NSZ

[nicoboss/nsz](https://github.com/nicoboss/nsz) documents the NSZ/XCZ format and
is MIT licensed. NSIC relies on its external backend for compressed input support
and does not embed the NSZ Python package.

## Tauri, React and transitive dependencies

Application dependencies are declared in `package.json` and
`src-tauri/Cargo.toml`. Their upstream license notices must be collected and
shipped with signed public releases. Dependency license auditing is a release
gate, not a substitute for reviewing this file.
