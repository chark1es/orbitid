import { customAlphabet } from "nanoid";
import { ID_PREFIX } from "@orbitid/shared";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 27);
/** `newId("user")` → `user_2AbC...` (use ID_PREFIX values from @orbitid/shared). */
export const newId = (prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX]) => `${prefix}_${nano()}`;
