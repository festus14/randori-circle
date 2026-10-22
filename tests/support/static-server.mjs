import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicPageFile } from '../../scripts/public-pages.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = Number(process.env.E2E_PORT || 4173);
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

// Exported for the routing contract test: every path served here as the app
// shell must also be served by vercel.json in production.
export function isStaticAppRoute(pathname) {
  return pathname === '/' || pathname === '/invite' || pathname === '/verify'
    || pathname === '/reset-password' || pathname.startsWith('/join/');
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');

  // Browser tests mock application APIs explicitly. An unexpected API call must
  // be visible instead of escaping to a deployed environment.
  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 503, { ok: false, error: 'API not configured in local static test server' });
    return;
  }

  // Public pages (/privacy, /terms) are their own static documents, as on Vercel.
  const requested = isStaticAppRoute(url.pathname)
    ? 'index.html'
    : publicPageFile(url.pathname) ?? decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = resolve(root, requested);

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local test server listening on http://127.0.0.1:${port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
