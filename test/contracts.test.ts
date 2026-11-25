import test from "node:test";
import { contract } from "../scripts/contracts.ts";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

test("public contracts match immutable version snapshots", async () => {
  const current = contract();
  const root = new URL("./snapshots/", import.meta.url);
  const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  assert.equal(
    await readFile(
      new URL(`versions/v${current.schemaVersion}.json`, root),
      "utf8",
    ),
    encode(current),
    "Contract drift: approve a schema increment and run contracts:update; old archives are immutable.",
  );
  assert.equal(
    await readFile(new URL("command-catalog.json", root), "utf8"),
    encode({ ...current, schemas: undefined }),
  );
  assert.equal(
    await readFile(new URL("schemas.json", root), "utf8"),
    encode(current.schemas),
  );
});

test("repository-owned source contains no mjs files", async () => {
  const root = new URL("../", import.meta.url);
  const ignored = new Set(["node_modules", ".git", "dist"]);
  async function visit(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith("._") || ignored.has(entry.name)) continue;
      assert.notEqual(
        path.extname(entry.name).toLowerCase(),
        ".mjs",
        "Forbidden .mjs file: " + new URL(entry.name, directory).pathname,
      );
      if (entry.isDirectory())
        await visit(new URL(entry.name + "/", directory));
    }
  }
  await visit(root);
});
