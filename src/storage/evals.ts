import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  evalRecordSchema,
  type EvalDefinition,
} from "../engine/evals/format.js";
import { id } from "../schemas/common.js";
import { atomicJSON, readJSON } from "./files.js";
import { fail } from "../engine/protocol.js";
/** Callers use Storage.exclusive for mutations; this store owns no queue. */
export class EvalStore {
  constructor(private readonly home: string) {}
  private file(evalID: string) {
    return path.join(this.home, "evals", id.parse(evalID) + ".json");
  }
  async get(evalID: string) {
    const record = await readJSON(
      this.file(evalID),
      evalRecordSchema,
      8 * 1024 * 1024,
    ).catch((e) => {
      if (e.code === "ENOENT") return fail("eval_not_found", 404);
      throw e;
    });
    if (record.definition.evalID !== evalID)
      fail("eval_identity_mismatch", 409);
    return record;
  }
  async list() {
    const entries = await readdir(path.join(this.home, "evals")).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    return Promise.all(
      entries
        .filter((n) => !n.startsWith(".") && n.endsWith(".json"))
        .sort()
        .map((n) => this.get(n.slice(0, -5))),
    );
  }
  async save(definition: EvalDefinition, revision: number) {
    await mkdir(path.join(this.home, "evals"), {
      recursive: true,
      mode: 0o700,
    });
    const record = evalRecordSchema.parse({ definition, revision });
    await atomicJSON(this.file(definition.evalID), record, 8 * 1024 * 1024);
    return record;
  }
  async delete(evalID: string) {
    await unlink(this.file(evalID));
  }
}
