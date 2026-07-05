"""biomed-data-agent 通用文件格式转换包。

本包下的每个模块都是独立可执行的 CLI 脚本，在 CSV / Excel / DataRecord JSON
之间互相转换，填补 Qoder Work 的 xlsx skill 与本 skill 的 DataRecord JSON
之间的格式鸿沟。调度器沙箱中通过 ``python scripts/io/xxx.py --input ... --out ...`` 执行。
"""
