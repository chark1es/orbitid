/** Recorded side effects shared by the `vi.mock`ed mail/webhook services. */
export interface RecordedEmail {
  to: string;
  template: string;
  vars: Record<string, string | number | undefined>;
}

export const mailOutbox: RecordedEmail[] = [];
export const events: { type: string; data: unknown }[] = [];
