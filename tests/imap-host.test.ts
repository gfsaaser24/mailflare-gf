import { describe, expect, it, vi } from "vitest";

import {
	assertSafeImapHost,
	isPrivateIpAddress,
	resolveSafeImapHost,
	type HostLookup,
} from "../src/lib/import/imap-utils";

/** A lookup that never touches the network; fails the test if it is called unexpectedly. */
function fakeLookup(addresses: Array<{ address: string; family: number }>): HostLookup {
	return vi.fn(async () => addresses);
}

const neverCalled: HostLookup = vi.fn(async () => {
	throw new Error("DNS lookup should not have run");
});

describe("assertSafeImapHost (literals)", () => {
	it("rejects a literal private IPv4", () => {
		expect(() => assertSafeImapHost("10.0.0.5")).toThrow(/Private IMAP hosts/);
		expect(() => assertSafeImapHost("192.168.1.1")).toThrow(/Private IMAP hosts/);
		expect(() => assertSafeImapHost("172.20.3.4")).toThrow(/Private IMAP hosts/);
		expect(() => assertSafeImapHost("127.0.0.1")).toThrow(/Private IMAP hosts/);
		expect(() => assertSafeImapHost("169.254.169.254")).toThrow(/Private IMAP hosts/);
		expect(() => assertSafeImapHost("100.64.0.1")).toThrow(/Private IMAP hosts/);
		expect(() => assertSafeImapHost("0.0.0.0")).toThrow(/Private IMAP hosts/);
	});

	it("rejects localhost-ish names", () => {
		expect(() => assertSafeImapHost("localhost")).toThrow(/not allowed/);
		expect(() => assertSafeImapHost("box.local")).toThrow(/not allowed/);
		expect(() => assertSafeImapHost("   ")).toThrow(/not allowed/);
	});

	it("accepts a literal public IPv4", () => {
		expect(() => assertSafeImapHost("93.184.216.34")).not.toThrow();
	});
});

describe("isPrivateIpAddress", () => {
	it("classifies IPv6 ranges", () => {
		expect(isPrivateIpAddress("::1")).toBe(true);
		expect(isPrivateIpAddress("::")).toBe(true);
		expect(isPrivateIpAddress("fd00::1")).toBe(true);
		expect(isPrivateIpAddress("fc00::1")).toBe(true);
		expect(isPrivateIpAddress("fe80::1")).toBe(true);
		expect(isPrivateIpAddress("::ffff:10.0.0.5")).toBe(true);
		expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("2606:4700:4700::1111")).toBe(false);
		expect(isPrivateIpAddress("::ffff:93.184.216.34")).toBe(false);
	});
});

describe("resolveSafeImapHost", () => {
	it("rejects a literal private IPv4 without resolving", async () => {
		await expect(resolveSafeImapHost("10.0.0.5", neverCalled)).rejects.toThrow(
			/Private IMAP hosts/,
		);
	});

	it("accepts a literal public IPv4 without resolving", async () => {
		await expect(resolveSafeImapHost("93.184.216.34", neverCalled)).resolves.toEqual({
			address: "93.184.216.34",
			family: 4,
		});
	});

	it("rejects a hostname that resolves to a private address", async () => {
		const lookup = fakeLookup([{ address: "10.0.0.5", family: 4 }]);
		await expect(resolveSafeImapHost("evil.example.com", lookup)).rejects.toThrow(
			/Private IMAP hosts/,
		);
		expect(lookup).toHaveBeenCalledWith("evil.example.com");
	});

	it("rejects a hostname that resolves to a mix of public and private addresses", async () => {
		const lookup = fakeLookup([
			{ address: "93.184.216.34", family: 4 },
			{ address: "192.168.1.10", family: 4 },
		]);
		await expect(resolveSafeImapHost("mixed.example.com", lookup)).rejects.toThrow(
			/Private IMAP hosts/,
		);
	});

	it("rejects a hostname that resolves to IPv6 loopback", async () => {
		const lookup = fakeLookup([{ address: "::1", family: 6 }]);
		await expect(resolveSafeImapHost("v6.example.com", lookup)).rejects.toThrow(
			/Private IMAP hosts/,
		);
	});

	it("returns the first address for a public hostname", async () => {
		const lookup = fakeLookup([
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:4700:4700::1111", family: 6 },
		]);
		await expect(resolveSafeImapHost("imap.example.com", lookup)).resolves.toEqual({
			address: "93.184.216.34",
			family: 4,
		});
	});

	it("returns family 6 when the first address is IPv6", async () => {
		const lookup = fakeLookup([{ address: "2606:4700:4700::1111", family: 6 }]);
		await expect(resolveSafeImapHost("imap6.example.com", lookup)).resolves.toEqual({
			address: "2606:4700:4700::1111",
			family: 6,
		});
	});

	it("rejects a host that cannot be resolved", async () => {
		const empty: HostLookup = async () => [];
		await expect(resolveSafeImapHost("nowhere.example.com", empty)).rejects.toThrow(
			/could not be resolved/,
		);
	});
});
