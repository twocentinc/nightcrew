import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "nightcrew-package-"));
try {
  const { stdout } = await exec(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
    { cwd: root },
  );
  const [pack] = JSON.parse(stdout);
  for (const file of pack.files)
    assert.match(
      file.path,
      /^(package\.json|README\.md|docs\/(?:model-switch-verification|eval-format)\.md|examples\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:md|json|mjs)|dist\/[a-zA-Z0-9_-]+\.(js|d\.ts))$/,
      "Unexpected packed file: " + file.path,
    );
  assert.ok(pack.files.some((f) => f.path === "dist/cli.js"));
  assert.ok(
    pack.files.some((f) => f.path === "examples/hello-world/agent.json"),
  );
  for (const name of ["inspect.mjs", "report.mjs", "agent.json", "skill.json"])
    assert.ok(pack.files.some((f) => f.path === "examples/agent-supervisor/" + name));
  const install = path.join(temp, "install");
  await mkdir(install);
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefer-offline",
      path.join(temp, pack.filename),
    ],
    { cwd: install, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  const home = path.join(temp, "home");
  await mkdir(home, { mode: 0o700 });
  const runtime = path.join(temp, "r");
  const env = { ...process.env, HOME: home, NIGHTCREW_HOME: runtime };
  const bin = path.join(install, "node_modules", ".bin", "nightcrew");
  const call = async (args) =>
    JSON.parse(
      (await exec(bin, args, { env, cwd: temp, timeout: 10000 })).stdout,
    );
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal((await call(["version"])).result.version, pkg.version);
  assert.ok(
    (await call(["help", "tools"])).result.commands.includes(
      "tools.create".replace(".", " "),
    ),
  );
  assert.ok(
    (await call(["schema", "get", "tools.create"])).result.schema.properties
      .tool,
  );
  assert.equal((await call(["init", "--dry-run"])).result.changed, false);
  await assert.rejects(readFile(path.join(runtime, "config.json")), {
    code: "ENOENT",
  });
  assert.equal((await call(["init"])).ok, true);
  assert.deepEqual((await call(["agents", "list"])).result.items, []);
  assert.equal((await call(["capabilities"])).result.models.length, 0);
  console.log(
    `Packed and independently installed nightcrew ${pkg.version}: executable, discovery and offline commands passed.`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
