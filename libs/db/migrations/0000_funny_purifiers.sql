CREATE TYPE "public"."job_state" AS ENUM('SCHEDULED', 'ARMED', 'FIRING', 'VERIFYING', 'BOOKED', 'WAITLISTED', 'FULL', 'FAILED', 'MISSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."portal_session_state" AS ENUM('ACTIVE', 'REFRESHING', 'NEEDS_USER', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."registration_window" AS ENUM('not-open', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."secret_kind" AS ENUM('password', 'storage_state', 'register_token');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_account_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"rung" text NOT NULL,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"login" text NOT NULL,
	"home_club_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_accounts_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "portal_activities" (
	"id" integer PRIMARY KEY NOT NULL,
	"club_slug" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"window" "registration_window" NOT NULL,
	"full" boolean DEFAULT false NOT NULL,
	"seats_taken" integer,
	"seats_total" integer,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_account_id" uuid NOT NULL,
	"state" "portal_session_state" DEFAULT 'NEEDS_USER' NOT NULL,
	"logged_in_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_sessions_portal_account_id_unique" UNIQUE("portal_account_id")
);
--> statement-breakpoint
CREATE TABLE "registration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid,
	"portal_activity_id" integer NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"state" "job_state" DEFAULT 'SCHEDULED' NOT NULL,
	"worker_id" text,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"send_latency_ms" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"matcher" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_account_id" uuid NOT NULL,
	"kind" "secret_kind" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"telegram_chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker" text NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_heartbeats_worker_pk" PRIMARY KEY("worker")
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_portal_account_id_portal_accounts_id_fk" FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_registration_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."registration_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_portal_account_id_portal_accounts_id_fk" FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_jobs" ADD CONSTRAINT "registration_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_jobs" ADD CONSTRAINT "registration_jobs_rule_id_registration_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."registration_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_jobs" ADD CONSTRAINT "registration_jobs_portal_activity_id_portal_activities_id_fk" FOREIGN KEY ("portal_activity_id") REFERENCES "public"."portal_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_rules" ADD CONSTRAINT "registration_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_blobs" ADD CONSTRAINT "secret_blobs_portal_account_id_portal_accounts_id_fk" FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_once" ON "notifications" USING btree ("portal_account_id","job_id","rung");--> statement-breakpoint
CREATE INDEX "portal_activities_club_start" ON "portal_activities" USING btree ("club_slug","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_jobs_one_per_class" ON "registration_jobs" USING btree ("user_id","portal_activity_id") WHERE "registration_jobs"."state" <> 'CANCELLED';--> statement-breakpoint
CREATE INDEX "registration_jobs_due" ON "registration_jobs" USING btree ("state","opens_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_blobs_account_kind" ON "secret_blobs" USING btree ("portal_account_id","kind");