import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination))
  throw Error(
    "Usage: node --experimental-strip-types eval.ts /absolute/new/result-directory",
  );
const suite = JSON.parse(
  await readFile(new URL("./eval.json", import.meta.url), "utf8"),
);
suite.graders = [
  {
    graderID: "agent-checks",
    executablePath: process.execPath,
    argv: [
      "--experimental-strip-types",
      fileURLToPath(new URL("./grade.ts", import.meta.url)),
    ],
    timeoutMs: 10000,
  },
];
console.log(JSON.stringify({ suite, destination }));
