### Task 1: Add Idempotent Account Timers

**Files:**
- Modify: `src/accounts/manager.ts`
- Test: `tests/browser-oauth.test.ts`

**Interfaces:**
- Consumes: existing `AccountManager.startAutoRefresh()` and `AccountManager.startStatsLogger()`.
- Produces: idempotent timer methods that return safely when a timer already exists.

- [ ] **Step 1: Make `startAutoRefresh()` idempotent**

In `src/accounts/manager.ts`, replace the start of `startAutoRefresh()` with this guard:

```ts
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error(`[${this.provider}] auto-refresh failed:`, err.message),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error(`[${this.provider}] initial refresh failed:`, err.message),
    );
  }
```

- [ ] **Step 2: Make `startStatsLogger()` idempotent**

In `src/accounts/manager.ts`, replace `startStatsLogger()` with:

```ts
  startStatsLogger(): void {
    if (this.statsTimer) return;
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }
```

- [ ] **Step 3: Run the focused compile check**

Run:

```bash
npm run build
```

Expected: TypeScript build passes.

---

