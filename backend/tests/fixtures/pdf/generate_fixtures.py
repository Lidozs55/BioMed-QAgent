"""Regenerate the minimal PDF fixtures used by test_skill_extract_tables.py.

Run from this directory:

    python generate_fixtures.py

Both fixtures are hand-authored, single-page PDFs with exact xref offsets so
they parse with pdfplumber / pdfminer.six.  No external PDF library is needed
to generate them (the script only assembles bytes and computes offsets).

Fixtures:
    minimal_table.pdf  — one text block (title / authors / abstract / DOI)
                         plus a ruled 2-column table (Gene x FC) on page 1.
    scanned_image.pdf  — one page containing an image XObject and no text
                         layer (simulates a scanned / image-only PDF).
"""

from __future__ import annotations

from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent


def build_pdf(objects: list[bytes]) -> bytes:
    """Assemble objects into a minimal single-root PDF with a correct xref table."""
    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    obj_nums: list[int] = []
    for i, body in enumerate(objects):
        num = 1 + i
        obj_nums.append(num)
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode("latin-1")
        out += body
        out += b"\nendobj\n"
    xref_pos = len(out)
    max_obj = max(obj_nums)
    out += f"xref\n0 {max_obj + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for num in obj_nums:
        out += f"{offsets[num]:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {max_obj + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(out)


def minimal_table_pdf() -> bytes:
    """A ruled 2-column table (Gene x FC) with a text block above it."""
    lines = (
        b"1 w\n"
        b"72 660 m 300 660 l S\n"  # horizontal rules (4 rows)
        b"72 640 m 300 640 l S\n"
        b"72 620 m 300 620 l S\n"
        b"72 600 m 300 600 l S\n"
        b"72 660 m 72 600 l S\n"  # vertical rules (3 columns -> 2 cells)
        b"180 660 m 180 600 l S\n"
        b"300 660 m 300 600 l S\n"
    )
    content = b"".join([
        b"BT /F1 12 Tf 72 760 Td (Gene Expression Analysis in Cancer) Tj ET\n",
        b"BT /F1 12 Tf 72 746 Td (Smith, J., Doe, A.) Tj ET\n",
        b"BT /F1 12 Tf 72 732 Td (Abstract) Tj ET\n",
        b"BT /F1 12 Tf 72 718 Td "
        b"(This study analyzes gene expression patterns in cancer tissues.) Tj ET\n",
        b"BT /F1 12 Tf 72 704 Td (DOI: 10.1234/test.5678) Tj ET\n",
        b"q " + lines + b"Q\n",
        b"BT /F1 12 Tf 80 652 Td (Gene) Tj ET\n",
        b"BT /F1 12 Tf 190 652 Td (FC) Tj ET\n",
        b"BT /F1 12 Tf 80 632 Td (BRCA1) Tj ET\n",
        b"BT /F1 12 Tf 190 632 Td (1.5) Tj ET\n",
        b"BT /F1 12 Tf 80 612 Td (TP53) Tj ET\n",
        b"BT /F1 12 Tf 190 612 Td (2.0) Tj ET\n",
    ])
    return build_pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(content)} >>\nstream\n".encode("latin-1")
        + content
        + b"endstream",
    ])


def scanned_image_pdf() -> bytes:
    """A page with a 2x2 gray image XObject and no text layer."""
    img = bytes([0x80, 0x40, 0xC0, 0x20])
    content = b"q 72 700 200 200 re W n /Im1 Do Q\n"
    return build_pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        f"<< /Length {len(content)} >>\nstream\n".encode("latin-1")
        + content
        + b"endstream",
        (
            b"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 "
            b"/ColorSpace /DeviceGray /BitsPerComponent 8 /Length "
            + str(len(img)).encode("latin-1")
            + b" >>\nstream\n"
            + img
            + b"endstream"
        ),
    ])


def main() -> None:
    (OUT_DIR / "minimal_table.pdf").write_bytes(minimal_table_pdf())
    (OUT_DIR / "scanned_image.pdf").write_bytes(scanned_image_pdf())
    print("wrote minimal_table.pdf and scanned_image.pdf")


if __name__ == "__main__":
    main()
