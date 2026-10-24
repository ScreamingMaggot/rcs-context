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
			".ci-main{flex:1 1 540px;min-width:0;max-height:72vh;overflow-y:auto;overscroll-behavior:contain;padding-right:2px;padding-bottom:16px}",
			".ci-rail{flex:1 1 260px;min-width:230px;max-width:360px;display:flex;flex-direction:column;gap:10px;max-height:72vh;overflow-y:auto;overscroll-behavior:contain;padding-right:2px;padding-bottom:16px}",
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
			// 【v1.10.39 · 宿主折叠行隐藏】宿主按 compaction 协议渲染的「上下文已压缩 / 已压缩 N 条…」
			//   每折一次占一行、越来越长。插件改为在 composer 左侧自绘一行紧凑状态（本折/累计比值 +
			//   压缩中/记忆编译中脉冲）；宿主行全部隐藏。宿主原生 compaction 由本插件另写
			//   native-compaction 标记并在同一行补回（见 FoldChip），不会静默丢失。
			'[class*="compactionRow"]{display:none!important}',
			// 完成后收成中性色（琥珀只留给“正在发生”的状态，不再长期占据注意）
			".ci-foldchip-done{border-color:var(--dsw-alias-border-l2,rgba(127,127,150,.3));background:transparent;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8));font-weight:400}",
			".ci-foldchips{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}",
			// ===== MEMORY 面板 =====
			".mem-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0}",
			"@media (max-width:900px){.mem-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}",
			".mem-kpi{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.22));border-radius:11px;padding:9px 11px;background:rgba(127,127,150,.04)}",
			".mem-kpi b{display:block;font-size:20px;line-height:1.2;font-weight:650;font-variant-numeric:tabular-nums}",
			".mem-kpi span{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75));margin-top:2px}",
			".mem-kpi.mem-warn b{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".mem-bars{display:flex;flex-direction:column;gap:7px}",
			".mem-bar{display:grid;grid-template-columns:112px minmax(40px,1fr) 44px;align-items:center;gap:8px;font-size:11px}",
			".mem-bar .k{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mem-track{display:block;height:7px;border-radius:99px;background:rgba(127,127,150,.14);overflow:hidden}",
			".mem-fill{display:block;height:100%;border-radius:99px;background:rgba(100,140,255,.72)}",
			".mem-bar .n{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace)}",
			".mem-ins{display:flex;flex-direction:column;gap:7px;max-height:300px;overflow:auto;overscroll-behavior:contain}",
			".mem-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.2));border-radius:10px;padding:8px 10px;background:rgba(127,127,150,.035)}",
			".mem-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".mem-key{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid rgba(100,140,255,.4);background:rgba(100,140,255,.12)}",
			".mem-conf{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid rgba(127,127,150,.35);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85))}",
			".mem-conf.low{border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.12);color:inherit}",
			".mem-summary{margin-top:4px;font-size:12px;line-height:1.5;word-break:break-word}",
			".mem-meta{margin-top:4px;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7));font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mem-prov{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid rgba(127,127,150,.3);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85));white-space:nowrap}",
			".mem-prov.private{border-color:rgba(25,145,70,.45);background:rgba(25,145,70,.1)}",
			".mem-recent{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;overscroll-behavior:contain}",
			".mem-row{display:grid;grid-template-columns:92px minmax(80px,1fr) 70px 74px;gap:8px;align-items:center;font-size:11px;padding:3px 2px;border-bottom:1px solid rgba(127,127,150,.08)}",
			".mem-row .k{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mem-st{font-size:10px;letter-spacing:.04em}",
			".mem-st.active{color:#58c46b}",
			".mem-st.resolved{color:var(--dsw-alias-label-secondary,rgba(180,180,195,.6))}",
			".mem-off{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-state-warn-secondary,rgba(255,180,84,.5));background:var(--dsw-alias-state-warn-tertiary,rgba(255,180,84,.14));font-size:12px;margin:8px 0;color:var(--dsw-alias-label-primary,#0f1115)}",
			".mem-flag{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(127,127,150,.08)}",
			".mem-flag:last-child{border-bottom:none}",
			".mem-foot{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7));font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);flex-wrap:wrap;word-break:break-all}",
			".mem-empty{padding:14px 4px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75));font-size:12px}",
			// 记忆面板补充：状态胶囊 / 可访问开关 / 作用域表 / 五列近期记录
			".mem-hd-t{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".mem-state{font-size:10px;line-height:16px;padding:0 7px;border-radius:999px;border:1px solid rgba(127,127,150,.35);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8));white-space:nowrap}",
			".mem-state.on{border-color:rgba(52,199,89,.55);background:rgba(52,199,89,.12);color:#58c46b}",
			".mem-state.pending{border-color:rgba(245,158,11,.55);background:rgba(245,158,11,.12);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".mem-dot-pending{background:var(--dsw-alias-state-warn-primary,#f59e0b);box-shadow:0 0 8px rgba(245,158,11,.6)}",
			".mem-state.off{border-color:rgba(127,127,150,.35);background:rgba(127,127,150,.08)}",
			".mem-flag-t{min-width:0}",
			".mem-flag-state{font-size:11px;min-width:26px;text-align:right;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8))}",
			".mem-dis{opacity:.42;cursor:not-allowed}",
			// 开关容器不能再挂 .ci-on（那会把整块染绿）；用独立的 mem-on 只驱动滑块
			".ci-toggle.mem-on .ci-switch{background:rgba(52,199,89,.22);border-color:rgba(52,199,89,.6)}",
			".ci-toggle.mem-on .ci-switch:before{transform:translateX(15px);opacity:1}",
			".mem-evidence{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid rgba(100,140,255,.35);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85))}",
			".mem-ws{display:flex;flex-direction:column;gap:4px}",
			".mem-ws-row{display:grid;grid-template-columns:minmax(0,1fr) 44px 76px;gap:8px;align-items:center;font-size:11px;padding:2px 0}",
			".mem-ws-row.current{background:rgba(100,140,255,.07);border-radius:6px}",
			".mem-ws-row .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mem-ws-row .n{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace)}",
			".mem-ws-row .t{text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7))}",
			".mem-group-t{margin-top:9px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85))}",
			".mem-cur{font-size:9px;line-height:15px;padding:0 5px;border-radius:999px;border:1px solid rgba(52,199,89,.5);background:rgba(52,199,89,.12);color:#58c46b;margin-left:6px;white-space:nowrap}",
			".mem-origin{font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.68));margin-left:5px;white-space:nowrap}",
			".mem-range{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}",
			".mem-range-btn{font-size:11px;padding:3px 9px}",
			".mem-range-btn.on{border-color:rgba(100,140,255,.65);background:rgba(100,140,255,.16)}",
			".mem-row{grid-template-columns:86px minmax(80px,1fr) 112px 62px 76px}",
			".mem-row .mem-scope{font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mem-row .mem-time{text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7))}",
			".mem-row.mem-head{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.65));border-bottom:1px solid rgba(127,127,150,.18);padding-bottom:4px;margin-bottom:2px}",
			"@media (max-width:720px){.mem-row{grid-template-columns:80px minmax(70px,1fr) 60px 70px}.mem-row .mem-scope,.mem-row.mem-head .mem-scope{display:none}}",
			// 图谱 / 列表 / 设置 三页签
			".mem-tabs{display:flex;align-items:center;gap:4px;margin:10px 0 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.18))}",
			".mem-tab{font-family:inherit;font-size:12px;line-height:24px;padding:1px 11px 3px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;background:transparent;color:inherit;cursor:pointer;opacity:.72}",
			".mem-tab:hover{background:rgba(127,127,150,.1);opacity:1}",
			".mem-tab.on{opacity:1;border-color:var(--dsw-alias-border-l2,rgba(127,127,150,.22));background:rgba(127,127,150,.09);box-shadow:inset 0 -2px 0 rgba(100,140,255,.75)}",
			".mem-tabs-note{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7));padding-bottom:4px;white-space:nowrap}",
			".mem-strip{display:flex;flex-wrap:wrap;gap:4px 18px;padding:8px 11px;margin:10px 0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.2));border-radius:10px;background:rgba(127,127,150,.035);font-size:11px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85))}",
			".mem-strip b{color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums;margin-left:3px}",
			".mem-limit{margin:2px 0 8px;padding:4px 9px;border:1px dashed rgba(127,127,150,.35);border-radius:7px;font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.82));display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			".mem-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}",
			".mem-toolbar .ci-sel{min-width:88px;max-width:150px;width:auto;font-size:11px;padding:2px 4px}",
			".mem-toolbar-label{font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7))}",
			".mem-search{min-width:130px;flex:1 1 130px;max-width:240px}",
			".mem-focus{display:inline-flex;align-items:center;gap:3px;font-size:10px;line-height:18px;padding:0 3px 0 8px;border-radius:999px;border:1px solid rgba(100,140,255,.45);background:rgba(100,140,255,.12);max-width:220px}",
			".mem-focus>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mem-focus-x{border:none;background:transparent;color:inherit;cursor:pointer;font-family:inherit;font-size:13px;line-height:1;padding:0 3px}",
			".mem-settings{max-width:900px;margin:10px auto 0}",
			// 图谱
			".mem-graph-wrap{position:relative;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,150,.2));border-radius:12px;background:radial-gradient(circle at 50% 45%,rgba(100,140,255,.07),transparent 64%),rgba(127,127,150,.025);overflow:hidden}",
			".mem-graph{display:block;width:100%;height:clamp(220px,32vh,430px);touch-action:none;cursor:grab}",
			".mem-graph:active{cursor:grabbing}",
			".mem-graph-tools{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:4px}",
			".mem-graph-tools .ci-btn{padding:1px 7px;min-width:26px;line-height:17px}",
			".mem-graph-wrap .mem-legend{border-top:1px solid rgba(127,127,150,.12);background:rgba(127,127,150,.03)}",
			".mem-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:5px 9px;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8))}",
			".mem-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle;background:rgba(127,127,150,.7)}",
			".mem-dot.ws{border-radius:2px;background:rgba(100,140,255,.9)}",
			".mem-dot.sess{background:rgba(88,196,107,.85)}",
			".mem-dot.fact.constraint{background:#e2a33b}",
			".mem-dot.fact.state{background:#5b9dff}",
			".mem-dot.fact.task{background:#a78bfa}",
			".mem-dot.fact.history{background:#8b95a5}",
			".mem-line{display:inline-block;width:16px;height:0;border-top:2px solid rgba(127,127,150,.4);margin-right:4px;vertical-align:middle}",
			".mem-line.shared{border-top-color:rgba(100,140,255,.7)}",
			".mem-line.origin{border-top-style:dashed;border-top-color:rgba(167,139,250,.75)}",
			".mem-line.private{border-top-color:rgba(88,196,107,.75)}",
			".mem-line.member{border-top-style:dashed;border-top-color:rgba(127,127,150,.5)}",
			".mem-edge{stroke:rgba(127,127,150,.3);stroke-width:1;fill:none;transition:stroke .12s ease,stroke-width .12s ease}",
			".mem-edge.shared{stroke:rgba(100,140,255,.55);stroke-width:1.4}",
			".mem-edge.origin{stroke:rgba(167,139,250,.55);stroke-dasharray:4 3}",
			".mem-edge.private{stroke:rgba(88,196,107,.55)}",
			".mem-edge.member{stroke:rgba(127,127,150,.26);stroke-dasharray:2 3}",
			".mem-edge.on{stroke:rgba(100,140,255,.95);stroke-width:2;stroke-dasharray:none}",
			".mem-node circle,.mem-node rect{stroke:rgba(127,127,150,.5);stroke-width:1;fill:rgba(127,127,150,.18);transition:opacity .12s ease}",
			".mem-node.workspace rect{fill:rgba(100,140,255,.2);stroke:rgba(100,140,255,.8)}",
			".mem-node.session circle{fill:rgba(88,196,107,.18);stroke:rgba(88,196,107,.75)}",
			".mem-node.fact circle{fill:rgba(127,127,150,.28);stroke:rgba(127,127,150,.6)}",
			".mem-node.fact.constraint circle{fill:rgba(226,163,59,.3);stroke:#e2a33b}",
			".mem-node.fact.state circle{fill:rgba(91,157,255,.28);stroke:#5b9dff}",
			".mem-node.fact.task circle{fill:rgba(167,139,250,.28);stroke:#a78bfa}",
			".mem-node.fact.history circle{fill:rgba(139,149,165,.26);stroke:#8b95a5}",
			".mem-node.current circle:not(.mem-ring),.mem-node.current rect{stroke-width:2.2}",
			".mem-node .mem-ring{fill:none;stroke:rgba(100,140,255,.6);stroke-width:1.1;stroke-dasharray:3 3}",
			".mem-node.sel circle,.mem-node.sel rect{stroke-width:2.6}",
			".mem-node.dim{opacity:.22}",
			".mem-node.muted{opacity:.48}",
			".mem-node:focus{outline:none}",
			".mem-focus-ring{fill:none;stroke:#7cc4ff;stroke-width:2;stroke-dasharray:3 3;pointer-events:none}",
			".mem-graph-tools .ci-btn.on{border-color:rgba(100,140,255,.65);background:rgba(100,140,255,.16)}",
			".mem-zen .mem-strip,.mem-zen .mem-graph-wrap .mem-legend{display:none}",
			".mem-zen .mem-graph{height:clamp(300px,50vh,640px)}",
			".mem-node-label{font-size:14px;fill:currentColor;pointer-events:none;user-select:none}",
			// 详情栏与列表卡片
			".mem-detail-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:11px;padding:4px 0;border-bottom:1px solid rgba(127,127,150,.08)}",
			".mem-detail-row:last-of-type{border-bottom:none}",
			".mem-detail-row span{color:var(--dsw-alias-label-secondary,rgba(180,180,195,.75));flex:none}",
			".mem-detail-row b{font-weight:500;text-align:right;word-break:break-all;min-width:0}",
			".mem-detail-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}",
			".mem-detail-sub{margin-top:10px;font-size:10px;letter-spacing:.05em;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.62));text-transform:uppercase}",
			".mem-evs{display:flex;flex-direction:column;gap:2px;margin-top:4px}",
			".mem-ev{border-bottom:1px solid rgba(127,127,150,.08);padding:3px 0}",
			".mem-ev summary{display:flex;align-items:baseline;gap:6px;cursor:pointer;list-style:none;font-size:11px}",
			".mem-ev summary::-webkit-details-marker{display:none}",
			".mem-ev-k{flex:none;font-size:9px;padding:0 5px;border-radius:999px;border:1px solid rgba(127,127,150,.3);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.8))}",
			".mem-ev-c{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,rgba(205,205,220,.9))}",
			".mem-ev-t{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.6))}",
			".mem-ev-meta{font-size:10px;color:var(--dsw-alias-label-secondary,rgba(180,180,195,.7));padding:3px 0 0 2px}",
			".mem-ev-raw{white-space:pre-wrap;word-break:break-all;font-size:10px;max-height:160px;overflow:auto;background:rgba(127,127,150,.08);padding:6px;border-radius:5px;margin:5px 0 0;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace)}",
			".mem-fact-label{font-size:14px;fill:var(--dsw-alias-label-secondary,rgba(214,218,228,.92));pointer-events:none}",
			".mem-fact{cursor:pointer}",
			".mem-fact:hover{border-color:rgba(100,140,255,.4);background:rgba(100,140,255,.055)}",
			".mem-fact.sel{border-color:rgba(100,140,255,.6);background:rgba(100,140,255,.09)}",
			".mem-fact.muted{opacity:.58}",
			".mem-type{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid rgba(127,127,150,.32);color:var(--dsw-alias-label-secondary,rgba(180,180,195,.85))}",
			".mem-type.constraint{border-color:rgba(226,163,59,.5);background:rgba(226,163,59,.1)}",
			".mem-type.state{border-color:rgba(91,157,255,.45)}",
			".mem-type.task{border-color:rgba(167,139,250,.45)}",
			"@media (max-width:720px){.mem-tabs-note{display:none}.mem-graph{height:30vh}.mem-toolbar .ci-sel{flex:1 1 96px;max-width:none}.mem-search{flex:1 1 100%;max-width:none}}",
			"@media (max-width:900px){.mem-node-label{font-size:17px}.mem-fact-label{font-size:15px}.mem-toolbar-label{display:none}}",
			"@media (prefers-color-scheme:light){.mem-edge{stroke:rgba(60,75,110,.5)}.mem-edge.shared{stroke:rgba(40,90,215,.8);stroke-width:1.6}.mem-edge.origin{stroke:rgba(110,70,205,.8)}.mem-edge.private{stroke:rgba(25,145,70,.85)}.mem-edge.member{stroke:rgba(90,100,120,.45)}.mem-node circle,.mem-node rect{fill:rgba(90,105,130,.16);stroke:rgba(60,75,105,.75)}.mem-node.workspace rect{fill:rgba(50,95,215,.14);stroke:rgba(40,90,215,.95)}.mem-node.session circle{fill:rgba(25,145,70,.12);stroke:rgba(25,145,70,.9)}.mem-node.fact.constraint circle{fill:rgba(200,140,30,.25);stroke:#b7791f}.mem-node.fact.state circle{fill:rgba(40,110,220,.2);stroke:#2b6cd4}.mem-node.fact.task circle{fill:rgba(120,85,200,.22);stroke:#6d4bc0}.mem-node.fact.history circle{fill:rgba(100,110,125,.18);stroke:#5d6674}.mem-node .mem-ring{stroke:rgba(40,90,215,.7)}.mem-node-label{fill:#1b1f27}.mem-fact-label{fill:#3a4150}.mem-focus-ring{stroke:#1b64c8}}",
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
		// 触发点中文标签（v1.10.37 起生产触发点只有 turn-end；旧记录里的 turn-stopping 仍照常显示）
		function trigLabel(t) {
			return t === "turn-end" ? "本轮结束触发"
				: t === "turn-stopping" ? "本轮结束触发（旧触发点）"
				: t === "pre-step" ? "下一轮开始前触发（旧触发点）"
				: (t || "触发点未知");
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
			// 为什么需要：turn-end 触发的是**后台**折叠（只排队、不阻塞本轮），浓缩模型要跑几秒~十几秒；
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
				return e("span", { key: s.id, className: "ci-chip" + (sel[s.id] ? " ci-chipon" : ""), role: "checkbox", "aria-checked": !!sel[s.id], tabIndex: 0, onClick: function () { toggleSession(s.id); }, onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleSession(s.id); } }, title: s.id + (s.workspace ? " @ " + s.workspace : "") + "（右键可导出 LOG）",
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
						e("div", { className: "ci-text" + (open ? "" : " ci-clamp"), role: "button", tabIndex: 0, "aria-expanded": !!open, onClick: function () { toggleExpand(id); }, onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleExpand(id); } }, title: open ? "收起" : "展开" },
							"▸ " + b.t));
				}
				// 角色标记（等宽、同尺寸，时间线不因新增「推理」行而重排）：
				//   u=你 / r=推理（EXTREASON 外置推理简报）/ 其余=AI。图标放 role 左边与 AI 行同槽位。
				var isU = b.k === "u", isR = b.k === "r";
				var ico = isR ? "\u25C8 " : "";
				var role = isU ? "你" : (isR ? "推理" : "AI");
				return e("div", { key: id, className: "ci-msg " + (isU ? "ci-u" : isR ? "ci-r" : "ci-a") },
					e("div", { className: "ci-text" + (open ? "" : " ci-clamp"), role: "button", tabIndex: 0, "aria-expanded": !!open, onClick: function () { toggleExpand(id); }, onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleExpand(id); } }, title: open ? "收起" : "展开" },
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
								e("div", { className: "ci-grphd", role: "button", tabIndex: 0, "aria-expanded": !!open, onClick: function () { toggleLgGroup(w); }, onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleLgGroup(w); } } },
									e("span", { className: "ci-caret" }, "▶"),
									e("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, w || "(未分组)"),
									e("span", { className: "ci-sub" }, recN + "/" + list.length)),
								(open ? e("div", { className: "ci-chips" }, list.map(function (s) {
									var rec = lgRec(s.id);
									return e("span", { key: s.id, className: "ci-chip" + (rec ? " ci-chipon" : ""), role: "checkbox", "aria-checked": !!rec, tabIndex: 0, title: s.id + (s.workspace ? " @ " + s.workspace : "") + (rec ? " · 记录中" : " · 已关") + "（右键可导出 LOG）", onClick: function () { lgPost({ sessionId: s.id, on: !rec }); }, onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); lgPost({ sessionId: s.id, on: !rec }); } },
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
					(err ? e("div", { className: "ci-err", role: "alert", "aria-live": "assertive" }, "⚠ " + err) : null),
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
									// 上次折叠的触发点标签：用户靠它判断"本轮结束即折"（turn-end）到底有没有跑过
									(lf && lf.trigger ? e("span", { className: "ci-sub", title: "这次折叠由哪个触发点产生：turn-end = 本轮 AI 输出结束后台折；pre-step = 旧版的下一轮请求前折（已移除）" }, "触发：" + trigLabel(lf.trigger)) : null),
									e("button", { className: "ci-btn", style: { marginLeft: "auto" }, onClick: status }, "刷新")),
								// 在飞 → 醒目显示「上一轮输出压缩中…」；刚结束 → 极简「已完成」；平时什么都不显示
								(finOn ? inflightLine(fin) : (finDoneAt && (Date.now() - finDoneAt) < FIN_DONE_MS ? e("div", { className: "ci-sub", style: { marginBottom: 6, color: "rgba(52,199,89,.9)" } }, "已完成") : null)),
								(lf ? [
									e("div", { key: "m", className: "ci-metrics" },
										e("span", null, "round ", e("b", null, lf.round ?? "?"), " · step ", e("b", null, lf.step ?? "?")),
										e("span", null, "本折 ", e("b", null, (lf.incrementalRawBytes ?? lf.shadowedBytes ?? "?") + " → " + (lf.appendedBytes ?? lf.transcriptBytes ?? "?") + " B"), " (", e("b", null, Math.round((lf.foldRatio ?? lf.shrink ?? 1) * 100) + "%"), ")"),
										e("span", null, "累计 ", e("b", null, lf.cumRatio == null ? "?" : Math.round(lf.cumRatio * 100) + "%")),
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
										e("div", { className: "ci-grphd", role: "button", tabIndex: 0, "aria-expanded": !!open, onClick: function () { toggleGroup(w); }, onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleGroup(w); } } },
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
			// v1.10.39：宿主折叠行已由 CSS 隐藏；这里自绘一行紧凑状态。
			//   · 折叠完成 ⇒ 「本折 98% · 累计 62%」（百分比 <100% 才是省）
			//   · 折叠在飞 ⇒ 琥珀脉冲 +「压缩中」（原样保留）
			//   · 记忆编译在飞 ⇒ 琥珀脉冲 +「记忆编译中」；成功 30s 内 ⇒「记忆 +N」
			//   · 宿主原生 compaction 在飞 ⇒「原生压缩中」（补回被隐藏的宿主信号）
			var lf = (st && st.lastFold) || null;
			var mi = (st && st.memoryInflight) || null;
			var ml = (st && st.memoryLast) || null;
			var ni = (st && st.nativeCompaction) || null;
			var co = (st && st.consolidate) || null;
			var coi = (co && co.inflight) || null;
			var col = (co && co.last) || null;
			var pctOf = function (v) {
				var n = Number(v);
				return Number.isFinite(n) ? Math.round(n * 100) : null;
			};
			var foldPct = pctOf(lf && (lf.foldRatio != null ? lf.foldRatio : lf.shrink));
			var cumPct = pctOf(lf && lf.cumRatio);
			// 只在拿到本会话自己的折叠结果时显示（status 无 per-sid 文件时会回退全局 last-fold ⇒ 别拿别人会话的比值冒充）
			var hasFoldDone = foldPct != null && cumPct != null && (!sid || (st && st.lastFoldPerSession === true));
			var memRecent = !!(ml && ml.ok === true && Number.isFinite(Number(ml.t)) && (Date.now() - Number(ml.t)) < 30000);
			var coRecent = !!(col && col.ok === true && Number.isFinite(Number(col.t)) && (Date.now() - Number(col.t)) < 30000);
			if (!forced && !f && !infer && !ni && !mi && !hasFoldDone && !memRecent && !coi && !coRecent) return null; // 常态：一个节点都不渲染
			var secOf = function (x) {
				var t0 = Number(x && x.startedAt);
				return Number.isFinite(t0) ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : null;
			};
			var chips = [];
			if (f || infer || forced) {
				var sec = secOf(f);
				var title;
				if (f) {
					title = "上一轮输出正在后台压缩（" + trigLabel(f && f.trigger) + (sec != null ? " · 已 " + sec + "s" : "") + "）：浓缩模型返回后写入 last-fold，下一轮请求前并入上下文";
				} else if (infer) {
					title = "有会话正在后台压缩，但会话未知：全机恰好只有 1 个会话在飞（" + shortId(infer.sessionId) + " · " + trigLabel(infer.trigger) + "）。本插槽没拿到当前会话 id，故按全局唯一在飞推断，可能与当前会话无关；多会话同时在飞时本小标不显示";
				} else {
					title = "强制显示（调试）：实际只在折叠/记忆编译有状态时出现。当前采样=" + (st ? "无在飞" : "尚未返回") + "，sid=" + (sid || "(未解析到)") + "，形态 " + ciShapeBrief(props)
						+ "。关闭：localStorage.removeItem('ciFoldChipForce') 后刷新页面";
				}
				chips.push(e("span", { key: "f", className: "ci-foldchip", title: title,
					"data-ci-foldchip": forced ? "force" : (f ? "inflight" : "inferred") },
					e("span", { className: "ci-pulse" }),
					"压缩中" + (f && sec != null ? " " + sec + "s" : "")));
			} else if (hasFoldDone) {
				chips.push(e("span", { key: "f", className: "ci-foldchip ci-foldchip-done", "data-ci-foldchip": "done",
					title: "本折 " + (lf.foldRatio != null ? Number(lf.foldRatio).toFixed(2) : "—")
						+ " · 累计 " + (lf.cumRatio != null ? Number(lf.cumRatio).toFixed(2) : "—")
						+ "（<1 表示省）；本折 = (本次新增转录 − 首折原样保留的 head) ÷ 本次新原料，累计 = 当前转录 ÷ 累计折叠原料" },
					"本折 " + foldPct + "% · 累计 " + cumPct + "%"));
			}
			if (coi) {
				var cosec = secOf(coi);
				var stageText = ({ sweep: "核对文件", gather: "收集事件", llm: "模型考证", repair: "修复输出", apply: "写入结果" }[coi.stage] || "整理中");
				chips.push(e("span", { key: "c", className: "ci-foldchip", "data-ci-foldchip": "consolidate",
					title: "记忆整理（" + (coi.trigger === "manual" ? "手动" : "空闲自动") + "）：" + stageText + (cosec != null ? " · 已 " + cosec + "s" : "") },
					e("span", { className: "ci-pulse" }), "记忆整理中" + (cosec != null ? " " + cosec + "s" : "")));
			} else if (coRecent) {
				var coN = (Number(col.invalidated) || 0) + (Number(col.superseded) || 0) + (Number(col.merged) || 0) + (Number(col.added) || 0);
				chips.push(e("span", { key: "c", className: "ci-foldchip ci-foldchip-done", "data-ci-foldchip": "consolidate-done",
					title: "上次整理：" + (col.invalidated || 0) + " 条失效 · " + (col.superseded || 0) + " 条取代 · "
						+ (col.merged || 0) + " 条合并 · " + (col.added || 0) + " 条新增"
						+ (col.ms != null ? " · " + (col.ms / 1000).toFixed(1) + "s" : "") },
					"记忆已整理" + (coN ? " · " + coN : "")));
			}
			if (ni) {
				var nsec = secOf(ni);
				chips.push(e("span", { key: "n", className: "ci-foldchip", "data-ci-foldchip": "native",
					title: "DSH 原生上下文压缩正在运行" + (nsec != null ? "（已 " + nsec + "s）" : "") + "；插件折叠已让路，避免作废它的总结" },
					e("span", { className: "ci-pulse" }), "原生压缩中"));
			}
			if (mi) {
				var msec = secOf(mi);
				chips.push(e("span", { key: "m", className: "ci-foldchip", "data-ci-foldchip": "memory",
					title: "轻 LLM 正在把本轮新事件编译为记忆" + (msec != null ? "（已 " + msec + "s）" : "") + "；完成后写入 memory.sqlite" },
					e("span", { className: "ci-pulse" }), "记忆编译中"));
			} else if (memRecent) {
				chips.push(e("span", { key: "m", className: "ci-foldchip ci-foldchip-done", "data-ci-foldchip": "memory-done",
					title: "最近一次记忆编译：+" + (ml.insights || 0) + " 条洞察" + (ml.through != null ? "，至 seq " + ml.through : "") + (ml.model ? " · " + ml.model : "") },
					"记忆 +" + (ml.insights || 0)));
			}
			return e("span", { className: "ci-foldchips", role: "status", "aria-live": "polite" }, chips);
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
		// ===== MEMORY「外部记忆」面板 =====
		// 数据面：GET /api/memory/status（只读 SQLite 快照）＋ POST /api/memory/config（三个开关热写 control.json）。
		// 视觉沿用本插件的 DSW token 体系；KPI 用显式 4 列网格（窄屏 2 列），不依赖自动排布。
		function memAgo(ts) {
			var n = Number(ts);
			if (!isFinite(n) || n <= 0) return "—";
			var d = Date.now() - n;
			if (d < 60000) return Math.max(1, Math.round(d / 1000)) + " 秒前";
			if (d < 3600000) return Math.round(d / 60000) + " 分钟前";
			if (d < 86400000) return Math.round(d / 3600000) + " 小时前";
			return new Date(n).toLocaleDateString();
		}
		function memScope(s) {
			var t = String(s || "");
			if (t.indexOf("ws:") === 0) {
				var p = t.slice(3).split("/").filter(Boolean);
				return "工作区 " + (p.length ? p[p.length - 1] : t.slice(3));
			}
			if (t.indexOf("sess:") === 0) return "会话 " + t.slice(5, 13);
			return t || "—";
		}
		function memBytes(n) {
			var v = Number(n) || 0;
			if (v < 1024) return v + " B";
			if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
			return (v / 1048576).toFixed(1) + " MB";
		}
		function memCursor(n) {
			var v = Number(n);
			return Number.isFinite(v) && v >= 0 ? String(v) : "—";
		}
		// ---- 记忆图谱：来源结构（工作区 → 会话 → 洞察） ----
		// 纯函数、确定性布局；命令/文件不画点，只作为节点计数。便于单测与重绘。
		function memHash(s) {
			var h = 2166136261;
			var t = String(s || "");
			for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
			return h >>> 0;
		}
		function memClip(s, n) {
			var t = String(s || "");
			return t.length > n ? (t.slice(0, n) + "…") : t;
		}
		function memNodeLabel(n) {
			if (!n) return "";
			if (n.kind === "workspace") return memClip(n.label || "工作区", 16);
			if (n.kind === "session") return n.title ? ("「" + memClip(n.title, 13) + "」") : ("会话 " + String(n.sid || "").slice(0, 8));
			return n.key || "洞察";
		}
		function memNodeRadius(n) {
			if (n.kind === "workspace") return 17 + Math.min(10, Math.log((Number(n.n) || 1) + 1) * 2);
			if (n.kind === "session") return 9 + Math.min(8, Math.log((Number(n.n) || 1) + 1) * 1.6);
			return 4 + Math.min(4, (Number(n.confidence) || 0.5) * 4);
		}
		// 布局签名的单条缓存：hover/平移/缩放都可能触发重绘，节点集合没变时不应重跑 24 轮 O(n²) 斥力。
		var memLayoutCache = { sig: "", at: null };
		function memoryGraphLayout(nodes, edges, W, H) {
			W = Number(W) || 900; H = Number(H) || 560;
			nodes = (nodes || []).map(function (n) { return n.id ? n : Object.assign({}, n, { id: n.scope }); });
			var sig = W + "x" + H + "|" + nodes.map(function (n) {
				return n.id + ":" + n.kind + ":" + (Number(n.n) || 0) + ":" + (Number(n.confidence) || 0) + ":" + (n.originSid || "") + ":" + (n.workspaceScope || "");
			}).join("|");
			if (memLayoutCache.sig === sig && memLayoutCache.at) {
				var atCached = memLayoutCache.at;
				return {
					nodes: nodes.map(function (n) { var p = atCached.get(n.id); return Object.assign({}, n, { x: p.x, y: p.y }); }),
					edges: edges || [],
				};
			}
			var ws = nodes.filter(function (n) { return n.kind === "workspace"; });
			var sess = nodes.filter(function (n) { return n.kind === "session"; });
			var facts = nodes.filter(function (n) { return n.kind === "fact"; });
			var cx = W / 2, cy = H / 2;
			var pos = new Map();
			var wr = ws.length > 1 ? Math.min(W, H) * 0.30 : 0;
			ws.forEach(function (n, i) {
				var a = ws.length > 1 ? (Math.PI * 2 * i / ws.length) - Math.PI : 0;
				pos.set(n.id, { x: cx + Math.cos(a) * wr, y: cy + Math.sin(a) * wr });
			});
			var sessByWs = new Map();
			sess.forEach(function (n) {
				var k = n.workspaceScope || "";
				if (!sessByWs.has(k)) sessByWs.set(k, []);
				sessByWs.get(k).push(n);
			});
			sessByWs.forEach(function (list, k) {
				var base = pos.get(k) || { x: cx, y: cy };
				var rr = list.length > 1 ? Math.min(210, 86 + list.length * 26) : 128;
				list.forEach(function (n, i) {
					var a = (Math.PI * 2 * i / Math.max(1, list.length)) + (memHash(n.id) % 100) / 500;
					pos.set(n.id, { x: base.x + Math.cos(a) * rr, y: base.y + Math.sin(a) * rr });
				});
			});
			var factsByScope = new Map();
			facts.forEach(function (n) {
				var k = n.scope || "";
				if (!factsByScope.has(k)) factsByScope.set(k, []);
				factsByScope.get(k).push(n);
			});
			factsByScope.forEach(function (list, scope) {
				var base = pos.get(scope) || { x: cx, y: cy };
				var rr = list.length > 1 ? Math.min(210, 72 + list.length * 15) : 74;
				list.forEach(function (n, i) {
					var a = (Math.PI * 2 * i / Math.max(1, list.length)) + (memHash(n.id) % 100) / 700;
					var p = { x: base.x + Math.cos(a) * rr, y: base.y + Math.sin(a) * rr };
					if (String(scope).indexOf("ws:") === 0 && n.originSid) {
						var op = pos.get("sess:" + n.originSid);
						if (op) p = { x: (p.x * 2 + op.x) / 3, y: (p.y * 2 + op.y) / 3 };
					}
					pos.set(n.id, p);
				});
			});
			nodes.forEach(function (n) {
				if (pos.has(n.id)) return;
				var a = (memHash(n.id) % 360) * Math.PI / 180;
				pos.set(n.id, { x: cx + Math.cos(a) * 80, y: cy + Math.sin(a) * 80 });
			});
			var arr = nodes.map(function (n) { var p = pos.get(n.id); return { id: n.id, kind: n.kind, x: p.x, y: p.y }; });
			var minOf = function (a, b) {
				if (a.kind === "workspace" || b.kind === "workspace") return 70;
				if (a.kind === "session" || b.kind === "session") return 34;
				return 14;
			};
			for (var it = 0; it < 24; it++) {
				for (var i = 0; i < arr.length; i++) {
					for (var j = i + 1; j < arr.length; j++) {
						var a = arr[i], b = arr[j];
						var dx = b.x - a.x, dy = b.y - a.y;
						var d = Math.sqrt(dx * dx + dy * dy);
						if (d < 0.5) {
							// 完全重合时方向未定义；用 id 哈希给一个确定性分离方向（纯随机会让每次重绘跳动）。
							var ang = (memHash(a.id + '|' + b.id) % 360) * Math.PI / 180;
							dx = Math.cos(ang) * 0.5; dy = Math.sin(ang) * 0.5; d = 0.5;
						}
						var min = minOf(a, b);
						if (d < min) {
							var push = (min - d) / d * 0.5;
							a.x -= dx * push; a.y -= dy * push;
							b.x += dx * push; b.y += dy * push;
						}
					}
				}
				for (i = 0; i < arr.length; i++) {
					arr[i].x = Math.max(24, Math.min(W - 24, arr[i].x));
					arr[i].y = Math.max(24, Math.min(H - 24, arr[i].y));
				}
			}
			// 初始环半径只保证结构可读；再按包围盒整体缩放，让稀疏图也能撑满画布（留出标签余量）。
			var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			arr.forEach(function (p) {
				if (p.x < minX) minX = p.x;
				if (p.y < minY) minY = p.y;
				if (p.x > maxX) maxX = p.x;
				if (p.y > maxY) maxY = p.y;
			});
			var bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
			// 画布是横向的：x/y 分别缩放，稀疏图也能用满宽度；节点半径与字号不变。
			var sx = Math.min(1.9, (W - 200) / bw);
			var sy = Math.min(1.6, (H - 160) / bh);
			if (Number.isFinite(sx) && Number.isFinite(sy) && (sx > 1 || sy > 1)) {
				sx = Math.max(1, sx); sy = Math.max(1, sy);
				arr.forEach(function (p) { p.x = cx + (p.x - cx) * sx; p.y = cy + (p.y - cy) * sy; });
			}
			var at = new Map(arr.map(function (n) { return [n.id, n]; }));
			memLayoutCache = { sig: sig, at: at };
			return {
				nodes: nodes.map(function (n) { var p = at.get(n.id); return Object.assign({}, n, { x: p.x, y: p.y }); }),
				edges: edges || [],
			};
		}
		// 范围/类型/状态/搜索/聚焦过滤；返回可绘制的子图。
		function visibleMemoryGraph(graph, opts) {
			graph = graph || { nodes: [], edges: [] };
			opts = opts || {};
			var range = opts.range || "all";
			var type = opts.type || "all";
			var status = opts.status || "active";
			var q = String(opts.query || "").trim().toLowerCase();
			var focus = opts.focus || null;
			var curWsScope = opts.curWsScope || null;
			var curSessScope = opts.curSessScope || null;
			var allNodes = (graph.nodes || []).map(function (n) { return n.id ? n : Object.assign({}, n, { id: n.scope }); });
			// 列表分页：更早的事实只进列表，不把图谱撑到上千节点。
			var extraFacts = Array.isArray(opts.extraFacts) ? opts.extraFacts : [];
			var sessMap = new Map();
			allNodes.forEach(function (n) { if (n.kind === "session") sessMap.set(n.scope, n); });
			function inRange(scope) {
				if (range === "all") return true;
				if (range === "workspace") return scope === curWsScope;
				if (range === "session") return scope === curSessScope;
				return scope === curWsScope || scope === curSessScope;
			}
			function factOk(n) {
				if (!n || n.kind !== "fact") return false;
				if (status !== "all" && n.status !== status) return false;
				if (type !== "all" && n.factType !== type) return false;
				if (q && (String(n.summary) + " " + String(n.key)).toLowerCase().indexOf(q) < 0) return false;
				if (!inRange(n.scope)) return false;
				if (focus) {
					if (focus.indexOf("ws:") === 0) {
						if (n.scope === focus) return true;
						if (String(n.scope).indexOf("sess:") === 0) {
							var s = sessMap.get(n.scope);
							return !!(s && s.workspaceScope === focus);
						}
						return false;
					}
					if (focus.indexOf("sess:") === 0) {
						if (n.scope === focus) return true;
						if (String(n.scope).indexOf("ws:") === 0 && ("sess:" + n.originSid) === focus) return true;
						return false;
					}
				}
				return true;
			}
			var graphFacts = allNodes.filter(factOk);
			var facts = graphFacts.slice();
			var factIds = new Set(facts.map(function (f) { return f.id; }));
			extraFacts.forEach(function (f) {
				if (!factOk(f) || factIds.has(f.id)) return;
				factIds.add(f.id);
				facts.push(f);
			});
			var keep = new Set();
			graphFacts.forEach(function (n) {
				keep.add(n.id); keep.add(n.scope);
				if (n.originSid) keep.add("sess:" + n.originSid);
			});
			if (range !== "all") {
				if (curWsScope) keep.add(curWsScope);
				if (curSessScope) keep.add(curSessScope);
			}
			Array.from(keep).forEach(function (id) {
				var s = sessMap.get(id);
				if (s && s.workspaceScope) keep.add(s.workspaceScope);
			});
			var nodes = allNodes.filter(function (n) {
				if (n.kind === "fact") return keep.has(n.id);
				if (range === "all" && !focus) return true;
				return keep.has(n.scope);
			});
			var ids = new Set(nodes.map(function (n) { return n.id; }));
			var edges = (graph.edges || []).filter(function (x) { return ids.has(x.source) && ids.has(x.target); });
			return { nodes: nodes, edges: edges, facts: facts, graphFacts: graphFacts };
		}
		var MEM_ENV = { memoryEnabled: "DSH_MEMORY", memoryLlmEnabled: "DSH_MEMORY_LLM", memoryInjectCatalog: "DSH_MEMORY_INJECT", memoryHandoff: "DSH_MEMORY_HANDOFF", memoryConsolidateAuto: "DSH_MEMORY_CONSOLIDATE" };
		var MEM_LOCK = { memoryEnabled: "enabled", memoryLlmEnabled: "llmEnabled", memoryInjectCatalog: "injectCatalog", memoryHandoff: "handoff", memoryConsolidateAuto: "consolidateAuto" };
		// 注入回执：把“模型这轮到底看到了什么”从 console 搬到面板。全文是不可信数据，不执行。
		function InjectionReceipt(inj) {
			if (!inj) return null;
			if (inj.legacy) return e("div", { className: "ci-sub", style: { marginTop: 6 } }, "注入回执：旧版只记录了“已注入”，无原文");
			return e("div", { className: "ci-sub", style: { marginTop: 6 } },
				"注入回执 " + inj.chars + " 字 · sha " + (inj.sha1 || "-") + (inj.handover ? " · 含交接卡" : ""),
				inj.text ? e("details", null,
					e("summary", { style: { cursor: "pointer" } }, "查看注入原文（不可信背景）"),
					e("pre", { style: { whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto", fontSize: 11, margin: "4px 0 0" } }, inj.text)) : null);
		}
		function MemoryView(props) {
			var _d = useState(null), data = _d[0], setData = _d[1];
			var _e = useState(null), err = _e[0], setErr = _e[1];
			var _b = useState(false), busy = _b[0], setBusy = _b[1];
			var sid = (props && props.sessionId) || "";
			// 记忆范围：current = 当前工作区共享 + 本会话私有；缺省打开具体会话时看当前上下文。
			var _rg = useState(sid ? "current" : "all"), range = _rg[0], setRange = _rg[1];
			var _tab = useState("graph"), tab = _tab[0], setTab = _tab[1];
			var _ty = useState("all"), type = _ty[0], setType = _ty[1];
			var _stt = useState("active"), status = _stt[0], setStatus = _stt[1];
			var _q = useState(""), query = _q[0], setQuery = _q[1];
			var _sel = useState([]), selected = _sel[0], setSelected = _sel[1];
			var _fo = useState(null), focus = _fo[0], setFocus = _fo[1];
			var _vp = useState({ x: 0, y: 0, k: 1 }), viewport = _vp[0], setViewport = _vp[1];
			var _hv = useState(null), hover = _hv[0], setHover = _hv[1];
			// 编译模型覆盖（control.memoryLlmProvider/Model）：空 = 跟随会话当前模型。
			var _mp = useState(""), memP = _mp[0], setMemP = _mp[1];
			var _mm = useState(""), memM = _mm[0], setMemM = _mm[1];
			var _mps = useState([]), memProviders = _mps[0], setMemProviders = _mps[1];
			var _mms = useState([]), memModels = _mms[0], setMemModels = _mms[1];
			var _mde = useState(null), memMdlErr = _mde[0], setMemMdlErr = _mde[1];
			// 证据钻取：选中事实后懒加载证据链；切换选择时清空，避免旧证据短暂挂在新事实上。
			var _evd = useState(null), evData = _evd[0], setEvData = _evd[1];
			var _evx = useState(null), evErr = _evx[0], setEvErr = _evx[1];
			// 画布比例跟随容器：固定 900x560 在 600x220 的槽里会按高度缩到 0.39，标签实际只有 5–6px。
			var _gb = useState({ w: 900, h: 560 }), graphBox = _gb[0], setGraphBox = _gb[1];
			// roving tabindex：整个图谱只占一个 Tab 位，方向键在节点间移动。
			var _kb = useState(null), kbId = _kb[0], setKbId = _kb[1];
			var _zn = useState(false), zen = _zn[0], setZen = _zn[1];
			// 时间窗（天）：0=全部；只影响事实/最近记录，不改全库计数。
			var _sd = useState(0), sinceDays = _sd[0], setSinceDays = _sd[1];
			// 列表分页：更早的事实只在列表追加；查询签名变化时清空，避免跨范围串页。
			var _old = useState({ sig: "", facts: [], cursor: null, hasMore: false, pages: 0, loading: false, err: null }), older = _old[0], setOlder = _old[1];
			// 图谱独立端点：graph tab 激活时按需拉取，避免 5s 轮询 /api/memory/status 携带 64.9% 的图谱负载。
			var _gd = useState(null), graphData = _gd[0], setGraphData = _gd[1];
			// 框选：在图谱空白处拖拽画矩形，松开时选中矩形内所有节点。
			var _bs = useState(null), boxSelect = _bs[0], setBoxSelect = _bs[1];
			var boxRef = useRef(null);
			var listSig = [sid, range, focus || "", sinceDays].join("|");
			var wrapRef = useRef(null);
			var memPicked = useRef(false); // 用户手动改过后，轮询不再覆盖选择
			var dragRef = useRef(null);
			var svgRef = useRef(null);
			var viewRef = useRef(viewport);
			viewRef.current = viewport;
			function loadMemModels(p) {
				if (!p) { setMemModels([]); return Promise.resolve(); }
				return fetch("/api/context-inject/models", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ provider: p }),
				}).then(function (r) { return r.json(); }).then(function (j) {
					if (j && j.ok === false) { setMemMdlErr((j && j.error) || "模型目录请求失败"); return; }
					setMemMdlErr(null);
					setMemModels((j && j.models) || []);
				}).catch(function (x) { setMemMdlErr("模型目录不可用：" + String((x && x.message) || x)); });
			}
			useEffect(function () {
				fetch("/api/context-inject/models", { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (j) { if (j && j.ok !== false) setMemProviders(j.providers || []); })
					.catch(function (x) { setMemMdlErr("模型目录不可用：" + String((x && x.message) || x)); });
			}, []);
			function saveMemRoute(p, m) {
				if (busy) return Promise.resolve();
				setBusy(true);
				return fetch("/api/memory/config", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ memoryLlmProvider: p || null, memoryLlmModel: m || null }),
				}).then(function (r) { return r.json(); }).then(function (s) {
					if (!s || !s.ok) setErr(new Error((s && s.error) || "config failed"));
					else setErr(null);
					return pull();
				}).catch(function (x) { setErr(x); }).finally(function () { setBusy(false); });
			}
			function onMemProviderChange(ev) {
				var p = (ev && ev.target && ev.target.value) || "";
				memPicked.current = true;
				setMemP(p);
				setMemM("");
				if (!p) saveMemRoute("", "");
			}
			function onMemModelChange(ev) {
				var m = (ev && ev.target && ev.target.value) || "";
				memPicked.current = true;
				setMemM(m);
				if (m) saveMemRoute(memP, m);
			}
			function memoryQuery(useRange, opts) {
				var o = opts || {};
				var q = [];
				if (sid) q.push("sessionId=" + encodeURIComponent(sid));
				q.push("range=" + encodeURIComponent(useRange || range));
				// 聚焦某个工作区/会话时向服务端下钻并放宽上限；未聚焦仍保持 200 条默认值。
				var focusReq = focus && /^(ws|sess):/.test(focus) ? focus : "";
				q.push("factLimit=" + (o.factLimit || (focusReq ? 500 : 200)));
				if (focusReq) q.push("focusScope=" + encodeURIComponent(focusReq));
				var days = Number(sinceDays) || 0;
				if (days > 0) {
					var cut = new Date();
					cut.setHours(0, 0, 0, 0);
					q.push("sinceTs=" + (cut.getTime() - (days - 1) * 86400000));
				}
				if (o.cursor) q.push("cursor=" + encodeURIComponent(o.cursor));
				return q.join("&");
			}
			function pull(nextRange) {
				var useRange = nextRange || range;
				return fetch("/api/memory/status?" + memoryQuery(useRange), { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (s) {
						setData(s); setErr(null);
						// 服务端可能因会话没有工作区/记录而回退到 all；跟随它，否则当前范围会渲染成空图。
						if (s && s.rangeEffective && s.rangeEffective !== useRange) setRange(s.rangeEffective);
						return s;
					})
					.catch(function (x) { setErr(x); return null; });
			}
			function loadOlder() {
				var gs = (data && data.graph && data.graph.stats) || {};
				if (!gs.focusScope || older.loading) return;
				var baseFacts = older.sig === listSig ? older.facts : [];
				var cursor = older.sig === listSig && older.cursor ? older.cursor : gs.nextCursor;
				if (!cursor) return;
				setOlder({ sig: listSig, facts: baseFacts, cursor: cursor, hasMore: !!gs.hasMore, pages: older.sig === listSig ? older.pages : 0, loading: true, err: null });
				fetch("/api/memory/status?" + memoryQuery(range, { cursor: cursor, factLimit: 500 }), { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (!j || j.ok === false) throw new Error((j && (j.error || j.message)) || "加载失败");
						var st = (j.graph && j.graph.stats) || {};
						var add = ((j.graph && j.graph.nodes) || []).filter(function (n) { return n.kind === "fact"; });
						var seen = new Set(baseFacts.map(function (f) { return f.id; }));
						var merged = baseFacts.slice();
						add.forEach(function (f) { if (!seen.has(f.id)) { seen.add(f.id); merged.push(f); } });
						setOlder({ sig: listSig, facts: merged, cursor: st.nextCursor || null, hasMore: !!st.hasMore, pages: (older.sig === listSig ? older.pages : 0) + 1, loading: false, err: null });
					})
					.catch(function (x) {
						setOlder({ sig: listSig, facts: baseFacts, cursor: cursor, hasMore: !!gs.hasMore, pages: older.sig === listSig ? older.pages : 0, loading: false, err: x });
					});
			}
			function pullGraph() {
				if (tab !== "graph") return;
				var focusReq = focus && /^(ws|sess):/.test(focus) ? focus : "";
				var q = [];
				if (sid) q.push("sessionId=" + encodeURIComponent(sid));
				q.push("range=" + encodeURIComponent(range));
				q.push("factLimit=" + (focusReq ? 500 : 200));
				if (focusReq) q.push("focusScope=" + encodeURIComponent(focusReq));
				var days = Number(sinceDays) || 0;
				if (days > 0) {
					var cut = new Date();
					cut.setHours(0, 0, 0, 0);
					q.push("sinceTs=" + (cut.getTime() - (days - 1) * 86400000));
				}
				fetch("/api/memory/graph?" + q.join("&"), { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (j && j.ok !== false && j.graph) setGraphData(j.graph);
					})
					.catch(function () { /* graph fetch failure is non-fatal */ });
			}
			useEffect(function () {
				setOlder({ sig: listSig, facts: [], cursor: null, hasMore: false, pages: 0, loading: false, err: null });
			}, [listSig]);
			useEffect(function () {
				// 页面不可见时停轮询；切回来立即补一帧（5s 固定间隔在后台纯属浪费）
				function tick() { if (typeof document !== "undefined" && document.hidden) return; pull(); }
				function onVis() { if (!document.hidden) pull(); }
				var iv = setInterval(tick, 5000);
				pull();
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
				return function () {
					clearInterval(iv);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
				};
			}, [sid, range, focus, sinceDays]);
			useEffect(function () { setRange(sid ? "current" : "all"); setFocus(null); setSelected([]); }, [sid]);
			// 图谱 tab 激活时按需拉取独立端点；参数变化时重新拉取。
			useEffect(function () {
				if (tab === "graph") pullGraph();
			}, [tab, sid, range, focus, sinceDays]);
			// 图谱滚轮缩放：passive:false，避免 React 合成 wheel 不能 preventDefault。
			// 用 ref 取当前视口：平移后 k 不变，闭包里的旧 x/y 会让缩放把画面拽回旧位置。
			// 依赖 graphReady：首帧数据未到时不渲染 svg，只挂 [tab] 会让监听永远缺失。
			var hasGraph = !!graphData;
			useEffect(function () {
				var el = svgRef.current;
				if (!el || !el.addEventListener) return;
				function onWheel(ev) {
					ev.preventDefault();
					var vp = viewRef.current;
					var nk = Math.max(0.55, Math.min(2.4, vp.k * (ev.deltaY < 0 ? 1.12 : 0.9)));
					if (nk === vp.k) return;
					var nx = vp.x, ny = vp.y;
					try {
						var ctm = el.getScreenCTM && el.getScreenCTM();
						if (ctm && el.createSVGPoint) {
							var pt = el.createSVGPoint();
							pt.x = ev.clientX; pt.y = ev.clientY;
							var p = pt.matrixTransform(ctm.inverse());
							nx = p.x - (p.x - vp.x) * (nk / vp.k);
							ny = p.y - (p.y - vp.y) * (nk / vp.k);
						}
					} catch { /* keep center zoom */ }
					setViewport({ x: nx, y: ny, k: nk });
				}
				el.addEventListener("wheel", onWheel, { passive: false });
				return function () { el.removeEventListener("wheel", onWheel); };
			}, [tab, hasGraph]);
			// 按实际容器比例调整 viewBox（宽度固定 900，高度按容器高宽比换算）。
			// 不这么做时，宽扁容器会按高度缩放，14px 标签只剩约 5.5px。
			useEffect(function () {
				var el = wrapRef.current;
				if (!el || !el.getBoundingClientRect) return;
				function fit() {
					var r = el.getBoundingClientRect();
					if (!(r.width > 0) || !(r.height > 0)) return;
					var H = Math.max(280, Math.min(620, Math.round(900 * r.height / r.width)));
					setGraphBox(function (prev) { return (prev.w === 900 && Math.abs(prev.h - H) < 8) ? prev : { w: 900, h: H }; });
				}
				fit();
				var ro = null;
				if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(fit); ro.observe(el); }
				return function () { if (ro) ro.disconnect(); };
			}, [tab, hasGraph]);
			// 证据链懒加载：只在选中事实时请求，不把证据塞进 5s 轮询的状态响应。
			// 列表分页载入的旧事实不在首屏图谱里，也要能回查证据。
			useEffect(function () {
				if (!selected.length) { setEvData(null); setEvErr(null); return; }
				if (selected.length > 1) { setEvData(null); setEvErr(null); return; }
				var pool = ((graphData && graphData.nodes) || []).concat(older.facts || []);
				var node = pool.filter(function (x) { return x.id === selected[0]; })[0];
				if (!node || node.kind !== "fact") { setEvData(null); setEvErr(null); return; }
				var alive = true;
				setEvData(null); setEvErr(null);
				fetch("/api/memory/evidence?scope=" + encodeURIComponent(node.scope) + "&key=" + encodeURIComponent(node.key), { headers: { "Content-Type": "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (!alive) return;
						if (j && j.ok) setEvData(j);
						else setEvErr(new Error((j && j.error) || "evidence-failed"));
					})
					.catch(function (x) { if (alive) setEvErr(x); });
				return function () { alive = false; };
			}, [selected, older.facts]);
			// 首次拿到快照 / 服务端路由变化时同步选择器；用户手动改过后不再覆盖。
			var memRouteP = data && data.llmRoute ? (data.llmRoute.provider || "") : "";
			var memRouteM = data && data.llmRoute ? (data.llmRoute.model || "") : "";
			useEffect(function () {
				if (memPicked.current) return;
				setMemP(memRouteP);
				setMemM(memRouteM);
			}, [memRouteP, memRouteM]);
			useEffect(function () { loadMemModels(memP); }, [memP]);
			function applyFlag(key, value) {
				if (busy) return;
				setBusy(true);
				var body = {}; body[key] = value;
				fetch("/api/memory/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
					.then(function (r) { return r.json(); })
					.then(function (s) {
						if (!s || !s.ok) setErr(new Error((s && s.error) || "config failed"));
						else setErr(null);
					})
					.catch(function (x) { setErr(x); })
					.then(function () { setBusy(false); pull(); });
			}
			if (!data) {
				return e("div", { className: "ci-root" },
					e("div", { className: "ci-hd" },
						e("span", { className: "ci-badge ci-off" }),
						e("div", null,
							e("div", { className: "ci-title" }, "外部记忆"),
							e("div", { className: "ci-sub" }, err ? ("读取失败：" + String(err.message || err)) : "读取中…")),
						e("button", { className: "ci-btn", style: { marginLeft: "auto" }, onClick: function () { pull(range); } }, "重试")));
			}
			var f = data.flags || {};
			var t = data.totals || {};
			var db = data.db || {};
			var co = data.consolidate || {};
			var coi = co.inflight || null;
			var col = co.last || null;
			var coManual = co.manualRoute || null;
			var coManText = (coManual && coManual.provider)
				? ("手动模型：" + coManual.provider + " / " + (coManual.model || "—"))
				: "手动模型：跟随编译/会话模型";
			var conext = co.next || null;
			var coIdleMin = Math.max(1, Math.round((Number(co.idleMs) || 900000) / 60000));
			var coReady = !!(f.enabled && f.llmEnabled);
			var coStage = coi ? ({ sweep: "核对文件", gather: "收集事件", llm: "模型考证", repair: "修复输出", apply: "写入结果" }[coi.stage] || "整理中") : "";
			var coSec = coi && Number(coi.startedAt) ? Math.max(0, Math.round((Date.now() - Number(coi.startedAt)) / 1000)) : null;
			var coNextAt = conext && Number(conext.nextAt) ? Number(conext.nextAt) : null;
			var coReasonText = {
				"no-route": "没有可用的模型路由（请在「编译模型」里指定）",
				"disabled": "记忆层或轻 LLM 编译未开启",
				"no-workspace": "找不到该会话的工作区",
				"llm-failed": "模型调用失败",
				"parse-failed": "模型输出未通过校验",
				"busy": "已有整理在运行",
				"error": "整理过程异常",
			};
			var coCountdown = !sid ? "打开具体会话后可手动整理"
				: (co.auto === false ? "自动整理已关闭（仍可手动）"
					: (!coNextAt ? "空闲时自动整理" : (coNextAt <= Date.now() ? "即将整理" : "约 " + Math.max(1, Math.round((coNextAt - Date.now()) / 60000)) + " 分钟后")));
			var coParts = [];
			if (col && col.ok) {
				if (col.invalidated) coParts.push(col.invalidated + " 条失效");
				if (col.superseded) coParts.push(col.superseded + " 条取代");
				if (col.merged) coParts.push(col.merged + " 条合并");
				if (col.added) coParts.push(col.added + " 条新增");
				if (col.skipped) coParts.push(col.skipped + " 条未通过校验");
				if (col.protected) coParts.push(col.protected + " 条约束受保护");
				if (!coParts.length) coParts.push("没有需要变更的事实");
			}
			var coLastText = col ? (col.ok
				? ("上次整理：" + coParts.join(" · ") + (col.ms != null ? " · " + (col.ms / 1000).toFixed(1) + "s" : "") + (col.model ? " · " + col.model : ""))
				: ("上次整理失败：" + (coReasonText[col.reason] || col.reason || "未知"))) : null;
			function consolidateNow() {
				if (busy || coi || !sid) return;
				setBusy(true);
				fetch("/api/memory/consolidate", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: sid }),
				}).then(function (r) { return r.json(); }).then(function (j) {
					if (!j || !j.ok) setErr(new Error((j && j.error) || "consolidate failed"));
					else setErr(null);
				}).catch(function (x) { setErr(x); }).then(function () {
					setBusy(false);
					setTimeout(function () { pull(); }, 800);
					setTimeout(function () { pull(); }, 3500);
				});
			}
			var lock = data.envLocked || {};
			var lockN = ["enabled", "llmEnabled", "injectCatalog"].filter(function (k) { return lock[k] === true; }).length;
			var armed = data.armed === true;
			// 三种真实状态：运行中（本进程已武装）/ 待重启（配置已开但启动时未加载）/ 未启用（已热停写或配置关闭）
			var st = !f.enabled ? "off" : (armed ? "on" : "pending");
			var stText = st === "on" ? "运行中" : st === "pending" ? "待重启" : "未启用";
			var banner = !armed && !f.enabled
				? "记忆层未启用：不写入、不注册工具、不注入目录。启用后需重启 dsh web。"
				: (!armed && f.enabled
					? "配置已启用，但当前进程启动时未加载记忆插件：重启 dsh web 后生效。"
					: (!f.enabled ? "已停止写入：不新增记录、不编译、不注入；memory_* 仍可读取既有记忆。重新开启即时恢复。" : null));
			var maxKind = 1;
			(data.kinds || []).forEach(function (k) { if (k.n > maxKind) maxKind = k.n; });
			function kpi(label, value, warn, title) {
				return e("div", { className: "mem-kpi" + (warn ? " mem-warn" : ""), title: title || null },
					e("b", null, value), e("span", null, label));
			}
			function flagRow(key, label, hint, on) {
				var locked = lock[MEM_LOCK[key]] === true;
				var dis = busy || locked;
				return e("div", { key: key, className: "mem-flag" },
					e("div", { className: "mem-flag-t" },
						e("div", { className: "ci-title", style: { fontSize: 12 } }, label),
						e("div", { className: "ci-sub" }, hint + (locked ? " · 由 " + MEM_ENV[key] + " 锁定" : ""))),
					e("div", {
						className: "ci-toggle" + (on ? " mem-on" : "") + (dis ? " mem-dis" : ""),
						role: "switch",
						"aria-checked": on === true,
						"aria-label": label,
						"aria-disabled": dis,
						tabIndex: dis ? -1 : 0,
						title: locked ? ("环境变量 " + MEM_ENV[key] + " 覆盖此开关，面板写入无效")
							: (busy ? "正在保存…" : "点击切换（运行时生效）"),
						onClick: function () { if (!dis) applyFlag(key, !on); },
						onKeyDown: function (ev) {
							if (dis) return;
							if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
								ev.preventDefault();
								applyFlag(key, !on);
							}
						},
					},
						e("span", { className: "ci-switch" }),
						e("span", { className: "mem-flag-state" }, locked ? "锁定" : (on ? "开" : "关"))));
			}
			// ---- 当前上下文与图谱视图 ----
			var cur = data.current || null;
			var curWs = (cur && cur.workspace) || null;
			var curSess = (cur && cur.session) || null;
			var curWsScope = curWs ? curWs.scope : null;
			var curSessScope = curSess ? curSess.scope : null;
			var graph = graphData || { nodes: [], edges: [], stats: {} };
			var olderFacts = older.sig === listSig ? older.facts : [];
			var visible = visibleMemoryGraph(graph, {
				range: range, type: type, status: status, query: query, focus: focus,
				curWsScope: curWsScope, curSessScope: curSessScope,
				extraFacts: tab === "list" ? olderFacts : [],
			});
			var factsVisible = visible.facts || [];
			var graphFactsVisible = visible.graphFacts || factsVisible;
			var selectedNode = null, focusNode = null;
			(graph.nodes || []).forEach(function (n) {
				if (selected.length === 1 && n.id === selected[0]) selectedNode = n;
				if (focus && n.scope === focus) focusNode = n;
			});
			if (!selectedNode && selected.length === 1) {
				selectedNode = olderFacts.filter(function (n) { return n.id === selected[0]; })[0] || null;
			}
			var factTypeText = { state: "状态", constraint: "约束", task: "任务", history: "历史" };
			function rangeSelect() {
				var opts = sid
					? [["current", "当前上下文"], ["workspace", "本工作区"], ["session", "本会话私有"], ["all", "全部"]]
					: [["all", "全部"]];
				return e("select", {
					className: "ci-sel", value: sid ? range : "all",
					"aria-label": "范围选择",
					title: "默认跟随当前选中的会话页；展开可看其他工作区",
					onChange: function (ev) {
						setFocus(null); setSelected([]);
						setRange((ev && ev.target && ev.target.value) || (sid ? "current" : "all"));
					},
				}, opts.map(function (o) { return e("option", { key: o[0], value: o[0] }, o[1]); }));
			}
			function typeSelect() {
				var opts = [["all", "全部类型"], ["constraint", "约束"], ["state", "状态"], ["task", "任务"], ["history", "历史"]];
				return e("select", { className: "ci-sel", value: type, "aria-label": "类型过滤", title: "按事实类型过滤",
					onChange: function (ev) { setType((ev && ev.target && ev.target.value) || "all"); } },
					opts.map(function (o) { return e("option", { key: o[0], value: o[0] }, o[1]); }));
			}
			function statusSelect() {
				var opts = [["active", "有效"], ["all", "全部状态"], ["stale", "已失效"], ["superseded", "被取代"]];
				return e("select", { className: "ci-sel", value: status, "aria-label": "状态过滤", title: "按生命周期状态过滤",
					onChange: function (ev) { setStatus((ev && ev.target && ev.target.value) || "active"); } },
					opts.map(function (o) { return e("option", { key: o[0], value: o[0] }, o[1]); }));
			}
			function timeSelect() {
				var opts = [["0", "全部时间"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["90", "最近 90 天"]];
				return e("select", { className: "ci-sel", value: String(sinceDays || 0), "aria-label": "时间范围", title: "按事实更新时间过滤（只影响事实与最近记录，不改全库计数）",
					onChange: function (ev) { setSelected([]); setSinceDays(Number((ev && ev.target && ev.target.value) || 0) || 0); } },
					opts.map(function (o) { return e("option", { key: o[0], value: o[0] }, o[1]); }));
			}
			function focusChip() {
				if (!focus) return null;
				return e("span", { className: "mem-focus" },
					e("span", null, "聚焦 " + (focusNode ? memNodeLabel(focusNode) : memScope(focus))),
					e("button", { className: "mem-focus-x", "aria-label": "清除聚焦", title: "清除聚焦", onClick: function () { setFocus(null); } }, "×"));
			}
			function expandButton() {
				if (range !== "all") {
					return e("button", { className: "ci-btn", title: "显示其他工作区与会话",
						onClick: function () { setRange("all"); setFocus(null); } }, "展开全部");
				}
				if (sid) {
					return e("button", { className: "ci-btn", title: "回到当前会话上下文",
						onClick: function () { setRange("current"); setFocus(null); setSelected([]); } }, "回到当前");
				}
				return null;
			}
			function selectNode(n, ev) {
				if (!n) return;
				var ctrlKey = ev && (ev.ctrlKey || ev.metaKey);
				var shiftKey = ev && ev.shiftKey;
				if (ctrlKey) {
					// Toggle in multi-select
					var idx = selected.indexOf(n.id);
					if (idx >= 0) {
						setSelected(selected.filter(function (id) { return id !== n.id; }));
					} else {
						setSelected(selected.concat([n.id]));
					}
				} else if (shiftKey && selected.length > 0) {
					// Range select: add all nodes between last selected and current
					// For now, just add to selection (proper range requires layout order)
					if (selected.indexOf(n.id) < 0) {
						setSelected(selected.concat([n.id]));
					}
				} else {
					// Single select
					setSelected([n.id]);
				}
			}
			function openNodeInList(n) {
				if (!n) return;
				setTab("list");
				setSelected(n.id);
				var inCur = n.scope === curWsScope || n.scope === curSessScope;
				if (n.kind === "fact") {
					// 可见节点已满足当前过滤；只有从详情栏打开一个被过滤掉的事实时才放宽筛选。
					var seen = (visible.facts || []).some(function (f) { return f.id === n.id; });
					if (!seen) { setType("all"); setStatus("all"); setQuery(""); }
					if (!inCur) setRange("all");
					setFocus(null);
					return;
				}
				if (n.kind === "session" || n.kind === "workspace") {
					if (!inCur) setRange("all");
					setFocus(n.scope);
				}
			}
			function tabButton(id, label) {
				return e("button", { key: id, className: "mem-tab" + (tab === id ? " on" : ""), role: "tab", "aria-selected": tab === id, onClick: function () { setTab(id); } }, label);
			}
			function overviewStrip() {
				return e("div", { className: "mem-strip" },
					e("span", null, "全库活跃记录 ", e("b", null, t.active || 0)),
					e("span", null, "当前上下文记录 ", e("b", null, cur ? cur.records : 0), " 条"),
					e("span", null, "当前有效洞察 ", e("b", null, cur ? cur.insights : 0)),
					e("span", null, "本会话私有记录 ", e("b", null, curSess ? curSess.records : 0)),
					e("span", null, "待处理错误 ", e("b", null, t.errors || 0)));
			}
			function memoryToolbar() {
				return e("div", { className: "mem-toolbar" },
					e("span", { className: "mem-toolbar-label" }, "范围"), rangeSelect(),
					e("span", { className: "mem-toolbar-label" }, "时间"), timeSelect(),
					e("span", { className: "mem-toolbar-label" }, "类型"), typeSelect(),
					e("span", { className: "mem-toolbar-label" }, "状态"), statusSelect(),
					e("input", { className: "ci-sel mem-search", type: "search", placeholder: "搜索摘要/键…", value: query,
						onChange: function (ev) { setQuery((ev && ev.target && ev.target.value) || ""); } }),
					focusChip(),
					e("span", { style: { flex: 1 } }),
					e("span", { className: "ci-sub" }, (tab === "list" ? factsVisible : graphFactsVisible).length + " 条洞察"),
					expandButton());
			}
			function factCard(f) {
				var cls = "mem-card mem-fact" + (f.status !== "active" ? " muted" : "") + (selected.indexOf(f.id) >= 0 ? " sel" : "");
				return e("div", { key: f.id, className: cls,
					onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); selectNode(f, ev); },
					onDoubleClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); openNodeInList(f); } },
					e("div", { className: "mem-card-h" },
						e("span", { className: "mem-key" }, f.key),
						e("span", { className: "mem-type " + (f.factType || "") }, factTypeText[f.factType] || f.factType || "?"),
						e("span", { className: "mem-prov" + (String(f.scope || "").indexOf("sess:") === 0 ? " private" : "") },
							String(f.scope || "").indexOf("sess:") === 0 ? "本会话私有" : "工作区共享"),
						e("span", { className: "mem-conf" + ((f.confidence || 0) < 0.6 ? " low" : "") }, "置信 " + Math.round((f.confidence || 0) * 100) + "%"),
						f.status !== "active" ? e("span", { className: "mem-st " + f.status }, f.status) : null),
					e("div", { className: "mem-summary" }, f.summary || "(无摘要)"),
					e("div", { className: "mem-meta", title: f.scope },
						(String(f.scope || "").indexOf("ws:") === 0 && f.originTitle ? ("来自「" + f.originTitle + "」 · ") : "")
						+ memAgo(f.updated_ts)));
			}
			function limitNotice(withPaging) {
				var gs = (withPaging ? (data && data.graph && data.graph.stats) : (graphData && graphData.stats)) || {};
				var same = older.sig === listSig;
				var extra = withPaging && same ? (older.facts || []).length : 0;
				var err = same ? older.err : null;
				if (!gs.truncated && extra === 0 && !err) return null;
				var shown = (Number(gs.facts) || 0) + extra;
				var total = Math.max(Number(gs.factTotal) || 0, shown);
				var win = Number(gs.sinceTs) > 0 ? "（当前时间窗内）" : "";
				// 分页状态以“已翻过页”的游标为准；否则沿用首页游标，避免翻到底后按钮重新出现。
				var paged = same && older.pages > 0;
				var cursor = paged ? older.cursor : gs.nextCursor;
				var more = paged ? older.hasMore : !!gs.hasMore;
				var showBtn = !!(withPaging && gs.focusScope && (older.loading || (more && cursor)));
				var msg = !gs.focusScope ? "点工作区或会话钻取可看全。"
					: (more ? (withPaging ? "可继续加载更早的事实。" : "切到列表可加载更早的事实。") : "已到最早一条。");
				return e("div", { className: "mem-limit", role: "status" },
					e("span", null, "已载入 " + shown + " / 共 " + total + " 条事实" + win
						+ (paged ? "（含更早 " + extra + " 条）" : "（单次上限 " + (gs.factLimit || 200) + "）")
						+ "；" + msg),
					showBtn ? e("button", {
						className: "ci-btn", disabled: !!older.loading,
						onClick: loadOlder,
					}, older.loading ? "加载中…" : "加载更早") : null,
					err ? e("span", { className: "ci-err" }, "加载失败：" + String((err && err.message) || err)) : null);
			}
			function graphBody() {
				if (err) {
					return e("div", { className: "ci-sec" },
						e("div", { className: "ci-err", role: "alert" }, "图谱加载失败：" + String(err.message || err)),
						e("button", { className: "ci-btn", onClick: function () { pull(); } }, "重试"));
				}
				if (!visible.nodes.length) {
					return e("div", {},
						limitNotice(),
						e("div", { className: "ci-sec" },
							e("div", { className: "mem-empty" }, "当前范围没有可画的节点。"),
							range !== "all" ? e("button", { className: "ci-btn", onClick: function () { setRange("all"); setFocus(null); } }, "展开全部") : null));
				}
				var lay = memoryGraphLayout(visible.nodes, visible.edges, graphBox.w, graphBox.h);
				var at = new Map(lay.nodes.map(function (n) { return [n.id, n]; }));
				// 节点标签的计数按当前可见事实算：状态/类型/搜索过滤后不应继续显示全量数字。
				var visFacts = new Map();
				(visible.graphFacts || factsVisible || []).forEach(function (f) { visFacts.set(f.scope, (visFacts.get(f.scope) || 0) + 1); });
				var activeId = selected.length === 1 ? selected[0] : hover;
			var activeSet = selected.length > 0 ? new Set(selected) : null;
				// 【v1.10.54 · 路径传播高亮】从选中节点沿边做 BFS，找出所有可达节点用于路径高亮。
				// 这样选中一个事实时，其来源会话与所属工作区都会被高亮，形成完整的来源链路。
				var pathSet = null;
				if (activeSet) {
					pathSet = new Set(activeSet);
					var queue = Array.from(activeSet);
					while (queue.length > 0) {
						var cur = queue.shift();
						visible.edges.forEach(function (ed) {
							var neighbor = ed.source === cur ? ed.target : (ed.target === cur ? ed.source : null);
							if (neighbor && !pathSet.has(neighbor)) {
								pathSet.add(neighbor);
								queue.push(neighbor);
							}
						});
					}
				}
				// roving focus：只看当前获得焦点的节点，按方向找“主轴最近、副轴最小”的邻居。
				function nodeAria(n) {
					if (n.kind === "workspace") return "工作区 " + (n.label || "") + "，" + (n.n || 0) + " 条记录";
					if (n.kind === "session") return "会话 " + (n.title || n.sid || "") + "，" + (n.n || 0) + " 条记录";
					return (n.summary || n.key) + "，" + (factTypeText[n.factType] || n.factType || "事实")
						+ "，" + (n.status || "") + "，置信 " + Math.round((Number(n.confidence) || 0) * 100) + "%";
				}
				function moveFocus(dx, dy) {
					if (typeof document === "undefined") return;
					var cur = document.activeElement && document.activeElement.getAttribute
						? document.activeElement.getAttribute("data-node") : null;
					var from = cur ? at.get(cur) : null;
					var best = null, bestScore = Infinity;
					lay.nodes.forEach(function (n) {
						if (!from) return;
						var ddx = n.x - from.x, ddy = n.y - from.y;
						var primary = ddx * dx + ddy * dy;
						if (primary <= 2) return;
						var score = primary + Math.abs(ddx * dy - ddy * dx) * 2.2;
						if (score < bestScore) { bestScore = score; best = n; }
					});
					if (!from) best = lay.nodes[0];
					if (!best) return;
					setKbId(best.id);
					var gs = svgRef.current && svgRef.current.querySelectorAll ? svgRef.current.querySelectorAll("g[data-node]") : [];
					for (var i = 0; i < gs.length; i++) {
						if (gs[i].getAttribute("data-node") === best.id) { try { gs[i].focus(); } catch (e) { /* ignore */ } break; }
					}
				}
				// 语义缩放 + 贪心避让：小图直接标事实摘要；大图放大到 1.25× 才标。
				// 工作区/会话标签永远优先，重叠时先隐藏事实标签，再按重要性保留。
				var showFactLabels = viewport.k >= 1.25 || graphFactsVisible.length <= 10;
				// 小图只标最可信的前 6 条事实，避免把画布变成文字墙；放大后全部参与避让。
				var factRank = new Map();
				graphFactsVisible.slice().sort(function (a, b) {
					return ((b.status === "active") - (a.status === "active")) || ((Number(b.confidence) || 0) - (Number(a.confidence) || 0));
				}).forEach(function (f, i) { factRank.set(f.id, i); });
				var labelBoxes = [];
				var labelText = new Map();
				function labelBox(n, text, size) {
					var w = 0;
					for (var i = 0; i < text.length; i++) w += (text.charCodeAt(i) > 255 ? 1 : 0.62) * size;
					var r = memNodeRadius(n);
					var baseY = n.y + r + (n.kind === "fact" ? 16 : 15);
					if (baseY + size * 0.3 > graphBox.h - 6) baseY = Math.max(size + 4, n.y - r - 8);
					var dx = 0;
					var left = n.x - w / 2;
					var right = n.x + w / 2;
					if (left < 6) dx = 6 - left;
					else if (right > graphBox.w - 6) dx = (graphBox.w - 6) - right;
					return {
						x1: left + dx - 2, x2: right + dx + 2,
						y1: baseY - size * 0.85 - 2, y2: baseY + size * 0.3 + 2,
						dx: dx, ty: baseY - n.y,
					};
				}
				function boxHit(a, b) {
					// 留 2 单位容差：字形上下留白本就不重叠，1px 级的框相交不该整条隐藏。
					var ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
					var iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
					return ix > 2 && iy > 2;
				}
				var labelCandidates = [];
				lay.nodes.forEach(function (n) {
					if (n.kind !== "fact") {
						var cnt = visFacts.get(n.scope) || 0;
						labelCandidates.push({ n: n, text: memNodeLabel(n) + (cnt ? " · " + cnt : ""), size: 14, pr: n.current ? 0.5 : 1 });
					} else if (selected.indexOf(n.id) >= 0 || hover === n.id) {
						labelCandidates.push({ n: n, text: memClip(n.summary || n.key, 16), size: 14, pr: 0 });
					} else if (showFactLabels) {
						var rank = factRank.has(n.id) ? factRank.get(n.id) : 99;
						if (viewport.k < 1.25 && rank >= 6) return;
						labelCandidates.push({ n: n, text: memClip(n.summary || n.key, 10), size: 14, pr: 2 + rank * 0.01 + (1 - (Number(n.confidence) || 0)) + (n.status !== "active" ? 1 : 0) });
					}
				});
				labelCandidates.sort(function (a, b) { return a.pr - b.pr || a.n.y - b.n.y; });
				labelCandidates.forEach(function (c) {
					var box = labelBox(c.n, c.text, c.size);
					if (labelBoxes.some(function (b) { return boxHit(box, b); })) return;
					labelBoxes.push(box);
					labelText.set(c.n.id, { text: c.text, size: c.size, fact: c.n.kind === "fact", dx: box.dx, ty: box.ty });
				});
				var edgeEls = visible.edges.map(function (ed, i) {
					var a = at.get(ed.source), b = at.get(ed.target);
					if (!a || !b) return null;
					var on = pathSet && (pathSet.has(ed.source) && pathSet.has(ed.target));
					return e("line", { key: "e" + i, className: "mem-edge " + ed.kind + (on ? " on" : ""), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
				});
				var nodeEls = lay.nodes.map(function (n) {
					var r = memNodeRadius(n);
					var linked = !pathSet || pathSet.has(n.id);
					var cls = "mem-node " + n.kind
						+ (n.kind === "fact" ? " " + (n.factType || "unknown") : "")
						+ (n.status && n.status !== "active" ? " muted" : "")
						+ (n.current ? " current" : "")
						+ (selected.indexOf(n.id) >= 0 ? " sel" : "")
						+ (linked ? "" : " dim");
					return e("g", { key: n.id, className: cls, "data-node": n.id, transform: "translate(" + n.x + "," + n.y + ")",
							tabIndex: (kbId ? n.id === kbId : lay.nodes[0] && lay.nodes[0].id === n.id) ? 0 : -1,
							role: "button",
							"aria-label": nodeAria(n),
							"aria-pressed": selected.indexOf(n.id) >= 0 ? "true" : "false",
							"aria-current": n.current ? "true" : undefined,
							style: { cursor: "pointer" },
							onFocus: function () { setKbId(n.id); setHover(n.id); },
							onBlur: function () { setHover(null); },
							onKeyDown: function (ev) {
								if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
									ev.preventDefault();
									selectNode(n);
								} else if (ev.key === "Escape") {
									ev.preventDefault();
									setSelected([]);
								}
							},
						onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); selectNode(n, ev); },
						onDoubleClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); openNodeInList(n); },
						onMouseEnter: function () { setHover(n.id); }, onMouseLeave: function () { setHover(null); } },
						n.kind === "workspace"
							? e("rect", { x: -r, y: -r, width: r * 2, height: r * 2, rx: 5 })
							: e("circle", { r: r }),
						n.current ? e("circle", { r: r + 4, className: "mem-ring" }) : null,
						kbId === n.id ? e("circle", { r: r + 7, className: "mem-focus-ring" }) : null,
						(function () {
							var lab = labelText.get(n.id);
							if (!lab) return null;
							return e("text", { x: lab.dx, y: lab.ty, textAnchor: "middle",
								className: n.kind === "fact" ? "mem-fact-label" : "mem-node-label" }, lab.text);
						})(),
						e("title", null, n.kind === "fact" ? (n.summary || n.key) : (memNodeLabel(n) + (n.path ? ("\n" + n.path) : ""))));
				});
				function zoom(delta) {
					var k = Math.max(0.55, Math.min(2.4, viewport.k * delta));
					setViewport(Object.assign({}, viewport, { k: k }));
				}
				return e("div", {},
					limitNotice(),
					e("div", { className: "mem-graph-wrap", ref: wrapRef },
					e("svg", { ref: svgRef, className: "mem-graph", viewBox: "0 0 " + graphBox.w + " " + graphBox.h,
						role: "group",
						"aria-label": "记忆来源图谱：方向键遍历节点，Enter 打开详情，Esc 关闭详情",
						onKeyDown: function (ev) {
							var dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
							if (dir) { ev.preventDefault(); moveFocus(dir[0], dir[1]); }
							else if (ev.key === "Escape") { ev.preventDefault(); setSelected([]); }
						},
						onPointerDown: function (ev) {
							var t = ev.target;
							if (t && t.closest && t.closest("[data-node]")) return;
							var r = ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : null;
							var s = r && r.width && r.height ? Math.min(r.width / graphBox.w, r.height / graphBox.h) : 1;
							// Ctrl/Shift + 拖拽 = 框选；否则 = 平移。
							if (ev.ctrlKey || ev.shiftKey || ev.button === 0) {
								var startX = (ev.clientX - (r ? r.left : 0)) / s;
								var startY = (ev.clientY - (r ? r.top : 0)) / s;
								boxRef.current = { x1: startX, y1: startY, x2: startX, y2: startY, s: s, r: r, ctrl: ev.ctrlKey, shift: ev.shiftKey };
								setBoxSelect({ x1: startX, y1: startY, x2: startX, y2: startY });
							} else {
								dragRef.current = { x: ev.clientX, y: ev.clientY, vx: viewport.x, vy: viewport.y, s: s > 0 ? s : 1 };
							}
							if (ev.currentTarget && ev.currentTarget.setPointerCapture) { try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ } }
						},
						onPointerMove: function (ev) {
							var b = boxRef.current;
							if (b) {
								var x2 = (ev.clientX - (b.r ? b.r.left : 0)) / b.s;
								var y2 = (ev.clientY - (b.r ? b.r.top : 0)) / b.s;
								setBoxSelect({ x1: b.x1, y1: b.y1, x2: x2, y2: y2 });
								return;
							}
							var d = dragRef.current;
							if (!d) return;
							setViewport(Object.assign({}, viewport, { x: d.vx + (ev.clientX - d.x) / d.s, y: d.vy + (ev.clientY - d.y) / d.s }));
						},
						onPointerUp: function (ev) {
							var b = boxRef.current;
							if (b) {
								// 框选结束：找出矩形内的节点并加入选择。
								var x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2);
								var y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
								// 太小的拖拽（<5px）视为点击空白，清空选择。
								if (Math.abs(x2 - x1) < 5 && Math.abs(y2 - y1) < 5) {
									if (!b.ctrl && !b.shift) setSelected([]);
								} else {
									var hit = lay.nodes.filter(function (n) {
										return n.x >= x1 && n.x <= x2 && n.y >= y1 && n.y <= y2;
									}).map(function (n) { return n.id; });
									if (hit.length > 0) {
										if (b.ctrl) {
											// Ctrl：追加/移除（已选的取消，未选的加入）
											var newSel = selected.slice();
											hit.forEach(function (id) {
												var idx = newSel.indexOf(id);
												if (idx >= 0) newSel.splice(idx, 1);
												else newSel.push(id);
											});
											setSelected(newSel);
										} else {
											setSelected(hit);
										}
									} else if (!b.ctrl && !b.shift) {
										setSelected([]);
									}
								}
								boxRef.current = null;
								setBoxSelect(null);
								return;
							}
							dragRef.current = null;
						},
						onPointerLeave: function () { dragRef.current = null; boxRef.current = null; setBoxSelect(null); } },
						e("g", { transform: "translate(" + viewport.x + "," + viewport.y + ") scale(" + viewport.k + ")" }, edgeEls, nodeEls,
						boxSelect ? e("rect", {
							x: Math.min(boxSelect.x1, boxSelect.x2),
							y: Math.min(boxSelect.y1, boxSelect.y2),
							width: Math.abs(boxSelect.x2 - boxSelect.x1),
							height: Math.abs(boxSelect.y2 - boxSelect.y1),
							className: "mem-box-select",
							fill: "rgba(100, 150, 255, 0.15)",
							stroke: "rgba(100, 150, 255, 0.6)",
							strokeWidth: 1,
							strokeDasharray: "4,2"
						}) : null)),
					e("div", { className: "mem-graph-tools" },
						e("button", { className: "ci-btn", "aria-label": "放大", onClick: function () { zoom(1.18); }, title: "放大" }, "+"),
						e("button", { className: "ci-btn", "aria-label": "缩小", onClick: function () { zoom(0.85); }, title: "缩小" }, "−"),
						e("button", { className: "ci-btn", "aria-label": "适配视图", onClick: function () { setViewport({ x: 0, y: 0, k: 1 }); }, title: "适配" }, "适配"),
						e("button", { className: "ci-btn" + (zen ? " on" : ""), "aria-label": zen ? "退出聚焦模式" : "进入聚焦模式", onClick: function () { setZen(!zen); }, title: "隐藏概览与图例，放大图谱" }, zen ? "退出聚焦" : "聚焦")),
					e("div", { className: "mem-legend" },
						e("span", null, e("i", { className: "mem-dot ws" }), "工作区"),
						e("span", null, e("i", { className: "mem-dot sess" }), "会话"),
						e("span", null, e("i", { className: "mem-dot fact constraint" }), "约束"),
						e("span", null, e("i", { className: "mem-dot fact state" }), "状态"),
						e("span", null, e("i", { className: "mem-dot fact task" }), "任务"),
						e("span", null, e("i", { className: "mem-dot fact history" }), "历史"),
						e("span", null, e("i", { className: "mem-line shared" }), "共享"),
						e("span", null, e("i", { className: "mem-line origin" }), "来源"),
						e("span", null, e("i", { className: "mem-line private" }), "私有"),
						e("span", null, e("i", { className: "mem-line member" }), "成员"),
						e("span", { className: "ci-sub" }, "点/方向键=详情 · 双击=聚焦 · 滚轮缩放标签"))));
			}
			function listBody() {
				if (err) {
					return e("div", { className: "ci-sec" },
						e("div", { className: "ci-err", role: "alert" }, "列表加载失败：" + String(err.message || err)),
						e("button", { className: "ci-btn", onClick: function () { pull(); } }, "重试"));
				}
				var groups = new Map();
				factsVisible.forEach(function (f) {
					if (!groups.has(f.scope)) groups.set(f.scope, []);
					groups.get(f.scope).push(f);
				});
				var order = Array.from(groups.keys()).sort(function (a, b) {
					var sa = groups.get(a)[0], sb = groups.get(b)[0];
					var ca = (a === curSessScope ? 2 : 0) + (a === curWsScope ? 1 : 0);
					var cb = (b === curSessScope ? 2 : 0) + (b === curWsScope ? 1 : 0);
					return (cb - ca) || ((sb.updated_ts || 0) - (sa.updated_ts || 0));
				});
				var sections = order.map(function (scope) {
					var list = groups.get(scope);
					return e("div", { key: scope, className: "ci-sec" },
						e("div", { className: "ci-sech" }, list[0].scopeLabel || memScope(scope), e("span", { className: "ci-sub" }, list.length + " 条")),
						list.map(factCard));
				});
				var recs = (data.recent || []).filter(function (r) { return r.kind !== "insight"; });
				return e("div", {},
					limitNotice(true),
					factsVisible.length ? sections : e("div", { className: "ci-sec" },
						e("div", { className: "mem-empty" }, "当前范围没有洞察。"),
						range !== "all" ? e("button", { className: "ci-btn", onClick: function () { setRange("all"); setFocus(null); } }, "展开全部") : null),
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "最近记录", e("span", { className: "ci-sub" }, recs.length + " 条")),
						recs.length ? e("div", { className: "mem-recent" },
							e("div", { className: "mem-row mem-head" },
								e("span", null, "类型"), e("span", null, "键"), e("span", { className: "mem-scope" }, "作用域"),
								e("span", null, "状态"), e("span", { style: { textAlign: "right" } }, "更新")),
							recs.map(function (r, i) {
								return e("div", { key: i, className: "mem-row" },
									e("span", null, r.kind),
									e("span", { className: "k", title: r.key }, r.key),
									e("span", { className: "mem-scope", title: r.scope }, r.scopeLabel || memScope(r.scope)),
									e("span", { className: "mem-st " + r.status }, r.status),
									e("span", { className: "mem-time" }, memAgo(r.updated_ts)));
							})) : e("div", { className: "mem-empty" }, "—")));
			}
			function detailRow(k, v) {
				return e("div", { className: "mem-detail-row" }, e("span", null, k), e("b", null, v));
			}
			function evidenceBody() {
				if (evErr) return e("div", { className: "ci-sub" }, "证据加载失败：" + String((evErr && evErr.message) || evErr));
				if (!evData) return e("div", { className: "ci-sub" }, "证据加载中…");
				var list = evData.evidence || [];
				if (!list.length) return e("div", { className: "ci-sub" }, "没有可回查的事件证据。");
				return e("div", { className: "mem-evs" }, list.map(function (x, i) {
					return e("details", { key: x.id || i, className: "mem-ev" },
						e("summary", null,
							e("span", { className: "mem-ev-k" }, x.kind || "ref"),
							e("span", { className: "mem-ev-c", title: x.content || "" }, x.content || "—"),
							e("span", { className: "mem-ev-t" }, memAgo(x.ts))),
						e("div", { className: "mem-ev-meta" },
							(x.sessionTitle ? ("来源会话：" + x.sessionTitle) : (x.sid ? ("会话 " + String(x.sid).slice(0, 8)) : "无会话来源"))
							+ (x.seq != null ? (" · seq " + x.seq) : "")),
						x.raw ? e("pre", { className: "mem-ev-raw" }, x.raw) : null);
				}));
			}
			function railBody() {
				// 多选：显示摘要而非单个节点详情。
				if (selected.length > 1) {
					var close = e("button", { className: "ci-btn", style: { marginLeft: "auto", padding: "2px 9px" }, "aria-label": "清除选择", onClick: function () { setSelected([]); } }, "清除");
					var allNodes = (graphData && graphData.nodes) || [];
					var selNodes = allNodes.filter(function (n) { return selected.indexOf(n.id) >= 0; });
					var byKind = { workspace: 0, session: 0, fact: 0 };
					selNodes.forEach(function (n) { byKind[n.kind] = (byKind[n.kind] || 0) + 1; });
					return e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "多选摘要", close),
						e("div", { className: "ci-sub" }, "已选 " + selected.length + " 个节点"),
						e("div", { className: "mem-detail-row" }, e("span", null, "工作区"), e("b", null, byKind.workspace || 0)),
						e("div", { className: "mem-detail-row" }, e("span", null, "会话"), e("b", null, byKind.session || 0)),
						e("div", { className: "mem-detail-row" }, e("span", null, "洞察"), e("b", null, byKind.fact || 0)),
						e("div", { className: "ci-sub", style: { marginTop: 8 } }, "Ctrl+点击=追加/取消 · 拖拽空白=框选"));
				}
				if (selectedNode) {
					var n = selectedNode;
					var close = e("button", { className: "ci-btn", style: { marginLeft: "auto", padding: "2px 9px" }, onClick: function () { setSelected([]); } }, "关闭");
					if (n.kind === "fact") {
						return e("div", { className: "ci-sec" },
							e("div", { className: "ci-sech" }, "洞察详情", close),
							e("div", { className: "mem-key" }, n.key),
							e("div", { className: "mem-summary", style: { marginBottom: 8 } }, n.summary || "(无摘要)"),
							detailRow("事实类型", factTypeText[n.factType] || n.factType || "—"),
							detailRow("生命周期", n.status || "—"),
							detailRow("置信", Math.round((n.confidence || 0) * 100) + "%"),
							detailRow("范围", n.scopeLabel || memScope(n.scope)),
							detailRow("来源会话", n.originTitle || "—"),
							detailRow("更新", memAgo(n.updated_ts)),
							detailRow("模型", n.model || "—"),
							e("div", { className: "mem-detail-sub" }, "证据链 · " + (n.evidence || 0) + " 条"),
							evidenceBody(),
							e("div", { className: "mem-detail-actions" },
								e("button", { className: "ci-btn", onClick: function () { openNodeInList(n); } }, "在列表中查看"),
								n.originSid ? e("button", { className: "ci-btn", onClick: function () { setFocus("sess:" + n.originSid); setTab("list"); } }, "只看来源会话") : null));
					}
					if (n.kind === "workspace") {
						var sessN = (graph.nodes || []).filter(function (x) { return x.kind === "session" && x.workspaceScope === n.scope; }).length;
						return e("div", { className: "ci-sec" },
							e("div", { className: "ci-sech" }, "工作区详情", close),
							e("div", { className: "ci-title" }, n.label || "工作区", n.current ? e("span", { className: "mem-cur" }, "当前") : null),
							e("div", { className: "ci-sub", style: { wordBreak: "break-all" } }, n.path || n.scope),
							detailRow("记录", n.n || 0),
							detailRow("洞察", (n.facts || 0) + (Number(n.factTotal) > (n.facts || 0) ? (" / " + n.factTotal) : "")),
							detailRow("会话", sessN),
							e("div", { className: "mem-detail-actions" },
								e("button", { className: "ci-btn", onClick: function () { setFocus(n.scope); setTab("list"); } }, "只看此工作区"),
								n.current ? null : e("button", { className: "ci-btn", onClick: function () { setRange("all"); }, title: "展开全部后才能聚焦其他工作区" }, "展开全部")));
					}
					return e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "会话详情", close),
						e("div", { className: "ci-title" }, n.title || ("会话 " + String(n.sid || "").slice(0, 8)), n.current ? e("span", { className: "mem-cur" }, "当前") : null),
						e("div", { className: "ci-sub" }, n.workspace ? ("工作区 " + n.workspace) : "未定位工作区"),
						detailRow("记录", n.n || 0),
						detailRow("私有洞察", (n.facts || 0) + (Number(n.factTotal) > (n.facts || 0) ? (" / " + n.factTotal) : "")),
						detailRow("来源洞察", n.originFacts || 0),
						e("div", { className: "mem-detail-actions" },
							e("button", { className: "ci-btn", onClick: function () { setFocus(n.scope); setTab("list"); } }, "只看此会话"),
							e("button", { className: "ci-btn", onClick: function () { setSelected([]); } }, "返回概览")));
				}
				return e("div", { className: "ci-sec" },
					e("div", { className: "ci-sech" }, "当前上下文"),
					curWs ? e("div", { className: "mem-detail-row" }, e("span", null, "工作区"), e("b", null, curWs.title)) : null,
					curSess ? e("div", { className: "mem-detail-row" }, e("span", null, "会话"), e("b", null, curSess.title || curSess.scope)) : null,
					e("div", { className: "mem-detail-row" }, e("span", null, "上下文记录"), e("b", null, cur ? cur.records : 0)),
					e("div", { className: "mem-detail-row" }, e("span", null, "上下文有效洞察"), e("b", null, cur ? cur.insights : 0)),
					e("div", { className: "mem-detail-row" }, e("span", null, "本会话私有记录"), e("b", null, curSess ? curSess.records : 0)),
					e("div", { className: "ci-sub", style: { marginTop: 8 } }, "默认跟随当前选中的会话页显示；点「展开全部」查看其他工作区。"),
					e("div", { className: "mem-legend", style: { marginTop: 10 } },
						e("span", null, e("i", { className: "mem-dot ws" }), "工作区"),
						e("span", null, e("i", { className: "mem-dot sess" }), "会话"),
						e("span", null, e("i", { className: "mem-dot fact constraint" }), "约束"),
						e("span", null, e("i", { className: "mem-dot fact state" }), "状态")),
					data.session ? InjectionReceipt(data.session.injection) : null);
			}
			function settingsBody() {
				return e("div", {},
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "全库概览"),
						e("div", { className: "mem-kpis" },
							kpi("全部活跃", t.active || 0, false, "另有已解决 " + (t.resolved || 0) + " 条"),
							kpi("全部有效洞察", t.insights || 0, false, "轻 LLM 提炼且仍 active 的持久事实"),
							kpi("工作区", t.workspaces || 0, false, "按 cwd 共享的 ws:* 作用域数"),
							kpi("待处理错误", t.errors || 0, (t.errors || 0) > 0, "status=active 的 error 记录"))),
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "开关"),
						flagRow("memoryEnabled", "记忆层", "订阅事件流，写入 SQLite，注册 memory_* 工具", f.enabled),
						flagRow("memoryLlmEnabled", "轻 LLM 编译", "每轮结束把新事件编译为 insight（模型见下方「编译模型」）", f.llmEnabled),
						flagRow("memoryInjectCatalog", "目录注入", "会话首次 pre-step 注入一次记忆目录（每步重读开关）", f.injectCatalog),
						flagRow("memoryHandoff", "会话交接", "每轮结束写交接卡；同工作区新会话首次注入最近一张", f.handoff),
						flagRow("memoryConsolidateAuto", "自动整理", "空闲 " + coIdleMin + " 分钟后自动整理；无新事件不跑（手动不受影响）", f.consolidateAuto),
						e("div", { className: "ci-sub", style: { marginTop: 6 } }, "已武装进程内，未被环境变量锁定的开关即时生效；启动时未加载记忆层则需重启。环境变量（DSH_MEMORY / DSH_MEMORY_LLM / DSH_MEMORY_INJECT / DSH_MEMORY_HANDOFF / DSH_MEMORY_CONSOLIDATE）优先级高于此面板。")),
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "整理"),
						e("div", { className: "ci-sub", style: { marginBottom: 6 } }, "核对目录重置、失效旧状态与合并重复事实。约束（端口/规则/偏好）受保护，不会因整理被删。"),
						e("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
							e("button", {
								className: "ci-btn", disabled: busy || !!coi || !sid || !coReady,
								title: !coReady ? "需先开启「记忆层」与「轻 LLM 编译」"
									: (!sid ? "打开具体会话后可手动整理" : (coi ? ("整理中：" + coStage) : "立即执行一次整理")),
								onClick: consolidateNow,
							}, coi ? ("整理中 " + (coSec != null ? coSec + "s" : "") + " · " + coStage) : "立即整理"),
							e("span", { className: "ci-sub" }, coCountdown)),
						coReady ? null : e("div", { className: "ci-sub", style: { marginTop: 6 } }, "需先开启「记忆层」与「轻 LLM 编译」"),
						e("div", { className: "ci-sub", style: { marginTop: 6 } }, coManText),
						coLastText ? e("div", { className: "ci-sub", style: { marginTop: 6 } }, coLastText) : null),
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "编译模型"),
						e("div", { className: "ci-sub", style: { marginBottom: 6 } }, "轻 LLM 编译使用的模型；留空 = 跟随会话当前模型。可选本地轻模型（如 qwen3:4b）。"),
						(memMdlErr ? e("div", { className: "ci-err" }, "⚠ " + memMdlErr) : null),
						e("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
							e("select", { className: "ci-sel", value: memP, disabled: busy, onChange: onMemProviderChange,
								title: "记忆编译用 provider；「跟随会话模型」= 清除覆盖" },
								e("option", { value: "" }, "跟随会话模型"),
								memProviders.map(function (p) { return e("option", { key: p.id, value: p.id }, (p.name || p.id)); })),
							e("select", { className: "ci-sel", value: memM, disabled: busy || !memP, onChange: onMemModelChange,
								title: "选定即保存 provider/model 成对覆盖；清除 provider 即恢复跟随会话" },
								e("option", { value: "" }, memP ? "选择模型…" : "—"),
								memModels.map(function (m) { return e("option", { key: m.id, value: m.id }, (m.name || m.id)); }))),
						e("div", { className: "ci-sub", style: { marginTop: 6 } },
							(data.llmRoute && data.llmRoute.provider)
								? "当前覆盖：" + data.llmRoute.provider + " / " + (data.llmRoute.model || "—")
								: "当前：跟随会话模型（每轮重新读取 control.json）")),
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "记录构成"),
						(data.kinds && data.kinds.length) ? e("div", { className: "mem-bars" }, data.kinds.map(function (k) {
							return e("div", { key: k.kind, className: "mem-bar" },
								e("span", { className: "k", title: k.kind }, k.kind),
								e("span", { className: "mem-track" }, e("span", { className: "mem-fill", style: { width: Math.max(2, Math.round(100 * k.n / maxKind)) + "%" } })),
								e("span", { className: "n" }, k.n));
						})) : e("div", { className: "mem-empty" }, "还没有记录。")),
					e("div", { className: "ci-sec" },
						e("div", { className: "ci-sech" }, "数据库"),
						e("div", { className: "ci-sub", style: { wordBreak: "break-all" } }, "DB " + (db.exists ? memBytes(db.bytes) : "未创建") + " · " + (db.path || "")),
						e("div", { className: "ci-sub" }, "已编译会话 " + ((data.compile && data.compile.cursors) || 0)
							+ (data.compile && data.compile.last ? (" · 最近编译 " + String(data.compile.last.sid).slice(0, 8) + "… @ " + data.compile.last.through) : "")),
						e("div", { className: "ci-sub" }, "只读快照 · 5s 轮询"),
						data.error ? e("div", { className: "ci-err" }, "读取异常：" + data.error) : null,
						(db.exists && data.sqlite === false) ? e("div", { className: "ci-err" }, "Node 缺少 node:sqlite，面板无法读取") : null));
			}
			return e("div", { className: "ci-root" + (zen && tab === "graph" ? " mem-zen" : "") },
				e("div", { className: "ci-hd" },
					e("span", { className: "ci-badge " + (st === "on" ? "ci-on" : st === "pending" ? "mem-dot-pending" : "ci-off") }),
					e("div", null,
						e("div", { className: "mem-hd-t" },
							e("div", { className: "ci-title" }, "外部记忆"),
							e("span", { className: "mem-state " + st }, stText),
							(lockN ? e("span", { className: "mem-evidence", title: "环境变量优先级高于面板：被锁定的开关不可点击" }, "env 锁定 " + lockN + " 项") : null)),
						e("div", { className: "ci-sub" }, "SQLite · 工作区共享事实 · 只读工具 memory_catalog / search / get")),
					e("button", { className: "ci-btn", style: { marginLeft: "auto" }, onClick: function () { pull(); } }, "刷新")),
				banner ? e("div", { className: "mem-off" }, banner) : null,
				err ? e("div", { className: "ci-err" }, "读取失败：" + String(err.message || err)) : null,
				e("div", { className: "mem-tabs", role: "tablist" },
					tabButton("graph", "图谱"), tabButton("list", "列表"), tabButton("settings", "设置"),
					e("span", { className: "mem-tabs-note" }, tab === "settings" ? "写入、模型与诊断" : "默认跟随当前选中的会话页")),
				tab === "settings"
					? e("div", { className: "mem-settings" }, settingsBody())
					: e("div", { className: "ci-cols" },
						e("div", { className: "ci-main" },
							overviewStrip(),
							memoryToolbar(),
							tab === "graph" ? graphBody() : listBody()),
						e("div", { className: "ci-rail" }, railBody())));
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
			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register(
					{ name: "conversation.view", id: "memory", order: 21, label: function () { return "记忆"; },
						inject: function (sessionId) { return { sessionId: sessionId || null }; } },
					function (props) { return React.createElement(MemoryView, props || {}); });
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
