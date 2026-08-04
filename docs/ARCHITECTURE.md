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
  ├─ file inspection and recursive scanning
  ├─ persistent settings and imported prod.keys
  ├─ constrained backend download/import
  └─ child-process lifecycle and event streaming
            │
            ▼
nscb_rust (external, user-installed)
  ├─ base/update/DLC → XCI
  └─ XCI verification report
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
├── settings.json
└── INFO/MASSVERIFY/             # backend verification reports
```

Game inputs remain in place. Outputs go to the user-selected directory. Large
temporary files use the operating system default or the configured temporary
directory.

## Trust boundaries

- File and folder access begins with a user selection or drag-and-drop.
- Directory scans skip symlink traversal and accept only NSP/NSZ/XCI/XCZ.
- Backend download URLs must start with the official nscb_rust GitHub Releases path.
- Only one backend process may run at a time.
- Firmware patch options are opt-in and not persisted.
- Multiple detected base TITLE IDs block a build.

## Future extension points

- Replace filename-based fallback classification with structured CNMT/NACP data.
- Add a job model whose manifests can be resumed without persisting secrets.
- Add a signed diagnostic bundle with path redaction.
- Introduce an adapter interface if another appropriately licensed backend becomes available.
