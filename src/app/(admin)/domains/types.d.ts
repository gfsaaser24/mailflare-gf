export type Domain = {
	id: string;
	hostname: string;
	status: string;
	/** Why `status` is "error"; null otherwise. Written by the reconciler. */
	statusReason: string | null;
	/** Every required DNS record was present at `lastCheckedAt`. */
	dnsOk: boolean;
	/** ISO timestamp of the last reconcile, or null when never checked. */
	lastCheckedAt: string | null;
	routingEnabled: boolean;
	sendingEnabled: boolean;
	zoneId: string;
};

export type DnsRecord = {
	type?: string;
	name?: string;
	content?: string;
	priority?: number;
};

export type DnsStatusSummary = {
	routing: { configured: boolean; missing: string[] };
	sending: { configured: boolean; records: string[] };
};
