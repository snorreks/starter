CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_owner_updated_idx` ON `conversations` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `conversations_owner_id_idx` ON `conversations` (`owner_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`author_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`client_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_created_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_id_idx` ON `messages` (`conversation_id`,`client_id`);