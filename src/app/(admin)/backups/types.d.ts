export type BackupScheduleType = "daily" | "weekly" | "monthly";
export type BackupStatus = "queued" | "running" | "completed" | "failed";

export type BackupSettings = {
	id: string;
	enabled: boolean;
	scheduleType: BackupScheduleType;
	scheduleValue: number | null;
	retentionEnabled: boolean;
	retentionDays: number;
	updatedAt: string;
};

export type BackupItem = {
	id: string;
	status: BackupStatus;
	trigger: "manual" | "scheduled";
	filename: string | null;
	size: number | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};

export type BackupsResponse = {
	settings: BackupSettings;
	backups: BackupItem[];
	configuration: {
		configured: boolean;
		missing: string[];
	};
};

/** Per-organisation retention windows (T5.2), all in days. */
export type RetentionSettings = {
	trashDays: number;
	sessionsDays: number;
	webhookDeliveriesDays: number;
	auditLogsDays: number;
	autoReplyDays: number;
	outboundJobsDays: number;
};

export type RetentionResponse = {
	retention: RetentionSettings;
};
