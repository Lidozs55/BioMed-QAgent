# Family Host XLSX Carrier Parser

The registered-table Core parser supports Office Open XML `.xlsx` workbooks through
an explicitly promoted parser definition. A definition must declare the worksheet,
source-column order, target schema, media type, and the existing byte/row/column
limits.

The parser reads workbook bytes only after registered-asset SHA-256 and size
verification. It requires the named worksheet and exact header order, converts
cells through the existing schema field rules, records rejection audits, and
emits `SourceLocatorV2` cell locators. Workbook metadata or unselected worksheets
are not inferred as dataset semantics.

Legacy binary `.xls` is intentionally not accepted by the XLSX parser. It needs a
separate promoted parser implementation and media-type registration; an `.xls`
file must fail closed rather than be interpreted as `.xlsx`.
