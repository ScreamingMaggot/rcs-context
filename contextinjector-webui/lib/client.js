// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// contextinjector-webui (client half) — "注入" tab in the conversation.view ring.
// Structured panel: workspace-grouped session whitelist + fold timeline.
// Data plane: fetch /api/context-inject/{status,config}; theme-aware via DSW tokens.
window.__ModuleLoader__.load({
	id: "contextinjector-webui/client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
		var e = React.createElement;

		// ---- theme-aware stylesheet (injected once; DSW tokens with safe fallbacks) ----
		var css = [
			".ci-root{font-size:13px;line-height:1.55;max-width:1240px;padding:14px 16px;color:var(--dsw-alias-label-primary,#e7e7ee)}",
			// 双栏（v1.10）：右栏承载管理（当前会话/白名单/日志编译），宽屏并排、窄屏 flex 自动回退单列
			".ci-cols{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}",
			".ci-main{flex:1 1 540px;min-width:0;max-height:72vh;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}",
			".ci-rail{flex:1 1 260px;min-width:230px;max-width:360px;display:flex;flex-direction:column;gap:10px;max-height:72vh;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}",
			".ci-main::-webkit-scrollbar,.ci-rail::-webkit-scrollbar{width:8px}",
			".ci-main::-webkit-scrollbar-thumb,.ci-rail::-webkit-scrollbar-thumb{background:rgba(127,127,150,.35);border-radius:4px}",
			".ci-hd{display:flex;align-items:center;gap:10px;margin-bottom:4px}",
			".ci-badge{width:8px;height:8px;border-radius:50%;flex:none}",
			".ci-on{background:#34c759;box-shadow:0 0 8px rgba(52,199,89,.7)}",
			".ci-off{background:rgba(120,120,140,.45)}",
			".ci-title{font-size:13px;font-weight:650;letter-spacing:.01em}",
			".ci-sub{font-size:11px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75))}",
			".ci-sec{background:rgba(127,127,150,.06);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.22));border-radius:12px;padding:10px 12px;margin:10px 0}",
			".ci-sech{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75))}",
			".ci-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}",
			".ci-switch{width:34px;height:19px;border-radius:999px;border:1px solid rgba(127,127,150,.45);position:relative;transition:background .18s ease;flex:none;background:transparent}",
			".ci-switch:before{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:currentColor;opacity:.75;transition:transform .18s ease}",
			".ci-on .ci-switch{background:rgba(52,199,89,.22);border-color:rgba(52,199,89,.6)}",
			".ci-on .ci-switch:before{transform:translateX(15px);opacity:1}",
			// LOGcompiler 区开关的独立 on 态（不加 ci-on，避免整行被涂绿，仅滑块位移+描边变绿）
			".ci-lg .ci-switch{background:transparent}",
			".ci-lgon .ci-switch{background:rgba(52,199,89,.22);border-color:rgba(52,199,89,.6)}",
			".ci-lgon .ci-switch:before{transform:translateX(15px);opacity:1}",
			".ci-grp{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.22));border-radius:10px;margin:6px 0;overflow:hidden}",
			".ci-grphd{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;font-size:12px;background:rgba(127,127,150,.05)}",
			".ci-grphd:hover{background:rgba(127,127,150,.1)}",
			".ci-caret{font-size:9px;transition:transform .15s ease;flex:none}",
			".ci-open .ci-caret{transform:rotate(90deg)}",
			".ci-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 10px}",
			".ci-chip{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.3));border-radius:999px;padding:2px 8px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;color:inherit;transition:border-color .12s ease,background .12s ease}",
			".ci-chipon{border-color:rgba(100,140,255,.65);background:rgba(100,140,255,.13)}",
			".ci-arch{opacity:.45;text-decoration:line-through}",
			".ci-metrics{display:flex;flex-wrap:wrap;gap:4px 14px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;margin-bottom:8px}",
			".ci-metric b{font-weight:650;color:var(--dsw-alias-label-primary,#e7e7ee)}",
			".ci-hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.16));margin:10px 0}",
			".ci-rnd{display:flex;gap:10px;margin:4px 0 10px}",
			".ci-rndtag{flex:none;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:10px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8));padding-top:3px;min-width:62px}",
			".ci-flow{flex:1;min-width:0}",
			".ci-msg{border-left:2px solid rgba(127,127,150,.18);padding:2px 10px 2px 12px;margin:3px 0}",
			".ci-u{border-left-color:rgba(120,160,255,.55)}",
			".ci-a{border-left-color:rgba(127,127,150,.14)}",
			// 外置推理简报（EXTREASON `[R]` 行）：独立色相（紫），与「你」(蓝)/「AI」(灰) 一眼可分
			".ci-r{border-left-color:rgba(178,130,255,.6)}",
			".ci-r .ci-role{color:rgba(198,160,255,.95)}",
			".ci-t{border-left:none;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;padding:1px 2px;margin:2px 0}",
			".ci-t-ok{color:#58c46b}",".ci-t-err{color:#ff6b6b}",
			".ci-role{font-size:10px;font-weight:700;letter-spacing:.08em;margin-right:6px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7))}",
			".ci-text{white-space:pre-wrap;word-break:break-word;cursor:pointer}",
			".ci-clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}",
			".ci-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}",
			".ci-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.4));background:transparent;color:inherit;border-radius:7px;padding:3px 11px;font-size:12px;cursor:pointer}",
			".ci-btn:hover{background:rgba(127,127,150,.12)}",
			// 右键菜单（会话 chip → 导出 LOG / 复制会话 ID）【取自 RCS-0.1.0 返回包】
			".ci-ctx{position:fixed;z-index:9999;min-width:172px;padding:4px;border-radius:9px;background:var(--dsw-alias-bg-elevated,#22222b);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.45));box-shadow:0 10px 28px rgba(0,0,0,.45);font-size:12px}",
			".ci-ctx-hd{padding:3px 8px 6px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75));font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid rgba(127,127,150,.2);margin-bottom:4px}",
			".ci-ctx button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:5px 8px;border-radius:6px;cursor:pointer}",
			".ci-ctx button:hover{background:rgba(127,127,150,.16)}",
			".ci-ctx button:disabled{opacity:.45;cursor:default}",
			".ci-ctx button:disabled:hover{background:transparent}",
			".ci-err{color:#ff6b6b;font-size:12px;margin:4px 0}",
			// v1.8/v1.9 压缩模型（面板）：provider/model 原生 select，直接从 DSH 已注册目录里选。
			// 深色主题下原生 select 弹出层 option 文字默认继承浅色（未悬停不可见）→ option 显式配色兜底。
			".ci-sel{font-family:inherit;font-size:11px;line-height:18px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.35));border-radius:7px;padding:2px 6px;min-width:170px;max-width:250px}",
			".ci-sel option{color:#16161d;background:#fff}",
			// v1.7 composer dock：本会话压缩模式选择器（卡片上方一行，首轮发送前即可用）
			".cim-dock{box-sizing:border-box;max-width:var(--dsh-composer-card-max-width,760px);width:100%;margin:0 auto 6px;padding:0 12px;display:flex;align-items:center;gap:8px;font-size:11px;flex:none}",
			".cim-lb{color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75));flex:none;letter-spacing:.02em}",
			".cim-chips{display:flex;gap:5px;flex-wrap:wrap;min-width:0}",
			".cim-chip{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.3));border-radius:999px;padding:1px 9px;cursor:pointer;color:inherit;background:transparent;font-size:11px;line-height:18px;white-space:nowrap;font-family:inherit;transition:border-color .12s ease,background .12s ease}",
			".cim-chip:hover{background:rgba(127,127,150,.12)}",
			".cim-on{border-color:rgba(100,140,255,.65);background:rgba(100,140,255,.13)}",
			".cim-hint{color:var(--dsw-alias-label-secondary,rgba(180,180,195,.6));font-size:10px;flex:none}",
			".ci-chart{width:100%;height:110px;display:block;background:rgba(127,127,150,.04);border-radius:8px;margin-top:4px}",
			// 【在飞折叠】「上一轮输出压缩中…」脉冲点（琥珀 = 面板既有的警示色相，与绿=就绪/灰=停区分）
			".ci-pulse{width:8px;height:8px;border-radius:50%;flex:none;background:#ffb454;box-shadow:0 0 8px rgba(255,180,84,.75);animation:ci-pulse 1.1s ease-in-out infinite}",
			"@keyframes ci-pulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1.12)}}",
			".ci-fin{color:rgba(255,190,110,.95)}",
			// 【会话页·在飞折叠】composer 操作行左侧的「压缩中」小标：行内 inline-flex（flex:none），
			//   与同排的档位选择器同字号 13px/20px ⇒ 只占行内位置、不改变行高，不挤动 DSH 自己的状态行。
			//   脉冲点复用上面的 .ci-pulse；色相与面板 .ci-fin 一致（琥珀 = 警示）。
			// v2.4 可见性（浅/深两套主题都要看得见）：描边/底色/脉冲点改用 DSH 自带的 warn 令牌族
			//   `--dsw-alias-state-warn-{primary,secondary,tertiary}`，**两套主题都给值**
			//   （dsh-client-ui-theme/lib/client.js:15369 浅色块 / :20674 深色块：
			//    primary=amber-500 #f59e0b、secondary=amber-400 #f7ad31、
			//    tertiary=琥珀底（浅 #fef5e7 / 深 #27241f）），
			//   且 DSH 自己的审批卡就是这套配方（dsh-client-ui-conversation/lib/client.js:6010：
			//   `.bqrRRG_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}`
			//   + `.bqrRRG_dot{background:var(--dsw-alias-state-warn-primary)}` 的 8px 点）。
			//   **文字色故意不用琥珀**：琥珀系文字在浅色主题的白卡片上对比度只有约 2.2:1（DSH 审批卡自己也是这个数），
			//   而"压缩中"是要被读到的状态字。故文字用主题 label-primary（浅=#0f1115 / 深=#f9fafb，
			//   在本胶囊底上对比度 ≈14:1~17:1），琥珀身份交给底色+描边+脉冲点三处承载。
			//   旧实现写死 `color:rgba(255,190,110,.95)`（约 1.6:1）⇒「小标其实在渲染，但用户看不见」是真实候选原因之一。
			".ci-foldchip{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;box-sizing:border-box;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-secondary,var(--dsw-static-amber-400,rgba(255,180,84,.5)));background:var(--dsw-alias-state-warn-tertiary,var(--dsw-static-amber-100,rgba(255,180,84,.14)));color:var(--dsw-alias-label-primary,#0f1115)}",
			// 胶囊内的脉冲点用同一族令牌（深色下更亮、浅色下更饱和），动画仍是上面那一套 @keyframes ci-pulse
			".ci-foldchip .ci-pulse{background:var(--dsw-alias-state-warn-primary,var(--dsw-static-amber-500,#f59e0b))}",
			"@media (prefers-reduced-motion:reduce){.ci-switch,.ci-caret,.cim-chip{transition:none}.ci-pulse{animation:none;opacity:.9}}"
		].join("");
		var CSS_TAG = "contextinjector-webui/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "contextinjector-webui";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function shortId(id) { return String(id || "").replace(/^session-/, "").slice(0, 8); }
		function parseTranscript(text) {
			var rounds = [], cur = null;
			(text || "").split("\n").forEach(function (line) {
				var rm = /^\[ROUND\]\s*(\d+)/.exec(line);
				if (rm) { cur = { n: Number(rm[1]), blocks: [] }; rounds.push(cur); return; }
				if (!cur) return;
				var m;
				if ((m = /^\[U\]\s?(.*)/.exec(line))) { cur.blocks.push({ k: "u", t: m[1] }); return; }
				if ((m = /^\[A\]\s?(.*)/.exec(line))) { cur.blocks.push({ k: "a", t: m[1] }); return; }
				// EXTREASON 外置推理简报：转录里的 `[R] …` 行自成一块（kind "r" = 推理），
				// 不再被下面「未识别行按 AI 显示」的兜底吞成 AI 块（用户报：`[R]` 段还顶着 AI 图标）。
				if ((m = /^\[R\]\s?(.*)/.exec(line))) { cur.blocks.push({ k: "r", t: m[1] }); return; }
				if ((m = /^\[T\]\s?(.*)/.exec(line))) { cur.blocks.push({ k: "t", t: m[1] }); return; }
				if (line.trim()) { cur.blocks.push({ k: "a", t: line.trim() }); }
			});
			return rounds;
		}

		class ErrorBoundary extends React.Component {
			constructor(props) { super(props); this.state = { error: null }; }
			static getDerivedStateFromError(error) { return { error: error }; }
			render() {
				if (this.state.error) {
					return React.createElement("div", { style: { color: "#ff6b6b", padding: 12, fontFamily: "ui-monospace,SFMono-Regular,Consolas,monospace", fontSize: 12, whiteSpace: "pre-wrap" } },
						"[\u6CE8\u5165\u9762\u677F\u6E32\u67D3\u9519\u8BEF] " + String((this.state.error && this.state.error.message) || this.state.error) + "\n" + String((this.state.error && this.state.error.stack) || ""));
				}
				return this.props.children;
			}
		}
		// ===== 模块级共享 /status 采样器（会话页「压缩中」小标 + 「注入」面板共用；全局唯一 500ms 定时器）=====
		// 为什么收口：两个消费者都要看同一份 /status（尤其 foldInflight）。各起一个 500ms setInterval =
		//   同一 URL 双份请求 + 两处可能泄漏的定时器。这里只留一个采样面：
		//   key = sessionId（"" = 全局）→ 每个 key 一份快照 + 一张订阅表；订阅数归零 → clearInterval。
		// 生命周期：首个消费者挂载才启动；最后一个卸载即停，并丢掉该 key 的快照（不留"在飞"残留假象）。
		// 失败：保留上一次快照，把错误写进快照 err（面板照旧 setErr；小标只读 data.foldInflight，静默）。
		var CI_STATUS_MS = 500;
		var ciStatus = (function () {
			var subs = {};   // key -> [fn]
			var snaps = {};  // key -> { data, err, at }
			var timer = null;
			function notify(key, snap) {
				if (!subs[key]) return; // 已无订阅者：卸载后的迟到响应直接丢弃（不写状态、不回调）
				snaps[key] = snap;
				subs[key].slice().forEach(function (fn) { try { fn(snap); } catch (x) {} });
			}
			function read(key) {
				var q = key ? "?sessionId=" + encodeURIComponent(key) : "";
				return fetch("/api/context-inject/status" + q, { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (s) { notify(key, { data: s, err: null, at: Date.now() }); return s; })
					.catch(function (x) { notify(key, { data: (snaps[key] && snaps[key].data) || null, err: x, at: Date.now() }); return null; });
			}
			function tick() { Object.keys(subs).forEach(read); }
			function stopIfIdle() {
				if (Object.keys(subs).length === 0 && timer !== null) { clearInterval(timer); timer = null; }
			}
			return {
				snapshot: function (key) { return snaps[key] || null; },
				subscribe: function (key, fn) {
					if (!subs[key]) subs[key] = [];
					subs[key].push(fn);
					if (timer === null) timer = setInterval(tick, CI_STATUS_MS); // 首个消费者：启动采样
					if (snaps[key]) fn(snaps[key]); // 命中缓存先回放（切 tab 回来不闪空白），下一拍再刷
					else read(key);                 // 否则立即采一次（等价于旧实现的"挂载即 status()"）
					return function () {
						var list = subs[key];
						if (!list) return; // 幂等：重复调用/已停
						var i = list.indexOf(fn);
						if (i >= 0) list.splice(i, 1);
						if (list.length !== 0) return;
						delete subs[key];
						delete snaps[key];  // 订阅数归零即丢快照
						stopIfIdle();
					};
				},
				refresh: function (key) { return read(key); },
			};
		})();
		// 触发点中文标签（foldAttempt 的两个触发点；未知值原样显示，不隐藏信息）——面板与新小标共用
		function trigLabel(t) {
			return t === "turn-stopping" ? "本轮结束触发" : t === "pre-step" ? "下一轮开始前触发" : (t || "触发点未知");
		}
		function InjectView(props) {
			var _d = useState(null), data = _d[0], setData = _d[1];
			var _e = useState(null), err = _e[0], setErr = _e[1];
			var _on = useState(false), on = _on[0], setOn = _on[1];
			var _sel = useState({}), sel = _sel[0], setSel = _sel[1];
			var _ws = useState({}), wss = _ws[0], setWss = _ws[1];
			// v1.9：顶部「AI 输出压缩档」chips 已删（每会话在 composer 独立选档）→ cd 全局档状态移除
			var _mdlErr = useState(null), mdlErr = _mdlErr[0], setMdlErr = _mdlErr[1];
			// v1.8 压缩模型：目录（providers/models）+ 当前覆盖值
			var _mdl = useState(null), mdl = _mdl[0], setMdl = _mdl[1];
			var _selP = useState(""), selP = _selP[0], setSelP = _selP[1];
			var _selM = useState(""), selM = _selM[0], setSelM = _selM[1];
			var _picked = useState(false), picked = _picked[0], setPicked = _picked[1];
			var _ow = useState({}), openWs = _ow[0], setOpenWs = _ow[1];
			// LOGcompiler「会话记录」区分组展开态（独立于白名单 openWs，避免互相影响）
			var _lgow = useState({}), lgOpenWs = _lgow[0], setLgOpenWs = _lgow[1];
			function toggleLgGroup(w) { setLgOpenWs(function (prev) { var n = Object.assign({}, prev); if (n[w]) delete n[w]; else n[w] = true; return n; }); }
			// 归档会话不进入白名单候选（与左侧栏一致）
			var _all = useState(false), allRounds = _all[0], setAllRounds = _all[1];
			var _ex = useState({}), expanded = _ex[0], setExpanded = _ex[1];
			var _busy = useState(false), busy = _busy[0], setBusy = _busy[1];
			// 右键菜单（会话 chip → 导出 LOG / 复制会话 ID）【取自 RCS-0.1.0 返回包】
			//   菜单只在"有菜单"时挂全局监听：点空白/Escape/滚动都关掉（滚动用捕获阶段，容器内滚动也生效）。
			var _ctx = useState(null), ctxMenu = _ctx[0], setCtxMenu = _ctx[1];
			useEffect(function () {
				if (!ctxMenu) return;
				var close = function () { setCtxMenu(null); };
				var onKey = function (ev) { if (ev && ev.key === "Escape") close(); };
				document.addEventListener("click", close);
				document.addEventListener("keydown", onKey);
				window.addEventListener("scroll", close, true);
				return function () {
					document.removeEventListener("click", close);
					document.removeEventListener("keydown", onKey);
					window.removeEventListener("scroll", close, true);
				};
			}, [ctxMenu]);
			var cur = (props && props.sessionId) || null;
			// #7 maxtokens UI 输入：存"编辑中的值"；null=未编辑，展示当前 control.condenseMaxTokens
			var _mtInp = useState(""), mtInp = _mtInp[0], setMtInp = _mtInp[1];
			var curMT = (data && data.control && typeof data.control.condenseMaxTokens === 'number') ? data.control.condenseMaxTokens : null; // null=跟随默认(700)
			function saveMaxTokens(v) { // v: number|null
				setBusy(true);
				fetch("/api/context-inject/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ condenseMaxTokens: v }) })
					.then(function (r) { return r.json(); }).then(function (resp) { if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp)); setMtInp(""); return status(); })
					.catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setBusy(false); });
			}
			// 【取自 RCS-0.1.0 返回包】condenseMinBytes UI 输入：与 maxtokens 同盒同排；存"编辑中的值"，空=清除(回内置 240)
			var _mbInp = useState(""), mbInp = _mbInp[0], setMbInp = _mbInp[1];
			var curMB = (data && data.control && typeof data.control.condenseMinBytes === 'number') ? data.control.condenseMinBytes : null; // null=跟随默认(240)
			function saveMinBytes(v) { // v: number|null（null=清除该字段，回落内置 240）
				setBusy(true);
				fetch("/api/context-inject/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ condenseMinBytes: v }) })
					.then(function (r) { return r.json(); }).then(function (resp) { if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp)); setMbInp(""); return status(); })
					.catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setBusy(false); });
			}
			// #10 自定义压缩提示词：编辑中的 single/keys；null=用内置默认
			var _ps = useState({ single: "", keys: "" }), prompts = _ps[0], setPrompts = _ps[1];
			var _showD = useState(false), showDefPrompts = _showD[0], setShowDefPrompts = _showD[1]; // 是否展开查看默认提示词
			var defaultPrompts = (data && data.runtime && data.runtime.defaultPrompts) || null; // 内置默认(single/keys)
			var curPrompts = (data && data.control && data.control.prompts && typeof data.control.prompts === 'object') ? data.control.prompts : null; // null=内置默认
			function savePrompts(patch) {
				setBusy(true);
				fetch("/api/context-inject/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompts: patch || null }) })
					.then(function (r) { return r.json(); }).then(function (resp) { if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp)); setPrompts({ single: "", keys: "" }); return status(); })
					.catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setBusy(false); });
			}

			// 一次采样落到本视图状态（原 status().then 的主体，逐字保留；现由共享采样器的订阅回调驱动）
			function applyStatus(s) {
				setData(s);
				setOn(!!(s.control && s.control.enabled));
				var m = {}, g = {};
				(s.control && s.control.sessions || []).forEach(function (x) { m[x] = true; });
				setSel(m);
				(s.sessions || []).forEach(function (s2) { if (!g[s2.workspace]) g[s2.workspace] = []; g[s2.workspace].push(s2); });
				Object.keys(g).forEach(function (w) { g[w].sort(function (a, b) { return (a.archived === b.archived ? 0 : a.archived ? 1 : -1) || a.id.localeCompare(b.id); }); });
				setWss(g);
				return s;
			}
			// 手动/写后刷新：交给共享采样器（同一 URL、同一 500ms 采样面）——本视图不再自建定时器；
			// 失败同样经快照 err 回到下面的订阅回调（错误处理口径不变）。
			function status() { return ciStatus.refresh(cur || ""); }
			function save(patch) {
				setBusy(true);
				return fetch("/api/context-inject/config", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch || { enabled: on, sessions: Object.keys(sel).filter(function (k) { return sel[k]; }) }),
				}).then(function (r) { return r.json(); }).then(function (resp) {
					if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp));
					return status();
				}).catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setBusy(false); });
			}
			useEffect(function () {
				loadModels(); // v1.8：压缩模型目录（一次性；轮询只刷 status）
				// 轮询周期 2s → 0.5s：后台折叠常在 2s 内就落定，「在飞 → 已完成」这整段状态会被 2s 采样整段跳过，
				//   用户看不到「上一轮输出压缩中…」。0.5s 下 2s 的折叠约能采到 4 次。
				// v2.3：采样面收口到模块级 ciStatus（与会话页「压缩中」小标同一轮采样、同一 500ms 周期）；
				//   本视图只订阅快照，不再自建 setInterval ⇒ 两个消费者合计仍只有一份定时器，卸载由 refCount 停掉。
				return ciStatus.subscribe(cur || "", function (snap) {
					if (snap && snap.err) { setErr(String((snap.err && snap.err.message) || snap.err)); return; }
					if (snap && snap.data) applyStatus(snap.data);
				});
			}, [cur]);
			// v1.9：本会话档位经 /session 端点读写（与 composer 同一通道）——
			// 勾选 = 启用无损折叠（写 sessionModes=off 并入白名单）；取消 = none（移出白名单+清档）。
			// 保证白名单与 sessionModes 永远一致：无"白名单内却无档"的悬空态（插件侧无档=不折叠）。
			function setSessionMode(id, mode) {
				if (!id) return Promise.resolve();
				setBusy(true);
				return fetch("/api/context-inject/session", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: id, mode: mode }),
				}).then(function (r) { return r.json(); }).then(function (resp) {
					if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp));
					return status();
				}).catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setBusy(false); });
			}
			function toggleSession(id) {
				setSessionMode(id, sel[id] ? "none" : "off");
			}
			// v1.8/v1.9：压缩模型目录。不带 provider = 列 provider；带 provider = 列该 provider 的模型
			// （listModels 可能是网络调用，故按需拉取，不在轮询里刷新）。错误上浮到面板（mdlErr）。
			function loadModels(provider) {
				// 模型列表走 POST（body 传 provider），避免依赖 query 解析；列 provider 用 GET
				var req = provider
					? fetch("/api/context-inject/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: provider }) })
					: fetch("/api/context-inject/models", { headers: { "Content-Type": "application/json" } });
				return req
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (!j) return;
						if (j.ok === false) { setMdlErr((j && j.error) || "模型目录请求失败"); return; }
						setMdlErr(null);
						if (provider) setMdl(function (prev) { return Object.assign({}, prev, { models: j.models || [] }); });
						else {
							setMdl(j);
							// 仅当用户尚未手动选择时，才用 current 初始化；否则初始请求晚到会清掉用户的选择（竞态）
							if (!picked && j.current && j.current.provider) { setSelP(j.current.provider); setSelM(j.current.model || ""); loadModels(j.current.provider); }
							else if (!picked) { setSelP(""); setSelM(""); }
						}
					})
					.catch(function (x) { setMdlErr("模型目录不可用：" + String((x && x.message) || x)); });
			}
			// v1.9：select 收口 —— provider 首项「跟随会话模型」= 清除覆盖（provider/model 一并传 null）；
			// 选 provider 即拉该 provider 模型列表；选 model 即保存成对覆盖（半配置由 host 忽略）。
			function onProviderChange(ev) {
				var p = ev && ev.target ? ev.target.value : "";
				setPicked(true);
				if (!p) {
					setSelP(""); setSelM("");
					setMdl(function (m) { return m ? Object.assign({}, m, { models: [] }) : m; });
					save({ condenseProvider: null, condenseModel: null });
					return;
				}
				setSelP(p); setSelM("");
				loadModels(p);
			}
			function onModelChange(ev) {
				var m = ev && ev.target ? ev.target.value : "";
				setSelM(m);
				if (m) save({ condenseProvider: selP, condenseModel: m });
			}
		function toggleGroup(w) {
				setOpenWs(function (prev) { var n = Object.assign({}, prev); if (n[w]) delete n[w]; else n[w] = true; return n; });
			}
			function toggleExpand(id) {
				var n = Object.assign({}, expanded);
				if (n[id]) delete n[id]; else n[id] = true;
				setExpanded(n);
			}
			var lf = (data && data.lastFold) || null;
			// 【在飞折叠】「上一轮输出压缩中…」：数据来自 /status.foldInflight（host 读插件写的在飞标记）。
			// 为什么需要：turn-stopping 触发的是**后台**折叠（只排队、不阻塞本轮），浓缩模型要跑几秒~十几秒；
			//   这段时间 lastFold 仍是上一轮的结果，面板看起来"什么都没发生"（用户实测困惑点）。
			// 秒数不需要额外定时器：本视图每 0.5s 轮询 /status，重渲染即自动走秒。
			var fin = (data && data.foldInflight) || null;
			var finOn = !!fin;
			// 「已完成」小标签：只在"在飞 → 消失"那一次转换后短暂出现，靠 0.5s 轮询重渲染自然消退（不起定时器）。
			// 保留期 30s（原 8s）：落定本身很容易一闪而过，8s 常在被看到之前就消失；30s 保证用户至少看见一次。
			var FIN_DONE_MS = 30000;
			var _finDone = useState(0), finDoneAt = _finDone[0], setFinDoneAt = _finDone[1];
			var prevFinOn = useRef(false);
			useEffect(function () {
				if (prevFinOn.current && !finOn) setFinDoneAt(Date.now()); // 落定（成功/失败都算）
				prevFinOn.current = finOn;
			}, [finOn]);
			// 触发点中文标签已提到模块级（trigLabel）：会话页「压缩中」小标与本面板共用同一份口径
			function inflightLine(f) {
				var t0 = Number(f && f.startedAt);
				var sec = Number.isFinite(t0) ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : null;
				return e("div", { className: "ci-sech ci-fin", style: { margin: "0 0 6px" }, title: "后台折叠进行中：本轮输出结束后已排队，浓缩模型返回即落 last-fold（下一轮请求前会 join）" },
					e("span", { className: "ci-pulse" }),
					"上一轮输出压缩中…",
					e("span", { className: "ci-sub" }, trigLabel(f && f.trigger) + (sec != null ? " · 已 " + sec + "s" : "")));
			}
			var rounds = parseTranscript(lf && (lf.full || lf.preview || ""));
			var shown = allRounds ? rounds : rounds.slice(-3);
			var lfOn = !!(data && data.control && data.control.enabled);
			var wsNames = Object.keys(wss).sort();

			function chip(s, curChip) {
				var ttl = s.title || "";
				var label = ttl || shortId(s.id);
				// 右键出菜单（导出 LOG / 复制会话 ID）；stopPropagation 防止顺带触发 chip 的勾选
				// 【取自 RCS-0.1.0 返回包】
				return e("span", { key: s.id, className: "ci-chip" + (sel[s.id] ? " ci-chipon" : ""), onClick: function () { toggleSession(s.id); }, title: s.id + (s.workspace ? " @ " + s.workspace : "") + "（右键可导出 LOG）",
					onContextMenu: function (ev) {
						ev.preventDefault(); ev.stopPropagation();
						setCtxMenu({ x: ev.clientX, y: ev.clientY, sid: s.id, title: ttl || shortId(s.id), hasLog: lgHasLog(s.id) });
					} },
					(sel[s.id] ? "✓ " : "") + label);
			}
			function msgBlock(b, i, roundId) {
				var id = roundId + ":" + i;
				var open = !!expanded[id];
				if (b.k === "t") {
					// 【修复·本地缺陷#2】【取自 RCS-0.1.0 返回包】状态判定改为"整行找状态 token"：
					// 旧实现 /OK$/ 只认行尾 OK → 结构化 [T]（…|read|文件|OK|P1…，status 不在行尾）恒被误判为 err。
					// 现按 | 切分取首个状态 token；兼容 OK|FAIL|ERR|PARTIAL|CANCEL（仅 OK 绿，其余红）。
					var st = String(b.t).split("|").map(function (s) { return s.trim(); })
						.filter(function (s) { return /^(OK|FAIL|ERR|PARTIAL|CANCEL)$/.test(s); })[0] || "";
					var ok = st === "OK";
					// 超长 [T] 行同样走点击折叠（与消息块同规则），避免长工具结果把面板撑爆。
					return e("div", { key: id, className: "ci-t" + (ok ? " ci-t-ok" : " ci-t-err") },
						e("div", { className: "ci-text" + (open ? "" : " ci-clamp"), onClick: function () { toggleExpand(id); }, title: open ? "收起" : "展开" },
							"▸ " + b.t));
				}
				// 角色标记（等宽、同尺寸，时间线不因新增「推理」行而重排）：
				//   u=你 / r=推理（EXTREASON 外置推理简报）/ 其余=AI。图标放 role 左边与 AI 行同槽位。
				var isU = b.k === "u", isR = b.k === "r";
				var ico = isR ? "\u25C8 " : "";
				var role = isU ? "你" : (isR ? "推理" : "AI");
				return e("div", { key: id, className: "ci-msg " + (isU ? "ci-u" : isR ? "ci-r" : "ci-a") },
					e("div", { className: "ci-text" + (open ? "" : " ci-clamp"), onClick: function () { toggleExpand(id); }, title: open ? "收起" : "展开" },
						e("span", { className: "ci-role" }, ico + role), b.t));
			}
			function timeline(rounds2) {
				if (!rounds2.length) return e("div", { className: "ci-sub" }, "尚无折叠记录（对话跨轮后自动生成）");
				return rounds2.map(function (r) {
					return e("div", { key: r.n, className: "ci-rnd" },
						e("div", { className: "ci-rndtag" }, "ROUND " + r.n),
						e("div", { className: "ci-flow" }, r.blocks.map(function (b, i) { return msgBlock(b, i, r.n); })));
				});
			}
			// ===== LOGcompiler「日志编译」区（并入本面板；数据来自 /status.logcompiler，写入 /api/logcompiler/config）=====
			var _lgDir = useState(""), lgDir = _lgDir[0], setLgDir = _lgDir[1];
			var _lgB = useState(false), lgBusy = _lgB[0], setLgBusy = _lgB[1];
			useEffect(function () {
				var v = (data && data.logcompiler && data.logcompiler.control && data.logcompiler.control.logsDir) || "";
				setLgDir(v);
			}, [data && data.logcompiler && data.logcompiler.control && data.logcompiler.control.logsDir]);
			var lg = (data && data.logcompiler) || null;
			// ===== 本会话压缩档（v1.11：从 composer dock 移入注入面板「当前会话」卡片）=====
			var MODE_OPTS = [["none", "关"], ["off", "工具折叠"], ["single", "单压缩"], ["double", "双压缩"]];
			function curOwn(id) {
				var sm = data && data.control && data.control.sessionModes;
				var n = String(id || "").replace(/^session-/i, "");
				if (sm && typeof sm === "object") { for (var k in sm) if (String(k).replace(/^session-/i, "") === n) return sm[k]; }
				return null;
			}
			function pickMode(id, mode) {
				if (!id) return;
				setBusy(true);
				fetch("/api/context-inject/session", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: id, mode: mode }),
				}).then(function (r) { return r.json(); }).then(function (resp) {
					if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp));
					return status();
				}).catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setBusy(false); });
			}
			var lgCtrl = (lg && lg.control) || null;
			var lgEnabled = !lgCtrl || lgCtrl.enabled !== false;
			var lgSm = (lgCtrl && lgCtrl.sessions) || null;
			function lgRec(sid) {
				if (!lgEnabled) return false;
				if (!lgSm) return true;
				var n = String(sid || "").replace(/^session-/i, "");
				for (var k in lgSm) if (String(k).replace(/^session-/i, "") === n) return lgSm[k] !== false;
				return true;
			}
			function lgPost(patch) {
				setLgBusy(true);
				return fetch("/api/logcompiler/config", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch || {}),
				}).then(function (r) { return r.json(); }).then(function (resp) {
					if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp));
					return status();
				}).catch(function (x) { setErr(String((x && x.message) || x)); }).finally(function () { setLgBusy(false); });
			}
			// —— 会话 → 转录文件（右键菜单 /「导出 LOG」按钮共用；文件名规则与插件 normKey、host lgKey 一致）——
			// 【取自 RCS-0.1.0 返回包】
			function lgKeyOf(s) { return String(s || "").replace(/^session-?/i, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80); }
			// 是否有转录文件（决定菜单项/按钮是否置灰）
			//   单文件模式（LOGCOMPILER_OUT）：全部轮次写进同一个文件、不按 sid 命名 ⇒ host 快照自
			//   2026-09-10 起透出 `single`/`outFile`（见 index.mjs logcompilerSnapshot），据此直接放行，
			//   避免"所有会话的导出按钮恒灰、功能不可达"。
			//   其余情况按归一 sid 匹配 files[].sid（host lgKey 与插件 normKey 同规则）。
			function lgHasLog(id) {
				if (lg && lg.single === true) return true;
				var k = lgKeyOf(id), fs2 = (lg && lg.files) || [];
				for (var i = 0; i < fs2.length; i++) if (fs2[i].sid === k) return true;
				return false;
			}
			// 下载：走临时 <a href="/api/logcompiler/export?sid=…" download>（同源 GET，浏览器直接落盘）
			function lgExport(id) {
				try {
					var a = document.createElement("a");
					a.href = "/api/logcompiler/export?sid=" + encodeURIComponent(id);
					a.download = "";
					document.body.appendChild(a);
					a.click();
					if (a.parentNode) a.parentNode.removeChild(a);
				} catch (x) { setErr(String((x && x.message) || x)); }
			}
			function lgCopy(t) {
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; }
				} catch (x) { /* 剪贴板不可用时忽略 */ }
			}
			function logSec() {
				var files = (lg && lg.files) || [];
				var dirIn = { fontFamily: "inherit", fontSize: 11, lineHeight: "18px", color: "inherit", background: "rgba(127,127,150,.06)", border: "1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.35))", borderRadius: 7, padding: "2px 6px", minWidth: 110, flex: "1 1 120px", maxWidth: 180 };
				return e("div", { className: "ci-sec" },
					e("div", { className: "ci-sech" }, "日志编译 · LOGcompiler",
						e("span", { className: "ci-badge " + ((lg && lg.mounted) ? "ci-on" : "ci-off"), style: { marginLeft: 6 }, title: (lg && lg.mounted) ? "插件已装载" : "插件未装载（仅配置保存）" })),
					(!(lg && lg.mounted) ? e("div", { className: "ci-sub", style: { color: "rgba(255,170,90,.9)" } }, "LOGcompiler 插件未装载：设置先保存，装载后生效") : null),
					e("div", { className: "ci-toggle ci-lg" + (lgEnabled ? " ci-lgon" : ""), style: { marginTop: 6 }, onClick: function () { lgPost({ enabled: !lgEnabled }); } },
						e("span", { className: "ci-switch" }), e("span", { style: { fontSize: 12 } }, lgEnabled ? "记录中" : "已暂停")),
					e("div", { className: "ci-sub", style: { margin: "8px 0 4px" } }, "输出目录：" + ((lg && lg.logsDir) || "(内部默认 <state>/transcripts)")),
					e("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
						e("input", { style: dirIn, placeholder: "留空=内部默认", value: lgDir, onChange: function (ev) { setLgDir((ev && ev.target && ev.target.value) || ""); } }),
						e("button", { className: "ci-btn", disabled: lgBusy, onClick: function () { lgPost({ logsDir: lgDir.trim() || null }); } }, "保存目录"),
						e("button", { className: "ci-btn", disabled: lgBusy, onClick: function () { setLgDir(""); lgPost({ logsDir: null }); } }, "恢复默认")),
					e("div", { className: "ci-grp", style: { marginTop: 6 } },
						e("div", { className: "ci-grphd", style: { cursor: "default" } },
							e("span", { style: { flex: 1 } }, "会话记录 · 按工作区"),
							e("span", { className: "ci-sub" }, lgEnabled ? "默认全开" : "已停")),
						wsNames.length ? wsNames.map(function (w) {
							var list = (wss[w] || []).filter(function (s) { return !s.archived; });
							if (!list.length) return null;
							var open = !!lgOpenWs[w] || (wsNames.length === 1); // 单工作区默认展开
							var recN = 0; list.forEach(function (s) { if (lgRec(s.id)) recN++; });
							return e("div", { key: w, className: "ci-grp" + (open ? " ci-open" : "") },
								e("div", { className: "ci-grphd", onClick: function () { toggleLgGroup(w); } },
									e("span", { className: "ci-caret" }, "▶"),
									e("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, w || "(未分组)"),
									e("span", { className: "ci-sub" }, recN + "/" + list.length)),
								(open ? e("div", { className: "ci-chips" }, list.map(function (s) {
									var rec = lgRec(s.id);
									return e("span", { key: s.id, className: "ci-chip" + (rec ? " ci-chipon" : ""), title: s.id + (s.workspace ? " @ " + s.workspace : "") + (rec ? " · 记录中" : " · 已关") + "（右键可导出 LOG）", onClick: function () { lgPost({ sessionId: s.id, on: !rec }); },
										onContextMenu: function (ev) {
											ev.preventDefault(); ev.stopPropagation();
											setCtxMenu({ x: ev.clientX, y: ev.clientY, sid: s.id, title: s.title || shortId(s.id), hasLog: lgHasLog(s.id) });
										} },
										(rec ? "● " : "○ ") + (s.title || shortId(s.id)));
								})) : null));
						}) : e("div", { className: "ci-sub" }, "暂无会话")),
					e("div", { className: "ci-sub", style: { marginTop: 6 } }, files.length ? "已生成 " + files.length + " 份转录文件" : "（尚无转录文件）"),
					// 右键菜单：会话 chip 上右键弹出（fixed 定位；贴边时向内收，视口外不溢出）
					// 【取自 RCS-0.1.0 返回包】菜单自身 stopPropagation，点它不会顺带关掉/触发底下的 chip。
					ctxMenu ? e("div", {
						className: "ci-ctx",
						style: {
							left: Math.max(6, Math.min(ctxMenu.x, (window.innerWidth || 1200) - 200)),
							top: Math.max(6, Math.min(ctxMenu.y, (window.innerHeight || 800) - 110)),
						},
						onClick: function (ev) { ev.stopPropagation(); },
						onContextMenu: function (ev) { ev.preventDefault(); ev.stopPropagation(); },
					},
						e("div", { className: "ci-ctx-hd", title: ctxMenu.sid }, ctxMenu.title),
						e("button", { disabled: !ctxMenu.hasLog, title: ctxMenu.hasLog ? "" : "该会话还没有转录文件", onClick: function () { lgExport(ctxMenu.sid); setCtxMenu(null); } }, "导出 LOG"),
						(!ctxMenu.hasLog ? e("div", { className: "ci-ctx-hd", style: { borderBottom: 0, marginBottom: 0, paddingTop: 0 } }, "该会话还没有转录文件") : null),
						e("button", { onClick: function () { lgCopy(ctxMenu.sid); setCtxMenu(null); } }, "复制会话 ID")) : null);
			}

			// A档实验开关：工具结果结构化折叠（[T]+[V]，toolfold；默认 OFF）
			var tfOn = !!(data && data.control && data.control.toolfoldStructured === true);
			function setToolfold(on) {
				fetch("/api/context-inject/config", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ toolfoldStructured: !!on }),
				}).then(function (r) { return r.json(); }).then(function (resp) {
					if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp));
					return status();
				}).catch(function (x) { setErr(String((x && x.message) || x)); });
			}

			return e(ErrorBoundary, null,
				e("div", { className: "ci-root" },
					e("div", { className: "ci-hd " + (lfOn ? "ci-on" : ""), style: { marginBottom: 8 } },
						e("div", { className: "ci-badge " + (lfOn ? "ci-on" : "ci-off") }),
						e("div", { style: { flex: 1, minWidth: 0 } },
							e("div", { className: "ci-title" }, "CONTEXTinjector"),
							e("div", { className: "ci-sub" }, lfOn ? "注入中 · 白名单会话在跨轮后折叠为转录" : "默认关闭 · 勾选会话后才生效")),
						e("div", { className: "ci-toggle", onClick: function () { save({ enabled: !on, sessions: Object.keys(sel).filter(function (k) { return sel[k]; }) }); } },
							e("span", { className: "ci-switch" }), e("span", { style: { fontSize: 12 } }, on ? "开" : "关"))),
					(err ? e("div", { className: "ci-err" }, "⚠ " + err) : null),
					e("div", { className: "ci-cols" },
						e("div", { className: "ci-main" },
							e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "\u538B\u7F29\u5668\u6A21\u578B"),
								e("div", { className: "ci-sub", style: { marginBottom: 6 } }, "single/double \u6863\u538B\u7F29 AI \u6B63\u6587\u65F6\u7528\u7684\u6A21\u578B\uFF1B\u9ED8\u8BA4\u8DDF\u968F\u4F1A\u8BDD\u5F53\u524D\u6A21\u578B\uFF08\u65E0\u9700\u914D\u7F6E\uFF09"),
								(mdlErr ? e("div", { className: "ci-err" }, "\u26A0 " + mdlErr) : null),
								(mdl && mdl.llmAvailable === false ? e("div", { className: "ci-err" }, "DSH \u672A\u63D0\u4F9B llm \u670D\u52A1\uFF1Asingle/double \u6863\u5C06\u81EA\u52A8\u56DE\u9000\u65E0\u635F") : null),
								(lf && lf.condenseErr ? e("div", { className: "ci-err" }, "\u4E0A\u6B21\u6298\u53E0\u538B\u7F29\u8C03\u7528\u9519\u8BEF\uFF1A" + (lf.condenseErrKind ? "[" + lf.condenseErrKind + "] " : "") + lf.condenseErr) : null),
								e("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
									e("select", { className: "ci-sel", value: selP, onChange: onProviderChange, title: "\u538B\u7F29\u5668\u7528 provider\uFF1B\u300C\u8DDF\u968F\u4F1A\u8BDD\u6A21\u578B\u300D = \u7528\u8BE5\u4F1A\u8BDD\u5F53\u524D\u6A21\u578B\uFF08\u6E05\u9664\u8986\u76D6\uFF09" },
										e("option", { value: "" }, "\u8DDF\u968F\u4F1A\u8BDD\u6A21\u578B"),
										((mdl && mdl.providers) || []).map(function (p) { return e("option", { key: p.id, value: p.id }, (p.name || p.id)); })),
									e("select", { className: "ci-sel", value: selM, disabled: !selP, onChange: onModelChange, title: "\u9009\u5B9A\u5373\u4FDD\u5B58\u4E3A\u8BE5\u4F1A\u8BDD\u538B\u7F29\u5668\u6A21\u578B\uFF08\u4E0E provider \u6210\u5BF9\uFF09" },
										e("option", { value: "" }, selP ? "\u9009\u62E9\u6A21\u578B\u2026" : "\u2014"),
										((mdl && mdl.models) || []).map(function (m) { return e("option", { key: m.id, value: m.id }, (m.name || m.id)); }))),
								e("div", { className: "ci-sub", style: { marginTop: 6 } },
									(lf && lf.condenseRoute
										? "\u4E0A\u6B21\u6298\u53E0\u5B9E\u9645\u4F7F\u7528\uFF1A" + lf.condenseRoute.provider + " / " + lf.condenseRoute.model + " (" + lf.condenseRoute.via + ")"
										: "\u5F53\u524D\uFF1A" + ((mdl && mdl.current && mdl.current.provider) ? mdl.current.provider + " / " + mdl.current.model : "\u8DDF\u968F\u4F1A\u8BDD\u6A21\u578B")))),
							e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "\u538B\u7F29\u53C2\u6570\uFF08maxtokens / \u6700\u5C0F\u957F\u5EA6\uFF09"),
								e("div", { className: "ci-sub", style: { marginBottom: 6 } }, "single/double \u6863\u6BCF\u6B21\u538B\u7F29\u7684 token \u4E0A\u9650\uFF1B\u7559\u7A7A = \u5185\u7F6E\u9ED8\u8BA4(700)\uFF0C\u8DDF\u968F\u6A21\u578B\u7A97\u53E3\u5F85\u63A5"),
								e("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
									e("input", { className: "ci-sel", style: { width: 120 }, type: "number", min: 64, step: 64, placeholder: curMT != null ? String(curMT) : "\u9ED8\u8BA4700", value: mtInp, onChange: function (ev) { setMtInp((ev && ev.target && ev.target.value) || ""); } }),
									e("button", { className: "ci-btn", disabled: busy, onClick: function () { var v = Number(mtInp); saveMaxTokens(Number.isFinite(v) && v >= 64 ? Math.floor(v) : null); } }, "\u4FDD\u5B58"),
									e("button", { className: "ci-btn", disabled: busy, onClick: function () { setMtInp(""); saveMaxTokens(null); } }, "\u6062\u590D\u9ED8\u8BA4"),
									e("span", { className: "ci-sub" }, curMT != null ? "\u5F53\u524D " + curMT : "\u9ED8\u8BA4 700"),
									e("span", { className: "ci-sub", style: { marginLeft: 10 } }, "\u538B\u7F29\u6700\u5C0F\u957F\u5EA6"),
									e("input", { className: "ci-sel", style: { width: 110 }, type: "number", min: 0, step: 1, placeholder: curMB != null ? String(curMB) : "\u9ED8\u8BA4240", title: "0 = \u4E0D\u8BBE\u95E8\u69DB\uFF08\u6BCF\u6761 [A] \u90FD\u538B\u7F29\uFF0C\u538B\u7F29\u8C03\u7528\u6B21\u6570\u660E\u663E\u589E\u52A0\uFF09", value: mbInp, onChange: function (ev) { setMbInp((ev && ev.target && ev.target.value) || ""); } }),
									e("button", { className: "ci-btn", disabled: busy, onClick: function () { var t = String(mbInp).trim(); var v = Number(t); saveMinBytes(t !== "" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null); } }, "\u4FDD\u5B58"),
									e("button", { className: "ci-btn", disabled: busy, onClick: function () { setMbInp(""); saveMinBytes(null); } }, "\u6062\u590D\u9ED8\u8BA4"),
									e("span", { className: "ci-sub" }, curMB != null ? "\u5F53\u524D " + curMB : "\u9ED8\u8BA4 240")),
								e("div", { className: "ci-sub", style: { marginTop: 6 } }, "\u538B\u7F29\u6700\u5C0F\u957F\u5EA6\uFF1A[A] \u6B63\u6587\u77ED\u4E8E\u6B64\u957F\u5EA6\u4E0D\u538B\u7F29\uFF1B0 = \u4E0D\u8BBE\u95E8\u69DB\uFF08\u6BCF\u6761 [A] \u90FD\u538B\u7F29\uFF0C\u538B\u7F29\u8C03\u7528\u6B21\u6570\u660E\u663E\u589E\u52A0\uFF09\uFF1B\u7559\u7A7A/\u6E05\u9664 = \u5185\u7F6E\u9ED8\u8BA4 240")),
							e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "\u538B\u7F29\u63D0\u793A\u8BCD"),
								e("div", { className: "ci-sub", style: { marginBottom: 6 } }, "single\uff1a\u5355\u6B21\u538B\u7F29\u6A21\u5F0F\uff1bkeys\uff1a\u989D\u5916\u8FDB\u884C\u5173\u952E\u503C\u63D0\u53D6\u6A21\u5F0F\uff1b\u7559\u7A7A = \u5185\u7F6E\u9ED8\u8BA4"),
								e("div", { className: "ci-sub", style: { margin: "6px 0 2px" } }, "single \u63D0\u793A\u8BCD\uff08\u5355\u6B21\u538B\u7F29\uff09\uff1A"),
								e("textarea", { rows: 3, style: { width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 11, color: "inherit", background: "rgba(127,127,150,.06)", border: "1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.3))", borderRadius: 7, padding: "4px 6px" }, placeholder: curPrompts && curPrompts.single ? "\u5DF2\u81EA\u5B9A\u4E49" : "\u5185\u7F6E\u9ED8\u8BA4\uFF08\u7A7A=\u6E05\u9664\u56DE\u5F52\u9ED8\u8BA4\uFF09", value: prompts.single, onChange: function (ev) { setPrompts({ single: (ev && ev.target && ev.target.value) || "", keys: prompts.keys }); } }),
								e("div", { className: "ci-sub", style: { margin: "6px 0 2px" } }, "keys \u63D0\u793A\u8BCD\uff08\u5173\u952E\u503C\u63D0\u53D6\uff09\uff1A"),
								e("textarea", { rows: 3, style: { width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 11, color: "inherit", background: "rgba(127,127,150,.06)", border: "1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.3))", borderRadius: 7, padding: "4px 6px" }, placeholder: curPrompts && curPrompts.keys ? "\u5DF2\u81EA\u5B9A\u4E49" : "\u5185\u7F6E\u9ED8\u8BA4\uFF08\u7A7A=\u6E05\u9664\u56DE\u5F52\u9ED8\u8BA4\uFF09", value: prompts.keys, onChange: function (ev) { setPrompts({ single: prompts.single, keys: (ev && ev.target && ev.target.value) || "" }); } }),
								e("div", { style: { display: "flex", gap: 6, marginTop: 6 } },
									e("button", { className: "ci-btn", disabled: busy, onClick: function () { savePrompts({ single: prompts.single.trim() || null, keys: prompts.keys.trim() || null }); } }, "\u5E94\u7528"),
									e("button", { className: "ci-btn", disabled: busy, onClick: function () { setPrompts({ single: "", keys: "" }); savePrompts(null); } }, "\u56DE\u5F52\u9ED8\u8BA4"))),
								e("div", { style: { marginTop: 8 } },
									e("button", { className: "ci-btn", onClick: function () { setShowDefPrompts(!showDefPrompts); } }, showDefPrompts ? "\u6536\u8D77\u9ED8\u8BA4\u63D0\u793A\u8BCD" : "\u67E5\u770B\u9ED8\u8BA4\u63D0\u793A\u8BCD")),
								(showDefPrompts ? [
									e("div", { key: "ds", className: "ci-sub", style: { margin: "6px 0 2px" } }, "\u9ED8\u8BA4 single\uFF1A"),
									e("div", { key: "dsv", style: { maxHeight: 90, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: 11, color: "var(--dsw-alias-label-secondary,rgba(180,180,195,.8))", background: "rgba(127,127,150,.05)", border: "1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.2))", borderRadius: 7, padding: "4px 6px" } }, (defaultPrompts && defaultPrompts.single) || "(\u65E0)"),
									e("div", { key: "dk", className: "ci-sub", style: { margin: "6px 0 2px" } }, "\u9ED8\u8BA4 keys\uFF1A"),
									e("div", { key: "dkv", style: { maxHeight: 90, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: 11, color: "var(--dsw-alias-label-secondary,rgba(180,180,195,.8))", background: "rgba(127,127,150,.05)", border: "1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.2))", borderRadius: 7, padding: "4px 6px" } }, (defaultPrompts && defaultPrompts.keys) || "(\u65E0)")
								] : null),
							e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "\u538B\u7F29\u5668IO\u6BD4"),
								(data && data.ivr && data.ivr.rounds && data.ivr.rounds.length ? [
									e("div", { key: "iv", className: "ci-metrics" },
										e("span", null, "\u7D2F\u8BA1\u8F93\u5165 ", e("b", null, (data.ivr.cumIn ?? 0) + "B")),
										e("span", null, "\u7D2F\u8BA1\u8F93\u51FA ", e("b", null, (data.ivr.cumOut ?? 0) + "B")),
										e("span", null, "\u6BD4\u503C ", e("b", null, data.ivr.cumRatio ?? "?")),
										e("span", null, "\u5171 ", e("b", null, data.ivr.rounds.length), " \u8F6E")),
									e(IvrChart, { key: "ch", rounds: data.ivr.rounds }),
									e("div", { key: "ivr", style: { maxHeight: 90, overflowY: "auto", fontSize: 11, fontFamily: "var(--ds-font-family-code,ui-monospace,Consolas,monospace)" } },
										data.ivr.rounds.map(function (r, i) { return e("div", { key: i }, "\u7B2C" + (i + 1) + "\u8F6E\uFF1A\u8F93\u5165 " + r.inBytes + "B \u2192 \u8F93\u51FA " + r.outBytes + "B\uFF0C\u6BD4\u503C " + r.ratio); }))
								] : e("div", { className: "ci-sub" }, "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u6298\u53E0\u8FC7")),
								e("div", { className: "ci-sub", style: { marginTop: 6 } }, "\u6BD4\u503C = \u8F93\u5165 \u00F7 \u8F93\u51FA\u3002\u503C\u8D8A\u5927\u5219\u538B\u7F29\u6389\u7684\u91CF\u8D8A\u5927\uFF0C\u4FDD\u5B88\u53CD\u6620\u8F93\u5165\u7ECF\u6D4E\u6027\u3002\u84DD\u7EBF\uFF1D\u6BCF\u8F6E\uFF0C\u7EFF\u7EBF\uFF1D\u7D2F\u8BA1\uFF1B\u865A\u7EBF\uFF1D\u6BD4\u503C 1 \u53C2\u8003\u7EBF\u3002")),
							e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "最近一次折叠",
									// 上次折叠的触发点标签：用户靠它判断"本轮结束即折"（turn-stopping）到底有没有跑过
									(lf && lf.trigger ? e("span", { className: "ci-sub", title: "这次折叠由哪个触发点产生：turn-stopping = 本轮 AI 输出结束即折；pre-step = 下一轮请求前折" }, "触发：" + trigLabel(lf.trigger)) : null),
									e("button", { className: "ci-btn", style: { marginLeft: "auto" }, onClick: status }, "刷新")),
								// 在飞 → 醒目显示「上一轮输出压缩中…」；刚结束 → 极简「已完成」；平时什么都不显示
								(finOn ? inflightLine(fin) : (finDoneAt && (Date.now() - finDoneAt) < FIN_DONE_MS ? e("div", { className: "ci-sub", style: { marginBottom: 6, color: "rgba(52,199,89,.9)" } }, "已完成") : null)),
								(lf ? [
									e("div", { key: "m", className: "ci-metrics" },
										e("span", null, "round ", e("b", null, lf.round ?? "?"), " · step ", e("b", null, lf.step ?? "?")),
										e("span", null, "压缩 ", e("b", null, (lf.incrementalRawBytes ?? lf.shadowedBytes ?? "?") + " → " + (lf.appendedBytes ?? lf.transcriptBytes ?? "?") + " B"), " (", e("b", null, Math.round((lf.shrink ?? 1) * 100) + "%"), ")"),
										e("span", null, "gate ", e("b", null, lf.gate || "?")),
										e("span", null, "档 ", e("b", null, lf.mode || "off")),
										e("span", null, "hash ", e("b", null, String(lf.transcriptHash || "").slice(0, 8))),
										e("span", null, "monotonic ", e("b", null, lf.monotonic === true ? "✓" : lf.monotonic || "?"))),
									e("div", { key: "n", className: "ci-sub" }, "请求结构：" + (lf.afterNodes && lf.afterNodes.length ? lf.afterNodes.map(function (x) { return x.role + (x.src ? "/" + x.src : "") + ":" + x.bytes + "B"; }).join(" · ") : "—")),
									e("hr", { key: "r", className: "ci-hr" }),
									timeline(shown),
									(rounds.length > 3 ? e("div", { key: "ra", className: "ci-actions" }, e("button", { className: "ci-btn", onClick: function () { setAllRounds(!allRounds); } }, allRounds ? "仅显示最近 3 轮" : "显示全部 " + rounds.length + " 轮")) : null)
								// 在飞且还没折过：上面的「压缩中…」已是唯一可说的内容，不再并排一句"尚无折叠发生"（自相矛盾）
								] : (finOn ? null : e("div", { className: "ci-sub" }, "尚无折叠发生（把当前会话加入白名单，跨轮对话后出现）"))))),
						e("div", { className: "ci-rail" },
							(cur ? e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "当前会话",
									e("span", { className: "ci-badge " + (sel[cur] ? "ci-on" : "ci-off"), style: { marginLeft: 6 }, title: sel[cur] ? "已入白名单（将折叠）" : "未入白名单（不折叠）" }),
									// 导出本会话 LOG 的显式入口（右键菜单不好找；无转录时置灰并说明）【取自 RCS-0.1.0 返回包】
									e("button", { className: "ci-btn", style: { marginLeft: "auto", padding: "2px 9px" }, disabled: !lgHasLog(cur),
										title: lgHasLog(cur) ? "下载本会话的 LOGcompiler 转录文件" : "本会话还没有转录文件（尚未记录到任何一轮）",
										onClick: function () { lgExport(cur); } }, "导出 LOG")),
								e("div", { className: "ci-sub", style: { margin: "0 0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, cur),
								e("div", { className: "ci-sech", style: { marginBottom: 6 } }, "本会话压缩档"),
								e("div", { className: "cim-chips", style: { marginBottom: 4 } }, MODE_OPTS.map(function (o) {
									var active = (curOwn(cur) || "none") === o[0];
									return e("button", { key: o[0], className: "cim-chip" + (active ? " cim-on" : ""), disabled: busy,
										title: o[0] === "none" ? "本会话不折叠" : o[0] === "off" ? "对每轮对话做工具转录折叠（保留原始信息）" : o[0] === "single" ? "对每轮AI输出进行语义压缩" : "单次压缩基础上进行关键值保真提取",
										onClick: function () { pickMode(cur, o[0]); } }, o[1]);
								})),
								e("hr", { className: "ci-hr" }),
								e("div", { className: "ci-toggle ci-lg" + (tfOn ? " ci-lgon" : ""), style: { marginTop: 2 }, title: "实验（A档，默认关）：工具结果折叠为结构化 [T]（P0–P3）+ 值保真链 [V]", onClick: function () { setToolfold(!tfOn); } },
									e("span", { className: "ci-switch" }), e("span", { style: { fontSize: 12 } }, "工具结果结构化折叠（实验）")),
								e("div", { className: "ci-sub", style: { marginTop: 2 } }, tfOn ? "开启：read/edit/grep/bash/ask_user 等折叠为结构化行 + [V] 值保真链" : "默认关（保现行为）。开启后对工具结果生成 P 级/指纹/err 结构化行。"),
								(sel[cur] && !curOwn(cur) ? e("div", { className: "ci-sub", style: { marginTop: 4 } }, "白名单内但未选档→不折叠；选任一档即启用") : null)) : null),
							e("div", { className: "ci-sec" },
								e("div", { className: "ci-sech" }, "会话白名单 · 按工作区（已归档不列出）"),
								(wsNames.length ? wsNames.map(function (w) {
									var list = (wss[w] || []).filter(function (s) { return !s.archived; });
									if (!list.length) return null;
									var open = !!openWs[w];
									var picked = list.filter(function (s) { return sel[s.id]; }).length;
									return e("div", { key: w, className: "ci-grp" + (open ? " ci-open" : "") },
										e("div", { className: "ci-grphd", onClick: function () { toggleGroup(w); } },
											e("span", { className: "ci-caret" }, "▶"),
											e("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, w || "(未分组)"),
											e("span", { className: "ci-sub" }, picked + "/" + list.length)),
										(open ? e("div", { className: "ci-chips" }, list.map(function (s) { return chip(s); })) : null));
								}) : e("div", { className: "ci-sub" }, "暂无会话"))),
							logSec())
					)
				)
			);
		}
		// ===== composer dock：首条发送前的「本会话压缩模式」选择器 =====
		// 注册于 conversation.input.dock —— 该槽位在空白会话（首轮发送前）同样渲染，故首轮之前即可选档。
		// 规则（修：切回已选会话不再复现；点"关"也消失）：
		//   - 会话在 sessionModes 里已选档（off/single/double）→ 隐藏（有注入 tab 可改）。
		//   - 会话已被本机"决策过"（本地 dismissed 记忆，含选"关"）→ 隐藏，跨会话切入不重现。
		//   - 否则（新会话未决策）→ 显示；点任一档（含"关"）即写档并把 sid 记为已决策。
		// 本地记忆用 localStorage keyed by 归一 sid；换 sid（新会话）自然重新出现。
		var MODE_OPTS = [["none", "关"], ["off", "工具折叠"], ["single", "单压缩"], ["double", "双压缩"]];
		function DockMemo() { return "contextinjector.dock.dismissed"; }
		function dockMemoRead() { try { return JSON.parse(localStorage.getItem(DockMemo()) || "{}") || {} } catch (e) { return {} } }
		function dockMemoAdd(sid) { try { var m = dockMemoRead(); m[normSidStr(sid)] = 1; localStorage.setItem(DockMemo(), JSON.stringify(m)) } catch (e) {} }
		function normSidStr(s) { return String(s || "").replace(/^session-/i, ""); }
		function ModeDock(props) {
			var sid = (props && props.sessionId) || null;
			var _c = useState(null), ctrl = _c[0], setCtrl = _c[1];
			var _b = useState(false), busy = _b[0], setBusy = _b[1];
			var _hid = useState(false), hidden = _hid[0], setHidden = _hid[1];
			function pull() {
				return fetch("/api/context-inject/status", { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (s) { setCtrl(s && s.control ? s.control : null); })
					.catch(function () {});
			}
			useEffect(function () {
				setHidden(false); // 会话切换后重置本态（是否已选仍由 ctrl 决定）
				pull();
				var iv = setInterval(pull, 6000);
				return function () { clearInterval(iv); };
			}, [sid]);
			function pick(mode) {
				if (!sid) return;
				setBusy(true);
				fetch("/api/context-inject/session", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: sid, mode: mode }),
				}).then(function (r) { return r.json(); }).then(function (resp) {
					if (!resp || resp.ok !== true) throw new Error(JSON.stringify(resp));
					dockMemoAdd(sid); // 无论选何档（含"关"）都记为已决策 → 隐藏
					setHidden(true);
					return pull();
				}).catch(function () {}).finally(function () { setBusy(false); });
			}
			if (!sid) return null;
			var n = normSidStr(sid);
			var sm = ctrl && ctrl.sessionModes;
			var own = null;
			if (sm && typeof sm === "object") { Object.keys(sm).forEach(function (k) { if (own === null && normSidStr(k) === n) own = sm[k]; }); }
			// 已选档 / 已本地决策 / 本实例已点过 → 隐藏
			if (own !== null || hidden || dockMemoRead()[n]) return null;
			var inList = ((ctrl && ctrl.sessions) || []).some(function (x) { return normSidStr(x) === n; });
			return e("div", { className: "cim-dock" },
				e("span", { className: "cim-lb", title: "本会话的上下文压缩模式；随时可改，在跨轮折叠时生效" }, "压缩"),
				e("div", { className: "cim-chips" }, MODE_OPTS.map(function (o) {
					return e("button", {
						key: o[0], className: "cim-chip", disabled: busy,
						title: o[0] === "none" ? "本会话不折叠" : o[0] === "off" ? "工具转录折叠" : o[0] === "single" ? "语义压缩" : "语义压缩 + 值保真（保真最高）",
						onClick: function () { pick(o[0]); },
					}, o[1]);
				})),
				(inList && !own ? e("span", { className: "cim-hint", title: "白名单内但未选档 → 不折叠；选择任一档即启用" }, "未选档·不折叠") : null));
		}
		// ===== 【会话页·在飞折叠】「压缩中」小标的参数形态兼容层（v2.4）=====
		// 背景（用户反复报「会话页从来没有『压缩中』小标」）：小标只由 /status.foldInflight 驱动，
		//   所以"渲染不出来"只可能是 ①插槽根本没渲染到我们 ②拿不到会话 id ③颜色看不见 ④窗口太短没逮到。
		//   ②的成因是**插槽参数形态**——本文件原先只吃 `props.sessionId` 一种形态：
		//     · owner props：`conversation.input.left` 传的是 **zone 对象** `{session, input}`
		//       （dsh-client-ui-conversation/lib/client.js:7191-7194 构造、:7241 `renderSlot("conversation.input.left", zone)`；
		//        契约文档 dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:270-274 `owner: InputZone`，
		//        同文件 :395-397 `interface InputZone { session: ConversationSnapshot; input: InputState }`）；
		//     · standard kit：渲染器给每个 entry 铺 `sessionId`（dsh-client-ui-renderer/lib/client.js:535-567，
		//        其中 :563 `standard["sessionId"] = info.sessionId`）；
		//     · entry 自己的 inject：以 `(sessionId, actions)` 调用（同文件 :334-341 `runInject`），
		//        本文件的 inject 正是据此写（另见 DSH 自带 entry 的写法
		//        dsh-client-ui-conversation/lib/client.js:10006 `inject: (sessionId) => ({...})`）。
		//   ⇒ 结论：正常路径下 `props.sessionId` **就是**裸会话 id；但三者任一被 DSH 改口径都会**静默**打死小标
		//     （渲染函数返回 null，控制台一句都不说）。这里把 5 种可能形态全部吃下 + 挂载一行、**每次状态跃迁
		//     各一行**诊断日志（`[ci-foldchip]`；跃迁行带 `Δ=`），再也不可能出现"看不到又查不出"的局面。
		// 形态清单：裸字符串 / {sessionId} / {session:{id}} / {session:"sid"} / {id}
		function ciSidFrom(v) {
			if (typeof v === "string") return v.trim() || null;
			if (typeof v === "number" && Number.isFinite(v)) return String(v);
			if (!v || typeof v !== "object") return null;
			if (typeof v.sessionId === "string" && v.sessionId.trim()) return v.sessionId.trim();
			var s = v.session;
			if (typeof s === "string" && s.trim()) return s.trim();
			if (s && typeof s === "object") {
				if (typeof s.sessionId === "string" && s.sessionId.trim()) return s.sessionId.trim();
				if (typeof s.id === "string" && s.id.trim()) return s.id.trim();
			}
			if (typeof v.id === "string" && v.id.trim()) return v.id.trim();
			return null;
		}
		// props（对象或裸字符串）→ { sid, via }；via 只用于诊断日志，取最具体的来源名
		function ciChipSid(props) {
			if (typeof props === "string") { var b = props.trim(); return { sid: b || null, via: b ? "bare-string" : "none" }; }
			var p = props || {};
			if (typeof p.sessionId === "string" && p.sessionId.trim()) return { sid: p.sessionId.trim(), via: "props.sessionId" };
			var s = p.session;
			if (typeof s === "string" && s.trim()) return { sid: s.trim(), via: "props.session" };
			if (s && typeof s === "object") {
				if (typeof s.sessionId === "string" && s.sessionId.trim()) return { sid: s.sessionId.trim(), via: "props.session.sessionId" };
				if (typeof s.id === "string" && s.id.trim()) return { sid: s.id.trim(), via: "props.session.id" };
			}
			if (typeof p.id === "string" && p.id.trim()) return { sid: p.id.trim(), via: "props.id" };
			return { sid: null, via: "none" };
		}
		// 形态摘要（日志与 title 共用）：只报"在不在 + 什么类型 + 多长"，绝不打值本身（会话 id 不进 UI 文案）
		function ciShapeBrief(props) {
			if (typeof props === "string") return "arg=string[" + props.length + "]";
			var p = props || {};
			return ["sessionId", "session", "id", "input"].map(function (k) {
				if (!(k in p)) return k + "=absent";
				var v = p[k];
				return k + "=" + (v === null ? "null" : typeof v === "string" ? "string[" + v.length + "]" : Array.isArray(v) ? "array" : typeof v);
			}).join(" ");
		}
		function ciPropsKeys(props) {
			try { return typeof props === "string" ? "(bare-string)" : Object.keys(props || {}).join(","); }
			catch (x) { return "(unreadable)"; }
		}
		// 【诊断】挂载打一行 + **每次状态跃迁各打一行**（旧实现只在挂载打一行，压缩期在控制台没有任何证据行）。
		//   为什么改（用户实测 2026-09-10）：旧口径下控制台永远只有 `foldInflight=no`（挂载那一刻本来就没在折），
		//     真实压缩的瞬间没有日志 ⇒ 无法一次性判定是"标记根本没写"还是"写了但采样窗口没对上"。
		//   现口径：**状态指纹**不变就不打（0.5s 连续采样 ⇒ 同一状态绝不刷屏），指纹变化时打一行，跃迁行带 `Δ=`。
		//     指纹 = 形状 + keys + sid + via + foldInflight(含 trigger) + globalInflight 计数 + force + 采样错误；
		//     ⚠ `age`（秒数）**不进指纹** —— 它每秒都在变，进了就会按秒刷屏（违背"不许按拍刷屏"）。
		//   排障口径（devtools 控制台筛 `[ci-foldchip]`）：
		//     · 一行都没有 ⇒ 插槽没渲染到我们（落点/注册问题，与 sessionId 无关）；
		//     · sid=(none) ⇒ 形态没解析出来（把这行原样贴回来即可）；
		//     · 压缩期间出现 `Δ= … foldInflight=YES trigger=pre-step age=Ns` ⇒ 标记在写、采样也逮到了（渲染另查）；
		//     · 压缩期间一条 Δ 都没有 ⇒ 要么标记没写，要么该次折叠短于一拍（CI_STATUS_MS=500ms）；两者用
		//       `<DSH_HOME>/state-compiler/.ctxinjector/fold-inflight/<sid>.json`（=写没写）与 last-fold.json 的
		//       trigger 字段（=折没折）可一次判定。
		//   纯函数（故可回归测试，见 fold-boundary.test.mjs）：返回 { key, line } = 需要打这一行；返回 null = 与上一次同状态、不打。
		function ciFoldChipLogLine(prevKey, props, r, data, errText, forced) {
			try {
				var keys = ciPropsKeys(props);
				var shape = ciShapeBrief(props);
				var f = (data && data.foldInflight) || null;
				var all = (data && data.foldInflightAll) || null;
				var age = (f && Number.isFinite(Number(f.startedAt))) ? Math.max(0, Math.round((Date.now() - Number(f.startedAt)) / 1000)) : null;
				var fiKey = errText ? ("sample-error:" + errText) : f ? ("YES trigger=" + String(f.trigger)) : "no"; // 指纹用（不含 age）
				var fiLine = fiKey + (age != null ? " age=" + age + "s" : ""); // 日志用（含 age，与旧格式逐字一致）
				var g = all ? String(all.length) : "n/a";
				var key = shape + " | keys=[" + keys + "] | sid=" + (r.sid || "(none)") + " via=" + r.via
					+ " | foldInflight=" + fiKey + " | globalInflight=" + g + " | force=" + (forced ? "1" : "0");
				if (key === prevKey) return null; // 同状态连续采样：一行都不新增（防按拍刷屏）
				return {
					key: key,
					// 单行；字段与旧版一致（sid/via/foldInflight/trigger/age/globalInflight/force），跃迁行只多一个 `Δ=`
					line: "[ci-foldchip] " + (prevKey == null ? "mount" : "Δ=") + " " + shape + " | keys=[" + keys + "] | sid=" + (r.sid || "(none)") + " via=" + r.via
						+ " | foldInflight=" + fiLine + " | globalInflight=" + g + " | force=" + (forced ? "1" : "0"),
				};
			} catch (x) { return null; /* 诊断日志绝不允许影响渲染 */ }
		}
		// 【调试强制位】localStorage.setItem('ciFoldChipForce','1') + 刷新页面 ⇒ 不管有没有在飞折叠都渲染小标
		//   （样式与真身完全一致，只是 title 标注"强制显示（调试）"、DOM 上带 `data-ci-foldchip="force"`；
		//     若强制位开着而 sid 也没解析出来，title 里会一并写明，便于一次判定"落点/颜色/形态"。）
		//   关闭：localStorage.removeItem('ciFoldChipForce') + 刷新页面（无需重启服务）。
		//   为什么需要：真身只在后台折叠在飞的那几秒出现，用户很难逮住 ⇒ 用它把"看不见"这件事
		//   确定性地拆成"落点对不对"与"窗口够不够长"两个独立问题。
		var CI_FORCE_KEY = "ciFoldChipForce";
		function ciFoldForceOn() {
			try { return typeof localStorage !== "undefined" && localStorage.getItem(CI_FORCE_KEY) === "1"; }
			catch (x) { return false; } // 隐私模式/存储被禁 → 当没开（绝不影响渲染）
		}
		// 【会话页·在飞折叠】「压缩中」小标：会话页上直接可见（不再只藏在「注入」面板里）。
		//   数据源：与面板同一份共享 /status 快照（foldInflight per-sid）⇒ 无在飞时**不渲染任何节点**（return null）。
		//   落点 conversation.input.left（composer 操作行左侧工具簇 = 输入卡片左下角）：该处是 flex 行内位置，
		//   与同排档位选择器同字号 13px/20px，不改变行高 ⇒ 不挤动/不盖住 DSH 自己的「Deep diving...」状态行。
		//   秒数不另起定时器：共享采样器每 0.5s 重渲染即自动走秒（与面板 inflightLine 同一口径）。
		function FoldChip(props) {
			var r = ciChipSid(props);
			var sid = r.sid;
			var forced = ciFoldForceOn();
			var _s = useState(null), st = _s[0], setSt = _s[1];
			var logKeyRef = useRef(null); // 上一次已打日志的**状态指纹**（null = 还没打过 ⇒ 下一次是挂载行）
			// 【诊断】挂载一行 + 状态跃迁各一行；同状态连续采样不重复打。纯观测：只 console.log，不写文件、
			//   不起定时器（沿用模块级共享 500ms 采样器的回调），也不碰任何 state ⇒ 绝不影响小标渲染条件/样式。
			function logFoldChip(data, errText) {
				var lg = ciFoldChipLogLine(logKeyRef.current, props, r, data, errText, forced);
				if (!lg) return;                                  // 同状态：不打（防按拍刷屏）
				logKeyRef.current = lg.key;
				try { console.log(lg.line); } catch (x) { /* 打日志失败也绝不影响渲染 */ }
			}
			// 有 sid → 订阅该 sid；**没有 sid** → 订阅全局键 ""（见下面的兜底推断，绝不再静默 null）。
			var key = sid || "";
			useEffect(function () {
				setSt(null); // 键变化（换会话）先清空，别把上一个会话的"在飞"带过来
				return ciStatus.subscribe(key, function (snap) {
					// 采样失败 → 当作"无在飞"（宁可不报，也不误报一个永远转的小标）
					if (snap && snap.err) {
						setSt(null);
						logFoldChip(null, String((snap.err && snap.err.message) || snap.err));
						return;
					}
					var data = (snap && snap.data) || null;
					setSt(data);
					logFoldChip(data, null);
				});
			}, [key]);
			var f = (st && st.foldInflight) || null;
			// 【无 sid 兜底】本插槽按理一定拿得到会话 id（见上面形态层）。真拿不到时**不静默放弃**：
			//   用 host 在"不带 ?sessionId=" 时额外上报的 `foldInflightAll`（逐会话在飞标记列表）。
			//   限制（明确写下）：全局快照不知道当前看的是哪个会话 ⇒ 只有**全机恰好 1 个会话在飞**时才敢推断；
			//   多会话同时折叠时一律不显示（避免把别人的折叠显示成本会话的）；显示时 title 会写明"会话未知"。
			var all = (st && st.foldInflightAll) || null;
			var infer = (!sid && all && all.length === 1) ? all[0] : null;
			if (!forced && !f && !infer) return null; // 常态：一个节点都不渲染（不占位、不影响布局）
			var t0 = Number(f && f.startedAt);
			var sec = Number.isFinite(t0) ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : null;
			var title;
			if (f) {
				title = "上一轮输出正在后台压缩（" + trigLabel(f && f.trigger) + (sec != null ? " · 已 " + sec + "s" : "") + "）：浓缩模型返回后写入 last-fold，下一轮请求前并入上下文";
			} else if (infer) {
				title = "有会话正在后台压缩，但会话未知：全机恰好只有 1 个会话在飞（" + shortId(infer.sessionId) + " · " + trigLabel(infer.trigger) + "）。本插槽没拿到当前会话 id，故按全局唯一在飞推断，可能与当前会话无关；多会话同时在飞时本小标不显示";
			} else {
				title = "强制显示（调试）：实际只在折叠在飞时出现。当前采样=" + (st ? "无在飞" : "尚未返回") + "，sid=" + (sid || "(未解析到)") + "，形态 " + ciShapeBrief(props)
					+ "。关闭：localStorage.removeItem('ciFoldChipForce') 后刷新页面";
			}
			return e("span", { className: "ci-foldchip", role: "status", "aria-live": "polite",
				title: title, "data-ci-foldchip": forced ? "force" : (f ? "inflight" : "inferred") },
				e("span", { className: "ci-pulse" }),
				"压缩中");
		}
		// #5 压缩器IO比折线：横轴逐轮，蓝=每轮 I/O 比值，绿=累计 I/O 比值。★=里程碑轮
		//   ⚠ 修（本地缺陷：标签被拉扁/挤扁）【取自 RCS-0.1.0 返回包】：
		//     旧实现固定 viewBox 600×130 + preserveAspectRatio="none"，而 CSS 强制 width:100%;height:110px
		//     ⇒ x/y 各自缩放，容器不是 600 宽时文字被横向拉伸。现改为**实测容器像素**当 viewBox
		//     （1 用户单位 = 1 px，且不再用 preserveAspectRatio），文字等比、笔画不变形。
		function ivrChart(rounds, W, H, svgRef) {
			var pad = 6, top = 10, bot = 18;
			W = Math.max(240, Math.round(W || 600));
			H = Math.max(80, Math.round(H || 110));
			if (!rounds || !rounds.length) return null;
			var n = rounds.length;
			var xs = function (i) { return pad + (n === 1 ? W / 2 : (i / (n - 1)) * (W - 2 * pad)); };
			// 纵轴用"每轮比值"，自适应量程（比值可能 <1 也可能 >1）
			var vals = rounds.map(function (r) { return r.ratio; });
			var vmax = Math.max.apply(null, vals.concat([1.2]));
			var vmin = Math.min.apply(null, vals.concat([0.8]));
			var span = Math.max(0.2, vmax - vmin);
			var yR = function (v) { return top + (1 - (v - vmin) / span) * (H - top - bot); };
			var grid = [vmin, (vmin + vmax) / 2, vmax].map(function (g, i) {
				var yy = yR(g).toFixed(1);
				return e("g", { key: "g" + i },
					e("line", { x1: pad, y1: yy, x2: W - 24, y2: yy, stroke: "rgba(127,127,150,.14)", "stroke-width": 1 }),
					e("text", { x: W - 20, y: Number(yy) + 3, fontSize: 9, fill: "rgba(180,180,195,.6)", textAnchor: "start" }, g.toFixed(2)));
			});
			// 参考线：比值 1（输入＝输出 ⇒ 没有冗余可压）。量程恒含 [0.8, 1.2]，所以它一定落在图内。
			var refY = yR(1).toFixed(1);
			// 窄面板只写 "1"，避免长标签压住左侧数据点
			var refLabel = W >= 360 ? "\u6BD4\u503C 1\uFF08\u65E0\u5197\u4F59\u53EF\u538B\uFF09" : "1";
			var ref1 = e("g", { key: "ref1" },
				e("line", { x1: pad, y1: refY, x2: W - 24, y2: refY, stroke: "rgba(200,200,215,.45)", "stroke-width": 1, "stroke-dasharray": "4 3" }),
				e("text", { x: pad + 2, y: Number(refY) - 4, fontSize: 9, fill: "rgba(200,200,215,.8)", textAnchor: "start" }, refLabel));
			var lineR = rounds.map(function (r, i) { return (i ? "L" : "M") + xs(i).toFixed(1) + " " + yR(r.ratio).toFixed(1); }).join(" ");
			var lineC = rounds.map(function (r, i) { return (i ? "L" : "M") + xs(i).toFixed(1) + " " + yR(r.cumRatio).toFixed(1); }).join(" ");
			var dots = rounds.map(function (r, i) { return e("circle", { key: i, cx: xs(i), cy: yR(r.ratio), r: r.stageAnchor ? 3 : 1.8, fill: r.stageAnchor ? "#ffd479" : "#6ea8ff" }); });
			var xl0 = e("text", { key: "x0", x: pad, y: H - 3, fontSize: 9, fill: "rgba(180,180,195,.6)", textAnchor: "start" }, "r" + rounds[0].n);
			var xl1 = e("text", { key: "x1", x: W - 24, y: H - 3, fontSize: 9, fill: "rgba(180,180,195,.6)", textAnchor: "end" }, "r" + rounds[n - 1].n);
			// viewBox = 实测像素（无 preserveAspectRatio ⇒ 默认 meet，因比例一致即 1:1）
			return e("svg", { className: "ci-chart", ref: svgRef, viewBox: "0 0 " + W + " " + H },
				grid, ref1,
				e("path", { d: lineC, fill: "none", stroke: "rgba(120,200,120,.6)", "stroke-width": 1.5 }),
				e("path", { d: lineR, fill: "none", stroke: "#6ea8ff", "stroke-width": 1.5 }),
				dots, xl0, xl1);
		}
		// 图表宿主：用 ResizeObserver 实测容器像素尺寸喂给 viewBox（避免非等比缩放把字拉扁）
		//   【取自 RCS-0.1.0 返回包】ResizeObserver 不可用时回落 600×110（与 CSS 高度一致）；
		//   尺寸未变时不 setState（幂等守卫），免得每次 observe 回调都白重渲染一遍。
		function IvrChart(props) {
			var _wh = useState({ w: 600, h: 110 }), wh = _wh[0], setWh = _wh[1];
			var ref = useRef(null);
			useEffect(function () {
				var el = ref.current;
				if (!el || typeof ResizeObserver === "undefined") return;
				var measure = function () {
					var w = Math.round(el.clientWidth || 600), h = Math.round(el.clientHeight || 110);
					setWh(function (p) { return (p.w === w && p.h === h) ? p : { w: w, h: h }; });
				};
				measure();
				var ro = new ResizeObserver(measure);
				ro.observe(el);
				return function () { ro.disconnect(); };
			}, []);
			return ivrChart(props.rounds, wh.w, wh.h, ref);
		}
		var inject = ["slots"];
		function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register(
					{ name: "conversation.view", id: "contextinjector", order: 20, label: function () { return "\u6CE8\u5165"; },
						inject: function (sessionId) { return { sessionId: sessionId || null }; } },
					function (props) { return React.createElement(InjectView, props || {}); });
			});
			ctx.slots.inject("conversation.input.dock", function () {
				return ctx.slots.register(
					{ name: "conversation.input.dock", id: "contextinjector-mode", order: 80,
						inject: function (sessionId) { return { sessionId: sessionId || null }; } },
					function (props) { return React.createElement(ModeDock, props || {}); });
			});
			// v2.3【会话页·在飞折叠】「压缩中」小标：让"上一轮输出正在压缩"在会话页可见（不再只在注入面板里）。
			// 落点选择（按与 DSH「Deep diving...」状态行的贴近度排序）：
			//   DSH 那个状态行（tokens 在 dsh-client-ui-conversation/lib/client.js:5610 的 TurnStatus，由 ChatView
			//   直接内联渲染在聊天列尾部）**没有插槽** ⇒ 没有"同一行"可挂；会话页可用的最近插槽只有：
			//   ① conversation.input.left（本实现选用）：composer 操作行左侧工具簇，位于状态行正下方、同为左对齐；
			//      且是行内 flex 位置 ⇒ 新增 inline 小标不改行高，不会把 DSH 的状态行顶上去。
			//   ② conversation.input.dock（ModeDock 所在）：会多出整整一行，把上方聊天内容顶动（弃）。
			//   ③ conversation.composer.dock / session.header.utilities：分别在输入卡片下方、会话页顶部右角，更远（备选）。
			// 注：list 插槽的 options.id 是必填（SlotCore 对 kind:"list" 强校验），故带 id。
			// 【v2.4 参数形态结论（源码实证，勿再猜）】`conversation.input.left` 的 **owner props 是 zone 对象**
			//   `{session, input}`（dsh-client-ui-conversation/lib/client.js:7191-7194 构造 + :7241 传入；
			//   契约 slots.d.ts:270-274 `owner: InputZone`、:395-397 InputZone 定义）；
			//   而 **entry 自己的 inject 回调吃的是裸会话 id**（dsh-client-ui-renderer/lib/client.js:334-341：
			//   `if (info !== void 0) args.push(info.sessionId)` 后 `inject(...args)`；
			//   DSH 自带 entry 同款写法见 dsh-client-ui-conversation/lib/client.js:10006）；
			//   另外渲染器还会在 standard kit 里铺一份 `sessionId`（dsh-client-ui-renderer/lib/client.js:563）。
			//   ⇒ 组件侧 `props.sessionId` 本来是**有值**的；但为了任何一处口径变化都不再"静默打死小标"，
			//     ① 这个 inject 只在**拿到非空字符串**时才回填（若某版本改传 zone 对象，绝不回填，
			//        否则用对象覆盖掉 kit 里正确的 sessionId，小标会永远渲染不出来）；
			//     ② 组件侧另有 5 形态解析（ciChipSid）+ 挂载一行 / **每次状态跃迁各一行** `[ci-foldchip]` 诊断日志
			//        （跃迁行带 `Δ=`；同一状态连续采样不重复打，见 ciFoldChipLogLine）。
			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register(
					{ name: "conversation.input.left", id: "contextinjector-fold", order: 90,
						inject: function (arg) { return (typeof arg === "string" && arg.trim()) ? { sessionId: arg.trim() } : {}; } },
					function (props) { return React.createElement(FoldChip, props || {}); });
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
