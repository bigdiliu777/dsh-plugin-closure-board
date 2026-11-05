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
