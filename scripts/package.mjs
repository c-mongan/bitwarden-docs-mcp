import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const npm = process.env.npm_execpath;
if (!npm)
  throw new Error("Use npm run package so the current npm CLI is known.");
const stage = await mkdtemp(join(root, ".bundle-"));
const outputDir = process.env.MCPB_OUTPUT_DIR
  ? resolve(process.env.MCPB_OUTPUT_DIR)
  : join(root, "..");
const output = join(outputDir, `bitwarden-docs-${manifest.version}.mcpb`);
try {
  await mkdir(join(stage, "server"));
  for (const name of [
    "server",
    "corpus",
    "sources",
    "runtime",
    "diagnostics",
    "local-files",
    "evidence-text",
    "links",
    "guidance",
    "capture",
    "output-schemas",
    "version",
  ]) {
    await cp(
      join(root, "dist", "src", `${name}.js`),
      join(stage, "server", `${name}.js`),
    );
  }
  // Reviewed guide-source hashes; guidance reports needs_review without them.
  await cp(
    join(root, "docs", "guides.lock.json"),
    join(stage, "server", "guides.lock.json"),
  );
  for (const name of [
    "manifest.json",
    "package.json",
    "package-lock.json",
    "README.md",
    "PRIVACY.md",
    "NOTICE.md",
    "SECURITY.md",
    "LICENSE",
  ]) {
    await cp(join(root, name), join(stage, name));
  }
  execFileSync(
    process.execPath,
    [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-fund"],
    { cwd: stage, stdio: "inherit" },
  );
  execFileSync(process.execPath, [npm, "audit", "--omit=dev"], {
    cwd: stage,
    stdio: "inherit",
  });
  // The packer is a development tool; it is not shipped in the extension.
  const cli = join(
    root,
    "node_modules",
    "@anthropic-ai",
    "mcpb",
    "dist",
    "cli",
    "cli.js",
  );
  execFileSync(
    process.execPath,
    [cli, "validate", join(stage, "manifest.json")],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync(process.execPath, [cli, "pack", stage, output], {
    cwd: root,
    stdio: "inherit",
  });
  const data = await readFile(output);
  await writeFile(
    `${output}.sha256`,
    `${createHash("sha256").update(data).digest("hex")}  bitwarden-docs-${manifest.version}.mcpb\n`,
  );
  console.log(`Package: ${output}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
