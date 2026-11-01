import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CACHE, atomicJson, loadCorpus } from "./corpus.js";
import { assessAnswers, evaluationPrompt } from "./answer-evaluation.js";

const input = process.argv[2];
if (input === "prompt") {
  console.log(evaluationPrompt());
} else if (input) {
  const result = assessAnswers(
    JSON.parse(await readFile(input, "utf8")),
    await loadCorpus(),
  );
  const report = {
    at: new Date().toISOString(),
    input: basename(input),
    ...result,
  };
  await atomicJson(join(CACHE, `answer-evaluation-${basename(input)}`), report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} else {
  throw new Error(
    "Usage: evaluate-answers.js prompt | /path/to/client-answers.json",
  );
}
