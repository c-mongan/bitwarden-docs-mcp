# Bitwarden Docs for Claude Desktop

Search official Bitwarden documentation from Claude, get cited admin guidance, and capture highlighted screenshots of the official source. Install one local extension. No Bitwarden account, API key, separate Node.js installation, or hosted server is needed.

This is an unofficial extension. Bitwarden does not endorse it. Source code is MIT-licensed; see [LICENSE](LICENSE).

## Install

1. Get `bitwarden-docs-0.2.0.mcpb`: build it with `npm ci && npm run package` (see Developer checks) or obtain it from the maintainer. Check it against its `.sha256` file.
2. Open Claude Desktop. Open **Settings → Desktop app → Extensions → Manage**. Older versions use **Settings → Extensions**.
3. Open **Advanced settings**, select **Install Extension…**, and select the `.mcpb` file. Review the package details and install it. Your organization can restrict custom extensions.
4. Start a new Claude chat and enable **Bitwarden Docs (Unofficial)** in the tools or connectors menu.
5. Ask: “Use Bitwarden Docs to check documentation status, then explain how SSO differs from vault decryption. Cite the official sources.”

The first question starts the download and waits briefly for the documents. A fast download needs no extra question. If the network is slow, Claude explains what to do next. Ask “Is Bitwarden Docs ready?” to see its installed server version, readiness and source counts. If the download fails, check your internet connection and ask Claude to run `refresh_docs`. Do not enter your Bitwarden master password or vault credentials.

## Check an update

After installing a new package, start a new Claude chat and ask: “Use Bitwarden Docs docs_status. Report the server version and readiness.” Version 0.2.0 reports its version directly. If the old version is still running, restart the extension in Claude settings or restart Claude when safe. The connection session ID changes when the server process restarts.

## Six questions to try

1. “Does Bitwarden SSO give our identity provider access to vault decryption keys? Cite the exact section.”
2. “Use Bitwarden Docs guidance: what must be configured before an administrator can recover a member account? Tell me what you still need to know about our setup.”
3. “Compare Teams and Enterprise for SSO, SCIM, policies, and self-hosting. Read the relevant sections and state any limits.”
4. “Summarize Bitwarden's published security and compliance claims. Separate vendor claims from customer obligations.”
5. “What does the public business pricing page say? Include the currency, billing period, tax qualification, and retrieval date. This is not a negotiated quote.”
6. “Do nested collections inherit permissions? Capture a highlighted screenshot of the official passage.”

## Citations, guidance and screenshots

Each search and read result carries an `excerptSha256` of the exact cached text and a `sectionUrl`. `linkStatus` is `verified` only when a heading anchor was found on the rendered page and checked against the same page body; otherwise Claude should cite the page URL. Anchor checks run after each refresh and contact only the same public pages. Most help pages have verified anchors; the selected sales pages do not publish heading anchors.

`get_guidance` covers common admin and security questions: SSO versus vault decryption, account recovery, SCIM and Directory Connector, self-hosting, plans and pricing, compliance claims, cloud regions, roles and collections, emergency access, policies, Secrets Manager, passkeys, Send, event logs, two-step login, imports and MSPs. It returns official excerpts separately from maintained recommendations, asks for missing details such as plan or cloud versus self-hosting, and warns when sources changed since the recommendations were reviewed. It refuses questions about vault contents, live organization settings or negotiated terms.

`capture_evidence` is optional. It needs Google Chrome or Microsoft Edge installed on the computer; nothing else is downloaded. It opens the browser headless with a new temporary profile, contacts only `bitwarden.com`, checks that the cached passage still matches the live page, and returns a highlighted PNG of at most 1200×850 pixels and 1.5 MB. The temporary profile is deleted afterwards. Your own browser profile, cookies and logins are never used. Without a supported browser, the tool reports `unavailable` and Claude should cite the text instead. A screenshot shows where the text appears; it does not prove that a claim follows from it.

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

The cache also keeps up to 40 recent screenshot files in its `evidence` folder. To remove the extension, disable or remove **Bitwarden Docs (Unofficial)** in Claude's extension settings. The documentation cache can remain. To remove it too, close the extension and move only the directory above to Trash or Recycle Bin. No vault data is stored there.

## Privacy

Search runs on your computer. Downloads, section-link checks and screenshots contact only selected public `bitwarden.com` documentation URLs. Search queries are not sent to Bitwarden. The tool replies are sent to Claude to generate an answer; this is not an offline language model. Local diagnostics record operation names, times, success and page counts, without queries or document text. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Developer checks

Requires Node.js 22 or later. Run `npm ci`, then `npm test` and `npm run lint`. Set `DOCS_MCP_CACHE` to an isolated directory for verification, then run:

| Command | What it checks |
| --- | --- |
| `npm run refresh` | Downloads documentation, then checks section anchors |
| `npm run refresh:links` | Rechecks every page's rendered heading anchors |
| `npm run eval` | 20 original retrieval and evidence scenarios over MCP stdio |
| `npm run eval:benchmark -- retrieval development` | Recall@3 on 30 development cases (use `heldout` only for final runs) |
| `npm run eval:guidance` | Guidance routing, refusal and topic-source citation |
| `npm run eval:answers -- prompt` / `-- answers.json` | Structured answer prompt and provenance scorer for a clean client run |
| `npm run smoke` | Real MCP stdio search, read, guidance and status |
| `npm run smoke:evidence` | Live capture with the installed browser, PNG digest and profile cleanup |
| `npm run audit` | Reconstructs every document and section through MCP and compares hashes |

`npm run guides:lock -- "<reviewer>"` records reviewed guide-source hashes in `docs/guides.lock.json`. Run it only after reading the changed sources and recommendations. See [docs/evaluation.md](docs/evaluation.md) for the method and current results, and [docs/evidence.md](docs/evidence.md) for citation and screenshot details.

Run `npm run package` to make the `.mcpb` and its SHA-256 checksum in the parent directory, or in `MCPB_OUTPUT_DIR` when set. The package contains production dependencies only, including `playwright-core` without bundled browsers. Run `node scripts/check-package.mjs <unpacked-dir> <empty-cache-dir>` to test the packaged server. Evaluations are project-authored test sets, not a blind measure of Claude's answer accuracy.

Tools: `search_docs`, `read_doc`, `get_guidance`, `capture_evidence`, `list_docs`, `docs_status`, `refresh_docs`. Every tool declares an output schema and returns structured content. Filter search and catalogue sources with `help` or `sales`. Follow `nextOffset` for catalogue pages, `nextLine` for document text, and `nextSectionOffset` for heading-directory pages. Pass the returned `revision` during pagination and to `capture_evidence`; restart pagination if the cache changes.
