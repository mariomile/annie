/**
 * Two clients made one card: what the person said of the first (other names, referenti, labels,
 * notes, ricontatti, contacts had) goes into the second's card, and the first's name stays as
 * another name, so the registers that write it find the card. When only the first has a card,
 * that card is kept (its id with it), named as the second. Two different partite IVA, or two
 * different codici fiscali, are two clients: refused. Invoices, quotes and hours never change.
 */
import type { Client } from "../client-sums.ts";
import type { ClientState } from "../client-store.ts";
import { CLIENT_LIMITS, type ClientCard, ClientError } from "../clients.ts";
import type { Marker } from "../marker.ts";
import { mergeCards } from "../party-cards.ts";

export { mergeRefusal } from "../party-cards.ts";

/**
 * The state with `a` merged into `b`, as saved now (party-cards.ts mergeCards), with the clients'
 * own fields: labels, ricontatti (the open ones all kept), contacts had and the address. `fresh`
 * makes a card for a client without one. ClientError when the merged card would hold too much or
 * clash with another card.
 */
export function merged(state: ClientState, a: Client, b: Client, fresh: (state: ClientState, name: string, client: Client) => ClientCard, by: Marker): ClientState {
	return mergeCards<ClientCard, ClientState>(state, a, b, {
		fresh: (s, name, party) => fresh(s, name, party as Client),
		by,
		limits: CLIENT_LIMITS,
		word: "cliente",
		fail: (message) => new ClientError(message),
		extras: (base, other) => {
			const tags = [...new Set([...base.tags, ...(other?.tags ?? [])])].slice(0, CLIENT_LIMITS.tags);
			const followUps = [...base.followUps, ...(other?.followUps ?? [])];
			const open = followUps.filter((f) => f.done === undefined);
			if (open.length > CLIENT_LIMITS.followUps) throw new ClientError("la scheda unita avrebbe troppi ricontatti aperti");
			const room = CLIENT_LIMITS.followUps - open.length;
			const closed = followUps.filter((f) => f.done !== undefined);
			const kept = room > 0 ? closed.slice(-room) : [];
			const log = [...(base.log ?? []), ...(other?.log ?? [])].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at)).slice(-CLIENT_LIMITS.log);
			const address = base.address ?? other?.address;
			return { tags, followUps: [...open, ...kept].sort((x, y) => x.id.localeCompare(y.id)), ...(log.length === 0 ? {} : { log }), ...(address === undefined ? {} : { address }) };
		},
	});
}
