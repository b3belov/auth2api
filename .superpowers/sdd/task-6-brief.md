### Task 6: Update README Login Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: existing Login and Starting the server sections.
- Produces: documented browser login URLs with no Anthropic alias.

- [ ] **Step 1: Add browser-login docs in the Login section**

After the provider list and before "Auto mode", add:

````md
### Browser mode from the running server

When the server is running locally, you can start OAuth from a normal browser page:

```bash
# Claude
open http://127.0.0.1:8317/v1/claude-auth

# Codex / ChatGPT
open http://127.0.0.1:8317/v1/codex-auth
```

These routes are localhost-only and do not require an API key because they start an interactive browser login. Successful login writes the same token files as the CLI flow (`claude-<email>.json` or `codex-<email>.json`) and updates the running server immediately.
````

- [ ] **Step 2: Update the endpoint list**

In the endpoint list near the existing `/admin/reload` row, add:

```md
| `GET /v1/claude-auth`       | Start Claude OAuth login from a local browser |
| `GET /v1/codex-auth`        | Start Codex OAuth login from a local browser  |
```

- [ ] **Step 3: Verify no alias docs exist**

Run:

```bash
rg -n "anthropic-auth" README.md src
```

Expected: no output.

---

