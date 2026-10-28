/** First row of a query result, or undefined when the query matched nothing. */
export const first = <T>(rows: readonly T[]): T | undefined => rows[0];
