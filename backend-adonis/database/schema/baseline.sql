-- Skema dasar database Lacak SMB = hasil 44 migrasi Laravel backend-api (terakhir:
-- 2026_10_25_160000_create_briefings_table), dibuat dengan pg_dump --schema-only.
-- Dipakai migrasi 0000_baseline_schema untuk database KOSONG; database lama
-- (produksi/server uji) sudah punya skema ini dan tidak dijalankan ulang.
-- Jangan diubah: perubahan skema baru ditulis sebagai migrasi Lucid.

CREATE TABLE public.activity_log (
    id bigint NOT NULL,
    log_name character varying(255),
    description text NOT NULL,
    subject_type character varying(255),
    subject_id bigint,
    causer_type character varying(255),
    causer_id bigint,
    properties json,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    event character varying(255),
    batch_uuid uuid,
    organization_id bigint,
    ip_address character varying(45),
    user_agent character varying(255)
);

CREATE SEQUENCE public.activity_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.activity_log_id_seq OWNED BY public.activity_log.id;

CREATE TABLE public.apk_builds (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    version character varying(20) NOT NULL,
    file_path character varying(255),
    embedded_site_code character varying(32) NOT NULL,
    checksum_sha256 character varying(64),
    built_by bigint NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    apk_type character varying(10) DEFAULT 'tracker'::character varying NOT NULL,
    status character varying(10) DEFAULT 'success'::character varying NOT NULL,
    build_log text,
    device_id bigint,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.apk_builds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.apk_builds_id_seq OWNED BY public.apk_builds.id;

CREATE TABLE public.app_settings (
    key character varying(100) NOT NULL,
    value text,
    updated_by bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE TABLE public.briefings (
    id bigint NOT NULL,
    title character varying(120) NOT NULL,
    host_user_id bigint NOT NULL,
    allowed_roles json NOT NULL,
    allowed_organization_ids json NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.briefings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.briefings_id_seq OWNED BY public.briefings.id;

CREATE TABLE public.cache (
    key character varying(255) NOT NULL,
    value text NOT NULL,
    expiration bigint NOT NULL
);

CREATE TABLE public.cache_locks (
    key character varying(255) NOT NULL,
    owner character varying(255) NOT NULL,
    expiration bigint NOT NULL
);

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    user_id bigint NOT NULL,
    body text,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    reply_to_id bigint,
    image_path character varying(255),
    image_mime character varying(50),
    image_width integer,
    image_height integer
);

CREATE SEQUENCE public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;

CREATE TABLE public.consent_documents (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    subject_name character varying(255) NOT NULL,
    signer_name character varying(255) NOT NULL,
    signer_role character varying(20) NOT NULL,
    document_file_path character varying(255) NOT NULL,
    signed_at date NOT NULL,
    valid_until date,
    revoked_at timestamp(0) without time zone,
    created_by bigint NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    updated_by bigint
);

CREATE SEQUENCE public.consent_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.consent_documents_id_seq OWNED BY public.consent_documents.id;

CREATE TABLE public.device_commands (
    id bigint NOT NULL,
    device_id bigint NOT NULL,
    command_type character varying(255) NOT NULL,
    issued_by bigint NOT NULL,
    issued_via character varying(255) NOT NULL,
    status character varying(255) DEFAULT 'pending'::character varying NOT NULL,
    reason_note character varying(255),
    acknowledged_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT device_commands_command_type_check CHECK (((command_type)::text = ANY ((ARRAY['lock'::character varying, 'unlock'::character varying, 'start_monitor'::character varying, 'stop_monitor'::character varying, 'locate_now'::character varying])::text[]))),
    CONSTRAINT device_commands_issued_via_check CHECK (((issued_via)::text = ANY ((ARRAY['web_dashboard'::character varying, 'master_app'::character varying, 'telegram_bot'::character varying, 'system_auto'::character varying])::text[]))),
    CONSTRAINT device_commands_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'delivered'::character varying, 'acknowledged'::character varying, 'failed'::character varying])::text[])))
);

CREATE SEQUENCE public.device_commands_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.device_commands_id_seq OWNED BY public.device_commands.id;

CREATE TABLE public.device_locations (
    id bigint NOT NULL,
    device_id bigint NOT NULL,
    source character varying(255) NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    ble_distance_meters numeric(6,2),
    ble_rssi smallint,
    recorded_at timestamp(0) without time zone NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT device_locations_source_check CHECK (((source)::text = ANY ((ARRAY['ble'::character varying, 'gps'::character varying, 'ble_estimated'::character varying])::text[])))
);

CREATE SEQUENCE public.device_locations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.device_locations_id_seq OWNED BY public.device_locations.id;

CREATE TABLE public.device_otps (
    id bigint NOT NULL,
    device_id bigint NOT NULL,
    otp_code_hash character varying(255) NOT NULL,
    purpose character varying(255) DEFAULT 'self_unlock'::character varying NOT NULL,
    expires_at timestamp(0) without time zone NOT NULL,
    used_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT device_otps_purpose_check CHECK (((purpose)::text = 'self_unlock'::text))
);

CREATE SEQUENCE public.device_otps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.device_otps_id_seq OWNED BY public.device_otps.id;

CREATE TABLE public.devices (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    consent_document_id bigint NOT NULL,
    device_name character varying(255) NOT NULL,
    device_uuid character varying(255) NOT NULL,
    android_version character varying(10) NOT NULL,
    app_build_version character varying(20) NOT NULL,
    site_code_embedded character varying(32) NOT NULL,
    status character varying(255) DEFAULT 'pending_enrollment'::character varying NOT NULL,
    battery_level smallint,
    last_seen_at timestamp(0) without time zone,
    enrolled_at timestamp(0) without time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint,
    updated_by bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    deleted_at timestamp(0) without time zone,
    secret_hash character varying(64),
    CONSTRAINT devices_status_check CHECK (((status)::text = ANY ((ARRAY['online'::character varying, 'offline'::character varying, 'locked'::character varying, 'pending_enrollment'::character varying])::text[])))
);

CREATE SEQUENCE public.devices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.devices_id_seq OWNED BY public.devices.id;

CREATE TABLE public.failed_jobs (
    id bigint NOT NULL,
    uuid character varying(255) NOT NULL,
    connection character varying(255) NOT NULL,
    queue character varying(255) NOT NULL,
    payload text NOT NULL,
    exception text NOT NULL,
    failed_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.failed_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.failed_jobs_id_seq OWNED BY public.failed_jobs.id;

CREATE TABLE public.geofence_rules (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    rule_name character varying(255) NOT NULL,
    allowed_ssid character varying(255),
    allowed_ip_cidr character varying(255),
    max_distance_meters integer,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    center_latitude numeric(10,7),
    center_longitude numeric(10,7),
    anchor_device_id bigint,
    updated_by bigint
);

CREATE SEQUENCE public.geofence_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.geofence_rules_id_seq OWNED BY public.geofence_rules.id;

CREATE TABLE public.job_batches (
    id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    total_jobs integer NOT NULL,
    pending_jobs integer NOT NULL,
    failed_jobs integer NOT NULL,
    failed_job_ids text NOT NULL,
    options text,
    cancelled_at integer,
    created_at integer NOT NULL,
    finished_at integer
);

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    queue character varying(255) NOT NULL,
    payload text NOT NULL,
    attempts smallint NOT NULL,
    reserved_at integer,
    available_at integer NOT NULL,
    created_at integer NOT NULL
);

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;

CREATE TABLE public.live_recordings (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    user_id bigint NOT NULL,
    work_session_id bigint,
    egress_id character varying(255) NOT NULL,
    track_sid character varying(255) NOT NULL,
    source character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'recording'::character varying NOT NULL,
    file_path character varying(255),
    size_bytes bigint,
    error text,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.live_recordings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.live_recordings_id_seq OWNED BY public.live_recordings.id;

CREATE TABLE public.model_has_permissions (
    permission_id bigint NOT NULL,
    model_type character varying(255) NOT NULL,
    model_id bigint NOT NULL
);

CREATE TABLE public.model_has_roles (
    role_id bigint NOT NULL,
    model_type character varying(255) NOT NULL,
    model_id bigint NOT NULL
);

CREATE TABLE public.organizations (
    id bigint NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(20) DEFAULT 'company_asset'::character varying NOT NULL,
    unique_site_code character varying(32) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint,
    updated_by bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    deleted_at timestamp(0) without time zone
);

CREATE SEQUENCE public.organizations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organizations_id_seq OWNED BY public.organizations.id;

CREATE TABLE public.password_reset_tokens (
    email character varying(255) NOT NULL,
    token character varying(255) NOT NULL,
    created_at timestamp(0) without time zone
);

CREATE TABLE public.permissions (
    id bigint NOT NULL,
    name character varying(255) NOT NULL,
    guard_name character varying(255) NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.permissions_id_seq OWNED BY public.permissions.id;

CREATE TABLE public.personal_access_tokens (
    id bigint NOT NULL,
    tokenable_type character varying(255) NOT NULL,
    tokenable_id bigint NOT NULL,
    name text NOT NULL,
    token character varying(64) NOT NULL,
    abilities text,
    last_used_at timestamp(0) without time zone,
    expires_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    device_type character varying(16)
);

CREATE SEQUENCE public.personal_access_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.personal_access_tokens_id_seq OWNED BY public.personal_access_tokens.id;

CREATE TABLE public.role_has_permissions (
    permission_id bigint NOT NULL,
    role_id bigint NOT NULL
);

CREATE TABLE public.roles (
    id bigint NOT NULL,
    name character varying(255) NOT NULL,
    guard_name character varying(255) NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

CREATE TABLE public.sessions (
    id character varying(255) NOT NULL,
    user_id bigint,
    ip_address character varying(45),
    user_agent text,
    payload text NOT NULL,
    last_activity integer NOT NULL
);

CREATE TABLE public.telegram_bindings (
    id bigint NOT NULL,
    organization_id bigint NOT NULL,
    telegram_chat_id character varying(255) NOT NULL,
    bot_token_ref character varying(255) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    created_by bigint,
    updated_by bigint
);

CREATE SEQUENCE public.telegram_bindings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.telegram_bindings_id_seq OWNED BY public.telegram_bindings.id;

CREATE TABLE public.telegram_user_links (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    telegram_user_id character varying(255) NOT NULL,
    telegram_username character varying(255),
    created_by bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.telegram_user_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.telegram_user_links_id_seq OWNED BY public.telegram_user_links.id;

CREATE TABLE public.user_site_access (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    organization_id bigint NOT NULL,
    granted_by bigint,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.user_site_access_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_site_access_id_seq OWNED BY public.user_site_access.id;

CREATE TABLE public.users (
    id bigint NOT NULL,
    organization_id bigint,
    username character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    email_verified_at timestamp(0) without time zone,
    password character varying(255) NOT NULL,
    two_factor_secret text,
    two_factor_confirmed_at timestamp(0) without time zone,
    two_factor_recovery_codes text,
    is_active boolean DEFAULT true NOT NULL,
    remember_token character varying(100),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    deleted_at timestamp(0) without time zone
);

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

CREATE TABLE public.violation_logs (
    id bigint NOT NULL,
    device_id bigint NOT NULL,
    geofence_rule_id bigint,
    violation_type character varying(255) NOT NULL,
    detected_value character varying(255) NOT NULL,
    notified_telegram boolean DEFAULT false NOT NULL,
    notified_dashboard boolean DEFAULT false NOT NULL,
    detected_at timestamp(0) without time zone NOT NULL,
    created_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT violation_logs_violation_type_check CHECK (((violation_type)::text = ANY ((ARRAY['wifi_mismatch'::character varying, 'ip_mismatch'::character varying, 'distance_exceeded'::character varying])::text[])))
);

CREATE SEQUENCE public.violation_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.violation_logs_id_seq OWNED BY public.violation_logs.id;

CREATE TABLE public.work_session_events (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    organization_id bigint,
    work_session_id bigint,
    type character varying(30) NOT NULL,
    status character varying(20) NOT NULL,
    occurred_at timestamp(0) without time zone NOT NULL,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone
);

CREATE SEQUENCE public.work_session_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.work_session_events_id_seq OWNED BY public.work_session_events.id;

CREATE TABLE public.work_sessions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    organization_id bigint,
    started_at timestamp(0) without time zone NOT NULL,
    last_heartbeat_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    end_reason character varying(20),
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    camera_active boolean DEFAULT false NOT NULL,
    screen_active boolean DEFAULT false NOT NULL,
    on_break boolean DEFAULT false NOT NULL,
    idle boolean DEFAULT false NOT NULL,
    disconnected_at timestamp(0) without time zone
);

CREATE SEQUENCE public.work_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.work_sessions_id_seq OWNED BY public.work_sessions.id;

ALTER TABLE ONLY public.activity_log ALTER COLUMN id SET DEFAULT nextval('public.activity_log_id_seq'::regclass);

ALTER TABLE ONLY public.apk_builds ALTER COLUMN id SET DEFAULT nextval('public.apk_builds_id_seq'::regclass);

ALTER TABLE ONLY public.briefings ALTER COLUMN id SET DEFAULT nextval('public.briefings_id_seq'::regclass);

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);

ALTER TABLE ONLY public.consent_documents ALTER COLUMN id SET DEFAULT nextval('public.consent_documents_id_seq'::regclass);

ALTER TABLE ONLY public.device_commands ALTER COLUMN id SET DEFAULT nextval('public.device_commands_id_seq'::regclass);

ALTER TABLE ONLY public.device_locations ALTER COLUMN id SET DEFAULT nextval('public.device_locations_id_seq'::regclass);

ALTER TABLE ONLY public.device_otps ALTER COLUMN id SET DEFAULT nextval('public.device_otps_id_seq'::regclass);

ALTER TABLE ONLY public.devices ALTER COLUMN id SET DEFAULT nextval('public.devices_id_seq'::regclass);

ALTER TABLE ONLY public.failed_jobs ALTER COLUMN id SET DEFAULT nextval('public.failed_jobs_id_seq'::regclass);

ALTER TABLE ONLY public.geofence_rules ALTER COLUMN id SET DEFAULT nextval('public.geofence_rules_id_seq'::regclass);

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);

ALTER TABLE ONLY public.live_recordings ALTER COLUMN id SET DEFAULT nextval('public.live_recordings_id_seq'::regclass);

ALTER TABLE ONLY public.organizations ALTER COLUMN id SET DEFAULT nextval('public.organizations_id_seq'::regclass);

ALTER TABLE ONLY public.permissions ALTER COLUMN id SET DEFAULT nextval('public.permissions_id_seq'::regclass);

ALTER TABLE ONLY public.personal_access_tokens ALTER COLUMN id SET DEFAULT nextval('public.personal_access_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

ALTER TABLE ONLY public.telegram_bindings ALTER COLUMN id SET DEFAULT nextval('public.telegram_bindings_id_seq'::regclass);

ALTER TABLE ONLY public.telegram_user_links ALTER COLUMN id SET DEFAULT nextval('public.telegram_user_links_id_seq'::regclass);

ALTER TABLE ONLY public.user_site_access ALTER COLUMN id SET DEFAULT nextval('public.user_site_access_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.violation_logs ALTER COLUMN id SET DEFAULT nextval('public.violation_logs_id_seq'::regclass);

ALTER TABLE ONLY public.work_session_events ALTER COLUMN id SET DEFAULT nextval('public.work_session_events_id_seq'::regclass);

ALTER TABLE ONLY public.work_sessions ALTER COLUMN id SET DEFAULT nextval('public.work_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.apk_builds
    ADD CONSTRAINT apk_builds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cache_locks
    ADD CONSTRAINT cache_locks_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.cache
    ADD CONSTRAINT cache_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.consent_documents
    ADD CONSTRAINT consent_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.device_locations
    ADD CONSTRAINT device_locations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.device_otps
    ADD CONSTRAINT device_otps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_device_uuid_unique UNIQUE (device_uuid);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_uuid_unique UNIQUE (uuid);

ALTER TABLE ONLY public.geofence_rules
    ADD CONSTRAINT geofence_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_batches
    ADD CONSTRAINT job_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.live_recordings
    ADD CONSTRAINT live_recordings_egress_id_unique UNIQUE (egress_id);

ALTER TABLE ONLY public.live_recordings
    ADD CONSTRAINT live_recordings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.model_has_permissions
    ADD CONSTRAINT model_has_permissions_pkey PRIMARY KEY (permission_id, model_id, model_type);

ALTER TABLE ONLY public.model_has_roles
    ADD CONSTRAINT model_has_roles_pkey PRIMARY KEY (role_id, model_id, model_type);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_unique_site_code_unique UNIQUE (unique_site_code);

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (email);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_name_guard_name_unique UNIQUE (name, guard_name);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_token_unique UNIQUE (token);

ALTER TABLE ONLY public.role_has_permissions
    ADD CONSTRAINT role_has_permissions_pkey PRIMARY KEY (permission_id, role_id);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_guard_name_unique UNIQUE (name, guard_name);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.telegram_bindings
    ADD CONSTRAINT telegram_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_telegram_user_id_unique UNIQUE (telegram_user_id);

ALTER TABLE ONLY public.user_site_access
    ADD CONSTRAINT user_site_access_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_site_access
    ADD CONSTRAINT user_site_access_user_id_organization_id_unique UNIQUE (user_id, organization_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);

ALTER TABLE ONLY public.violation_logs
    ADD CONSTRAINT violation_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_session_events
    ADD CONSTRAINT work_session_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_sessions
    ADD CONSTRAINT work_sessions_pkey PRIMARY KEY (id);

CREATE INDEX activity_log_log_name_id_index ON public.activity_log USING btree (log_name, id);

CREATE INDEX activity_log_log_name_index ON public.activity_log USING btree (log_name);

CREATE INDEX activity_log_organization_id_id_index ON public.activity_log USING btree (organization_id, id);

CREATE INDEX apk_builds_apk_type_index ON public.apk_builds USING btree (apk_type);

CREATE INDEX apk_builds_built_by_index ON public.apk_builds USING btree (built_by);

CREATE INDEX apk_builds_embedded_site_code_index ON public.apk_builds USING btree (embedded_site_code);

CREATE INDEX apk_builds_organization_id_index ON public.apk_builds USING btree (organization_id);

CREATE INDEX apk_builds_status_index ON public.apk_builds USING btree (status);

CREATE INDEX briefings_ended_at_index ON public.briefings USING btree (ended_at);

CREATE INDEX cache_expiration_index ON public.cache USING btree (expiration);

CREATE INDEX cache_locks_expiration_index ON public.cache_locks USING btree (expiration);

CREATE INDEX causer ON public.activity_log USING btree (causer_type, causer_id);

CREATE INDEX chat_messages_organization_id_id_index ON public.chat_messages USING btree (organization_id, id);

CREATE INDEX consent_documents_created_by_index ON public.consent_documents USING btree (created_by);

CREATE INDEX consent_documents_organization_id_index ON public.consent_documents USING btree (organization_id);

CREATE INDEX consent_documents_updated_by_index ON public.consent_documents USING btree (updated_by);

CREATE INDEX device_commands_device_id_status_index ON public.device_commands USING btree (device_id, status);

CREATE INDEX device_commands_issued_by_index ON public.device_commands USING btree (issued_by);

CREATE INDEX device_locations_device_id_recorded_at_index ON public.device_locations USING btree (device_id, recorded_at);

CREATE INDEX device_otps_device_id_expires_at_index ON public.device_otps USING btree (device_id, expires_at);

CREATE INDEX devices_consent_document_id_index ON public.devices USING btree (consent_document_id);

CREATE INDEX devices_created_by_index ON public.devices USING btree (created_by);

CREATE INDEX devices_organization_id_index ON public.devices USING btree (organization_id);

CREATE INDEX devices_status_index ON public.devices USING btree (status);

CREATE INDEX devices_updated_by_index ON public.devices USING btree (updated_by);

CREATE INDEX failed_jobs_connection_queue_failed_at_index ON public.failed_jobs USING btree (connection, queue, failed_at);

CREATE INDEX geofence_rules_anchor_device_id_index ON public.geofence_rules USING btree (anchor_device_id);

CREATE INDEX geofence_rules_created_by_index ON public.geofence_rules USING btree (created_by);

CREATE INDEX geofence_rules_organization_id_index ON public.geofence_rules USING btree (organization_id);

CREATE INDEX geofence_rules_updated_by_index ON public.geofence_rules USING btree (updated_by);

CREATE INDEX jobs_queue_index ON public.jobs USING btree (queue);

CREATE INDEX live_recordings_organization_id_started_at_index ON public.live_recordings USING btree (organization_id, started_at);

CREATE INDEX live_recordings_status_started_at_index ON public.live_recordings USING btree (status, started_at);

CREATE INDEX live_recordings_user_id_started_at_index ON public.live_recordings USING btree (user_id, started_at);

CREATE INDEX model_has_permissions_model_id_model_type_index ON public.model_has_permissions USING btree (model_id, model_type);

CREATE INDEX model_has_roles_model_id_model_type_index ON public.model_has_roles USING btree (model_id, model_type);

CREATE INDEX personal_access_tokens_expires_at_index ON public.personal_access_tokens USING btree (expires_at);

CREATE INDEX personal_access_tokens_tokenable_type_tokenable_id_index ON public.personal_access_tokens USING btree (tokenable_type, tokenable_id);

CREATE INDEX role_has_permissions_role_id_index ON public.role_has_permissions USING btree (role_id);

CREATE INDEX sessions_last_activity_index ON public.sessions USING btree (last_activity);

CREATE INDEX sessions_user_id_index ON public.sessions USING btree (user_id);

CREATE INDEX subject ON public.activity_log USING btree (subject_type, subject_id);

CREATE INDEX telegram_bindings_created_by_index ON public.telegram_bindings USING btree (created_by);

CREATE INDEX telegram_bindings_organization_id_index ON public.telegram_bindings USING btree (organization_id);

CREATE INDEX telegram_bindings_updated_by_index ON public.telegram_bindings USING btree (updated_by);

CREATE INDEX user_site_access_granted_by_index ON public.user_site_access USING btree (granted_by);

CREATE INDEX user_site_access_organization_id_index ON public.user_site_access USING btree (organization_id);

CREATE INDEX users_organization_id_index ON public.users USING btree (organization_id);

CREATE INDEX violation_logs_device_id_detected_at_index ON public.violation_logs USING btree (device_id, detected_at);

CREATE INDEX violation_logs_geofence_rule_id_index ON public.violation_logs USING btree (geofence_rule_id);

CREATE INDEX work_session_events_organization_id_occurred_at_index ON public.work_session_events USING btree (organization_id, occurred_at);

CREATE INDEX work_session_events_user_id_occurred_at_index ON public.work_session_events USING btree (user_id, occurred_at);

CREATE INDEX work_sessions_ended_at_last_heartbeat_at_index ON public.work_sessions USING btree (ended_at, last_heartbeat_at);

CREATE UNIQUE INDEX work_sessions_one_open_per_user ON public.work_sessions USING btree (user_id) WHERE (ended_at IS NULL);

CREATE INDEX work_sessions_organization_id_ended_at_index ON public.work_sessions USING btree (organization_id, ended_at);

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.apk_builds
    ADD CONSTRAINT apk_builds_built_by_foreign FOREIGN KEY (built_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.apk_builds
    ADD CONSTRAINT apk_builds_device_id_foreign FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.apk_builds
    ADD CONSTRAINT apk_builds_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_host_user_id_foreign FOREIGN KEY (host_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_reply_to_id_foreign FOREIGN KEY (reply_to_id) REFERENCES public.chat_messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.consent_documents
    ADD CONSTRAINT consent_documents_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.consent_documents
    ADD CONSTRAINT consent_documents_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.consent_documents
    ADD CONSTRAINT consent_documents_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_device_id_foreign FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_issued_by_foreign FOREIGN KEY (issued_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.device_locations
    ADD CONSTRAINT device_locations_device_id_foreign FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.device_otps
    ADD CONSTRAINT device_otps_device_id_foreign FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_consent_document_id_foreign FOREIGN KEY (consent_document_id) REFERENCES public.consent_documents(id);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.geofence_rules
    ADD CONSTRAINT geofence_rules_anchor_device_id_foreign FOREIGN KEY (anchor_device_id) REFERENCES public.devices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.geofence_rules
    ADD CONSTRAINT geofence_rules_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.geofence_rules
    ADD CONSTRAINT geofence_rules_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.geofence_rules
    ADD CONSTRAINT geofence_rules_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.live_recordings
    ADD CONSTRAINT live_recordings_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.live_recordings
    ADD CONSTRAINT live_recordings_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.live_recordings
    ADD CONSTRAINT live_recordings_work_session_id_foreign FOREIGN KEY (work_session_id) REFERENCES public.work_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.model_has_permissions
    ADD CONSTRAINT model_has_permissions_permission_id_foreign FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.model_has_roles
    ADD CONSTRAINT model_has_roles_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.role_has_permissions
    ADD CONSTRAINT role_has_permissions_permission_id_foreign FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.role_has_permissions
    ADD CONSTRAINT role_has_permissions_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.telegram_bindings
    ADD CONSTRAINT telegram_bindings_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.telegram_bindings
    ADD CONSTRAINT telegram_bindings_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.telegram_bindings
    ADD CONSTRAINT telegram_bindings_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_site_access
    ADD CONSTRAINT user_site_access_granted_by_foreign FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.user_site_access
    ADD CONSTRAINT user_site_access_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_site_access
    ADD CONSTRAINT user_site_access_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.violation_logs
    ADD CONSTRAINT violation_logs_device_id_foreign FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.violation_logs
    ADD CONSTRAINT violation_logs_geofence_rule_id_foreign FOREIGN KEY (geofence_rule_id) REFERENCES public.geofence_rules(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_session_events
    ADD CONSTRAINT work_session_events_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_session_events
    ADD CONSTRAINT work_session_events_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_session_events
    ADD CONSTRAINT work_session_events_work_session_id_foreign FOREIGN KEY (work_session_id) REFERENCES public.work_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_sessions
    ADD CONSTRAINT work_sessions_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_sessions
    ADD CONSTRAINT work_sessions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
