import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** How the control plane sends the sign-in links. The real service is still to choose. */
export interface Mailer {
	send(mail: Mail): Promise<void>;
}

export type Mail = { readonly to: string; readonly subject: string; readonly text: string };

/** Keeps mails in memory: tests. */
export class MemoryMailer implements Mailer {
	readonly sent: Mail[] = [];
	async send(mail: Mail): Promise<void> {
		this.sent.push(mail);
	}
}

/** Appends mails to a file the operator reads: development, before a mail service is chosen. */
export class FileMailer implements Mailer {
	constructor(private readonly dir: string) {}
	async send(mail: Mail): Promise<void> {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		appendFileSync(join(this.dir, "outbox.txt"), `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n\n----\n`, { mode: 0o600 });
	}
}
