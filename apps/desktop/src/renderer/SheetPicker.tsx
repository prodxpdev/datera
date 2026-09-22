import { useState } from 'react';

/**
 * Which sheets to connect from a workbook (#31).
 *
 * Connecting an .xlsx used to read the first sheet and say so in a detection panel most
 * people never open. For the commonest "I have a spreadsheet" case that is the whole
 * feature missing — and worse than missing, because a workbook's first tab is often a
 * summary, so the silent choice is frequently the wrong one.
 *
 * Every sheet is offered, all selected, in workbook order. Each becomes its own source,
 * because that is what a sheet is: a separate table that happens to share a file.
 */
export function SheetPicker({
  path,
  sheets,
  busy,
  onConnect,
  onSkip,
}: {
  readonly path: string;
  readonly sheets: readonly string[];
  readonly busy: boolean;
  readonly onConnect: (sheets: readonly string[]) => void;
  readonly onSkip: () => void;
}): JSX.Element {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(sheets));
  const fileName = path.split('/').pop() ?? path;

  const toggle = (sheet: string): void => {
    const next = new Set(chosen);
    if (next.has(sheet)) next.delete(sheet);
    else next.add(sheet);
    setChosen(next);
  };

  return (
    <div className="sheetpicker" data-sheetpicker={fileName}>
      <div className="frt">{fileName} has {sheets.length} sheets</div>
      <p>
        Each sheet becomes its own source, and they can be grouped into one dataset
        afterwards if they share a key. Nothing is copied — the file is read in place.
      </p>

      <div className="sheetlist">
        {sheets.map((sheet, i) => (
          <label className="sheetrow" key={sheet}>
            <input
              type="checkbox"
              data-sheet={sheet}
              checked={chosen.has(sheet)}
              onChange={() => toggle(sheet)}
            />
            <span className="sheetname">{sheet}</span>
            {/* Worth saying: it is the tab that would have been picked silently. */}
            {i === 0 && <span className="sheetnote">first tab</span>}
          </label>
        ))}
      </div>

      <div className="pickrow">
        <button
          className="btn p"
          data-connect-sheets
          disabled={busy || chosen.size === 0}
          onClick={() => onConnect(sheets.filter((s) => chosen.has(s)))}
        >
          Connect {chosen.size} sheet{chosen.size === 1 ? '' : 's'}
        </button>
        <button className="btn" data-skip-sheets disabled={busy} onClick={onSkip}>
          Skip this file
        </button>
      </div>
    </div>
  );
}
