/**
 * Sheet names from an .xlsx workbook (#31).
 *
 * DuckDB's excel extension can read a named sheet but cannot list them: there is no
 * `xlsx_sheets()` function, and a wrong name yields a Binder Error with a single fuzzy
 * "did you mean" suggestion rather than the set. So the names come from the file itself.
 *
 * An .xlsx is a zip, and `xl/workbook.xml` names every sheet in workbook order. Reading
 * the entry is a host job — it needs inflate — so the core parses and the host
 * decompresses, which is the same split as everywhere else.
 */

/**
 * Pull sheet names out of `xl/workbook.xml`.
 *
 * Deliberately a narrow scan rather than an XML parser. The file has one shape, the
 * attribute is always `name`, and shipping a parser to read one attribute out of one
 * known document would be more code to be wrong in — not less.
 *
 * Order matters: `read_xlsx` with no sheet reads the first, so the list has to say which
 * that is.
 */
export function sheetNamesFrom(workbookXml: string): readonly string[] {
  const names: string[] = [];

  // <sheet name="Q3 Summary" sheetId="3" r:id="rId3"/> — attribute order varies between
  // producers, so the name is matched on its own rather than by position.
  for (const element of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname\s*=\s*"([^"]*)"/.exec(element[0])?.[1];
    if (name !== undefined) names.push(decodeXmlEntities(name));
  }

  return names;
}

/**
 * The five entities XML predefines, plus numeric references.
 *
 * A sheet legitimately called `R&D` is stored as `R&amp;D`, and handing that back would
 * produce a name `read_xlsx` rejects — the one thing this function must not do.
 */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last: decoding it first would let `&amp;lt;` become `<`.
    .replace(/&amp;/g, '&');
}
