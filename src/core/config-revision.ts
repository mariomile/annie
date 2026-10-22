let revision = 0;

/**
 * Called after every write that can change which model a conversation answers with: a chat's
 * own model, a provider's key, a subscription connected or not, an instance's record (its
 * allowed providers). An engine session not started yet aligns its pending work again when
 * the revision moved meanwhile.
 */
export function configChanged(): void {
	revision++;
}

export function configRevision(): number {
	return revision;
}
