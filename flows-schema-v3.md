# Flows 统一 Schema（v3.2 定稿）

> 2026-09-20 定稿。取代 v2（flows-templates-design.md 的 template/vars/args）与 v3 初版（库+引用+扁平 flows）。
> 采用用户的嵌套结构：common 模板内联步骤 + groups 绑定模板 + flows 按组嵌套。
> v3.2 变更：参数引用从 `${paramN}` 下标改为**命名变量** `${name}`，与 Services 面板的
> 变量体系（`${incidentId}` 等）统一；解析优先级 = 文件 params > 全局捕获变量。

---

## 1. 定稿结构

```yaml
version: 3

# 文件级参数：命名变量，所有 flow 共享同一参数集
params:
- name: business_service
  type: option                  # 选项仍来自独立 Forms 模块

# 模板库：每个模板 = 名字 + 完整步骤序列（步骤内联定义，带 action/items）
common:
- name: ResolvedTemplate
  steps:
  - name: ack
    action: true
    items:
      state: 2
      work_notes: ack
      assigned_to: 3a302e092be60f107d50f4b20391bf02
  - name: update basic info
    action: true
    items:
      assigned_to: 3a302e092be60f107d50f4b20391bf02
      state: 6
      cmdb_ci: 254fc66147d8b61431c140d4116d4355
      u_application_service_incident: 2
- name: AskTemplate
  steps:
  - name: set ask state
    action: true
    items:
      state: 3
      work_notes: waiting for info
      assigned_to: 3a302e092be60f107d50f4b20391bf02

# 组：绑定下拉分组名 + 模板；flows 嵌套在组内
groups:
- group: Resolved
  common: ResolvedTemplate
  flows:
  - name: Device activation
    items:                      # flow 的自有步骤（追加在模板之后）
      work_notes: Device activation is completed
      comments: ""
      u_initial_assessment: Device activation is pending completion
      close_notes: Device activation is completed
      business_service: ${business_service}
  - name: Modem replacement
    items:
      work_notes: Modem replacement completed
      comments: ""
      u_initial_assessment: Modem replacement pending check
      close_notes: Modem replacement completed
      business_service: ${business_service}     # ← 命名变量，与 Services 体系一致

- group: Ask
  common: AskTemplate
  flows:
  - name: Request customer info
    items:
      work_notes: Please provide serial number
      comments: ""
      u_initial_assessment: Waiting for customer input
      business_service: ${business_service}     # ← 同一参数集

  - name: Request site photo
    items:
      work_notes: Customer needs to upload site photo
      comments: ""
      u_initial_assessment: Awaiting site evidence
      business_service: ${business_service}
```

## 2. 相对用户草稿的修正点

| # | 草稿 | 修正 | 原因 |
|---|---|---|---|
| 1 | `business_service: ${param1}/${param2}/${param3}` 下标递增 | 命名变量 `${business_service}`，全局同一参数集 | 参数按名字解析（v3.2），不存在按 flow 递增的索引 |
| 2 | flows 平铺在外、与 groups 无关联 | flows 嵌套进各自 group | 表达归属关系，下拉分组直接由此渲染 |
| 3 | `common: - name: ResolvedTemplate` 后紧跟顶层 `steps:`（层级易误读） | 每个模板自带 `steps:` 缩进在模板下 | 明确模板与步骤的从属关系 |
| 4 | flow 的 `items` 无 name | 可省略 name（自动以 flow 名显示），也可显式写 | 展示友好 |

## 3. 语义规则

- **flow 的有效步骤序列** = `groups[].common` 对应模板的 `steps` ++ flow 自己的 `items`（作为最后一个步骤）。
- **action 语义不变**：模板步骤上的 `action: true` 按序逐条独立发送；flow 的 `items` 未写 action
  时默认 false，作为（唯一的）合并发送步骤；也可显式写 `action: true`。
- **无模板的独立 flow**：`group` 可以不写 `common:`（或 flow 直接挂在无 common 的组下），
  例如 "Ack only" = 一个组里只有一个 flow，items 即 ack 内容本身。
- **flow 多个自有步骤**：v1 支持 `items`（单步）；如确有多步需求，后续允许 `steps:` 列表
  （结构上是 items 的自然扩展，解析器预留）。

### 3.1 命名变量体系（v3.2 核心）

- **引用语法**：`${name}`，与 Services 面板现有体系完全一致（`resolvePlaceholders`
  本来就是按名字查表，flows 只是此前恰好传了 `paramN` 当名字）。
- **解析优先级**（用户确认的规则）：
  1. **文件 `params:` 里声明的参数**（执行时用户输入，`type: option` 从 Forms 库供选项）
     —— 声明了就一定是输入框，即使与全局变量重名也**以文件定义优先**；
  2. **全局捕获变量**（SRE_ENV：`${number}` `${caller_name}` `${incidentId}` `${userToken}`
     `${instance}` `${f_wo_number}` `${f_sid}` `${f_access_token}`）—— 自动从页面上下文填充，
     不渲染输入框（对齐 Services 现有行为）；
  3. 两者都不是 → 按 Services 惯例渲染为自由文本输入框，同时校验给出 warning
     （防手滑拼错变量名后静默变输入框）。
  - 实现：`values = { ...capturedGlobals, ...userInputs }`，文件参数后写覆盖全局，天然实现优先级。
- **命名规范**：建议 `[A-Za-z0-9_]+`；校验对含空格/特殊字符的名字告警。
- **按需渲染（v3.3）**：`params:` 是整个 bundle 共享的参数集，但**侧边栏只渲染当前选中
  flow 实际引用到的 param**——判定口径 = 该 flow 所有步骤 `form:`（含嵌套对象/数组）里的
  `${name}` 出现的名字（legacy `ref:` 步骤则扫描被引用 common 步骤的 form）。
  没被引用的 param 不渲染（避免噪音，也避免手填了值反而清空字段）；一个 flow 一个 param
  都不用时不显示 Parameters 区。实现：引擎 `Y.usedParamNames()`，options 与 sidepanel 共用。
- **自动补全**：编辑器里 `${` 后提示 文件参数 + 全局捕获变量（分组展示）。【已实现】
- **迁移**：存量文档的 `${paramN}` 按各文档 `params:` 列表下标映射重写为
  `${name}`；对应下标无声明的保留原样并告警。

- **稳定 id**：`hash(group名 + "/" + flow名)`；校验要求组内 flow 名唯一、组引用的
  common 模板必须存在、模板内步骤名唯一。
- **空值 = 清空字段（v3.3）**：`field:` / `field: ~` / `field: ""` 三种写法等价，语义都是
  "把该字段置空"（如 `assign_to:` 清空指派人）。校验对空值一律放行——即使该字段在 Forms
  库里只有固定候选值（`type: number`/`sysid`）也不报错；执行时 PATCH 发送显式空字符串。
  注意：带引号的 `"~"` / `"null"` 是**字面量文本**，不是空值。空值经物化写出为 `~`，
  读回时必须还原成 `""`（否则会把两字符的 `~` 发给 ServiceNow）。【已实现】
- **`comments` 是特例**：comments 与 work_notes 实际总是同文，所以空的 `comments:`
  （`comments: ""` / `~` / 什么都不写）是"与 work_notes 相同"的标记，长文本只写一遍：
  - 空 comments + 有 work_notes → comments 取 work_notes 的值；
  - 空 comments + 无 work_notes → **删除该字段**：空标记只是"跟随 work_notes"，绝不等于
    "清空 incident 的 comments"；
  - comments 非空 → 按作者写的值原样发送（不再被 work_notes 无条件覆盖）；
  - comments 整行不写 + 有 work_notes → 仍自动补齐（兼容旧文档）。【已实现】

## 4. 功能无损对照

| 现有功能 | v3.1 归宿 | 状态 |
|---|---|---|
| ref 单步复用 | 模板内联步骤（模板本身承担复用单元） | ✅ 语义等价（复用粒度从"步骤"变为"模板"） |
| action:true 独立发送 / 其余合并 | 步骤级 action，语义不变 | ✅ |
| type: option 参数 / form 校验 | Forms 模块不动 | ✅ |
| 公共参数 | 文件级 params | ✅（双作用域徽标取消，参数行去重） |
| 下拉列出全部 flow | 列出全部，并按 group 分组渲染 | ✅ + 增强 |
| pb.id 选中记忆 | hash(组/flow名) 稳定 id | ✅ |
| 步骤级 ref 混排（ref A → 内联 → ref B） | 复用粒度变为整个模板，步骤级 ref 取消 | ⚠️ 唯一收敛点（现有数据无此用法） |
| 多个模板共享同一单步（如 ack 出现在两个模板） | 各模板内各写一份 | ⚠️ 轻微重复；后续可给模板 steps 加 `ref:` 支持（结构预留兼容） |

## 5. 运行时物化（不变）

1. 合成 commonYaml（文件 params + 各模板步骤展开成 common_steps）→ 现有
   `parseCommonSteps` / ref 解析照常工作；
2. 每个 flow 物化成自包含 playbook yaml（name/desc + params + flow: 模板步骤 ref +
   自有 items 步骤）→ `renderFlowsSelectorPanel` / `executePlaybook` 零改动；
3. 下拉按 groups 渲染 optgroup（可选增强）；不分组数据平铺也照常工作。

## 6. 工作量

与 v3 初版相当（约 700 行）：yaml-lite（parseBundle / 展开 / 校验 / 物化）约 300~400，
options 单编辑器 + 迁移约 250~350，加载层 50~100，sidepanel 参数去重 + 可选分组 100~200。

## 7. 剩余问题清单（用户问"还有什么其他的问题么"）

仍需注意 / 待确认（2026-09-20 12:00 更新：以下三项均已实现）：

1. ~~无模板 flow 的承载方式~~：组可以不写 `common:`（用户确认）；
2. ~~未知变量名的处理策略~~：**validate 报错**（严格模式，用户确认）——每个 `${name}` 必须是
   文件参数或捕获全局变量，否则校验失败；
3. ~~模板间共享单步~~：**已实现** —— 顶层可选 `steps:` 共享步骤库，模板步骤和 flow 的
   `steps:` 条目都可用 `- ref: <库名>` 引用（纯继承 name/action/items，ref 只允许指向库，
   从语法上杜绝循环）；迁移工具不产出库；
4. ~~flow 多自有步骤~~：**已实现** —— flow 可写 `steps:` 列表（每项 ref 或内联），
   与单步 `items` 互斥（同时出现校验报错，物化时 steps 优先）；
5. **旧数据迁移**：`${paramN}` → `${name}` 的自动重写基于下标映射，若某文档 params
   声明与实际引用对不上，重写后会留下未解析占位符（校验会抓出来，不会静默发送）；
6. **变量名规范**：建议限定 `[A-Za-z0-9_]+`，含空格/特殊字符校验告警（YAML 值里写
   `${my name}` 这类仍能解析，但易踩坑）；
7. ~~自动补全增强~~：**已实现** —— 编辑器输入 `${` 后按名提示文件参数（PARAM 组）+
   全局捕获变量（GLOBAL 组），选中自动补全并闭合 `}`；Services 编辑器同样受益（全局组）。
