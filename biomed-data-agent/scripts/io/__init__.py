"""biomed-data-agent 通用文件格式转换包。

本包下的每个模块都是独立可执行的 CLI 脚本，在 CSV / Excel / DataRecord JSON
之间互相转换，作为调度器通用文件处理能力的补充（当调度器无相关能力时回退使用）。
调度器沙箱中通过 ``python scripts/io/xxx.py --input ... --out ...`` 执行。
"""
