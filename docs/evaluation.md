# Evaluation procedure and results

All evaluation sets are project-authored. The implementation author wrote the questions, the guidance patterns and the expected sources, so these results are regression evidence rather than a blind benchmark. No result here measures Claude's answer accuracy in Claude Desktop.

## Sets

| Set | File | Size | What passes |
| --- | --- | --- | --- |
| Original retrieval | `src/evaluation-cases.ts` | 20 | Expected page in top 5 over MCP stdio, evidence phrase present in the full read; two no-match scope cases |
| Benchmark retrieval | `evaluation/cases.json` | 60 (30 development, 30 held-out) | Recall@3 ≥ 90% using the raw question, and every critical case |
| Guidance | `evaluation/guidance-cases.json` | 28 | 100% answer/refuse classification; ≥ 90% topic routing and topic-source citation |
| Structured answers | `src/answer-evaluation.ts` | 7 | Facts, abstention, verbatim quote in the cited page, URL match |
| Benchmark answers | `evaluation/cases.json` | 60 | Provenance plus a semantic review bound to the exact answers, cases and corpus revision |

Nine development and six held-out cases are critical, including all four abstention cases (two per split). Abstention cases ask for negotiated terms, vault contents, live organization settings and contractual breach guarantees.

## Rules

Use `development` for tuning. Run `heldout` only after retrieval code is fixed. If a held-out result motivates a retrieval, guidance or prompt change, that set becomes development evidence; write a new held-out set before claiming generalization. Do not edit a question or rubric to raise a score. Record label defects separately with the evidence.

Label defect recorded before the first held-out run: `development-25` and `heldout-24` originally accepted only one pricing page. Both `sales:pricing` and `sales:pricing/business` publish Teams, Enterprise and Families prices, so both cases now accept either page and the plans help page.

Development tuning: light plural folding (`accounts` → `account`) was added to search after the first development run (25/28 → 26/28). The original 20-case evaluation still passed 20/20 after the change.

## Results on 1 November 2026

Fresh isolated cache, 388 pages (371 help, 17 sales), revision `4f12b09a0e7a…`, cases file SHA-256 `621c7ca25cd4…`.

| Check | Result |
| --- | --- |
| Unit and protocol tests | 53/53 pass |
| Original retrieval evaluation | 20/20; for 11 of the 18 answerable cases the matched result carries a verified section link |
| Benchmark development recall@3 | 26/28 (92.9%), all critical pass. Misses: `development-11` (Linux self-host requirements), `development-22` (machine account) |
| Benchmark held-out recall@3 | 27/28 (96.4%), all critical pass. Miss: `heldout-11` (air-gapped deployment). First run, before any held-out tuning; not tuned afterwards |
| Guidance | 28/28 classification, 100% routing, 100% topic-source citation, 73% of cited excerpts with verified section links |
| Section anchors | 379 of 388 pages have verified anchors; 9 pages (mostly sales) publish none; 0 fetch failures |
| Live evidence smoke | 3/3 captures through installed Chrome with matching PNG digests; stale revision rejected; no temporary profiles left |
| Access audit | 388 pages, 4,438 sections and 47,158 lines reconstructed through MCP; upstream discovery matches |

Abstention cases have no retrieval score. A real clean-client answer run has not been performed for 0.2.0. Report it separately when it is done.

## Answer evaluation

1. Print the prompt: `npm run eval:answers -- prompt` (structured facts) or `npm run eval:benchmark -- prompt heldout` (free-form answers). The prompt contains questions and fact keys, never rubrics or expected sources.
2. Give it to a clean client that has only this server's `docs_status`, `get_guidance`, `search_docs` and `read_doc` tools. Do not allow files, shell, web, refresh or other servers. Record the client, model, tool transcript and exact final JSON privately.
3. Score structured answers: `npm run eval:answers -- /path/to/answers.json`. It fails wrong facts, uncited facts, quotes absent from the cited page, wrong sources and invented facts for private-data questions.
4. For benchmark answers, read each answer, its rubric and every cited passage. Write a semantic review:

```json
{
  "reviewer": "Name or role, including whether this is the implementation author",
  "answersSha256": "SHA-256 of the exact answers file bytes",
  "corpusRevision": "revision returned by the server",
  "casesSha256": "SHA-256 of evaluation/cases.json",
  "verdicts": [
    {
      "caseId": "heldout-01",
      "correct": true,
      "citationsSupported": true,
      "reason": "Explain the support and limits checked."
    }
  ]
}
```

5. Score: `npm run eval:benchmark -- score heldout answers.json review.json`. The scorer rejects a review bound to different answers, cases or revision, and missing or duplicate answers or verdicts. Pass needs 90% correct and every critical case.

An answer with a genuine but irrelevant quote must fail semantic review. Quote presence alone is not correctness.
