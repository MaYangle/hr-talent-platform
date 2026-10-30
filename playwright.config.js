import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Corporate proxies must never receive the local acceptance server's requests.
const localBypass = [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",");
process.env.NO_PROXY = localBypass;
process.env.no_proxy = localBypass;

const port = Number(process.env.TALENT_TEST_PORT || 4181);
const directory = path.resolve(process.env.TALENT_BROWSER_DATA_DIR || ".");
if (
  path.dirname(directory) !== path.resolve(os.tmpdir()) ||
  !path.basename(directory).startsWith("talent-hub-browser-")
) {
  throw new Error(
    "Run browser tests with npm run test:web to create an isolated workspace",
  );
}
const python =
  process.env.TALENT_TEST_PYTHON ||
  (process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python");

export default defineConfig({
  testDir: "./tests/web",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  metadata: { workspaceData: directory },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    ...(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE,
          },
        }
      : {}),
  },
  webServer: {
    command: `"${python}" server.py --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      TALENT_DATA_DIR: directory,
      TALENT_SECURE_COOKIE: "0",
      TALENT_ALLOWED_HOSTS: "",
      TALENT_MODEL_API_KEY: "",
    },
  },
});
