// Playwright e2e config: serves services/web statically. Project 'chromium' uses the mock engine
// (?mock=1); project 'real-engine' drives the real WebAssembly build.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEB_TEST_PORT || 8765);

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [
    // UI behaviour against the mock engine (fast, no wasm build needed).
    { name: 'chromium', testDir: './tests/e2e', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
    // Integration against the real C++/WebAssembly engine.
    { name: 'real-engine', testDir: './tests/e2e-real', timeout: 60_000, use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
