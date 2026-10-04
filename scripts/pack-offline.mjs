import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineBundle } from "./offline-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(
  process.argv[2] ?? resolve(root, "release/offline-0.1.0"),
);
if (existsSync(destination))
  throw new Error(`Offline bundle destination already exists: ${destination}`);
mkdirSync(dirname(destination), { recursive: true });
const staging = mkdtempSync(join(dirname(destination), ".pipe-ls-bundle-"));
try {
  createOfflineBundle(root, staging);
  renameSync(staging, destination);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
process.stdout.write(`Offline CLI bundle created at ${destination}\n`);
