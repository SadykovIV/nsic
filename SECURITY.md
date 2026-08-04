# Security policy

## Sensitive material

Never attach or commit `prod.keys`, title keys, tickets, certificates, game
packages, decrypted NCA data, or logs that reveal their contents. NSIC does not
need key contents in issue reports.

The application stores an imported `prod.keys` locally in its Application
Support directory. Remove it from **Settings → Encryption keys** when it is no
longer needed. NSIC masks the key path in its visible command log.

## Reporting a vulnerability

Open a private security advisory in the future GitHub repository. Include the
NSIC version, macOS version, exact reproduction steps and a minimal sanitized
log. Do not create a public issue for a vulnerability involving key exposure,
arbitrary command execution or unsafe backend replacement.

## Backend trust

`nscb_rust` is a separate executable controlled by its upstream author. NSIC
restricts in-app downloads to that project's GitHub Releases, but currently has
no pinned checksum or signature. Users who require a stronger trust model should
build and inspect the backend themselves, then use manual import.
