CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_idx` ON `device_codes` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_idx` ON `device_codes` (`user_code`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `access_token` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `refresh_token` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `id_token` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `access_token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `refresh_token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `scope` text;