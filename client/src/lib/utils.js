import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString();
}

export function fmtUsd(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "$0.00";
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(digits)}`;
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "—";
  const v = Number(ms);
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

export function fmtPct(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return "—";
  return `${Number(p).toFixed(1)}%`;
}

export function fmtBytes(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return "0 B";
  const b = Number(bytes);
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

// Convert UTC epoch bucket timestamps into the browser's local timezone (e.g. GMT+7).
export function fmtBucketLabel(row, xKey = "bucket", { short = false } = {}) {
  const ts = row?.bucketTs;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts);
    const pad2 = (n) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const min = pad2(d.getMinutes());
    const raw = String(row?.[xKey] || "");
    const isDaily = xKey === "day" || (raw.length > 0 && raw.length <= 10 && !raw.includes(":"));
    if (isDaily) {
      return short ? `${mm}-${dd}` : `${yyyy}-${mm}-${dd}`;
    }
    return short ? `${dd} ${hh}:${min}` : `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
  const raw = String(row?.[xKey] || "");
  if (!short) return raw;
  return raw.length > 14 ? raw.slice(0, 14) : raw;
}
