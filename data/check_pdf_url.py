import json
with open(r"d:\Code\BioMedQAgent\data\output\Te51dd48e\raw_records.json", "r", encoding="utf-8") as f:
    records = json.load(f)
print(f"Total records: {len(records)}")
has_pdf = 0
for r in records[:5]:
    fields = r.get("fields", {})
    print(f"  fields keys: {list(fields.keys())[:10]}")
    print(f"  pdf_url: {fields.get('pdf_url', '<missing>')}")
    print(f"  best_oa_location: {fields.get('best_oa_location', '<missing>')}")
    if fields.get("pdf_url"):
        has_pdf += 1
print(f"\nRecords with pdf_url: {has_pdf}")
print(f"Total with pdf_url: {sum(1 for r in records if r.get('fields', {}).get('pdf_url'))}")
