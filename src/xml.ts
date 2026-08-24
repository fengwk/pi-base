/** Escape a string for safe insertion into an XML text node or quoted attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const XML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
} as const;

/** Decode one layer of entities produced by escapeXml. */
export function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (match, name: string) => (
    XML_ENTITIES[name as keyof typeof XML_ENTITIES] ?? match
  ));
}
