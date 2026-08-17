/**
 * Shared XML sanity check for the publication tiers (deduplicated from
 * ``europe-pmc.ts`` and ``publication-fallback.ts``; Python
 * ``bytes.lstrip + startswith(b"<")`` parity).
 */

const LSTRIP_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** Python ``fetch_full_text_xml`` XML sanity check (bytes.lstrip + "<"). */
export function looksLikeXml(head: Buffer): boolean {
  let index = 0;
  while (index < head.length && LSTRIP_WHITESPACE.has(head[index] ?? 0)) index++;
  return head[index] === 0x3c;
}