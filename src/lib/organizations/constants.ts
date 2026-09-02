/**
 * The organisation every pre-multi-tenant row was backfilled into.
 *
 * Tenant tables default `organization_id` to this value so that code paths which
 * have not yet been threaded with a real organisation (see T3.2) keep working and
 * land in the default org.
 */
export const DEFAULT_ORGANIZATION_ID = "org_default";

/** Slug of the default organisation created by the organisations migration. */
export const DEFAULT_ORGANIZATION_SLUG = "default";
