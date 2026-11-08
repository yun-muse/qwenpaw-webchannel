/**
 * M45: inline SVG markup for the table toolbar.
 *
 * The markdown tables are decorated from `decorateMarkdown`, outside React, so
 * those buttons cannot render a lucide component. The path data below is
 * copied verbatim from lucide-react v1.62.0 (ISC — the project already depends
 * on it for every other icon) and uses the same 24 viewBox, `stroke-width: 2`
 * and round caps/joins, so the imperative toolbar and the React-rendered
 * message footer look like one set.
 */
const PATHS = {
  /** lucide `table` — the 结构化表格 label. */
  table:
    '<rect width="18" height="18" x="3" y="3" rx="2"/>' +
    '<path d="M12 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  /** lucide `clipboard-list` — copy the table's rows as Markdown. Distinct
   *  from the footer's `fileCode` (copy the whole message source) so the two
   *  never read as the same action when both bars are on screen. */
  clipboardList:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  /** lucide `file-code-corner` (alias `file-code-2`) — raw Markdown source. */
  fileCode:
    '<path d="M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35"/>' +
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"/>' +
    '<path d="m5 16-3 3 3 3"/><path d="m9 22 3-3-3-3"/>',
  /** lucide `file-spreadsheet` — Excel/TSV. */
  fileSpreadsheet:
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"/>' +
    '<path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
  /** lucide `check` — the copied feedback state. */
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;

export type GlyphName = keyof typeof PATHS;

export function glyphSvg(name: GlyphName, size = 16): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    `${PATHS[name]}</svg>`
  );
}
