// Cloudflare Pages Function: /api/images/* → the CMS image service (Images PR, DL-040).
// Variables (Pages project settings): IMAGE_PROVIDER (unset = "Image service not set up"), and for a real provider later
// IMAGE_API_KEY (secret) and IMAGE_MODEL; IMAGE_DAILY_CAP_USD with a KV binding when the daily cap is added (Q6).
// R2 binding CMS_SOURCES (the same private bucket as /api/files); ACCESS_* as for /api/files.
import { handleImages, type ImagesEnv } from '../../_lib/images.ts';
import type { Bucket } from '../../_lib/files.ts';

export const onRequest = (ctx: { request: Request; env: ImagesEnv & { CMS_SOURCES: Bucket } }) => handleImages(ctx.request, ctx.env, ctx.env.CMS_SOURCES);
