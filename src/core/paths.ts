import { join } from "node:path";
import type { InstanceId, TenantId } from "./ids.ts";

/**
 * On-disk layout. Everything a tenant owns lives under its own directory:
 *
 *   <dataDir>/tenants/<tenantId>/tenant.json
 *   <dataDir>/tenants/<tenantId>/secrets.json          (mode 0600)
 *   <dataDir>/tenants/<tenantId>/audit.jsonl           (append-only)
 *   <dataDir>/tenants/<tenantId>/instances/<instanceId>/instance.json
 *   <dataDir>/tenants/<tenantId>/instances/<instanceId>/engine/   (durable engine storage)
 */
export function tenantDir(dataDir: string, tenant: TenantId): string {
	return join(dataDir, "tenants", tenant);
}

export function tenantFile(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "tenant.json");
}

export function secretsFile(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "secrets.json");
}

export function auditFile(dataDir: string, tenant: TenantId): string {
	return join(tenantDir(dataDir, tenant), "audit.jsonl");
}

export function instanceDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(tenantDir(dataDir, tenant), "instances", instance);
}

export function instanceFile(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "instance.json");
}

export function engineDir(dataDir: string, tenant: TenantId, instance: InstanceId): string {
	return join(instanceDir(dataDir, tenant, instance), "engine");
}
