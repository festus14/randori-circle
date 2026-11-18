# Execution languages

Status: implemented behind default-off per-language flags; issue #466, epic #460

Owner: Randori Circle maintainers

Last reviewed: 2026-11-18

## Provider contract

JavaScript/Python remain unchanged when both new flags are absent or not literal
`true`. Public catalogue language definitions and workspace selection validation
use the same server-owned enabled/provider-supported list. The browser does not
infer runtime availability from a local toggle. No provider discovery request is
made on page load or per exercise.

| Language | Vercel Sandbox | Self-hosted Piston | New flag |
| --- | --- | --- | --- |
| JavaScript | node:24 | javascript 18.15.0 | none |
| Python | python:3.14 | python 3.10.0 | none |
| TypeScript | node:24, `main.cts`, `--experimental-strip-types` | syntax-stripped JS on javascript 18.15.0 | `EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED` |
| Go | **not supported** on stock images | go 1.16.2, installed offline by the operator | `EXECUTION_LANGUAGE_GO_ENABLED` |

SDK 3.8.0 declares managed Node/Python and other base images, but does not promise
an offline Go compiler in them. No runtime package install, provider network
access, vendored interpreter, mutable toolchain snapshot or dependency on #483
is introduced. A future Vercel Go capability must explicitly add a verified
pristine snapshot/image and its runtime pin before changing this matrix.

The operator must provision the exact Piston runtime packages before enabling
its flags. A missing package fails the smoke and must leave that language dark;
flagging a language is not permission to download a compiler during a run.
The self-hosted service must deny egress, isolate every run, bound output and
CPU/wall time, and discard its run filesystem. Never use the retired public API.

## Harness and private input

The API never evaluates member code. Node 24's `stripTypeScriptTypes` is a
**syntax-only** transformation in the API; the resulting source enters the same
restricted JS VM harness inside the provider sandbox. This lets Piston reuse its
existing JS runtime rather than requiring a second installed TypeScript compiler.
Node v24.22.3 was checked locally: the flag is accepted, annotations/generics/type
aliases strip, and enums fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. No SDK
image documentation promises a different Node patch version.

TypeScript supports erasable types only: no enums, runtime namespaces, parameter
properties, decorators or JSX. Catalogue functions must not use imports/exports,
`require`, stdin or top-level script output; the restricted VM is unchanged.
This is execution, not type checking. Unsupported syntax produces failed cases.

Go uses a submitted `package main` file plus a separate server-owned `main.go`
harness in the **same fresh sandbox**. Standard-library imports are permitted;
no `main` function or external modules. The harness reflects the selected function,
decodes each argument into its declared type, invokes it and JSON-encodes its one
return value. Variadic functions/multiple returns, decoding errors, panics and
non-JSON returns fail that case. A compile error or killed run leaves cases
without results, hence failed. Return empty slices rather than nil when `[]` is
expected; nil encodes as JSON null. Struct fields must be exported with JSON tags.

Generic Go starters use `interface{}`: numbers decode as `float64`, arrays as
`[]interface{}`, objects as `map[string]interface{}`, null as nil. Members may
replace generic argument/result types with corresponding typed slices/structs.

TypeScript private stdin retains ID-94: a second fresh sandbox/script, exact
20,000-byte UTF-8 input limit, separate private response, no durable input/output,
existing 60-second UI expiry and same account lease. **Go private stdin is not
supported:** the controls hide/clear on language switch and the API rejects any
Go `stdin` with a clear message before leases/provider calls. Go catalogue runs
remain one execution. Provider-owned private command-log retention must still be
reviewed before enabling `EXECUTION_STDIN_ENABLED`.

All languages share the 256 KiB provider response/output cap, normalizer, eight
server-owned cases, attestation, acknowledged code-document versions and verified
run-feed projection. Expected outputs/oracles never enter a provider harness or
browser projection. Go compilation gets 10 seconds, run wall/CPU 10 seconds and
request 22 seconds; legacy deadlines/payloads stay unchanged. Vercel cleanup,
deny-all policy, session timeout and per-case JS VM timeout stay unchanged.

## Catalogue authoring and provenance

`api/_catalog-languages.js` derives portable TypeScript/Go function signatures and
minimal starters from the **reviewed canonical JavaScript signature**. It adds
runtime metadata, not exercise statements, examples, constraints, versions or
case semantics. All 27 active exercises (including all eight interview-kit
exercises) get both adapters. The canonical catalogue and provenance JSON files
are byte-for-byte unchanged: their existing language definitions and hashes are
not rewritten, ignored or filtered during hash validation.

Keep JS parameter/entrypoint names portable ASCII identifiers. The validator
checks every derived signature/starter even while flags are off. Bespoke new
language starter content or changed question semantics must instead follow
[versioned provenance review](CATALOG_PROVENANCE.md); do not use this adapter to
exclude authored content from the canonical hash.

`npm run validate:catalog` checks TypeScript starters and all eight kit references
against generated cases and public examples in the production harness. Existing
independent Python/small-input oracle checks remain. Independently authored Go
references cover all eight kits plus Focus Block Roll-up, Balanced Template
Markers and Capacity Upgrade Index in `scripts/catalog-go-references.mjs`.
With an already-installed Go toolchain the validator compiles/runs those exact
harnesses offline (`GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`). It otherwise
prints an explicit Go skip; `CATALOG_REQUIRE_GO=true` makes absence a hard failure.
The required Ubuntu CI catalogue job sets this flag. No compiler was installed
or provider contacted on the implementation box, which has no Go toolchain.

## Smoke budgets and rollout

The protected `execution-smoke` route runs one trivial program per enabled,
provider-supported language. Its **existing** atomic claim, 30-minute spacing,
schedule slot per 20 hours and deploy slot per 24 hours are unchanged. At most
four languages run concurrently. Default cost remains two runs per claim;
TypeScript adds one Vercel creation (three total); Piston with both additions
performs four runs. Disabled/unsupported languages cost zero. A new language
missing from an old cached result is `result_missing`, never a passing cache.
The workflow assessor validates/fails on every advertised language, not only JS/PY.

The opt-in CLI keeps its existing maximum of five creations per invocation:
unset `EXECUTION_SMOKE_LANGUAGE` runs the old JS/PY good+broken references and
Vercel egress probe. Select `typescript` or `go` to run that language's good and
broken references instead (two runs plus one egress probe on Vercel, two on
Piston). The selector refuses disabled/unsupported targets. It is never in tests.

1. Merge/deploy with both flags off. Verify the normal JS/PY journey and gates.
2. In the controlled canary deployment, enable **one** supported language flag.
   For Piston first verify the exact installed runtime and isolation/egress policy.
3. Run the existing execution-smoke workflow against that deployment under the
   approved operator setup. Require the new language's actual `status=ok`, not
   `throttled`, and use the targeted CLI reference canary plus editor → sandbox
   → verified-summary/feed journey. Stay within claim windows; no force bypass.
4. Only then enable the corresponding production flag and redeploy. Require the
   next permitted real production workflow run to pass for that language.
5. Repeat independently for the other language. Go remains unavailable on Vercel.

No provider calls or rollout were performed by this branch. Rollback is to unset
that language flag and redeploy: the public definitions/selector disappear and
new requests fail closed; drafts, historical signed runs and schema stay intact.
No database migration, destructive cleanup, new npm dependency or initial Monaco
language bundle is needed. The same-origin selector module loads only when the
server advertises an addition; existing Monaco TypeScript/Go modes are reused.
A server-pinned language arriving before the lazy catalogue is restored silently,
without replacing its code or dispatching an edit. Before turning a live language
off, interview owners should switch active rooms to an enabled language; existing
Go documents still participate in retention after the flag is off.

## Provider-free verification

Use Node 24 on PATH, focused tests with at most four workers, and no credentials:

```sh
node --experimental-test-module-mocks --test --test-concurrency=4 tests/unit/execution-languages.test.mjs
npm run validate:catalog
npx playwright test tests/e2e/execution-languages.spec.ts --project=chromium --workers=4
```

Tests cover literal flags, provider gating, native stripping, Go file generation,
compile/run failures, caps, normalization, attestation persistence, private stdin,
cache rollout failure and the mocked TypeScript editor/verified-summary journey.
Go semantic execution is checked only where a local compiler already exists;
mocked provider results are not represented as proof of compiled Go correctness.
