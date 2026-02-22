import { z } from 'zod/v3';
import { Toml } from '../../../util/schema-utils/index.ts';

const MiseToolOptions = z.object({
  // ubi backend only
  tag_regex: z.string().optional(),
  // github backend only
  version_prefix: z.string().optional(),
});
export type MiseToolOptions = z.infer<typeof MiseToolOptions>;

const MiseTool = z.union([
  z.string(),
  MiseToolOptions.extend({
    version: z.string().optional(),
  }),
  z.array(z.string()),
]);
export type MiseTool = z.infer<typeof MiseTool>;

const MiseMinVersion = z.union([
  z.string(),
  z.object({
    hard: z.string().optional(),
    soft: z.string().optional(),
  }),
]);
export type MiseMinVersion = z.infer<typeof MiseMinVersion>;

export const MiseFile = Toml.pipe(
  z.object({
    min_version: MiseMinVersion.optional(),
    tools: z.record(MiseTool),
  }),
);
export type MiseFile = z.infer<typeof MiseFile>;
