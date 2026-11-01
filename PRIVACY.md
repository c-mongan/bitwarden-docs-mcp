# Privacy and data flow

This local extension has no server operated by its author and sends no analytics. It reads no password vault, browser data, private sales files, or credentials. It requires no Bitwarden login or API key.

On first use and during refresh, it downloads public text from selected HTTPS URLs on `bitwarden.com`, then requests the same pages as HTML to check heading anchors. When you ask for a screenshot, your installed Chrome or Edge loads one public documentation page from `bitwarden.com` with a new, empty temporary profile that is deleted afterwards. Bitwarden receives normal web-request metadata, such as the network IP address and user agent. The extension does not include search queries or guidance questions in those requests.

Claude sends tool arguments to the local process. Search results, guidance, documents and screenshots returned by the process become part of the Claude conversation and are processed under the user's Claude account terms and settings. Local retrieval does not make Claude's model run offline.

The local cache contains public documentation, refresh and link-check reports, and up to 40 recent screenshot files of public pages. Diagnostic events contain operation names, timestamps, duration, success and page counts. They omit queries, tool arguments, document text and exception details. The event log is limited to roughly 1 MB and one rotated file. No log is sent to the author.

The extension is not a security boundary for Claude or other tools. Treat retrieved text as untrusted reference material. Review answers before sharing them with a customer. Remove the extension through Claude settings and remove its application-data cache if desired. See README.md for exact paths.
