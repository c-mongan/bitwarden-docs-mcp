# Bitwarden Docs for Claude Desktop

Search official Bitwarden documentation from Claude. Install one local extension. No Bitwarden account, API key, separate Node.js installation, or hosted server is needed.

This is an unofficial extension. Bitwarden does not endorse it.

## Install

1. Download `bitwarden-docs-0.1.2.mcpb` to your Mac or Windows computer.
2. Open Claude Desktop. Open **Settings → Desktop app → Extensions → Manage**. Older versions use **Settings → Extensions**.
3. Open **Advanced settings**, select **Install Extension…**, and select the `.mcpb` file. Review the package details and install it. Your organization can restrict custom extensions.
4. Start a new Claude chat and enable **Bitwarden Docs (Unofficial)** in the tools or connectors menu.
5. Ask: “Use Bitwarden Docs to check documentation status, then explain how SSO differs from vault decryption. Cite the official sources.”

The first question starts the download and waits briefly for the documents. A fast download needs no extra question. If the network is slow, Claude explains what to do next. Ask “Is Bitwarden Docs ready?” to see its installed server version, readiness and source counts. If the download fails, check your internet connection and ask Claude to run `refresh_docs`. Do not enter your Bitwarden master password or vault credentials.

## Check an update

After installing a new package, start a new Claude chat and ask: “Use Bitwarden Docs docs_status. Report the server version and readiness.” Version 0.1.2 reports its version directly. If the old version is still running, restart the extension in Claude settings or restart Claude when safe. The connection session ID changes when the server process restarts.

## Five questions to try

1. “Does Bitwarden SSO give our identity provider access to vault decryption keys? Cite the source.”
2. “Compare Teams and Enterprise for SSO, SCIM, policies, and self-hosting. Read the relevant sections and state any limits.”
3. “What must be configured before an administrator can recover a member account?”
4. “Summarize Bitwarden's published security and compliance claims. Separate vendor claims from customer obligations.”
5. “What does the public business pricing page say? Include the currency, billing period, tax qualification, and retrieval date. This is not a negotiated quote.”

## What is included

The extension reads the English help feed and checks it against the official help sitemap. It also reads 17 selected sales pages: product, pricing, compliance, integration, self-hosting, MSP, case-study and vendor-comparison references. `docs_status` reports the exact current counts, exclusions, failures and dates. Exclusions include publisher placeholders and feed-only articles whose public HTML and Markdown both return 404. A retired enterprise landing page is excluded; the business product and pricing pages cover the current offering.

Text is preserved with headings, tables, links, source URLs and hashes. Images, videos, linked PDFs, the general blog archive, community posts, private sales material and password vaults are not read. Courses are indexed only to the extent that their text appears in the public feed. Some publisher exports contain embedded-content placeholders. Tool results flag those pages; the missing components must not be treated as evidence. A vendor comparison is not an independent review.

```text
Bitwarden public pages → local cache ↔ Claude Desktop → cited answer
```

Search results are passages, not final answers. Claude must read supporting sections, preserve qualifications, and say when evidence is missing or conflicting. Public documentation cannot confirm private discounts, contract terms or customer-specific guarantees. Check a live source before relying on stale prices.

## Updates and local storage

Documentation refreshes during use when more than 24 hours old. A refresh does not block access to cached text. Failed refreshes retain the last good text and are visible in `docs_status`. Automatic retries wait 15 minutes after a failure. No separate background service is installed.

Extension code does **not** update automatically. Install a new `.mcpb` file when the maintainer provides one. The cache stays outside the installation folder:

| System | Cache directory |
| --- | --- |
| macOS | `~/Library/Application Support/BitwardenDocsMCP` |
| Windows | `%LOCALAPPDATA%\BitwardenDocsMCP` |

To remove the extension, disable or remove **Bitwarden Docs (Unofficial)** in Claude's extension settings. The documentation cache can remain. To remove it too, close the extension and move only the directory above to Trash or Recycle Bin. No vault data is stored there.

## Privacy

Search runs on your computer. Downloads contact only selected public `bitwarden.com` documentation URLs. Search queries are not sent to Bitwarden. The tool replies are sent to Claude to generate an answer; this is not an offline language model. Local diagnostics record operation names, times, success and page counts, without queries or document text. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Developer checks

Requires Node.js 22 or later. Run `npm ci`, then `npm test` and `npm run lint`. Set `DOCS_MCP_CACHE` to an isolated directory for verification. Run `npm run refresh`, `npm run eval`, `npm run smoke`, and `npm run audit`. The audit reconstructs every indexed document and heading section through MCP and compares text hashes. It does not prove that all rendered website content is indexed.

Run `npm run package` to make the `.mcpb` and its SHA-256 checksum in the parent directory. The package contains production dependencies only. The 20-case evaluation checks retrieval and source access. It is an authored test set, not a blind measure of Claude's answer accuracy.

Tools: `search_docs`, `read_doc`, `list_docs`, `docs_status`, `refresh_docs`. Filter sources with `help` or `sales`. Follow `nextOffset` for catalogue pages, `nextLine` for document text, and `nextSectionOffset` for heading-directory pages. Pass the returned `revision` during pagination; restart pagination if the cache changes.
