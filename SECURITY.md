# Security boundaries

Version 0.2.0 adds verified section links, cited guidance and optional browser screenshots. Version 0.1.1 hardened the local cache and publisher-input limits. This is a documentation retrieval tool, not a password-vault integration or an independent security certification.

## What the extension can do

- Download only selected public HTTPS pages on `bitwarden.com`. Every redirect is checked against the same allowlist. Credentials in URLs, query strings, custom ports, private addresses, other hosts and unrelated paths are rejected.
- Read and write its documentation cache, diagnostic log and screenshot evidence folder. No tool accepts a filesystem path, shell command, arbitrary URL or Bitwarden credential.
- After a refresh, fetch the same allowlisted public pages as HTML to read heading anchors. Cached text is not changed by this check.
- Return indexed public text to Claude. It does not read vaults, private files or browser profiles, expose a network listener, execute retrieved code, or install a background service.

## Screenshot browser isolation

`capture_evidence` starts the installed Google Chrome or Microsoft Edge through `playwright-core`. No browser is downloaded or bundled. Each capture:

- runs headless, with the Chromium sandbox on, extensions disabled and sync disabled;
- uses a new temporary profile directory inside the private cache, never an existing browser profile, so no cookies, logins, history or extensions are available;
- blocks service workers, downloads, WebSockets and popups;
- aborts every request that is not HTTPS `GET` or `HEAD` to `bitwarden.com`, and every navigation outside the documentation allowlist;
- accepts only a document ID, cache revision and at most 40 lines; page text is matched as data, never used as code or selectors;
- is limited to one capture at a time, a 45-second deadline, a 1200×850 clip and a 1.5 MB PNG.

The temporary profile is deleted when the capture ends. Profiles left by a crashed process are removed after ten minutes. The browser still executes `bitwarden.com` page scripts within these limits; a compromised `bitwarden.com` page is outside this extension's threat model. Screenshots are kept as private files (mode 0600 on macOS) in the cache `evidence` folder, limited to 40 files.

## Local-file protection

The final cache directory must be a real directory owned by the current user. On macOS it uses mode 0700; newly written cache and log files use mode 0600. Windows uses the user's application-data directory and inherited Windows access controls; Windows ACL behavior has not been independently tested.

Cache and log files cannot be symbolic links. POSIX file opens also use `O_NOFOLLOW`. Cache replacement uses an exclusive temporary file and atomic rename. Existing public cache content is retained if a refresh or safe write fails. Parent application-data directories and the operating-system account are trusted; these checks do not defend against a compromised account or administrator.

## Resource and privacy limits

Downloads have a 25-second request timeout, bounded retries and an 8 MB response limit. The corpus file is limited to 32 MB. A document is limited to 512 KB, 20,000 lines and 1,500 headings. A help feed is limited to 2,000 documents. Unexpected source loss or severe truncation preserves the last good content.

Search queries, guidance questions, document bodies, tool arguments and exception details are not written to diagnostic events. There is no author-operated analytics service. Public documentation is sent to Claude as a tool result; Claude processes it under the account's own terms and settings. Local retrieval is not offline inference.

## Untrusted documentation

Publisher pages remain untrusted reference data. The server instructs Claude to read supporting text, cite sources, preserve qualifications and ignore instructions embedded in retrieved documents. Unknown or customer-specific claims require uncertainty. Embedded-content placeholders are flagged.

These instructions reduce risk but cannot guarantee that a language model will resist every prompt injection. This extension cannot control Claude's other enabled tools. For sensitive sales work, enable only the tools needed and review answers before sending them to a customer. Never paste vault passwords, API keys or private customer records into documentation queries.

## Dependencies and package integrity

`package-lock.json` fixes dependency versions. `playwright-core` and `marked` are pinned exactly. Packaging installs production dependencies with lifecycle scripts disabled and requires a clean production dependency audit. The bundle includes no development packer, documentation cache or credentials. A SHA-256 file accompanies the package. A checksum detects accidental changes; it does not authenticate the sender. The private package is unsigned, so obtain it from the maintainer through a trusted channel.

The temporary-file dependency of the development packer is pinned to fixed version 0.2.7. The packer's remaining Zod v3 advisory has no compatible upstream fix in the published packer. It is excluded from the installed extension and is used only with this project's own manifest; do not use this build environment to process untrusted third-party bundles. No incompatible major-version override is used to conceal that advisory.

Runtime dependencies reported no known vulnerabilities at the recorded audit date. This is not a guarantee that no vulnerabilities exist. Re-run dependency checks before distributing future versions.

## Reporting a problem

Contact the maintainer privately with the extension version, operation name, approximate time, and a description. Do not include credentials, private queries or a full conversation. Disable the extension in Claude settings if you suspect unsafe behavior. No public security disclosure or external report is sent automatically by this project.
