# Deployment and merge gates

Status: accepted repository decision for issue #87

Decision date: 2026-09-19

## Decision

Pull-request merges must not depend on a successful Vercel preview deployment. The required repository-owned check is `deployability`; Vercel previews remain advisory evidence. The existing `e2e` and `GitGuardian Security Checks` gates remain required. CodeRabbit remains advisory.

Production still deploys only from protected `main` through Vercel. This decision changes the merge gate, not the production deployment path, production credentials, or the provider's deployment controls.

## What the repository gate proves

The `deployability` workflow is intentionally fast and provider-neutral. It has read-only repository permissions, uses no secrets, calls no Vercel API or CLI, and validates that:

- the static application, lockfile, package manifest, and deployment manifest exist;
- the package and CI agree on the supported Node.js 24 runtime;
- every grouped API rewrite targets a checked-in handler;
- the SPA fallback is last, so it cannot shadow API routes;
- API cache-safety and minimum-safe browser security-header values remain intact; and
- every scheduled job has a valid five-field schedule and a matching route.

It also pins the five-minute outbox worker and its secret-free hourly watchdog:
the worker retains its protected two-minute deadline, while the watchdog keeps
read-only GitHub permissions, fixed time/page bounds, and no production access.

The unit suite exercises fail-closed cases and runs the command with an unreachable HTTPS proxy, an unusable provider token, and a simulated exhausted-quota marker. That proves this gate does not consume preview quota or need the preview service to be reachable.

This check does **not** prove that a provider can allocate quota, that protected environment variables are correct, or that the deployed edge returns the expected headers. Preview and production deployment telemetry remain the evidence for those provider-owned properties. Production readiness and health probes continue to fail closed when database or migration state is incomplete.

## Required external settings action

After the first `deployability` check has completed successfully on a pull request, update the GitHub `main` ruleset/branch protection once:

1. add `deployability` to required status checks;
2. keep `e2e` and `GitGuardian Security Checks` required; and
3. remove `Vercel` from required status checks, leaving its PR check enabled but advisory.

Do not forge, rename, or manually override Vercel's status. No repository change can alter GitHub's required-check policy, so an administrator must perform this settings change explicitly.

## Alternatives considered

| Option | Advantages | Costs and risks | Decision |
|---|---|---|---|
| Upgrade Vercel preview capacity | Preserves a deployed preview as a hard gate; minimal workflow change | Merge availability still depends on one vendor and account-level quota; ongoing cost; outages remain blocking | Useful independently, but not the merge-safety control |
| Keep Vercel required and retry later | No policy change | Known quota exhaustion can halt all delivery for a day; unrelated changes queue behind provider capacity | Rejected |
| Make Vercel advisory with no replacement | Fastest operational change | Configuration and route drift could merge without a focused signal | Rejected |
| Require the repository-owned contract; keep previews advisory | Deterministic, fast, auditable, no provider token or quota; catches deploy-manifest drift | Cannot validate provider allocation, environment configuration, or a live edge | Chosen |
| Move previews to another provider | Reduces current Vercel coupling | Migration effort, another provider contract, and the same class of external outage/quota risk | Revisit only if the production platform changes |

## Operating policy

- Treat a failed `deployability`, `e2e`, or security check as a merge blocker.
- Treat a failed Vercel preview as advisory for merge, but investigate it before relying on that preview for product acceptance.
- Treat a failed production deployment as a release incident. Do not promote or announce the release until production health/readiness is green.
- Keep the gate generic. When deployment routes, headers, runtime, or scheduled jobs change, update the manifest and its contract tests in the same pull request.
