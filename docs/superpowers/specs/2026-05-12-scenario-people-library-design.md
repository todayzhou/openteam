# Scenario People Library Design

## Context

OpenTeam already has two related resource libraries:

- Built-in people in `src/group/builtinRoleTemplates.ts`. These are currently 38 mostly famous-thinker or expert-style templates.
- Built-in group templates in `src/group/builtinGroupTemplates.ts`. These currently include 45 group scenarios and 270 scenario members across 11 categories.

The current people library is too thin for day-to-day use. Group templates already contain many practical members, but users can only access those members by creating a whole group. The people library also only separates `内置人员` and `自定义人员`, so a larger built-in set would become hard to scan without category filters.

## Goals

- Move the reusable members from built-in group templates into the built-in people library.
- Preserve scenario context for members that would be ambiguous outside their original group.
- Add category filtering to the people library modal.
- Add category filtering to the add-person modal so users can quickly choose people by scenario.
- Keep existing group template creation behavior unchanged.
- Keep the existing snapshot behavior: after a person is added to a chat, later template updates do not mutate that chat member.

## Non-Goals

- Do not add a template marketplace, favorites, ratings, or remote updates.
- Do not merge all same-name members into one universal template.
- Do not make built-in people editable.
- Do not change custom people storage beyond adding optional metadata normalization.
- Do not change orchestration templates or group template runtime semantics.

## Product Model

The built-in people library will contain two broad families:

- `思想风格顾问`: the existing famous-thinker and expert-style templates.
- `场景化人员`: reusable roles derived from group templates, such as `学习规划师`, `Prompt规范工程师`, `餐饮·成本控制师`, and `制造业·成本控制师`.

Scenario people should feel like standalone people, not hidden children of a group template. Their descriptions and prompts already explain their responsibility, boundary, inputs, methods, and outputs, so they can be reused in arbitrary chats.

## Categories

Role templates gain an optional category:

```ts
export interface RoleTemplate {
  id: string
  type: RoleTemplateType
  name: string
  category?: string
  description?: string
  defaultModelSource?: RoleModelSource
  defaultChatSite?: ChatSite
  defaultExternalModelId?: string
  sourceTemplateId?: string
  sourceTemplateName?: string
  chatGptGptsUrl?: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}
```

Category values:

- Existing famous-thinker templates use `思想风格顾问`.
- Scenario people use the category from their source group template:
  - `学生与学习`
  - `职场效率`
  - `内容创作`
  - `产品与创业`
  - `市场营销与销售`
  - `技术研发`
  - `企业管理`
  - `财务、法律、合规`
  - `电商与本地生意`
  - `专业服务`
  - `行业垂直专家团`

The UI category list uses `全部` plus categories that exist in the current filtered template type. This keeps custom-only lists from showing empty built-in categories unless custom users later receive categories.

## Built-In Scenario People Generation

Add a small transformation layer in `src/group/builtinRoleTemplates.ts` or a nearby helper module. It will derive scenario people from `BUILTIN_GROUP_TEMPLATES` rather than hand-copying 270 definitions.

Each group template role becomes a `RoleTemplate` with:

- `type: 'builtin'`
- stable id derived from source group id and role name
- `name`
- `category`
- `description`
- `sourceTemplateId`
- `sourceTemplateName`
- `defaultChatSite: 'deepseek'`
- `systemPrompt`
- timestamps set to `0`

ID format:

```text
builtin-scenario-{groupTemplateId}-{sluggedRoleName}
```

The id must be stable across builds and independent of array position. Chinese role names can be converted with a deterministic short hash if slugging is not readable enough.

## Naming and Disambiguation

Most group template member names can be kept as-is. For duplicate names or names that become unclear outside the original group, add a short scenario prefix.

Rules:

- If a role name appears only once across all group templates, keep the original role name.
- If the same role name appears in multiple templates with meaningfully different context, prefix with a concise source context:
  - `餐饮·成本控制师`
  - `制造业·成本控制师`
  - `短视频·标题封面顾问`
  - `小红书·标题封面顾问`
- If duplicate roles are essentially the same reusable function, they may still stay separate in v1 if their prompts differ. We optimize for not losing scenario nuance.
- Keep names within the existing 50-character limit.

The original source group remains visible through metadata in detail views and card meta text.

## People Library UI

The people library modal keeps the existing top-level tabs:

- `自定义人员`
- `内置人员`

Inside the current tab, add a category filter row above the list:

- `全部`
- category chips for the currently visible template type

Behavior:

- Opening the people library resets search to empty and category to `全部`.
- Switching between built-in and custom resets category to `全部`.
- Search matches `name`, `description`, `systemPrompt`, `category`, and `sourceTemplateName`.
- The summary count reflects the current type, category, and search filters.
- Pagination applies after filtering.
- Built-in cards show a compact meta line, for example:
  - `内置 · 技术研发 · AI Agent 开发群`
  - `内置 · 思想风格顾问`
- The built-in detail modal shows category and source group in metadata.

Empty states:

- Built-in no category result: `当前分类暂无内置人员`
- Custom no category result: `当前分类暂无自定义人员`
- Search no result keeps the existing search-specific empty copy, with category context if useful.

## Add-Person Modal UI

The add-person modal also keeps top-level tabs:

- `自定义人员`
- `内置人员`

Add the same category filter row below the search input. This row is especially important in `内置人员`, because the list will expand from 38 to more than 300 built-in templates.

Behavior:

- Opening add-person resets type to `custom`, search to empty, category to `全部`, and site selections to defaults.
- Switching type resets category to `全部`.
- Search and category filtering apply together.
- Selected people remain selected if the user changes category or search, as long as they are still valid in the underlying list.
- Site selection behavior is unchanged.
- Disabled site behavior for already-added same template and model remains unchanged.

## Data Flow

Template list construction:

1. `BUILTIN_ROLE_TEMPLATES` includes existing famous templates plus derived scenario templates.
2. `getAllRoleTemplates(store)` returns built-ins first, then custom templates.
3. UI filters the returned templates by type, category, and search query.
4. Adding a person still sends `source: 'library'` and `roleTemplateId`.
5. `createGroupRolesBatch` resolves the template through `getRoleTemplateById`.
6. `createGroupRole` snapshots name, description, system prompt, site, and template id into the chat role.

Storage:

- Built-in templates remain code constants and are not written to Chrome storage.
- Custom templates remain stored in `roleTemplatesById`.
- Older custom templates without `category` continue to load.

## Error Handling and Safety

- If derived ids collide, tests fail before release.
- If a scenario role has an empty prompt or description, tests fail.
- Built-in templates continue to reject edit and delete commands.
- High-risk scenario prompts keep their existing boundaries from group templates.
- If a source group template is later removed, existing chat roles are unaffected because they already store snapshots.

## Testing

Unit tests should cover:

- `RoleTemplate` normalization preserves optional category and source metadata for custom templates.
- Built-in role templates include existing famous templates and derived scenario people.
- Derived scenario people have stable unique ids.
- Duplicate source role names are disambiguated in the built-in people list.
- Scenario people carry category and source group metadata.
- `getAllRoleTemplates` returns built-ins before custom templates.
- People library filters built-in people by category.
- Add-person filters built-in people by category.
- Search matches category and source group name.
- Selected add-person entries survive category/search changes.
- Built-in detail modal displays category and source group metadata.

Focused verification:

```bash
npm test -- src/group/builtinRoleTemplates.test.ts src/group/roleTemplates.test.ts src/teamPage/peopleLibraryView.test.ts src/teamPage/domRefs.test.ts src/teamPage/teamHtml.test.ts
```

Full verification:

```bash
npm run typecheck
npm test
npm run build
```

## Implementation Order

1. Extend `RoleTemplate` with optional category and source metadata.
2. Add tests for built-in scenario people derivation and duplicate-name disambiguation.
3. Implement derived scenario people in the built-in role template module.
4. Add category filter state to `TeamPageState`.
5. Add category filter DOM refs and markup in `team.html`.
6. Update people library filtering and card metadata.
7. Update add-person filtering and selection persistence.
8. Update detail modal metadata.
9. Run focused tests, typecheck, full tests, and build.

