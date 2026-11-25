import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { type ZodType } from "zod";
import { checkpoint } from "../engine/execution/process.js";
import { NightcrewError } from "../engine/protocol.js";

export async function boundedRead<T>(
  read: () => Promise<T>,
  timeoutMs = 10000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new NightcrewError(
                "storage.readTimeout",
                "State read exceeded its deadline",
                6,
                "safe",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function regular(file: string, max: number) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error("Invalid state file");
  if (
    process.getuid &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  )
    throw new NightcrewError(
      "config.invalidPermissions",
      "State files must be owner-only",
      3,
    );
}
export async function readJSON<T>(
  file: string,
  schema: ZodType<T>,
  max: number,
): Promise<T> {
  return boundedRead(async () => {
    await regular(file, max);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return schema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  });
}
export async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicJSON(file: string, value: unknown, max: number) {
  checkpoint();
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > max) throw Error("resource_limit");
  const directory = path.dirname(file),
    temporary = path.join(directory, "." + randomUUID() + ".tmp");
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    checkpoint();
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function claimJSON(file: string, value: unknown, max: number) {
  checkpoint();
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > max) throw Error("resource_limit");
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}
