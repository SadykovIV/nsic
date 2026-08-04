#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This release script must run on Apple Silicon (arm64)." >&2
  exit 1
fi

command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
command -v cargo >/dev/null || { echo "Rust/Cargo is required" >&2; exit 1; }

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build:arm64

app="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Nintendo Switch Image Converter.app"
if [[ ! -d "$app" ]]; then
  echo "built application not found: $app" >&2
  exit 1
fi

codesign --force --deep --sign - "$app"
mkdir -p release
archive="release/NSIC-v$(node -p "require('./package.json').version")-macos-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
"$root/scripts/check_release_contents.sh" "$archive"
echo "Created $archive"
