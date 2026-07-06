"""为历史任务生成 records.json 和 analysis.json（从 final_data.json 提取）。"""
import json
from pathlib import Path

OUTPUT_DIR = Path("data/output")
for task_dir in sorted(OUTPUT_DIR.iterdir()):
    if not task_dir.is_dir():
        continue
    summary_file = task_dir / "task_summary.json"
    if not summary_file.exists():
        continue

    # 生成 records.json（从 final_data.json 提取）
    records_file = task_dir / "records.json"
    final_data_file = task_dir / "final_data.json"
    if not records_file.exists() and final_data_file.exists():
        with open(final_data_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        records = data.get("records", [])
        if records:
            with open(records_file, "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, indent=2)
            print(f"  {task_dir.name}: records.json ({len(records)} 条)")

    # 生成 analysis.json（合并 ppi/enrichment/drug_target 结果）
    analysis_file = task_dir / "analysis.json"
    if not analysis_file.exists():
        analysis = {}
        for name, fname in [("ppi_network", "ppi_result.json"),
                            ("enrichment", "enrichment_result.json"),
                            ("drug_targets", "drug_target_result.json")]:
            fpath = task_dir / fname
            if fpath.exists():
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # 提取 result 字段（save_result 包装的格式）
                if isinstance(data, dict) and "result" in data:
                    analysis[name] = data["result"]
                else:
                    analysis[name] = data
        if analysis:
            with open(analysis_file, "w", encoding="utf-8") as f:
                json.dump(analysis, f, ensure_ascii=False, indent=2)
            print(f"  {task_dir.name}: analysis.json ({len(analysis)} 项)")

print("完成")
