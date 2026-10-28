// Body coercion so the same schemas accept JSON and urlencoded forms.
import { z } from "zod";

/** Accepts JSON booleans and form values `true/false/1/0`. */
export const zBool = z.preprocess((value) => {
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return value;
}, z.boolean());

/** Metadata object, accepting a JSON-encoded string when submitted as a form field. */
export const zMetadata = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, z.record(z.string(), z.unknown()));
