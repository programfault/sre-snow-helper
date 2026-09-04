# Common Steps 重构需求（暂缓，待后续实现）

> 状态：**2026-09-04 决定暂缓**。本需求来自 2026-09 的设计讨论，尚未实现。
> 当前代码仍为「组件化」架构：每个公共步骤是 `sreComponents` 数组里一张独立卡片（自带
> name/desc/form），Playbook 用 `ref: name` 引用。
> 重新评估后倾向：**保留组件化/多文档形态**，避免所有公共步骤挤进单个大 YAML；具体落地方式见文末「待定项」。

---

## 1. 需求背景（用户原话要点）

原「Components」区域需要重新设计：

1. 不再需要手动逐个添加 component；希望能更简单地管理公共步骤，且不再需要为每个组件写 name / description。
2. Playbook 的 YAML 结构随之调整，flow 里的步骤通过 `ref` 引用公共步骤。
3. 引入 `action` 语义，改变前端解析后发送 JSON payload 的方式。
4. 自动补全规则调整：`ref: `（冒号+空格）后只提示所有公共步骤；`/` + 空格逻辑不变。

## 2. 曾提出的目标 YAML 结构

### 2.1 公共步骤（单文档方案，曾作为讨论基线）

```yaml
params:
  - name: User Name
common_steps:
  ack:
    action: true
    form:
      note: for test
```

- 顶层 `params:` 为文件级公共参数。
- `common_steps:` 是 map：`步骤名 -> { action?, form? }`。

### 2.2 Playbook（flow 方案）

```yaml
name: ask questions
desc: need more details
params:
  - name: User Name
flow:
  - name: ack
    ref: ack
  - name: fill comments
    form:
      note: fill commonts ${param0}
```

- flow 项可带 `name`（展示名）与 `ref`（引用公共步骤 key）。
- 内联步骤（无 ref）自带 `form:`。

### 2.3 params 作用域规则（已澄清）

- 公共步骤 form 里的 `${paramN}` → 用**公共文档**自己的顶层 `params` 解析。
- 内联/flow 自带 form 里的 `${paramN}` → 用 **playbook 自己的 `params`** 解析。
- 前端解析时已知每个 param 来自哪里，"公共的用公共的，各自归各自管"。

### 2.4 action 语义（已澄清）

- `action` 可定义在 **flow 项**上，也可定义在**公共步骤体**内；解析后取"有效真值"。
- 未定义则默认 `false`。
- 执行顺序：
  - `action: true` 的步骤 **按 flow 定义顺序逐个独立发送**（每步一条 JSON / 一次 toast）。
  - 其余（`false`）步骤 **合并为最后一次发送**。
  - 若所有步骤都 `action: true`，则完全按 flow 顺序逐条执行。
- 展示形态维持现状：仍是"每步各自 toast 一段 JSON"，只是对 `action: true` 的步骤排序，并在日志/展示上区分独立发送与合并发送。

### 2.5 自动补全（已澄清）

- 光标前一串字符是 `ref: `（冒号+空格）时：只提示所有公共步骤 key。
- `/` + 空格触发：逻辑不变（原 slash 补全）。

## 3. 为什么先保持组件化（本次决策依据）

单文档方案把所有公共步骤 + 各自的 params/form 集中到一个 YAML 与一个编辑器里：

- 公共步骤越多，文件线性膨胀，定位/折叠/校验互相干扰。
- 没有文件/卡片级隔离，"各自归各自管"在编辑体验上反而变差。

**倾向结论**：公共步骤仍以"独立小文档/卡片"为单位更优；name 可由编辑器从步骤 key
自动派生，从而保留"免手写 name/desc"的收益、避免单文件过大的代价。

## 4. 待定项 / 后续实现 Checklist

- [ ] 确定公共步骤的存储形态：A) 每个步骤一张卡（推荐，沿用多卡片 UI，隐藏 name/desc 输入，自动以步骤 key 命名）；B) 用户原始提法：单个 `common_steps` 单文档编辑器。
- [ ] yaml-lite 解析器：`parseFlow` / 公共步骤 map 解析 / action 归一 / params 作用域解析（当前已回退到旧版，未保留改动）。
- [ ] Options UI：去掉 name/desc 输入（若走 A，需要每张卡的"步骤 key"编辑）。
- [ ] Playbook 卡与自动补全切换到 flow + 公共步骤引用；`ref: ` 上下文只提示公共步骤 keys。
- [ ] Side panel：按新 schema 渲染，参数输入分组标注来源；执行时 action=true 按其序逐条 toast、其余合并一次 toast（沿用现状手动触发，不做真实 HTTP）。
- [ ] 存储迁移：`sreComponents`/`sreCommons` 兼容到新存储键。

## 5. 相关 YAML 解析约定（参考）

- flow 项识别：`^[ \t]+- (?:name|ref|desc|form|action):`。
- `action` 布尔取值：true/false、yes/no、on/off、1/0。
- form 校验：form key 必须存在于 Form 库（按 name 归组）。若该字段任一行 type 非 string，YAML 值须等于其中某行的 value；全部为 string 则任意值通过。
