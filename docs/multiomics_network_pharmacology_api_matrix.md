日期：2026-07-06

数据集和采集网站一一对应表

说明：

- “直接 API”指可以用 Python/R/HTTP 程序化获取数据或提交在线分析。
- “是否要申请”分为：否、可选、是、受控数据需申请。
- “本地下载建议”用于 AGENT 设计：在线调用优先的数据库不建议默认全量下载；大矩阵/队列数据则建议按项目缓存。

| 数据集/数据库 | 主要数据 | 推荐采集网站 | 直接 API/程序化访问 | 是否要申请/API key | 本地下载建议 | AGENT 实现建议 |
|---|---|---|---|---|---|---|
| TCGA / TARGET / GDC | 癌症 WES/WGS、RNA-seq、miRNA、CNV、甲基化、临床 | https://portal.gdc.cancer.gov/ | 是，GDC REST API | 开放数据否；controlled access 需 dbGaP/GDC token | 按项目缓存 processed data；原始 BAM/FASTQ 不默认下载 | 首批接入。以 case/sample/aliquot barcode 做主键。 |
| CPTAC / PDC | 癌症蛋白组、磷酸化蛋白组、临床、biospecimen | https://pdc.cancer.gov/pdc/ | 是，PDC GraphQL API | 多数公开元数据否；受控/embargo 数据按项目要求 | 建议缓存 protein/peptide abundance matrix 和 sample mapping | 与 GDC 联动，做 proteogenomics。 |
| CPTAC Pan-Cancer harmonized resource / CDS | 泛癌 harmonized mutation、RNA、protein、clinical、derived molecular data | https://dataservice.datacommons.cancer.gov/ | 有 Gen3/CRDC 体系 API | 通常 controlled data 需授权 | 有授权后按 cohort 下载 | 适合正式泛癌复现，不作为无授权 MVP 的默认源。 |
| cBioPortal studies | 癌症突变、CNV、表达、临床、药物研究队列 | https://www.cbioportal.org/ | 是，REST/Swagger API | public instance 通常否；私有实例看配置 | 小到中等队列可缓存 | 快速癌症队列查询首选，适合 gene panel 级分析。 |
| UCSC Xena | TCGA、GTEx、CCLE 等矩阵化多组学 | https://xenabrowser.net/datapages/ | 是，Python/REST 风格接口 | 否 | 建议缓存 phenotype + expression/CNV/methylation 矩阵 | 跨队列表达/临床分析很方便。 |
| GTEx | 正常组织 RNA-seq、WGS、eQTL/sQTL | https://gtexportal.org/home/ | 是，GTEx Portal API | 公开汇总否；个体级数据需 dbGaP | 汇总表达/eQTL 可缓存；个体级不默认 | 与 TCGA 做肿瘤-正常对照、eQTL/colocalization。 |
| ICGC / ARGO | 国际癌症基因组和临床 | https://dcc.icgc.org/、https://www.icgc-argo.org/ | 是，portal/API | 受控数据需 DAC/授权 | 按项目下载 | 作为 TCGA 外部验证源。 |
| DepMap / CCLE | CRISPR/RNAi dependency、expression、mutation、CNV、drug sensitivity | https://depmap.org/portal/ | 是，下载 endpoint/Figshare；不建议爬网页 | 通常否；遵守条款 | 强烈建议按季度 release 缓存 | 药靶优先级和癌症细胞系验证核心源。 |
| Sanger Cancer Dependency Map | CRISPR dependency、cell line omics | https://depmap.sanger.ac.uk/ | 是，公开 API | 非商业个人使用通常无需登录；商业/第三方应用需联系 | 可按 release 缓存 | 与 Broad DepMap 交叉验证。 |
| LINCS L1000 / Connectivity Map | 药物/基因扰动表达 signature | https://clue.io/、https://lincsproject.org/ | 是，CLUE API；GEO 可下载数据 | CLUE API 需要注册 API key；GEO 不需要 | 全量 L1000 很大，不默认下载；按 query/perturbagen 缓存 | 做疾病 signature 反向匹配、药物重定位。 |
| GEO | 表达、单细胞、表观、空间等 processed data 和元数据 | https://www.ncbi.nlm.nih.gov/geo/ | 是，NCBI E-utilities/FTP | NCBI API key 可选，提高限速 | 按 GSE/GSM 缓存 | accession resolver 的核心入口。 |
| SRA | FASTQ/BAM 原始测序 | https://www.ncbi.nlm.nih.gov/sra | 是，E-utilities/SRA Toolkit/cloud | NCBI API key 可选 | 原始数据体量大，仅任务需要时下载 | GSE -> GSM -> SRR 链路要自动解析。 |
| ENA | FASTQ/CRAM、study/sample/run 元数据 | https://www.ebi.ac.uk/ena/browser/home | 是，Portal API/FTP | 否 | 原始数据按需 | SRA 的欧洲镜像/替代下载源。 |
| ArrayExpress / BioStudies | functional genomics、转录组、补充文件 | https://www.ebi.ac.uk/biostudies/arrayexpress | 是，API | 否 | 按 accession 缓存 | 欧洲表达数据入口。 |
| Human Cell Atlas | 单细胞/单核数据、供体/组织元数据 | https://data.humancellatlas.org/ | 是，DCP API | 公开数据否 | h5ad/matrix 按项目缓存 | 单细胞 atlas 数据源。 |
| CZ CELLxGENE / Census | curated h5ad、cell metadata、collection | https://cellxgene.cziscience.com/ | 是，Census/Discover API | 通常否 | 适合按 collection/dataset 缓存 h5ad | 单细胞 AGENT MVP 首选。 |
| Broad Single Cell Portal | 单细胞表达矩阵、metadata、研究集合 | https://singlecell.broadinstitute.org/single_cell | 部分 API/下载 | 公开数据否；部分需登录/授权 | 按 study 缓存 | 补充 CELLxGENE/HCA。 |
| HuBMAP | 单细胞、空间、多模态人体组织图谱 | https://portal.hubmapconsortium.org/ | 是，portal/API | 公开数据否；workspace/受控功能可能需登录 | 按 dataset 缓存 | 空间组学和组织图谱重要源。 |
| ENCODE | RNA-seq、ATAC、ChIP、DNase、methylation、standard pipeline output | https://www.encodeproject.org/ | 是，REST/JSON API | 否 | metadata + peaks/bigWig 按实验缓存 | 表观调控 AGENT 首选。 |
| Roadmap Epigenomics | 正常组织/细胞表观图谱、chromatin state | http://www.roadmapepigenomics.org/ | 主要是文件下载，API 弱 | 否 | 建议缓存常用 chromatin state/peak | 稳定参考注释，更新少。 |
| 4D Nucleome | Hi-C、3D genome、核结构 | https://data.4dnucleome.org/ | 是，portal/API | 公开数据否 | 按 experiment 缓存 | 做 TAD/loop/染色质互作。 |
| PRIDE / ProteomeXchange | 蛋白组 raw MS、mzML、protein/peptide 表 | https://www.ebi.ac.uk/pride/ | 是，PRIDE API | 否 | processed matrix 优先；raw MS 按需 | 蛋白组非癌症公共数据源。 |
| MetaboLights | 代谢组/脂质组 raw 和 feature table | https://www.ebi.ac.uk/metabolights/ | 是，API | 否 | 按 study 缓存 | 代谢组源之一，注意 ID 映射。 |
| Metabolomics Workbench | 代谢组项目、峰表、代谢物注释 | https://www.metabolomicsworkbench.org/ | 是，REST/API | 否 | 按 study 缓存 | 与 MetaboLights 互补。 |
| MGnify | 微生物组、宏基因组分析结果 | https://www.ebi.ac.uk/metagenomics/ | 是，API | 否 | abundance/functional table 可缓存 | 微生物组首选整合源。 |
| HMP DACC | Human Microbiome Project 数据和元数据 | https://portal.hmpdacc.org/ | 主要 portal/下载；原始数据经 SRA | 否 | 以 SRA/BioProject 方式缓存 | 人体微生物组经典参考。 |
| Open Targets Platform | target-disease-drug evidence、tractability、known drugs、safety | https://platform.opentargets.org/ | 是，GraphQL API；也有 downloads/BigQuery | 否 | 单基因/疾病在线查；大规模用 downloads/BigQuery | 网络药理学靶点优先级首批接入。 |
| Open Targets Genetics | GWAS credible set、variant-gene、colocalization、L2G | https://genetics.opentargets.org/ | 是，API/downloads | 否 | 批量任务建议下载 | 遗传证据驱动靶点发现。 |
| ChEMBL | compound、target、bioactivity、mechanism、assay | https://www.ebi.ac.uk/chembl/ | 是，REST API/Python client | 否 | 常用 drug-target-bioactivity 可缓存 | 药物-靶点关系首选开放源。 |
| PubChem | compound、substance、bioassay、synonym、CID 映射 | https://pubchem.ncbi.nlm.nih.gov/ | 是，PUG-REST | 否 | ID 映射可缓存；全量不默认 | 化合物标准化和 CID/InChIKey 映射。 |
| BindingDB | protein-ligand binding affinity | https://www.bindingdb.org/ | 有下载和 web services | 通常否 | 建议下载子集或按 target 缓存 | 补充 ChEMBL 的结合亲和力证据。 |
| DrugBank | drug、target、enzyme、transporter、interaction、indication | https://go.drugbank.com/ | 有 API | 是，需要 API key/许可证；商业更严格 | 不作为默认自动下载源 | 用 ChEMBL/PubChem/OpenTargets 替代；有许可证再接。 |
| Therapeutic Target Database, TTD | therapeutic target、drug、disease、pathway | https://ttd.idrblab.cn/ | 主要 full data download；公开稳定 API 弱 | 下载通常否；遵守引用/条款 | 可下载快照 | 靶点-疾病-药物补充源。 |
| DGIdb | drug-gene interaction、druggable gene categories | https://dgidb.org/ | 是，GraphQL API | 否 | 小型结果在线查即可 | gene list 找可药靶点的轻量 API。 |
| PharmGKB / ClinPGx | 药物基因组、variant-drug、dosing guideline、pathway | https://www.pharmgkb.org/、https://api.pharmgkb.org/ | 是，REST/JSON/JSON-LD | 通常否 | 可按 gene/drug 缓存 | 药物反应和药物基因组证据。 |
| ClinicalTrials.gov | 临床试验、适应症、干预、phase、状态 | https://clinicaltrials.gov/data-api | 是，API v2 | 否 | 不建议全量下载；按 disease/drug 查询 | 药物/靶点临床转化状态。 |
| openFDA / FAERS / labels | 药品标签、不良事件、召回、NDC | https://open.fda.gov/apis/ | 是，API | 无 key 也可；免费 key 提高日限额 | 按 drug/event 缓存 | 药物安全性和已上市证据。 |
| STRING | PPI/functional association network | https://string-db.org/ | 是，API | 通常否；建议带 caller_identity | 常用物种网络可下载缓存 | 网络药理学 PPI 首选开放源。 |
| BioGRID | curated protein/genetic/chemical interactions、ORCS screens | https://thebiogrid.org/ | 是，REST API | 是，免费 access key | 常用 PPI/ORCS 可下载缓存 | 高置信实验互作和 CRISPR screen 补充。 |
| STITCH | chemical-protein interactions | http://stitch.embl.de/ | 有 API/下载，但更新相对旧 | 通常否 | 可按需缓存 | 化合物-蛋白网络补充；优先级低于 ChEMBL/STRING。 |
| UniProt | protein sequence/function、variant、subcellular、cross-reference | https://www.uniprot.org/ | 是，REST API | 否 | ID 映射和 protein metadata 可缓存 | 所有 protein/gene 标准化必接。 |
| RCSB PDB | 实验结构、ligand、complex、binding site | https://www.rcsb.org/ | 是，REST/GraphQL API | 否 | 结构文件按需下载 | 结构药理和 docking 前处理。 |
| AlphaFold DB | predicted protein structure | https://alphafold.ebi.ac.uk/ | 可程序化 URL/API/FTP 获取 | 否 | 按 UniProt accession 缓存结构 | 结构补全，不能替代实验结构。 |
| Reactome | curated pathways、reactions、online ORA/expression analysis | https://reactome.org/ | 是，Content Service + Analysis Service | 否 | 通常无需下载；在线分析即可 | 类似你提到的 KEGG：可直接 POST gene list 做在线富集。 |
| KEGG | pathway、disease、drug、compound、gene、module | https://www.kegg.jp/kegg/rest/keggapi.html | 是，REST API | 通常无需 key；注意许可，FTP/批量有商业限制 | 不默认全库下载；在线调用和缓存结果 | 用于 pathway/compound/drug 映射；富集可让 clusterProfiler/g:Profiler/Enrichr 调在线数据。 |
| Gene Ontology | GO term、gene annotation | https://geneontology.org/ | 有 API/文件下载 | 否 | GO OBO/GAF 可按版本缓存 | 富集背景常用，需记录版本。 |
| g:Profiler | 在线 GO/KEGG/Reactome/WP 富集、ID 转换、ortholog | https://biit.cs.ut.ee/gprofiler/ | 是，API + R/Python client | 否 | 不需下载数据库 | 自动化富集分析优先选择之一。 |
| Enrichr | 在线 gene set enrichment、KEGG/GO/MSigDB 等库 | https://maayanlab.cloud/Enrichr/ | 是，API | 否 | 不需下载数据库 | 适合快速在线富集和药物 signature 库。 |
| MSigDB | curated gene sets、hallmark、C2/C5/C7/C8 | https://www.gsea-msigdb.org/gsea/msigdb/ | 下载需账号/许可；也可经 Enrichr/g:Profiler 间接用部分库 | 是，下载需注册并遵守许可 | 如果要精确复现 GSEA，下载版本快照 | 不要默认内置全库；记录版本和许可。 |
| DisGeNET | gene-disease、variant-disease、disease-disease | https://disgenet.com/ | 是，REST API | 是，需账户/token/计划 | 按许可决定 | 可用但不建议无账户默认接入；Open Targets/GWAS/ClinVar 可先替代。 |
| OMIM | Mendelian phenotype、gene-phenotype | https://omim.org/ | 是，API | 是，需申请 API key；再分学术/商业许可 | 不默认下载 | 临床遗传强源，但有版权和再分发限制。 |
| GeneCards / MalaCards | gene-centric/disease-centric integrative knowledge | https://www.genecards.org/ | 有商业/授权 API；网页抓取禁止 | 是，需许可证 | 不默认下载/抓取 | 不建议作为自动采集默认源；用原始开放源替代。 |
| CTD | chemical-gene-disease、toxicogenomics | https://ctdbase.org/ | 主要下载/部分查询 | 通常否 | 可下载快照 | 毒理和化学-疾病证据补充。 |
| TCMSP | 中药成分、靶点、ADME | https://tcmsp-e.com/ | 无稳定开放 API | 可能需登录/人工；不建议爬取 | 不建议默认 | 传统“网络药理学”常用，但 AGENT 应标低置信并优先查原始化合物/靶点库。 |
| HERB | 中药-成分-靶点/疾病 | http://herb.ac.cn/ | 主要网页/下载，API 弱 | 看数据页要求 | 可下载快照 | 中药网络药理学可接，但要保留证据来源和预测/实验区分。 |
| ETCM / SymMap | 中药方剂、成分、靶点、症状/疾病 | http://www.tcmip.cn/ETCM/、https://www.symmap.org/ | API 弱或不稳定 | 看站点要求 | 谨慎缓存 | 用于 TCM 场景，不作为通用药物靶点主源。 |

## 4. 首批 MVP 建议接入顺序
我感觉现阶段解决第一个就基本够了，先从第一个来吧
| 阶段 | 数据源 | 原因 |
|---|---|---|
| 1 | GEO/SRA/ENA、GDC、STRING、UCSC Xena | 解决表达和癌症多组学的基础采集。 |
| 1 | Ensembl/NCBI Gene/HGNC/UniProt | 解决 ID 标准化。 |
| 1 | KEGG REST、Reactome Analysis、g:Profiler、Enrichr | 解决在线富集，不必下载大型 pathway 库。 |
| 1 | Open Targets、ChEMBL、PubChem、STRING、ClinicalTrials.gov、openFDA | 搭出网络药理学主链路：disease -> genes -> targets -> drugs -> safety/clinical。 |
| 2 | PDC/CPTAC、DepMap/CCLE、LINCS/CLUE | 增强多组学、功能筛选和药物重定位。 |
| 2 | CELLxGENE/HCA/HuBMAP/ENCODE/PRIDE/MetaboLights/MGnify | 扩展单细胞、空间、表观、蛋白组、代谢组、微生物组。 |
| 3 | DrugBank、OMIM、DisGeNET、GeneCards、TCM 类数据库 | 需要许可证或登录，放到可选 connector，不能默认静默抓取。 |


## 6. 关键来源链接

- GDC API docs: https://docs.gdc.cancer.gov/API/Users_Guide/Getting_Started/
- PDC GraphQL API docs: https://proteomic.datacommons.cancer.gov/pdc/api-documentation
- CPTAC pan-cancer data notice: https://datacommons.cancer.gov/news/cptacs-pan-cancer-multi-omic-papers-data-accessible-through-crdc
- Open Targets GraphQL API: https://platform-docs.opentargets.org/data-access/graphql-api
- KEGG API manual: https://www.kegg.jp/kegg/rest/keggapi.html
- Reactome Analysis Service: https://reactome.org/dev/analysis
- ChEMBL API docs: https://www.ebi.ac.uk/chembl/api/data/docs
- PubChem programmatic access: https://pubchem.ncbi.nlm.nih.gov/docs/programmatic-access
- DGIdb API: https://dgidb.org/api
- BioGRID REST service: https://wiki.thebiogrid.org/doku.php/biogridrest
- ClinicalTrials.gov API: https://clinicaltrials.gov/data-api/api
- openFDA API authentication: https://open.fda.gov/apis/authentication/
- CLUE API tutorial: https://clue.io/connectopedia/query_api_tutorial
- DepMap downloads: https://depmap.org/portal/
- PharmGKB API: https://api.pharmgkb.org/
- DrugBank API docs: https://docs.drugbank.com/v1/
- GeneCards terms: https://www.lifemapsc.com/terms-of-use/
- NCBI API key docs: https://www.ncbi.nlm.nih.gov/datasets/docs/v2/api/api-keys/

## 7. 代表论文链接

- Pan-cancer proteogenomics connects oncogenic drivers to functional states, Cell 2023: https://doi.org/10.1016/j.cell.2023.07.014
- Proteogenomic data and resources for pan-cancer analysis, Cancer Cell 2023: https://doi.org/10.1016/j.ccell.2023.06.009
- A proteogenomic portrait of lung squamous cell carcinoma, Cell 2021: https://doi.org/10.1016/j.cell.2021.07.016
- Integrated Proteogenomic Characterization of Clear Cell Renal Cell Carcinoma, Cell 2019: https://doi.org/10.1016/j.cell.2019.10.007
- A Next Generation Connectivity Map: L1000 Platform and the First 1,000,000 Profiles, Cell 2017: https://doi.org/10.1016/j.cell.2017.10.049
- Network-based in silico drug efficacy screening, Nature Communications 2016: https://doi.org/10.1038/ncomms10331
- Network-based approach to prediction and population-based validation of in silico drug repurposing, Nature Communications 2018: https://doi.org/10.1038/s41467-018-05116-5
- Network-based prediction of drug combinations, Nature Communications 2019: https://doi.org/10.1038/s41467-019-09186-x
