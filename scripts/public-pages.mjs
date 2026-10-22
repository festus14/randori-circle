// Public, static pages that anyone can read while signed out (ID-79).
//
// Google's OAuth branding page needs a privacy policy and terms of service at
// stable public URLs. Each page is a plain `<name>.html` at the repository
// root. Under `cleanUrls`, Vercel serves it at `/<name>` from the filesystem
// before any rewrite runs, so these paths never reach the SPA fallback and
// never load the app shell. The local dev server, the e2e static server, the
// routing contract test, the deployability check and the production smoke
// check all read this one table so they cannot drift apart.
export const PUBLIC_PAGES = Object.freeze({
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
});

export const PUBLIC_PAGE_PATHS = Object.freeze(Object.keys(PUBLIC_PAGES));
export const PUBLIC_PAGE_FILES = Object.freeze(Object.values(PUBLIC_PAGES));

// Exact clean paths only: `/privacy.html` (which Vercel redirects to the clean
// URL), `/privacy/` and `/Privacy` are not mapped.
export function publicPageFile(pathname) {
  return typeof pathname === 'string' && Object.hasOwn(PUBLIC_PAGES, pathname)
    ? PUBLIC_PAGES[pathname]
    : null;
}
