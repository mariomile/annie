/**
 * Checks of the fields a store reads back (quotes.json, expenses.json): text of a bounded length
 * without control characters, and who did something and when (a Marker). What fails them makes
 * the store unreadable, so nothing is ever written over a file that was changed by hand.
 */
import type { Marker } from "./marker.ts";
import { hasControlChars } from "./plain-text.ts";

/** Text of 1 to `max` characters, without control characters (newlines allowed). */
export const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !hasControlChars(v);

/** Missing, or isText. */
export const optText = (v: unknown, max: number): boolean => v === undefined || isText(v, max);

/** Who (at most 200 characters) and when (at most 40). */
export const isMarker = (v: unknown): v is Marker => typeof v === "object" && v !== null && isText((v as Marker).by, 200) && isText((v as Marker).at, 40);
