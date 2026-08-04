# Contributing

Contributions are welcome for the NSIC source code and documentation.

1. Do not add keys, game files, tickets, certificates or external backend binaries.
2. Keep firmware/key-generation changes opt-in and document their compatibility risk.
3. Add tests for argument construction, file classification and workflow state.
4. Run `pnpm typecheck`, `pnpm test`, and
   `cargo test --manifest-path src-tauri/Cargo.toml`.
5. Keep Russian and English interface strings in sync.

Bug reports should include sanitized filenames or TITLE IDs, content types,
versions, NSIC/backend versions and the smallest relevant log excerpt.
