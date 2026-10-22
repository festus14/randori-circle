// The canonical production origin and the host redirects that move traffic
// to it (ID-80). One source for vercel.json's contract check, the production
// smoke check, operator tools and tests.
//
// - The canonical origin is the only one that matches APP_URL, so it is the
//   only host where Google sign-in works and the only one the browser Sentry
//   gate treats as production (index.html keeps a literal copy).
// - www is a permanent alias of the apex.
// - The old Vercel alias redirects page paths temporarily (a rollback must not
//   be pinned in browser caches) and keeps serving /api/* so cron-job.org,
//   GitHub workflows and in-flight API calls keep working during the move.
export const CANONICAL_ORIGIN = 'https://randoricircle.com';
export const WWW_ORIGIN = 'https://www.randoricircle.com';
export const LEGACY_ORIGIN = 'https://randori-circle-self.vercel.app';

// A string `has` value is a regular expression (Vercel's schema), matched
// against the whole hostname. Escaping the dots makes it match exactly one host.
export function hostPattern(origin) {
  return new URL(origin).hostname.replaceAll('.', '\\.');
}

// The exact vercel.json `redirects` array. Vercel compiles it after the
// cleanUrls redirects and before headers, the filesystem and every rewrite,
// including the SPA fallback. Preview and deployment hosts
// (*-festus14s-projects.vercel.app) never match the host patterns.
// `/:path(.*)` rather than `/:path*`: Vercel compiles `/:path*` strictly, so it
// would not match `/` and the bare www host would not redirect.
export const CANONICAL_DOMAIN_REDIRECTS = Object.freeze([
  Object.freeze({
    source: '/:path(.*)',
    has: Object.freeze([Object.freeze({ type: 'host', value: hostPattern(WWW_ORIGIN) })]),
    destination: `${CANONICAL_ORIGIN}/:path`,
    permanent: true,
  }),
  Object.freeze({
    source: '/:path((?!api(?:/|$)).*)',
    has: Object.freeze([Object.freeze({ type: 'host', value: hostPattern(LEGACY_ORIGIN) })]),
    destination: `${CANONICAL_ORIGIN}/:path`,
    permanent: false,
  }),
]);
