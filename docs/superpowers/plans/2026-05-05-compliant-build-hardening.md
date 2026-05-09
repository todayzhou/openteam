# Compliant Build Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden production extension bundles using Chrome Web Store-compliant minification and artifact checks.

**Architecture:** Keep all logic self-contained in the extension package and avoid strong obfuscation. Production builds explicitly minify Vite and esbuild outputs, while development watch builds remain readable. A small exported artifact scanner blocks sourcemaps, source map comments, and dynamic-code primitives from shipped JavaScript.

**Tech Stack:** Vite 5, esbuild, Vitest, Chrome Manifest V3.

---

### Task 1: Build Configuration Tests

**Files:**
- Modify: `src/extensionConfig.test.ts`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write failing tests**

Add tests that assert production builds are minified, development builds stay readable, esbuild script builds inherit the same policy, and release JavaScript artifacts reject sourcemaps or dynamic execution markers.

- [ ] **Step 2: Run focused test to verify failure**

Run: `npm test -- src/extensionConfig.test.ts`

Expected: FAIL because the new helper functions do not exist yet.

- [ ] **Step 3: Implement minimal build hardening helpers**

Export helper functions from `vite.config.ts` for production/development build hardening and release artifact scanning. Use those helpers from the actual Vite and esbuild build config.

- [ ] **Step 4: Run focused test to verify pass**

Run: `npm test -- src/extensionConfig.test.ts`

Expected: PASS.

### Task 2: Full Verification

**Files:**
- Modify: `vite.config.ts`

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: PASS and `dist/content.js` is a compact production bundle.
