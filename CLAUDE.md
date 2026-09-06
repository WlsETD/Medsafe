# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MedSafe — a cross-hospital polypharmacy (drug-drug interaction) warning system built as a **static, no-build-step frontend** (plain HTML + Vue 3 via CDN + Tailwind CDN + ECharts) backed by **Firebase Authentication + Cloud Firestore**, with a real **HAPI FHIR R4** integration for cross-hospital data exchange. Four role-based portals: patient (`patient.html`), doctor (`dashboard.html`), admin (`admin.html`), insurance underwriter (`insurance.html`).

There is no bundler, no transpiler, no npm build. Every `.html` page loads `js/*.js` files directly as global-scope scripts (`window.DbService`, `window.DdiEngine`, `window.FhirClient`, `window.auth`, `window.db`, etc.) — not ES modules on the frontend. `package.json`'s `"type": "module"` and the `tests/*.mjs` files apply only to the Node-based test suite, not the app itself.

**The Firestore security rules (`firestore.rules`) are the single real access-control boundary of this system.** Anyone can download the entire frontend (it's static and public), so every authorization decision must be enforced in rules, not in JS. Treat `firestore.rules` as the most security-critical file in the repo — read its extensive inline comments before touching it; they document *why* each clause exists, including specific vulnerabilities that were found and fixed (referenced as `P0-x`/`P1-x`/`S-x`/`H-x` in comments, from an internal adversarial audit).

## Commands

```bash
npm test              # runs all four suites below, in order
npm run test:catalog  # tests/drug-catalog.test.mjs   — drug identity resolution (pure Node, no emulator)
npm run test:ddi      # tests/ddi-engine.test.mjs      — DDI matching engine (pure Node, no emulator)
npm run test:fhir     # tests/fhir-client.test.mjs     — FHIR client layer (pure Node, no emulator)
npm run test:rules    # tests/firestore-rules.test.mjs — requires `firebase emulators:exec --only firestore`
```

- `test:rules` spins up the Firestore emulator itself (via `firebase emulators:exec`) and reads `firestore.rules` directly from disk — it always tests the exact file that would be deployed. Requires the Firebase CLI to be installed and buildable emulator binaries (Java).
- To run a single test file directly: `node tests/ddi-engine.test.mjs` (these are plain assertion scripts, not a test-runner framework — no `--grep`/filtering support; edit the file or read its output to isolate a case).
- **Any change to `firestore.rules` or to drug/DDI identity logic (`js/drug-catalog.js`, `js/ddi-engine.js`, `js/ddi-rules-ddinter.js`) must be followed by the corresponding test suite before considering the change done.**
- No lint/typecheck config exists in this repo — don't invent one.
- Local run: the app **must** be served over HTTP, not opened via `file://` (Firebase Auth rejects the `file://` origin): `python -m http.server 8000` or `npx serve .`, then visit `http://localhost:8000` → redirects to `login.html`.

## Architecture

### Identity & auth model
- Users log in with a plain `username` + password. The frontend synthesizes a fake email (`username@medsafe.local`, see `toAuthEmail()` in `js/auth.js`) and calls Firebase Auth — Firebase Auth itself is only used as a password/session mechanism, not as the identity source of truth.
- `user_roles/{uid}` in Firestore is the **sole trusted identity index** (role + status + username), keyed by Firebase Auth `uid`. Every other collection's rule derives authorization from this document via `profile()` in `firestore.rules`, never from `localStorage` or client-declared role.
- `js/auth.js`'s `verifyRole()` re-derives the verified identity from Firestore on every page load and only mounts the Vue app after that succeeds (`mountWhenAuthorized`) — there is deliberately no "render UI optimistically, redirect if unauthorized" window.
- Three distinct failure modes are handled differently and must stay distinct when modifying auth code: **denied** (not logged in / disabled account → sign out + wipe local state + redirect to login), **wrong room** (valid session, wrong role for this page → redirect to own home, do NOT sign out or wipe data), and **infra failure** (offline/timeout → show a retryable screen, do NOT sign out or wipe data). Conflating these has previously destroyed unsynced user data on transient network errors.
- `js/firebase-config.js` sets up a **second** Firebase Auth app instance (`window.secondaryAuth`) purely so that admin's "create user" flow doesn't hijack the admin's own logged-in session when calling `createUserWithEmailAndPassword`.
- Firebase config values (`apiKey` etc.) are intentionally public in `js/firebase-config.js` — this is a public-client web app; security is enforced entirely by Firestore rules, not by hiding config.

### Access-control patterns to know before editing `firestore.rules`
- **`{a}__{b}` composite document IDs** are used throughout (`care_relations`, `consents`, `break_glass`) so rules can do O(1) `get()`/`exists()` lookups instead of queries (Security Rules can't query collections, only read known paths). When adding a new relationship-gated collection, follow this pattern rather than introducing a queryable index.
- **Reading a not-yet-existing document** (to decide create-vs-update client-side) needs special-cased `resource == null` handling in the rule, scoped narrowly so existence itself doesn't become an oracle (see `ridNamesMe()` and its long comment for the reasoning about why a naive `resource == null` allow is a leak).
- **`get()` doesn't exist means "not found"**; a bare boolean leak on relationship existence (e.g., "is this patient assigned to this doctor") is treated as a privacy leak in this codebase (reveals the fact of a care relationship) — new rules should preserve that indistinguishability where relevant.
- **Write-once fields** (`fhirPseudonym`, `profile.nationalId`) use a "set once, immutable after" pattern rather than a general-purpose update, to prevent identity/pseudonym reassignment attacks.
- **Accountable/attested fields** (`nationalIdVerifiedBy/At`, `audit_logs.actor`, `patient_summaries.attestedBy`, prescriptions' `safetyCheck`) always require the writer to name themselves as `profile().username` (cross-checked against `token.email` via `ownsUsername()`), and timestamps must equal `request.time` server-side — never client-supplied. When adding a new "who did this / when" field, follow this exact pattern.
- **`get, list` are split** where enumeration would be a privacy escalation even though single-document lookup is fine (`patient_index`: `get` allowed, `list` denied) — don't collapse these back into a single `read` grant.
- **Break-glass / emergency access** (`break_glass` collection) is a deliberate, audited self-authorization escape hatch for doctors with no care relationship (ER scenarios). It requires a named reason (≥10 chars), server-set timestamps, and a 4-hour hard expiry, and records can never be updated/deleted (only superseded by a fresh declaration). This is intentional — do not "fix" it into a stricter/blocking model without understanding the availability-vs-safety tradeoff documented at that rule.
- The rules file records several **previously-shipped vulnerabilities and their fixes inline** (grep for `對抗性稽核`, `曾經的漏洞`, `S-1`, `S-2`, `H-2` through `H-7`, `P0-`, `P1-`). Before changing a rule, read its comment block fully — it usually explains a regression that already happened once.
- Known, deliberate, *undocumented-to-users-but-documented-in-code* limitations of the rules layer (don't try to "fix" these without discussing scope first): no global uniqueness enforcement for `fhirPseudonym` or `nationalId` beyond format; audit logs can't guarantee every action is logged (client must choose to write them); consent/patient_summary data is patient-attested, not system-verified. See `DEPLOY_CHECKLIST.md` §5 for the full list of known tradeoffs and how to explain them.

### DDI (drug-drug interaction) engine
- `js/drug-catalog.js` + `js/ddi-rules-ddinter.js` (data imported from `DDINTER2/*.csv` via `tools/import-ddinter.mjs`) provide drug identity resolution; `js/ddi-engine.js` performs matching by **ATC code**, not by drug-name string equality (name matching was the original bug — cross-hospital name variants like "Warfarin Sodium" vs "Warfarin" didn't match).
- The engine checks **all pairs among existing medications**, not just "new drug vs. existing drugs" — a patient's existing regimen can itself contain an unflagged interaction.
- Severity has a distinct `unknown` rank *below* `minor`, not folded into `moderate` — an interaction from DDInter's `Unknown` severity data must never render or sort as if it were a confirmed moderate/major interaction. Preserve this distinction in any severity-related change.
- "No interaction found" and "cannot be evaluated" (unmapped/compound drug) are different states and must never be collapsed into a single "safe" result — this exact conflation was a fixed audit finding (P0-3/P1-12).

### Prescription safety gate
- `firestore.rules`'s `patient_data` collection enforces that any *newly appended* medication must carry a `safetyCheck` map (`verdict`, `checkedAt`, `by`), and if `verdict == 'risk'`, a named `overrideReason` (≥4 chars) is mandatory. This is enforced at the data layer specifically because a UI-only "must check before prescribing" gate is trivially bypassable by calling the Firestore SDK directly. When touching prescription-writing code paths, preserve this invariant rather than relying on frontend flow control.

### FHIR integration (`js/fhir-client.js`)
- Central `FhirClient` object: 12s timeout via `AbortController` (public HAPI sandbox is often slow/unresponsive), configurable base URL (read from `admin_data` settings, default `https://hapi.fhir.org/baseR4`), HTTPS-only.
- `isUnprotected()` is the flag actual UI warnings key off — it is **not** simply "is this hapi.fhir.org" (that was a fixed bug: warnings disappeared when pointed at a self-hosted-but-still-unauthenticated server). It defaults to "unprotected" unless an admin has explicitly declared `fhirAccessControlled` in settings; that declaration is an operator attestation, not something the client verifies.
- No API key / auth header is sent by design — a pure static frontend cannot hold a secret from its own users; anything stored in `admin_data` is readable by every authenticated user per the rules above. A real protected FHIR backend requires a server-side proxy (explicitly deferred, see file header "Phase 6" notes).
- Patient data sent to the public FHIR sandbox is pseudonymized: random `fhirPseudonym` per patient (not derived from username — a derived/hashed pseudonym would be reversible offline since the algorithm is public and the username space is tiny), blurred birth year (5-year bucket), no real name. This is explicitly documented as pseudonymization, not anonymization (medication + dosage combinations remain quasi-identifying).

### Chat / notifications
- `js/chatStore.js` + `js/notify.js` (localStorage/`storage`-event based) originally held doctor-patient chat entirely client-side; this was migrated to Firestore's `conversations/{patientUsername}/messages` (see rules section and `P1-4` comments) because chat is legally part of the medical record in Taiwan and can't live only in browser storage. Don't reintroduce localStorage as the source of truth for chat content — it's fine only as an ephemeral read/unread-count cache.

### National ID (身分證字號) handling
- `js/utils.js`'s `validateNationalId()` implements the Taiwan national-ID / new resident UI checksum algorithm (2nd digit `1`/`2` for citizens, `8`/`9` for the newer resident UI format — both share the same checksum). It runs client-side only and is deliberately **not** used for duplicate-registration lookups server-side — see the long comment there explaining why building a lookup index of hashed IDs in a public-source frontend is itself a privacy risk (offline rainbow-table feasible in ~69s against the ~52M valid ID space).
- Verification of a national ID (`nationalIdVerifiedBy/At` in `patient_data`) is a separate, staff-only attestation step from the patient's own self-reported entry — see `firestore.rules`'s `verificationIsAccountable()`. Note the documented regression it guards against: naively requiring `nationalIdVerifiedAt == request.time` on every write (not just when the verification fields actually change) made a verified patient's whole record permanently read-only, since any unrelated later write would fail that equality. Any change to write-once/attestation-style rules should consider this "unrelated field touches the same equality check" failure mode.

## Deployment

See `DEPLOY_CHECKLIST.md` for the full pre/post-deploy procedure — it is detailed and encodes real incidents (e.g., `.git/` accidentally served publicly because `**/.*` doesn't match files *inside* a dot-directory; a Cache-Control mismatch between new HTML and cached old JS taking down the whole site after deploy). Key points if asked to deploy:
- `firebase.json`'s `hosting.public` is `.` (repo root) — anything not in the `ignore` list gets uploaded. Never add new sensitive/internal files without also adding them to that `ignore` list.
- `firestore.rules` and the app code are **coupled and must be deployed together**: `firebase deploy --only firestore:rules,hosting`. Deploying only one side silently breaks functionality (old rules reject new collections; new rules reject old code's writes) — see checklist §2 for the exact failure table.
- `tools/delete-user.cjs` is a manual GDPR/account-deletion helper that shells out to `firebase firestore:delete` per known document path; it is not exhaustive (some collections require manual Firebase Console cleanup, noted in its own output) and does not delete the Firebase Auth account itself.
