/**
 * Width of the right column (Changed files / File changes) inside the centre row. Each main tab keeps its own width:
 * the log needs a wide main island (`deepgit.ui.split.details`, px), Local changes needs a narrow list and a wide diff
 * (`deepgit.ui.split.details.changes`, px). The persisted value is clamped on every use, so an old or oversized value
 * never breaks the layout. On Local changes the column starts at its largest width each time the tab is opened (see
 * `columnWidth`); a width the user drags there only lasts until the tab is opened again and is never saved.
 */
export const MIN_DETAILS = 320;
/** The main island (log, changes) never gets narrower than this when the column is dragged. */
export const MIN_MAIN = 480;
/** The main island keeps at least this much when the column is maximized. */
export const MIN_MAIN_MAXIMIZED = 200;
/** Share of the centre row the column takes on the Log tab when the user has not dragged it. */
export const DEFAULT_DETAILS_RATIO = 0.42;
/** Share of the centre row the column takes on the Local changes tab after a double-click on the splitter (its default width). */
export const DEFAULT_CHANGES_DETAILS_RATIO = 0.6;

export type MainTabKey = "log" | "changes";

/** The Splitter `persistKey` of the right column for each main tab ("details" stays the Log key, so old values keep working). */
export function detailsPersistKey(tab: MainTabKey): string {
  return tab === "changes" ? "details.changes" : "details";
}

export function defaultRatio(tab: MainTabKey): number {
  return tab === "changes" ? DEFAULT_CHANGES_DETAILS_RATIO : DEFAULT_DETAILS_RATIO;
}

/** Largest width the user can drag the column to. */
export function maxDetails(rowW: number, splitter: number): number {
  return Math.max(MIN_DETAILS, rowW - MIN_MAIN - splitter);
}

export function defaultDetails(rowW: number, splitter: number, ratio = DEFAULT_DETAILS_RATIO): number {
  return clampDetails(Math.round(rowW * ratio), rowW, splitter, ratio);
}

/** `w` kept between the minimum and what the main island allows; a missing or bad value gives the default. */
export function clampDetails(w: number | null | undefined, rowW: number, splitter: number, ratio = DEFAULT_DETAILS_RATIO): number {
  const v = typeof w === "number" && Number.isFinite(w) ? w : Math.round(rowW * ratio);
  return Math.round(Math.min(Math.max(v, MIN_DETAILS), maxDetails(rowW, splitter)));
}

/** Width of the maximized column: most of the row, the main island keeps a strip (never narrower than the normal width). */
export function maximizedDetails(rowW: number, splitter: number): number {
  const strip = Math.max(MIN_MAIN_MAXIMIZED, Math.round(rowW * 0.15));
  return Math.max(MIN_DETAILS, rowW - splitter - strip);
}

export interface ColumnWidthInput {
  tab: MainTabKey;
  /** The user maximized the "File changes" tab. */
  maximized: boolean;
  /** Local changes shows the column at its largest width until the user moves the splitter. */
  fullOnChanges: boolean;
  /** Saved width of the tab (NaN or missing = never dragged). */
  stored: number | null | undefined;
  rowW: number;
  splitter: number;
}

/**
 * Width of the right column to draw. A maximized column wins (and is never narrower than the largest normal width); on Local changes, while `fullOnChanges` is set, the column
 * takes everything the main island can spare (the same limit as a drag, so the first drag from there does not jump and
 * the middle column keeps its minimum); otherwise the saved width, clamped.
 */
export function columnWidth(i: ColumnWidthInput): number {
  // Never narrower than the largest normal width: on a very wide row the maximized strip (15 %) is bigger than MIN_MAIN.
  if (i.maximized) return Math.max(maximizedDetails(i.rowW, i.splitter), maxDetails(i.rowW, i.splitter));
  if (i.tab === "changes" && i.fullOnChanges) return maxDetails(i.rowW, i.splitter);
  return clampDetails(i.stored, i.rowW, i.splitter, defaultRatio(i.tab));
}
