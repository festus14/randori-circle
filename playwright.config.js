/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default {
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 7000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open:'never' }]],
  use: {
    baseURL: process.env.E2E_BASE || 'https://randori-circle-self.vercel.app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
};
