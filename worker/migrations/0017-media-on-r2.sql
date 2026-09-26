-- Catalogue photos moved from the storefront's /media/ to R2 behind
-- media.nexusohm.com on 2026-09-26 (scripts/upload-media.mjs, every key
-- HEAD-verified). Merchant uploads are absolute nexus-api URLs and never
-- contain the quoted relative prefix, so they are untouched.
--
--   cd worker
--   npx wrangler d1 execute <db> --remote --file=migrations/0017-media-on-r2.sql
UPDATE products SET media = REPLACE(media, '"/media/', '"https://media.nexusohm.com/')
 WHERE media LIKE '%"/media/%';
