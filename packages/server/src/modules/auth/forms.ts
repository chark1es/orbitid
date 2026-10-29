// Body coercion so the same schemas accept JSON and urlencoded forms.
import { z } from "zod";
import { isMaskedSecret } from "../../lib/secrets";

/** Accepts JSON booleans and form values `true/false/1/0`. */
export const zBool = z.preprocess((value) => {
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return value;
}, z.boolean());

/** A metadata value: bounded depth and size, so a client cannot store an arbitrarily large blob. */
const metadataValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(metadataValue).max(100),
    z.record(z.string().max(256), metadataValue),
  ]),
);

const metadataObject = z.record(z.string().max(256), metadataValue).refine(
  (value) => Object.keys(value).length <= 100,
  { message: "metadata may contain at most 100 keys" },
).refine(
  (value) => {
    try {
      return JSON.stringify(value).length <= 16 * 1024;
    } catch {
      return false;
    }
  },
  { message: "metadata must serialize to at most 16 KB" },
);

const decodeMetadata = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/** Metadata object, accepting a JSON-encoded string when submitted as a form field. */
export const zMetadata = z.preprocess(decodeMetadata, metadataObject);

/**
 * A settings secret that arrived back from an editor. The mask means "unchanged" and is dropped before
 * validation; any other value is a real replacement.
 */
export const zSecret = z.preprocess((value) => (isMaskedSecret(value) ? undefined : value), z.string().max(8192).optional());
