# Building a compatible hacPack on macOS ARM64

NSIC does not distribute hacPack binaries. Build it from the GPL-2.0 upstream
source and apply the small compatibility patch kept in this repository:

```bash
git clone https://github.com/DarkUnixOs/hacPack.git
cd hacPack
git apply --ignore-space-change /absolute/path/to/nsic/patches/hacpack-nsic.patch
cp config.mk.template config.mk
make -j8
file hacPack
```

`file hacPack` must report a Mach-O 64-bit arm64 executable before it is imported
in NSIC Settings.

The source patch keeps two compatibility changes:

- preserve 64-bit arithmetic while converting NCA media offsets to byte offsets,
  preventing section-encryption truncation above 4 GiB;
- accept the four-byte SDK values used by modern games instead of rejecting every
  SDK whose major version is greater than zero.

Safe modification mode uses hacPack's `publicdata` NCA type and
`--publicdatanca` metadata input to rebuild only the selected DLC carrier. It
does not rebuild the application Program NCA.

NSIC verifies all six PublicData RomFS IVFC levels with hactool after every
rebuild. The carrier DLC Meta NCA is created only after this check succeeds.
