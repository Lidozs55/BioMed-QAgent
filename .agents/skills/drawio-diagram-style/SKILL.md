---
name: drawio-diagram-style
description: BioMed-QAgent 仓库 draw.io 架构图的布局风格与交付循环。凡是在本仓库新建、编辑、压缩布局、检查接线或导出任何 .drawio 图(如 docs/architecture/*.drawio)时都要使用——即使用户只说"调一下布局""更紧凑一点""导出图片""检查连线"也应触发。沉淀用户认可的紧凑"镜像时间轴"布局规则、接线约定、配色与 validate → 分片目检 → 修复导出的完整闭环;与通用 drawio-skill(教画法)配合使用,本 skill 定义本仓库的品味。
---

# drawio-diagram-style — 本仓库架构图布局风格

参照实现:`docs/architecture/biomed-qagent-core-deterministic-flow.drawio`(用户亲自收紧过的终版)。
改这张图或新建同风格图时,先读它对照几何,不要凭记忆。

## 布局宪法

1. **紧凑是默认,留白是缺陷。** 画布收缩到内容大小(当前 980×1440 竖版,gridSize=5)。
   用户多轮反馈的核心都是"太宽、太空、绕行太长"——提交前自问每一块空白能否再压。
2. **右侧板块跟主轴行走（镜像时间轴），并贴着自己的接线行收放。** 右列不是信息堆栈，每个
   板块与它语义相关的流程行水平对齐，位置随行走、随版式代次收紧：
   - 受控输入 → 挨 ①②(y≈100)
   - 显式非发布状态田字格 → 紧挨 ④ 门禁上方起排(y≈295)
   - 动态扩展(窄版 235)→ 对齐右带左缘 x=520、紧挨 ⑤(y≈580)
   - 全链路可靠性 → 挨 ⑦⑧(y≈906)
   - 发布权边界 → 收尾(y≈1124);Run≠Publication + 消费重验说明放主列正下方;页脚进容器底部。
   布局迭代时按此对位重排,而不是按"输入/可靠性/状态"分类竖排。
3. **接线优先于对称。** 需要接线的框放在易于接线处——进边从哪面来最顺就放哪面
   (Review pending 在右列、从容器底部仰入;Rejected 在左列从走廊平进);格宽按文字量各自
   设定(120–145 不等),不追求等宽。
4. **主列窄卡。** 双行阶段卡 400×70;菱形门禁 340×110;常规范间隙 30px,信任转换处
   (门禁后、准入前后)放大到 40–50px。主列 x=50 w=400,走廊 ~60px,右带 x=520 w=300。

## 接线规则

- 正交边，显式钉 `exitX/exitY/entryX/entryY`;拐点 waypoints 写在**父容器相对坐标**
  (draw.io 语义如此)。
- **走廊纵向通道之外，优先用右带板块之间的横向间隙道**：相邻板块的垂直空隙(如动态扩展与
  HIL 条之间 y≈810–920)是天然的东西向车道，长失败边与回投边各占一条水平道并行不悖。
- 需接线的框放在**来边最容易进入的那一面**，不锁定左列：Review pending 在右列、从容器
  底部 `entryX=0.75;entryY=1` 仰入(边穿过容器下缘填充带属正常);Rejected 在左列从走廊平进。
- 动态回投边从面板**底部**出、沿面板下方间隙横走、从准入门右侧进入——不与走廊纵向道争位。
- 边标签 12px + `labelBackgroundColor=#FFFFFF`;避让优先动**标签**而非框：用 edge geometry 的
  相对 x(沿路径位置)+ offset 微调(实例：受控规格 x=0.225/y=3、不满足产品门禁 x=0.088/y=15、
  重新哈希 x=-0.115/y=-10)。大标题用 x=-30 平移到主列正上方，让出 Agent 竖直边的标签带。
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
   4 空格缩进、swimlane 出现 `points=` 属性、host/agent 头变化、边可能换新 id——接受这些
   产物,不要整体回滚格式;源文件旁的 `.*.bkp` 备份已被 .gitignore 忽略)。
2. `python <drawio-skill>/scripts/validate.py <file> --score` 必须 0 error。
   **已知误报**(都是校验器把 parent=6 边的相对 waypoints 当绝对坐标读导致):虚报
   through-vertex,甚至虚报两条边 cross。先手算两边真实路线(abs = rel + 容器原点)再判断,
   不要为消 warning 改坏布局;真实穿框/交叉必须修。文本包围盒重叠(text cell 交叠)若
   文字本身不碰撞可接受。
3. 预览导出(不带 `-e`,`--width` ≤ 2000),然后**分片目检**:
   `python <本skill>/scripts/tile_inspect.py preview.png --cols 2 --rows 3`,
   逐块 Read 每个分片,查裁字、压线、穿框、标签互撞。
4. 终版导出 `-e -s 2 -b 20`,随后两处修复缺一不可:draw.io 28.2.8 的 `-e` PNG 除了
   IEND 截断,**zTXt 块 CRC 也写错**,严格解码器(Pillow)会拒读——重算全部块 CRC
   (对 chunk type+body 做 crc32)并回写;嵌入 XML 是 raw deflate + URL 编码,解包校验。
5. `pnpm docs:check`、`git diff --check` 通过后再提交;docs-only 提交跳过质量门禁。
   push 被拒时先 `git pull --rebase origin main`——并行会话随时可能推过新提交。

## 反面清单(都被打回过)

- 宽画幅(>1240)与"右侧信息带竖排堆栈"——板块必须跟行对位。
- 失败边长距离绕行且穿过其他板块区,或从目标格对面强行进入。
- 为对称把接线格放远处;为消校验器误报改坏真实路线。
- 只看整图小尺寸渲染就交付——必须分片逐块看。
