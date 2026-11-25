import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { skillSchema } from "../dist/contracts.js";
import {
  writeSkillFolder,
  readSkillFiles,
  loadSkillContent,
} from "../dist/skills.js";
import { loadRegistry } from "../dist/registry.js";

test("skill folders round-trip text/binary resources, preserve unrelated files, and reject traversal", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-skills-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "skills");
  const skill = skillSchema.parse({
    skillID: "review",
    name: "Review",
    description: "Review records",
    instructions: "Use the reference.",
    toolIDs: [],
    files: [
      {
        path: "references/nested/guide.md",
        content: "Reference instructions",
        encoding: "utf8",
      },
      {
        path: "assets/template.json",
        content: '{"status":null}',
        encoding: "utf8",
      },
      {
        path: "assets/binary.dat",
        content: Buffer.from([0, 255, 128]).toString("base64"),
        encoding: "base64",
      },
    ],
  });
  await writeSkillFolder(root, skill, skill.skillID);
  await writeFile(path.join(root, "review", "notes.txt"), "Preserve me");
  const loaded = (await loadRegistry(home)).skills.get("review");
  assert.deepEqual(
    loaded!.files.slice().sort((a, b) => a.path.localeCompare(b.path)),
    skill.files.slice().sort((a, b) => a.path.localeCompare(b.path)),
  );
  const available = loadSkillContent([loaded!], {});
  assert.equal(available.available[0].skillID, "review");
  assert.deepEqual(available.skills, []);
  const instructions = loadSkillContent([loaded!], { skillIDs: ["review"] });
  assert.equal(instructions.skills[0].instructions, "Use the reference.");
  assert.ok(
    instructions.skills[0].files.every((f) => !Object.hasOwn(f, "content")),
  );
  assert.equal(
    loadSkillContent([loaded!], {
      files: [{ skillID: "review", path: "assets/template.json" }],
    }).files[0].content,
    '{"status":null}',
  );
  assert.throws(
    () => loadSkillContent([loaded!], { skillIDs: ["other"] }),
    /not selected/,
  );
  for (const invalid of [
    "../secret",
    "assets/../../secret",
    "/etc/passwd",
    "assets//file",
    "assets/./file",
    "assets/a\\b",
  ]) {
    assert.equal(
      skillSchema.safeParse({
        ...skill,
        files: [{ path: invalid, content: "x" }],
      }).success,
      false,
    );
  }
  await writeSkillFolder(
    root,
    { ...skill, instructions: "Updated" },
    skill.skillID,
  );
  assert.equal(
    await readFile(path.join(root, "review", "notes.txt"), "utf8"),
    "Preserve me",
  );
  const outside = path.join(home, "outside");
  await writeFile(outside, "must not read");
  await symlink(outside, path.join(root, "review", "assets", "link"));
  await assert.rejects(readSkillFiles(path.join(root, "review")), /symlink/);
});

test("skill folders enforce aggregate size and preserve existing folder on rejected replacement", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-skill-limit-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "skills");
  const skill = skillSchema.parse({
    skillID: "small",
    name: "Small",
    description: "small",
    instructions: "Keep",
    toolIDs: [],
  });
  await writeSkillFolder(root, skill, "small");
  const folder = path.join(root, "small", "references");
  await mkdir(folder);
  await writeFile(path.join(folder, "large.txt"), "x".repeat(128 * 1024 + 1));
  await assert.rejects(
    readSkillFiles(path.join(root, "small")),
    /Invalid skill resource/,
  );
  assert.equal(
    skillSchema.safeParse({
      ...skill,
      files: [{ path: "assets/x", encoding: "base64", content: "not base64!" }],
    }).success,
    false,
  );
});

test("model tool boundary returns bounded errors without replaying failures or swallowing cancellation", async () => {
  const { executeModelTool } = await import("../dist/registry.js");
  const definition = {
    toolID: "test",
    description: "test",
    executablePath: process.execPath,
    argv: ["-e", "process.exit(2)"],
    timeoutMs: 1000,
    parameters: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  };
  const signal = new AbortController().signal;
  assert.equal(
    (await executeModelTool(undefined, "{}", signal)).error.code,
    "tool_unavailable",
  );
  assert.equal(
    (await executeModelTool(definition, "{", signal)).error.outcome,
    "not_started",
  );
  assert.equal(
    (await executeModelTool(definition, '{"extra":true}', signal)).error.code,
    "invalid_tool_arguments",
  );
  const invalidAction = await executeModelTool(
    {
      ...definition,
      parameters: {
        type: "object" as const,
        properties: {
          action: { type: "string" as const, enum: ["tables", "schema"] },
        },
        required: ["action"],
      },
    },
    '{"action":"help"}',
    signal,
  );
  assert.match(invalidAction.error.message, /tables/);
  assert.match(invalidAction.error.message, /schema/);
  assert.match(invalidAction.error.message, /action/);
  for (const [argv, timeoutMs, code] of [
    [["-e", "process.exit(2)"], 1000, "tool_execution_failed"],
    [["-e", "console.log('not json')"], 1000, "invalid_tool_output"],
    [
      ["-e", "process.stdout.write('x'.repeat(1048577))"],
      1000,
      "tool_output_limit",
    ],
    [["-e", "setInterval(()=>{},1000)"], 100, "tool_timeout"],
  ] as Array<[string[], number, string]>) {
    const output = await executeModelTool(
      { ...definition, argv, timeoutMs },
      "{}",
      signal,
    );
    assert.equal(output.ok, false);
    assert.equal(output.error.code, code);
    assert.equal(output.error.outcome, "unknown");
  }
  const controller = new AbortController();
  const pending = executeModelTool(
    { ...definition, argv: ["-e", "setInterval(()=>{},1000)"] },
    "{}",
    controller.signal,
  );
  setTimeout(() => controller.abort(new Error("cancelled by user")), 50);
  await assert.rejects(pending, /cancelled by user/);
  await assert.rejects(
    executeModelTool(definition, "bad json", controller.signal),
    /cancelled by user/,
  );
});
