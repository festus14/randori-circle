# Domain and DNS

Redirects, certificates, or sender-domain verification for
`randoricircle.com` are wrong. The descriptive layer is
[SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §3.1 (routing, rewrites and
redirects); the canonical-domain switch is §12 of the
[production bootstrap guide](../PRODUCTION_BOOTSTRAP_GUIDE.md).

The repo holds no DNS record values. The source of truth for each
surface is its own console: Vercel Domains for the web domains,
Google Cloud for OAuth domains, Resend Domains for mail records.
Never copy a DNS record value out of a doc or an old screenshot —
read the exact record the provider shows today.

## Symptoms

- `https://randoricircle.com` does not load, or a subdomain does not
  resolve.
- `www.randoricircle.com` does not redirect to the apex, or an old
  link lands on the wrong host.
- The browser reports a certificate error.
- Resend shows the sender domain as not Verified, or mail
  dead-letters with `domain_not_verified`.

## Confirm (read-only)

Run these from your own network (not from behind a proxy that rewrites
responses):

```bash
# Web redirects: www is a permanent redirect, the old alias a
# temporary one for page paths only; /api/* on the old alias still
# serves directly, with no redirect.
curl -sI 'https://www.randoricircle.com/invite?x=1'
# Expect: 308 to https://randoricircle.com/invite?x=1
curl -sI 'https://randori-circle-self.vercel.app/invite?x=1'
# Expect: 307 to https://randoricircle.com/invite?x=1
curl -sI 'https://randori-circle-self.vercel.app/api/health/live'
# Expect: 200, no redirect (liveness, so a database outage is not
# reported as an alias-routing failure).

# DNS: compare against what Vercel Domains and Resend Domains show.
dig +short randoricircle.com A
dig +short www.randoricircle.com CNAME

# Mail records: Resend Domains shows the exact DKIM, SPF, and DMARC
# records to publish for the sender domain. Query the record names
# Resend shows, e.g.:
dig +short TXT <selector>._domainkey.<sender-domain>
dig +short TXT <sender-domain>
dig +short TXT _dmarc.<sender-domain>

# Certificate: check the chain, issuer, and expiry for the host the
# browser actually visited.
echo | openssl s_client -connect randoricircle.com:443 -servername randoricircle.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## Fix

- **Sender domain not Verified in Resend:** publish exactly the
  DKIM, SPF, and DMARC records Resend Domains shows for that domain,
  wait for DNS propagation, then re-check in Resend. A wrong or
  stale record value is the usual cause — re-copy from Resend, do
  not edit a remembered value. Until the domain is Verified, use of
  a verified-domain `RESEND_FROM` is what unblocks mail; see
  [email not arriving](email-not-arriving.md).
- **Web domain not resolving or wrong host:** in Vercel Domains,
  confirm `randoricircle.com` and `www.randoricircle.com` are
  attached to the project and DNS points at Vercel. The redirect
  rules themselves live in `vercel.json` — if they changed, that is
  a code fix plus a deploy, not a DNS edit.
- **Certificate error:** Vercel provisions and renews certificates
  for attached domains. Check Vercel Domains for the failing host;
  do not hand-roll a certificate.
- **HSTS:** pages send
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
  so browsers that visited `randoricircle.com` require HTTPS on
  every `*.randoricircle.com` host for a year. Any subdomain added
  later — including an email click-tracking domain — must serve
  HTTPS.

## Verify

Re-run the Confirm commands: Resend shows Verified, `www` returns
308, the old alias page path returns 307, `/api/health/live` on the
old alias returns 200, and `npm run smoke:production` passes.
