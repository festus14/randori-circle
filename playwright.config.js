import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 35000,
  expect: { timeout: 9000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 12000,
    navigationTimeout: 20000,
  },
  webServer: {
    command: 'npm run start:test',
    url: baseURL,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
