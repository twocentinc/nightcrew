import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  commandCatalog,
  exportSchemas,
  globalOptions,
} from "../dist/commands/registry.js";
import {
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
  EXIT_CODES,
} from "../dist/engine/protocol.js";
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    ) as T;
  return value;
}
export function contract() {
  return canonical({
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    exitCodes: EXIT_CODES,
    globalOptions,
    commands: commandCatalog(),
    schemas: exportSchemas(),
  });
}
export async function updateSnapshots() {
  const root = new URL("../test/snapshots/", import.meta.url);
  const archive = new URL(`versions/v${SCHEMA_VERSION}.json`, root);
  const current = contract();
  const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const expected = encode(current);
  let previous;
  try {
    previous = await readFile(archive, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (previous !== undefined && previous !== expected)
    throw Error(
      "Contract drift: increment SCHEMA_VERSION; existing version snapshots are immutable.",
    );
  await mkdir(new URL("versions/", root), { recursive: true });
  if (previous === undefined)
    await writeFile(archive, expected, { flag: "wx" });
  await writeFile(
    new URL("command-catalog.json", root),
    encode({ ...current, schemas: undefined }),
  );
  await writeFile(new URL("schemas.json", root), encode(current.schemas));
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] !== "--update")
    throw Error(
      "Expected --update; use npm run contracts:check to run verification tests.",
    );
  await updateSnapshots();
  console.log("Command and schema snapshots updated.");
}
