import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
const baseURL = `http://127.0.0.1:${port}`;

// index.html loads the production Sentry loader. In browser tests that SDK
// would report CI sessions to production and, worse, its iframe-based
// native-timer probing races Playwright's fake clock injection: in roughly
// one run in ten, page.clock.fastForward() stops reaching the clock that owns
// the app's timers, so fake-clock tests (e.g. invite expiry) wait on real
// time and fail. Make the telemetry hosts unresolvable for every context.
// page.route() still intercepts first, so tests that substitute the loader
// with a probe keep working.
const telemetryHostResolverRules = [
  'MAP js-de.sentry-cdn.com ~NOTFOUND',
  'MAP browser.sentry-cdn.com ~NOTFOUND',
  'MAP *.sentry.io ~NOTFOUND',
].join(', ');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 35000,
  expect: { timeout: 9000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Real-runtime journeys each own a private server and database, so they
  // parallelize safely; the hosted Linux runner has four vCPUs.
  workers: process.env.CI ? 3 : undefined,
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
    launchOptions: { args: [`--host-resolver-rules=${telemetryHostResolverRules}`] },
    // index.html sets `html{scroll-behavior:smooth}` (off under reduced
    // motion), so focusing an off-screen field (fill) starts an animated
    // scroll. On a busy page the animation can begin after Playwright's
    // stability check for the next click, so mousedown/mouseup land while the
    // target is still moving and the click is silently lost (schedule-sync:
    // the trace shows the page mid-scroll across the Propose click, and no
    // POST). Reduced motion makes every scroll instant and CSS transitions
    // ~0 ms for all contexts, including browser.newContext().
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'npm run start:test',
    url: baseURL,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
