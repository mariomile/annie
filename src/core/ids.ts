/**
 * Tenant and instance IDs become directory names, so they are restricted to a
 * safe alphabet: no separators, no dots, no path traversal.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export type TenantId = string & { readonly __brand: "TenantId" };
export type InstanceId = string & { readonly __brand: "InstanceId" };

export function tenantId(value: string): TenantId {
	assertId(value, "tenantId");
	return value as TenantId;
}

export function instanceId(value: string): InstanceId {
	assertId(value, "instanceId");
	return value as InstanceId;
}

function assertId(value: string, label: string): void {
	if (!ID_PATTERN.test(value)) {
		throw new Error(`Invalid ${label} "${value}": use 1-63 chars of a-z, 0-9, "-" or "_", starting with a letter or digit`);
	}
}
