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

## 11. 历史遗留单独成档

一个真实项目里出现了 37 个 `待处理`：全部是 `3/7` + `✕3`，模式完全一致——
缺 `TASK-KNOWLEDGE`/`TASK-REVIEW`/`TASK-FINAL`，即**收尾三任务规范确立之前**建的 change。

37 行并列等于没有信息。因此：

- **判据**：任务清单里三个收尾任务**一个都没有** → `legacy`；缺一两个的仍然是真问题。
- **优先级**：`legacy` 在 `kindOf` 里**先于** pending/done 判断，否则它们会落进 pending。
- **噪音**：三个全缺时只报一条 warn，不再报三条 error。
- **位置**：渲染在当前 / 待处理 / 已完成之后，默认收起，摘要行显示 `N 历史`。

验证（合成 5 个 change）：

```
active   curr           stages=2/7
pending  real-pending   stages=4/7  issues=（阶段未走完但零 error，仍进待处理）
legacy   legacy-one     stages=3/7  issues=ww
legacy   legacy-two     stages=3/7  issues=ww
bands: {"active":1,"pending":2,"legacy":2}
```

注意 `real-pending` 那条：**零 error 但阶段没走完，仍然算待处理**——
"有遗留"不等于"报错"，这是这个分档的关键。

## 12. 面板必须自己滚动

侧栏 tab 容器是定高的，内容溢出会被裁掉而不是出现滚动条。根节点必须显式声明
`height: 100%; minHeight: 0; overflowY: auto; boxSizing: border-box`，
否则 37 条待处理只能看到前 20 个，且无法下拉。

## 13. 枚举上限吃掉活跃 change

一个项目有 40+ 个 change 时，面板显示"无活跃 change"，而 37 待处理 + 3 已完成 = **正好 40**。
原因：`MAX_CHANGES = 40` 截断了目录枚举，而**活跃 change 恰好被截在门外**。

计数本身就是证据：`changes` 里若含活跃项，摘要应是 `(pending + done) = 39`；
既然等于 40，说明活跃项根本不在列表里。

修复两条，缺一不可：

1. 上限 40 → 200（远高于任何真实项目）
2. **活跃 change 永不参与截断**——枚举后若 `activeId` 不在名单里，显式补上

验证（50 个 change，活跃项排在最后）：

```
changes enumerated: 50 | activeId: zz-last
bands: {"active":1,"legacy":49}
active present: true
```

教训：**任何"上限"都必须先保住当前正在看的那一项**。截断是给病态数据兜底的，
不是用来决定"哪几项重要"的。

## 14. "没找到" 必须说出找过哪里

另一台设备从 GitHub 装 v0.2.5 后，面板只显示一句"当前项目未接入闭环"。
那句话无法自证——**看不出它探测了哪些根、每个根的结果是什么**，于是"插件坏了"
和"这个会话的工作区不是仓库根"这两种完全不同的原因长得一模一样。

`collect` 现在始终返回 `trace`：

```
changes: 0
trace  : [
  {"root":"./","state":"missing .codex/session-state.json","changes":0},
  {"root":".closure-kit/","state":"missing .codex/session-state.json","changes":0}
]
```

空态直接把它渲染出来。这类"什么都没有"的界面，**必须能回答'你找过没有'**——
否则用户唯一能做的就是来问开发者。

## 15. 远程工作区：275 个 change 把轮询拖死了

一台设备报"未接入闭环"，而项目里 `.codex/session-state.json` 明明存在（4794 字节）。
远程实测：

```
/home/cgsz/yiyuan/.codex/session-state.json   存在
/home/cgsz/yiyuan/openspec/changes            275 个目录
```

原因不是"没找到"，是**一轮扫描根本跑不完**：

- v0.2.5 把枚举上限从 40 提到 200 → 每轮 400 次文件读取
- 工作区在 SSH 远程，每次读取都是一次往返
- `setInterval(tick, 2000)` 不等上一轮结束就发下一轮 → 请求堆积
- 快照永远发不出去，UI 停在初始 `loading`，而我把 `loading` 和 `absent` 合并成了同一句"未接入闭环"

四处修正：

| 问题 | 修正 |
| --- | --- |
| 每轮扫描太多 | 上限回到 40（这是它曾经工作过的代价），并加 4 秒墙钟预算 |
| 活跃 change 可能不在窗口内 | 枚举后强制补入 `activeId` |
| `loading` 被当成 `absent` | 分开：`loading` 显示"读取中…" |
| 轮询重叠 | `setInterval` → 自调度 `setTimeout`，上一轮结束才排下一轮 |

并在页脚如实报告 `扫描 41/275`——**不假装扫完了**。

教训：`loading` / `absent` / `empty` 是三种不同的事实，合并其中任意两种都会把
"慢"伪装成"没有"。

## 16. 预算把活跃 change 跳过了（第二次犯同一类错）

v0.2.7 加了 4 秒墙钟预算，但把活跃 change **追加在扫描队列末尾**。远程实测：

```
扫描 5/275      ← 4 秒只够读 5 个
无活跃 change   ← 第 6 个正是它
```

同一类错误换了方向：v0.2.5 是"上限截断"，v0.2.7 是"预算截断"，两次都把
**最该保住的那一项**丢掉了。

修正：

1. **活跃 change 排到队列首位**，并豁免预算检查（`name !== activeId` 才允许 break）
2. 读到活跃 change 后**立即发布一次部分快照**，其余分档在后面补齐

慢盘模拟（80 个 change、每次读取 75ms、活跃项排最后）：

```
total: 80  scanned: 16  elapsed: 4299ms
partials: [{"at":348,"active":1,"n":1}]   ← 348ms 就把活跃项画出来了
final has active: true
```

**第一条规则：任何"提前结束"的逻辑，都必须先问一句——正在看的那一项拿到了吗。**

## 17. 轮转扫描：把"扫不完"变成"逐步覆盖"

275 个 change 的远程仓库，每个 change 两次文件读取。任何"每轮全量"的方案都注定失败——
v0.2.7 靠预算截断只是把失败推迟成"永远只看到前几个"。

改为**缓存 + 轮转**：

```
每轮 = 当前 change（必扫，立即发布）
     + 最多 8 个缓存过期/未缓存的其它 change（游标轮转）
     + 其余条目从缓存直出（60 秒 TTL）
```

实测（80 个 change、每次读取 20ms）：

```
round  1: cached   9/80  active=true  ms=1018
round  9: cached  73/80  active=true  ms=1005
round 10: cached  80/80  active=true  ms=894
round 11: cached  80/80  active=true  ms=140   ← 全命中后只剩活跃项要读
```

覆盖线性增长，全量之后开销回落到毫秒级。**这不是"优化"，而是远程文件系统下唯一
能同时做到"看得到当前"和"看得全"的结构。**

代价与边界：

- 首次覆盖需要若干轮，新 change 之外的条目可能短暂缺失（页脚如实报 `已缓存 N/M`）
- 缓存在插件模块作用域内，页面刷新即清空
- TTL 60 秒意味着别人改了某个旧 change，最多一分钟后才反映

## 18. 覆盖满了却还在一直扫

用户观察到：`已缓存 275/275` 之后面板仍在持续读取。原因是我只设了一个 TTL：

- 活跃 change 每 2 秒重读（必须，这是实时性来源）
- **其它 274 个按 60 秒 TTL 轮转重读** → 约 9 次读取/秒，永远不会停

一个已经归档、半年没动过的 change，每分钟重读一次毫无意义。两处修正：

| 场景 | 行为 |
| --- | --- |
| 覆盖未满 | TTL **30 秒**，尽快补齐 |
| 覆盖已满 | TTL **5 分钟**，只做低频兜底 |
| 标签页隐藏 | 轮询降到 10 秒，且不做扫描 |

实测（30 个 change，12 轮）：

```
round  1..3: cached 9..25/30  io=37   ← 补齐期
round  4   : cached 30/30    io=25   ← 刚好满
round  5.. : cached 30/30    io=5    ← 稳态：只剩活跃项要读
```

稳态每轮 5 次 IO = 会话状态 + 活跃 change 的 proposal/tasks/归档探测 + 目录列举。
**这就是应有形态：一直盯的只有正在做的那一个。**

## 19. 切换 change 时缓存里的"幽灵当前"

缓存是按 changeId 存的快照，而快照里带有**只在它是活跃项时才成立**的字段：
`isActive`、`activeTask`、`blocker`，以及由 session 推出的 `closed`。

session 一旦切到新 change：

- 新 change：下一轮必扫、必然重建 → 2 秒内出现（`session-state.json` 从不缓存）
- 旧 change：缓存里仍是 `isActive: true`，而 TTL 是 **5 分钟**

于是面板上会出现**两个"当前"**，最多持续 5 分钟；UI 取 `changes.filter(isActive)[0]`，
甚至可能显示错的那一个。

修正：每轮开始先做一次"降级清理"——缓存条目若 `isActive` 但已不是当前活跃项，
**直接删除并排到队首重建**（只多读 1 个 change）。

验证（同一进程内把 active 从 alpha 切到 beta）：

```
before switch | active=["alpha"] | alpha.activeTask="TASK-001"
after  switch | active=["beta"]  | alpha.activeTask=""        ← 已被降级重建
```

**教训：缓存的不只是数据，还有"它当时是什么角色"。角色会变，缓存必须跟着失效。**
