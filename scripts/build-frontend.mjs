import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("app/static/vendor", { recursive: true });
await build({
  entryPoints: ["frontend/markdown.js"],
  bundle: true,
  minify: true,
  outfile: "app/static/vendor/markdown.js",
  legalComments: "external",
});
await cp("node_modules/katex/dist/katex.min.css", "app/static/vendor/katex.min.css");
await cp("node_modules/katex/dist/fonts", "app/static/vendor/fonts", { recursive: true });
await cp("node_modules/katex/LICENSE", "app/static/vendor/KATEX-LICENSE");
await mkdir("app/static/vendor/licenses", { recursive: true });
for (const [name, file] of Object.entries({
  dompurify: "LICENSE",
  "markdown-it": "LICENSE",
  "markdown-it-texmath": "license.txt",
  entities: "LICENSE",
  "linkify-it": "LICENSE",
  mdurl: "LICENSE",
  "punycode.js": "LICENSE-MIT.txt",
  "uc.micro": "LICENSE.txt",
})) {
  await cp(`node_modules/${name}/${file}`, `app/static/vendor/licenses/${name}.txt`);
}
