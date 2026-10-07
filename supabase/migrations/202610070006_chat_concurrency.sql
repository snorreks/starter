create or replace function public.admit_chat_generation(
  p_conversation_id uuid, p_client_id text, p_request_fingerprint text,
  p_user_message_id uuid, p_content text
) returns table(outcome text, assistant_message_id uuid, attempt integer)
language plpgsql security definer
set search_path = pg_catalog, public, private, auth
as $$
declare v_owner uuid := auth.uid(); v_row private.chat_generations%rowtype; v_bucket timestamptz := date_trunc('hour', now()); v_created boolean;
begin
  if v_owner is null then raise exception using errcode = '42501', message = 'authenticated identity required'; end if;
  if p_client_id is null or length(p_client_id) not between 1 and 118 or p_client_id like 'assistant:%' or p_request_fingerprint !~ '^[a-f0-9]{64}$' or length(p_content) not between 1 and 8000 then
    raise exception using errcode = '22023', message = 'invalid chat generation input';
  end if;
  if not exists(select 1 from public.conversations c where c.id = p_conversation_id and c.owner_id = v_owner) then
    raise exception using errcode = '42501', message = 'conversation ownership required';
  end if;
  -- Serialize one owner's admissions so independent Worker isolates share this cap.
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text, 0));
  insert into private.chat_generations(owner_id, conversation_id, client_id, request_fingerprint, user_message_id)
  values(v_owner, p_conversation_id, p_client_id, p_request_fingerprint, p_user_message_id)
  on conflict(owner_id, conversation_id, client_id) do nothing returning * into v_row;
  v_created := found;
  if v_created then
    if (select count(*) from private.chat_generations g where g.owner_id=v_owner and g.state='admitted') > 2 then
      raise exception using errcode='P0001', message='owner chat concurrency limit reached';
    end if;
    insert into private.admission_counters(owner_id, bucket_start, admitted) values(v_owner, v_bucket, 0)
    on conflict do nothing;
    update private.admission_counters set admitted = admitted + 1
      where owner_id = v_owner and bucket_start = v_bucket and admitted < 5;
    if not found then raise exception using errcode = 'P0001', message = 'chat admission limit reached'; end if;
  else
    select * into v_row from private.chat_generations g where g.owner_id=v_owner and g.conversation_id=p_conversation_id and g.client_id=p_client_id for update;
    if v_row.request_fingerprint = p_request_fingerprint and v_row.state in ('failed','cancelled') then
      update private.chat_generations as generation set state='admitted',attempt=generation.attempt+1,updated_at=now()
        where generation.owner_id=v_owner and generation.conversation_id=p_conversation_id and generation.client_id=p_client_id
        returning * into v_row;
      v_created := found;
      if v_created and (select count(*) from private.chat_generations g where g.owner_id=v_owner and g.state='admitted') > 2 then
        raise exception using errcode='P0001', message='owner chat concurrency limit reached';
      end if;
    end if;
  end if;
  if v_row.request_fingerprint <> p_request_fingerprint then
    raise exception using errcode = '23505', message = 'chat idempotency conflict';
  end if;
  if v_row.user_message_id = p_user_message_id and v_row.state = 'admitted' then
    insert into public.messages(id, conversation_id, author_id, role, content, client_id)
    values(p_user_message_id, p_conversation_id, v_owner, 'user', p_content, p_client_id)
    on conflict(conversation_id, client_id) do nothing;
  end if;
  update public.conversations set updated_at=now() where id=p_conversation_id and owner_id=v_owner;
  return query select case when v_row.state='completed' then 'completed' when v_created then 'admitted' else 'in_flight' end, v_row.assistant_message_id, v_row.attempt;
end;
$$;
