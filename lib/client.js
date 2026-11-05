window.__ModuleLoader__.load({
	id: "dsh-plugin-closure-board",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const h = react.createElement;

		/* ------------------------------------------------------------------ *
		 * Contract (mirrors .closure-kit/scripts/task_contract.py)
		 * ------------------------------------------------------------------ */

		/** Kit roots, most specific first: a migrated project root, then the source kit. */
		const KIT_ROOTS = ["", ".closure-kit/"];
		const SESSION_STATE = ".codex/session-state.json";
		const CHANGES_DIR = "openspec/changes";
		const TASK_RE = /^- \[([ xX])\]\s+(.*)$/;

		const TAB_ID = "dsh-plugin-closure-board";
		const TAB_KIND = "closure-board";

		const LEVEL_EVIDENCE = {
			lite: ["verification_evidence"],
			standard: ["green_evidence", "verification_evidence"],
			full: ["test_file", "red_evidence", "green_evidence", "verification_evidence"],
		};

		/** Evidence values that assert nothing (evidence-validity-gate rejects these). */
		const VAGUE_EVIDENCE = /^(ok|okay|pass|passed|done|yes|true|verified|n\/a|none|-+|\.{1,3}|已验证|测试通过|通过|正常|无问题|完成)[.!]?$/i;

		/** Only project-relative artifact paths are probed, never shell commands. */
		const PATH_TOKEN = /[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]*\.(?:json|md|log|txt|png|jpe?g|ya?ml)/g;

		const FIXED_IDS = {
			knowledge: "TASK-KNOWLEDGE",
			review: "TASK-REVIEW",
			final: "TASK-FINAL",
		};

		/* ------------------------------------------------------------------ *
		 * Data layer
		 * ------------------------------------------------------------------ */

		/** Remote calls may resolve to a value, a RemoteResult envelope, or throw. */
		function unwrap(value) {
			if (value && typeof value === "object" && "ok" in value) {
				return value.ok ? value.value : undefined;
			}
			return value;
		}

		function fieldOf(body, names) {
			for (const name of names) {
				const match = body.match(new RegExp("- " + name + ":\\s*([^\\n]*)"));
				if (match) return match[1].trim();
			}
			return "";
		}

		function parseTasks(text) {
			if (typeof text !== "string") return [];
			const lines = text.split(/\r?\n/);
			const tasks = [];
			for (let index = 0; index < lines.length; index += 1) {
				const match = TASK_RE.exec(lines[index].trim());
				if (!match) continue;
				const block = [];
				let cursor = index + 1;
				while (cursor < lines.length && !TASK_RE.test(lines[cursor].trim())) {
					block.push(lines[cursor]);
					cursor += 1;
				}
				index = cursor - 1;
				const title = match[2].trim();
				const body = block.join("\n");
				const level = fieldOf(body, ["task_level", "任务级别"]).toLowerCase();
				tasks.push({
					id: title.split(/\s+/)[0],
					title,
					checked: match[1].toLowerCase() === "x",
					level: LEVEL_EVIDENCE[level] ? level : "standard",
					body,
				});
			}
			return tasks;
		}

		function pathTokens(body) {
			const found = body.match(PATH_TOKEN) || [];
			const unique = [];
			for (const token of found) {
				const cleaned = token.replace(/^[./\\]+/, "").replace(/[.,;:]+$/, "");
				if (cleaned && !cleaned.includes("..") && unique.indexOf(cleaned) === -1) unique.push(cleaned);
			}
			return unique.slice(0, 12);
		}

		function isFixed(id) {
			return id.startsWith("TASK-KNOWLEDGE") || id.startsWith("TASK-REVIEW") || id.startsWith("TASK-FINAL");
		}

		function computeStages(session, hasAcceptance, tasks) {
			const byId = {};
			for (const task of tasks) byId[task.id] = task;
			const impl = tasks.filter((task) => !isFixed(task.id));
			const implDone = impl.length > 0 && impl.every((task) => task.checked);
			const isClosed = !!(session && String(session.status || "").toLowerCase() === "closed");
			const done = (id) => !!(byId[id] && byId[id].checked);
			const finalChecked = done(FIXED_IDS.final);
			return [
				{ id: "proposal", label: "提案", done: hasAcceptance, reason: "需要 proposal.md 的 「## 验收标准」" },
				{ id: "plan", label: "拆分", done: tasks.length > 0, reason: "tasks.md 尚无任务" },
				{
					id: "impl",
					label: "实施",
					done: implDone,
					active: !implDone && impl.length > 0,
					reason:
						impl.length === 0
							? "尚无实施任务"
							: "实施任务还有 " + impl.filter((task) => !task.checked).length + " 项未完成（不含收尾三任务）",
				},
				{ id: "knowledge", label: "知识", done: done(FIXED_IDS.knowledge), reason: FIXED_IDS.knowledge + " 未勾选" },
				{ id: "review", label: "审批", done: done(FIXED_IDS.review), reason: FIXED_IDS.review + " 未勾选" },
				{ id: "final", label: "验收", done: finalChecked, reason: FIXED_IDS.final + " 未勾选" },
				{
					id: "closed",
					label: "收口",
					done: isClosed && finalChecked,
					reason: isClosed && !finalChecked ? "会话已 closed，但 TASK-FINAL 未勾选" : "会话尚未 closed",
				},
			];
		}

		/**
		 * Demote stages whose underlying task already reports an error.
		 *
		 * A green tick over a hard finding is the exact lie this board exists to
		 * prevent, so an errored stage reverts to "not done" and becomes the next
		 * step — which is where the fix has to happen.
		 */
		function applyIssueGating(stages, issues) {
			const stageTask = { knowledge: FIXED_IDS.knowledge, review: FIXED_IDS.review, final: FIXED_IDS.final };
			const counts = Object.create(null);
			for (const issue of issues) {
				if (issue.level !== "error" || !issue.task) continue;
				counts[issue.task] = (counts[issue.task] || 0) + 1;
			}
			return stages.map((stage) => {
				const taskId = stageTask[stage.id];
				const count = taskId ? counts[taskId] || 0 : 0;
				if (!stage.done || count === 0) return stage;
				return { ...stage, done: false, active: true, dirty: true, reason: "有 " + count + " 项错误待处理" };
			});
		}

		/** One glanceable verdict for the whole change. */
		function verdictOf(data) {
			if (!data.changeId) return { key: "idle", label: "无活跃 change", color: COLORS.soft };
			const stages = data.stages || [];
			const errors = (data.issues || []).filter((issue) => issue.level === "error").length;
			const allDone = stages.length > 0 && stages.every((stage) => stage.done);
			const pending = stages.filter((stage) => !stage.done).length;
			if (allDone && errors === 0) return { key: "complete", label: "完整闭环", color: COLORS.done };
			if (data.closed) {
				return {
					key: "broken",
					label: "未完成闭环" + (pending > 0 ? " · " + pending + " 项待办" : ""),
					color: COLORS.error,
				};
			}
			if (errors > 0) return { key: "dirty", label: "进行中 · 有问题", color: COLORS.warn };
			return { key: "running", label: "进行中", color: COLORS.active };
		}

		/**
		 * Cross-check tasks.md against the artifacts it cites. Read-only: every
		 * finding is derived from a file that either exists or does not.
		 */
		async function findConflicts(ctx, root, changeId, session, tasks, proposalText, read) {
			const issues = [];
			const probes = new Map();
			const skipped = new Set();
			let budget = 40;
			/**
			 * Probe once per distinct path. Repeating the same stat for every task that
			 * cites it used to burn the budget and silently drop later findings — the
			 * worst of both: noise up front, missing evidence behind.
			 */
			const exists = async (path) => {
				if (probes.has(path)) return probes.get(path);
				budget -= 1;
				if (budget < 0) {
					skipped.add(path);
					return true;
				}
				let value = false;
				try {
					value = !!(await unwrap(await ctx.remote.workspaceFiles.stat(ctx.sessionId, root + path)));
				} catch (error) {
					value = false;
				}
				probes.set(path, value);
				return value;
			};
			const missing = new Map();
			const reportMissingPath = (taskId, token, label) => {
				let entry = missing.get(token);
				if (!entry) {
					entry = { label, tasks: [] };
					missing.set(token, entry);
				}
				if (taskId && entry.tasks.indexOf(taskId) === -1) entry.tasks.push(taskId);
			};

			const byId = {};
			for (const task of tasks) byId[task.id] = task;

			const review = byId[FIXED_IDS.review];
			if (review && review.checked) {
				const artifact = fieldOf(review.body, ["review_artifact"]) || "docs/verification/" + changeId + "/change-review.json";
				if (!(await exists(artifact))) reportMissingPath(FIXED_IDS.review, artifact, "批准报告不存在：");
			}

			const finalTask = byId[FIXED_IDS.final];
			if (finalTask && finalTask.checked) {
				const report = fieldOf(finalTask.body, ["project_closure_evidence"]);
				if (!report) {
					issues.push({ level: "error", task: FIXED_IDS.final, text: "缺少 project_closure_evidence" });
				} else if (!(await exists(report))) {
					reportMissingPath(FIXED_IDS.final, report, "验收报告不存在：");
				}
			}

			for (const task of tasks) {
				if (!task.checked) continue;
				const required = LEVEL_EVIDENCE[task.level] || [];
				const missing = required.filter((key) => !new RegExp("- " + key + ":\\s*\\S").test(task.body));
				if (missing.length > 0) {
					issues.push({ level: "warn", task: task.id, text: "已勾选但缺少 " + missing.join(" / ") });
				}
				for (const key of required) {
					const value = fieldOf(task.body, [key]).replace(/^[\x60"']|[\x60"']$/g, "").trim();
					if (value && VAGUE_EVIDENCE.test(value)) {
						issues.push({ level: "error", task: task.id, text: key + " 是空话：" + value });
					}
				}
				for (const token of pathTokens(task.body)) {
					if (await exists(token)) continue;
					reportMissingPath(task.id, token, "证据引用的路径不存在：");
				}
			}

			const closed = !!(session && String(session.status || "").toLowerCase() === "closed");
			if (closed && !(finalTask && finalTask.checked)) {
				issues.push({ level: "error", task: "", text: "会话已 closed，但 TASK-FINAL 未勾选" });
			}

			const activeTask = session && session.active_task ? String(session.active_task) : "";
			if (activeTask && !byId[activeTask]) {
				issues.push({ level: "warn", task: "", text: "session 的 active_task 不在 tasks.md：" + activeTask });
			}

			if (tasks.length > 0) {
				for (const id of [FIXED_IDS.knowledge, FIXED_IDS.review, FIXED_IDS.final]) {
					if (!byId[id]) issues.push({ level: "error", task: id, text: "缺少固定收尾任务" });
				}
			}
			if (typeof proposalText === "string") {
				if (!/##\s*验收标准/.test(proposalText)) {
					issues.push({ level: "error", task: "proposal", text: "缺少「## 验收标准」（Gate 1）" });
				}
				if (!/##\s*变更记忆/.test(proposalText)) {
					issues.push({ level: "warn", task: "proposal", text: "缺少「## 变更记忆」（Gate 2.2）" });
				}
			}
			if (typeof read === "function" && changeId) {
				const memory = await read(root + "docs/project-knowledge/change-memory/index.md");
				if (typeof memory === "string" && memory.indexOf(changeId) === -1) {
					issues.push({ level: "warn", task: "change-memory", text: "未登记 " + changeId });
				}
			}

			// One finding per missing artifact, naming every task that cites it.
			for (const [path, entry] of missing) {
				if (skipped.has(path)) continue;
				const head = entry.tasks[0] || "";
				const extra = entry.tasks.length > 1 ? "（共 " + entry.tasks.length + " 项引用）" : "";
				issues.push({ level: "error", task: head, tasks: entry.tasks, text: entry.label + path + extra });
			}
			if (skipped.size > 0) {
				issues.push({
					level: "warn",
					task: "",
					text: "路径探测预算耗尽，" + skipped.size + " 个路径未核对（结果可能不全）",
				});
			}

			return issues;
		}

		/**
		 * Which change the board speaks for: active_change -> last history entry ->
		 * the only change directory. With several candidates and no pointer the board
		 * stays silent rather than guess.
		 */
		async function resolveTarget(ctx, root, session) {
			const active = session && session.active_change ? String(session.active_change) : "";
			if (active) return { changeId: active, source: "active" };

			const history = Array.isArray(session && session.history) ? session.history : [];
			for (let i = history.length - 1; i >= 0; i -= 1) {
				const name = history[i] && history[i].change_name ? String(history[i].change_name) : "";
				if (name) return { changeId: name, source: "history" };
			}

			let entries = [];
			try {
				const listing = unwrap(await ctx.remote.workspaceFiles.list(ctx.sessionId, root + CHANGES_DIR));
				entries = ((listing && listing.entries) || [])
					.map((entry) => (typeof entry === "string" ? entry : entry && entry.name))
					.filter((name) => typeof name === "string" && name.length > 0 && !name.startsWith(".") && name !== "archive");
			} catch (error) {
				entries = [];
			}
			if (entries.length === 1) return { changeId: entries[0], source: "only" };
			return { changeId: "", source: "none" };
		}

		function neutral(root, session) {
			return {
				root,
				session,
				changeId: "",
				source: "none",
				archived: false,
				closed: false,
				hasProposal: false,
				hasTasks: false,
				hasAcceptance: false,
				tasks: [],
				stages: [],
				issues: [],
			};
		}

		/** Probe every kit root and assemble one snapshot; undefined means "no kit here". */
		async function collect(ctx) {
			const read = async (path) => {
				try {
					const result = unwrap(await ctx.remote.workspaceFiles.read(ctx.sessionId, path, { limit: 5000 }));
					return result && typeof result.text === "string" ? result.text : undefined;
				} catch (error) {
					return undefined;
				}
			};
			const exists = async (path) => {
				try {
					return !!(await unwrap(await ctx.remote.workspaceFiles.stat(ctx.sessionId, path)));
				} catch (error) {
					return false;
				}
			};

			for (const root of KIT_ROOTS) {
				// Only the session state proves the kit is wired. AGENTS.md is universal
				// and would make every repository look like a closure project.
				const sessionText = await read(root + SESSION_STATE);
				if (sessionText === undefined) continue;

				let session = null;
				if (typeof sessionText === "string") {
					try {
						session = JSON.parse(sessionText);
					} catch (error) {
						session = null;
					}
				}

				const target = await resolveTarget(ctx, root, session);
				const changeId = target.changeId;
				const changeBase = root + CHANGES_DIR + "/" + changeId + "/";
				const proposalText = changeId ? await read(changeBase + "proposal.md") : undefined;
				const tasksText = changeId ? await read(changeBase + "tasks.md") : undefined;

				if (!changeId || (proposalText === undefined && tasksText === undefined)) {
					return neutral(root, session);
				}

				const tasks = parseTasks(tasksText);
				const hasAcceptance = typeof proposalText === "string" && /##\s*验收标准/.test(proposalText);
				const issues = await findConflicts(ctx, root, changeId, session, tasks, proposalText, read);
				const archived = await exists(changeBase + ".archived");

				return {
					root,
					session,
					changeId,
					source: target.source,
					archived,
					closed: !!(session && String(session.status || "").toLowerCase() === "closed"),
					hasProposal: typeof proposalText === "string",
					hasTasks: typeof tasksText === "string",
					hasAcceptance,
					tasks,
					stages: applyIssueGating(computeStages(session, hasAcceptance, tasks), issues),
					issues,
				};
			}
			return undefined;
		}

		/* ------------------------------------------------------------------ *
		 * Presentation
		 * ------------------------------------------------------------------ */

		const COLORS = {
			text: "rgba(235,238,245,0.94)",
			dim: "rgba(235,238,245,0.56)",
			soft: "rgba(235,238,245,0.30)",
			done: "#5fbf7f",
			active: "#6aa9ff",
			warn: "#e0a03a",
			error: "#e5695f",
			border: "rgba(255,255,255,0.10)",
			panel: "rgba(255,255,255,0.05)",
		};

		function mark(state) {
			if (state === "done") return "✓";
			if (state === "active") return "▸";
			if (state === "error") return "✕";
			return "○";
		}

		function Chip({ text, color }) {
			return h(
				"span",
				{
					style: {
						flex: "0 0 auto",
						fontSize: "10px",
						lineHeight: "14px",
						padding: "0 5px",
						borderRadius: "7px",
						color,
						border: "1px solid " + color,
						opacity: 0.85,
					},
				},
				text,
			);
		}

		function StageRow({ stages }) {
			return h(
				"div",
				{ style: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" } },
				...stages.map((stage) =>
					h(
						"span",
						{
							key: stage.id,
							title: stage.done ? "" : stage.reason || "",
							style: {
								display: "inline-flex",
								alignItems: "center",
								gap: "4px",
								fontSize: "12px",
								lineHeight: "16px",
								cursor: stage.done ? "default" : "help",
								color: stage.done ? COLORS.done : stage.dirty ? COLORS.warn : stage.active ? COLORS.active : COLORS.soft,
								textDecoration: stage.done ? "line-through" : "none",
							},
						},
						h(
							"span",
							{ style: { fontSize: "10px" } },
							stage.done ? mark("done") : stage.dirty ? "⚠" : stage.active ? mark("active") : mark("idle"),
						),
						stage.label,
					),
				),
			);
		}

		/**
		 * One finding. A grouped finding (one missing artifact cited by several tasks)
		 * expands on click into the exact task ids, so the reader can tell whether every
		 * citation is legitimate or some evidence text needs rewriting.
		 */
		function IssueLine({ issue }) {
			const isError = issue.level === "error";
			const color = isError ? COLORS.error : COLORS.warn;
			const tasks = issue.tasks && issue.tasks.length ? issue.tasks : issue.task ? [issue.task] : [];
			const grouped = tasks.length > 1;
			const [open, setOpen] = react.useState(false);
			return h(
				"div",
				{ style: { padding: "2px 0" } },
				h(
					"div",
					{
						role: grouped ? "button" : undefined,
						onClick: grouped ? () => setOpen((value) => !value) : undefined,
						title: grouped ? (open ? "收起引用任务" : "展开引用任务") : "",
						style: {
							display: "flex",
							gap: "6px",
							color,
							fontSize: "11px",
							lineHeight: "16px",
							cursor: grouped ? "pointer" : "default",
							userSelect: grouped ? "none" : "auto",
						},
					},
					h("span", { style: { flex: "0 0 auto" } }, isError ? "✕" : "⚠"),
					h(
						"span",
						{ style: { flex: "0 0 auto", minWidth: "78px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: 0.85 } },
						issue.task || "会话",
					),
					h("span", { style: { minWidth: 0, flex: "1 1 auto", wordBreak: "break-word" } }, issue.text),
					grouped ? h("span", { style: { flex: "0 0 auto", fontSize: "10px", opacity: 0.75 } }, open ? "▴" : "▾") : null,
				),
				grouped && open
					? h(
							"div",
							{
								style: {
									marginLeft: "18px",
									marginTop: "2px",
									color: COLORS.dim,
									fontSize: "10px",
									lineHeight: "15px",
									fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
									wordBreak: "break-word",
								},
							},
							tasks.join(" · "),
						)
					: null,
			);
		}

		function TaskRow({ task, current, badTasks }) {
			const bad = badTasks.indexOf(task.id) !== -1;
			const color = task.checked ? (bad ? COLORS.warn : COLORS.done) : current ? COLORS.active : COLORS.dim;
			return h(
				"div",
				{ style: { display: "flex", alignItems: "baseline", gap: "6px", padding: "2px 0", color, fontSize: "12px", lineHeight: "18px" } },
				h("span", { style: { fontSize: "10px", width: "10px", flex: "0 0 auto" } }, mark(task.checked ? "done" : current ? "active" : "idle")),
				h(
					"span",
					{
						style: {
							flex: "1 1 auto",
							minWidth: 0,
							textDecoration: task.checked ? "line-through" : "none",
							opacity: task.checked ? 0.82 : 1,
							wordBreak: "break-word",
						},
					},
					task.title,
				),
				bad ? h("span", { style: { color: COLORS.warn, fontSize: "10px", flex: "0 0 auto" }, title: "证据不一致" }, "⚠") : null,
				h("span", { style: { color: COLORS.soft, fontSize: "10px", flex: "0 0 auto" } }, task.level),
			);
		}

		const MAX_ISSUES = 4;

		/* ------------------------------------------------------------------ *
		 * Shared feed: the header button owns the poll, the tab body subscribes
		 * ------------------------------------------------------------------ */

		let feed = { phase: "loading", data: undefined };
		const feedListeners = new Set();
		function publishFeed(next) {
			feed = next;
			for (const listener of feedListeners) listener();
		}
		function subscribeFeed(listener) {
			feedListeners.add(listener);
			return () => feedListeners.delete(listener);
		}
		function useFeed() {
			return react.useSyncExternalStore(subscribeFeed, () => feed);
		}

		/** Poll one snapshot on an interval and publish it to every seat. */
		function usePoll(sessionId, readSnapshot) {
			const readerRef = react.useRef(readSnapshot);
			readerRef.current = readSnapshot;
			react.useEffect(() => {
				let cancelled = false;
				async function tick() {
					const reader = readerRef.current;
					if (!sessionId || typeof reader !== "function") return;
					let data;
					try {
						data = await reader();
					} catch (error) {
						data = undefined;
					}
					if (cancelled) return;
					publishFeed({ phase: data === undefined ? "absent" : "ready", data });
				}
				tick();
				const timer = setInterval(tick, 2000);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [sessionId]);
		}

		/** Header button: always mounted, so it also owns the poll. Opens the tab. */
		function OpenButton(props) {
			const { sessionId, readSnapshot, openPanel } = props;
			usePoll(sessionId, readSnapshot);
			const snapshot = useFeed();
			// An absent kit is not a failure: stay out of the way entirely.
			if (snapshot.phase !== "ready" || !snapshot.data) return null;
			const data = snapshot.data;
			const verdict = verdictOf(data);
			const done = (data.stages || []).filter((stage) => stage.done).length;
			const total = (data.stages || []).length;

			return h(
				"button",
				{
					type: "button",
					onClick: openPanel,
					title: "闭环流程面板\n" + (data.changeId || "无活跃 change") + " · " + verdict.label,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: "5px",
						height: "24px",
						padding: "0 7px",
						borderRadius: "6px",
						background: "transparent",
						border: "1px solid " + verdict.color,
						color: verdict.color,
						fontSize: "11px",
						lineHeight: "1",
						cursor: "pointer",
						opacity: 0.95,
					},
				},
				h("span", { style: { fontSize: "9px" } }, verdict.key === "complete" ? "✓" : verdict.key === "running" || verdict.key === "idle" ? "○" : "⚠"),
				"闭环",
				total > 0 ? h("span", { style: { fontVariantNumeric: "tabular-nums" } }, done + "/" + total) : null,
			);
		}

		/** Tab body: the full board, rendered as a normal column in the right sidebar. */
		function BoardBody(props) {
			const { sessionId, readSnapshot } = props;
			usePoll(sessionId, readSnapshot);
			const snapshot = useFeed();
			const [showAllIssues, setShowAllIssues] = react.useState(false);
			const [copied, setCopied] = react.useState(false);

			if (snapshot.phase !== "ready" || !snapshot.data) {
				return h(
					"div",
					{ style: { padding: "14px 12px", color: COLORS.soft, fontSize: "12px", lineHeight: "18px" } },
					"当前项目未接入闭环",
					h(
						"div",
						{ style: { marginTop: "4px", fontSize: "11px", opacity: 0.7 } },
						"未找到 .codex/session-state.json 或 AGENTS.md，无需处理。",
					),
				);
			}

			const data = snapshot.data;

			// Kit present but nothing to report: one quiet statement, no empty stage rail.
			if (!data.changeId) {
				return h(
					"div",
					{ style: { padding: "14px 12px", color: COLORS.soft, fontSize: "12px", lineHeight: "18px" } },
					"无活跃 change",
					h(
						"div",
						{ style: { marginTop: "4px", fontSize: "11px", opacity: 0.7 } },
						"kit 已就绪：" + (data.root || ".") + "。开始一个 change 后这里会显示阶段与任务。",
					),
				);
			}

			const stages = data.stages || [];
			const tasks = data.tasks || [];
			const issues = data.issues || [];
			const doneCount = stages.filter((stage) => stage.done).length;
			const errorCount = issues.filter((issue) => issue.level === "error").length;
			const verdict = verdictOf(data);
			const allStagesDone = stages.length > 0 && stages.every((stage) => stage.done);
			const dirtyStages = stages.filter((stage) => !stage.done && stage.dirty);
			const nextStage = stages.filter((stage) => !stage.done)[0];
			const session = data.session || null;
			const currentTaskId = session && session.active_task ? String(session.active_task) : "";
			const blocker = session && session.blocker ? String(session.blocker) : "";
			const badTasks = issues.flatMap((issue) => (issue.tasks && issue.tasks.length ? issue.tasks : issue.task ? [issue.task] : []));
			const issueText = issues
				.map((issue) => "- [" + issue.level + "] " + (issue.task ? issue.task + " " : "") + issue.text)
				.join("\n");

			const copyIssues = () => {
				try {
					const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
					if (!clipboard || typeof clipboard.writeText !== "function") return;
					clipboard.writeText(issueText).then(
						() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						},
						() => {},
					);
				} catch (error) {
					// Clipboard denial is not a board failure.
				}
			};

			return h(
				"div",
				{ style: { padding: "10px 12px 16px", color: COLORS.text, fontSize: "12px", borderLeft: "2px solid " + verdict.color } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
					h(Chip, { text: verdict.label, color: verdict.color }),
					data.archived ? h(Chip, { text: "已归档", color: COLORS.dim }) : null,
					h("span", { style: { flex: "1 1 auto" } }),
					h("span", { style: { color: verdict.key === "complete" ? COLORS.dim : verdict.color, fontSize: "11px", fontVariantNumeric: "tabular-nums" } }, doneCount + "/" + stages.length),
				),
				h(
					"div",
					{
						title: data.changeId,
						style: {
							marginTop: "6px",
							color: COLORS.text,
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
							fontSize: "13px",
							fontWeight: 500,
							lineHeight: "18px",
							wordBreak: "break-all",
						},
					},
					data.changeId || "无活跃 change",
				),
				data.closed || data.source !== "active"
					? h(
							"div",
							{ style: { marginTop: "6px", fontSize: "11px", color: COLORS.dim } },
							data.closed && (issues.length > 0 || !allStagesDone)
								? "会话已关闭，但流程未走完"
								: data.closed
									? "无遗留问题"
									: "上次会话未激活",
							issues.length > 0 ? h("span", { style: { color: COLORS.warn } }, " · 仍有 " + issues.length + " 项待处理") : null,
						)
					: null,
				stages.length > 0 ? h(StageRow, { stages }) : null,
				nextStage
					? h(
							"div",
							{ style: { marginTop: "8px", color: COLORS.dim, fontSize: "11px" } },
							"下一步：",
							h("span", { style: { color: COLORS.active } }, nextStage.label),
							" — ",
							nextStage.reason || "",
						)
					: null,
				dirtyStages.length > 0
					? h("div", { style: { marginTop: "3px", fontSize: "11px", color: COLORS.warn } }, "⚠ 勾了但有问题：", dirtyStages.map((stage) => stage.label).join(" · "))
					: null,
				currentTaskId || blocker
					? h(
							"div",
							{ style: { marginTop: "4px", color: COLORS.dim, fontSize: "11px" } },
							currentTaskId ? h("span", null, "当前 ", h("span", { style: { color: COLORS.active } }, currentTaskId)) : null,
							blocker ? h("span", { style: { color: COLORS.warn } }, " · 阻塞 ", blocker) : null,
						)
					: null,
				data.changeId && !data.hasTasks ? h("div", { style: { marginTop: "6px", color: COLORS.warn, fontSize: "11px" } }, "缺少 tasks.md") : null,
				issues.length > 0
					? h(
							"div",
							{ style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid " + COLORS.border } },
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" } },
								h(
									"span",
									{ role: "button", onClick: copyIssues, title: "复制问题清单（可直接交给 agent）", style: { fontSize: "11px", color: COLORS.dim, cursor: "pointer", userSelect: "none" } },
									copied ? "已复制" : "复制清单",
								),
								h("span", { style: { flex: "1 1 auto" } }),
								h("span", { style: { fontSize: "10px", color: errorCount > 0 ? COLORS.error : COLORS.warn } }, errorCount > 0 ? errorCount + " error" : "warn only"),
							),
							...(showAllIssues ? issues : issues.slice(0, MAX_ISSUES)).map((issue, index) => h(IssueLine, { key: issue.task + "|" + (issue.text || "").slice(0, 24) + "|" + index, issue })),
							issues.length > MAX_ISSUES
								? h(
										"div",
										{ role: "button", onClick: () => setShowAllIssues((value) => !value), style: { color: COLORS.dim, fontSize: "10px", paddingTop: "3px", cursor: "pointer", userSelect: "none" } },
										showAllIssues ? "收起 ▴" : "还有 " + (issues.length - MAX_ISSUES) + " 条，点击展开 ▾",
									)
								: null,
						)
					: null,
				tasks.length > 0
					? h(
							"div",
							{ style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid " + COLORS.border } },
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" } },
								h("span", { style: { fontSize: "11px", color: COLORS.dim } }, "任务"),
								h("span", { style: { flex: "1 1 auto" } }),
								h(
									"span",
									{ style: { fontSize: "11px", color: COLORS.dim, fontVariantNumeric: "tabular-nums" } },
									tasks.filter((task) => task.checked).length + "/" + tasks.length,
								),
							),
							...tasks.map((task) => h(TaskRow, { key: task.id, task, current: task.id === currentTaskId, badTasks })),
						)
					: null,
			);
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		const inject = ["slots", "sessions", "remote", "remote.workspaceFiles", "sidebarRight", "sidebarRightTabs"];

		function apply(ctx) {
			const face = (sessionId) => ({
				sessionId,
				readSnapshot: () => collect({ sessionId, remote: ctx.remote }),
				openPanel: () => {
					try {
						ctx.sidebarRight.openTab(TAB_KIND);
					} catch (error) {
						// Wiring failure stays silent rather than breaking the header.
					}
				},
			});

			// The tab type: a "page" type opened by kind, with a guide entry so it is discoverable.
			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						multiple: false,
						keepMounted: false,
						priority: "builtin",
						title: () => "闭环",
						guide: [
							{
								id: "closure-board",
								order: 40,
								title: () => "闭环流程",
								description: () => "阶段进度与 tasks.md 勾选状态",
							},
						],
					}),
				"closure-board: tab type",
			);

			// The body, keyed by the definition id.
			ctx.slots.inject("sidebar.right.pane.tab", () =>
				ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, inject: face }, BoardBody),
			);

			// A normal header button (in-flow, never overlaying) is the entry point.
			ctx.slots.inject("conversation.session.header.utilities", () =>
				ctx.slots.register({ name: "conversation.session.header.utilities", id: "closure-board-open", order: 5, inject: face }, OpenButton),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = { parseTasks, computeStages, applyIssueGating, verdictOf, collect, findConflicts, pathTokens, KIT_ROOTS };
		return module.exports;
	},
});
