/** Thrown when something would leave the instance without an explicit egress permission. */
export class EgressDenied extends Error {
	override readonly name = "EgressDenied";
	constructor(
		readonly kind: "model_provider" | "channel" | "connector",
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

/** Thrown when another process already has the instance open. */
export class InstanceLocked extends Error {
	override readonly name = "InstanceLocked";
	constructor(
		readonly instance: string,
		readonly owner: string | undefined,
	) {
		super(
			`Instance ${instance} is already open in another process (${owner ?? "owner unknown"}). ` +
				"An instance runs in one process at a time: stop the other one first.",
		);
	}
}

export class NotFound extends Error {
	override readonly name = "NotFound";
}
