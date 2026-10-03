CREATE TABLE `maintenance_runs` (
	`run_key` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`slot` text,
	`scheduled_time` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`cutoff_at` integer,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`expired_sessions` integer DEFAULT 0 NOT NULL,
	`idle_rate_limits` integer DEFAULT 0 NOT NULL,
	`artifacts_queued` integer DEFAULT 0 NOT NULL,
	`artifacts_retired` integer DEFAULT 0 NOT NULL,
	`pending_dispatches` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	CONSTRAINT "maintenance_runs_status_check" CHECK("maintenance_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "maintenance_runs_trigger_check" CHECK("maintenance_runs"."trigger" in ('scheduled', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `maintenance_runs_started_idx` ON `maintenance_runs` (`started_at`);