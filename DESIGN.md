# 闭环面板 · 设计记录

> 本文件不是 npm 包的入口文档，只记录决策理由、踩坑与验证方式，供维护者阅读。

## 1. 席位选择：从错误到正确

试过三种形态，前两种都错：

| 形态 | 结果 |
| --- | --- |
| `conversation.input.dock`（输入框上方居中） | 卡片悬在对话中间，视觉上"夹着"，违和 |
| `position: fixed` 右上角浮层 | **必然遮挡**窗口其他部分，用户明确否决 |
| **`sidebar.right.pane.tab` 右侧栏一列** | ✅ 挤压布局而不是覆盖布局 |

右栏是 DSH 里具备完整扩展契约的位置：`ctx.sidebarRightTabs.register` 注册类型，
`sidebar.right.pane.tab`（keyed）注册正文，`ctx.sidebarRight.openTab(kind)` 打开。
官方文档对右栏的定位是"它是页面的一列，不是压在页面上的卡片"，正是需要的行为。

### 入口按钮为什么放 `conversation.session.header.utilities`

`conversation.session.header.corner` 更贴"右上角"，但它是 `kind: single`，
**已被右栏折叠按钮占用**，强占会冲突。`utilities` 是 `kind: list`，可安全追加。

## 2. 项目识别：一个差点常态化的误报

最初用 `AGENTS.md` 存在与否判断"是不是闭环项目"。**这个判据是错的**——
几乎每个仓库都有 AGENTS.md，于是任何项目都会冒出一个 `⚠ 闭环` 按钮，点开又是空面板。

改为**只认 `.codex/session-state.json`**（迁移包必然带它）：

| 探测结果 | 入口按钮 | 面板正文 |
| --- | --- | --- |
| 有 session-state，有 change | 显示，判定色 + `N/7` | 完整面板 |
| 有 session-state，无 change | 显示，灰色 `○ 闭环` | 一句安静的说明 |
| 无 session-state | **不渲染** | 中性灰字"当前项目未接入闭环" |

## 3. 阶段不能自己说谎

初版里出现过 `✓审批` 与 `✕ 批准报告不存在` 同时存在的荒谬状态，以及
`✓收口` 而 `○验收` 未完成的矛盾。修正：

- `收口` = session closed **且** `TASK-FINAL` 已勾选（只关会话不算收口）
- 任何属于该阶段的 **error** 级问题，把阶段从 `✓` 降级为 amber `⚠`，原因写"有 N 项错误待处理"

代价是进度数字变难看（示例从 5/7 掉到 2/7）。这是刻意的：**这个卡片的唯一价值是不自欺。**

脏阶段**不抢**"下一步"的位置——`知识`/`审批` 依赖 `实施` 完成，跳到前面没意义。
改为在下一步下面单独一行：`⚠ 勾了但有问题：知识 · 审批`。

## 4. 收口之后不能消失

闭环结束后，上一轮没走完的环节正是驱动修复的输入，卡片不能直接清空。

change 解析采用降级链，全部基于磁盘事实：

1. `session-state.json` 的 `active_change`
2. `session-state.json` 的 `history` 最后一条 `change_name`
3. `openspec/changes/` 下**唯一**的目录
4. 有多个目录且无会话指针 → **不显示**（宁可不猜）

归档不移动文件（`change_archive.py` 只写 `.archived` 标记），所以归档后仍可完整读取，
面板会显示 `已归档` 胶囊。

## 5. 探测失败不指控

单次分析最多探测 18 个路径。stat 抛错或预算耗尽时**按"存在"处理**：

```js
const exists = async (path) => {
  budget -= 1;
  if (budget < 0) return true;   // 不知道，就不说它不存在
  ...
};
```

宁可漏报，不可误报——误报会让整个面板失去可信度。同一路径同一任务也只报一次，
专用规则（如 `review_artifact`）优先于通用路径扫描。

## 6. 单一轮询源

入口按钮常驻、右栏正文按需。若各自轮询，两个席位会显示两份不同时刻的"事实"。
因此按钮独占 2 秒轮询并发布快照，正文用 `useSyncExternalStore` 订阅同一份。

## 7. 教训：junction 会吞掉源码

曾经为了省事，在**应用安装目录**里再建一个指向源码的 junction：

```
D:\deepseek\resources\app\dsh\node_modules\dsh-plugin-closure-board  ->  D:\编程\闭环\dsh-plugin-closure-board
```

客户端升级时该目录被递归删除，**Windows 沿着 junction 走进去，把源码目录内容一并清空**。
同时 profile 的 patch 条目也被重置。

**硬规则：绝不在应用安装目录放 junction。** 只放在 profile 的用户数据目录：

```
C:\Users\<user>\.dsh\profiles\<profile>\node_modules\dsh-plugin-closure-board
```

### 从会话日志恢复

源码丢失后从 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` 恢复：

1. 该文件是**逐事件分帧**的 zstd，整体解压只能得到首帧（185 字节）
2. 按魔数 `28 B5 2F FD` 切帧，逐段 `zstdDecompressSync`（本例 907 帧全部成功）
3. 在事件里找 `tool/call` 的 `data.arguments`（JSON 字符串），`JSON.parse` 拿到 `code`
4. 从 `String.raw` 模板字面量中截出文件正文，再重放之后的每次 `edit`

注意：文件里中文若是 `\uXXXX` 转义形式，编辑脚本里的字符串必须先归一化，
否则"真汉字"与"转义序列"匹配不上。

## 8. 验证方式

数据层不依赖浏览器，可用 Node 直接驱动：

```js
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
await import("file:///<pkg>/lib/client.js");
const mod = captured.factory(() => ({}));
const snapshot = await mod.__internals.collect({ sessionId: "s", remote });
```

`remote` 用假实现指向临时目录即可。`__internals` 导出
`parseTasks / computeStages / applyIssueGating / verdictOf / collect / findConflicts / pathTokens`。

已验证的场景：有 kit + 有 change、有 kit + 无 change、无 kit、归档 change、
收口后仍保留、指针指向已删除 change。

## 9. 组合包安装链路

用隔离的临时 profile 验证过 bundle 契约（不碰 desktop）：

```
dsh --profile <scratch> --from-default-profile web --dump-config
# 把包加入该 profile 的 dsh.profile.bundles 后再 dump
# 输出出现 "# == dsh-plugin-closure-board" 与 "- id: closure-board" 即为成功
# 无 skippedBundles 表示未被版本闸门拒绝
```
NaN