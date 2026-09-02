import type { CfDnsRecord } from "@/lib/cloudflare-api";

export type DnsStatusSummary = {
	routing: {
		configured: boolean;
		missing: string[];
	};
	sending: {
		configured: boolean;
		records: string[];
	};
};

export function summariseDns(
	routingRecords: CfDnsRecord[],
	routingMissing: CfDnsRecord[],
	sendingRecords: CfDnsRecord[],
): DnsStatusSummary {
	const recordTypes = (
		type: "routing-records" | "routing-missing" | "sending",
	) => {
		const list =
			type === "routing-records"
				? routingRecords
				: type === "routing-missing"
					? routingMissing
					: sendingRecords;
		return Array.from(new Set(list.map((r) => r.type).filter(Boolean))) as string[];
	};

	return {
		routing: {
			configured: routingMissing.length === 0 && routingRecords.length > 0,
			missing: recordTypes("routing-missing"),
		},
		sending: {
			configured: sendingRecords.length > 0,
			records: recordTypes("sending"),
		},
	};
}

/**
 * True when every DNS record the domain needs is live.
 *
 * Routing records (MX + SPF TXT) are always required. The sending records are
 * only required for domains that actually have a sending subdomain.
 */
export function dnsRecordsOk(summary: DnsStatusSummary, requireSending: boolean): boolean {
	if (!summary.routing.configured) return false;
	return requireSending ? summary.sending.configured : true;
}

/** Human-readable reasons for `dnsRecordsOk` being false; empty when DNS is fine. */
export function describeMissingDns(summary: DnsStatusSummary, requireSending: boolean): string[] {
	const reasons: string[] = [];
	if (!summary.routing.configured) {
		reasons.push(
			summary.routing.missing.length > 0
				? `Missing Email Routing DNS records: ${summary.routing.missing.join(", ")}`
				: "Email Routing DNS records are not published",
		);
	}
	if (requireSending && !summary.sending.configured) {
		reasons.push("Email Sending DNS records are not published");
	}
	return reasons;
}
