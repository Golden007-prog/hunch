/** Inline policy stays bound to the record revision and its atomic JSON write. */
import { z } from 'zod';
const principalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/);
export const RecordVisibilitySchema = z.object({
  owner: principalId,
  readers: z.array(principalId).max(256),
  writers: z.array(principalId).max(256),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.readers).size !== value.readers.length || new Set(value.writers).size !== value.writers.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'visibility lists must contain distinct principal IDs' });
  if (value.writers.some(id => id !== value.owner && !value.readers.includes(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'every writer must also be a reader' });
});
export type RecordVisibility = z.infer<typeof RecordVisibilitySchema>;
export function visibilityAllows(record: unknown, id: string, mode: 'read' | 'write' = 'read'): boolean {
  if (!record || typeof record !== 'object') return false;
  const raw = (record as { visibility?: unknown }).visibility;
  if (raw === undefined) return true;
  const parsed = RecordVisibilitySchema.safeParse(raw);
  if (!parsed.success) return false;
  return parsed.data.owner === id || (mode === 'read' ? parsed.data.readers : parsed.data.writers).includes(id);
}
