import test from "node:test";
import { contract } from "./contracts.ts";
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

test("commands directory contains exactly the top-level CLI families", async () => {
  const files = (await readdir(new URL("../src/commands/", import.meta.url)))
    .filter((name) => !name.startsWith("._"))
    .sort();
  const families = [
    ...new Set(
      contract().commands.map((command) => command.name.split(" ")[0]),
    ),
  ]
    .map((name) => name + ".ts")
    .sort();
  assert.deepEqual(files, families);
});

test("README release identity agrees with the package and public contract", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const current = contract();
  assert.ok(
    readme.includes(
      `**${pkg.version}**, protocol **${current.protocolVersion}**, schema **${current.schemaVersion}**`,
    ),
  );
});
