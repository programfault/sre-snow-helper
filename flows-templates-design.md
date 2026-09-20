# Flows 模板化重构设计（v2：移除 Common，flow 分组/实例化）

> 2026-09-20 · 设计稿（未实现）。承接 `flows-common-merge-feasibility.md`，
> 根据用户新决策细化：**Forms 保持独立模块不动；Common 概念移除；flow 支持模板/实例以消除重复定义；
> sidepanel 下拉仍然列出所有（实例）flow。**

---

## 1. 用户指出的冗余（真实例子）

现状三个 flow 几乎完全相同，差异只在最后一步 "Leave Message" 的 4 个字符串：

- flow "Ack only"：`ref: ack`
- flow "Resolved / Complete work order"：`ref: resolve` + `ref: low-level` + Leave Message（Work order is completed ...）
- flow "Resolved / Device activation"：`ref: resolve` + `ref: low-level` + Leave Message（Device activation is completed ...）

冗余有两个层级，需要两个机制分别消解：

| 冗余层级 | 例子 | 机制 |
|---|---|---|
| **步骤级**复用 | ack / cancel / resolve / low-level 被多个 flow `ref:` | 原 common_steps 降级为 bundle 内的 `steps:` 段落（不再是独立 tab/文档） |
| **flow 级**复用 | 多个 flow 共享相同前缀 + 仅参数不同的尾步 | **模板 flow + 实例（template/instance）**，实例只声明差异 |

## 2. 目标 bundle 格式

```yaml
version: 2

# 文件级参数：供 steps: 里的 form 引用（原 Common 文档顶层 params，语义不变）
params:
  - name: Assigned To SysId

# 原 common_steps，原样降级为普通段落；ref: 只允许指向这里
steps:
  ack:
    form:
      state: 2
      work_notes: ack
      assigned_to: 3a302e092be60f107d50f4b20391bf02
  resolve:
    form:
      assigned_to: 3a302e092be60f107d50f4b20391bf02
      state: 6
      cmdb_ci: 254fc66147d8b61431c140d4116d4355
      u_application_service_incident: 254fc66147d8b61431c140d4116d4355
      close_code: Solved (Work Around)
  low-level:
    form:
      impact: 4
      urgency: 4

flows:
  - name: Ack only
    desc: Only ack
    flow:
      - ref: ack

  - name: Resolved                    # 模板：不在下拉列表出现
    template: true
    params:
      - name: business_service
        type: option                  # 仍由独立 Forms 模块供选项
    vars: [work_notes, assessment, close_notes]
    flow:
      - ref: resolve
      - ref: low-level
      - name: Leave Message
        form:
          work_notes: ${work_notes}
          comments:
          u_initial_assessment: ${assessment}
          close_notes: ${close_notes}
          business_service: ${param0}

  - name: Resolved · Complete work order    # 实例：出现在下拉
    use: Resolved
    args:
      work_notes: Work order is completed
      assessment: Work order is pending completion
      close_notes: Work order is completed

  - name: Resolved · Device activation
    use: Resolved
    args:
      work_notes: Device activation is completed
      assessment: Device activation is pending completion
      close_notes: Device activation is completed
```

要点：

- **`steps:` 不是新的 common**：它只是文件里的一段共享步骤库，没有独立编辑器、没有独立 params 作用域
  （用文件级 `params:`），`ref:` 语义与现在的 common_steps 完全一致。
- **模板 vs 实例的判定**：`template: true` → 隐藏于下拉；`use: <模板名>` → 实例。
  普通流程（无 template 无 use）与现在完全一样。
- **两类占位符并存且不冲突**：`${paramN}` 是运行时用户输入（现有机制，保留）；
  `${var}` 是实例物化时替换的命名变量（仅存在于模板中，实例必须全部给出 args）。
- Forms 模块不动：`type: option` 参数、form 值校验继续走 `sreForms`。

## 3. 运行时物化（这是本方案可行性的核心）

**加载层**（storage 读取后、渲染前）把 bundle 物化为现有 sidepanel 已认识的形状：

1. 合成 commonYaml：`params:` + `common_steps:`(= steps) → 喂给现有
   `Y.parseCommonSteps(data.commonYaml)`，sidepanel 的 ref 解析、params 徽标逻辑零改动。
2. 对每个实例生成一段自包含 playbook yaml 文本：
   - 头部取实例 `name/desc`；`params:` 取模板的 params（`type: option` 原样保留）；
   - `flow:` 取模板的 flow 文本，对 `${var}` 做文本级替换（值含 yaml 特殊字符时用
     现有引号工具加引号）；`${paramN}` 原样保留给运行时。
   - 物化后的 flow 里仍有 `ref:`，由第 1 步合成的 commonYaml 照常解析。
3. 实例 id：用 `hash(实例名)` 派生**稳定 id**（而不是 index），这样
   `srePanelState.selFlow` 的选中记忆、卡片折叠状态在编辑/重导入后仍然有效。

结果：**sidepanel（renderFlowsSelectorPanel / renderPlaybookCard / executePlaybook）基本不动**，
下拉列表 = 所有实例（普通 flow + 实例），排序沿用现有逻辑。

### 下拉分组（可选增强）

现列表是平铺按名排序。要按模板分组，给 `buildFilterPickerCard` 加 optgroup 支持，
组名 = 模板名（"Resolved"），组内 = 实例名后缀。属纯 UI 增强，不影响数据层。

## 4. Options UI 变化

- ServiceNow 页从 3 个子 tab（Form / Common / Flows）变为 2 个（Form / Flows）；
- Flows tab = 单 CodeMirror 编辑器编辑整个 bundle（v1 文档里的"方案 B 编辑器"，
  但因为实例物化机制的存在，这份 yaml 的结构是稳定的：steps 段 + flows 序列）；
- Validate 按钮：对全文档跑校验——steps form 对 Forms 库校验；每个实例物化后
  跑 `validatePlaybookFlow`；模板层面校验 vars 与 `${var}` 引用一一对应、
  use 指向存在的模板、实例名唯一、`ref:` 只指向 steps。
- 折中方案（若不想一步到位）：也可以保留每卡编辑、只是卡片按
  `steps:` / `flows:` 区段渲染——但单编辑器 + 注释横幅分节更简单，推荐前者。

## 5. 风险与边界情况

| 风险 | 处理 |
|---|---|
| args 值不合法（如 state: 9 不在 Forms 库候选里） | 物化后走现有 `validatePlaybookFlow`，校验错误需带上实例名定位 |
| 实例重名 | 校验拒绝；稳定 id 派生也要求名字唯一 |
| ref 循环 / ref 指向 flow | 规则定为 `ref:` 只允许指向 `steps:`，从语法上杜绝循环 |
| 模板被删但实例还在 | 校验：use 指向不存在的模板报错 |
| `${var}` 值里有冒号/换行等 yaml 特殊字符 | 物化替换时统一加引号（复用 yaml-lite 的引号工具） |
| 双开 options 页同步 | 单文档整串写回，debounce 冲突面比按卡分键大——沿用现有 onChanged 全量比对 + JSON diff 防回环（options-init.js 已有此模式） |
| 迁移 | 一次性：sreCommonSteps → steps 段；每张 playbook 卡 → flows 序列一项（文本整体缩进 2 格或 parse 后重序列化，推荐后者）；旧键保留 30 天作备份 |

## 6. 工作量估计

- yaml-lite：`parseBundle` / `materializeInstances` / `serializeBundle` / bundle 校验，
  约 350~450 行（大量复用现有 parse/validate 函数）。
- options：Flows tab 重构为单编辑器 + 校验报告 + 迁移逻辑，约 250~350 行；Common tab 移除。
- 加载层：storage 读取 → 物化 → 喂 sidepanel，约 50~100 行。
- sidepanel：零改动（分组下拉为可选 +80~120 行）。
- 合计约 **700~900 行**，与上一轮"方案 B"同量级，但运行时风险显著更低，
  且直接消解了用户指出的重复定义问题。

## 7. 结论

可行，且是三个方案（共享导出 / 存储合并 / 模板化）中对用户痛点的最准确回应：

1. Common 作为独立概念消失，但共享步骤以 `steps:` 段落保留（这是 ref 机制的必要地基，
   完全删掉会让 ack/resolve 这类单步复用退化成复制粘贴）；
2. 模板 + 实例把"前几步相同、只有文案不同"的 flow 收敛为一份定义 + N 行差异声明；
3. 下拉列表仍列出全部实例，分组是可选增强；
4. 物化机制保证 sidepanel 与执行链路几乎零改动，主要工作量集中在 yaml-lite 与 options UI。
