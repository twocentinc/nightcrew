import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, cp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
test(
  "packed package installs and exposes working CLI and examples",
  {
    skip: process.env.NIGHTCREW_TEST_PACKAGE !== "1",
    timeout: 180000,
  },
  async () => {
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
          /^(package\.json|README\.md|docs\/(?:model-switch-verification|eval-format|acceptance|compatibility)\.md|examples\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:md|json|ts)|dist\/(?:commands\/|engine\/(?:runs\/|execution\/|instant\/|scheduling\/|models\/|compaction\/|capabilities\/|evals\/)?|schemas\/|storage\/|server\/|utils\/(?:commands\/)?)?[a-zA-Z0-9_-]+\.(js|d\.ts))$/,
          "Unexpected packed file: " + file.path,
        );
      assert.ok(pack.files.some((f?: any) => f.path === "dist/cli.js"));
      assert.ok(
        pack.files.some(
          (f?: any) => f.path === "examples/hello-world/agent.json",
        ),
      );
      for (const name of [
        "inspect.ts",
        "report.ts",
        "agent.json",
        "skill.json",
      ])
        assert.ok(
          pack.files.some(
            (f?: any) => f.path === "examples/agent-supervisor/" + name,
          ),
        );
      assert.deepEqual(
        Object.keys(
          JSON.parse(
            (
              await readFile(path.join(root, "package.json"), "utf8")
            ).toString(),
          ).bin,
        ),
        ["nightcrew"],
      );
      for (const folder of ["agent-supervisor", "summarizer"])
        for (const name of ["eval.json", "eval.ts", "grade.ts", "test.ts"])
          assert.ok(
            pack.files.some(
              (f?: any) => f.path === `examples/${folder}/${name}`,
            ),
          );
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
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import { strict as assert } from 'node:assert'; import { startServer } from 'nightcrew'; import { operationRouter, managementClient } from 'nightcrew/operations'; assert.equal(typeof startServer, 'function'); assert.equal(typeof managementClient, 'function'); assert.ok(operationRouter['agents list']);",
        ],
        { cwd: install },
      );
      // Examples are copied out before editing/running: Node does not strip
      // TypeScript directly under node_modules.
      for (const folder of ["agent-supervisor", "summarizer"]) {
        const example = path.join(temp, folder);
        await cp(
          path.join(install, "node_modules", "nightcrew", "examples", folder),
          example,
          { recursive: true },
        );
        if (folder === "agent-supervisor") {
          const invoke = (name: string, argv: string[], input: unknown) =>
            JSON.parse(
              execFileSync(
                process.execPath,
                [
                  "--experimental-strip-types",
                  path.join(example, name),
                  ...argv,
                ],
                {
                  input: JSON.stringify(input),
                  encoding: "utf8",
                  stdio: ["pipe", "pipe", "pipe"],
                  timeout: 10000,
                },
              ),
            );
          // Invalid IDs fail before reading runtime data. This also proves the
          // copied TypeScript entrypoints execute through macOS /var symlinks.
          assert.equal(
            invoke("inspect.ts", [], { action: "invalid" }).ok,
            false,
          );
          assert.equal(
            invoke("report.ts", ["--validate"], {
              runID: "../invalid",
              text: "",
            }).valid,
            false,
          );
        }
        const request = JSON.parse(
          (
            await exec(process.execPath, [
              "--experimental-strip-types",
              path.join(example, "eval.ts"),
            ])
          ).stdout,
        );
        assert.equal(request.grader.exec.executablePath, process.execPath);
        assert.equal(
          request.grader.exec.argv[1],
          await realpath(path.join(example, "grade.ts")),
        );
        const grade = JSON.parse(
          execFileSync(
            process.execPath,
            ["--experimental-strip-types", path.join(example, "grade.ts")],
            {
              input: JSON.stringify({
                eval: { evalID: "summarizer-budget-not-invented" },
                run: { messages: [] },
                result:
                  folder === "summarizer"
                    ? { summary: "Budget $50/day" }
                    : "A review report.",
              }),
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 10000,
            },
          ),
        );
        assert.equal(grade.passed, true);
        await exec(process.execPath, [
          "--experimental-strip-types",
          "--test",
          "--test-name-pattern=grader",
          path.join(example, "test.ts"),
        ]);
      }
      const { stdout: exportsOutput } = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const main=await import("nightcrew");const operations=await import("nightcrew/operations");console.log(JSON.stringify({server:typeof main.startServer,initialize:typeof main.initializeHome,router:typeof operations.managementClient,hasAgents:!!operations.operationRouter["agents list"]}));`,
        ],
        { cwd: install, timeout: 10000 },
      );
      assert.deepEqual(JSON.parse(exportsOutput), {
        server: "function",
        initialize: "function",
        router: "function",
        hasAgents: true,
      });
      const home = path.join(temp, "home");
      await mkdir(home, { mode: 0o700 });
      const runtime = path.join(temp, "r");
      const env = { ...process.env, HOME: home, NIGHTCREW_HOME: runtime };
      const bin = path.join(install, "node_modules", ".bin", "nightcrew");
      const call = async (args: string[]) =>
        JSON.parse(
          (await exec(bin, args, { env, cwd: temp, timeout: 10000 })).stdout,
        );
      const pkg = JSON.parse(
        (
          await readFile(new URL("../package.json", import.meta.url), "utf8")
        ).toString(),
      );
      assert.equal((await call(["version"])).result.version, pkg.version);
      assert.ok(
        (await call(["help", "tools"])).result.tree.tools.includes("create"),
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
      assert.equal(
        (await call(["status", "--doctor"])).result.capabilities.models.length,
        0,
      );
      console.log(
        `Packed and independently installed nightcrew ${pkg.version}: executable, discovery and offline commands passed.`,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
