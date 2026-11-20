---
name: recon-and-poc-ops
role: scout
description: Use when auditing npm/OSS packages offline, running non-blocking local demo servers, checking GitHub duplicates, or building interactive HTML PoCs.
---

# Scout Recon, Local PoC & Pre-Submission Duplicate Check SOP

## 1. Zero-Traffic Offline SDK / Package Unpacking
To inspect published `npm` artifacts (`dist/` + `package.json`) without heavy `git clone` or production traffic:
```bash
cd "$SCOUT_WORKSPACE"
npm pack <pkg>@latest
tar -xzf *.tgz
# Published code is now under ./package/
```

## 2. Non-Blocking Background Server Launch (Preventing Pipe Hangs)
Never run `node server.mjs &` with inherited stdio handles inside `bash` — open child stdout/stderr descriptors block the tool runner until timeout. Always close stdin and redirect stdout/stderr to files inside `$SCOUT_WORKSPACE`:
```bash
cd "$SCOUT_WORKSPACE"
nohup node server.mjs < /dev/null > "$SCOUT_WORKSPACE/server.log" 2>&1 &
echo $! > "$SCOUT_WORKSPACE/server.pid"
sleep 1
curl -sS --max-time 5 http://127.0.0.1:<PORT>/health
```
Always stop temporary servers via `kill "$(cat "$SCOUT_WORKSPACE/server.pid")"` when testing completes (unless explicitly instructed to leave a public demo port running for user screen recording).

## 3. Five-Way Pre-Submission GitHub Duplicate Check
Before packaging a white-box vulnerability for submission, verify all 5 public channels via GitHub API / git:
1. **Latest `npm` tarball**: Confirm the flaw reproduces on the exact latest published version (`npm view <pkg> version`).
2. **`main` / `canary` HEAD**: Fetch the target file from `raw.githubusercontent.com/<org>/<repo>/HEAD/<path>` to verify no silent fix landed on `main`.
3. **GitHub Security Advisories**: `curl -sS --max-time 10 "https://api.github.com/repos/<org>/<repo>/security-advisories?per_page=30"`
4. **Open & Closed Issues**: Search repository issues for the vulnerable function/parameter name (also note any maintainer comments confirming the behavior is a security boundary to cite as anti-"by-design" proof!).
5. **Open & Recently Merged PRs**: Search PRs touching the target file path in the last 30 days.

## 4. Single-Page Interactive HTML Button PoC Pattern
For API, auth, or logic vulnerabilities lacking a visual UI, include a minimal local Node HTTP server (`demo-server.mjs`) serving a single-page HTML dashboard with sequential buttons (**1. Baseline -> 2. Patched Control (403) -> 3. Attack (200) -> 4. Post-Attack State**) and live request/response JSON panels so both the operator (for MP4 recording) and triagers can verify impact in 10 seconds.
