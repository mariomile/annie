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

/** Thrown when a message comes from a user the instance's allowlist does not name for that channel. */
export class UserNotAllowed extends Error {
	override readonly name = "UserNotAllowed";
	constructor(
		readonly channel: string,
		readonly userId: string,
		readonly threadId: string,
		readonly reason: "no_users_allowed_on_channel" | "user_not_in_allowlist",
	) {
		super(`User "${userId}" is not allowed on channel "${channel}" (${reason})`);
	}
}

export class NotFound extends Error {
	override readonly name = "NotFound";
}
