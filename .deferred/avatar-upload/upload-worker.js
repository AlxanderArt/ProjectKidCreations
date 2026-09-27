/* ProjectKidCreations — phase-three/upload-worker.js
 * Avatar upload pipeline. Loaded as a regular script (not a Web Worker).
 *
 * Public API:
 *   window.PKC_AVATAR.processAndUpload(file, token, {
 *     onValidate, onResize, onUploadStart, onProgress, onSuccess, onError
 *   })
 *
 * Pipeline:
 *   1. validate type + size
 *   2. createImageBitmap (fallback: HTMLImageElement)
 *   3. OffscreenCanvas downscale (fallback: <canvas>) to <= MAX_DIM
 *   4. canvas.toBlob('image/webp', 0.85) (fallback: image/jpeg)
 *   5. POST multipart/form-data to /api/avatar-upload with Bearer token
 *   6. expects upstream response { ok, url, key, bytes }
 */

(function () {
  "use strict";

  const CFG = window.PKC_PHASE_THREE || {};
  const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_BYTES = CFG.AVATAR_MAX_BYTES || (2 * 1024 * 1024);
  const MAX_DIM = CFG.AVATAR_MAX_DIM || 1024;
  const UPLOAD_URL = CFG.AVATAR_UPLOAD_URL || "/api/avatar-upload";

  const supportsOffscreen = typeof OffscreenCanvas !== "undefined";
  const supportsBitmap = typeof createImageBitmap === "function";

  // ── validation ──────────────────────────────────────────

  function validateFile(file) {
    if (!file) return "No file selected.";
    if (!ALLOWED_TYPES.has(file.type)) return "Use JPEG, PNG, or WEBP.";
    if (file.size > MAX_BYTES) {
      const mb = (MAX_BYTES / (1024 * 1024)).toFixed(0);
      return `Image must be ≤${mb}MB.`;
    }
    return null;
  }

  // ── decode → bitmap (with fallback) ─────────────────────

  async function decode(file) {
    if (supportsBitmap) {
      try { return await createImageBitmap(file); } catch (_) { /* fall through */ }
    }
    // Fallback: HTMLImageElement + URL.createObjectURL
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't decode image.")); };
      img.src = url;
    });
  }

  // ── downscale to MAX_DIM (longest edge) ─────────────────

  function computeTarget(srcW, srcH) {
    if (srcW <= MAX_DIM && srcH <= MAX_DIM) return { w: srcW, h: srcH };
    const ratio = srcW / srcH;
    if (srcW >= srcH) return { w: MAX_DIM, h: Math.round(MAX_DIM / ratio) };
    return { w: Math.round(MAX_DIM * ratio), h: MAX_DIM };
  }

  async function downscaleAndEncode(bitmap) {
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    const { w, h } = computeTarget(srcW, srcH);

    let canvas, ctx;
    if (supportsOffscreen) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext("2d");
    } else {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext("2d");
    }
    if (!ctx) throw new Error("Canvas not available.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);

    // Prefer WebP at 0.85. If WebP unsupported, fall back to JPEG.
    return await canvasToBlobBestEffort(canvas);
  }

  async function canvasToBlobBestEffort(canvas) {
    const tryEncode = (type, q) => new Promise((resolve) => {
      if (typeof canvas.convertToBlob === "function") {
        canvas.convertToBlob({ type, quality: q }).then(resolve).catch(() => resolve(null));
      } else if (typeof canvas.toBlob === "function") {
        canvas.toBlob((b) => resolve(b), type, q);
      } else {
        resolve(null);
      }
    });

    let blob = await tryEncode("image/webp", 0.85);
    if (blob && blob.size > 0) return { blob, mime: "image/webp", ext: "webp" };

    blob = await tryEncode("image/jpeg", 0.85);
    if (blob && blob.size > 0) return { blob, mime: "image/jpeg", ext: "jpg" };

    throw new Error("Encoding failed.");
  }

  // ── upload ──────────────────────────────────────────────

  function uploadWithProgress({ blob, mime, ext }, token, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      const filename = `avatar.${ext}`;
      fd.append("file", blob, filename);
      fd.append("mime", mime);
      fd.append("bytes", String(blob.size));

      const xhr = new XMLHttpRequest();
      xhr.open("POST", UPLOAD_URL, true);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.responseType = "text";

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.min(0.99, e.loaded / e.total));
        }
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          return reject(new Error(`Upload failed (${xhr.status}).`));
        }
        let data;
        try { data = JSON.parse(xhr.responseText || "{}"); }
        catch { return reject(new Error("Bad upload response.")); }
        if (!data.ok || !data.url) {
          return reject(new Error(data.message || "Upload rejected."));
        }
        if (onProgress) onProgress(1);
        resolve(data);
      };
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.onabort = () => reject(new Error("Upload aborted."));
      xhr.send(fd);
    });
  }

  // ── orchestrator ────────────────────────────────────────

  async function processAndUpload(file, token, hooks) {
    hooks = hooks || {};

    const validationErr = validateFile(file);
    if (validationErr) {
      if (hooks.onError) hooks.onError(new Error(validationErr));
      return null;
    }
    if (hooks.onValidate) hooks.onValidate({ name: file.name, size: file.size, type: file.type });

    let bitmap;
    try {
      bitmap = await decode(file);
    } catch (err) {
      if (hooks.onError) hooks.onError(err);
      return null;
    }

    let encoded;
    try {
      encoded = await downscaleAndEncode(bitmap);
      if (hooks.onResize) {
        hooks.onResize({
          originalBytes: file.size,
          encodedBytes: encoded.blob.size,
          mime: encoded.mime,
          width: Math.min(bitmap.width, MAX_DIM),
          height: Math.min(bitmap.height, MAX_DIM)
        });
      }
    } catch (err) {
      if (hooks.onError) hooks.onError(err);
      return null;
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }

    if (hooks.onUploadStart) hooks.onUploadStart();

    try {
      const result = await uploadWithProgress(
        encoded,
        token,
        hooks.onProgress
      );
      if (hooks.onSuccess) hooks.onSuccess(result);
      return result;
    } catch (err) {
      if (hooks.onError) hooks.onError(err);
      return null;
    }
  }

  window.PKC_AVATAR = { processAndUpload, validateFile };
})();
