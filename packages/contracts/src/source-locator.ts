export type SourceLocatorV2Type = "json_pointer" | "xml_cell" | "pdf_region" | "image_bbox";

export interface SourceLocatorV2Base {
  locator_version: "2.0";
  locator_type: SourceLocatorV2Type;
  asset_id: string;
  logical_file: string;
  raw_value: string;
}

export interface JsonPointerSourceLocator extends SourceLocatorV2Base {
  locator_type: "json_pointer";
  json_pointer: string;
}

export interface XmlCellSourceLocator extends SourceLocatorV2Base {
  locator_type: "xml_cell";
  xml_path: string;
  table_id: string;
  row_index: number;
  column_index: number;
}

export interface PdfRegionSourceLocator extends SourceLocatorV2Base {
  locator_type: "pdf_region";
  page_number: number;
  table_id: string | null;
  figure_id: string | null;
  row_label: string | null;
  column_label: string | null;
}

export interface ImageBBoxSourceLocator extends SourceLocatorV2Base {
  locator_type: "image_bbox";
  page_number: number | null;
  figure_id: string | null;
  bbox: [number, number, number, number];
}

export type SourceLocatorV2 =
  | JsonPointerSourceLocator
  | XmlCellSourceLocator
  | PdfRegionSourceLocator
  | ImageBBoxSourceLocator;
