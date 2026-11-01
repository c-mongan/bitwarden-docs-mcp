import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCorpus } from "./corpus.js";
import { guideSourceIds } from "./guidance.js";
import { ROOT } from "./paths.js";

// Run only after a person has read the current guide sources and recommendations.
export async function writeGuideLock(reviewer: string) {
  const corpus = await loadCorpus();
  const ids = guideSourceIds();
  const missing = ids.filter(
    (id) => !corpus.pages.some((page) => page.id === id),
  );
  if (missing.length)
    throw new Error(
      `Guide sources missing from the cache: ${missing.join(", ")}`,
    );
  const lock = {
    reviewedAt: new Date().toISOString(),
    reviewer,
    sources: Object.fromEntries(
      ids.map((id) => [
        id,
        corpus.pages.find((page) => page.id === id)!.sha256,
      ]),
    ),
  };
  await writeFile(
    join(ROOT, "docs/guides.lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  return { reviewedAt: lock.reviewedAt, reviewer, sources: ids.length };
}
