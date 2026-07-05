#!/usr/bin/env python3
"""fasta_parser.py — FASTA 序列解析器。

用途：把 FASTA 文件（.fasta / .fa / .faa / .fna）解析成 DataRecord 列表。

输入格式：
    标准 FASTA，``>`` 开头的 header 行后跟若干行序列。支持多序列文件。

输出格式：
    每条序列一个 record，fields 含：
      seq_id, description, sequence, length,
      type (protein / dna / unknown，基于字母判断), entity_type。

示例：
    python fasta_parser.py --input sequences.fasta --out result.json

依赖：仅标准库。流式逐行读取，支持大文件。
"""
import sys

from _base import (BaseParser, make_record, setup_cli,
                   make_ok, make_error, write_output)

PROTEIN_ALPHABET = set("ACDEFGHIKLMNPQRSTVWY*")
DNA_ALPHABET = set("ACGTN")
# 蛋白特有字母（不与 DNA 字母重叠）
PROTEIN_ONLY = set("DEFHIKPQRVWY")


def detect_seq_type(sequence):
    """根据序列字母判断类型：protein / dna / unknown。"""
    if not sequence:
        return "unknown"
    upper = set(sequence.upper())
    if upper <= DNA_ALPHABET:
        return "dna"
    if upper <= PROTEIN_ALPHABET:
        return "protein"
    # 含蛋白特有字母 -> protein，否则无法确定
    if upper & PROTEIN_ONLY:
        return "protein"
    return "unknown"


class FastaParser(BaseParser):
    """逐行流式解析 FASTA。"""

    source_name = "fasta"

    def parse(self, file_path):
        records = []
        seq_id = None
        description = ""
        seq_lines = []

        def flush():
            """把当前累积的序列输出成 record。"""
            if seq_id is None:
                return
            sequence = "".join(seq_lines)
            fields = {
                "seq_id": seq_id,
                "description": description,
                "sequence": sequence,
                "length": len(sequence),
                "type": detect_seq_type(sequence),
                "entity_type": "Sequence",
            }
            records.append(make_record(
                task_id="", source_name=self.source_name,
                fields=fields, file_path=file_path,
                confidence=0.95, method="table",
                accession=seq_id, source_type="file"))

        with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n").rstrip("\r")
                if not line:
                    continue
                if line.startswith(">"):
                    flush()
                    header = line[1:]
                    parts = header.split(None, 1)
                    seq_id = parts[0] if parts else ""
                    description = parts[1].strip() if len(parts) > 1 else ""
                    seq_lines = []
                else:
                    # 文件开头出现无 header 的脏行 -> 跳过
                    if seq_id is None:
                        continue
                    seq_lines.append(line.strip())
        flush()
        return records


def main():
    parser = setup_cli("fasta_parser", "FASTA 序列解析器")
    args = parser.parse_args()
    try:
        p = FastaParser()
        records = p.parse(args.input)
        for r in records:
            r["task_id"] = args.task_id
        write_output(make_ok(records), args.out)
    except Exception as e:
        write_output(make_error(f"FASTA 解析失败: {e}"), args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
