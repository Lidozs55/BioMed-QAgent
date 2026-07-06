#!/usr/bin/env python3
"""pdb_parser.py — PDB 蛋白质结构解析器。

用途：把 PDB 格式文件（.pdb / .ent）解析成单个 DataRecord。

输入格式：
    标准 PDB 文本，按固定列解析以下记录：
      HEADER  —— 分类 / 沉积日期 / PDB ID
      TITLE   —— 标题（可跨多行）
      EXPDTA  —— 实验方法
      REMARK 2 —— 分辨率
      SEQRES  —— 序列（按链，三字母氨基酸）
      ATOM / HETATM —— 原子坐标（用于计数 / 链 / 配体）

输出格式：
    一个 record，fields 含：
      pdb_id, title, resolution, deposition_date, experimental_method,
      atoms_count, chains (list), ligands (list of HETATM 残基名),
      sequence (SEQRES 拼接的单字母序列), entity_type。

示例：
    python pdb_parser.py --input 1aki.pdb --out result.json

依赖：仅标准库（不依赖 Biopython）。
"""
import sys

from _base import (BaseParser, make_record, setup_cli,
                   make_ok, make_error, write_output)

# 三字母氨基酸 -> 单字母
AA3TO1 = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
    "MSE": "M", "SEC": "U", "PYL": "O",
}


class PdbParser(BaseParser):
    """纯 Python PDB 解析器，按固定列读取常见记录。"""

    source_name = "pdb"

    def parse(self, file_path):
        pdb_id = ""
        title_parts = []
        resolution = None
        deposition_date = ""
        experimental_method = ""
        atoms_count = 0
        chains = set()
        ligands = set()
        seqres = {}  # chain_id -> [三字母残基]

        with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                rec_name = line[:6].strip()
                if rec_name == "HEADER":
                    deposition_date = line[50:59].strip()
                    pdb_id = line[62:66].strip().lower()
                elif rec_name == "TITLE":
                    title_parts.append(line[10:].rstrip())
                elif rec_name == "EXPDTA":
                    experimental_method = line[10:].strip()
                elif rec_name == "REMARK":
                    if line[7:10].strip() == "2":
                        content = line[11:].strip()
                        if content.upper().startswith("RESOLUTION"):
                            for tok in content.split():
                                try:
                                    resolution = float(tok.rstrip("."))
                                    break
                                except ValueError:
                                    continue
                elif rec_name == "SEQRES":
                    chain = line[11].strip()
                    if chain:
                        chains.add(chain)
                        seqres.setdefault(chain, []).extend(line[19:].split())
                elif rec_name in ("ATOM", "HETATM"):
                    atoms_count += 1
                    chain = line[21].strip()
                    if chain:
                        chains.add(chain)
                    if rec_name == "HETATM":
                        res_name = line[17:20].strip()
                        if res_name and res_name != "HOH":
                            ligands.add(res_name)

        # SEQRES 拼接成单字母序列
        sequence = "".join(
            AA3TO1.get(r.upper(), "X")
            for residues in seqres.values() for r in residues
        )
        title = " ".join(t.strip() for t in title_parts if t.strip()).strip()

        fields = {
            "pdb_id": pdb_id,
            "title": title,
            "resolution": resolution,
            "deposition_date": deposition_date,
            "experimental_method": experimental_method,
            "atoms_count": atoms_count,
            "chains": sorted(chains),
            "ligands": sorted(ligands),
            "sequence": sequence,
            "entity_type": "Structure",
        }
        accession = pdb_id if pdb_id else None
        return [make_record(
            task_id="", source_name=self.source_name,
            fields=fields, file_path=file_path,
            confidence=0.95, method="table",
            accession=accession, source_type="file")]


def main():
    parser = setup_cli("pdb_parser", "PDB 蛋白质结构解析器")
    args = parser.parse_args()
    try:
        p = PdbParser()
        records = p.parse(args.input)
        for r in records:
            r["task_id"] = args.task_id
        write_output(make_ok(records), args.out)
    except Exception as e:
        write_output(make_error(f"PDB 解析失败: {e}"), args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
