-- Durable public media for Instagram publishing.
-- The application uses the service-role key for uploads; public read is required
-- because Meta's servers must be able to fetch the media URL without a session.

insert into storage.buckets (id, name, public)
values ('fullsend-creative', 'fullsend-creative', true)
on conflict (id) do update set public = true;

drop policy if exists fullsend_creative_public_read on storage.objects;
create policy fullsend_creative_public_read
on storage.objects for select
using (bucket_id = 'fullsend-creative');

drop policy if exists fullsend_creative_service_insert on storage.objects;
create policy fullsend_creative_service_insert
on storage.objects for insert
to service_role
with check (bucket_id = 'fullsend-creative');

drop policy if exists fullsend_creative_service_update on storage.objects;
create policy fullsend_creative_service_update
on storage.objects for update
to service_role
using (bucket_id = 'fullsend-creative')
with check (bucket_id = 'fullsend-creative');
