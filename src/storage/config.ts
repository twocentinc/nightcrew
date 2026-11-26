import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { checkpoint } from "../engine/execution/process.js";
import { NightcrewError } from "../engine/protocol.js";
import {
  storeSchema,
  validateConfig,
  type Config,
  type Store,
} from "../schemas/config.js";
import { atomicJSON, claimJSON, readJSON } from "./files.js";

export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function initializeHome(
  home: string,
  settings: Omit<
    Config,
    "revision" | "rootTokenHash" | "interactionCooldownMs"
  > & { interactionCooldownMs?: number },
) {
  checkpoint();
  if (!path.isAbsolute(home)) throw Error("Runtime home must be absolute");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const stat = await lstat(home);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new NightcrewError(
      "config.invalidHome",
      "Runtime home must be owner-only",
      3,
    );
  const token = randomBytes(32).toString("base64url");
  const store = storeSchema.parse({
    version: 5,
    config: {
      interactionCooldownMs: 300000,
      ...settings,
      revision: 1,
      rootTokenHash: tokenHash(token),
    },
    agents: [],
    cooldownUntil: null,
  });
  validateConfig(store);
  await claimJSON(path.join(home, "config.json"), store, 8 * 1024 * 1024);
  return { token };
}
/** Configuration I/O; callers retain the shared Storage transaction. */
export class ConfigStore {
  store!: Store;
  constructor(private readonly home: string) {}
  async load() {
    this.store = await readJSON(
      path.join(this.home, "config.json"),
      storeSchema,
      8 * 1024 * 1024,
    );
    validateConfig(this.store);
  }
  async save(next: Store) {
    storeSchema.parse(next);
    validateConfig(next);
    await atomicJSON(
      path.join(this.home, "config.json"),
      next,
      8 * 1024 * 1024,
    );
    this.store = next;
  }
}

export function verifyBearerToken(
  header: string | undefined,
  expectedHash: string,
) {
  return (
    !!header?.startsWith("Bearer ") &&
    timingSafeEqual(
      Buffer.from(tokenHash(header.slice(7)), "hex"),
      Buffer.from(expectedHash, "hex"),
    )
  );
}
