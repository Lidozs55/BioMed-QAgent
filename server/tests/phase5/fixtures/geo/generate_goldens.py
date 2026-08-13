"""One-off golden generator for the Phase 5 GEO port (P5-04).

Runs the Python reference implementations against deterministic fixtures and
dumps golden JSON consumed by ``server/tests/phase5/geo-*.test.ts``.  Run from
``backend/``:

    ./.venv/Scripts/python.exe ../server/tests/phase5/fixtures/geo/generate_goldens.py

Outputs land next to this script.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[5] / "backend"))

from app.datasets.build.adapters import get_adapter  # noqa: E402
from app.datasets.build.geo_sample_metadata import (  # noqa: E402
    parse_geo_soft_samples,
)
from app.datasets.build.probe_mapping import (  # noqa: E402
    build_probe_mapping,
    parse_platform_table,
)
from app.datasets.contracts import AdapterParams, ValueScale  # noqa: E402
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256  # noqa: E402
from app.integrations.ncbi.parsers import (  # noqa: E402
    parse_geo_esearch,
    parse_geo_esummary,
    resolve_geo_supplementary_assets,
)

OUT = Path(__file__).parent


def dump(name: str, value: object) -> None:
    (OUT / name).write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def write_gzip(name: str, text: str) -> Path:
    path = OUT / name
    path.write_bytes(gzip.compress(text.encode("utf-8"), mtime=0))
    return path


def asset_for(path: Path, source_id: str = "src_geo") -> SourceAsset:
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{path.name}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


ADAPTER = get_adapter("geo.expression.v1")

SERIES_MATRIX = (
    '!Series_title = "Test series"\n'
    '!Sample_geo_accession\t"GSM1"\t"GSM2"\n'
    '!Sample_title\t"Tumor P1"\t"Normal P1"\n'
    '!Sample_platform_id\t"GPL570"\t"GPL570"\n'
    '!Sample_characteristics_ch1\t"tissue type: tumor"\t"tissue type: normal"\n'
    '!Sample_characteristics_ch1\t"patient id: P1"\t"patient id: P1"\n'
    '!series_matrix_table_begin\n'
    '"ID_REF"\t"GSM1"\t"GSM2"\n'
    '"AFFX-BioB-5"\t1.5\t2.0\n'
    '"1007_s_at"\t3.0\t4.0\n'
    '"ENSG00000141510"\t5.0\t6.0\n'
    '!series_matrix_table_end\n'
)

METADATA_ONLY_MATRIX = (
    '!Series_title = "metadata only"\n'
    '!Sample_geo_accession = "GSM1"\n'
)

SUPPLEMENTARY_CSV = (
    "probe_id,S1,S2\n"
    "AFFX-BioB-5,1.5,2.0\n"
    "1007_s_at,3.0,4.0\n"
)

GPL570_ANNOT = (
    '!platform_table_begin\n'
    '"ID"\t"GENE_SYMBOL"\n'
    '"PROBE1"\t"TP53"\n'
    '"PROBE2"\t"---"\n'
    '"PROBE3"\t"BRCA1"\n'
    '!platform_table_end\n'
)

GPL570_ANNOT_ENSEMBL = (
    '!platform_table_begin\n'
    '"ID"\t"ENSEMBL_ID"\n'
    '"PROBE1"\t"ENSG00000141510"\n'
    '!platform_table_end\n'
)

GPL1_NO_GENE = (
    '!platform_table_begin\n'
    '"ID"\t"DESCRIPTION"\n'
    '"PROBE1"\t"x"\n'
    '!platform_table_end\n'
)


def run_adapter(path: Path, params: AdapterParams) -> dict:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        batch = ADAPTER.parse(
            asset_for(path),
            path,
            build_id="build_geo",
            binding_id="binding_geo",
            schema_ref="gene_expression.probe_long.v1",
            output_dir=Path(tmp),
            parameters=params,
        )
        long_rows = list(
            csv.DictReader(
                (Path(tmp) / batch.file_asset.relative_path).open(
                    encoding="utf-8", newline=""
                )
            )
        )
        rejected_rows = list(
            csv.DictReader(
                (Path(tmp) / "batches" / "binding_geo_rejected.csv").open(
                    encoding="utf-8", newline=""
                )
            )
        )
        sample_metadata_csv = ""
        support_path = Path(tmp) / "supporting" / "binding_geo_sample_metadata.csv"
        if support_path.is_file():
            sample_metadata_csv = support_path.read_text(encoding="utf-8")
        return {
            "row_count": batch.row_count,
            "statistics": batch.statistics,
            "warnings": batch.warnings,
            "mappings": [m.model_dump(mode="json") for m in batch.declared_mappings],
            "long_rows": long_rows,
            "rejected_rows": rejected_rows,
            "sample_metadata_csv": sample_metadata_csv,
        }


def main() -> None:
    # Copy the ncbi fixture tree (idempotent).
    ncbi = OUT.parents[4] / "backend" / "tests" / "fixtures" / "ncbi" / "gse178352"
    for name in (
        "geo_esearch.json",
        "geo_esummary.json",
        "geo_suppl_listing.html",
        "gse178352_family.soft.gz",
        "tximport_counts_slice.tsv",
        "manifest.json",
    ):
        shutil.copy(ncbi / name, OUT / name)

    # Discovery parser goldens.
    dump(
        "geo_esearch_page.golden.json",
        parse_geo_esearch((OUT / "geo_esearch.json").read_bytes()).model_dump(
            mode="json"
        ),
    )
    dump(
        "geo_esummary_records.golden.json",
        [
            record.model_dump(mode="json")
            for record in parse_geo_esummary((OUT / "geo_esummary.json").read_bytes())
        ],
    )
    dump(
        "geo_suppl_assets.golden.json",
        [
            asset.model_dump(mode="json")
            for asset in resolve_geo_supplementary_assets(
                (OUT / "geo_suppl_listing.html").read_bytes(),
                "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/"
                "GSE178352/suppl/",
            )
        ],
    )

    # SOFT sample metadata golden (real GSE178352 family SOFT fixture).
    with gzip.open(OUT / "gse178352_family.soft.gz", "rt", encoding="utf-8") as handle:
        samples, warnings = parse_geo_soft_samples(handle)
    dump(
        "geo_soft_samples.golden.json",
        {
            "samples": [sample.model_dump(mode="json") for sample in samples],
            "warnings": warnings,
        },
    )

    # Expression adapter goldens.
    series_path = write_gzip("geo_series_matrix.txt.gz", SERIES_MATRIX)
    write_gzip("geo_metadata_only_matrix.txt.gz", METADATA_ONLY_MATRIX)
    (OUT / "geo_supplementary_counts.csv").write_text(
        SUPPLEMENTARY_CSV, encoding="utf-8"
    )
    dump(
        "geo_series_matrix_batch.golden.json",
        run_adapter(
            series_path,
            AdapterParams(
                format="series_matrix",
                value_semantics="normalized_expression_value",
                value_scale=ValueScale.LOG2,
                expression_unit="normalized_expression_value",
                is_normalized=True,
                platform_ids=[],
                delimiter="auto",
            ),
        ),
    )
    dump(
        "geo_tximport_batch.golden.json",
        run_adapter(
            OUT / "tximport_counts_slice.tsv",
            AdapterParams(
                format="tximport_counts",
                value_semantics="estimated_count",
                value_scale=ValueScale.LINEAR,
                expression_unit="estimated_count",
                is_normalized=False,
                platform_ids=[],
                delimiter="auto",
            ),
        ),
    )
    dump(
        "geo_supplementary_batch.golden.json",
        run_adapter(
            OUT / "geo_supplementary_counts.csv",
            AdapterParams(
                format="supplementary_matrix",
                value_semantics="raw_count",
                value_scale=ValueScale.LINEAR,
                expression_unit="counts",
                is_normalized=False,
                platform_ids=[],
                delimiter="auto",
            ),
        ),
    )

    # Probe-mapping goldens.
    annot = write_gzip("gpl570_annot.txt.gz", GPL570_ANNOT)
    write_gzip("gpl570_annot_ensembl.txt.gz", GPL570_ANNOT_ENSEMBL)
    write_gzip("gpl1_no_gene_annot.txt.gz", GPL1_NO_GENE)
    mapping, target_namespace, status, ambiguous, probe_column, gene_column = (
        parse_platform_table(annot)
    )
    dump(
        "geo_platform_table.golden.json",
        {
            "mapping": mapping,
            "target_namespace": target_namespace,
            "status": status.value,
            "ambiguous": sorted(ambiguous),
            "probe_column": probe_column,
            "gene_column": gene_column,
        },
    )
    ensembl_result = parse_platform_table(
        OUT / "gpl570_annot_ensembl.txt.gz"
    )
    dump(
        "geo_platform_table_ensembl.golden.json",
        {
            "mapping": ensembl_result[0],
            "target_namespace": ensembl_result[1],
            "status": ensembl_result[2].value,
            "ambiguous": sorted(ensembl_result[3]),
            "probe_column": ensembl_result[4],
            "gene_column": ensembl_result[5],
        },
    )
    no_gene_result = parse_platform_table(OUT / "gpl1_no_gene_annot.txt.gz")
    dump(
        "geo_platform_table_no_gene.golden.json",
        {
            "mapping": no_gene_result[0],
            "target_namespace": no_gene_result[1],
            "status": no_gene_result[2].value,
            "ambiguous": sorted(no_gene_result[3]),
            "probe_column": no_gene_result[4],
            "gene_column": no_gene_result[5],
        },
    )

    # Build a source-long batch for probe mapping, then run build_probe_mapping.
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        rows = []
        for probe in ("PROBE1", "PROBE2", "PROBE3", "UNKNOWN1"):
            rows.append(
                "b1,gse,src,asset,"
                f"{probe},geo_probe,GSM1,expression,expression_value,"
                "log2,normalized_expression_value,1,1.5,log2_expression,"
                "f.txt,3,2,S1,1.5"
            )
        batch_path = tmp_path / "batch.csv"
        batch_path.write_text(
            "record_id,dataset_id,source_id,asset_id,gene_id_raw,"
            "gene_id_namespace_declared,sample_id,measurement_type,value_semantics,"
            "value_scale,expression_unit,is_normalized,is_integer_expected,"
            "expression_value,source_logical_file,source_line_number,"
            "source_column_index,source_column_name,source_raw_value\n"
            + "\n".join(rows)
            + "\n",
            encoding="utf-8",
        )
        result = build_probe_mapping(
            annotation_path=annot,
            batch_path=batch_path,
            binding_id="binding_geo",
            platform_id="GPL570",
            annotation_asset=asset_for(annot, source_id="src_annotation"),
            output_dir=tmp_path,
            source_id="src_annotation",
        )
        dump(
            "geo_probe_mapping.golden.json",
            {
                "probe_to_gene": result.probe_to_gene,
                "target_namespace": result.target_namespace,
                "summary": result.summary.model_dump(mode="json"),
                "detail_csv": result.detail_path.read_text(encoding="utf-8"),
            },
        )
        # SHA mismatch behavior is asserted structurally in the TS tests.
        wrong_sha = hashlib.sha256(b"some other file contents").hexdigest()
        bad_asset = SourceAsset(
            asset_id=asset_id_from_sha256(wrong_sha),
            kind="source",
            relative_path="source_assets/GPL570_annot.txt.gz",
            sha256=wrong_sha,
            size_bytes=annot.stat().st_size,
            media_type="text/tab-separated-values",
            source_id="src_annotation",
            successful_attempt_id="attempt_1",
            data_level=DataLevel.REPOSITORY_PROCESSED,
        )
        dump(
            "geo_probe_mapping_asset.golden.json",
            {
                "asset": bad_asset.model_dump(mode="json"),
                "actual_sha256": hashlib.sha256(annot.read_bytes()).hexdigest(),
            },
        )

    print("goldens written to", OUT)


if __name__ == "__main__":
    main()
