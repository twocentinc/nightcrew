import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  commandCatalog,
  exportSchemas,
  globalOptions,
} from "../dist/commands.js";
import {
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
  EXIT_CODES,
} from "../dist/protocol.js";
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
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
export async function snapshots(update = false) {
  const root = new URL("../test/snapshots/", import.meta.url);
  const archive = new URL(`versions/v${SCHEMA_VERSION}.json`, root);
  const current = contract();
  const encode = (value) => JSON.stringify(value, null, 2) + "\n";
  const expected = encode(current);
  let previous;
  try {
    previous = await readFile(archive, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (previous !== undefined && previous !== expected)
    throw Error(
      "Contract drift: increment SCHEMA_VERSION; existing version snapshots are immutable.",
    );
  if (update) {
    await mkdir(new URL("versions/", root), { recursive: true });
    if (previous === undefined)
      await writeFile(archive, expected, { flag: "wx" });
    await writeFile(
      new URL("command-catalog.json", root),
      encode({ ...current, schemas: undefined }),
    );
    await writeFile(new URL("schemas.json", root), encode(current.schemas));
  } else {
    if (previous !== expected)
      throw Error("Missing contract version; run npm run contracts:update.");
    if (
      (await readFile(new URL("command-catalog.json", root), "utf8")) !==
        encode({ ...current, schemas: undefined }) ||
      (await readFile(new URL("schemas.json", root), "utf8")) !==
        encode(current.schemas)
    )
      throw Error("Current snapshots do not match the version archive.");
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!["--check", "--update"].includes(process.argv[2]))
    throw Error("Expected --check or --update");
  await snapshots(process.argv[2] === "--update");
  console.log("Command and schema contracts verified.");
}
