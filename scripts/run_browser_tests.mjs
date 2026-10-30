import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "talent-hub-browser-"),
);
const cli = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
let status = 1;
try {
  const child = spawn(
    process.execPath,
    [cli, "test", ...process.argv.slice(2)],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, TALENT_BROWSER_DATA_DIR: directory },
    },
  );
  status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
} finally {
  // Playwright's own webServer teardown finishes before its CLI exits. Only now may data be removed.
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("talent-hub-browser-")
  ) {
    throw new Error("Refusing to clean an unexpected test directory");
  }
  await fs.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
process.exitCode = status;
