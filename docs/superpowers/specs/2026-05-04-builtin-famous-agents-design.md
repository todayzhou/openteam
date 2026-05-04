# Built-in Famous Agent Templates Design

## 背景

OpenTeam 已经有人员库能力：`RoleTemplate` 保存在 `roleTemplatesById` / `roleTemplateOrder` 中，用户可以从人员库批量选择人员加入群聊。现在需要把一批“名人思想风格模拟顾问”作为系统内置 Agent 模板提供给用户直接选择。

这些模板不是冒充真人，而是固定的系统模板。用户可以在添加人员时搜索、按类型筛选，并区分“内置人员”和“自定义人员”。

## 目标

- 增加系统内置名人 Agent 模板，用户打开产品后即可选择。
- `RoleTemplate` 增加类型属性，用来区分 `builtin` 和 `custom`。
- 内置模板不可删除，不作为普通自定义模板被用户破坏。
- 添加群聊人员时增加搜索功能。
- 添加群聊人员时增加 Tab：内置人员、自定义人员。
- 人员库总列表中显示每个人员的类型：内置或自定义。
- 复用现有加入群聊、站点选择、批量创建角色和提示词复制逻辑。

## 非目标

- 第一版不做内置模板在线更新。
- 第一版不做模板市场、评分、收藏或分类导航。
- 第一版不允许直接编辑系统内置模板。
- 第一版不做名人资料联网校验；模板内容来自项目内置提示词文本。
- 第一版不改变群聊内人员的快照行为：加入群聊后仍复制模板名称、描述和提示词。

## 数据模型

`RoleTemplate` 增加类型字段：

```ts
export type RoleTemplateType = 'builtin' | 'custom'

export interface RoleTemplate {
  id: string
  type: RoleTemplateType
  name: string
  description?: string
  defaultChatSite?: ChatSite
  chatGptGptsUrl?: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}
```

语义：

- `type: 'builtin'` 表示系统内置模板。
- `type: 'custom'` 表示用户自定义模板。
- 旧数据没有 `type` 时，加载时归一化为 `custom`。
- 用户新建人员时自动写入 `type: 'custom'`。
- 内置模板的 `id` 使用稳定前缀，例如 `builtin-frankl`、`builtin-camus`，避免和用户模板 ID 冲突。

如果界面需要 boolean 判断，使用 `template.type === 'builtin'`，不再额外持久化 `isBuiltin`，避免两个字段含义不一致。

## 内置模板来源

新增模块：

```text
src/group/builtinRoleTemplates.ts
```

职责：

- 导出 `BUILTIN_ROLE_TEMPLATES: RoleTemplate[]`。
- 导出 `getBuiltinRoleTemplate(templateId)`。
- 导出 `isBuiltinRoleTemplateId(templateId)`。
- 保存系统内置名人 Agent 提示词。

内置模板不依赖用户 storage。它们由代码常量提供，运行时和自定义模板合并展示。这样后续产品升级时，内置模板内容可以随代码版本更新，不会被用户本地旧 storage 覆盖。

## 模板读取

新增统一模板目录能力：

```ts
function getAllRoleTemplates(store: OpenTeamStore): RoleTemplate[]
function getRoleTemplateById(store: OpenTeamStore, templateId: string): RoleTemplate | undefined
function getCustomRoleTemplates(store: OpenTeamStore): RoleTemplate[]
```

规则：

- 所有展示用列表使用 `getAllRoleTemplates(store)`。
- 创建、更新、删除自定义模板仍操作 `store.roleTemplatesById`。
- 从模板创建群聊人员时使用 `getRoleTemplateById(store, templateId)`，因此内置和自定义都能被加入群聊。
- 保存 store 时只保存自定义模板；内置模板不写入 `chrome.storage.local`。

## 删除和编辑规则

内置模板：

- 删除按钮不显示。
- 不允许走 `ROLE_TEMPLATE_DELETE` 删除。
- 不允许走 `ROLE_TEMPLATE_UPDATE` 修改。
- 如果后续需要修改，提供“复制为自定义”能力，但第一版可以先不做。

自定义模板：

- 保持现有编辑能力。
- 保持现有删除保护：如果已被群聊使用，则不能删除。
- 新建时自动标记为 `custom`。

background 需要在 handler 层兜底：

- 删除内置模板时抛出“系统内置人员不能删除”。
- 更新内置模板时抛出“系统内置人员不能编辑”。

## 人员库列表体验

人员库弹窗继续显示所有模板，但每张卡增加类型标识：

- 内置模板显示 `内置`。
- 自定义模板显示 `自定义`。

列表排序：

1. 内置模板在前。
2. 自定义模板在后，沿用 `roleTemplateOrder`。
3. 同一类型内保持定义顺序或用户创建顺序。

分页继续沿用现有每页 5 条。第一版不在人员库总列表加搜索；搜索优先加在“添加人员”弹窗，因为用户明确提到的是群里面选择人员时搜索。

## 添加人员弹窗体验

添加群聊人员弹窗增加三个 UI 状态：

```ts
addPersonTemplateType: 'builtin' | 'custom'
addPersonSearchQuery: string
```

界面结构：

- 顶部搜索框：占位文案“搜索人员名称、描述或提示词”。
- Tab：`内置人员`、`自定义人员`。
- 列表只展示当前 Tab 下匹配搜索词的人员。
- 每条人员继续保留现有站点多选控件。
- 已加入当前群聊的同名同站点人员继续禁用该站点。

搜索规则：

- 大小写不敏感。
- 匹配 `name`、`description`、`systemPrompt`。
- 搜索词为空时显示当前 Tab 的全部人员。
- 搜索无结果时显示空态：
  - 内置 Tab：`没有匹配的内置人员`
  - 自定义 Tab：`没有匹配的自定义人员`

提交规则：

- 只提交当前已勾选人员。
- 内置和自定义人员都使用现有 `source: 'library'`，通过 `roleTemplateId` 区分。
- 临时人员仍可保留在添加弹窗右上角入口；它不进入内置/自定义 Tab。

## 群聊内人员创建

`createGroupRolesBatch` 的 library 分支从统一模板目录读取模板：

```ts
const template = getRoleTemplateById(store, item.roleTemplateId)
```

创建出来的 `GroupRole` 仍然保存：

- `templateId`
- `name`
- `description`
- `systemPrompt`
- `chatSite`
- 可选 `chatGptGptsUrl`

这保证内置模板后续更新不会悄悄改变已经加入旧群聊的人设。旧群聊人员是当时选择模板的快照。

## 测试策略

单元测试覆盖：

- 默认 store 归一化旧自定义模板为 `type: 'custom'`。
- 新建模板自动写入 `type: 'custom'`。
- 内置模板不会写入 storage。
- `getAllRoleTemplates` 合并内置和自定义模板。
- `getRoleTemplateById` 能读取内置模板和自定义模板。
- 删除/更新内置模板会失败。
- 从内置模板批量创建群聊人员时能复制提示词。
- 添加人员弹窗按 Tab 过滤内置/自定义人员。
- 添加人员弹窗搜索名称、描述、提示词。
- 人员库列表显示内置/自定义类型标识。
- 内置模板卡片不显示删除按钮。

## 实施顺序

1. 扩展 `RoleTemplate` 类型和 store 归一化逻辑。
2. 新增内置模板模块，先接入少量代表模板验证链路，再填充完整名人库。
3. 增加统一模板读取 helper，并替换 UI 和 background 中的模板读取入口。
4. 加入内置模板不可编辑、不可删除的防护。
5. 改造添加人员弹窗，增加搜索和内置/自定义 Tab。
6. 在人员库总列表显示类型标识。
7. 补充测试并运行现有测试集。

