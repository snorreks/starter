CREATE TABLE `job_artifact_retirements` (
	`job_id` text PRIMARY KEY NOT NULL,
	`output_key` text NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`cutoff_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text DEFAULT 'encode' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`fixture` text NOT NULL,
	`preset` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`workflow_id` text NOT NULL,
	`dispatch_state` text DEFAULT 'pending' NOT NULL,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`dispatch_error` text,
	`dispatched_at` integer,
	`active_attempt_id` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`output_key` text,
	`output_bytes` integer,
	`output_sha256` text,
	`output_container_format` text,
	`output_video_codec` text,
	`output_width` integer,
	`output_height` integer,
	`output_duration_ms` integer,
	`output_expires_at` integer,
	`error_code` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "jobs_kind_check" CHECK("jobs"."kind" in ('encode')),
	CONSTRAINT "jobs_dispatch_state_check" CHECK("jobs"."dispatch_state" in ('pending', 'dispatched', 'dispatch_failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_owner_idempotency_key_uq` ON `jobs` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_owner_created_idx` ON `jobs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_dispatch_state_idx` ON `jobs` (`dispatch_state`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_output_expiry_idx` ON `jobs` (`output_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_owner_active_uq` ON `jobs` (`owner_id`) WHERE "jobs"."status" in ('pending', 'running');