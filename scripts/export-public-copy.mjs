#!/usr/bin/env node

import { mkdir, readFile, writeFile, lstat, realpath, chmod } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORBIDDEN_PATH = /(^|\/)(?:reports|node_modules|\.git|\.aws|\.ssh|STATUS\.md)(?:\/|$)|(^|\/)\.env(?!\.example$)|[.]local[.]|[.](?:pem|key|p12|pfx)$|(^|\/)(?:credentials|id_rsa|id_ed25519)/i;
const FORBIDDEN_CONTENT = [
  /AKIA[0-9A-Z]{16}/, /ASIA[0-9A-Z]{16}/, /BEGIN (?:[A-Z ]+)?PRIVATE KEY/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];
function safeRelative(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path)
    && !path.includes("\\") && !path.includes(":")
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}
async function readContained(root, path) {
  if (!safeRelative(path) || FORBIDDEN_PATH.test(path) || path === "config/hosts.tsv") throw new Error("公開清單包含不允許的路徑");
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("公開來源不允許 symlink 或 junction");
  }
  const resolved = await realpath(cursor);
  if (!resolved.startsWith(root + sep) || !(await lstat(cursor)).isFile()) throw new Error("公開來源超出邊界或不是一般檔案");
  return readFile(cursor);
}

export async function exportPublicCopy(sourceRoot, destination, { privateTerms = [] } = {}) {
  const source = await realpath(resolve(sourceRoot));
  const target = resolve(destination);
  if (target === source) throw new Error("公開版目的地不可與來源 repo 相同");

  const manifest = JSON.parse(await readContained(source, "config/public-files.json"));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("公開檔案清單無效");
  const terms = [...privateTerms];
  try {
    const localPath = join(source, "config/public-export.local.json");
    if ((await lstat(localPath)).isSymbolicLink()) throw new Error("私人規則不可為連結");
    const local = JSON.parse(await readFile(localPath, "utf8"));
    if (!Array.isArray(local.forbidden_terms)) throw new Error("私人規則格式錯誤");
    terms.push(...local.forbidden_terms);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (terms.some((term) => typeof term !== "string" || !term.trim())) throw new Error("私人規則必須是非空字串");
  const buffers = new Map();
  for (const item of manifest) {
    const from = typeof item === "string" ? item : item.source;
    const to = typeof item === "string" ? item : item.destination;
    if (!safeRelative(to) || FORBIDDEN_PATH.test(to) || buffers.has(to.toLowerCase())) throw new Error("公開輸出路徑無效或重複");
    const content = await readContained(source, from);
    const text = content.toString("utf8");
    if (content.includes(0) || FORBIDDEN_CONTENT.some((pattern) => pattern.test(text))
      || terms.some((term) => (text + from + to).toLowerCase().includes(term.toLowerCase()))) {
      throw new Error("公開內容掃描失敗；未建立副本，請在本機檢閱來源");
    }
    const sourceMode = (await lstat(join(source, from))).mode;
    // Shebangs preserve launcher usability when exporting from Windows, where
    // filesystem modes do not carry Git's executable bit. Never copy special bits.
    const mode = (sourceMode & 0o111) || text.startsWith("#!") ? 0o755 : 0o644;
    buffers.set(to.toLowerCase(), { path: to, content, mode });
  }

  await mkdir(target);
  for (const { path, content, mode } of buffers.values()) {
    const output = join(target, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content, { flag: "wx", mode });
    await chmod(output, mode);
  }
  return { destination: target, files: buffers.size };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const destination = process.argv[2];
  if (!destination) {
    console.error("Usage: node scripts/export-public-copy.mjs <new-empty-directory>");
    process.exitCode = 2;
  } else {
    try {
      const result = await exportPublicCopy(process.cwd(), destination);
      console.log(`公開草稿已匯出至 ${relative(process.cwd(), result.destination)}（${result.files} files）；仍須完成發布驗收`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
