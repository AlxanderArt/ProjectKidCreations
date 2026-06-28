# Deferred surfaces

Files here are committed but not on the active route surface. Move them back to `api/` when their dependencies are set up.

## avatar-upload.js.gated-on-supabase
Phase 3 avatar upload Edge function. Gated on:
- Vercel env var `BLOB_READ_WRITE_TOKEN` set
- `@vercel/blob` import works in Edge runtime (may need `"type": "module"` in package.json or runtime change to `nodejs`)

To restore: `git mv .deferred/avatar-upload.js.gated-on-supabase api/avatar-upload.js`

## upload-worker.js.gated-on-supabase
Phase 3 client-side avatar pipeline (validate → downscale → POST to `/api/avatar-upload`).
Parked alongside the Edge function: with no upload endpoint live, the Phase Three
dropzone is disabled in `phase-three/index.html` (a "coming soon" panel) and this
script is not included so no broken upload can be triggered. `@vercel/blob` was also
removed from `package.json` while the feature is deferred (cleared a high-severity
`undici` audit advisory).

To restore (when Blob is provisioned):
1. `git mv .deferred/upload-worker.js.gated-on-supabase phase-three/upload-worker.js`
2. `git mv .deferred/avatar-upload.js.gated-on-supabase api/avatar-upload.js`
3. Re-add `@vercel/blob` to `package.json` (a version whose transitive `undici` is patched).
4. Restore the interactive dropzone + `AVATAR_UPLOAD_URL` / `AVATAR_MAX_*` config + the
   `<script src="upload-worker.js">` include in `phase-three/index.html` (see git history of this commit).
