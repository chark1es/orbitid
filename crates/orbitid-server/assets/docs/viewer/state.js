/*
 * Shared viewer state.
 *
 * Exported as one object rather than individual bindings so every module reads the same spec and base URL after the
 * fetch in `viewer.js` resolves.
 */
export const state = { spec: null, query: "", baseUrl: "" };
