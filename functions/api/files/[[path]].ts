// Cloudflare Pages Function: /api/files/* → the CMS file service on the private R2 bucket.
// Bindings and variables (Pages project settings; see docs/sambit-checklist.md):
//   CMS_SOURCES            R2 bucket binding → bucket "cms-sources"
//   ACCESS_TEAM_DOMAIN     e.g. witoscope.cloudflareaccess.com
//   ACCESS_AUD             the Access application's AUD tag
//   ACCESS_ALLOWED_EMAILS  Sambit's email
//   FILES_SIGNING_KEY      secret, ≥ 32 random characters
import { handleFiles, type Bucket, type FilesEnv } from '../../_lib/files.ts';

export const onRequest = (ctx: { request: Request; env: FilesEnv & { CMS_SOURCES: Bucket } }) =>
  handleFiles(ctx.request, ctx.env, ctx.env.CMS_SOURCES);
