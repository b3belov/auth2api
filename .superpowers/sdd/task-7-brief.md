### Task 7: Full Validation

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: completed Tasks 1-6.
- Produces: final confidence that browser OAuth endpoints build and tests pass.

- [ ] **Step 1: Run formatting**

Run:

```bash
npm run prettier
```

Expected: Prettier updates or confirms formatting for `src/**/*.ts` and `tests/**/*.ts`.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm run test -- tests/browser-oauth.test.ts tests/codex.test.ts tests/smoke.test.ts
```

Expected: browser OAuth tests, existing Codex auth tests, and smoke tests pass.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Confirm route surface**

Run:

```bash
rg -n "claude-auth|codex-auth|anthropic-auth" src README.md tests
```

Expected:
- `claude-auth` appears in `src/server.ts`, `README.md`, and tests.
- `codex-auth` appears in `src/server.ts`, `README.md`, and tests.
- `anthropic-auth` appears only in the negative test string, or not at all if the implementer chooses to test the missing route without spelling it in docs/source.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/auth/browser-oauth.ts src/accounts/manager.ts src/server.ts src/index.ts tests/browser-oauth.test.ts README.md
git commit -m "feat(auth): add browser oauth endpoints"
```

Expected: commit succeeds with a Conventional Commits-compliant subject.

---

## Self-Review

- Spec coverage: The plan covers both requested endpoints, excludes `/v1/anthropic-auth`, preserves existing provider token storage, keeps browser navigation header-free, and protects credential minting with loopback-only access.
- Placeholder scan: No placeholder marker text remains.
- Type consistency: Provider ids use the repo's existing `anthropic` and `codex` ids while public routes use `claude-auth` and `codex-auth`.
- Risk notes: The tests use fixed OAuth callback ports `54545` and `1455`, matching production behavior. If a local developer already has those ports in use, the relevant tests fail clearly with `EADDRINUSE`, which mirrors the real runtime constraint.

## Hardening Coverage

- Logical gaps: First-run startup is now testable through an exported `startServer()` instead of only described in prose.
- Technical gaps: The callback server must be listening before redirecting the browser, and every terminal callback outcome clears the listener and in-flight state.
- Simplification and reusability: The plan keeps one provider-agnostic browser OAuth helper and exactly two public routes; no alias or wrapper route is introduced.
- UX: Success and failure browser pages are explicit, and README copy gives the two visitable local URLs.
- Performance: The auth flow is not a hot path; one in-flight login per provider and idempotent timers prevent resource buildup.
- Security: Browser auth remains header-free for navigation, but loopback authorization is based on `req.socket.remoteAddress`, not spoofable forwarding headers.
- Bugs: The plan covers state mismatch, malformed callback, duplicate login, callback bind failure, and auth URL build failure paths.
- Misconfigurations: Startup output lists the new routes, temp-config startup is tested with zero accounts, and route-surface checks prevent `/v1/anthropic-auth` from landing.
