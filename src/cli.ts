import { refresh, status } from "./corpus.js";
import { diagnostics } from "./diagnostics.js";
import { refreshSectionLinks } from "./links.js";
import { writeGuideLock } from "./guide-lock.js";
const command = process.argv[2];
if (command === "refresh") {
  const result = status(await refresh());
  const links = await refreshSectionLinks();
  console.log(JSON.stringify({ ...result, linkCheck: links }, null, 2));
  if (result.sources.some((source) => !source.complete) || links.failed.length)
    process.exitCode = 1;
} else if (command === "links") {
  const links = await refreshSectionLinks(undefined, undefined, { all: true });
  console.log(JSON.stringify(links, null, 2));
  if (links.failed.length) process.exitCode = 1;
} else if (command === "guides-lock") {
  const reviewer = process.argv[3];
  if (!reviewer)
    throw new Error('Usage: cli.js guides-lock "<reviewer name and role>"');
  console.log(JSON.stringify(await writeGuideLock(reviewer), null, 2));
} else if (command === "status")
  console.log(JSON.stringify(await diagnostics(), null, 2));
else
  throw new Error(
    "Usage: cli.js refresh | links | status | guides-lock <reviewer>",
  );
