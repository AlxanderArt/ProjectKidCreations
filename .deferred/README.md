# Deferred surfaces

Files here are committed but not on the active route surface. Move them back to `api/` when their dependencies are set up.

## avatar-upload.js.gated-on-supabase
Phase 3 avatar upload Edge function. Gated on:
- Vercel env var `BLOB_READ_WRITE_TOKEN` set
- `@vercel/blob` import works in Edge runtime (may need `"type": "module"` in package.json or runtime change to `nodejs`)

To restore: `git mv .deferred/avatar-upload.js.gated-on-supabase api/avatar-upload.js`
