import { shortPraticaId, type Pratica } from "../core/practice.ts";

export const BUTTONS = ["Approva", "Modifica", "Scarta"] as const;

export function formatReceivedAt(iso: string): string {
	const d = new Date(iso);
	return new Intl.DateTimeFormat("it-IT", {
		timeZone: "Europe/Rome",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(d);
}

export function newRequestNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	const lead = pratica.lead;
	const name = lead.fullName ?? lead.company ?? "sconosciuto";
	const email = lead.email ?? "(nessuna email)";
	return `Nuova richiesta di preventivo · Pratica #${id}

Da: ${name} <${email}>
Oggetto: ${lead.rawSubject}
Ricevuta: ${formatReceivedAt(lead.receivedAt)}

Riassunto: ${lead.rawSnippet || lead.productOrService || "richiesta di preventivo"}.

Lead aggiornato nel CRM: ${lead.fullName ?? "—"} · ${lead.company ?? "—"} (${pratica.crmLeadId ? "aggiornato" : "nuovo contatto"}).`;
}

export function leadCardAndDraft(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	const lead = pratica.lead;
	const missing = pratica.missingFields.length > 0 ? pratica.missingFields.join(", ") : "—";
	return `Scheda lead · Pratica #${id}

Nome: ${lead.fullName ?? "—"}
Azienda: ${lead.company ?? "—"}
Email: ${lead.email ?? "—"}
Telefono: ${lead.phone ?? "—"}
Prodotto/servizio: ${lead.productOrService ?? "—"}
Urgenza: ${lead.urgency ?? "—"}
Dati mancanti: ${missing}
Note: ${lead.notes ?? "—"}

- Bozza v${pratica.draftVersion} (lei) -

Oggetto: ${pratica.draftSubject}

${pratica.draftBody}

- Fine bozza -`;
}

export function sendingNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Invio in corso · Pratica #${id}
Bozza v${pratica.draftVersion} approvata da te. Sto inviando la mail a ${pratica.lead.email}.`;
}

export function sentNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Inviata · Pratica #${id}

A: ${pratica.lead.fullName ?? ""} <${pratica.lead.email}>
Oggetto: ${pratica.draftSubject}
Ora: ${formatReceivedAt(pratica.approvedAt ?? new Date().toISOString())}
CRM: esito «risposta inviata» registrato sul lead.`;
}

export function alreadyClosed(status: string): string {
	return `Questa pratica è già chiusa (${status === "sent" ? "inviata" : status}). Non posso cambiare l'esito da qui.`;
}

export function editPrompt(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Modifica · Pratica #${id}

Scrivi qui sotto come vuoi cambiare la bozza (tono, contenuti, dati mancanti). Puoi anche incollare il testo intero da usare al posto della bozza.
Per annullare senza cambiare nulla, scrivi: annulla modifica`;
}

export function discardedNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Scartata · Pratica #${id}

Nessuna mail è stata inviata. Sul CRM il lead resta aperto con esito «scartata da commerciale».
Se era un errore, crea una nuova pratica dalla mail originale (non si «riapre» questa).`;
}

export function crmDownNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Attenzione · Pratica #${id}

Non sono riuscita ad aggiornare il CRM (timeout). La bozza è comunque pronta qui sotto. Puoi Approvare: riproverò il CRM dopo l'invio. Se preferisci aspettare, tocca Scarta e riprova più tardi.`;
}

export function sendFailedNotice(pratica: Pratica, reason: string): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Invio non riuscito · Pratica #${id}

Il provider mail ha rifiutato l'invio (${reason}). Nessuna mail è partita.
Quando il problema è risolto, tocca Approva per ritentare l'invio della stessa bozza. Oppure Modifica o Scarta.`;
}

export function crashAfterApproveNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Invio non completato · Pratica #${id}

Il processo si è interrotto prima della conferma di invio. Nessuna mail risulta inviata.
Tocca Approva per ritentare l'invio della bozza v${pratica.draftVersion}, oppure Modifica o Scarta.`;
}

export function spamNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Mail in arrivo · probabilmente spam · Pratica #${id}

Da: ${pratica.lead.email ?? "sconosciuto"}
Oggetto: ${pratica.lead.rawSubject}
Classificazione: spam. Nessun lead nel CRM.

Tocca Scarta per archiviare. Tocca Approva se vuoi forzarla come richiesta di preventivo (partirà l'estrazione e la bozza).`;
}

export function nonCommercialeNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	const name = pratica.lead.fullName ?? "";
	const email = pratica.lead.email ?? "";
	const da = name && email ? `${name} <${email}>` : email || name || "sconosciuto";
	return `Mail in arrivo · non commerciale · #${id}

Da: ${da}
Oggetto: ${pratica.lead.rawSubject}
Classificazione: non_commerciale (non è spam). Nessun lead, nessuna bozza.`;
}

export function invalidSenderNotice(pratica: Pratica): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Avviso · mittente non valido · #${id}

Ho ricevuto una mail senza indirizzo mittente utilizzabile (From vuoto o non valido).
Nessun lead è stato creato nel CRM. Nessuna bozza. Controlla la casella a mano se serve.`;
}

export function threadNewRequestNotice(pratica: Pratica, fromName: string): string {
	const id = shortPraticaId(pratica.praticaId);
	return `Nuova richiesta sul thread · Pratica #${id} (già inviata)

Da: ${fromName}
Oggetto: ${pratica.lead.rawSubject}
Ha aggiunto prodotti alla richiesta. Ho aggiornato lo stesso lead nel CRM e preparato una nuova bozza (v${pratica.draftVersion}).`;
}

export function duplicateNotifyLine(): string {
	return `Possibile doppione di notifica: ignora se hai già risposto.`;
}
