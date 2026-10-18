/** Who did something, and when (ISO): shared by the paid marks (invoices.ts) and the reminders (reminder-book.ts). */
export type Marker = { readonly by: string; readonly at: string };
