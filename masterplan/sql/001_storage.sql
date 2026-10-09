-- MasterPlan Digital storage on Supabase. Run once (it is safe to run again).
--
--   public.mp_records   the small JSON records: members, report status, the
--                       Library, the queue, the drafts. One row per key.
--   storage "masterplan" the files: PDFs, podcasts and the submitted resume.
--
-- Only the server reads or writes either one, with the secret key. Row level
-- security is on with no policies and the bucket is private, so the
-- publishable/anon key opens nothing.

create table if not exists public.mp_records (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.mp_records enable row level security;
revoke all on table public.mp_records from anon, authenticated;
grant select, insert, update, delete on table public.mp_records to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'masterplan', 'masterplan', false, 26214400,
  array['application/pdf', 'audio/mpeg', 'application/json', 'application/octet-stream']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
