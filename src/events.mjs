import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateEventName(value, label = "event") {
  if (!SAFE_NAME.test(value ?? "")) throw new Error(`${label} 只能使用 1～64 個英數、點、底線或連字號`);
  return value;
}

export function eventFilePath(root, target) {
  validateEventName(target, "target");
  return `${root.replace(/[\\/]+$/, "")}/${target}.jsonl`;
}

export async function recordEvent({ root = "reports/events", target, event, phase, at = new Date() }) {
  validateEventName(target, "target");
  validateEventName(event, "event");
  if (!["start", "end", "point"].includes(phase)) throw new Error("phase 必須是 start、end 或 point");
  const path = eventFilePath(root, target);
  const record = { schema_version: "1.0", target, event, phase, at: at.toISOString() };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return { path, record };
}

export async function loadEvents(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`事件檔第 ${index + 1} 行不是合法 JSON`);
    }
  });
}

export function hasCompletedEvent(events, eventName, start, end, target) {
  if (typeof target !== "string" || !target.trim()) return false;
  const matching = events
    .filter((event) => event.target === target && event.event === eventName && Date.parse(event.at) >= Date.parse(start) && Date.parse(event.at) < Date.parse(end))
    .sort((a, b) => Date.parse(a.at)-Date.parse(b.at));
  let open = false;
  for (const event of matching) {
    if (event.phase === "point") return true;
    if (event.phase === "start") open = true;
    if (event.phase === "end" && open) return true;
  }
  return false;
}
