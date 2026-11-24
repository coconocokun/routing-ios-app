const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "../../watch_app/targets/walk");
const target = path.resolve(__dirname, "../targets/walk");
fs.mkdirSync(target, { recursive: true });
const names = new Set(fs.readdirSync(source));
for (const file of fs.readdirSync(target, { withFileTypes: true })) {
  if (file.isFile() && file.name.endsWith(".swift") && !names.has(file.name)) {
    fs.unlinkSync(path.join(target, file.name));
  }
}
for (const name of names) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
}
