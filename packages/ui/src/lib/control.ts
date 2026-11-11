/**
 * The one place a control's single-line label is optically centred.
 *
 * Hanken Grotesk's cap height sits slightly high inside its line box, which makes a label look
 * a pixel above the centre of a fixed-height button, chip or tab. Trimming the text box to the
 * cap and alphabetic edges removes that asymmetry, so every control can rely on plain
 * `items-center` instead of a hand-tuned `translate-y` at the call site.
 */
export const CONTROL_LABEL = "leading-none control-optical"

/** Flex recipe shared by every button-like control, icon-only or icon + label. */
export const CONTROL_CENTER = "inline-flex items-center justify-center"

/** The complete recipe a fixed-height button-like control must carry. */
export const CONTROL_RECIPE = `${CONTROL_CENTER} ${CONTROL_LABEL}`
