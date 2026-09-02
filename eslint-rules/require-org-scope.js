/**
 * `require-org-scope` — keeps multi-tenant leaks out of `src/app/api/**`.
 *
 * It is a deliberately simple, text-level heuristic over Drizzle query chains:
 *
 *   - `db.select()....from(TENANT)` / `db.update(TENANT)` / `db.delete(TENANT)`
 *     must have a `.where(...)` whose source text mentions `scoped(` or
 *     `organizationId`.
 *   - `db.insert(TENANT).values(V)` must have a `V` that mentions
 *     `insertValues(` or `organizationId`.
 *
 * The scoping helpers live in `src/lib/api/with-org.ts` (`ctx.scoped`,
 * `ctx.insertValues`). Tables without an `organization_id` column
 * (`conversation_notes`, `message_attachments`, `mailbox_access`, ...) are not
 * listed here: scope those through their parent row.
 *
 * False negatives are expected (a query builder split across statements is not
 * followed). False positives are cheap to silence with an eslint-disable line
 * plus a comment saying how the query is scoped.
 */

/** Schema export names (JS identifiers) of every table with `organization_id`. */
const TENANT_TABLES = new Set([
	"users",
	"domains",
	"mailboxes",
	"messages",
	"conversations",
	"contacts",
	"folders",
	"apiKeys",
	"webhooks",
	"routingRules",
	"emailTemplates",
	"calendarEvents",
	"auditLogs",
	"inboundFailures",
]);

/** Route folders that are outside tenant scope by design. */
const EXEMPT_SEGMENTS = ["platform", "edge", "setup", "auth", "admin"];

/** Text that proves a `.where(...)` carries the organisation filter. */
const SCOPE_MARKERS = ["scoped(", "organizationId", "organization_id"];
/** Text that proves `.values(...)` stamps the organisation. */
const INSERT_MARKERS = ["insertValues(", "organizationId", "organization_id"];

function isDatabaseReceiver(text) {
	// `db`, `ctx.db`, `this.db`, `tx`, `trx`, `database`, ...
	return /(^|[.\s])(db|tx|trx|database)$/i.test(text.trim());
}

function isTenantTableArg(node) {
	return !!node && node.type === "Identifier" && TENANT_TABLES.has(node.name);
}

function isExemptFile(filename) {
	const path = filename.replace(/\\/g, "/");
	const index = path.indexOf("src/app/api/");
	if (index === -1) return true;
	const rest = path.slice(index + "src/app/api/".length);
	const first = rest.split("/")[0];
	return EXEMPT_SEGMENTS.includes(first);
}

/** Every call in `a().b().c()` starting at `start`. */
function collectChain(start) {
	const calls = [start];
	let current = start;
	while (
		current.parent &&
		current.parent.type === "MemberExpression" &&
		current.parent.object === current &&
		current.parent.parent &&
		current.parent.parent.type === "CallExpression" &&
		current.parent.parent.callee === current.parent
	) {
		current = current.parent.parent;
		calls.push(current);
	}
	return calls;
}

function findCall(chain, name) {
	return chain.find(
		(call) =>
			call.callee.type === "MemberExpression" &&
			call.callee.property.type === "Identifier" &&
			call.callee.property.name === name,
	);
}

function containsAny(text, markers) {
	return markers.some((marker) => text.includes(marker));
}

module.exports = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Require queries on organisation-scoped tables to filter by organization_id (see src/lib/api/with-org.ts).",
		},
		schema: [],
		messages: {
			missingWhere:
				"Query on `{{table}}` has no `.where(...)`. Add `scoped({{table}})` from withOrg's context.",
			unscopedWhere:
				"`.where(...)` on `{{table}}` is not organisation-scoped. Put `scoped({{table}})` inside the `and(...)`.",
			unscopedInsert:
				"Insert into `{{table}}` does not stamp `organizationId`. Use `insertValues({{table}}, ...)` from withOrg's context.",
		},
	},

	create(context) {
		const filename = context.filename ?? context.getFilename();
		if (isExemptFile(filename)) return {};
		const sourceCode = context.sourceCode ?? context.getSourceCode();

		function report(node, messageId, table) {
			context.report({ node, messageId, data: { table } });
		}

		function checkWhere(chain, node, table) {
			const whereCall = findCall(chain, "where");
			if (!whereCall) {
				report(node, "missingWhere", table);
				return;
			}
			const text = whereCall.arguments.map((arg) => sourceCode.getText(arg)).join(", ");
			if (!containsAny(text, SCOPE_MARKERS)) {
				report(whereCall, "unscopedWhere", table);
			}
		}

		return {
			CallExpression(node) {
				const callee = node.callee;
				if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;
				const method = callee.property.name;
				if (!["select", "insert", "update", "delete"].includes(method)) return;
				if (!isDatabaseReceiver(sourceCode.getText(callee.object))) return;

				const chain = collectChain(node);

				if (method === "select") {
					const fromCall = findCall(chain, "from");
					const table = fromCall && fromCall.arguments[0];
					if (!isTenantTableArg(table)) return;
					checkWhere(chain, node, table.name);
					return;
				}

				const target = node.arguments[0];
				if (!isTenantTableArg(target)) return;

				if (method === "insert") {
					const valuesCall = findCall(chain, "values");
					if (!valuesCall) return;
					const text = valuesCall.arguments.map((arg) => sourceCode.getText(arg)).join(", ");
					if (!containsAny(text, INSERT_MARKERS)) {
						report(valuesCall, "unscopedInsert", target.name);
					}
					return;
				}

				checkWhere(chain, node, target.name);
			},
		};
	},
};
