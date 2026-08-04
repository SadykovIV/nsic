#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <artifact-or-directory>" >&2
  exit 2
fi

target="$1"
if [[ ! -e "$target" ]]; then
  echo "artifact not found: $target" >&2
  exit 2
fi

work=""
scan="$target"
if [[ -f "$target" && "$target" == *.zip ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  ditto -x -k "$target" "$work"
  scan="$work"
fi

forbidden="$(find "$scan" -type f \( \
  -iname 'prod.keys' -o -iname 'keys.txt' -o -iname 'title.keys' -o \
  -iname 'nscb_rust*' -o -iname '*.nsp' -o -iname '*.nsz' -o \
  -iname '*.xci' -o -iname '*.xcz' -o -iname '*.nca' -o -iname '*.ncz' \
\) -print)"

if [[ -n "$forbidden" ]]; then
  echo "forbidden release content detected:" >&2
  echo "$forbidden" >&2
  exit 1
fi

echo "release content audit passed: $target"
