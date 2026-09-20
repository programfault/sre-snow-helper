# Common + Flows 合并为单一 YAML 的可行性分析

> 2026-09-20 · 分析稿（未实现）
> 背景：用户希望把配置页的 Common（公共步骤单文档）和 Flows（每个 flow 一张卡的独立 YAML）
> 统一为一个 YAML 文件管理，共享时只需传一个文件。

---

## 1. 现状盘点（基于代码）

| 数据 | 存储键 | 形态 | 编辑 UI |
|---|---|---|---|
| Common | `sreCommonSteps` | 单 YAML 文档 `{id, yaml}`：顶层 `params:` + `common_steps:` map | Common tab · 单 CodeMirror |
| Flows | `srePlaybooks` | 数组，每项 `{id, yaml, collapsed}`，yaml 顶层为 `name/desc/params/flow:` | Flows tab · 多卡片 + 每卡 CodeMirror |
| Forms | `sreForms` | 行数组（CSV 表格管理），不是 YAML | Form tab · 表格 + CSV 编辑器 |
| Services | `sreServices` | 单 YAML 文档（另一体系，本次不涉及） | Services tab |

关键耦合点：

- **运行时形状已经统一**：sidepanel 消费的是解析后的 `playbooks[]` + `common`（`parseFlow` /
  `parseCommonSteps` 的产物）+ `forms`。执行逻辑（`executePlaybook`）不关心数据来自几张卡还是一个文件。
- **Forms 是隐藏依赖**：`validatePlaybookFlow` / `validateOptionParams` / `type: option` 参数
  都要查 `indexForms(forms)`。只共享 common+flows 而不带 forms，对方机器上 form 校验和
  option 单选会退化为 free text。
- **id 有语义**：`pb.id` 被 sidepanel 用来记忆选中项（`srePanelState.selFlow`）与折叠状态。
- **yaml-lite 是手写行驱动解析器**（非完整 YAML），已有 `parseCommonSteps` / `parseFlow` /
  `parseParams` / `parseHeader`，但没有「对象 → YAML 文本」的序列化器，也没有多文档（`---`）支持。
- 历史决策（common-steps-redesign.md）：2026-09-04 曾评估过「单文档方案」并暂缓，理由是
  公共步骤挤进单文件后编辑体验变差。本次提议方向不同（合并的是 common+flows 而非仅 common），
  但编辑体验的顾虑依然适用。

## 2. 核心判断

**技术上完全可行，且有一个非常有利的架构事实**：合并只需要发生在「存储/传输层」，
运行时可以把 bundle 拆解回 `playbooks[] + commonDoc + forms`，sidepanel 与执行链路几乎零改动。

同时要指出：**「共享只需一个文件」并不要求「存储必须合并」**。加一个导出/导入功能
（把分散的配置序列化成一个 YAML bundle、导入时反向拆解）就能达成共享目标，而无需重写编辑器。
因此真正的取舍是：

- **方案 A：存储不变 + 统一 YAML 导入/导出**（推荐先行）
- **方案 B：存储真正合并为单文档，编辑器随之一体化**（满足「统一用 yml 管理」的完整形态）

## 3. 目标 bundle 格式（两个方案通用）

```yaml
# SRE Helper bundle v1
version: 1

# 可选：全局参数（对应现 Common 文档顶层 params）
params:
  - name: User Name
    type: textarea

# 对应现 Common 文档的 common_steps（原样搬入）
common_steps:
  ack:
    action: true
    form:
      note: acknowledged ${param0}

# 对应现 Form 库（CSV 行转 YAML），保证对方机器校验/option 可用
forms:
  - name: incident_field
    label: Field
    display: Short description
    value: short_description
    type: string

# 对应现每个 playbook 卡；结构 = 现卡片 yaml 整体缩进两格
flows:
  - name: ask-questions
    desc: Need more details
    params:
      - name: Configuration item
        type: option
    flow:
      - name: ack user
        ref: ack
      - name: custom check
        action: true
        form:
          note: check ${param0}
```

## 4. 方案 A：导入/导出（存储保持分片）

### 导出（playbooks + commonDoc + forms → 一个 YAML）
- forms：行数组 → YAML 序列（字段固定 5 个，最简单）。
- commonDoc：文本已是 `params:` + `common_steps:`，直接整体缩进 2 格拼入 bundle。
- playbooks：每张卡 yaml 顶层缩进 2 格放进 `flows:` 序列。注意 `collapsed/id` 不导出。
  - 纯文本拼接 vs parse 后重序列化：**推荐 parse 后重序列化**。文本按行加缩进对
    注释、多行值很脆弱；yaml-lite 已能解析这些子集，按解析结果重新打印更稳。
    需要新增一个小型 `serializeBundle()`（约 100~150 行，只处理本插件用到的标量/
    map/序列，无锚点无多行块）。

### 导入（YAML bundle → 存储分片）
- 新增 `parseBundle(yaml)`：复用现有解析函数，返回 `{params, commonSteps, flows[], forms[]}`。
- 合并策略（需产品决策）：
  1. 整体替换（简单粗暴，风险是覆盖对方已有配置）；
  2. 按 flow name / common step key 合并（同名覆盖、其余保留）——推荐；
  3. 选择性勾选导入（UI 成本最高）。
- 导入前先对 bundle 整体跑一遍校验（对每个 flow 调 `validatePlaybookFlow` + forms 校验），
  报告错误清单后再落库。
- 共享出去的文件里的 `${paramN}` 按 index 对位，bundle 内 params/common_steps/forms
  自洽，导入即用。

### 工作量与风险
- 改动集中在 options 侧：`serializeBundle` / `parseBundle` + 两个按钮 + 导入确认/校验报告。
  估计 **300~450 行**，不动 sidepanel、不动执行链路、不动存储键。
- 风险：低。失败模式是「导入被拒绝并报错」，不会弄脏现有配置（导入前可快照备份）。

## 5. 方案 B：存储真正合并为单文档

### 需要做的事
1. 新存储键（如 `sreBundle`：`{id, yaml}`），写入迁移：首次启动把
   `srePlaybooks + sreCommonSteps`（+ 可选 `sreForms`）合成一份 bundle 文本，旧键保留备份。
2. options UI 重构：Flows 多卡片 + Common 单编辑器 → 一个大 CodeMirror。
   - 损失：每卡独立 Validate/折叠、卡片列表的概览性；大文件里定位 flow 靠滚动/fold。
   - 可缓解：按 flow 用注释横幅分节 + fold；或保留卡片视图、卡片只是主文档的「分区编辑器」
     （每次保存整文档，复杂度高）。
3. 存储同步：`onChanged` 双开 options 页时整文档互相覆盖的窗口变大（现在是按卡分键，
   冲突面小）；单文档需要整串写回，debounce 冲突需处理。
4. sidepanel 适配：读 bundle → `parseBundle()` 拆解 → 现有 render/execute 不变；
   `pb.id` 改为派生（如 `name` 的 hash 或序列 index），`srePanelState.selFlow` 的持久化
   选择要兼容。
5. 校验：整文档一次跑全部 flow 的校验，错误信息需带 flow 名定位。

### 工作量与风险
- 估计 **800~1200 行**改动 + UI 重构，且与 9 月「保留组件化/多卡片」的暂缓决定相抵触——
  当时的顾虑（单文件膨胀、编辑定位变差）在 flow 数量增多后同样会重现。
- 收益：配置绝对单一来源、文件即备份、git 友好（如果未来把 bundle 放到仓库/网盘）。

## 6. 结论与建议

1. **可行。**运行时层（sidepanel/执行/解析）对数据来源不敏感，合并只影响存储与编辑层。
2. **建议分两步走**：
   - 第一步做 **方案 A（导入/导出单 YAML bundle）**：直接满足「共享只需一个文件」的诉求，
     改动小、可回滚、编辑体验不变；
   - 使用一段时间后，若确实希望「日常管理也只有一个 yml」，再升级方案 B——届时 A 的
     `serializeBundle/parseBundle` 直接复用，B 的增量成本主要是 UI 重构与迁移。
3. 无论选哪个方案，**forms 应纳入 bundle**，否则共享出去的配置在对方机器上校验与
   option 参数会静默降级。
4. 待定决策点：
   - 导入合并策略（整体替换 / 按 name 合并 / 勾选导入）；
   - bundle 是否包含 Services 文档（建议 v1 先不含，格式里预留 `version:` 便于扩展）；
   - `ref:` 命名冲突的处理（两个来源的 common_steps 撞 key 时的优先级）。
