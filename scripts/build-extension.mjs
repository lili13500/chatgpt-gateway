import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "dist", "chrome-extension");
await fs.mkdir(target, { recursive: true });
const files = ["manifest.json", "background.js", "content.js", "popup.html", "popup.js"];
for (const name of files) {
  await fs.copyFile(path.join(root, name), path.join(target, name));
}
await fs.cp(path.join(root, "icons"), path.join(target, "icons"), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3 || !manifest.background.service_worker) {
  throw Error("CHROME_MANIFEST_INVALID");
}
console.log("CHROME_EXTENSION_READY=" + target);
