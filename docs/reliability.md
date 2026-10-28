# Refresh and validation

Use Node.js 22 or later. Run `npm ci`, `npm test`, and `npm run lint`.

Set `DOCS_MCP_CACHE` to an absolute path for an isolated verification cache. Refresh, evaluation, smoke and audit use the same cache path, including their child MCP processes.

```sh
export DOCS_MCP_CACHE="/absolute/path/to/documentation-cache"
npm run refresh
npm run eval
npm run smoke
npm run audit
```

The access audit enumerates all documents and heading-directory pages, reconstructs every document and section through MCP, compares text hashes, and checks fresh upstream discovery. It proves access to indexed text, not full rendered-site extraction or model comprehension.

## Refresh safety

The help feed is checked against the English help sitemap. Feed-only pages require a valid individual Markdown export. A publisher placeholder is excluded. A feed-only article whose Markdown and HTML both return 404 is excluded. Other fetch failures remain failures. If the sitemap is unavailable, help discovery fails and preserves the previous cache.

A discovery reduction greater than 20% for a source with at least ten pages is rejected. A page reduction greater than 60% for an existing body longer than 500 characters retains its previous text. These guards require maintainer inspection when the publisher deliberately removes large amounts of material. Do not bypass them to make a status check pass.

`proper-lockfile` renews the cache lock every two seconds. A competing writer cannot refresh that cache. After a writer crashes, the next refresh can recover a lock that has had no heartbeat for at least ten seconds. Data is written to a temporary file and atomically renamed. A killed writer cannot partially overwrite the previous corpus.

The local process coalesces refresh calls. Missing or stale content triggers background refresh during use. Existing content remains readable. A failed refresh waits 15 minutes before an automatic retry. Explicit `refresh_docs` calls can retry sooner. No daemon or scheduled OS task is installed.

## Logging and limits

Logs contain only operation names, timestamps, durations, success and counts. Exception details, queries and document text are excluded. Log write failures do not replace successful results or original tool errors. Missing, unreadable or partially written metric logs do not prevent status reporting.

Catalogue, search and document text replies are byte-bounded. Long heading directories have separate `sectionOffset` and `nextSectionOffset` pagination. Use the returned revision across all pagination to detect a cache update.

## Tests and limits

Tests cover source boundaries, duplicate URLs, placeholders, disappeared pages, partial fetches, stale and corrupt caches, retry backoff, concurrent refreshes, lock heartbeat and crash recovery, cache propagation, logging failures, pagination and the stdio MCP protocol.

The 20 authored evaluation cases check retrieval, readable evidence and no-match scope handling. Their expected-answer rubrics require human/model review. Passing retrieval is not a claim that Claude always answers correctly. Live network checks are separate from the fixture-based unit tests.
