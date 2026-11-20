---
name: hackerone-rules
role: strategist
description: Use when evaluating vulnerability reportability, HackerOne Same-Root-Cause duplicate risks, Signal math, or drafting HackerOne submissions.
---

# HackerOne Triage Rules, Root-Cause Deduplication & Submission Strategy

Core operational rules for the PurpleLight Strategist when selecting vulnerability hypotheses (`Insights`), prioritizing findings for submission, managing HackerOne Signal/Trial limits, and drafting reports.

## 1. The "Same Root Cause = Duplicate" Rule (Critical Anti-Duplicate Filter)

HackerOne's Platform Standards enforce **Root-Cause Consolidation**: multiple attack vectors, parameters, or fields that stem from the **same underlying code defect** and would be remediated by **a single reasonable architectural fix** are closed as `Duplicate` of the original report (or an internal vendor umbrella ticket).

### High-Risk "Same Root Cause" Traps (Deprioritize or Scrutinize Heavily)
1. **Intra-Function Sibling Field Omissions**:
   - *Real Battle Lesson (`better-auth` `POST /admin/update-user`)*: When a vendor recently patched `phoneNumber` inside `adminUpdateUser` using hand-enumerated `if` checks while still passing `ctx.body.data` raw to `internalAdapter.updateUser`, reporting `twoFactorEnabled` or `stripeCustomerId` in that **exact same function** was marked `Duplicate` — because triagers treat "missing field allowlist / `input:false` enforcement on `adminUpdateUser`" as the **single shared root cause** of the `phoneNumber` report!
   - *Rule*: Never assume an unguarded sibling field in the exact same handler/sink is an independent bounty if that handler already had a recent field-guard CVE — unless the vendor explicitly adopted a full allowlist and made a distinct logic error inside the new field's dedicated validator.
2. **Trivial Regex / Encoding Tweaks on Freshly Patched CVEs**:
   - Single-CVE patch bypasses (e.g., testing `/%2F` right after a mid-path `%2F` advisory) suffer from extreme **information symmetry** (dozens of hunters read the same GHSA diff within hours) and risk either private-ticket collision (2–3 day blind spot) or being folded into an still-open remediation ticket.

### High-Acceptance "Distinct Root Cause" Targets (Top Priority for Insights)
1. **Cross-Package / Cross-Adapter / Cross-Service Symmetry Mismatches**:
   - Example: Auditing 11 sibling adapters in `@ai-sdk/harness` and finding that `@ai-sdk/harness-opencode` lacks loopback authentication and parks unmatched calls in `pendingRequests` (separate package, separate codebase file, separate remediation PR from `ACP` or `Codex`).
   - Example: Comparing 5 URL-accepting microservices across a cloud platform and finding `/v1/webhooks` runs a standalone legacy URL validator that misses IPv6-mapped private literals `[::ffff:169.254.169.254]`.
2. **Cross-Component Confused Deputy & Protocol Composition Chains**:
   - Combining two distinct components whose trust assumptions mismatch (e.g., an egress proxy minting OIDC tokens for attacker-chosen `aud` URLs + an official SDK proxy helper verifying `aud` signature without checking tenant `team_id`).
3. **Newly In-Scope Assets & Uncharted Control Planes (0 Prior Advisories)**:
   - Repositories or cloud products added to scope within the last 30–90 days where no prior umbrella refactoring ticket exists.
4. **When Reporting a Genuine Patch Bypass**:
   - Verify the prior CVE is **fully closed and published**, and confirm your payload breaks **newly introduced logic in the patch commit itself** (not an untouched sibling parameter). Open the `Summary` by explicitly contrasting the patched code line against the distinct new flaw.

## 2. HackerOne Signal Math & Trial-Quota Unlocking

| Resolution Outcome | Signal / Reputation Points | Notes |
| :--- | :---: | :--- |
| **`Triaged` / `Resolved`** | **`+7`** | Awarded **immediately upon `Triaged`** (no need to wait for patch release). |
| **`Duplicate` (of Valid Undisclosed Report)** | **`+2`** | Awarded once the original parent report reaches `Triaged`/`Resolved` (`0` if parent was already disclosed or invalid). |
| **`Informative`** | **`0`** | No reputation penalty, **but increments denominator by +1**, diluting Signal average. |
| **`N/A` (Not Applicable)** | **`-5`** (`-2` self-closed) | Heavy penalty; never submit unverified static LLM inferences. |
| **`Spam`** | **`-10`** | Account-threatening penalty. |

- **Trial Rate-Limit Unlock Strategy**:
  - Program trial limits (e.g., max 2 pending/recent submissions when `Signal < 1.0`) check **global HackerOne Signal**, not per-program score.
  - If trial slots on a primary target are occupied or blocked by duplicates, pivot to a **fast-triaging program without a trial wall** to land 1–2 quick `Triaged (+7)` reports; once global `Signal >= 1.0`, trial restrictions lift across **all** HackerOne programs immediately.

## 3. High-Velocity Concise Report Standard

1. **Minimalist Structure (Zero Boilerplate)**:
   - **Title**: Component + Exact Flaw + Concrete Security Impact + Affected Version (`<= X.Y.Z`).
   - **Summary**: One tight paragraph explaining the trust boundary, why it fails, and what an attacker achieves.
   - **Steps to reproduce**: Interleave screenshots **one-by-one right under each step** (`Step 1` + `[SCREENSHOT 1]` -> `Step 2` + `[SCREENSHOT 2]`). Include:
     1. Baseline (normal behavior),
     2. Non-duplication control (if related to a prior CVE, show the old CVE payload is blocked),
     3. Attack & observable impact.
   - **Impact**: Crisp bullet points; cite upstream maintainer PRs/Issues when helpful to preempt `"By Design"` pushback; state preconditions honestly.
   - **Suggested fix**: 2–3 actionable engineering bullets.
   - **NEVER include**: bloated `Root cause` essays repeating the Summary, `Compliance` disclaimers, or a wall of uncaptioned screenshots dumped at the bottom.
2. **"Submit First, Video Second" Velocity Rule**:
   - On competitive programs, as soon as local reproduction, the self-contained `.zip` PoC, and 5-way GitHub duplicate checks (`npm latest`, `main` HEAD, GHSAs, Issues, PRs) pass, submit immediately to lock timestamp priority, then upload the screen-recording MP4 as a follow-up comment.
