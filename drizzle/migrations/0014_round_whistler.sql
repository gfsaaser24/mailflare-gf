ALTER TABLE "mailboxes" ALTER COLUMN "use_all_domains" SET DEFAULT false;--> statement-breakpoint
-- Existing mailboxes were created with the flag on by default, which expanded every
-- local part to an alias on every domain of the account. Turn it off; the admin
-- mailbox page still offers it per mailbox.
UPDATE "mailboxes" SET "use_all_domains" = false;
