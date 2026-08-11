# 结构、通路与化合物

覆盖蛋白结构（PDB）、通路网络（Reactome）、化合物（PubChem）等 research-only 数据源
的检索指导。**这些数据源不进入 V2 正式构建**（无对应 dataset family），仅用于 Agent
调研与证据交叉引用。

## 1. 基因→结构（PDB）

- 用 `find_skill(source="pdb")` + `invoke_skill` 按基因/蛋白名或 UniProt 检索结构；
- 关注结构分辨率、配体/活性位点、物种与突变体；
- 用途：蛋白结构佐证（如突变是否落在关键结构域）、药物结合位点调研。

## 2. 基因/通路→网络（Reactome）

- 用 `find_skill(source="reactome")` 检索通路成员与文献引用；
- 用途：从差异基因列表出发做通路富集调研（Reactome 作为证据路径，不进正式构建）；
- 通路网络分析：Reactome 通路成员调研 + GEO/GDC 表达构建并行，最后按 accession
  交叉引用。

## 3. 基因/疾病→化合物（PubChem）

- 用 `find_skill(source="pubchem")` 按化合物名/CID/SMILES 检索；
- 用途：药物靶点发现（基因→化合物→通路三角）、已知抑制剂/激动剂调研。

## 4. 三角调研模式（药物靶点/机制）

1. 从目标基因出发：PDB 查结构、Reactome 查通路、PubChem 查化合物；
2. 用 PubMed 查文献确认双向证据（"gene+X" / "gene+Y"）；
3. 需要定量证据时再用 GDC/Xena/GEO 做表达构建（进正式产物）；
4. 三条证据链在最终汇报中分别标注来源与用途，不混为一行级合并产物。

## 5. 边界

- 上述源返回的是调研证据，**不得伪装成正式 CSV 产物**；正式产物仅由
  `execute_dataset_build` 生成；
- 结构/通路/化合物结果用于佐证假设，不作为差异分析主证据。
