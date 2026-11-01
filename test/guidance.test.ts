import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SearchIndex, type Corpus, type Page } from "../src/corpus.js";
import { sha256 } from "../src/evidence-text.js";
import {
  getGuidance,
  guideSourceIds,
  loadGuideLock,
  matchingTopics,
  privateRequest,
  topics,
} from "../src/guidance.js";
import {
  answerCases,
  assessAnswers,
  evaluationPrompt,
} from "../src/answer-evaluation.js";
import {
  benchmarkPrompt,
  parseCases,
  retrievalReport,
  scoreAnswers,
} from "../src/benchmark.js";
import { outputSchemas } from "../src/output-schemas.js";

const ssoText =
  "# About Single Sign-On\n\n## SSO Decryption Options\n\nUsing SSO with Bitwarden retains our zero-knowledge encryption model. Nobody at Bitwarden has access to your data and, similarly, **neither should your Identity Provider**.";
const pricingText =
  "# Business Pricing\n\n## Teams\n\n$4 per month / per user billed annually. Prices exclude tax.";

function page(id: string, text: string, overrides: Partial<Page> = {}): Page {
  const [source, path] = id.split(":") as ["help" | "sales", string];
  return {
    id,
    source,
    title: text.match(/^# (.+)$/m)![1]!,
    url: `https://bitwarden.com/${path}/`,
    fetchedFrom: `https://bitwarden.com/${path}.md`,
    version: "live",
    fetchedAt: new Date().toISOString(),
    sha256: sha256(text),
    text,
    ...overrides,
  };
}
const corpus = (pages: Page[]): Corpus => ({
  schemaVersion: 1,
  pages,
  reports: [],
});

test("private-request detection refuses vault contents, negotiated terms and live org state only", () => {
  for (const question of [
    "What is our negotiated discount?",
    "Show me the passwords in our vault for the finance team.",
    "List the passwords stored in our company vault.",
    "Is SSO currently enabled in our organization?",
    "How many members are in our organization right now?",
    "Has our org already enrolled everyone in account recovery?",
  ])
    assert.equal(privateRequest(question).unsupported, true, question);
  for (const question of [
    "Does our identity provider get vault decryption keys when we enable SSO?",
    "What must be configured before an administrator can recover a member account?",
    "Can our admins see member vault items in collections?",
    "Compare Teams and Enterprise for SSO, SCIM, policies and self-hosting.",
    "How do I get a quote for 500 users?",
  ])
    assert.equal(privateRequest(question).unsupported, false, question);
  assert.deepEqual(
    privateRequest(
      "How do I check whether our organization has account recovery enabled?",
    ),
    { unsupported: false, privateContext: true },
  );
});

test("topics route common admin questions and every topic has review-tracked sources", () => {
  assert.equal(
    matchingTopics("Compare Teams and Enterprise for SSO and SCIM")[0]?.id,
    "plans-pricing",
  );
  assert.equal(
    matchingTopics("Do nested collections inherit?")[0]?.id,
    "access-control",
  );
  assert.equal(
    matchingTopics("How long is the emergency access wait?")[0]?.id,
    "emergency-access",
  );
  assert.deepEqual(matchingTopics("What colour is the sky?"), []);
  const ids = new Set(topics.map((topic) => topic.id));
  assert.equal(ids.size, topics.length);
  for (const topic of topics) {
    assert.ok(topic.pages.length, topic.id);
    assert.ok(topic.steps.length && topic.verify.length, topic.id);
    for (const id of topic.pages) assert.match(id, /^(help:help\/|sales:)/);
  }
});

test("guidance separates official excerpts from maintained recommendations and tracks review state", async () => {
  const sso = page("help:help/about-sso", ssoText, {
    anchors: { "sso-decryption-options": "SSO Decryption Options" },
    anchorsCheckedAt: new Date().toISOString(),
    anchorsSha256: sha256(ssoText),
  });
  const index = new SearchIndex(corpus([sso]));
  const question =
    "Does our identity provider get vault decryption keys when we enable SSO?";
  const unreviewed = getGuidance(index, question);
  assert.equal(unreviewed.status, "needs_review");
  assert.equal(unreviewed.topics[0]?.id, "sso-decryption");
  const doc = unreviewed.documentation[0]!;
  assert.equal(doc.documentId, sso.id);
  assert.equal(doc.linkStatus, "verified");
  assert.equal(doc.excerptSha256, sha256(doc.text));
  assert.match(doc.text, /neither should your Identity Provider/);
  const guide = unreviewed.recommendations[0]!;
  assert.ok(guide.steps.length);
  assert.ok(
    guide.sourceReview.some(
      (item) => item.id === sso.id && item.status === "needs_review",
    ),
  );
  assert.ok(
    guide.sourceReview.some(
      (item) => item.id === "help:help/sso-faqs" && item.status === "missing",
    ),
  );
  assert.ok(
    unreviewed.missingInformation.some((item) =>
      /cloud .* self-hosted/.test(item),
    ),
  );
  const lock = {
    reviewedAt: "2026-11-01T00:00:00.000Z",
    sources: Object.fromEntries(
      topics
        .find((topic) => topic.id === "sso-decryption")!
        .pages.map((id) => [id, id === sso.id ? sso.sha256 : "x"]),
    ),
  };
  assert.equal(getGuidance(index, question, lock).status, "needs_review");
  const onlySso = getGuidance(new SearchIndex(corpus([sso])), question, {
    ...lock,
    sources: { ...lock.sources },
  });
  assert.ok(onlySso.warnings.some((w) => /changed or are missing/.test(w)));
  outputSchemas.get_guidance.parse(unreviewed);
});

test("guidance adds pricing qualifications and refuses private commercial data", () => {
  const index = new SearchIndex(
    corpus([page("sales:pricing/business", pricingText)]),
  );
  const pricing = getGuidance(index, "How much does Teams cost per user?");
  assert.ok(pricing.warnings.some((w) => /not a quote/.test(w)));
  assert.ok(pricing.warnings.some((w) => /marketing claims/.test(w)));
  const refused = getGuidance(
    index,
    "What discount did we negotiate in our contract?",
  );
  assert.equal(refused.status, "unsupported");
  assert.deepEqual(refused.documentation, []);
  assert.deepEqual(refused.recommendations, []);
  const stale = getGuidance(
    new SearchIndex(
      corpus([
        page("sales:pricing/business", pricingText, {
          fetchedAt: "2000-01-01T00:00:00.000Z",
        }),
      ]),
    ),
    "How much does Teams cost per user?",
  );
  assert.ok(stale.warnings.some((w) => /older than 24 hours/.test(w)));
});

test("shipped guide lock covers every guide source", async () => {
  const lock = await loadGuideLock();
  assert.notEqual(lock.reviewedAt, "not reviewed");
  assert.deepEqual(Object.keys(lock.sources).sort(), guideSourceIds().sort());
});

test("answer evaluation checks facts, abstention and verbatim provenance", () => {
  const sso = page("help:help/about-sso", ssoText);
  const data = corpus([sso]);
  const good = {
    caseId: "sso-idp-keys",
    answer: "No.",
    abstained: false,
    facts: { identityProviderHasDecryptionKeys: false },
    evidence: [
      {
        documentId: sso.id,
        url: `${sso.url}#sso-decryption-options`,
        quote:
          "Nobody at Bitwarden has access to your data and, similarly, neither should your Identity Provider",
        supports: ["identityProviderHasDecryptionKeys"],
      },
    ],
  };
  const abstain = (caseId: string) => ({
    caseId,
    answer: "Cannot confirm.",
    abstained: true,
    facts: {},
    evidence: [],
  });
  const report = assessAnswers(
    {
      answers: [
        good,
        abstain("private-discount"),
        abstain("private-sso-state"),
      ],
    },
    data,
  );
  const result = (id: string) => report.results.find((r) => r.caseId === id)!;
  assert.equal(result("sso-idp-keys").pass, true);
  assert.equal(result("private-discount").pass, true);
  assert.equal(result("nested-collections").pass, false);
  assert.equal(report.pass, false);
  const forged = assessAnswers(
    {
      answers: [
        {
          ...good,
          evidence: [
            {
              ...good.evidence[0]!,
              quote: "The identity provider stores every vault key.",
            },
          ],
        },
      ],
    },
    data,
  );
  assert.match(forged.results[0]!.failures.join(), /Quote not found/);
  const invented = assessAnswers(
    {
      answers: [{ ...abstain("private-discount"), facts: { discount: "20%" } }],
    },
    data,
  );
  assert.match(
    invented.results
      .find((r) => r.caseId === "private-discount")!
      .failures.join(),
    /must not invent/,
  );
  assert.match(evaluationPrompt(), /identityProviderHasDecryptionKeys/);
  assert.equal(
    new Set(answerCases.map((item) => item.id)).size,
    answerCases.length,
  );
});

test("benchmark cases are balanced, unique and scored with bound semantic review", async () => {
  const raw = await readFile(
    new URL("../../evaluation/cases.json", import.meta.url),
    "utf8",
  );
  const cases = parseCases(raw);
  assert.equal(cases.filter((c) => c.split === "development").length, 30);
  assert.equal(cases.filter((c) => c.split === "heldout").length, 30);
  for (const item of cases)
    for (const id of item.expectedDocuments)
      assert.match(id, /^(help:help\/|sales:)/);
  const prompt = benchmarkPrompt(cases.slice(0, 2));
  assert.equal(JSON.stringify(prompt).includes("rubric"), false);
  const sso = page("help:help/about-sso", ssoText);
  const index = new SearchIndex(corpus([sso]));
  const subset = [
    {
      id: "t-1",
      split: "development" as const,
      question: "Does SSO give the identity provider decryption keys?",
      expectedDocuments: [sso.id],
      rubric: "No.",
      critical: true,
    },
  ];
  assert.equal(retrievalReport(subset, index, "development", "h").pass, true);
  const answers = JSON.stringify({
    answers: [
      {
        caseId: "t-1",
        answer: "No.",
        abstained: false,
        evidence: [
          {
            documentId: sso.id,
            url: sso.url,
            quote: "neither should your Identity Provider",
          },
        ],
      },
    ],
  });
  const review = {
    reviewer: "test",
    answersSha256: sha256(answers),
    corpusRevision: index.revision,
    casesSha256: "h",
    verdicts: [
      {
        caseId: "t-1",
        correct: true,
        citationsSupported: true,
        reason: "Quote states the IdP has no access.",
      },
    ],
  };
  assert.equal(scoreAnswers(subset, answers, review, index, "h").pass, true);
  assert.throws(
    () =>
      scoreAnswers(
        subset,
        answers,
        { ...review, casesSha256: "other" },
        index,
        "h",
      ),
    /different answers/,
  );
});
