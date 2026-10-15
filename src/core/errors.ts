/** Thrown when something would leave the instance without an explicit egress permission. */
export class EgressDenied extends Error {
	override readonly name = "EgressDenied";
	constructor(
		readonly kind: "model_provider" | "channel",
		readonly target: string,
	) {
		super(`Egress denied: ${kind} "${target}" is not allowed by this instance's egress policy`);
	}
}

export class NotFound extends Error {
	override readonly name = "NotFound";
}
