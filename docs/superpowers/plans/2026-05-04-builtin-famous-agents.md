# Built-in Famous Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add system built-in famous Agent templates that are selectable, searchable, typed as built-in/custom, and protected from deletion or editing.

**Architecture:** Built-in templates live in code as the authoritative source and are merged with custom templates at read time. Storage continues to persist only user-created templates, while helper functions resolve both built-in and custom templates for UI rendering and role creation.

**Tech Stack:** TypeScript, Chrome extension storage, Vite, Vitest, jsdom.

---

## File Structure

- Create `src/group/builtinRoleTemplates.ts`: built-in template constants and lookup helpers.
- Modify `src/group/types.ts`: add `RoleTemplateType` and `RoleTemplate.type`.
- Modify `src/group/store.ts`: normalize missing template types to `custom` and avoid persisting built-ins.
- Modify `src/group/roleTemplates.ts`: create custom templates with `type: 'custom'`, resolve library templates through merged helpers, and prevent built-in update/delete.
- Modify `src/teamPage/appState.ts`: add add-person tab/search state.
- Modify `src/teamPage/domRefs.ts` and `public/team.html`: add refs and markup for add-person search and tabs.
- Modify `src/teamPage/peopleLibraryView.ts`: render built-in/custom badges, hide built-in delete/edit, filter add-person list by tab/search.
- Modify `public/team.css`: style tabs, search field, type badges.
- Add or extend tests in `src/group/roleTemplates.test.ts`, `src/group/store.test.ts`, `src/background/groupExperience.test.ts`, `src/teamPage/peopleLibraryView.test.ts`, `src/teamPage/domRefs.test.ts`, and `src/teamPage/teamHtml.test.ts`.

## Task 1: Template Type And Built-In Catalog

**Files:**
- Modify: `src/group/types.ts`
- Create: `src/group/builtinRoleTemplates.ts`
- Modify: `src/group/store.ts`
- Test: `src/group/store.test.ts`
- Test: `src/group/roleTemplates.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that expect missing template types to normalize to `custom`, built-ins to be available through `getAllRoleTemplates`, and built-ins to be excluded from persisted storage.

- [ ] **Step 2: Run red tests**

Run: `npx vitest run src/group/store.test.ts src/group/roleTemplates.test.ts`
Expected: FAIL because `type` and built-in helper functions do not exist.

- [ ] **Step 3: Implement type and catalog**

Add `RoleTemplateType`, create `BUILTIN_ROLE_TEMPLATES`, and export `getAllRoleTemplates`, `getRoleTemplateById`, `getCustomRoleTemplates`, and `isBuiltinRoleTemplateId`.

- [ ] **Step 4: Run green tests**

Run: `npx vitest run src/group/store.test.ts src/group/roleTemplates.test.ts`
Expected: PASS.

## Task 2: Role Template Mutations And Batch Creation

**Files:**
- Modify: `src/group/roleTemplates.ts`
- Modify: `src/background/roleHandlers.ts`
- Test: `src/group/roleTemplates.test.ts`
- Test: `src/background/groupExperience.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for creating a group role from a built-in template, rejecting built-in update/delete, and preserving custom delete behavior.

- [ ] **Step 2: Run red tests**

Run: `npx vitest run src/group/roleTemplates.test.ts src/background/groupExperience.test.ts`
Expected: FAIL because built-in lookup and protection are not wired into mutations.

- [ ] **Step 3: Implement mutation behavior**

Use `getRoleTemplateById` in role creation paths, set new templates to `custom`, and throw clear errors for built-in update/delete.

- [ ] **Step 4: Run green tests**

Run: `npx vitest run src/group/roleTemplates.test.ts src/background/groupExperience.test.ts`
Expected: PASS.

## Task 3: Add-Person UI Search And Type Tabs

**Files:**
- Modify: `public/team.html`
- Modify: `src/teamPage/domRefs.ts`
- Modify: `src/teamPage/appState.ts`
- Modify: `src/teamPage/peopleLibraryView.ts`
- Modify: `public/team.css`
- Test: `src/teamPage/domRefs.test.ts`
- Test: `src/teamPage/peopleLibraryView.test.ts`
- Test: `src/teamPage/teamHtml.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that require search/tabs refs, verify built-in/custom tab filtering, verify search matches name/description/prompt, and verify built-in cards show type and no delete button.

- [ ] **Step 2: Run red tests**

Run: `npx vitest run src/teamPage/domRefs.test.ts src/teamPage/peopleLibraryView.test.ts src/teamPage/teamHtml.test.ts`
Expected: FAIL because markup, refs, state, and filtering do not exist.

- [ ] **Step 3: Implement UI behavior**

Add DOM elements and refs, extend state, render type badges, hide built-in destructive actions, and filter add-person items by active tab and search query.

- [ ] **Step 4: Run green tests**

Run: `npx vitest run src/teamPage/domRefs.test.ts src/teamPage/peopleLibraryView.test.ts src/teamPage/teamHtml.test.ts`
Expected: PASS.

## Task 4: Full Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Inspect diff**

Run: `git diff --stat && git diff -- src/group src/teamPage public/team.html public/team.css`
Expected: Diff only covers built-in templates, type/search UI, tests, and the implementation plan.

