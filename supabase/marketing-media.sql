-- Marketing photos and videos the owner uploads in Marketing Studio → New content.
-- Public read (social platforms must fetch them); owners can only upload into their own business folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('marketing-media', 'marketing-media', true, 52428800)
on conflict (id) do nothing;
drop policy if exists "marketing media upload" on storage.objects;
create policy "marketing media upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'marketing-media' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists "marketing media delete" on storage.objects;
create policy "marketing media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'marketing-media' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
