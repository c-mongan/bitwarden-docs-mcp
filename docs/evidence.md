# Citations and screenshot evidence

## Exact excerpts

`search_docs`, `read_doc` and `get_guidance` return the cached text with `excerptSha256`, the SHA-256 of that exact text. `sha256` covers the whole cached page. Together with `revision`, `fetchedAt` and the line range, they identify what Claude read. Quote a short exact excerpt in answers. Markdown formatting can be omitted when quoting.

## Section links

`sectionUrl` is set only when `linkStatus` is `verified`:

1. The rendered HTML page was fetched from the same allowlisted URL.
2. A heading anchor inside `main` was found. Bitwarden help pages put the id on a `div.scrollspy` wrapper around the heading. The page H1 carries its own id.
3. Exactly one anchor's text matches the cited section title.
4. The anchor check recorded the same page body hash as the cached text.

Otherwise `sectionUrl` is `null` and `linkStatus` is `unverified`; cite the page URL. The selected sales pages do not publish heading anchors. Tabbed content and repeated headings also remain unverified.

## Guidance

`get_guidance` returns two separate kinds of content:

- `documentation`: official excerpts with the citation fields above. These are untrusted source data.
- `recommendations`: maintained project steps (prerequisites, steps, verify). They are not Bitwarden quotations.

Each recommendation lists its `sourceIds` and a `sourceReview` with the current and reviewed hash of every source page. `docs/guides.lock.json` records the reviewed hashes, the reviewer and the date. If a source changes or disappears, the reply has status `needs_review` and a warning. Read the current source before relying on the recommendation, then rerun `npm run guides:lock -- "<reviewer>"` after review.

Status values: `ready`, `stale` (a source is older than 24 hours), `needs_review`, `no_match`, and `unsupported` (vault contents, live organization settings or negotiated terms).

## Screenshots

`capture_evidence` takes `id`, `revision`, `startLine`, `endLine` and an optional `sectionId` from `read_doc`. It:

1. checks the revision and the 1–40 line bound, and that the visible passage is 20–2400 characters;
2. starts the installed Chrome or Edge headless with a new temporary profile, service workers blocked and only `bitwarden.com` `GET`/`HEAD` requests allowed;
3. loads the page URL, rejects redirects to another page, and limits matching to the verified section when one exists;
4. matches the cached passage against normalized visible text, and rejects missing (`source_changed`), repeated (`ambiguous`), clipped or oversized (`too_large`) passages;
5. highlights the passage with the CSS Custom Highlight API without changing page text, and captures the passage with its nearby heading;
6. returns the PNG inline with `imageSha256`, `matchedTextSha256`, the live URL, clip and browser channel, and deletes the temporary profile.

The original and highlighted images are kept in the cache `evidence` folder, limited to 40 files. A screenshot shows that the passage appeared on the live page at `capturedAt`. It does not judge whether an answer's claim follows from the passage.
