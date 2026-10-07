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
  list(ownerId: string, page: number): Promise<NotePage>;
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
  async list(ownerId, page) {
    if (!Number.isInteger(page) || page < 0) {
      throw new RangeError('Note page must be a nonnegative integer.');
    }
    const size = 50;
    const { data, error } = await client
      .from('notes')
      .select('*')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * size, page * size + size);
    if (error !== null) {
      throw new Error(`Supabase notes repository: ${error.message}`);
    }
    const rows = data ?? [];
    const hasMore = rows.length > size;
    const notes = rows.slice(0, size).map(toNote);
    return {
      notes,
      serverTime: Date.now(),
      nextCursor: hasMore ? String(page + 1) : null,
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
