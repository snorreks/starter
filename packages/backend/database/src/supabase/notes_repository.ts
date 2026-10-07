import type { Note, NoteCreate, NoteUpdate } from '@starter/schemas/notes';
import type { SupabaseClient } from './client.ts';
import type { Database } from './database.types.ts';

export interface NotePage {
  notes: Note[];
  serverTime: number;
  nextCursor: string | null;
  hasMore: boolean;
}
export interface NotesRepository {
  list(ownerId: string, cursor: string | null, limit?: number): Promise<NotePage>;
  create(ownerId: string, input: NoteCreate): Promise<Note>;
  update(ownerId: string, id: string, input: NoteUpdate): Promise<Note | null>;
  remove(ownerId: string, id: string): Promise<boolean>;
}

const dbId = (id: string): string => (id.startsWith('note_') ? id.slice(5) : id);
const toNote = (row: Database['public']['Tables']['notes']['Row']): Note => ({
  id: `note_${row.id}`,
  ownerId: row.owner_id,
  title: row.title,
  body: row.body,
  createdAt: Date.parse(row.created_at),
  updatedAt: Date.parse(row.updated_at),
});
const checked = <T>(data: T | null, error: { message: string } | null): T => {
  if (error !== null) {
    throw new Error(`Supabase notes repository: ${error.message}`);
  }
  if (data === null) {
    throw new Error('Supabase notes repository returned no row.');
  }
  return data;
};

export const createSupabaseNotesRepository = (
  client: SupabaseClient<Database>,
): NotesRepository => ({
  async list(ownerId, cursor, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError('Note page limit must be between 1 and 50.');
    }
    const size = limit;
    let query = client.from('notes').select('*').eq('owner_id', ownerId);
    if (cursor !== null) {
      let decoded: { updatedAt: string; id: string };
      try {
        const parsed: unknown = JSON.parse(atob(cursor));
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('updatedAt' in parsed) ||
          !('id' in parsed) ||
          !('ownerId' in parsed) ||
          parsed.ownerId !== ownerId ||
          typeof parsed.updatedAt !== 'string' ||
          typeof parsed.id !== 'string'
        ) {
          throw new Error();
        }
        decoded = { updatedAt: parsed.updatedAt, id: parsed.id };
        if (
          !Number.isFinite(Date.parse(decoded.updatedAt)) ||
          new Date(decoded.updatedAt).toISOString() !== decoded.updatedAt ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            decoded.id,
          )
        ) {
          throw new Error();
        }
      } catch {
        throw new TypeError('Note cursor is malformed.');
      }
      query = query.or(
        `updated_at.lt.${decoded.updatedAt},and(updated_at.eq.${decoded.updatedAt},id.lt.${decoded.id})`,
      );
    }
    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(size + 1);
    if (error !== null) {
      throw new Error(`Supabase notes repository: ${error.message}`);
    }
    const rows = data ?? [];
    const hasMore = rows.length > size;
    const notes = rows.slice(0, size).map(toNote);
    return {
      notes,
      serverTime: Date.now(),
      nextCursor: hasMore
        ? btoa(
            JSON.stringify({
              ownerId,
              updatedAt: rows[size - 1]?.updated_at,
              id: rows[size - 1]?.id,
            }),
          )
        : null,
      hasMore,
    };
  },
  async create(ownerId, input) {
    const { data, error } = await client
      .from('notes')
      .insert({ owner_id: ownerId, ...input })
      .select('*')
      .single();
    return toNote(checked(data, error));
  },
  async update(ownerId, id, input) {
    const { data, error } = await client
      .from('notes')
      .update(input)
      .eq('owner_id', ownerId)
      .eq('id', dbId(id))
      .select('*')
      .maybeSingle();
    if (error !== null) {
      throw new Error(`Supabase notes repository: ${error.message}`);
    }
    return data === null ? null : toNote(data);
  },
  async remove(ownerId, id) {
    const { data, error } = await client
      .from('notes')
      .delete()
      .eq('owner_id', ownerId)
      .eq('id', dbId(id))
      .select('id');
    if (error !== null) {
      throw new Error(`Supabase notes repository: ${error.message}`);
    }
    return (data?.length ?? 0) === 1;
  },
});
