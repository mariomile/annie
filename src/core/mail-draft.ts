import type { MailAttachment } from "./mail-attachments.ts";

/** A mail Owni asks to send or save as a draft (google-actions.ts), as the person approves it. */
export type MailDraft = {
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly body: string;
	/** Files of the workspace, as checked when asked: sent only if still the same (mail-attachments.ts). */
	readonly attachments?: readonly MailAttachment[];
	/** Answering a message: the reply stays in its Gmail thread; who and what it answers is on the card. */
	readonly inReplyTo?: {
		readonly id: string;
		readonly threadId: string;
		readonly messageId: string;
		readonly references: string;
		readonly from: string;
		readonly subject: string;
		readonly date: string;
		/** The sender asked for replies elsewhere (Reply-To): said on the card. */
		readonly replyToDiffers?: true;
	};
};
