import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDate,
  formatMessageTime,
  nextLocalMidnight,
  nextMessageTimeChange,
  whenDue,
} from "@/types";

// The pre-cache implementations, verbatim. The cached formatters must render
// byte-identical strings for every branch.
function oldFormatMessageTime(dateCreated: number): string {
  const date = new Date(dateCreated);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

const OLD_STYLE: Record<Parameters<typeof formatDate>[1], (d: Date) => string> = {
  time: (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  weekdayShort: (d) => d.toLocaleDateString([], { weekday: "short" }),
  weekdayLong: (d) => d.toLocaleDateString([], { weekday: "long" }),
  monthDay: (d) => d.toLocaleDateString([], { month: "short", day: "numeric", year: undefined }),
  monthDayYear: (d) => d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }),
  full: (d) => d.toLocaleString(),
};
const STYLES = Object.keys(OLD_STYLE) as Array<keyof typeof OLD_STYLE>;

// Zones with DST, half- and quarter-hour offsets, a 30-minute DST shift and
// the southern hemisphere.
const ZONES = [
  "Europe/Stockholm",
  "America/New_York",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Chatham",
  "America/St_Johns",
  "Australia/Lord_Howe",
  "UTC",
];

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 10, 30, 0);

/** Deterministic spread: 1970–2040, plus the hours around this year's DST shifts. */
function timestamps(): number[] {
  let seed = 0x2545f491;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: number[] = [0, -1, 1, -DAY * 365 * 50, 8.64e15, -8.64e15];
  for (let i = 0; i < 300; i++) out.push(Math.floor(rand() * Date.UTC(2040, 0, 1)));
  for (const shift of [Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1), Date.UTC(2026, 2, 8, 7)]) {
    for (let m = -180; m <= 180; m += 11) out.push(shift + m * 60_000);
  }
  return out;
}

const originalTZ = process.env.TZ;
let clock = NOW;

/** Switch the process time zone, and step the clock past the formatter recheck. */
function useZone(zone: string) {
  process.env.TZ = zone;
  clock += 1_000;
  vi.setSystemTime(clock);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe("formatDate", () => {
  it("matches toLocale*String for every style, across time zones", () => {
    const ts = timestamps();
    const mismatches: string[] = [];
    let compared = 0;
    for (const zone of ZONES) {
      useZone(zone);
      for (const t of ts) {
        const d = new Date(t);
        for (const style of STYLES) {
          const expected = OLD_STYLE[style](d);
          // Numbers and Date objects both, as callers pass either.
          for (const got of [formatDate(t, style), formatDate(d, style)]) {
            compared++;
            if (got !== expected) mismatches.push(`${zone} ${style} ${t}: ${got} != ${expected}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(ZONES.length * ts.length * STYLES.length * 2);
  });

  it("renders an invalid date as toLocale*String does, instead of throwing", () => {
    for (const bad of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      for (const style of STYLES) {
        expect(formatDate(bad, style)).toBe(OLD_STYLE[style](new Date(bad)));
        expect(formatDate(bad, style)).toBe("Invalid Date");
      }
    }
  });

  it("picks up a time-zone change while running", () => {
    useZone("Europe/Stockholm");
    const t = Date.UTC(2026, 0, 1, 23, 30);
    const inStockholm = formatDate(t, "full");
    expect(inStockholm).toBe(new Date(t).toLocaleString());
    useZone("America/New_York");
    const inNewYork = formatDate(t, "full");
    expect(inNewYork).toBe(new Date(t).toLocaleString());
    // Guards the test itself: the switch really changed the output.
    expect(inNewYork).not.toBe(inStockholm);
    expect(formatDate(t, "time")).toBe(OLD_STYLE.time(new Date(t)));
  });
});

describe("formatMessageTime", () => {
  it("matches the toLocale*String version on every branch", () => {
    // Offsets around now hit each branch and its edges: the future (negative
    // diff), same day, the 24 h and 7-day boundaries, and older.
    const offsets: number[] = [];
    for (let h = -72; h <= 24 * 30; h += 2) offsets.push(h * 60 * 60 * 1000);
    for (const edge of [DAY, 7 * DAY]) {
      for (const d of [-1, 0, 1]) offsets.push(edge + d);
    }
    const ts = timestamps();
    const mismatches: string[] = [];
    const branches = new Set<string>();
    for (const zone of ZONES) {
      useZone(zone);
      for (const nowShift of [0, 5 * 60 * 60 * 1000, 13 * 60 * 60 * 1000]) {
        vi.setSystemTime(clock + nowShift);
        const now = Date.now();
        for (const t of [...offsets.map((off) => now - off), ...ts]) {
          const got = formatMessageTime(t);
          const expected = oldFormatMessageTime(t);
          if (got !== expected) mismatches.push(`${zone} ${t}: ${got} != ${expected}`);
          const diffDays = Math.floor((now - t) / DAY);
          branches.add(diffDays === 0 ? "time" : diffDays < 7 ? "weekday" : "monthDay");
        }
      }
      vi.setSystemTime(clock);
    }
    expect(mismatches).toEqual([]);
    expect([...branches].sort()).toEqual(["monthDay", "time", "weekday"]);
    expect(formatMessageTime(NaN)).toBe(oldFormatMessageTime(NaN));
  });
});

describe("nextMessageTimeChange", () => {
  it("names the first instant the label reads differently", () => {
    const offsets: number[] = [];
    for (let h = -30; h <= 24 * 9; h += 5) offsets.push(h * 60 * 60 * 1000 + 17_000);
    for (const edge of [0, DAY, 7 * DAY]) {
      for (const d of [-1, 0, 1]) offsets.push(edge + d);
    }
    const wrong: string[] = [];
    for (const zone of ["Europe/Stockholm", "Australia/Lord_Howe"]) {
      useZone(zone);
      const now = clock;
      for (const off of offsets) {
        const t = now - off;
        const due = nextMessageTimeChange(t, now);
        const label = formatMessageTime(t);
        if (!Number.isFinite(due)) {
          // Only past the last branch (a week or more old) does it never change.
          if (now - t < 7 * DAY) wrong.push(`${zone} ${off}: never`);
          continue;
        }
        if (due <= now) wrong.push(`${zone} ${off}: due ${due} not after now`);
        vi.setSystemTime(due - 1);
        const justBefore = formatMessageTime(t);
        vi.setSystemTime(due);
        const atDue = formatMessageTime(t);
        vi.setSystemTime(now);
        // Unchanged until due (branches only move forward), different at it.
        if (justBefore !== label) wrong.push(`${zone} ${off}: changed before due`);
        if (atDue === label) wrong.push(`${zone} ${off}: unchanged at due`);
      }
    }
    expect(wrong).toEqual([]);
    expect(nextMessageTimeChange(NaN, NOW)).toBe(Infinity);
  });
});

describe("nextLocalMidnight", () => {
  it("is the start of the next local day", () => {
    const wrong: string[] = [];
    for (const zone of ZONES) {
      useZone(zone);
      for (const t of timestamps()) {
        if (Math.abs(t) > 8e15) continue;
        const m = nextLocalMidnight(t);
        const sameDay = (a: number, b: number) =>
          new Date(a).toDateString() === new Date(b).toDateString();
        if (!(m > t) || !sameDay(m - 1, t) || sameDay(m, t) || m - t > 25 * 60 * 60 * 1000) {
          wrong.push(`${zone} ${t}: ${m}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("whenDue", () => {
  beforeEach(() => {
    // Replaces the file-wide Date-only fake: a second useFakeTimers is ignored.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });

  it("fires once, when the clock reaches the due time", () => {
    const onDue = vi.fn();
    whenDue(NOW + 3 * 60_000 + 500, onDue);
    vi.advanceTimersByTime(3 * 60_000 + 499);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("catches up within a minute when the clock jumps (system sleep)", () => {
    const onDue = vi.fn();
    whenDue(NOW + 60 * 60_000, onDue);
    // Asleep: wall time moves on, timers don't.
    vi.setSystemTime(NOW + 2 * 60 * 60_000);
    vi.advanceTimersByTime(60_000);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled, and never schedules for Infinity", () => {
    const onDue = vi.fn();
    const cancel = whenDue(NOW + 5_000, onDue);
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(onDue).not.toHaveBeenCalled();

    whenDue(Infinity, onDue);
    expect(vi.getTimerCount()).toBe(0);
  });
});
