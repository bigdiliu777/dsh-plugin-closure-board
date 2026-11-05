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

		/**
		 * Build stamp. Keep in sync with package.json: the plugin list can show a
		 * stale manifest, so the panel states its own version instead of relying on it.
		 */
		const VERSION = "0.2.11";

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
				// Strip a "./" prefix only: stripping any leading dot silently turned
				// ".closure/project-closure.yml" into "closure/…" and made a real file
				// look missing.
				const cleaned = token.replace(/^\.\//, "").replace(/^[\\/]+/, "").replace(/[.,;:]+$/, "");
				if (cleaned && !cleaned.includes("..") && unique.indexOf(cleaned) === -1) unique.push(cleaned);
			}
			// A shorthand tail of a longer path cited in the same block ("报告
			// project-closure/report.json" after the full path) is not a second artifact.
			const kept = unique.filter((token) => !unique.some((other) => other.length > token.length && other.endsWith("/" + token)));
			return kept.slice(0, 12);
		}

		function isFixed(id) {
			return id.startsWith("TASK-KNOWLEDGE") || id.startsWith("TASK-REVIEW") || id.startsWith("TASK-FINAL");
		}

		function computeStages(isClosed, hasAcceptance, tasks) {
			const byId = {};
			for (const task of tasks) byId[task.id] = task;
			const impl = tasks.filter((task) => !isFixed(task.id));
			const implDone = impl.length > 0 && impl.every((task) => task.checked);
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

		/** Is this change genuinely finished: every stage green and nothing flagged. */
		function isCompleteChange(change) {
			const stages = change.stages || [];
			const errors = (change.issues || []).filter((issue) => issue.level === "error").length;
			return stages.length > 0 && stages.every((stage) => stage.done) && errors === 0;
		}

		/**
		 * A change whose tasks.md has none of the three fixed tail tasks.
		 *
		 * That is the signature of a change written before the tail-task convention
		 * existed (or one that ignored it). They are not actionable one by one, and
		 * grouping them separately keeps them from burying the changes that are.
		 */
		function isLegacy(change) {
			const tasks = change.tasks || [];
			if (tasks.length === 0) return false;
			const ids = tasks.map((task) => task.id);
			return !ids.some((id) => id.startsWith("TASK-KNOWLEDGE") || id.startsWith("TASK-REVIEW") || id.startsWith("TASK-FINAL"));
		}

		/** Which band a change sits in. */
		function kindOf(change) {
			if (change.isActive) return "active";
			if (isLegacy(change)) return "legacy";
			return isCompleteChange(change) ? "done" : "pending";
		}

		/** One glanceable verdict. "In progress" only applies to the change the session owns. */
		function verdictOf(change, isActive) {
			if (!change || !change.changeId) return { key: "idle", label: "无活跃 change", color: COLORS.soft };
			const stages = change.stages || [];
			const errors = (change.issues || []).filter((issue) => issue.level === "error").length;
			const allDone = stages.length > 0 && stages.every((stage) => stage.done);
			const pending = stages.filter((stage) => !stage.done).length;
			if (allDone && errors === 0) return { key: "complete", label: "完整闭环", color: COLORS.done };
			if (isActive) {
				if (change.closed) {
					return { key: "broken", label: "未完成闭环" + (pending ? " · " + pending + " 项待办" : ""), color: COLORS.error };
				}
				if (errors > 0) return { key: "dirty", label: "进行中 · 有问题", color: COLORS.warn };
				return { key: "running", label: "进行中", color: COLORS.active };
			}
			if (errors > 0) return { key: "stale-bad", label: "有遗留问题", color: COLORS.error };
			return { key: "stale-open", label: "未走完", color: COLORS.warn };
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
				const absentTail = [FIXED_IDS.knowledge, FIXED_IDS.review, FIXED_IDS.final].filter((id) => !byId[id]);
				if (absentTail.length === 3) {
					// A list with no tail at all predates the convention: one note, not three errors.
					issues.push({ level: "warn", task: "", text: "任务清单缺少收尾三任务（规范前或已废弃的 change）" });
				} else {
					for (const id of absentTail) issues.push({ level: "error", task: id, text: "缺少固定收尾任务" });
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

		/** Hard sanity cap on the directory listing; reads are bounded separately. */
		const MAX_CHANGE_DIRS = 1000;

		/** How many stale changes one round re-reads, on top of the active one. */
		const SCAN_PER_ROUND = 8;

		/** Wall-clock guard: publish what we have rather than nothing. */
		const SCAN_BUDGET_MS = 4000;

		/** TTL while coverage is still filling in: fill fast. */
		const CACHE_TTL_FILL_MS = 30000;

		/**
		 * TTL once every change is cached.
		 *
		 * Refreshing 275 historical changes every minute kept the board permanently
		 * reading files over SSH for no visible benefit. A finished change changes
		 * rarely; five minutes is enough to notice an edit without spinning.
		 */
		const CACHE_TTL_IDLE_MS = 300000;

		/**
		 * Scanned change snapshots, keyed by kit root + change id.
		 *
		 * A remote workspace makes every read a round trip, so a full rescan per poll
		 * can never finish. Instead each round re-reads the active change plus a slice
		 * of the oldest entries and serves the rest from here; successive rounds rotate,
		 * so coverage grows until everything is cached and then simply refreshes.
		 */
		const changeCache = new Map();
		const scanCursors = new Map();

		async function listChangeNames(ctx, root) {
			try {
				const listing = unwrap(await ctx.remote.workspaceFiles.list(ctx.sessionId, root + CHANGES_DIR));
				const all = ((listing && listing.entries) || [])
					.map((entry) => (typeof entry === "string" ? entry : entry && entry.name))
					.filter((name) => typeof name === "string" && name.length > 0 && !name.startsWith(".") && name !== "archive");
				return { total: all.length, names: all.slice(0, MAX_CHANGE_DIRS) };
			} catch (error) {
				return { total: 0, names: [] };
			}
		}

		/** Build one change snapshot from disk. Returns undefined when the directory has nothing to read. */
		async function buildChange(ctx, root, name, activeId, session, read, exists) {
			const base = root + CHANGES_DIR + "/" + name + "/";
			const proposalText = await read(base + "proposal.md");
			const tasksText = await read(base + "tasks.md");
			if (proposalText === undefined && tasksText === undefined) return undefined;

			const isActive = name === activeId;
			const scope = isActive ? session : null;
			const archived = await exists(base + ".archived");
			// Only the active change proves closure through the session. For every other
			// change the archive marker is the proof: change_archive.py refuses to write
			// it unless the session was closed.
			const sessionClosed = !!(scope && String(scope.status || "").toLowerCase() === "closed");
			const closedFlag = isActive ? sessionClosed : archived;
			const tasks = parseTasks(tasksText);
			const hasAcceptance = typeof proposalText === "string" && /##\s*验收标准/.test(proposalText);
			const issues = await findConflicts(ctx, root, name, scope, tasks, proposalText, read, isActive ? 40 : 6);
			const stages = applyIssueGating(computeStages(closedFlag, hasAcceptance, tasks), issues);

			return {
				changeId: name,
				isActive,
				archived,
				closed: closedFlag,
				activeTask: isActive && scope && scope.active_task ? String(scope.active_task) : "",
				blocker: isActive && scope && scope.blocker ? String(scope.blocker) : "",
				hasProposal: typeof proposalText === "string",
				hasTasks: typeof tasksText === "string",
				hasAcceptance,
				tasks,
				stages,
				issues,
			};
		}

		/**
		 * Snapshot the whole project.
		 *
		 * One round = the active change (always rebuilt, published first) + up to
		 * SCAN_PER_ROUND stale entries, rotated by a cursor. Everything already cached
		 * is served as-is, so the board keeps showing what it has learned and fills in
		 * progressively instead of rescanning 275 directories every two seconds.
		 */
		async function collect(ctx, publish) {
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

			const trace = [];
			for (const root of KIT_ROOTS) {
				// Only the session state proves the kit is wired. AGENTS.md is universal
				// and would make every repository look like a closure project.
				const sessionText = await read(root + SESSION_STATE);
				if (sessionText === undefined) {
					trace.push({ root: root || "./", state: "missing " + SESSION_STATE, changes: 0 });
					continue;
				}

				let session = null;
				if (typeof sessionText === "string") {
					try {
						session = JSON.parse(sessionText);
					} catch (error) {
						session = null;
					}
				}
				const activeId = session && session.active_change ? String(session.active_change) : "";
				const names = await listChangeNames(ctx, root);
				const total = names.total;
				const keyOf = (name) => root + "\u0000" + name;

				// Drop cache entries whose directory is gone.
				const live = new Set(names.names);
				for (const key of Array.from(changeCache.keys())) {
					if (!key.startsWith(root + "\u0000")) continue;
					const changeName = key.slice(root.length + 1);
					if (!live.has(changeName)) changeCache.delete(key);
				}

				const now = Date.now();
				let cachedCount = 0;
				for (const key of changeCache.keys()) if (key.startsWith(root + "\u0000")) cachedCount += 1;
				// Full coverage means every directory already has a snapshot, so the sweep
				// can slow down instead of hammering the filesystem forever.
				const ttl = cachedCount >= names.names.length ? CACHE_TTL_IDLE_MS : CACHE_TTL_FILL_MS;
				const others = names.names.filter((name) => name !== activeId);
				const startIndex = others.length ? (scanCursors.get(root) || 0) % others.length : 0;
				const order = [];
				if (activeId) order.push(activeId);
				for (let i = 0; i < others.length; i += 1) order.push(others[(startIndex + i) % others.length]);
				scanCursors.set(root, startIndex + SCAN_PER_ROUND);

				const startedAt = Date.now();
				const changes = [];
				let rescanned = 0;

				for (const name of order) {
					const isActive = name === activeId;
					const cached = changeCache.get(keyOf(name));

					if (!isActive && cached && now - cached.at < ttl) {
						changes.push(cached.snapshot);
						continue;
					}
					// Budget applies only to non-active entries, and only to new reads.
					if (!isActive && rescanned >= SCAN_PER_ROUND) {
						if (cached) changes.push(cached.snapshot);
						continue;
					}
					if (!isActive && changes.length > 0 && Date.now() - startedAt > SCAN_BUDGET_MS) {
						if (cached) changes.push(cached.snapshot);
						continue;
					}

					const built = await buildChange(ctx, root, name, activeId, session, read, exists);
					if (!built) continue;
					changeCache.set(keyOf(name), { snapshot: built, at: Date.now() });
					changes.push(built);
					if (!isActive) rescanned += 1;
					// The change being worked on is painted before the rest catches up.
					if (isActive && typeof publish === "function") {
						publish({ root, activeId, changes: changes.slice(), trace: trace.slice(), total, scanned: changes.length });
					}
				}

				const rank = (change) => (change.isActive ? 0 : isLegacy(change) ? 3 : isCompleteChange(change) ? 2 : 1);
				changes.sort((a, b) => rank(a) - rank(b) || a.changeId.localeCompare(b.changeId));

				trace.push({ root: root || "./", state: "found " + SESSION_STATE, changes: changes.length });
				return { root, activeId, changes, trace, total, scanned: changes.length };
			}
			return { root: "", activeId: "", changes: [], trace, total: 0, scanned: 0 };
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

		/**
		 * Poll one snapshot and publish it to every seat.
		 *
		 * Self-scheduling rather than setInterval: over a remote workspace one scan can
		 * take longer than the interval, and overlapping scans would pile up reads on a
		 * filesystem where every read is a round trip.
		 */
		function usePoll(sessionId, readSnapshot) {
			const readerRef = react.useRef(readSnapshot);
			readerRef.current = readSnapshot;
			react.useEffect(() => {
				let cancelled = false;
				let timer = null;
				async function tick() {
					const reader = readerRef.current;
					if (!sessionId || typeof reader !== "function") return;
					// Hidden tab: keep the timer alive so the panel is fresh on return, but
					// stop spending round trips on files nobody is looking at.
					const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
					if (hidden) {
						timer = setTimeout(tick, 10000);
						return;
					}
					let data;
					try {
						data = await reader();
					} catch (error) {
						data = undefined;
					}
					if (cancelled) return;
					publishFeed({ phase: data === undefined ? "absent" : "ready", data });
					timer = setTimeout(tick, 2000);
				}
				tick();
				return () => {
					cancelled = true;
					if (timer) clearTimeout(timer);
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
			const changes = data.changes || [];
			if (!changes.length) return null;

			const active = changes.filter((change) => change.isActive)[0];
			const pending = changes.filter((change) => kindOf(change) === "pending");
			let icon = "\u2713";
			let color = COLORS.dim;
			let label = "\u95ed\u73af\u6d41\u7a0b\u9762\u677f\n\u5168\u90e8 change \u5df2\u5b8c\u6210";
			let progress = null;

			if (active) {
				const verdict = verdictOf(active, true);
				const stages = active.stages || [];
				icon = verdict.key === "complete" ? "\u2713" : verdict.key === "running" ? "\u25CB" : "\u26A0";
				color = verdict.color;
				progress = stages.filter((stage) => stage.done).length + "/" + stages.length;
				label = "\u95ed\u73af\u6d41\u7a0b\u9762\u677f\n" + active.changeId + " \u00b7 " + verdict.label + "\nv" + VERSION;
			} else if (pending.length > 0) {
				icon = "\u2715";
				color = COLORS.error;
				progress = String(pending.length);
				label = "\u95ed\u73af\u6d41\u7a0b\u9762\u677f\n" + pending.length + " \u4e2a change \u6709\u9057\u7559";
			}

			return h(
				"button",
				{
					type: "button",
					onClick: openPanel,
					title: label,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: "5px",
						height: "24px",
						padding: "0 7px",
						borderRadius: "6px",
						background: "transparent",
						border: "1px solid " + color,
						color,
						fontSize: "11px",
						lineHeight: "1",
						cursor: "pointer",
						opacity: 0.95,
					},
				},
				h("span", { style: { fontSize: "9px" } }, icon),
				"\u95ed\u73af",
				progress ? h("span", { style: { fontVariantNumeric: "tabular-nums" } }, progress) : null,
			);
		}

		/** Full detail for one change: stages, next step, findings, task list. */
		function ChangeDetail({ change, isActive }) {
			const [showAllIssues, setShowAllIssues] = react.useState(false);
			const [copied, setCopied] = react.useState(false);
			const stages = change.stages || [];
			const tasks = change.tasks || [];
			const issues = change.issues || [];
			const doneCount = stages.filter((stage) => stage.done).length;
			const errorCount = issues.filter((issue) => issue.level === "error").length;
			const verdict = verdictOf(change, isActive);
			const allStagesDone = stages.length > 0 && stages.every((stage) => stage.done);
			const dirtyStages = stages.filter((stage) => !stage.done && stage.dirty);
			const nextStage = stages.filter((stage) => !stage.done)[0];
			const currentTaskId = change.activeTask || "";
			const blocker = change.blocker || "";
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
				{ style: { marginTop: "6px", paddingLeft: "8px", borderLeft: "2px solid " + verdict.color } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
					h(Chip, { text: verdict.label, color: verdict.color }),
					change.archived ? h(Chip, { text: "\u5df2\u5f52\u6863", color: COLORS.dim }) : null,
					h("span", { style: { flex: "1 1 auto" } }),
					h(
						"span",
						{ style: { color: verdict.key === "complete" ? COLORS.dim : verdict.color, fontSize: "11px", fontVariantNumeric: "tabular-nums" } },
						doneCount + "/" + stages.length,
					),
				),
				h(
					"div",
					{
						title: change.changeId,
						style: {
							marginTop: "4px",
							color: COLORS.text,
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
							fontSize: "13px",
							fontWeight: 500,
							lineHeight: "18px",
							wordBreak: "break-all",
						},
					},
					change.changeId,
				),
				change.closed || !isActive
					? h(
							"div",
							{ style: { marginTop: "4px", fontSize: "11px", color: COLORS.dim } },
							change.closed && (issues.length > 0 || !allStagesDone)
								? "\u4f1a\u8bdd\u5df2\u5173\u95ed\uff0c\u4f46\u6d41\u7a0b\u672a\u8d70\u5b8c"
								: change.closed
									? "\u65e0\u9057\u7559\u95ee\u9898"
									: "\u4f1a\u8bdd\u672a\u6fc0\u6d3b",
							issues.length > 0 ? h("span", { style: { color: COLORS.warn } }, " \u00b7 \u4ecd\u6709 " + issues.length + " \u9879\u5f85\u5904\u7406") : null,
						)
					: null,
				stages.length > 0 ? h(StageRow, { stages }) : null,
				nextStage
					? h(
							"div",
							{ style: { marginTop: "8px", color: COLORS.dim, fontSize: "11px" } },
							"\u4e0b\u4e00\u6b65\uff1a",
							h("span", { style: { color: COLORS.active } }, nextStage.label),
							" \u2014 ",
							nextStage.reason || "",
						)
					: null,
				dirtyStages.length > 0
					? h("div", { style: { marginTop: "3px", fontSize: "11px", color: COLORS.warn } }, "\u26A0 \u52fe\u4e86\u4f46\u6709\u95ee\u9898\uff1a", dirtyStages.map((stage) => stage.label).join(" \u00b7 "))
					: null,
				currentTaskId || blocker
					? h(
							"div",
							{ style: { marginTop: "4px", color: COLORS.dim, fontSize: "11px" } },
							currentTaskId ? h("span", null, "\u5f53\u524d ", h("span", { style: { color: COLORS.active } }, currentTaskId)) : null,
							blocker ? h("span", { style: { color: COLORS.warn } }, " \u00b7 \u963b\u585e ", blocker) : null,
						)
					: null,
				!change.hasTasks ? h("div", { style: { marginTop: "6px", color: COLORS.warn, fontSize: "11px" } }, "\u7f3a\u5c11 tasks.md") : null,
				issues.length > 0
					? h(
							"div",
							{ style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid " + COLORS.border } },
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" } },
								h(
									"span",
									{ role: "button", onClick: copyIssues, title: "\u590d\u5236\u95ee\u9898\u6e05\u5355\uff08\u53ef\u76f4\u63a5\u4ea4\u7ed9 agent\uff09", style: { fontSize: "11px", color: COLORS.dim, cursor: "pointer", userSelect: "none" } },
									copied ? "\u5df2\u590d\u5236" : "\u590d\u5236\u6e05\u5355",
								),
								h("span", { style: { flex: "1 1 auto" } }),
								h("span", { style: { fontSize: "10px", color: errorCount > 0 ? COLORS.error : COLORS.warn } }, errorCount > 0 ? errorCount + " error" : "warn only"),
							),
							...(showAllIssues ? issues : issues.slice(0, MAX_ISSUES)).map((issue, index) => h(IssueLine, { key: issue.task + "|" + (issue.text || "").slice(0, 24) + "|" + index, issue })),
							issues.length > MAX_ISSUES
								? h(
										"div",
										{ role: "button", onClick: () => setShowAllIssues((value) => !value), style: { color: COLORS.dim, fontSize: "10px", paddingTop: "3px", cursor: "pointer", userSelect: "none" } },
										showAllIssues ? "\u6536\u8d77 \u25B4" : "\u8fd8\u6709 " + (issues.length - MAX_ISSUES) + " \u6761\uff0c\u70b9\u51fb\u5c55\u5f00 \u25BE",
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
								h("span", { style: { fontSize: "11px", color: COLORS.dim } }, "\u4efb\u52a1"),
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

		/** One collapsed line for a change the session no longer owns; expands into full detail. */
		function ChangeRow({ change }) {
			const [open, setOpen] = react.useState(false);
			const verdict = verdictOf(change, change.isActive);
			const stages = change.stages || [];
			const errors = (change.issues || []).filter((issue) => issue.level === "error").length;
			return h(
				"div",
				{ style: { marginTop: "4px" } },
				h(
					"div",
					{
						role: "button",
						onClick: () => setOpen((value) => !value),
						title: (open ? "\u6536\u8d77" : "\u5c55\u5f00") + "\uff1a" + change.changeId + " \u00b7 " + verdict.label,
						style: { display: "flex", alignItems: "baseline", gap: "6px", cursor: "pointer", userSelect: "none", lineHeight: "18px" },
					},
					h("span", { style: { fontSize: "10px", color: verdict.color, flex: "0 0 auto" } }, verdict.key === "complete" ? "\u2713" : "\u26A0"),
					h(
						"span",
						{
							style: {
								flex: "1 1 auto",
								minWidth: 0,
								fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
								fontSize: "11px",
								color: COLORS.text,
								wordBreak: "break-all",
								opacity: open ? 1 : 0.9,
							},
						},
						change.changeId,
					),
					errors > 0 ? h("span", { style: { flex: "0 0 auto", fontSize: "10px", color: COLORS.error } }, "\u2715" + errors) : null,
					h(
						"span",
						{ style: { flex: "0 0 auto", fontSize: "10px", color: COLORS.soft, fontVariantNumeric: "tabular-nums" } },
						stages.filter((stage) => stage.done).length + "/" + stages.length,
					),
					h("span", { style: { flex: "0 0 auto", fontSize: "9px", color: COLORS.soft } }, open ? "\u25B4" : "\u25BE"),
				),
				open ? h(ChangeDetail, { change, isActive: change.isActive }) : null,
			);
		}

		/** Tab body: the project workbench, grouped by how much attention each change needs. */
		function BoardBody(props) {
			const { sessionId, readSnapshot } = props;
			usePoll(sessionId, readSnapshot);
			const snapshot = useFeed();
			const [showDone, setShowDone] = react.useState(false);
			const [showPending, setShowPending] = react.useState(false);
			const [showLegacy, setShowLegacy] = react.useState(false);

			if (snapshot.phase === "loading") {
				return h("div", { style: { padding: "14px 12px", color: COLORS.soft, fontSize: "12px" } }, "\u8bfb\u53d6\u4e2d\u2026");
			}
			if (snapshot.phase !== "ready" || !snapshot.data) {
				return h(
					"div",
					{ style: { padding: "14px 12px", color: COLORS.soft, fontSize: "12px", lineHeight: "18px" } },
					"\u5f53\u524d\u9879\u76ee\u672a\u63a5\u5165\u95ed\u73af",
					h("div", { style: { marginTop: "4px", fontSize: "11px", opacity: 0.7 } }, "\u672a\u627e\u5230 .codex/session-state.json\uff0c\u65e0\u9700\u5904\u7406\u3002"),
				);
			}

			const data = snapshot.data;
			const changes = data.changes || [];
			if (!changes.length) {
				const trace = data.trace || [];
				const wired = trace.some((entry) => entry.changes > 0);
				return h(
					"div",
					{ style: { padding: "14px 12px", color: COLORS.soft, fontSize: "12px", lineHeight: "18px" } },
					wired ? "\u65e0 change" : "\u9879\u76ee\u91cc\u627e\u4e0d\u5230\u95ed\u73af kit",
					h(
						"div",
						{ style: { marginTop: "6px", fontSize: "11px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: 0.85 } },
						...trace.map((entry, index) =>
							h("div", { key: "t" + index, style: { wordBreak: "break-all" } }, entry.root + "  \u2192  " + entry.state),
						),
					),
					h(
						"div",
						{ style: { marginTop: "8px", fontSize: "11px", opacity: 0.7 } },
						wired
							? "\u5f00\u59cb\u4e00\u4e2a change \u540e\u8fd9\u91cc\u4f1a\u663e\u793a\u9636\u6bb5\u4e0e\u4efb\u52a1\u3002"
							: "\u4e0a\u9762\u5217\u51fa\u4e86\u5b9e\u9645\u63a2\u8fc7\u7684\u6839\u76ee\u5f55\u3002\u5b83\u4eec\u76f8\u5bf9\u4e8e\u4f1a\u8bdd\u5de5\u4f5c\u533a\u6839\uff0c\u5e94\u8be5\u5b58\u5728 " +
									SESSION_STATE +
									"\u3002",
					),
				);
			}

			const active = changes.filter((change) => change.isActive)[0];
			const errorsOf = (change) => (change.issues || []).filter((issue) => issue.level === "error").length;
			const pending = changes
				.filter((change) => kindOf(change) === "pending")
				// Most broken first: with dozens of unfinished changes the useful ones are
				// the ones with real findings, not the alphabetical head.
				.sort((a, b) => errorsOf(b) - errorsOf(a) || a.changeId.localeCompare(b.changeId));
			const done = changes.filter((change) => kindOf(change) === "done");
			const legacy = changes.filter((change) => kindOf(change) === "legacy").sort((a, b) => a.changeId.localeCompare(b.changeId));

			return h(
				"div",
				{
					style: {
						height: "100%",
						minHeight: 0,
						overflowY: "auto",
						boxSizing: "border-box",
						padding: "10px 12px 16px",
						color: COLORS.text,
						fontSize: "12px",
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "8px", color: COLORS.dim, fontSize: "11px" } },
					h("span", null, "\u95ed\u73af"),
					h("span", { style: { flex: "1 1 auto" } }),
					pending.length > 0 ? h("span", { style: { color: COLORS.error } }, pending.length + " \u5f85\u5904\u7406") : null,
					done.length > 0 ? h("span", null, done.length + " \u5df2\u5b8c\u6210") : null,
					legacy.length > 0 ? h("span", { style: { color: COLORS.soft } }, legacy.length + " \u5386\u53f2") : null,
				),
				data.total > data.scanned
					? h(
							"div",
							{ style: { marginTop: "4px", fontSize: "10px", color: COLORS.soft, lineHeight: "15px" } },
							"\u4ecd\u5728\u8f7d\u5165\uff1a\u5df2\u7f13\u5b58 " + data.scanned + " / " + data.total + " \u4e2a change\uff0c\u4e0b\u65b9\u5404\u6863\u4f1a\u9010\u6b65\u8865\u9f50\uff08\u5f53\u524d change \u59cb\u7ec8\u4f18\u5148\uff09\u3002",
						)
					: null,
				active
					? h(ChangeDetail, { change: active, isActive: true })
					: h("div", { style: { marginTop: "6px", fontSize: "11px", color: COLORS.soft } }, "\u65e0\u6d3b\u8dc3 change"),
				pending.length > 0
					? h(
							"div",
							{ style: { marginTop: "14px", paddingTop: "8px", borderTop: "1px solid " + COLORS.border } },
							h(
								"div",
								{
									role: "button",
									onClick: () => setShowPending((value) => !value),
									style: { fontSize: "11px", color: COLORS.error, cursor: "pointer", userSelect: "none" },
								},
								showPending ? "\u5f85\u5904\u7406 " + pending.length + " \u25B4" : "\u5f85\u5904\u7406 " + pending.length + " \u25BE",
							),
							showPending ? h("div", null, ...pending.map((change) => h(ChangeRow, { key: change.changeId, change }))) : null,
						)
					: null,
				done.length > 0
					? h(
							"div",
							{ style: { marginTop: "14px", paddingTop: "8px", borderTop: "1px solid " + COLORS.border } },
							h(
								"div",
								{ role: "button", onClick: () => setShowDone((value) => !value), style: { fontSize: "11px", color: COLORS.dim, cursor: "pointer", userSelect: "none" } },
								showDone ? "\u6536\u8d77 \u25B4" : "\u5df2\u5b8c\u6210 " + done.length + " \u25BE",
							),
							showDone ? h("div", null, ...done.map((change) => h(ChangeRow, { key: change.changeId, change }))) : null,
						)
					: null,
				legacy.length > 0
					? h(
							"div",
							{ style: { marginTop: "14px", paddingTop: "8px", borderTop: "1px solid " + COLORS.border } },
							h(
								"div",
								{
									role: "button",
									onClick: () => setShowLegacy((value) => !value),
									title: "\u4efb\u52a1\u6e05\u5355\u6ca1\u6709\u6536\u5c3e\u4e09\u4efb\u52a1\uff1a\u591a\u4e3a\u89c4\u8303\u786e\u7acb\u4e4b\u524d\u5efa\u7684 change",
									style: { fontSize: "11px", color: COLORS.soft, cursor: "pointer", userSelect: "none" },
								},
								showLegacy ? "\u5386\u53f2 " + legacy.length + " \u25B4" : "\u5386\u53f2 " + legacy.length + " \u25BE",
							),
							showLegacy ? h("div", null, ...legacy.map((change) => h(ChangeRow, { key: change.changeId, change }))) : null,
						)
					: null,
				h(
					"div",
					{
						style: {
							marginTop: "14px",
							paddingTop: "6px",
							borderTop: "1px solid " + COLORS.border,
							display: "flex",
							gap: "8px",
							fontSize: "10px",
							color: COLORS.soft,
						},
					},
					h("span", null, "closure-board v" + VERSION),
					data.total > data.scanned
						? h(
								"span",
								{ title: "远端每次读取都是一次往返，因此每轮只扫描一部分；当前 change 始终包含在内" },
								"\u5df2\u7f13\u5b58 " + data.scanned + "/" + data.total,
							)
						: null,
					h("span", { style: { flex: "1 1 auto" } }),
					h("span", { title: "kit 根目录" }, data.root || "."),
				),
			);
		}

		/* ------------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------------ */

		const inject = ["slots", "sessions", "remote", "remote.workspaceFiles", "sidebarRight", "sidebarRightTabs"];

		function apply(ctx) {
			const face = (sessionId) => ({
				sessionId,
				readSnapshot: () => collect({ sessionId, remote: ctx.remote }, (partial) => publishFeed({ phase: "ready", data: partial })),
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
		exports.__internals = { parseTasks, computeStages, applyIssueGating, verdictOf, isLegacy, kindOf, collect, findConflicts, pathTokens, KIT_ROOTS };
		return module.exports;
	},
});
