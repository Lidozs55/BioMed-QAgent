---
name: drawio-diagram-style
description: BioMed-QAgent 仓库 draw.io 架构图的布局风格与交付循环。凡是在本仓库新建、编辑、压缩布局、检查接线或导出任何 .drawio 图(如 docs/architecture/*.drawio)时都要使用——即使用户只说"调一下布局""更紧凑一点""导出图片""检查连线"也应触发。沉淀用户认可的紧凑"镜像时间轴"布局规则、接线约定、配色与 validate → 分片目检 → 修复导出的完整闭环;与通用 drawio-skill(教画法)配合使用,本 skill 定义本仓库的品味。
---

# drawio-diagram-style — 本仓库架构图布局风格

参照实现:`docs/architecture/biomed-qagent-core-deterministic-flow.drawio`(用户亲自收紧过的终版)。
改这张图或新建同风格图时,先读它对照几何,不要凭记忆。

## 布局宪法

1. **紧凑是默认,留白是缺陷。** 画布收缩到内容大小(当前 980×1320 竖版,gridSize=5)。
   用户多轮反馈的核心都是"太宽、太空、绕行太长"——提交前自问每一块空白能否再压。
2. **右侧板块跟主轴行走(镜像时间轴)。** 右列不是信息堆栈,每个板块与它语义相关的
   流程行水平对齐,读者无需来回找:
   - 受控输入 → 挨 01/02(y≈100)
   - 显式非发布状态田字格 → 挨 04 门禁(y≈290)
   - 动态扩展(窄版 235)→ 挨 05/06(y≈600)
   - 全链路可靠性 → 挨 07/08(y≈840)
   - 发布权边界 → 收尾(y≈1055);Run≠Publication 说明放主列正下方(y≈1120);页脚进容器底部。
   布局迭代时按此对位重排,而不是按"输入/可靠性/状态"分类竖排。
3. **接线优先于对称。** 需要接线的框放在易于接线处——田字格中 Rejected、Review pending
   两个有边框格放**左列**面向走廊;格宽按文字量各自设定(120–145 不等),不追求等宽。
4. **主列窄卡。** 双行阶段卡 400×70;菱形门禁 340×110;常规范间隙 30px,信任转换处
   (结果提交→产品门禁→发布)放大到 40–50px。主列 x=50 w=400,走廊 ~60px,右带 x=520 w=300。

## 接线规则

- 正交边,显式钉 `exitX/exitY/entryX/entryY`;拐点 waypoints 写在**父容器相对坐标**
  (draw.io 语义如此)。
- 短失败边走走廊直角进入;**长失败边从带外侧绕行**(右带右缘外 ~40px 的竖直通道),
  从目标的干净侧(底/顶)进入——宁可绕远不穿任何框,0 交叉、0 穿框是硬标准。
- 边标签 12px + `labelBackgroundColor=#FFFFFF`,用 geometry 的相对 x/y 和 offset 把标签
  挪出线体和框边。
- 边的颜色即语义:蓝 #6C8EBF 主流,紫 #9673A6 动态扩展回投,绿 #82B366 通过流,
  红虚线(`dashed=1;dashPattern=8 4`)#B85450 失败退出,灰 #666666 Agent 规格流。

## 视觉语言

- 固定浅色盘:主流/输入 #6C8EBF/#DAE8FC,门禁 #FFF2CC/#D6B656,产品门禁 #FFE6CC/#D79B00,
  产出 #D5E8D4/#82B366,动态 #E1D5E7/#9673A6,失败 #F8CECC/#B85450,中性 #F5F5F5/#666666。
- 中文为主,契约名英文(DatasetExecutionSpec、SourceAsset、OperationResult、
  ProductAssessment、DatasetPublication)。卡内标题 15–18px 粗体 + 12px 灰色副行。
- 不加图例;标题区(30px 主标题 + 18px 副标题)压在最上,Agent 框可与之共享顶部条带
  (文本包围盒重叠但文字不碰撞是可接受的)。

## 交付循环

1. 改 XML(保持 cell id 稳定;用户在 draw.io 桌面版里改过的话,文件会被重新序列化:
   4 空格缩进、swimlane 出现 `points=` 属性、边可能换新 id——接受这些产物,不要整体回滚格式)。
2. `python <drawio-skill>/scripts/validate.py <file> --score` 必须 0 error。
   **已知误报**:校验器把 parent=6 边的相对 waypoints 当绝对坐标读,会虚报
   through-vertex。先手算真实路线(abs = rel + 容器原点)再判断,不要为消 warning 改坏布局;
   真实穿框/交叉必须修。
3. 预览导出(不带 `-e`,`--width` ≤ 2000),然后**分片目检**:
   `python <本skill>/scripts/tile_inspect.py preview.png --cols 2 --rows 3`,
   逐块 Read 每个分片,查裁字、压线、穿框、标签互撞。
4. 终版导出 `-e -s 2 -b 20`,随后两处修复缺一不可:draw.io 28.2.8 的 `-e` PNG 除了
   IEND 截断,**zTXt 块 CRC 也写错**,严格解码器(Pillow)会拒读——重算全部块 CRC
   (对 chunk type+body 做 crc32)并回写;嵌入 XML 是 raw deflate + URL 编码,解包校验。
5. `pnpm docs:check`、`git diff --check` 通过后再提交;docs-only 提交跳过质量门禁。

## 反面清单(都被打回过)

- 宽画幅(>1240)与"右侧信息带竖排堆栈"——板块必须跟行对位。
- 失败边长距离绕行且穿过其他板块区,或从目标格对面强行进入。
- 为对称把接线格放远处;为消校验器误报改坏真实路线。
- 只看整图小尺寸渲染就交付——必须分片逐块看。
