/**
 * GEO platform annotation discovery (P5-04; Python
 * ``app/pipeline/processing/geo_annotation.py`` parity, discovery parts).
 *
 * NCBI stores platform annotation tables under
 * ``https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL{prefix}nnn/{gpl}/suppl/``
 * (Agilent-style ``{gpl}_*.txt.gz``) or ``.../annot/{gpl}.annot.gz``
 * (Affymetrix-style).  ``geoPlatformDir`` implements the GPL-prefix rule;
 * ``discoverAnnotationFile`` locates the file across both layouts.
 */

import type { PublicHttpClient } from "../network/http-client.js";

export const GEO_PLATFORM_FTP_ROOT = "https://ftp.ncbi.nlm.nih.gov/geo/platforms";

/**
 * Python ``geo_platform_dir``: GPL570 -> ``GPLnnn``, GPL4133 -> ``GPL4nnn``,
 * GPL19072 -> ``GPL19nnn``.
 */
export function geoPlatformDir(gpl: string): string {
  const digits = gpl.slice(3);
  const prefix = digits.length <= 3 ? "nnn" : `${digits.slice(0, -3)}nnn`;
  return `GPL${prefix}`;
}

function listingUrl(gpl: string, subdir: string): string {
  return `${GEO_PLATFORM_FTP_ROOT}/${geoPlatformDir(gpl)}/${gpl}/${subdir}/`;
}

/** Python ``_list_directory``: href scan of an NCBI FTP HTML listing. */
async function listDirectory(
  client: PublicHttpClient,
  url: string,
): Promise<string[]> {
  let response;
  try {
    response = await client.request(url);
  } catch {
    return [];
  }
  if (response.status !== 200) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const names: string[] = [];
  for (const match of text.matchAll(/href="([^"]+)"/g)) {
    const name = match[1];
    if (name.startsWith("/") || name === "Parent Directory") continue;
    names.push(name);
  }
  return names;
}

/** Python ``discover_annotation_file``: ``(subdir, filename)`` or null. */
export async function discoverAnnotationFile(
  client: PublicHttpClient,
  gpl: string,
): Promise<{ subdir: string; filename: string } | null> {
  const layouts: Array<{ subdir: string; pattern: RegExp }> = [
    { subdir: "suppl", pattern: new RegExp(`^${gpl}_[^/]*\\.txt\\.gz$`, "i") },
    { subdir: "annot", pattern: new RegExp(`^${gpl}\\.annot\\.gz$`, "i") },
  ];
  for (const { subdir, pattern } of layouts) {
    for (const name of await listDirectory(client, listingUrl(gpl, subdir))) {
      if (pattern.test(name)) return { subdir, filename: name };
    }
  }
  return null;
}
