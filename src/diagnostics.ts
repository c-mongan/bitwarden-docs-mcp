import { readBoundedFile, checkDirectory } from "./local-files.js";
import { join } from "node:path";
import { z } from "zod";
import { CACHE, loadCorpus, status } from "./corpus.js";

const logSchema = z.object({
  at: z.string(),
  operation: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  count: z.number().optional(),
});

export async function diagnostics(cache = CACHE) {
  let log = "";
  try {
    await checkDirectory(cache);
    log = await readBoundedFile(join(cache, "events.jsonl"), 1_100_000);
  } catch {
    /* Metrics must not prevent documentation status. */
  }
  const events = log.split("\n").flatMap((line) => {
    try {
      const value = logSchema.safeParse(JSON.parse(line));
      return value.success ? [value.data] : [];
    } catch {
      return [];
    }
  });
  const operations = [...new Set(events.map((item) => item.operation))].map(
    (operation) => {
      const items = events.filter((item) => item.operation === operation);
      const times = items.map((item) => item.durationMs).sort((a, b) => a - b);
      return {
        operation,
        calls: items.length,
        errors: items.filter((item) => !item.ok).length,
        p95Ms: Math.round(
          times[Math.max(0, Math.ceil(times.length * 0.95) - 1)]!,
        ),
      };
    },
  );
  return {
    ...status(await loadCorpus(cache)),
    observability: {
      destination:
        "Local stderr + bounded application-data events.jsonl (1 MB plus one rotated file). No external telemetry.",
      metricsWindow: "Current event log only; not lifetime counters.",
      operations,
      recentEvents: events.slice(-20),
    },
  };
}
