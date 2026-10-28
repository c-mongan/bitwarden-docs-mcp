import { refresh, status } from "./corpus.js";
import { diagnostics } from "./diagnostics.js";
const command = process.argv[2];
if (command === "refresh") {
  const result = status(await refresh());
  console.log(JSON.stringify(result, null, 2));
  if (result.sources.some((source) => !source.complete)) process.exitCode = 1;
} else if (command === "status")
  console.log(JSON.stringify(await diagnostics(), null, 2));
else throw new Error("Usage: cli.js refresh | status");
