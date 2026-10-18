/**
 * I clienti's own state, in `clients.json` of an instance (outside the workspace): the cards, the
 * next card and ricontatto numbers, and the ids of the calls that wrote (a call run again writes
 * nothing twice). Changed under the shared file lock through json-book.ts, with the copy
 * `clients.json.bak`. Read never throws: a file that does not read is `broken`, and nothing is
 * written over it. A card removed is gone from both files at the next write.
 */
import { join } from "node:path";
import { CARD_ID, CLIENT_LIMITS, type ClientCard, ClientError, FOLLOW_UP_ID, validCall, validCard } from "./clients.ts";
import { type BookFile, readBook, updateBook } from "./json-book.ts";
import { spellingKey } from "./name-keys.ts";

/** What a change works on: the cards and the next numbers to give. */
export type ClientState = { readonly nextCard: number; readonly nextFollowUp: number; readonly cards: readonly ClientCard[] };

type Book = ClientState & { readonly calls: readonly string[] };

export type ClientBook = ClientState & { readonly calls: readonly string[]; readonly broken: boolean };

export const CLIENTS_BROKEN = "le schede dei clienti (clients.json) non si leggono: non le cambio, perché andrebbero perse. Va sistemato o tolto il file dalla cartella dell'agente";

const EMPTY: Book = { nextCard: 1, nextFollowUp: 1, cards: [], calls: [] };

export class ClientStore {
	private readonly book: BookFile<Book>;
	constructor(instanceDir: string) {
		this.book = {
			file: join(instanceDir, "clients.json"),
			empty: EMPTY,
			maxBytes: CLIENT_LIMITS.fileBytes,
			valid: validBook,
			broken: () => new ClientError(CLIENTS_BROKEN),
			full: () => new ClientError("le schede dei clienti sono piene: non salvo altro"),
		};
	}

	/** Never throws. */
	read(): ClientBook {
		const book = readBook(this.book);
		if (book === undefined) return { ...EMPTY, broken: true };
		return { ...book, broken: false };
	}

	/**
	 * Under the lock, once per `callId`: `change` gets the state as saved now and gives the new one
	 * (the same object: nothing to write). Returns false when the call wrote already (run again),
	 * and then nothing changes. ClientError from `change` stops it with nothing written.
	 */
	update(callId: string, change: (state: ClientState) => ClientState): boolean {
		let fresh = false;
		updateBook(this.book, (book) => {
			if (book.calls.includes(callId)) return book;
			const state: ClientState = { nextCard: book.nextCard, nextFollowUp: book.nextFollowUp, cards: book.cards };
			const next = change(state);
			if (next === state) return book;
			fresh = true;
			const made: Book = { nextCard: next.nextCard, nextFollowUp: next.nextFollowUp, cards: next.cards, calls: [...book.calls, callId].slice(-CLIENT_LIMITS.calls) };
			if (validBook(made) === undefined) throw new ClientError("la scheda non è valida: non l'ho salvata");
			return made;
		});
		return fresh;
	}
}

const counter = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999_999;

function validBook(raw: unknown): Book | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const b = raw as Book;
	if (!counter(b.nextCard) || !counter(b.nextFollowUp)) return undefined;
	if (!Array.isArray(b.cards) || b.cards.length > CLIENT_LIMITS.cards || !b.cards.every(validCard)) return undefined;
	if (!Array.isArray(b.calls) || b.calls.length > CLIENT_LIMITS.calls || !b.calls.every(validCall)) return undefined;
	// Numbers never given again: every id below its counter, each once.
	const ids = new Set<string>();
	const fus = new Set<string>();
	for (const c of b.cards) {
		const n = Number(CARD_ID.exec(c.id)?.[1]);
		if (n >= b.nextCard || ids.has(c.id)) return undefined;
		ids.add(c.id);
		for (const f of c.followUps) {
			const m = Number(FOLLOW_UP_ID.exec(f.id)?.[1]);
			if (m >= b.nextFollowUp || fus.has(f.id)) return undefined;
			fus.add(f.id);
		}
	}
	// Two cards never answer to the same name or partita IVA.
	const names = new Set<string>();
	const vats = new Set<string>();
	for (const c of b.cards) {
		for (const k of new Set([c.name, ...c.aliases].map(spellingKey))) {
			if (names.has(k)) return undefined;
			names.add(k);
		}
		if (c.vat !== undefined) {
			if (vats.has(c.vat)) return undefined;
			vats.add(c.vat);
		}
	}
	return b;
}
