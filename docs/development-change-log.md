# 开发变更日志

用于记录持续性编程任务中的代码/文档变更，便于回顾、定位和还原。

## 2026-05-21 14:48:01 +08:00 - Issue #23 编排界面底部信息和按钮被遮挡

- 任务目标：修复编排界面底部信息和“保存/运行”按钮在常见窗口尺寸下被遮挡的问题。
- 涉及文件：暂未修改业务代码；建立本开发日志文件。
- 关键修改内容：无业务修改；当前阶段为分支准备和基线验证。
- 修改原因：记录开发任务起点，满足持续性编程任务的变更留痕要求。
- 验证方式/结果：已完成基线验证，见开发过程日志。
- 后续事项：复现/分析布局根因，修改编排弹窗布局样式并更新相关 UI 测试或截图说明。

## 2026-05-21 17:52:23 +08:00 - Issue #23 编排弹窗底部操作区可见性

- 任务目标：确保编排界面在常见桌面窗口尺寸下底部按钮和状态/说明信息可见可点，内容较长时不与底部操作区重叠。
- 涉及文件：public/team.css、src/teamPage/teamHtml.test.ts。
- 关键修改内容：
  - .orchestration-modal 增加明确视口内高度，保留四行 grid 布局并隐藏外溢。
  - .orchestration-layout 改为可收缩中间区域，移除固定 min-height: 520px 对 footer 的挤压。
  - .orchestration-stage-canvas 改为 min-height: 0，随中间区域收缩。
  - .orchestration-people-list 增加内部滚动能力，长人员列表不再向下覆盖 footer。
  - .orchestration-footer 增加独立定位层级，保持底部操作区可见。
  - 更新 	eamHtml.test.ts 中编排弹窗 CSS 断言，覆盖本次布局约束。
- 修改原因：中间内容区固定最小高度导致视口高度不足时 footer 与人员列表/画布重叠或被遮挡。
- 验证方式/结果：
pm test -- src/teamPage/teamHtml.test.ts、
pm test -- src/teamPage/orchestrationModalView.test.ts src/teamPage/orchestrationCanvas.test.ts、
pm run typecheck、
pm run build 均通过。
- 后续事项：重新加载 Chrome 扩展 dist 后人工确认“编排任务”弹窗底部保存/运行按钮可见可点。

## 2026-05-21 18:01:09 +08:00 - Issue #23 编排弹窗底部遮挡修复

- 任务目标：确保编排弹窗底部设置说明和“保存/运行”按钮在常见桌面窗口尺寸下可见可点。
- 涉及文件：public/team.css、src/teamPage/teamHtml.test.ts。
- 关键修改内容：
  - 为 .orchestration-modal 增加视口内高度约束和 min-height: 0，使 grid 中间内容区可正确收缩。
  - 将 .orchestration-layout 改为占满可用高度并隐藏自身溢出，由内部列表/设置区滚动承接长内容。
  - 为 .orchestration-people-list 增加 min-height: 0 和 flex 收缩/滚动能力。
  - 将 .orchestration-stage-canvas 的固定最小高度改为可收缩，避免挤压底部 footer。
  - 为 .orchestration-footer 增加层级保护，避免被画布区域覆盖。
  - 更新 	eamHtml.test.ts 中编排弹窗布局样式断言。
- 修改原因：原布局中间区域存在固定最小高度，较小视口下会挤压或遮挡底部操作区。
- 验证方式/结果：相关测试、类型检查和生产构建通过；完整 
pm run verify 在 Windows 环境存在与本次改动无关的既有失败，详见开发过程日志。
- 后续事项：提交分支并创建 PR，PR 中说明截图已验证底部操作区可见。
