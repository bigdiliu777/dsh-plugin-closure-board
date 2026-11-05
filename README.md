# dsh-plugin-closure-board

监控【闭环开发流程】的 DeepSeek Harness 插件。在会话 header 右侧提供一个入口按钮，
在右栏打开一列，实时显示当前 change 的闭环阶段与 `tasks.md` 勾选状态。

**只读**：仅读取下列文件，从不写入，因此不可能改动你的闭环数据。

| 文件 | 用途 |
| --- | --- |
| `.codex/session-state.json` | 当前 change / task / 阻塞 |
| `openspec/changes/<change>/proposal.md` | 验收标准与变更记忆是否存在 |
| `openspec/changes/<change>/tasks.md` | 任务清单与勾选 |
| `docs/project-knowledge/change-memory/index.md` | 该 change 是否已登记 |

kit 根按 `""` → `.closure-kit/` 顺序探测，所以既能用于已迁移的目标项目根目录，
也能用于尚未迁移、数据仍在 `.closure-kit/` 下的治理仓库。

## 显示什么

**7 个阶段**，全部由磁盘产物判定，不读任何自述：

提案 → 拆分 → 实施 → 知识 → 审批 → 验收 → 收口

**判定态**（决定面板左边条、入口按钮的颜色与文案）：

| 判定 | 条件 |
| --- | --- |
| `完整闭环` | 7 阶段全部完成且零问题 |
| `未完成闭环 · N 项待办` | 会话已 closed，但阶段未走完或有 error |
| `进行中 · 有问题` | 未 closed 但有 error |
| `进行中` | 未 closed 且无 error |
| `无活跃 change` | kit 已接入但尚无 change |

**矛盾检测**（探测失败一律不指控，宁可漏报不误报）：

- 已勾选任务缺少该 `task_level` 的必填证据（lite: verification；standard: +green；full: +test_file/red）
- 证据值是空话（`ok` / `已验证` / `测试通过`）
- 证据引用的 `docs/...` 产物路径实际不存在
- `TASK-REVIEW` 勾了但 `change-review.json` 不存在
- `TASK-FINAL` 勾了但 `project_closure_evidence` 为空或文件不存在
- 会话已 closed 但 `TASK-FINAL` 未勾选
- `active_task` 不在 `tasks.md` 里
- 缺少固定收尾三任务、缺少 `## 验收标准`、缺少 `## 变更记忆`、change-memory 未登记

**阶段诚实性**：阶段有 error 时不会显示绿勾，而是降级为 amber `⚠` 并标注原因；
`收口` 要求 session closed **且** `TASK-FINAL` 已勾选。

问题清单可一键复制成纯文本，直接粘给 agent 作为修复输入。

## 安装

前提：项目中已接入闭环治理包（存在 `.codex/session-state.json`）。
未接入的项目不会出现任何按钮——插件会完全静默。

### 插件面板

在 DSH 的「添加插件」里输入包名、GitHub 仓库地址或本地目录路径均可，
然后启用这个组合包。

### 手工（开发用）

```powershell
mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-plugin-closure-board" "<本包绝对路径>"
```

再在 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: closure-board
      name: dsh-plugin-closure-board
```

> **⚠️ 绝对不要把 junction 放进应用安装目录**（如 `...\resources\app\dsh\node_modules`）。
> 该目录在升级时会被递归删除，Windows 会**沿着 junction 把源码一起删掉**。
> 只放在 profile 的用户数据目录下。

> 本包同时是 bundle（自带 `cordis.patch.yml`）。手工 patch 与「选择组合包」
> 两种方式**只能二选一**，否则同一 id 会重复插入。

### 从界面安装失败时的排查

仓库地址安装已在隔离 profile 里**端到端验证**过：

```
dsh plugin --profile <scratch> add -w github:bigdiliu777/dsh-plugin-closure-board
→ + dsh-plugin-closure-board 0.1.0
→ dsh.profile.bundles 自动追加该包
→ dsh --profile <scratch> --dump-config 出现 "# == dsh-plugin-closure-board"
→ 无 skippedBundles（未被版本闸门拒绝）
```

界面走的是 `installBundle` 服务，与原始 pnpm 命令不完全相同。若遇到下列报错，按对应方式处理。

#### `ERR_PNPM_ADDING_TO_ROOT`

```
Running this command will add the dependency to the workspace root,
which might not be what you want...
```

profile 的 `pnpm-workspace.yaml` 含 `packages: [.]`，pnpm 因此拒绝往 workspace 根添加依赖。
在该文件追加：

```yaml
ignore-workspace-root-check: true
```

或改用 CLI 显式带 `-w`：

```powershell
dsh plugin --profile <profile> add -w github:bigdiliu777/dsh-plugin-closure-board
```

#### `git-hosted plugins build on install via their prepare script`

pnpm 11 默认拦截依赖的构建脚本。本包**没有** `prepare` / `build` 脚本，通常不会触发；
若触发，pnpm 会打印需要批准的精确键，按提示加到 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  - dsh-plugin-closure-board
```

#### 装完看不到面板

1. 确认 profile 的 `package.json` 里 `dsh.profile.bundles` 出现了 `dsh-plugin-closure-board`
2. 确认 `node_modules/dsh-plugin-closure-board/lib/client.js` 存在
3. 重启 DSH —— bundle 选择变更不一定热生效
4. 仍不行 → 见下方「兼容性」里的四步自查

## 更新

插件是**安装时的一份副本**，不是软链到 GitHub。仓库更新后，已安装的实例不会自动跟随。

### UI

1. 插件页 → 红色按钮 **卸载**
2. 插件列表 → **添加插件** → 粘贴同一个地址 → 安装
3. 确认插件页版本号变成预期版本

### CLI

```powershell
dsh plugin --profile <profile> remove -w dsh-plugin-closure-board
dsh plugin --profile <profile> add -w github:bigdiliu777/dsh-plugin-closure-board#v0.2.1
```

**必须先卸载**：`github:` 依赖会在 `pnpm-lock.yaml` 里固定成某个 commit SHA，
spec 不变时 pnpm 认为已满足，直接重装很可能拿不到新代码。

带 `#v0.2.1` 让版本可复现；不带则跟随默认分支 HEAD。

### 怎么确认真的更新了

插件页的版本号**可能来自启动时的清单缓存**。更可靠的判断是打开面板，看底部：

```
closure-board v0.2.1                        <kit 根目录>
```

这个数字是编译进 bundle 的常量，面板显示什么版本，跑的就是什么版本。

> 发版时注意：`package.json` 的 `version` 与 `lib/client.js` 里的 `VERSION` 必须同步。

### 开发态（本机软链）

如果 profile 里是指向源码的 junction，代码永远实时生效，无需"更新"；
只有面板底部那个版本号需要重启 DSH 才会刷新。

## 多个 change 的组织

一个长会话会连续做多个 change。面板**按项目列出全部 change**，而不是只显示当前那一个——
否则前面做完但有遗留的 change 会被新的直接盖掉，再也看不见。

三段，按需要关注的程度排序：

| 段 | 判据 | 默认形态 |
| --- | --- | --- |
| **当前** | `session-state.json` 的 `active_change` | 完整展开（阶段、问题、任务） |
| **待处理** | 非当前，且有 error **或** 阶段未全绿 | 折叠成计数，点击展开（默认收起，按 error 数降序） |
| **已完成** | 非当前，阶段全绿且零 error | 折叠成计数，点击展开 |
| **历史** | 非当前，任务清单里**没有收尾三任务**（规范前或已废弃） | 折叠成计数，点击展开 |

"待处理"里既有"做完了但有遗留"的，也有"做到一半被切走"的——两者都需要被看见。

**历史**单独成档，因为一个老项目可能有几十个规范确立之前建的 change：
每个都缺收尾三任务、阶段永远停在 3/7，混进"待处理"会把真正该做的事埋掉。
这类 change 只报一条 warn（"任务清单缺少收尾三任务"），不再报三条 error。
排序上**待处理永远在已完成之前**，哪怕它更老。两个段落默认都收起——几十个历史 change
一次性铺开等于什么也没说，先给数量，需要时再看。

### 非当前 change 的"收口"怎么判断

只有活跃 change 能通过 session 证明收口。其它 change 一律以 **`.archived` 标记**为依据：

> `change_archive.py` 只有在 session 已 closed 时才肯写这个标记，所以"已归档"蕴含"曾收口"。

同时这也意味着：**一个已经收口但忘了归档的 change，会被列进"待处理"**——这是刻意的，
因为闭环的完成出口本来就包含正式归档。

### 成本

非当前 change 只给 6 次路径探测预算（当前 change 是 40）。它们的档位由阶段条决定，
而阶段条是便宜的；对每个历史 change 每 2 秒都做完整证据核对，代价远大于收益。
目录枚举上限 40 个。

## 兼容性

依赖 DSH 的浏览器插件契约：`window.__ModuleLoader__.load`、平台模块表里的 `react`，
以及 `slots` / `sessions` / `remote.workspaceFiles` / `sidebarRight` / `sidebarRightTabs` 五个服务名。

DSH 升级若改动这些名字，插件会**静默不激活**（按钮消失、无报错）。排查顺序：

1. header 右侧还有没有「闭环」按钮
2. 没有 → 检查 profile 侧 junction 是否还在、目标是否为空
3. 还在 → 「设置 → 插件」看本条目是否报告同步失败
4. 一切正常但面板空白 → 服务名变了，按新版包 README 修正模块级 `inject`

cordis 按 fiber 隔离故障，本插件失效**不会**影响 DSH 其他功能。

## 实现

无构建步骤、无第三方依赖。`lib/client.js` 是手写 ESM，遵循
`window.__ModuleLoader__.load({ id, factory })` 协议，由 Host 在 `/plugins` 下直接提供；
`lib/index.js` 是空的 host 半侧，只为让 Loader 看见这个条目。

设计过程、踩过的坑与验证方法见 [DESIGN.md](./DESIGN.md)。

## License

未声明。发布前需要确定。
