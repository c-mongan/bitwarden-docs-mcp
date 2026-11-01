import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CACHE, SearchIndex, atomicJson, loadCorpus } from "./corpus.js";
import { getGuidance, loadGuideLock, topics } from "./guidance.js";
import { ROOT } from "./paths.js";

const cases = z
  .array(
    z.object({
      question: z.string(),
      expectedTopic: z.string().nullable(),
      expected: z.enum(["answerable", "unsupported"]),
    }),
  )
  .parse(
    JSON.parse(
      await readFile(join(ROOT, "evaluation/guidance-cases.json"), "utf8"),
    ),
  );
const index = new SearchIndex(await loadCorpus());
const lock = await loadGuideLock();
const results = cases.map((item) => {
  const guide = getGuidance(index, item.question, lock);
  const unsupported = guide.status === "unsupported";
  const classification =
    (item.expected === "unsupported") === unsupported &&
    (unsupported
      ? !guide.documentation.length && !guide.recommendations.length
      : guide.documentation.length > 0);
  const routed =
    item.expected === "unsupported" ||
    guide.topics[0]?.id === item.expectedTopic;
  const topic = topics.find((topic) => topic.id === item.expectedTopic);
  const cited =
    item.expected === "unsupported" ||
    guide.documentation.some((doc) => topic?.pages.includes(doc.documentId));
  return {
    question: item.question,
    status: guide.status,
    topics: guide.topics.map((topic) => topic.id),
    classification,
    routed,
    cited,
    verifiedLinks: guide.documentation.filter(
      (doc) => doc.linkStatus === "verified",
    ).length,
    citations: guide.documentation.length,
    pass: classification && routed && cited,
  };
});
const answerable = results.filter(
  (_, i) => cases[i]!.expected === "answerable",
);
const rate = (key: "routed" | "cited") =>
  answerable.filter((r) => r[key]).length / answerable.length;
const report = {
  methodology:
    "Project-authored guidance regression cases written alongside the topic patterns; development evidence, not a blind benchmark. Classification (answer vs refuse) must be 100%; topic routing and topic-source citation must each be at least 90%.",
  revision: index.revision,
  guideReviewedAt: lock.reviewedAt,
  pass:
    results.every((r) => r.classification) &&
    rate("routed") >= 0.9 &&
    rate("cited") >= 0.9,
  classification: results.filter((r) => r.classification).length,
  routedRate: rate("routed"),
  citedRate: rate("cited"),
  verifiedLinkRate:
    results.reduce((sum, r) => sum + r.verifiedLinks, 0) /
    Math.max(
      1,
      results.reduce((sum, r) => sum + r.citations, 0),
    ),
  statuses: Object.fromEntries(
    [...new Set(results.map((r) => r.status))].map((s) => [
      s,
      results.filter((r) => r.status === s).length,
    ]),
  ),
  total: results.length,
  results,
};
await atomicJson(join(CACHE, "guidance-evaluation.json"), report);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
