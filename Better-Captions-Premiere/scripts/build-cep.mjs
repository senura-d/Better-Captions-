// Builds the CEP (Window > Extensions) version of Better Captions into
// cep-dist/com.bettercaptions.cep, ready to copy into the CEP extensions folder.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "cep-dist", "com.bettercaptions.cep");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// The panel UI is the same Svelte app the UXP plugin shows in its webview,
// bundled into one self-contained HTML file.
execSync(`npx vite build --outDir "${path.join(out, "client")}" --emptyOutDir`, {
  cwd: path.join(root, "webview-ui"),
  stdio: "inherit",
});

fs.cpSync(path.join(root, "cep", "CSXS"), path.join(out, "CSXS"), { recursive: true });
fs.cpSync(path.join(root, "cep", "host"), path.join(out, "host"), { recursive: true });
fs.cpSync(path.join(root, "public", "icons"), path.join(out, "icons"), { recursive: true });

console.log(`CEP extension built: ${out}`);
