// Geometry of the file panel's result columns. Shared by the rows (FileTree)
// and the header buttons (FilePanelHeaderButtons) so each filter button sits
// directly above the column it filters.

/** Least room the names get, even when no name has been measured yet. */
export const MIN_NAME_PX = 150;
/** Breathing room kept between the longest name and the first column. */
const NAME_GAP_PX = 8;
/** Approximate width of one digit at the columns' 10px font. */
const DIGIT_PX = 7;
/** A header button's width (13px icon + 4px padding a side). A column is never narrower. */
export const HEADER_BUTTON_PX = 21;

export interface ColumnLayout {
  annotation: boolean;
  buzzdetect: boolean;
  /** Total tracks in a folder. The first column to give way. */
  total: boolean;
  /** Width of each column, in px. */
  widthPx: number;
}

/**
 * Which columns fit in a list `listWidth` px wide, given the biggest number one
 * will hold. Names always win: `nameNeededPx` is how far right the longest
 * visible name reaches from the list's left edge, and a column only appears if
 * it fits beside that without shortening any name. Columns give way from the
 * right: total, then buzzdetect, then annotation.
 */
export function columnLayout(
  listWidth: number,
  maxCount: number,
  hasBuzzdetect: boolean,
  nameNeededPx = 0,
): ColumnLayout {
  const nameRoom = Math.max(MIN_NAME_PX, nameNeededPx + NAME_GAP_PX);
  const widthPx = Math.max(HEADER_BUTTON_PX, (String(maxCount).length + 1) * DIGIT_PX);
  const buzzdetectColumns = hasBuzzdetect ? 1 : 0;
  return {
    widthPx,
    annotation: listWidth >= nameRoom + widthPx,
    buzzdetect: hasBuzzdetect && listWidth >= nameRoom + 2 * widthPx,
    total: listWidth >= nameRoom + (2 + buzzdetectColumns) * widthPx,
  };
}
