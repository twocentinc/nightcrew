// Resolve the optional executable grader without embedding machine paths in fixtures.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const definition = JSON.parse(
  await readFile(
    process.argv[2] ?? new URL("./eval.json", import.meta.url),
    "utf8",
  ),
);
definition.grader = {
  ...definition.grader,
  exec: {
    executablePath: process.execPath,
    argv: [
      "--experimental-strip-types",
      fileURLToPath(new URL("./grade.ts", import.meta.url)),
    ],
    timeoutMs: 10000,
  },
};
console.log(JSON.stringify(definition));
