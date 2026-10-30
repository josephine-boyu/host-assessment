const DAY = 86400000;

export function parseObservationWindow(start, end, { now = new Date(), maxDays = 35 } = {}) {
  function timestamp(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error("起訖時間必須包含時區（Z 或 ±HH:MM），且對齊整分鐘");
    }
    const date = new Date(value);
    const calendar = value.slice(0, 10);
    const midnight = new Date(`${calendar}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendar
      || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) throw new Error("起訖時間不是有效日期");
    return date.toISOString();
  }
  const from = timestamp(start), to = timestamp(end);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > maxDays * DAY) throw new Error(`區間長度必須大於零且不超過 ${maxDays} 天`);
  if (Date.parse(to) > now.getTime()) throw new Error("結束時間不可在未來");
  return { start: from, end: to, days: duration / DAY, timezone: "UTC", completed_days_only: Date.parse(from) % DAY === 0 && Date.parse(to) % DAY === 0 };
}

export function splitUtcWindow(window) {
  const segments = [];
  const end = Date.parse(window.end);
  for (let start = Date.parse(window.start); start < end;) {
    const finish = Math.min(Math.floor(start / DAY) * DAY + DAY, end);
    segments.push({ start: new Date(start), end: new Date(finish), seconds: (finish-start)/1000, date: new Date(start).toISOString().slice(0,10) });
    start = finish;
  }
  return segments;
}
