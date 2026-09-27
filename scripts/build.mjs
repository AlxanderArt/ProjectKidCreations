import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const THREE_MODULE = resolve("node_modules/three/build/three.module.js");
const INLINE_STYLE_ANCHOR = "\tcanvas.style.display = 'block';\n";

const stripThreeInlineStyle = {
  name: "strip-three-inline-style",
  setup(esbuild) {
    esbuild.onLoad({ filter: /three\.module\.js$/ }, async (args) => {
      if (resolve(args.path) !== THREE_MODULE) return null;
      const source = await readFile(args.path, "utf8");
      const occurrences = source.split(INLINE_STYLE_ANCHOR).length - 1;
      if (occurrences !== 1) {
        throw new Error(`Expected exactly one Three.js inline-style anchor; found ${occurrences}`);
      }
      return { contents: source.replace(INLINE_STYLE_ANCHOR, ""), loader: "js" };
    });
  },
};

const result = await build({
  entryPoints: ["src/landing.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  jsx: "automatic",
  target: "es2020",
  outdir: "dist",
  splitting: true,
  sourcemap: "linked",
  legalComments: "none",
  metafile: true,
  entryNames: "[name]",
  external: ["/assets/*"],
  plugins: [stripThreeInlineStyle],
});

await build({
  entryPoints: ["assets/pkc-motion/boot/pkc-boot.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outfile: "dist/pkc-motion.js",
  sourcemap: "linked",
  legalComments: "none",
});

await build({
  entryPoints: ["assets/pkc-motion/boot/pkc-boot-renderer.js"],
  bundle: false,
  minify: true,
  target: "es2020",
  outfile: "dist/pkc-boot-renderer.js",
  legalComments: "none",
});

await writeFile("dist/landing.meta.json", `${JSON.stringify(result.metafile, null, 2)}\n`);
