import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";

export const MAX_CACHE_BYTES = 32_000_000;

export async function checkDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      "Cache directory must be a real directory, not a symbolic link",
    );
  if (process.getuid && info.uid !== process.getuid())
    throw new Error("Cache directory must belong to the current user");
}

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await checkDirectory(path);
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function readBoundedFile(
  path: string,
  maxBytes = MAX_CACHE_BYTES,
) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Cache input must be a regular file, not a symbolic link");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > maxBytes)
      throw new Error("Cache file exceeds the safe size limit");
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        throw new Error("Cache file exceeds the safe size limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function appendPrivateLog(path: string, entry: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Log must be a regular file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await file.writeFile(entry);
  } finally {
    await file.close();
  }
}
