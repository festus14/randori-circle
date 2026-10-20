// Pure configuration and read-only policy for scripts/ui-screenshots.mjs.
// The screenshot tool drives a real browser and is excluded from unit
// coverage; the option parsing and the request guard that keeps production
// capture read-only live here so they can be unit tested.
import { resolve } from 'node:path';

export const DEFAULT_PROD_URL = 'https://randori-circle-self.vercel.app';

export const VIEWPORTS = Object.freeze({
  mobile: {
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
});

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseOptions(env = process.env) {
  const scope = String(env.UI_SCREENSHOTS_SCOPE || 'all').trim();
  if (!['all', 'public', 'local'].includes(scope)) throw new Error(`invalid UI_SCREENSHOTS_SCOPE: ${scope}`);
  const viewports = String(env.UI_SCREENSHOTS_VIEWPORTS || 'mobile,desktop').split(',')
    .map(item => item.trim()).filter(Boolean);
  for (const name of viewports) if (!Object.hasOwn(VIEWPORTS, name)) throw new Error(`invalid viewport: ${name}`);
  const prodUrl = new URL(String(env.UI_SCREENSHOTS_PROD_URL || DEFAULT_PROD_URL).trim());
  if (prodUrl.protocol !== 'https:') throw new Error('UI_SCREENSHOTS_PROD_URL must be https');
  return {
    scope,
    viewports,
    prodOrigin: prodUrl.origin,
    outDir: resolve(String(env.UI_SCREENSHOTS_OUT || 'ui-screenshots')),
  };
}

// Decides whether a browser request may proceed during public capture. Any
// non-read method is blocked and recorded without its query string, so a
// recorded URL can never carry tokens or form values.
export function readOnlyRequestDecision(method, url) {
  const normalized = String(method || '').toUpperCase();
  if (READ_ONLY_METHODS.has(normalized)) return { allow: true };
  return { allow: false, blocked: { method: normalized, url: String(url || '').split(/[?#]/)[0] } };
}
