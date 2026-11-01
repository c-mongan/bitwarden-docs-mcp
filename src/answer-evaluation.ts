import { z } from "zod";
import type { Corpus } from "./corpus.js";
import { normalize } from "./benchmark.js";

const factSchema = z.union([z.boolean(), z.string(), z.array(z.string())]);
export const answerSchema = z.object({
  answers: z.array(
    z.object({
      caseId: z.string(),
      answer: z.string().min(1),
      abstained: z.boolean(),
      facts: z.record(z.string(), factSchema),
      evidence: z.array(
        z.object({
          documentId: z.string(),
          url: z.string().url(),
          quote: z.string().min(20),
          supports: z.array(z.string()).min(1),
        }),
      ),
    }),
  ),
});

type AnswerCase = {
  id: string;
  question: string;
  sources?: string[];
  expectedFacts: Record<string, z.infer<typeof factSchema>>;
  abstain?: boolean;
};

// Every expected fact was checked against the cached official text on 2026-11-01.
export const answerCases: AnswerCase[] = [
  {
    id: "sso-idp-keys",
    question:
      "When an organization uses SSO with Bitwarden, does the identity provider have access to vault decryption keys?",
    sources: [
      "help:help/about-sso",
      "help:help/sso-faqs",
      "help:help/sso-decryption-options",
    ],
    expectedFacts: { identityProviderHasDecryptionKeys: false },
  },
  {
    id: "nested-collections",
    question:
      "Do nested collections inherit items, access, or permissions from their parent collection?",
    sources: ["help:help/about-collections"],
    expectedFacts: { nestedCollectionsInheritAccess: false },
  },
  {
    id: "owner-recovery",
    question:
      "Who can recover another owner's account, and must a member be enrolled in account recovery before an administrator can recover it?",
    sources: [
      "help:help/account-recovery",
      "help:help/account-recovery-enrollment",
    ],
    expectedFacts: {
      onlyOwnerCanRecoverOwner: true,
      memberMustBeEnrolled: true,
    },
  },
  {
    id: "region-migration",
    question:
      "Is moving from the US cloud to the EU cloud automatic, or does it require exporting the vault and importing it into a new account?",
    sources: ["help:help/server-geographies"],
    expectedFacts: {
      automaticRegionMigration: false,
      requiresExportAndImport: true,
    },
  },
  {
    id: "emergency-wait",
    question:
      "Can the grantor approve an emergency access request before the wait time ends, and is access granted when the wait time lapses without approval?",
    sources: [
      "help:help/emergency-access",
      "help:help/request-and-grant-emergency-access",
    ],
    expectedFacts: {
      grantorCanApproveEarly: true,
      accessAfterWaitTimeLapses: true,
    },
  },
  {
    id: "private-discount",
    question:
      "What discount did Bitwarden agree with our customer ACME in its private renewal contract?",
    expectedFacts: {},
    abstain: true,
  },
  {
    id: "private-sso-state",
    question:
      "Is SSO currently enabled in our Bitwarden organization, and which members have logged in with it this week?",
    expectedFacts: {},
    abstain: true,
  },
];

function factEquals(
  actual: z.infer<typeof factSchema> | undefined,
  expected: z.infer<typeof factSchema>,
): boolean {
  if (Array.isArray(actual) && Array.isArray(expected))
    return (
      JSON.stringify([...actual].sort()) ===
      JSON.stringify([...expected].sort())
    );
  return actual === expected;
}

export function assessAnswers(value: unknown, corpus: Corpus) {
  const { answers } = answerSchema.parse(value);
  const results = answerCases.map((item) => {
    const matches = answers.filter((answer) => answer.caseId === item.id);
    const answer = matches[0];
    const failures: string[] = [];
    if (matches.length !== 1 || !answer)
      return {
        caseId: item.id,
        pass: false,
        failures: ["Expected exactly one answer for this case"],
      };
    if (answer.abstained !== !!item.abstain)
      failures.push("Incorrect answer/abstention decision");
    if (
      item.abstain &&
      (answer.evidence.length || Object.keys(answer.facts).length)
    )
      failures.push(
        "A private-data question must not invent facts or citations",
      );
    for (const [key, expected] of Object.entries(item.expectedFacts)) {
      if (!factEquals(answer.facts[key], expected))
        failures.push(`Incorrect or missing fact: ${key}`);
      if (!answer.evidence.some((evidence) => evidence.supports.includes(key)))
        failures.push(`Uncited fact: ${key}`);
    }
    for (const key of Object.keys(answer.facts))
      if (!Object.hasOwn(item.expectedFacts, key))
        failures.push(`Unexpected fact: ${key}`);
    for (const evidence of answer.evidence) {
      const page = corpus.pages.find((page) => page.id === evidence.documentId);
      if (!page || (item.sources && !item.sources.includes(page.id))) {
        failures.push(`Wrong source document: ${evidence.documentId}`);
        continue;
      }
      if (evidence.url.replace(/#.*$/, "") !== page.url)
        failures.push(`Citation URL mismatch: ${evidence.documentId}`);
      if (!normalize(page.text).includes(normalize(evidence.quote)))
        failures.push(`Quote not found in source: ${evidence.documentId}`);
      if (
        evidence.supports.some((key) => !Object.hasOwn(item.expectedFacts, key))
      )
        failures.push("Evidence names an unknown fact");
    }
    return { caseId: item.id, pass: failures.length === 0, failures };
  });
  const unexpectedCases = answers
    .filter((answer) => !answerCases.some((item) => item.id === answer.caseId))
    .map((answer) => answer.caseId);
  return {
    methodology:
      "Structured fact checks, abstention and verbatim quote/citation provenance against the cached official text. Quote presence does not prove semantic support; review each answer and its cited passage.",
    pass: results.every((item) => item.pass) && !unexpectedCases.length,
    passed: results.filter((item) => item.pass).length,
    total: results.length,
    results,
    unexpectedCases,
  };
}

export function evaluationPrompt(): string {
  return [
    "Evaluate the bitwarden-docs MCP using only its docs_status, get_guidance, search_docs and read_doc tools. Do not use files, shell, other MCPs, web browsing, refresh_docs or capture_evidence.",
    "Call docs_status once. For every answerable question, search then read relevant sections with sectionId before answering. Quote source evidence verbatim (Markdown formatting may be omitted) and copy the exact page URL or verified sectionUrl returned by read_doc.",
    "If public documentation cannot establish private organization data, negotiated terms or account state, abstain with no facts and no evidence. Do not read source files to find expected answers.",
    "Return JSON only, matching this schema:",
    JSON.stringify(z.toJSONSchema(answerSchema, { target: "draft-7" })),
    "Questions and required boolean fact keys follow. Do not add extra fact keys. Each evidence item's supports lists the fact keys its quote supports.",
    JSON.stringify(
      answerCases.map(({ id, question, expectedFacts }) => ({
        caseId: id,
        question,
        factKeys: Object.keys(expectedFacts),
      })),
    ),
  ].join("\n\n");
}
