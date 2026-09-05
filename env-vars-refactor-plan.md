# 环境变量重构 + 实时上下文计划

> 目标：把 Base Info 从侧栏搬到 Options「环境变量」页；侧栏 header 只保留一个 info 图标 hover popover；
> 新增 2 个 ServiceNow 全局变量（caller_name / caller_sysid）；支持第二个 FSM domain（精确 host）；
> 修复"离开相关 tab 值不清除"的 stale 问题（Options 打开除外）。
>
> 约束：页面元素采集逻辑（content scripts 读 DOM / g_form）**不变，只挪展示位置与扩字段**。

---

## 1. 需求回顾（用户原话要点）

1. Base Info 占据太大空间 → 整体挪到配置页，单独一个 tab「环境变量」。采集逻辑不变，只是挪地方。
2. 新增两个全局变量 `caller_name`、`caller_sysid`：在 ServiceNow 表单页用
   `g_form.getDisplayValue('caller_id')` / `g_form.getValue('caller_id')` 获取。
3. 侧栏 header 保留（一个 info 小图标），hover 弹出所有变量的**实时值**。
   - 只显示 label + 对应值 + copy 按钮；
   - **不显示** `${gvar}` 变量名；
   - 因为带 copy 操作，它不是普通 hover tooltip，而是可交互的 popover（移入后可点击）。
4. 实时性：当前离开对应网站 tab（globe / ServiceNow）后值仍残留（PickBest 回退最近值）→ 应"跟随当前活动 tab"：在页面上就实时可见，切走立即清除。**Options 打开时不清除**（它本身是数据查看页）。
5. FSM 有两个 domain：`fsm.globe.com.ph` 和 `gsmgt-prod.gobetel.com`，采集逻辑一样、domain 不同，按**精确 host** 匹配第二个。

---

## 2. 目标行为（语义定义）

### 2.1 实时上下文（background 重定义）
按 **source（snow / goble）独立** 维护两套状态：

| 概念 | 含义 | 给谁用 |
|---|---|---|
| **active ctx** | 当前活动 tab 若属于该 source → 该 tab 的合并快照；否则 **null（清空）** | 侧栏 popover（实时跟随） |
| **last ctx** | 该 source 最近一次捕获到的**非空**快照，随上报/删除更新，**不随切 tab 清空** | Options 环境变量页 |

关键点：
- `PickBest()` → 改为 active-relative；broadcast（`snow_ctx`/`goble_ctx`）在 active 不属于该 source 时广播 `null`，侧栏收到即显示空。
- Options 环境变量页**不走** `snow_ctx`/`goble_ctx` 的 null 广播，而是：
  - 打开时查询新增消息 `snow_get_last` / `goble_get_last`（返回 last ctx）；
  - 监听广播时**只应用非 null** 的更新（多窗口场景下新捕获也能刷上去）。
- 页面**内部**字段级清空行为不变（沿用现有 collect/merge，不引入字段级清除），清除发生在 **tab/URL 级别**。

### 2.2 触发清除的时机（新增/调整监听）
- `chrome.tabs.onActivated`：active 指向普通页 / options / newtab 等 → 相应 source broadcast null。
- `chrome.tabs.onUpdated`（新增）：active tab URL 从目标站点跳走（同 tab 导航离开）→ 视为不再是该 source → broadcast null。
- `chrome.tabs.onRemoved`：现有逻辑保留。

### 2.3 副作用（明确的行为变化）
- 以前"开着 SN 页但浏览别的 tab，仍能 PATCH"将变为：**必须位于对应站点 tab 上**，执行时上下文才有效；否则明确报"open the page first"。
- 同一时刻只跟随一个 active tab，SN 与 goble 上下文互不串扰、各自独立（浏览 goble 时 SN ctx 为空，反之亦然）。
- Options tab 激活不会清空 last ctx，因此 Options 页仍能看到最近值。

---

## 3. 改动清单（按实现顺序）

### Step 1 — 新增 caller 字段采集（snow-content.js / background.js）
- 现有 `probeToken()` 注入的 MAIN-world 脚本只读 `g_ck`。扩展同一 postMessage 通道：
  - 尝试从 `window` 或 `#gsft_main` 的 contentWindow 拿 `g_form`；
  - 可用则读 `g_form.getValue('caller_id')`（sysid）与 `g_form.getDisplayValue('caller_id')`（名称）；
  - 结果随 token 一起 `postMessage` 回传（事件源仍用 `sre-snow-probe`）。
  - `g_form` 不可用（列表页/非表单）→ 不带 caller 字段，**不强制清空**（沿用现有 OR-merge）。
- `background.js`：
  - `snowFields()` / `snowMergeReport()` 增加 `callerSysid`、`callerName` 两键。

### Step 2 — 共享字段定义（新文件 env-defs.js）
把字段列表从 sidepanel 抽成**纯数据共享文件**，sidepanel 与 options 引用同一份（避免两处漏改）：
- 字段：`{ key, src: "snow"|"goble", label, gvar, max }`
- 现有 6 条 + 新增 2 条：
  - `{ key:"callerName", src:"snow", label:"Caller Name", gvar:"caller_name" }`
  - `{ key:"callerSysid", src:"snow", label:"Caller ID", gvar:"caller_sysid" }`
- 同时导出：按 src 分组的字段、label 查询、`max`/截断显示函数。
- `sidepanel.html`、`options.html` 在各自主脚本前引入该文件。

### Step 3 — sidepanel.js 全局变量集合与映射
- `SN_CTX_VARS` 增加 `caller_name`、`caller_sysid`（`CTX_VARS` 自动包含）。
- `snowVars()` 增加：
  - `callerName` → `${caller_name}`
  - `callerSysid` → `${caller_sysid}`
- `BASE_INFO_FIELDS` 常量替换为引用 `SRE_ENV_FIELDS`（Step 2）。
- 相关描述文案（toast hint 等）同步补上 caller / 新 domain 提示。

### Step 4 — 第二个 FSM domain（精确 host）
- `manifest.json`：
  - `host_permissions` 增加 `"https://gsmgt-prod.gobetel.com/*"`
  - `content_scripts` matches 增加 `"https://gsmgt-prod.gobetel.com/*"`（复用 goble-content.js）
- `goble-content.js`：`isGoble` 判断增加 `host === "gsmgt-prod.gobetel.com"`（精确相等，不泛化）。
- `background.js`：
  - `isGobleUrl()` 增加精确 host 判断；
  - `goble_refresh` 的 `tabs.query` URL 数组增加 `"https://gsmgt-prod.gobetel.com/*"`。

### Step 5 — background 实时/清除语义（见 §2）
- active / last 两套快照；`get_current` 改为 active-relative（可返回 null）。
- 新增 `snow_get_last` / `goble_get_last` 消息。
- 新增 `tabs.onUpdated` 处理同 tab 导航离开目标站点的清除。
- broadcast 逻辑：active-relative 广播（含 null）；last 快照不广播成 null。

### Step 6 — 侧栏：header info 图标 + 可交互 popover
- 移除 `#baseStrip` 整块及其内 Base Info 面板（`renderBaseInfoPanel` 在 render() 中的挂载点删除）。
- `header-actions` 增加一个小 info 图标（放 monitor dot 左侧或右侧，视觉与齿轮统一）。
- body 挂一个 popover 容器（绝对定位，右上对齐 header）：
  - **触发**：图标 mouseenter 打开（带 ~120ms 延迟），鼠标移入 popover 内不关闭；图标/popover 双双 mouseleave 后才关闭（延迟 ~250ms）；点外部 / Esc 关闭。
  - **内容**：仅 label + 截断值 + copy 按钮（复现现有 copy 交互），**无 `${gvar}`**；空态显示提示文案"Open a ServiceNow incident or FSM order page…"。
  - **数据**：跟随 `snow_ctx`/`goble_ctx`（active-relative，可空）实时刷新。
- 保留一个最小 Refresh 入口？→ 默认**不做**（popover 保持轻量；Options 页提供 Refresh），如需要再加。
- Labels 卡片保持在 .content 首位不变。

### Step 7 — Options：新顶级 tab「环境变量」（page-env）
- `options.html`：
  - `.tabs` 增加 `<button class="tab top" data-tab="env">环境变量</button>`；
  - 增加 `<div class="tab-page hidden" id="page-env">`（Options-core 的通用 tab 切换自动生效）；
  - 本页样式（复用现有 card / table / copy-btn 视觉）。
- 新 `options-env.js`（options.html 引入）：
  - 用 `SRE_ENV_FIELDS` 渲染**完整视图**：按 source 分组（ServiceNow / FSM）的行，含 label + `${gvar}` 小字 + 值 + copy（Options 页展示 gvar 有意义，供作者参考）。
  - 打开时查询 `snow_get_last` / `goble_get_last` 渲染；监听广播只应用非 null 更新。
  - Refresh 按钮：复用现有 `snow_refresh` / `goble_refresh` 消息后重查 last。
- 从 sidepanel 挪走时**不改动**任何 content script 采集逻辑。

---

## 4. 已确认的决策

1. **新增 label**：`Caller Name`（`${caller_name}`）、`Caller ID`（`${caller_sysid}`）。
2. **执行限制**：接受"仅活动 tab 有效"——执行对应源的服务必须位于该源活动 tab。
3. **popover**：带标题栏；显示 label + 值 + copy；不显示 gvar。
4. **Options tab 文案**：顶层 tab 用英文 **Environment**（与环境变量主题一致、与其它英文 tab 并列）。Options 页内行保留 `${gvar}` 小字提示（作者参考）。
5. **Refresh**：仅 Options 环境变量页提供。

---

## 5. 验证清单（改动后手工验证）

- [ ] ServiceNow 表单页：popover / Options 页出现 Caller Name、Caller ID，与页面 caller 一致；`${caller_name}`/`${caller_sysid}` 可被 playbook/service 解析。
- [ ] fsm.globe.com.ph 与 gsmgt-prod.gobetel.com 都能采集 fwo/fsid/factok。
- [ ] 在 SN incident tab 上 → 值实时显示；切到普通网页 → popover 变空。
- [ ] 打开 Options「环境变量」→ 仍显示最近值（不清除）；回到原 tab → 实时恢复。
- [ ] popover：hover 图标弹出，鼠标移入点击 copy 成功；移出后关闭。
- [ ] 同 tab 导航离开目标站点（如 goble 跳到别站）→ 值清除。
- [ ] 原有 playbook Dry Run / Execute、Services Run 回归通过。
- [ ] chrome://extensions 重新加载后无报错。

## 6. 提交

按功能原子提交：采集扩展(caller+domain) → 共享字段/全局变量 → background 实时语义 → 侧栏 popover → Options 页。完成后推送 GitHub。
