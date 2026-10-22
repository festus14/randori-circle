import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PUBLIC_PAGES,
  PUBLIC_PAGE_FILES,
  PUBLIC_PAGE_PATHS,
  publicPageFile,
} from '../../scripts/public-pages.mjs';

// Static privacy policy and terms pages (ID-79). They must be readable while
// signed out, load nothing but same-origin CSS, fonts and the favicon, and
// keep the app's Dojo Indigo tokens.

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const legalCss = read('assets/legal.css');
const pages = Object.fromEntries(Object.entries(PUBLIC_PAGES).map(([path, file]) => [path, read(file)]));
const PAGE_TITLES = { '/privacy': 'Privacy Policy', '/terms': 'Terms of Service' };
const ISSUE_TRACKER = 'https://github.com/festus14/randori-circle/issues';
// The one address the owner chose to publish for private requests (ID-79).
const CONTACT_EMAIL = 'festusomole14@gmail.com';

function declarations(block) {
  const values = new Map();
  for (const match of block.matchAll(/--([a-z0-9-]+):([^;]+);/gu)) values.set(match[1], match[2].trim());
  return values;
}

function cssBlock(source, selectorPattern) {
  const match = source.match(new RegExp(`${selectorPattern}\\{([^}]*)\\}`, 'u'));
  assert.ok(match, `missing CSS block ${selectorPattern}`);
  return declarations(match[1]);
}

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<head>[\s\S]*?<\/head>/u, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ');
}

test('the public page table maps exactly the two clean URLs to root documents', () => {
  assert.deepEqual(PUBLIC_PAGES, { '/privacy': 'privacy.html', '/terms': 'terms.html' });
  assert.deepEqual(PUBLIC_PAGE_PATHS, ['/privacy', '/terms']);
  assert.deepEqual(PUBLIC_PAGE_FILES, ['privacy.html', 'terms.html']);
  assert.ok(Object.isFrozen(PUBLIC_PAGES) && Object.isFrozen(PUBLIC_PAGE_PATHS) && Object.isFrozen(PUBLIC_PAGE_FILES));
  assert.equal(publicPageFile('/privacy'), 'privacy.html');
  assert.equal(publicPageFile('/terms'), 'terms.html');
  for (const pathname of ['/', '/privacy.html', '/privacy/', '/PRIVACY', '/terms?x', '/hasOwnProperty', '/__proto__',
    'privacy', '', null, undefined, 1, {}]) {
    assert.equal(publicPageFile(pathname), null, String(pathname));
  }
});

for (const [path, html] of Object.entries(pages)) {
  const title = PAGE_TITLES[path];
  const name = path.slice(1);

  test(`${path} is a standalone, script-free document with landmarks and one h1`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en-GB">/u);
    assert.match(html, new RegExp(`<title>${title} · Randori Circle</title>`, 'u'));
    assert.match(html, new RegExp(`<body data-public-page="${name}">`, 'u'));
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1/u);
    assert.match(html, /<meta name="color-scheme" content="dark light"\/>/u);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/legal\.css"\/>/u);
    // Not the app shell, and nothing that could call /api/logs or auth.
    assert.doesNotMatch(html, /<script\b/iu);
    assert.doesNotMatch(html, /<style\b|http-equiv="refresh"/iu);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/iu, 'no inline event handlers');
    assert.doesNotMatch(html, /\sstyle\s*=/iu, 'no inline styles (blocked by the page CSP)');
    assert.doesNotMatch(html, /id="appMain"|\/api\//u);
    assert.doesNotMatch(html, /<(?:form|iframe|object|embed|img|video|audio)\b/iu);

    assert.match(html, /<a class="skip-link" href="#main">Skip to main content<\/a>/u);
    assert.equal(html.match(/<header\b/gu)?.length, 1);
    assert.equal(html.match(/<main\b/gu)?.length, 1);
    assert.match(html, /<main id="main" class="legal-main" tabindex="-1">/u);
    assert.equal(html.match(/<footer\b/gu)?.length, 1);
    assert.match(html, /<nav aria-label="Legal">/u);
    assert.equal(html.match(/<h1\b/gu)?.length, 1);
    assert.match(html, new RegExp(`<h1>${title}</h1>`, 'u'));
    assert.match(html, /<p class="legal-updated">Last updated: <time datetime="2026-10-22">22 October 2026<\/time><\/p>/u);
  });

  test(`${path} headings never skip a level and every section id is unique`, () => {
    const levels = [...html.matchAll(/<h([1-6])\b/gu)].map(match => Number(match[1]));
    assert.equal(levels[0], 1);
    for (let index = 1; index < levels.length; index += 1) {
      assert.ok(levels[index] <= levels[index - 1] + 1, `heading h${levels[index]} follows h${levels[index - 1]}`);
    }
    assert.ok(levels.filter(level => level === 2).length >= 5, 'the page is split into sections');
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
    for (const match of html.matchAll(/href="#([^"]+)"/gu)) assert.ok(ids.includes(match[1]), `#${match[1]} exists`);
  });

  test(`${path} links back to the app and to the other legal page`, () => {
    assert.match(html, /<a class="legal-back" href="\/" data-testid="public-page-back">Back to Randori Circle<\/a>/u);
    assert.match(html, /<a class="legal-brand" href="\/">/u);
    assert.match(html, new RegExp(`<a href="${path}" aria-current="page">${title}</a>`, 'u'));
    const other = path === '/privacy' ? '/terms' : '/privacy';
    assert.match(html, new RegExp(`<a href="${other}">${PAGE_TITLES[other]}</a>`, 'u'));
    // Cross-page fragment links must point at real sections of the other page.
    for (const match of html.matchAll(/href="(\/privacy|\/terms)#([^"]+)"/gu)) {
      assert.match(pages[match[1]], new RegExp(`\\sid="${match[2]}"`, 'u'), `${match[1]}#${match[2]} exists`);
    }
  });

  test(`${path} adds a stricter CSP and loads only same-origin resources`, () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"\/>/u)?.[1];
    assert.equal(csp,
      "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'");
    for (const match of html.matchAll(/<(?:link|script|img|source)\b[^>]*\s(?:href|src)="([^"]+)"/gu)) {
      assert.match(match[1], /^\/assets\//u, `${match[1]} is a same-origin asset`);
    }
    // Outbound links are plain navigations; only these hosts are mentioned.
    const hosts = new Set([...html.matchAll(/href="https:\/\/([^/"]+)/gu)].map(match => match[1]));
    for (const host of hosts) {
      assert.ok(['github.com', 'developers.google.com', 'myaccount.google.com', 'ico.org.uk'].includes(host), host);
    }
  });

  test(`${path} publishes only the owner's contact email and keeps the issue tracker as a public option`, () => {
    const emails = new Set(html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) || []);
    assert.deepEqual([...emails], [CONTACT_EMAIL]);
    const mailtos = [...html.matchAll(/href="mailto:([^"]*)"/giu)].map(match => match[1]);
    assert.ok(mailtos.length >= 1);
    for (const target of mailtos) assert.equal(target, CONTACT_EMAIL);
    assert.ok(html.includes(`href="${ISSUE_TRACKER}"`));
    assert.match(visibleText(html), /don’t post personal information there/u);
    assert.match(visibleText(html), /owner of your circle/u);
  });
}

test('the operator and private contact are filled in, with no placeholders left', () => {
  const privacy = pages['/privacy'];
  for (const html of Object.values(pages)) assert.doesNotMatch(html, /CONTACT_EMAIL|CONTROLLER_NAME|owner to add/u);
  assert.match(visibleText(privacy), /Randori Circle is run by Festus Omole, based in the United Kingdom\./u);
  assert.match(privacy, /<h2 id="contact">/u);
  // Privacy and deletion requests and security reports go to the private address.
  const contact = visibleText(privacy.slice(privacy.indexOf('<h2 id="contact">')));
  assert.match(contact, new RegExp(`Email ${CONTACT_EMAIL.replace(/\./gu, '\\.')} ?\\. This is the private way to reach us\\.`, 'u'));
  assert.match(contact, /deleting your account, and for reporting a security problem/u);
  assert.match(visibleText(pages['/terms']), new RegExp(`report it privately to ${CONTACT_EMAIL.replace(/\./gu, '\\.')}`, 'u'));
});

test('the privacy policy carries the Google API Services User Data Policy disclosure', () => {
  const text = visibleText(pages['/privacy']);
  assert.match(pages['/privacy'],
    /href="https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy">Google API Services User Data Policy<\/a>/u);
  assert.match(text, /use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy , including the Limited Use requirements/u);
  assert.match(text, /openid email profile/u);
  assert.match(text, /not sold/u);
  assert.match(text, /not used for advertising/u);
});

test('the privacy policy states the retention gaps and providers the code really has', () => {
  const text = visibleText(pages['/privacy']);
  for (const phrase of [
    // Outbox and unfinished sign-ups are never purged today.
    /Email records : our email queue keeps a record of each email it sends\. For sign-up, password-reset and pairing emails this includes the recipient’s email address; for invitations it is an encrypted copy\. These records are not deleted automatically at the moment/u,
    /Unfinished sign-ups : if you start signing up with a password but don’t confirm your email, we keep your email address, name and password hash\. They are not deleted automatically at the moment/u,
    /The encrypted copy is kept with our email records/u,
    /our email queue also keeps an encrypted copy so it can send or retry the email/u,
    // Sentry's loader reaches every visitor; tracing and replay are off in code.
    /your browser downloads Sentry’s error-reporting script from Sentry’s servers/u,
    /GitHub hosts our code and public issue tracker and runs our scheduled maintenance jobs/u,
    /you are signed out only if it was your last active circle/u,
    /who is paired with whom each week/u,
    // Circle health (ID-78): aggregate counts only, and the all-or-none caveat.
    /a count of all pairs or none does show what every pair did/u,
    /Pair counts are hidden in weeks with fewer than four pairs and whenever they could point to a single pair/u,
    // Practice suggestions (ID-77): attempted marks only, and the room-privacy line admits it.
    /your current partner sees which exercises you have attempted before .* shown only as an “attempted” mark, never your code, scores or dates/u,
    /Your sessions stay private to the two of you, except that practice suggestions/u,
    /Exercises you hide from suggestions are remembered only in your browser/u,
    // Sentry breadcrumbs.
    /a short trail of what happened just before it \(such as pages opened, buttons pressed and the addresses of requests the app made\)/u,
    /your browser’s session storage briefly keeps a reference to it/u,
    /They can’t delete accounts themselves, but can remove you from the circle and pass your request on\./u,
  ]) {
    assert.match(text, phrase);
  }
  assert.doesNotMatch(text, /no third-party trackers|stores secret links only as hashes|including the recipient’s address, while the account exists/u);
});

test('the terms cover the required topics in plain language', () => {
  const text = visibleText(pages['/terms']);
  for (const phrase of [/free community tool for practising coding interviews/u, /“as is”/u, /without any warranty/u,
    /Abuse the code runner/u, /Harass anyone/u, /access other people’s data/u, /Disrupt the service/u,
    /owner can remove a member/u, /update the “Last updated” date/u, /law of England and Wales/u,
    /You must be at least 16 to use Randori Circle\./u, /bring a claim in the courts where you live/u]) {
    assert.match(text, phrase);
  }
});

test('legal.css copies the Dojo Indigo tokens from index.html without drift', () => {
  const appDark = cssBlock(indexHtml, ':root');
  const appLight = cssBlock(indexHtml, ':root\\.light');
  const legalDark = cssBlock(legalCss, ':root');
  const legalLight = cssBlock(legalCss, '@media \\(prefers-color-scheme: light\\)\\{\\s*:root');
  assert.ok(legalDark.size >= 30 && legalLight.size >= 9);
  for (const [token, value] of legalDark) assert.equal(value, appDark.get(token), `--${token} (dark)`);
  for (const [token, value] of legalLight) {
    assert.equal(value, appLight.get(token), `--${token} (light)`);
    assert.ok(legalDark.has(token), `--${token} has a dark value too`);
  }
  // Every colour token the light scheme overrides must exist in the app's light theme.
  for (const token of legalDark.keys()) {
    if (token.startsWith('color-')) assert.ok(legalLight.has(token), `--${token} follows the light scheme`);
  }
  // Colours come only from tokens; the stylesheet never hard-codes one outside the token blocks.
  const rules = legalCss.replace(/:root\{[^}]*\}/gu, '').replace(/@font-face\{[^}]*\}/gu, '');
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgb\(/iu);
  assert.match(legalCss, /src:url\("\/assets\/fonts\/geist-sans-latin-var\.woff2"\) format\("woff2"\)/u);
  assert.doesNotMatch(legalCss, /https?:\/\//u);
});

test('the signed-out landing links the full privacy policy and terms; members get them in the account menu', () => {
  assert.match(indexHtml,
    /<a id="landingPrivacyPolicyLink" href="\/privacy" data-testid="landing-privacy-policy-link">Privacy Policy<\/a>/u);
  assert.match(indexHtml, /<a id="landingTermsLink" href="\/terms" data-testid="landing-terms-link">Terms of Service<\/a>/u);
  const note = indexHtml.match(/<details id="landingPrivacy" class="landing-privacy">([\s\S]*?)<\/details>/u)?.[1];
  assert.ok(note, 'the in-page privacy note stays');
  assert.match(note, /<a href="\/privacy">Privacy Policy<\/a>/u);
  assert.match(note, /Randori Circle is a private practice space run by Festus Omole; circle owners decide who joins\./u);
  const menu = indexHtml.match(/<div id="meMenu" role="menu"[^>]*>([\s\S]*?)\n {8}<\/div>/u)?.[1];
  assert.ok(menu, 'account menu');
  // New tab, so following them never drops a live call or room.
  assert.match(menu, /<a id="mePrivacy" role="menuitem" class="account-menu-item account-menu-item--legal" tabindex="-1" href="\/privacy" target="_blank" rel="noopener">Privacy Policy<\/a>/u);
  assert.match(menu, /<a id="meTerms" role="menuitem" class="account-menu-item account-menu-item--legal" tabindex="-1" href="\/terms" target="_blank" rel="noopener">Terms of Service<\/a>/u);
  // The account actions keep their order ahead of the legal links.
  const order = [...menu.matchAll(/id="(me[A-Za-z]+)"/gu)].map(match => match[1]);
  assert.deepEqual(order, ['meIdentity', 'meProfile', 'meSetupGuide', 'meSignOut', 'meSignOutAll', 'mePrivacy', 'meTerms']);
});

test('the sign-up dialog links the Terms and Privacy Policy only while signing up', () => {
  const line = indexHtml.match(/<p id="authLegal" class="small muted auth-legal" hidden>([\s\S]*?)<\/p>/u)?.[1];
  assert.ok(line, 'sign-up legal line');
  assert.match(line, /<a href="\/terms" target="_blank" rel="noopener">Terms of Service<\/a>/u);
  assert.match(line, /<a href="\/privacy" target="_blank" rel="noopener">Privacy Policy<\/a>/u);
  // It sits inside the auth form, before the submit buttons, and the dialog render shows it only in sign-up mode.
  const form = indexHtml.match(/<form id="authForm"[\s\S]*?<\/form>/u)?.[0] || '';
  assert.ok(form.indexOf('id="authLegal"') > 0 && form.indexOf('id="authLegal"') < form.indexOf('id="authSignup"'));
  assert.match(indexHtml, /const legal=document\.getElementById\('authLegal'\);\n\s*if\(legal\) legal\.hidden=authMode!=='signup'\|\|pending;/u);
  for (const id of ['authSignup', 'authSignin', 'authGoogle', 'authNameField', 'authModeSwitch']) {
    assert.match(form, new RegExp(`id="${id}"`, 'u'), `${id} is kept`);
  }
});

test('the privacy policy describes self-service account deletion only where it is switched on (issue #339)', () => {
  const text = visibleText(pages['/privacy']);
  assert.match(text, /Where account deletion is switched on, open Edit profile from the account menu and choose Delete account/u);
  assert.match(text, /your name shown as “Deleted member”/u);
  assert.match(text, /If the option isn’t switched on, or you can no longer sign in, email/u);
  assert.doesNotMatch(text, /There isn’t a delete button yet/u);
});
