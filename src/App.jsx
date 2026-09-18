import React, { useState, useEffect, useMemo, useCallback, useRef, useContext, createContext } from "react";
import { createPortal } from "react-dom";
import {
  Plus, Trash2, ChevronDown, ChevronRight, PiggyBank, Wallet,
  AlertTriangle, Calendar, Settings2, Settings, Receipt, TrendingUp, Save, Check, X, RotateCcw, Sun, Moon,
  Download, Upload, FileSpreadsheet, Cloud, CloudOff, RefreshCw, Eye, EyeOff, Repeat, Bell,
  Monitor, Laptop, Smartphone
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { isSyncConfigured, pushBlob, pullBlob } from "./supabaseSync.js";
import {
  getSession, onAuthStateChange, signUpWithPassword, signInWithPassword,
  sendLoginCode, verifyLoginCode, signOut as authSignOut,
} from "./supabaseAuth.js";

// Only ever set by the Docker build (see Dockerfile) — gates the
// Docker-only Downloads tab so it never shows up in the Electron/Capacitor
// builds, which don't have a downloads folder to serve.
const IS_DOCKER_BUILD = import.meta.env.VITE_DEPLOYMENT_TARGET === "docker";

/* ============================================================================
   DATE UTILITIES — everything is stored/computed as UTC-midnight Date objects
   built from 'YYYY-MM-DD' strings, so there's no timezone drift.
============================================================================ */
const parseDate = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmtISO = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
const dayOf = (dt) => dt.getUTCDate();
const monthOf = (dt) => dt.getUTCMonth() + 1;
const fmtShort = (dt) =>
  dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/* Same as fmtShort, but the year is only worth stating when it actually
   differs from some reference date (e.g. the paycheck a "next due" date is
   being shown alongside) — otherwise it's redundant noise. */
const fmtShortRelativeTo = (dt, refDt) =>
  dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: dt.getUTCFullYear() === refDt.getUTCFullYear() ? undefined : "numeric",
    timeZone: "UTC",
  });
/* "Today" as a UTC-midnight Date built from the browser's local calendar
   date, so it compares cleanly against the UTC-midnight period dates above. */
const todayUTC = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
};

const PAY_SCHEDULE_TYPES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom (specific dates)" },
];
const DEFAULT_CUSTOM_PAY_DAYS = [1, 15];

const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/* The i-th (0-indexed) pay date for a given schedule, counting forward from
   firstPayDate. Weekly/bi-weekly are a fixed day interval. Monthly repeats
   the same calendar day each month, clamped so e.g. day 31 becomes the last
   day of a shorter month. Custom cycles through a sorted list of days-of-
   month (e.g. the 1st and 15th), rolling into the next month once the list
   is exhausted for the current one. */
function nthPayDate(schedule, firstPayDate, i) {
  const type = (schedule && schedule.type) || "biweekly";

  if (type === "weekly") return addDays(firstPayDate, i * 7);
  if (type === "monthly") {
    const totalMonths = firstPayDate.getUTCMonth() + i;
    const year = firstPayDate.getUTCFullYear() + Math.floor(totalMonths / 12);
    const month = ((totalMonths % 12) + 12) % 12;
    const day = Math.min(firstPayDate.getUTCDate(), daysInMonth(year, month));
    return new Date(Date.UTC(year, month, day));
  }
  if (type === "custom") {
    const days = [...new Set((schedule && schedule.customDays && schedule.customDays.length ? schedule.customDays : DEFAULT_CUSTOM_PAY_DAYS))].sort((a, b) => a - b);
    let year = firstPayDate.getUTCFullYear();
    let month = firstPayDate.getUTCMonth();
    let found = -1;
    for (let guard = 0; guard < 6000; guard++) {
      for (const targetDay of days) {
        const day = Math.min(targetDay, daysInMonth(year, month));
        const candidate = new Date(Date.UTC(year, month, day));
        if (candidate >= firstPayDate) {
          found++;
          if (found === i) return candidate;
        }
      }
      month++;
      if (month > 11) { month = 0; year++; }
    }
    return firstPayDate;
  }
  // biweekly (also the fallback for unrecognized types)
  return addDays(firstPayDate, i * 14);
}

const fmtMoney = (n) => {
  const neg = n < -0.001;
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `($${s})` : `$${s}`;
};

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
/* Plain-English description of a pay schedule, e.g. "on the 1st and 15th of
   each month" — used both in the Pay & Accounts help text and to label
   the pay schedule on the main header. */
function describePaySchedule(schedule) {
  const type = (schedule && schedule.type) || "biweekly";
  if (type === "weekly") return "weekly, every 7 days";
  if (type === "monthly") return "monthly, on the same calendar day each month";
  if (type === "custom") {
    const days = [...new Set(schedule.customDays && schedule.customDays.length ? schedule.customDays : DEFAULT_CUSTOM_PAY_DAYS)].sort((a, b) => a - b);
    const list = days.map(ordinal);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
    return `on the ${joined} of each month`;
  }
  return "biweekly, every 14 days";
}
/* Short adjective for the main header title, e.g. "Weekly Bill Ledger". */
function paySchedulePrefix(type) {
  if (type === "weekly") return "Weekly";
  if (type === "monthly") return "Monthly";
  if (type === "custom") return "Custom-Schedule";
  return "Bi-Weekly";
}

/* Strips currency formatting ($, commas, stray spaces) from free-typed
   override fields so e.g. "$85.30" still parses as a real number instead of
   going to NaN and poisoning every later period's carried-forward balance. */
function sanitizeAmount(v) {
  if (v === "" || v === undefined || v === null) return "";
  return String(v).replace(/[^0-9.\-]/g, "");
}
function toNumber(v) {
  const n = Number(sanitizeAmount(v));
  return Number.isFinite(n) ? n : 0;
}
/* Formats a committed override for display: always 2 decimals, blank when
   there's nothing committed. Used by the override inputs on Projection and
   History so an idle "50" reads back as "50.00" once you tab away. */
function formatCommittedAmount(committed) {
  return committed !== undefined && committed !== null && committed !== "" ? toNumber(committed).toFixed(2) : "";
}



/* ============================================================================
   SCHEDULE ENGINE — ported directly from the workbook's VBA macro CheckToPay
   (Module1.bas, written 2007 by D. Whitney). Schedule types:
     0 = every paycheck
     1 = monthly, by day of month
     2 = alternating months, by day of month (odd/even)
     3 = every N weeks, from a start date
     4 = quarterly, by day of month
     5 = annual, by date
============================================================================ */
function checkToPay(scheduleType, payDay, payMonth, payDate, nextPayDay, nextPayMonth, nextPayDate, targetDay, startDate, endDate, oddEven, numWeeks) {
  if (startDate && startDate > nextPayDate) return false;
  if (endDate && endDate < payDate) return false;

  let testDate = new Date(Date.UTC(payDate.getUTCFullYear(), payDate.getUTCMonth(), targetDay || 0));
  if (testDate < payDate) {
    testDate = new Date(Date.UTC(nextPayDate.getUTCFullYear(), nextPayDate.getUTCMonth(), targetDay || 0));
  }

  let newTargetDate;
  switch (scheduleType) {
    case 0:
      return true;
    case 1:
      newTargetDate = testDate;
      break;
    case 2: {
      const testMonth = monthOf(testDate);
      if (2 - (testMonth % 2) === Number(oddEven)) newTargetDate = testDate;
      else return false;
      break;
    }
    case 3: {
      const period = Math.max(1, numWeeks) * 7;
      const deltaDays = Math.floor((nextPayDate - startDate) / 86400000);
      const steps = Math.floor(deltaDays / period);
      newTargetDate = addDays(startDate, steps * period);
      break;
    }
    case 4: {
      if (monthOf(testDate) % 3 !== monthOf(startDate) % 3) return false;
      newTargetDate = testDate;
      break;
    }
    case 5: {
      if (testDate.getUTCMonth() !== startDate.getUTCMonth()) return false;
      newTargetDate = testDate;
      break;
    }
    default:
      return false;
  }

  return newTargetDate >= payDate && newTargetDate < nextPayDate;
}

const SCHEDULE_TYPES = [
  { value: 0, label: "Every paycheck", short: "Every check" },
  { value: 1, label: "Monthly, by day of month", short: "Monthly" },
  { value: 2, label: "Alternating months, by day", short: "Alt. months" },
  { value: 3, label: "Every N weeks, from start date", short: "Every N wks" },
  { value: 4, label: "Quarterly, by day of month", short: "Quarterly" },
  { value: 5, label: "Annually, by date", short: "Annual" },
];

const DEFAULT_CATEGORIES = [
  "Rent/Mortgage", "Vehicle payment", "Insurance", "Loans", "Credit Cards",
  "Subscriptions", "Transportation", "Entertainment", "Utilities", "Groceries", "Misc",
];

/* Pick the applicable gross/net pay for a given date from a sorted list of
   {date, grossPay, netPay} entries — mirrors the workbook's HLOOKUP
   (approximate match: latest entry on or before the date). */
function payForDate(payChanges, date) {
  let applicable = payChanges[0];
  for (const pc of payChanges) {
    if (pc._date <= date) applicable = pc;
    else break;
  }
  return applicable;
}

/* Standard amount for a bill: fixed dollar figure, or a % of gross/net pay. */
function computeBillAmount(bill, grossPay, netPay) {
  if (bill.amountType === "grossPct") return grossPay * (bill.pct || 0);
  if (bill.amountType === "netPct") return netPay * (bill.pct || 0);
  return bill.amount || 0;
}

/* Full projection engine. "Periods to project" is the number of *future*
   paychecks to generate — not a fixed total — so the window keeps sliding
   forward: every paycheck date always adds up to that many periods beyond
   today, and everything before today is generated too (History draws its
   backlog from the same list). */
function runProjection(data) {
  const { paycheck, bills, savingsAccounts } = data;
  const firstPayDate = parseDate(paycheck.firstPayDate);
  const buffer = paycheck.bufferDays || 0;
  const targetFuturePeriods = paycheck.numPeriods || 26;
  const today = todayUTC();

  const payChanges = [...paycheck.payChanges]
    .map((pc) => ({ ...pc, _date: parseDate(pc.date) }))
    .sort((a, b) => a._date - b._date);
  if (payChanges.length === 0) {
    payChanges.push({ date: paycheck.firstPayDate, grossPay: 0, netPay: 0, _date: firstPayDate });
  }

  const periodDate = (i) => {
    const raw = nthPayDate(paycheck.paySchedule, firstPayDate, i);
    const adjusted = addDays(raw, buffer);
    return { raw, adjusted, day: dayOf(adjusted), month: monthOf(adjusted) };
  };

  const billDates = bills.map((b) => ({
    start: parseDate(b.startDate),
    end: b.endDate ? parseDate(b.endDate) : new Date(Date.UTC(2099, 0, 1)),
  }));

  const periods = [];
  let checkingBal = paycheck.startingChecking || 0;
  const savingsBal = {};
  (savingsAccounts || []).forEach((a) => (savingsBal[a.id] = a.startingBalance || 0));

  // Non-auto-pay bills can be paid early/in installments from a paycheck
  // before they're actually due — each such entry (bill.periodOverrides[i]
  // on a period where the bill isn't due) both charges that period for real
  // and chips away at what's still owed once the bill's real due period
  // comes around. This accumulator carries that running "paid ahead" total
  // per bill across periods, forward in time same as checkingBal, and
  // resets the moment the bill's actual due period consumes it.
  const billPrepaid = {};
  bills.forEach((b) => (billPrepaid[b.id] = 0));

  // Running YTD gross/net, carried period to period so each row can show the
  // total through that specific paycheck (not just "as of today"). Resets —
  // and re-seeds from paycheck.ytdSeed if it applies — the moment a period's
  // calendar year changes from the previous one.
  let ytdYear = null;
  let ytdGrossRunning = 0;
  let ytdNetRunning = 0;

  let futureCount = 0;
  for (let i = 0; futureCount < targetFuturePeriods; i++) {
    const cur = periodDate(i);
    const next = periodDate(i + 1);
    if (cur.raw > today) futureCount++;
    const pay = payForDate(payChanges, cur.adjusted);
    const baseGrossPay = pay.grossPay || 0;
    const grossOv = paycheck.grossPayOverrides && paycheck.grossPayOverrides[i];
    const isGrossPayOverridden = grossOv !== undefined && grossOv !== null && grossOv !== "";
    const grossPay = isGrossPayOverridden ? toNumber(grossOv) : baseGrossPay;
    const baseNetPay = pay.netPay || 0;
    const netOv = paycheck.netPayOverrides && paycheck.netPayOverrides[i];
    const isNetPayOverridden = netOv !== undefined && netOv !== null && netOv !== "";
    const netPay = isNetPayOverridden ? toNumber(netOv) : baseNetPay;

    const lineItems = [];
    let totalBills = 0;
    const savingsDelta = {};

    bills.forEach((bill, idx) => {
      const bd = billDates[idx];
      const paid = checkToPay(
        bill.scheduleType, cur.day, cur.month, cur.adjusted,
        next.day, next.month, next.adjusted,
        bill.targetDay || 0, bd.start, bd.end, bill.oddEven || 0, bill.weeks || 1
      );
      const ov = bill.periodOverrides && bill.periodOverrides[i];
      const isOverridden = ov !== undefined && ov !== null && ov !== "";

      if (paid) {
        let amount;
        if (isOverridden) {
          amount = toNumber(ov);
        } else {
          const fullAmount = computeBillAmount(bill, grossPay, netPay);
          // Anything paid ahead since the last time this bill was actually
          // due comes off what's owed now — never below $0 (an overpayment
          // just fully covers this due period rather than going negative).
          amount = bill.autoPay ? fullAmount : Math.max(0, fullAmount - (billPrepaid[bill.id] || 0));
        }
        lineItems.push({ billId: bill.id, name: bill.name, amount, account: bill.account, isOverridden, isEarlyPayment: false });
        totalBills += amount;
        if (bill.account) savingsDelta[bill.account] = (savingsDelta[bill.account] || 0) + amount;
        billPrepaid[bill.id] = 0;
      } else if (!bill.autoPay && isOverridden) {
        const amount = toNumber(ov);
        if (amount !== 0) {
          lineItems.push({ billId: bill.id, name: bill.name, amount, account: bill.account, isOverridden: true, isEarlyPayment: true });
          totalBills += amount;
          if (bill.account) savingsDelta[bill.account] = (savingsDelta[bill.account] || 0) + amount;
        }
        billPrepaid[bill.id] = (billPrepaid[bill.id] || 0) + amount;
      }
    });

    const extraIncome = (paycheck.extraIncome && paycheck.extraIncome[i]) || 0;

    let projectedBal = checkingBal + netPay + extraIncome - totalBills;
    const override = paycheck.actualOverrides && paycheck.actualOverrides[i];
    const endingBal = override !== undefined && override !== null && override !== "" ? toNumber(override) : projectedBal;

    // Each savings account carries its own running balance forward the same
    // way checking does: this period's bills nudge it (savingsDelta), and if
    // the person has entered a real/actual balance for this period on that
    // account, that value wins and becomes the new base for future periods.
    const savingsProjected = {};
    const savingsIsOverridden = {};
    (savingsAccounts || []).forEach((a) => {
      const delta = savingsDelta[a.id] || 0;
      const derived = (savingsBal[a.id] || 0) + delta;
      const aOv = a.actualOverrides && a.actualOverrides[i];
      const hasOv = aOv !== undefined && aOv !== null && aOv !== "";
      savingsProjected[a.id] = derived;
      savingsIsOverridden[a.id] = hasOv;
      savingsBal[a.id] = hasOv ? toNumber(aOv) : derived;
    });

    const periodYear = cur.raw.getUTCFullYear();
    if (periodYear !== ytdYear) {
      ytdYear = periodYear;
      const seed = paycheck.ytdSeed;
      ytdGrossRunning = seed && seed.year === periodYear ? seed.gross || 0 : 0;
      ytdNetRunning = seed && seed.year === periodYear ? seed.net || 0 : 0;
    }
    ytdGrossRunning += grossPay;
    ytdNetRunning += netPay;

    periods.push({
      index: i,
      date: cur.raw,
      month: cur.month,
      grossPay,
      baseGrossPay,
      isGrossPayOverridden,
      netPay,
      baseNetPay,
      isNetPayOverridden,
      extraIncome,
      totalBills,
      lineItems,
      projectedBal,
      endingBal,
      isOverridden: override !== undefined && override !== null && override !== "",
      savingsBal: { ...savingsBal },
      savingsProjected,
      savingsIsOverridden,
      isLow: endingBal < (paycheck.lowBalanceThreshold || 0),
      ytdYear: periodYear,
      ytdGrossThroughPeriod: ytdGrossRunning,
      ytdNetThroughPeriod: ytdNetRunning,
    });

    checkingBal = endingBal;
  }

  // For each non-auto-pay bill, resolve "next actually-due date" as of
  // every period — powers the "not due — pay early" reminder row. A single
  // backward pass per bill: walking newest-to-oldest, next-due is just
  // whatever due date was most recently seen. Near the END of the visible
  // horizon, though, a bill's next occurrence may not exist within `periods`
  // at all yet — rather than leave those trailing periods with no next-due
  // date, extend the same schedule check a bit further out (bounded, and
  // naturally stopping at the bill's own end date) to find it for real.
  bills.forEach((bill, idx) => {
    if (bill.autoPay) return;
    const bd = billDates[idx];
    let next = null;
    let extensionAttempted = false;
    for (let ridx = periods.length - 1; ridx >= 0; ridx--) {
      const pp = periods[ridx];
      const isDue = pp.lineItems.some((li) => li.billId === bill.id && !li.isEarlyPayment);
      if (isDue) {
        next = pp.date;
      } else if (next === null && !extensionAttempted) {
        extensionAttempted = true;
        for (let j = periods.length; j < periods.length + 80; j++) {
          const c = periodDate(j);
          if (c.raw > bd.end) break; // bill has actually ended — genuinely no next due
          const n = periodDate(j + 1);
          const due = checkToPay(bill.scheduleType, c.day, c.month, c.adjusted, n.day, n.month, n.adjusted, bill.targetDay || 0, bd.start, bd.end, bill.oddEven || 0, bill.weeks || 1);
          if (due) { next = c.raw; break; }
        }
      }
      pp.nextDueByBill = pp.nextDueByBill || {};
      pp.nextDueByBill[bill.id] = next;
    }
  });

  return periods;
}

/* ============================================================================
   DEFAULT DATA — a blank slate for a new install. No bills, no accounts,
   no balances: just today's date as a starting point and the built-in
   category list, so first launch is an empty ledger rather than someone
   else's finances.
============================================================================ */
const DEFAULT_DATA = {
  paycheck: {
    firstPayDate: fmtISO(new Date()),
    paySchedule: { type: "biweekly", customDays: [...DEFAULT_CUSTOM_PAY_DAYS] },
    bufferDays: 0,
    numPeriods: 26,
    payChanges: [{ date: fmtISO(new Date()), grossPay: 0, netPay: 0 }],
    startingChecking: 0,
    lowBalanceThreshold: 0,
    actualOverrides: {},
    extraIncome: {},
    netPayOverrides: {},
    grossPayOverrides: {},
    ytdSeed: { year: new Date().getFullYear(), gross: 0, net: 0 },
  },
  savingsAccounts: [],
  categories: [...DEFAULT_CATEGORIES],
  bills: [],
};

/* ============================================================================
   THEME — plain hex literals chosen per render via a React Context. (This
   host environment's Tailwind build does not compile var() inside arbitrary
   bracket values, so classes must carry literal colors rather than CSS
   custom properties — the theme switches by re-rendering with a different
   literal, not by re-pointing a CSS variable.)
============================================================================ */
const LIGHT = {
  pageBg: "#FAF7F0", cardBg: "#FFFFFF", inputBg: "#FFFDF7", hoverBg: "#FBF8F0",
  ink: "#1F2A3C", inkSoft: "#8b8367", inkSoft2: "#57607a",
  rule: "#D8D2C2", ruleSoft: "#E4DFCE", ruleRow: "#EDE8D8",
  green: "#2F6F5E", greenHover: "#245a4c",
  rust: "#B3492E", rustHover: "#8f3a24",
  gold: "#B8862E", goldDark: "#8a6416",
  goldTintBg: "#FBF3E2", rustTintBg: "#FBEDE8", rustTintHover: "#B3492E1A",
  ring: "#2F6F5E4D", placeholder: "#c2bca6", btnBgHover: "#16202f",
};
const DARK = {
  pageBg: "#15171C", cardBg: "#1C1F26", inputBg: "#20232A", hoverBg: "#23262D",
  ink: "#ECE9DE", inkSoft: "#9D998A", inkSoft2: "#A6ACC0",
  rule: "#383C44", ruleSoft: "#2B2E35", ruleRow: "#292C32",
  green: "#57B096", greenHover: "#79C7AE",
  rust: "#E28368", rustHover: "#EF9C84",
  gold: "#D9A94E", goldDark: "#E8C077",
  goldTintBg: "#332A18", rustTintBg: "#382520", rustTintHover: "#E283682A",
  ring: "#57B0965A", placeholder: "#5A5D64", btnBgHover: "#F6F4EA",
};
const ThemeCtx = createContext(LIGHT);
const useTheme = () => useContext(ThemeCtx);

const DARK_MODE_KEY = "bill-tracker:dark-mode:v1";

function useDarkMode() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(DARK_MODE_KEY, false);
        if (res && res.value) setDark(res.value === "true");
      } catch (e) {
        /* default to light */
      }
    })();
  }, []);
  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      window.storage.set(DARK_MODE_KEY, String(next), false).catch(() => {});
      return next;
    });
  }, []);
  return [dark, toggle];
}

/* ============================================================================
   STORAGE
============================================================================ */
const STORAGE_KEY = "bill-tracker:data:v1";

/* Older saved blobs may predate categories, per-account actual overrides,
   or per-bill period overrides — patch in sane defaults so loading old data
   never crashes or silently drops functionality. */
function migrate(raw) {
  const categories = raw.categories && raw.categories.length ? raw.categories : [...DEFAULT_CATEGORIES];
  return {
    ...raw,
    categories,
    paycheck: {
      actualOverrides: {},
      extraIncome: {},
      netPayOverrides: {},
      grossPayOverrides: {},
      ytdSeed: { year: new Date().getFullYear(), gross: 0, net: 0 },
      ...(raw.paycheck || {}),
      paySchedule: {
        type: "biweekly",
        customDays: [...DEFAULT_CUSTOM_PAY_DAYS],
        ...((raw.paycheck && raw.paycheck.paySchedule) || {}),
      },
    },
    savingsAccounts: (raw.savingsAccounts || []).map((a) => ({ actualOverrides: {}, ...a })),
    bills: (raw.bills || []).map((b) => {
      const withDefaults = { periodOverrides: {}, category: "Misc", autoPay: false, ...b };
      if (!categories.includes(withDefaults.category)) {
        withDefaults.category = categories.includes("Misc") ? "Misc" : categories[0] || "Misc";
      }
      return withDefaults;
    }),
  };
}

function useStorageState() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [session, setSession] = useState(null);
  const [syncState, setSyncState] = useState("idle"); // idle | syncing | synced | error
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const saveTimer = useRef(null);
  // Mirrors session/data for closures that are created once (the debounced
  // setTimeout in persist, the visibility/focus listeners below) — without
  // these, those closures would keep whatever session/data existed at the
  // moment they were created, forever, the same reason saveTimer is a ref.
  const sessionRef = useRef(null);
  const dataRef = useRef(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Adopt cloud data (or seed the cloud if no row exists yet) for the signed-in
  // account. Shared by load-time auto-pull, sign-in, and "Sync now".
  const syncFromCloud = useCallback(async (userId, localSnapshot) => {
    if (!isSyncConfigured || !userId) return;
    setSyncState("syncing");
    const res = await pullBlob(userId);
    if (!res.ok) {
      setSyncState("error");
      return;
    }
    if (res.exists) {
      const adopted = migrate(res.data);
      setData(adopted);
      window.storage.set(STORAGE_KEY, JSON.stringify(adopted), false).catch(() => {});
      setSyncState("synced");
      setLastSyncedAt(new Date().toISOString());
    } else {
      const seed = await pushBlob(userId, localSnapshot);
      setSyncState(seed.ok ? "synced" : "error");
      if (seed.ok) setLastSyncedAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    (async () => {
      let local = DEFAULT_DATA;
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res && res.value) local = migrate(JSON.parse(res.value));
      } catch (e) {
        local = DEFAULT_DATA;
      }
      setData(local);
      setLoading(false);

      if (!isSyncConfigured) return;
      const initialSession = await getSession();
      sessionRef.current = initialSession;
      setSession(initialSession);
      if (initialSession) syncFromCloud(initialSession.user.id, local); // fire-and-forget; doesn't block rendering
    })();
  }, [syncFromCloud]);

  // Reacts to sign-in/sign-up/sign-out triggered from the Settings tab.
  // INITIAL_SESSION is skipped because the mount effect above already handled
  // startup, using the freshly-loaded local snapshot to seed the cloud with.
  useEffect(() => {
    const subscription = onAuthStateChange((event, newSession) => {
      if (event === "INITIAL_SESSION") return;
      sessionRef.current = newSession;
      setSession(newSession);
      if (event === "SIGNED_IN" && newSession) {
        syncFromCloud(newSession.user.id, dataRef.current);
      } else if (event === "SIGNED_OUT") {
        setSyncState("idle");
        setLastSyncedAt(null);
      }
    });
    return () => subscription.unsubscribe();
  }, [syncFromCloud]);

  // Auto-pull on load covers app *startup*, but an already-open app (the
  // common case — this isn't a page you reload) would otherwise never learn
  // about another device's edits until someone remembers to hit "Sync now".
  // Re-pulling whenever the app regains focus/visibility closes that gap
  // without going as far as a live subscription (which risks yanking a
  // field out from under an in-progress edit) — a focus/visibility change is
  // a natural boundary where the user isn't mid-keystroke.
  useEffect(() => {
    const onFocusOrVisible = () => {
      if (document.visibilityState === "hidden") return;
      if (sessionRef.current) syncFromCloud(sessionRef.current.user.id, dataRef.current);
    };
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    return () => {
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, [syncFromCloud]);

  // skipCloudPush lets resetToSeed wipe the local copy without also
  // overwriting the signed-in account's cloud copy — see resetToSeed below.
  const persist = useCallback((next, { skipCloudPush = false } = {}) => {
    setData(next);
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const ok = await window.storage.set(STORAGE_KEY, JSON.stringify(next), false);
        setSaveState(ok ? "saved" : "error");
      } catch (e) {
        setSaveState("error");
      }
      const s = sessionRef.current;
      if (isSyncConfigured && s && !skipCloudPush) {
        setSyncState("syncing");
        const res = await pushBlob(s.user.id, next);
        setSyncState(res.ok ? "synced" : "error");
        if (res.ok) setLastSyncedAt(new Date().toISOString());
      }
    }, 500);
  }, []);

  const resetToSeed = useCallback(() => {
    // Skip the cloud push — a local reset shouldn't silently overwrite the
    // signed-in account's synced data. Sign out first for that.
    setSyncState("idle");
    setLastSyncedAt(null);
    persist(DEFAULT_DATA, { skipCloudPush: true });
  }, [persist]);

  const syncNow = useCallback(() => {
    if (sessionRef.current) syncFromCloud(sessionRef.current.user.id, data);
  }, [syncFromCloud, data]);

  return {
    data, setData: persist, loading, saveState, resetToSeed,
    syncConfigured: isSyncConfigured, session, syncState, lastSyncedAt, syncNow,
  };
}

/* ============================================================================
   SMALL UI PRIMITIVES (ledger theme)
============================================================================ */
const Field = ({ label, children, className = "" }) => {
  const t = useTheme();
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>{label}</span>
      {children}
    </label>
  );
};

function useInputCls() {
  const t = useTheme();
  // Native <input>/<select>/<textarea> size to their own intrinsic content
  // by default, not their container — unlike a <div>, they don't stretch
  // to fill a flex or grid cell on their own. Without w-full here, every
  // field built on this class keeps its native width regardless of how
  // narrow its grid column gets, which is what was overflowing on mobile.
  return "w-full min-w-0 rounded-md px-2.5 py-1.5 text-[14px] focus:outline-none";
}
function inputStyle(t) {
  return { background: t.inputBg, border: `1px solid ${t.rule}`, color: t.ink };
}

const NumInput = (props) => {
  const t = useTheme();
  return <input type="number" step="0.01" className={useInputCls()} style={inputStyle(t)} {...props} />;
};
/* Dollar-amount field: shows a $ prefix and always displays two decimal
   places, snapping to that format on blur so a typed "85.3" reads back as
   "85.30" rather than staying however the user happened to type it. */
const CurrencyInput = ({ value, onChange, className = "", ...rest }) => {
  const t = useTheme();
  const [draft, setDraft] = useState(null);
  const cancelledRef = useRef(false);
  const formatted = Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "0.00";
  const display = draft !== null ? draft : formatted;
  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(null);
      return;
    }
    if (draft !== null) {
      onChange(toNumber(draft));
      setDraft(null);
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[13px]" style={{ color: t.inkSoft }}>$</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={display}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(formatted)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelledRef.current = true; e.currentTarget.blur(); } }}
        className={`${useInputCls()} ${className}`}
        style={inputStyle(t)}
        {...rest}
      />
    </div>
  );
};
const TextInput = (props) => {
  const t = useTheme();
  return <input type="text" autoComplete="off" className={useInputCls()} style={inputStyle(t)} {...props} />;
};
const DateInput = (props) => {
  const t = useTheme();
  return <input type="date" className={useInputCls()} style={inputStyle(t)} {...props} />;
};
const SelectInput = (props) => {
  const t = useTheme();
  return <select className={useInputCls()} style={inputStyle(t)} {...props} />;
};

/* Free-typed "1, 15" style list of days-of-month for a custom pay schedule.
   Parses to sorted unique integers 1–31 on blur; falls back to the default
   1st/15th pair if everything typed was invalid or the field was cleared. */
function CustomDaysInput({ value, onChange }) {
  const t = useTheme();
  const [draft, setDraft] = useState(null);
  const formatted = (value && value.length ? value : DEFAULT_CUSTOM_PAY_DAYS).slice().sort((a, b) => a - b).join(", ");
  const display = draft !== null ? draft : formatted;

  const commit = () => {
    if (draft === null) return;
    const days = [...new Set(
      draft.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
    )].sort((a, b) => a - b);
    onChange(days.length ? days : [...DEFAULT_CUSTOM_PAY_DAYS]);
    setDraft(null);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={display}
      placeholder="e.g. 1, 15"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setDraft(null); }}
      className={useInputCls()}
      style={inputStyle(t)}
    />
  );
}

function SaveIndicator({ state }) {
  const t = useTheme();
  if (state === "saving")
    return <span className="flex items-center gap-1 text-[12px]" style={{ color: t.inkSoft }}><Save size={12} className="animate-pulse" /> Saving…</span>;
  if (state === "saved")
    return <span className="flex items-center gap-1 text-[12px]" style={{ color: t.green }}><Check size={12} /> Saved</span>;
  if (state === "error")
    return <span className="flex items-center gap-1 text-[12px]" style={{ color: t.rust }}><X size={12} /> Save failed</span>;
  return <span className="text-[12px] text-transparent">·</span>;
}

// Absolute local time rather than relative ("3m ago") — relative text would
// go stale the moment it's rendered, since nothing re-renders this on a timer.
function formatSyncTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function SyncIndicator({ state, lastSyncedAt }) {
  const t = useTheme();
  const lastSynced = formatSyncTimestamp(lastSyncedAt);
  if (state === "syncing")
    return <span className="flex items-center gap-1 text-[12px]" style={{ color: t.inkSoft }}><RefreshCw size={12} className="animate-spin" /> Syncing…</span>;
  if (state === "synced")
    return (
      <span className="flex items-center gap-1 text-[12px]" style={{ color: t.green }}>
        <Cloud size={12} /> Synced{lastSynced ? ` — last at ${lastSynced}` : ""}
      </span>
    );
  if (state === "error")
    return (
      <span className="flex items-center gap-1 text-[12px]" style={{ color: t.rust }}>
        <CloudOff size={12} /> Sync error{lastSynced ? ` — last synced ${lastSynced}` : ""}
      </span>
    );
  return <span className="text-[12px] text-transparent">·</span>;
}

/* ============================================================================
   ACCOUNT (Supabase Auth sign-in gating cloud sync)
============================================================================ */
function AccountSection({ syncConfigured, session, syncState, lastSyncedAt, syncNow }) {
  const t = useTheme();
  const card = "rounded-lg p-5 shadow-sm space-y-4";
  const cardStyle = { background: t.cardBg, border: `1px solid ${t.ruleSoft}` };

  const [authMode, setAuthMode] = useState("password"); // password | code
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const switchMode = (mode) => {
    setAuthMode(mode);
    setError(null);
    setNotice(null);
  };

  const handleSignIn = async () => {
    setBusy(true); setError(null); setNotice(null);
    const res = await signInWithPassword(email.trim(), password);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setPassword("");
  };

  const handleSignUp = async () => {
    setBusy(true); setError(null); setNotice(null);
    const res = await signUpWithPassword(email.trim(), password);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setPassword("");
    if (res.needsEmailConfirmation) setNotice("Check your email to confirm your account, then sign in.");
  };

  const handleSendCode = async () => {
    setBusy(true); setError(null); setNotice(null);
    const res = await sendLoginCode(email.trim());
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setCodeSent(true);
    setNotice("Code sent — check your email.");
  };

  const handleVerifyCode = async () => {
    setBusy(true); setError(null);
    const res = await verifyLoginCode(email.trim(), codeDraft.trim());
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setCodeDraft("");
    setCodeSent(false);
    setNotice(null);
  };

  const handleSignOut = async () => {
    await authSignOut();
    setConfirmSignOut(false);
  };

  const btnPrimary = "flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[14px] font-medium transition-colors disabled:opacity-50";
  const btnPrimaryStyle = { background: t.ink, color: t.pageBg };

  return (
    <section className={card} style={cardStyle}>
      <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><Cloud size={16} /> Account</h3>
      <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>
        Optional — sign in to keep this data in sync across your own devices.
      </p>
      {!syncConfigured ? (
        <p className="text-[12px] italic" style={{ color: t.inkSoft }}>Cloud sync isn't set up in this build.</p>
      ) : session ? (
        <div className="space-y-3">
          <p className="text-[13px]" style={{ color: t.ink }}>
            Signed in as <span className="font-medium">{session.user.email}</span>
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={syncNow}
              className={btnPrimary}
              style={btnPrimaryStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.btnBgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = t.ink)}
            >
              <RefreshCw size={14} /> Sync now
            </button>
            <SyncIndicator state={syncState} lastSyncedAt={lastSyncedAt} />
            {confirmSignOut ? (
              <div className="flex items-center gap-1.5 text-[13px]">
                <span style={{ color: t.inkSoft }}>Sign out?</span>
                <button onClick={handleSignOut} className="font-medium hover:underline" style={{ color: t.rust }}>Yes</button>
                <button onClick={() => setConfirmSignOut(false)} className="hover:underline" style={{ color: t.inkSoft }}>Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmSignOut(true)} className="text-[13px] font-medium" style={{ color: t.rust }}>Sign out</button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-4 text-[12px]">
            <button onClick={() => switchMode("password")} className={authMode === "password" ? "font-semibold" : ""} style={{ color: authMode === "password" ? t.ink : t.inkSoft }}>
              Password
            </button>
            <button onClick={() => switchMode("code")} className={authMode === "code" ? "font-semibold" : ""} style={{ color: authMode === "code" ? t.ink : t.inkSoft }}>
              Email code
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Email" className="w-64">
              <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </Field>
            {authMode === "password" && (
              <Field label="Password" className="w-64">
                <div className="relative">
                  <TextInput type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} className="pr-8" />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    style={{ color: t.inkSoft }}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>
            )}
          </div>
          {authMode === "password" ? (
            <div className="flex flex-wrap items-center gap-4">
              <button disabled={busy || !email || !password} onClick={handleSignIn} className={btnPrimary} style={btnPrimaryStyle}>
                Sign in
              </button>
              <button disabled={busy || !email || !password} onClick={handleSignUp} className="text-[13px] font-medium disabled:opacity-50" style={{ color: t.green }}>
                Create account
              </button>
            </div>
          ) : !codeSent ? (
            <div className="flex flex-wrap items-center gap-4">
              <button disabled={busy || !email} onClick={handleSendCode} className={btnPrimary} style={btnPrimaryStyle}>
                Send code
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="6-digit code" className="w-32">
                <TextInput value={codeDraft} onChange={(e) => setCodeDraft(e.target.value)} placeholder="123456" />
              </Field>
              <button disabled={busy || !codeDraft} onClick={handleVerifyCode} className={btnPrimary} style={btnPrimaryStyle}>
                Verify
              </button>
              <button onClick={handleSendCode} className="text-[13px]" style={{ color: t.inkSoft }}>Resend code</button>
            </div>
          )}
        </div>
      )}
      {notice && <p className="text-[12px]" style={{ color: t.green }}>{notice}</p>}
      {error && <p className="text-[12px]" style={{ color: t.rust }}>{error}</p>}
    </section>
  );
}

/* ============================================================================
   BILL ROW EDITOR
============================================================================ */
function BillEditor({ bill, savingsAccounts, categories, onChange, onDelete }) {
  const t = useTheme();
  const st = bill.scheduleType;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4" style={{ background: t.hoverBg, borderTop: `1px solid ${t.ruleSoft}` }}>
      <Field label="Bill name" className="col-span-2 sm:col-span-2">
        <TextInput value={bill.name} onChange={(e) => onChange({ ...bill, name: e.target.value })} />
      </Field>
      <Field label="Schedule type">
        <SelectInput value={st} onChange={(e) => onChange({ ...bill, scheduleType: Number(e.target.value) })}>
          {SCHEDULE_TYPES.map((sch) => (
            <option key={sch.value} value={sch.value}>{sch.label}</option>
          ))}
        </SelectInput>
      </Field>

      {(st === 1 || st === 2 || st === 4 || st === 5) && (
        <Field label="Target day of month">
          <NumInput min="1" max="31" value={bill.targetDay} onChange={(e) => onChange({ ...bill, targetDay: Number(e.target.value) })} />
        </Field>
      )}
      {st === 2 && (
        <Field label="Odd / even months">
          <SelectInput value={bill.oddEven} onChange={(e) => onChange({ ...bill, oddEven: Number(e.target.value) })}>
            <option value={1}>Odd months</option>
            <option value={2}>Even months</option>
          </SelectInput>
        </Field>
      )}
      {st === 3 && (
        <Field label="Every N weeks">
          <NumInput min="1" value={bill.weeks} onChange={(e) => onChange({ ...bill, weeks: Number(e.target.value) })} />
        </Field>
      )}

      <Field label="Start date">
        <DateInput value={bill.startDate} onChange={(e) => onChange({ ...bill, startDate: e.target.value })} />
      </Field>
      <Field label="End date (optional)">
        <DateInput value={bill.endDate || ""} onChange={(e) => onChange({ ...bill, endDate: e.target.value || null })} />
      </Field>

      <Field label="Amount type">
        <SelectInput value={bill.amountType} onChange={(e) => onChange({ ...bill, amountType: e.target.value })}>
          <option value="fixed">Fixed dollar amount</option>
          <option value="grossPct">% of gross pay</option>
          <option value="netPct">% of net pay</option>
        </SelectInput>
      </Field>
      {bill.amountType === "fixed" ? (
        <Field label="Amount ($)">
          <NumInput value={bill.amount} onChange={(e) => onChange({ ...bill, amount: Number(e.target.value) })} />
        </Field>
      ) : (
        <Field label="Percent (e.g. 0.05 = 5%)">
          <NumInput step="0.001" value={bill.pct} onChange={(e) => onChange({ ...bill, pct: Number(e.target.value) })} />
        </Field>
      )}

      <Field label="Category">
        <SelectInput value={bill.category || "Misc"} onChange={(e) => onChange({ ...bill, category: e.target.value })}>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </SelectInput>
      </Field>

      <Field label="Also deposit into savings">
        <SelectInput value={bill.account || ""} onChange={(e) => onChange({ ...bill, account: e.target.value || null })}>
          <option value="">— none, plain expense —</option>
          {savingsAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </SelectInput>
      </Field>

      <Field label="Auto-pay">
        <label className="flex items-center gap-2 text-[13px] cursor-pointer py-1.5" style={{ color: t.ink }}>
          <input
            type="checkbox"
            checked={!!bill.autoPay}
            onChange={(e) => onChange({ ...bill, autoPay: e.target.checked })}
            style={{ accentColor: t.green }}
          />
          {bill.autoPay ? "Enabled" : "Disabled"}
        </label>
      </Field>

      <div className="col-span-2 sm:col-span-4 flex justify-end">
        <button
          onClick={onDelete}
          className="flex items-center gap-1.5 text-[13px] px-2 py-1 rounded-md transition-colors"
          style={{ color: t.rust }}
          onMouseEnter={(e) => (e.currentTarget.style.background = t.rustTintHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Trash2 size={14} /> Delete bill
        </button>
      </div>
    </div>
  );
}

function BillRow({ bill, savingsAccounts, categories, expanded, onToggle, onChange, onDelete, nextOccurrence }) {
  const t = useTheme();
  const schedLabel = SCHEDULE_TYPES.find((tt) => tt.value === bill.scheduleType)?.short || "";
  const amountLabel =
    bill.amountType === "fixed"
      ? fmtMoney(bill.amount)
      : `${(bill.pct * 100).toFixed(2)}% of ${bill.amountType === "grossPct" ? "gross" : "net"}`;
  const acct = savingsAccounts.find((a) => a.id === bill.account);

  return (
    <div style={{ borderBottom: `1px solid ${t.ruleSoft}` }}>
      <button
        onClick={onToggle}
        className="w-full grid items-center gap-3 px-4 py-3 text-left transition-colors grid-cols-[auto_minmax(0,1fr)_8rem] sm:grid-cols-[auto_minmax(0,1fr)_6rem_8rem] md:grid-cols-[auto_minmax(0,1fr)_7rem_6rem_7.5rem_8rem] lg:grid-cols-[auto_minmax(0,1fr)_7rem_6rem_7.5rem_7rem_8rem]"
        onMouseEnter={(e) => (e.currentTarget.style.background = t.hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {expanded ? <ChevronDown size={15} className="shrink-0" style={{ color: t.inkSoft }} /> : <ChevronRight size={15} className="shrink-0" style={{ color: t.inkSoft }} />}
        <span className="min-w-0 flex items-center gap-1.5">
          <span className="font-medium truncate" style={{ color: t.ink }}>{bill.name || "(untitled bill)"}</span>
          {bill.autoPay && <Repeat size={12} className="shrink-0" style={{ color: t.green }} title="Auto-pay enabled" />}
        </span>
        <span className="hidden md:block text-[10px] font-medium px-2 py-0.5 rounded-full text-center truncate" style={{ color: t.inkSoft2, background: t.hoverBg, border: `1px solid ${t.rule}` }}>
          {bill.category || "Misc"}
        </span>
        <span className="hidden sm:inline text-[12px] truncate" style={{ color: t.inkSoft }}>{schedLabel}</span>
        <span className="hidden md:flex items-center gap-1 text-[11px] min-w-0 truncate" style={{ color: t.gold }}>
          {acct && (<><PiggyBank size={12} className="shrink-0" /> <span className="truncate">{acct.name}</span></>)}
        </span>
        <span className="hidden lg:inline text-[12px] text-right" style={{ color: t.inkSoft }}>
          {nextOccurrence && `next ${fmtShort(nextOccurrence)}`}
        </span>
        <span className="font-mono text-[14px] text-right" style={{ color: t.ink }}>{amountLabel}</span>
      </button>
      {expanded && (
        <BillEditor bill={bill} savingsAccounts={savingsAccounts} categories={categories} onChange={onChange} onDelete={onDelete} />
      )}
    </div>
  );
}

/* ============================================================================
   CATEGORY MANAGEMENT
============================================================================ */
function CategoryManager({ data, setData }) {
  const t = useTheme();
  const categories = data.categories;
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null); // category name currently being renamed
  const [editDraft, setEditDraft] = useState("");

  const countFor = (c) => data.bills.filter((b) => (b.category || "Misc") === c).length;

  const addCategory = () => {
    const name = newName.trim();
    if (!name || categories.includes(name)) return;
    setData({ ...data, categories: [...categories, name] });
    setNewName("");
  };

  const startRename = (c) => {
    setEditingId(c);
    setEditDraft(c);
  };

  const commitRename = (oldName) => {
    const name = editDraft.trim();
    setEditingId(null);
    if (!name || name === oldName) return;
    if (categories.includes(name)) return; // no duplicates
    setData({
      ...data,
      categories: categories.map((c) => (c === oldName ? name : c)),
      bills: data.bills.map((b) => ((b.category || "Misc") === oldName ? { ...b, category: name } : b)),
    });
  };

  const deleteCategory = (c) => {
    if (categories.length <= 1) return; // always keep at least one category
    const remaining = categories.filter((x) => x !== c);
    const fallback = remaining.includes("Misc") ? "Misc" : remaining[0];
    setData({
      ...data,
      categories: remaining,
      bills: data.bills.map((b) => ((b.category || "Misc") === c ? { ...b, category: fallback } : b)),
    });
  };

  return (
    <div className="rounded-lg p-4 shadow-sm space-y-3" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
      <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Manage categories</p>
      <div className="flex flex-col gap-1.5">
        {categories.map((c) => (
          <div key={c} className="flex items-center gap-2">
            {editingId === c ? (
              <input
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={() => commitRename(c)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingId(null); }}
                className="flex-1 rounded px-2 py-1 text-[13px] focus:outline-none"
                style={{ background: t.inputBg, border: `1px solid ${t.green}`, color: t.ink }}
              />
            ) : (
              <button
                onClick={() => startRename(c)}
                className="flex-1 text-left rounded px-2 py-1 text-[13px] transition-colors"
                style={{ color: t.ink }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.hoverBg)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                title="Click to rename"
              >
                {c}
              </button>
            )}
            <span className="text-[11px] shrink-0 w-14 text-right" style={{ color: t.inkSoft }}>{countFor(c)} bill{countFor(c) === 1 ? "" : "s"}</span>
            <button
              onClick={() => deleteCategory(c)}
              disabled={categories.length <= 1}
              title={categories.length <= 1 ? "At least one category is required" : "Delete category"}
              className="p-1 rounded shrink-0"
              style={{ color: categories.length <= 1 ? t.rule : t.rust, opacity: categories.length <= 1 ? 0.5 : 1 }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1" style={{ borderTop: `1px solid ${t.ruleSoft}` }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addCategory(); }}
          placeholder="New category name…"
          className="flex-1 rounded px-2 py-1.5 text-[13px] focus:outline-none mt-2"
          style={{ background: t.inputBg, border: `1px solid ${t.rule}`, color: t.ink }}
        />
        <button
          onClick={addCategory}
          className="flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-md mt-2 shrink-0"
          style={{ color: t.green }}
        >
          <Plus size={13} /> Add
        </button>
      </div>
      <p className="text-[11px]" style={{ color: t.inkSoft }}>Deleting a category moves its bills to Misc (or the first remaining category). Renaming updates every bill using it.</p>
    </div>
  );
}

/* ============================================================================
   TABS
============================================================================ */
function BillsTab({ data, setData, periods }) {
  const t = useTheme();
  const categories = data.categories;
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState("category"); // "category" | "name" | "amount"
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [showCategoryManager, setShowCategoryManager] = useState(false);

  const nextByIndex = useMemo(() => {
    const map = {};
    data.bills.forEach((b) => {
      for (const p of periods) {
        if (p.lineItems.some((li) => !li.isEarlyPayment && li.name === b.name && li.account === b.account)) {
          map[b.id] = p.date;
          break;
        }
      }
    });
    return map;
  }, [periods, data.bills]);

  const updateBill = (id, updated) => {
    setData({ ...data, bills: data.bills.map((b) => (b.id === id ? updated : b)) });
  };
  const deleteBill = (id) => {
    setData({ ...data, bills: data.bills.filter((b) => b.id !== id) });
    setExpandedId(null);
  };
  const addBill = () => {
    const id = `b${Date.now()}`;
    const newBill = {
      id, name: "New bill", scheduleType: 1, targetDay: 1,
      startDate: fmtISO(new Date()), endDate: null, oddEven: 1, weeks: 4,
      amountType: "fixed", amount: 0, pct: 0, account: null, periodOverrides: {},
      category: categories.includes("Misc") ? "Misc" : categories[0],
      autoPay: false,
    };
    setData({ ...data, bills: [newBill, ...data.bills] });
    setExpandedId(id);
  };

  const monthlyEquivalent = (b) => {
    // rough monthly-equivalent for sorting by amount, regardless of amount type/schedule
    if (b.amountType !== "fixed") return 0;
    return b.amount || 0;
  };

  const filtered = data.bills.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()));

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "amount") return monthlyEquivalent(b) - monthlyEquivalent(a);
    // category
    const ca = a.category || "Misc";
    const cb = b.category || "Misc";
    if (ca !== cb) return categories.indexOf(ca) - categories.indexOf(cb);
    return a.name.localeCompare(b.name);
  });

  // group into sections when sorted by category
  const groups = useMemo(() => {
    if (sortBy !== "category") return null;
    const map = {};
    sorted.forEach((b) => {
      const c = b.category || "Misc";
      if (!map[c]) map[c] = [];
      map[c].push(b);
    });
    return categories
      .filter((c) => map[c] && map[c].length > 0)
      .map((c) => ({ category: c, bills: map[c], total: map[c].reduce((s, b) => s + monthlyEquivalent(b), 0) }));
  }, [sorted, sortBy, categories]);

  const toggleCollapsed = (c) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const sortOptions = [
    { id: "category", label: "Category" },
    { id: "name", label: "Name" },
    { id: "amount", label: "Amount" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <TextInput
          placeholder="Search bills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-[160px]"
        />
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Sort</span>
          <div className="flex rounded-md overflow-hidden" style={{ border: `1px solid ${t.rule}` }}>
            {sortOptions.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setSortBy(opt.id)}
                className="px-2.5 py-1.5 text-[12px] font-medium transition-colors"
                style={{
                  background: sortBy === opt.id ? t.ink : "transparent",
                  color: sortBy === opt.id ? t.pageBg : t.inkSoft,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => setShowCategoryManager((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] font-medium rounded-md px-2.5 py-1.5 transition-colors"
          style={{ color: showCategoryManager ? t.ink : t.inkSoft, border: `1px solid ${t.rule}`, background: showCategoryManager ? t.hoverBg : "transparent" }}
        >
          <Settings2 size={13} /> Categories
        </button>
        <button
          onClick={addBill}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[14px] font-medium transition-colors"
          style={{ background: t.ink, color: t.pageBg }}
          onMouseEnter={(e) => (e.currentTarget.style.background = t.btnBgHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = t.ink)}
        >
          <Plus size={15} /> Add bill
        </button>
      </div>

      {showCategoryManager && <CategoryManager data={data} setData={setData} />}

      {sorted.length === 0 && (
        <div className="rounded-lg p-8 text-center text-[14px]" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}`, color: t.inkSoft }}>
          No bills match “{filter}”.
        </div>
      )}

      {sortBy === "category" && groups ? (
        <div className="space-y-4">
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.category);
            return (
              <div key={g.category} className="rounded-lg overflow-hidden shadow-sm" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
                <button
                  onClick={() => toggleCollapsed(g.category)}
                  className="w-full flex items-center justify-between px-4 py-2 transition-colors"
                  style={{ background: t.hoverBg, borderBottom: isCollapsed ? "none" : `1px solid ${t.ruleSoft}` }}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: t.inkSoft2 }}>
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    {g.category}
                  </span>
                  <span className="flex items-center gap-2.5 text-[11px]" style={{ color: t.inkSoft }}>
                    <span>{g.bills.length} bill{g.bills.length === 1 ? "" : "s"}</span>
                    <span
                      className="font-mono text-[12px] font-semibold"
                      style={{ color: t.ink }}
                      title={g.bills.some((b) => b.amountType !== "fixed") ? "Percentage-of-pay bills aren't included in this total" : undefined}
                    >
                      {fmtMoney(g.total)}
                    </span>
                  </span>
                </button>
                {!isCollapsed && g.bills.map((bill) => (
                  <BillRow
                    key={bill.id}
                    bill={bill}
                    savingsAccounts={data.savingsAccounts}
                    categories={categories}
                    expanded={expandedId === bill.id}
                    onToggle={() => setExpandedId(expandedId === bill.id ? null : bill.id)}
                    onChange={(updated) => updateBill(bill.id, updated)}
                    onDelete={() => deleteBill(bill.id)}
                    nextOccurrence={nextByIndex[bill.id]}
                  />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        sorted.length > 0 && (
          <div className="rounded-lg overflow-hidden shadow-sm" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
            {sorted.map((bill) => (
              <BillRow
                key={bill.id}
                bill={bill}
                savingsAccounts={data.savingsAccounts}
                categories={categories}
                expanded={expandedId === bill.id}
                onToggle={() => setExpandedId(expandedId === bill.id ? null : bill.id)}
                onChange={(updated) => updateBill(bill.id, updated)}
                onDelete={() => deleteBill(bill.id)}
                nextOccurrence={nextByIndex[bill.id]}
              />
            ))}
          </div>
        )
      )}
      <p className="text-[12px] px-1" style={{ color: t.inkSoft }}>{sorted.length} of {data.bills.length} bills shown · click a row to edit its schedule, amount, or category. Per-paycheck overrides live in the Projection tab.</p>
    </div>
  );
}

function PayChangeRow({ pc, onChange, onDelete, removable }) {
  const t = useTheme();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:items-end">
      <Field label="Effective date">
        <DateInput value={pc.date} onChange={(e) => onChange({ ...pc, date: e.target.value })} />
      </Field>
      <Field label="Gross pay / check">
        <CurrencyInput value={pc.grossPay} onChange={(val) => onChange({ ...pc, grossPay: val })} />
      </Field>
      <Field label="Net pay / check">
        <div className="flex gap-1.5">
          <CurrencyInput value={pc.netPay} onChange={(val) => onChange({ ...pc, netPay: val })} />
          {removable && (
            <button onClick={onDelete} className="rounded-md p-1.5 shrink-0" style={{ color: t.rust }}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}

function PaycheckTab({ data, setData }) {
  const t = useTheme();
  const pc = data.paycheck;
  const updatePC = (patch) => setData({ ...data, paycheck: { ...pc, ...patch } });

  const currentYear = new Date().getFullYear();
  const ytdSeed = pc.ytdSeed && pc.ytdSeed.year === currentYear ? pc.ytdSeed : { year: currentYear, gross: 0, net: 0 };
  const updateYtdSeed = (patch) => updatePC({ ytdSeed: { ...ytdSeed, ...patch } });

  const paySchedule = pc.paySchedule || { type: "biweekly", customDays: DEFAULT_CUSTOM_PAY_DAYS };
  const updatePaySchedule = (patch) => updatePC({ paySchedule: { ...paySchedule, ...patch } });

  const updatePayChange = (idx, next) => {
    const arr = [...pc.payChanges];
    arr[idx] = next;
    updatePC({ payChanges: arr });
  };
  const addPayChange = () => {
    const last = pc.payChanges[pc.payChanges.length - 1] || { grossPay: 0, netPay: 0 };
    updatePC({ payChanges: [...pc.payChanges, { date: fmtISO(new Date()), grossPay: last.grossPay, netPay: last.netPay }] });
  };
  const deletePayChange = (idx) => updatePC({ payChanges: pc.payChanges.filter((_, i) => i !== idx) });

  const updateAccount = (id, patch) => {
    setData({ ...data, savingsAccounts: data.savingsAccounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  };
  const addAccount = () => {
    const id = `acct${Date.now()}`;
    setData({ ...data, savingsAccounts: [...data.savingsAccounts, { id, name: "New savings account", startingBalance: 0, actualOverrides: {} }] });
  };
  const deleteAccount = (id) => {
    setData({
      ...data,
      savingsAccounts: data.savingsAccounts.filter((a) => a.id !== id),
      bills: data.bills.map((b) => (b.account === id ? { ...b, account: null } : b)),
    });
  };

  const card = "rounded-lg p-5 shadow-sm space-y-4";
  const cardStyle = { background: t.cardBg, border: `1px solid ${t.ruleSoft}` };

  return (
    <div className="space-y-6">
      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><Calendar size={16} /> Paycheck schedule</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Pay schedule">
            <SelectInput value={paySchedule.type} onChange={(e) => updatePaySchedule({ type: e.target.value })}>
              {PAY_SCHEDULE_TYPES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </SelectInput>
          </Field>
          {paySchedule.type === "custom" && (
            <Field label="Pay days of month">
              <CustomDaysInput value={paySchedule.customDays} onChange={(days) => updatePaySchedule({ customDays: days })} />
            </Field>
          )}
          <Field label="First paycheck date">
            <DateInput value={pc.firstPayDate} onChange={(e) => updatePC({ firstPayDate: e.target.value })} />
          </Field>
          <Field label="Payment buffer (days)">
            <NumInput min="0" step="1" value={pc.bufferDays} onChange={(e) => updatePC({ bufferDays: Math.round(Number(e.target.value)) })} />
          </Field>
          <Field label="Periods to project">
            <NumInput min="1" max="104" step="1" value={pc.numPeriods} onChange={(e) => updatePC({ numPeriods: Math.round(Number(e.target.value)) })} />
          </Field>
          <Field label="Low balance alert threshold">
            <CurrencyInput value={pc.lowBalanceThreshold} onChange={(val) => updatePC({ lowBalanceThreshold: val })} />
          </Field>
        </div>
        <p className="text-[12px]" style={{ color: t.inkSoft }}>Pay is assumed <span className="font-medium" style={{ color: t.ink }}>{describePaySchedule(paySchedule)}</span>, starting from the first paycheck date. <span className="font-medium" style={{ color: t.ink }}>Payment buffer</span> shifts which paycheck a bill lands on (useful if bills are treated as due a day or two after the check actually posts) without changing the paycheck's own displayed date. <span className="font-medium" style={{ color: t.ink }}>Periods to project</span> is how many <em>upcoming</em> paychecks stay on the Projection tab — it's a sliding window, so as each one lands and moves to History, the next one takes its place.</p>
      </section>

      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><TrendingUp size={16} /> Pay rate over time</h3>
        <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>Add a new row whenever your gross or net pay changes. The projection uses whichever entry is effective as of each paycheck date.</p>
        <div className="space-y-3">
          {pc.payChanges.map((p, i) => (
            <PayChangeRow key={i} pc={p} onChange={(next) => updatePayChange(i, next)} onDelete={() => deletePayChange(i)} removable={pc.payChanges.length > 1} />
          ))}
        </div>
        <button onClick={addPayChange} className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: t.green }}>
          <Plus size={14} /> Add pay change
        </button>
      </section>

      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><TrendingUp size={16} /> Year-to-date income</h3>
        <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>
          Income already earned in {currentYear} before this tracker counts it — from an earlier paycheck, a prior job, or before you started using this app. Every {currentYear} paycheck the projection generates adds on top of this automatically, and the whole total resets to $0 when {currentYear + 1} begins.
        </p>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <Field label={`${currentYear} starting gross`}>
            <CurrencyInput value={ytdSeed.gross} onChange={(val) => updateYtdSeed({ gross: val })} />
          </Field>
          <Field label={`${currentYear} starting net`}>
            <CurrencyInput value={ytdSeed.net} onChange={(val) => updateYtdSeed({ net: val })} />
          </Field>
        </div>
      </section>

      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><Wallet size={16} /> Checking account</h3>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <Field label="Starting balance">
            <CurrencyInput value={pc.startingChecking} onChange={(val) => updatePC({ startingChecking: val })} />
          </Field>
        </div>
        <p className="text-[12px]" style={{ color: t.inkSoft }}>This is the balance right before your first projected paycheck. You can correct drift anytime by entering an actual balance directly on a row in the Projection tab.</p>
      </section>

      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><PiggyBank size={16} /> Savings accounts</h3>
        <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>Tag any bill to one of these accounts (in the Bills tab) and its paid amount will be added here as well as subtracted from checking — just like an automatic transfer. Each account's running balance is tracked paycheck by paycheck in the Projection tab, and can be corrected there anytime you check the real balance.</p>
        <div className="space-y-2">
          {data.savingsAccounts.map((a) => (
            <div key={a.id} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_32px] gap-2 sm:items-end">
              <Field label="Account name">
                <TextInput value={a.name} onChange={(e) => updateAccount(a.id, { name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-[1fr_32px] sm:contents gap-2 items-end">
                <Field label="Starting balance">
                  <CurrencyInput value={a.startingBalance} onChange={(val) => updateAccount(a.id, { startingBalance: val })} />
                </Field>
                <button onClick={() => deleteAccount(a.id)} className="rounded-md p-1.5 mb-0.5" style={{ color: t.rust }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={addAccount} className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: t.green }}>
          <Plus size={14} /> Add savings account
        </button>
      </section>
    </div>
  );
}

function SettingsTab({
  data, setData, resetToSeed, periods,
  syncConfigured, session, syncState, lastSyncedAt, syncNow,
}) {
  const t = useTheme();
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingImport, setPendingImport] = useState(null);
  const [importError, setImportError] = useState(null);
  const fileInputRef = useRef(null);

  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bill-tracker-${fmtISO(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const triggerImport = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.bills) || !parsed.paycheck) {
        throw new Error("That file doesn't look like a bill tracker export.");
      }
      setImportError(null);
      setPendingImport(migrate(parsed));
    } catch (err) {
      setPendingImport(null);
      setImportError(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
    }
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    setData(pendingImport);
    setPendingImport(null);
  };

  const availableYears = useMemo(() => yearsInPeriods(periods), [periods]);
  const currentYear = todayUTC().getUTCFullYear();
  const [reportYear, setReportYear] = useState(() => (availableYears.includes(currentYear) ? currentYear : availableYears[0] || currentYear));
  const [includeBills, setIncludeBills] = useState(false);

  const exportYTDReport = () => {
    const csv = buildYTDReportCSV(periods, reportYear, data.savingsAccounts, { includeBills, bills: data.bills });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bill-tracker-ytd-${reportYear}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const card = "rounded-lg p-5 shadow-sm space-y-4";
  const cardStyle = { background: t.cardBg, border: `1px solid ${t.ruleSoft}` };

  return (
    <div className="space-y-6">
      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><Settings size={16} /> Data</h3>
        <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>Move your data to another device, or start fresh.</p>
        <div className="flex flex-wrap items-center gap-4">
          <button onClick={exportData} className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: t.ink }}>
            <Download size={14} /> Export
          </button>
          {pendingImport ? (
            <div className="flex items-center gap-1.5 text-[13px]">
              <span style={{ color: t.inkSoft }}>Replace all data with imported file ({pendingImport.bills.length} bills)?</span>
              <button onClick={confirmImport} className="font-medium hover:underline" style={{ color: t.rust }}>Yes</button>
              <button onClick={() => setPendingImport(null)} className="hover:underline" style={{ color: t.inkSoft }}>Cancel</button>
            </div>
          ) : (
            <button onClick={triggerImport} className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: t.ink }}>
              <Upload size={14} /> Import
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
          {confirmReset ? (
            <div className="flex items-center gap-1.5 text-[13px]">
              <span style={{ color: t.inkSoft }}>
                {session
                  ? "Reset all data on this device? You'll stay signed in, and this won't touch your synced account data — the next sync will bring it back."
                  : "Reset all data?"}
              </span>
              <button onClick={() => { resetToSeed(); setConfirmReset(false); }} className="font-medium hover:underline" style={{ color: t.rust }}>Yes</button>
              <button onClick={() => setConfirmReset(false)} className="hover:underline" style={{ color: t.inkSoft }}>Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmReset(true)} className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: t.rust }}>
              <RotateCcw size={14} /> Reset
            </button>
          )}
        </div>
        {importError && <p className="text-[12px]" style={{ color: t.rust }}>{importError}</p>}
      </section>

      <AccountSection
        syncConfigured={syncConfigured} session={session} syncState={syncState} lastSyncedAt={lastSyncedAt} syncNow={syncNow}
      />

      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><FileSpreadsheet size={16} /> Year-to-date report</h3>
        <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>Every paycheck in the year you pick — gross, net, bills, checking balance, each savings account's balance, and the running YTD total through each one, all reflecting any Actual corrections you've entered — as a spreadsheet (CSV) you can open in Excel, Sheets, or Numbers.</p>
        {availableYears.length === 0 ? (
          <p className="text-[12px] italic" style={{ color: t.inkSoft }}>No paychecks generated yet — set up a paycheck schedule first.</p>
        ) : (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-[13px] cursor-pointer" style={{ color: t.ink }}>
              <input type="checkbox" checked={includeBills} onChange={(e) => setIncludeBills(e.target.checked)} style={{ accentColor: t.green }} />
              Include individual bill line items (date, bill, category, amount — one row per bill paid)
            </label>
            <div className="flex items-end gap-3">
              <Field label="Year" className="w-32">
                <SelectInput value={reportYear} onChange={(e) => setReportYear(Number(e.target.value))}>
                  {availableYears.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </SelectInput>
              </Field>
              <button
                onClick={exportYTDReport}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[14px] font-medium transition-colors"
                style={{ background: t.ink, color: t.pageBg }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.btnBgHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = t.ink)}
              >
                <Download size={14} /> Download report
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ============================================================================
   DOWNLOADS (Docker build only) — lists whatever installers happen to be in
   the server's downloads/ folder, read live from nginx's JSON directory
   listing (see docker/default.conf) rather than a hardcoded file list, so
   dropping a new build in that folder just shows up with no code change.
============================================================================ */
const DOWNLOAD_CATEGORIES = [
  { id: "windows", label: "Windows", icon: Monitor, match: (n) => n.endsWith(".exe") },
  { id: "mac", label: "macOS", icon: Laptop, match: (n) => n.endsWith(".dmg") },
  { id: "android", label: "Android", icon: Smartphone, match: (n) => n.endsWith(".apk") },
];

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  const mb = n / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function DownloadRow({ file }) {
  const t = useTheme();
  let modified = "";
  const d = new Date(file.mtime);
  if (!Number.isNaN(d.getTime())) modified = fmtShort(d);
  return (
    <a
      href={`/downloads/${encodeURIComponent(file.name)}`}
      download
      className="flex items-center justify-between gap-3 text-[13px] rounded-md px-3 py-2 transition-colors"
      style={{ color: t.ink, border: `1px solid ${t.rule}` }}
      onMouseEnter={(e) => (e.currentTarget.style.background = t.hoverBg)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span className="truncate">{file.name}</span>
      <span className="flex items-center gap-2 shrink-0 text-[11px] font-mono" style={{ color: t.inkSoft }}>
        {modified && <span>{modified}</span>}
        <span>{formatBytes(file.size)}</span>
      </span>
    </a>
  );
}

function DownloadsTab() {
  const t = useTheme();
  const [files, setFiles] = useState(null); // null = loading; [] once loaded (possibly empty)
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/downloads/", { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(`http-${res.status}`);
        return res.json();
      })
      .then((entries) => {
        if (cancelled) return;
        // Dotfiles (e.g. the folder's own .gitkeep placeholder) aren't real
        // downloads — filtered out rather than shown as an "Other" file.
        setFiles(entries.filter((e) => e.type === "file" && !e.name.startsWith(".")));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || "failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!files) return null;
    const groups = DOWNLOAD_CATEGORIES.map((c) => ({ ...c, files: files.filter((f) => c.match(f.name.toLowerCase())) }));
    const matchedNames = new Set(groups.flatMap((g) => g.files.map((f) => f.name)));
    return { groups, other: files.filter((f) => !matchedNames.has(f.name)) };
  }, [files]);

  const card = "rounded-lg p-5 shadow-sm space-y-4";
  const cardStyle = { background: t.cardBg, border: `1px solid ${t.ruleSoft}` };

  return (
    <div className="space-y-4">
      <section className={card} style={cardStyle}>
        <h3 className="flex items-center gap-2 font-serif text-[17px]" style={{ color: t.ink }}><Download size={16} /> Downloads</h3>
        <p className="text-[12px] -mt-1" style={{ color: t.inkSoft }}>Install Bill Tracker on another device. This list reflects whatever's currently in the server's downloads folder.</p>

        {error && <p className="text-[12px] italic" style={{ color: t.rust }}>Couldn't load the downloads list ({error}).</p>}
        {!error && files === null && <p className="text-[12px] italic" style={{ color: t.inkSoft }}>Loading…</p>}
        {!error && files !== null && files.length === 0 && <p className="text-[12px] italic" style={{ color: t.inkSoft }}>No downloads available yet.</p>}

        {grouped && grouped.groups.map(
          (g) =>
            g.files.length > 0 && (
              <div key={g.id} className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>
                  <g.icon size={12} /> {g.label}
                </p>
                {g.files.map((f) => (
                  <DownloadRow key={f.name} file={f} />
                ))}
              </div>
            )
        )}

        {grouped && grouped.other.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Other files</p>
            {grouped.other.map((f) => (
              <DownloadRow key={f.name} file={f} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProjectionChart({ periods, threshold, title = "Checking balance projection" }) {
  const t = useTheme();
  const chartData = periods.map((p) => ({
    date: fmtShort(p.date),
    balance: Number(p.endingBal.toFixed(2)),
  }));
  // Recharts can fail to redraw an existing <Line> when only its underlying
  // values change (not the point count) if the update happens inside a
  // multi-line chart alongside other re-renders. Keying the chart on a
  // fingerprint of the actual numbers forces a clean remount whenever any
  // value changes, which is the reliable fix rather than trusting shallow
  // prop diffing inside the library.
  const fingerprint = chartData.map((d) => d.balance).join(",");
  return (
    <div className="rounded-lg p-4 shadow-sm" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
      <h3 className="font-serif text-[16px] mb-3" style={{ color: t.ink }}>{title}</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart key={fingerprint} data={chartData} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid stroke={t.ruleSoft} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: t.inkSoft }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: t.inkSoft }} width={64} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(v) => [fmtMoney(v), "Balance"]}
            contentStyle={{ background: t.inputBg, border: `1px solid ${t.rule}`, borderRadius: 6, fontSize: 12, color: t.ink }}
          />
          <ReferenceLine y={threshold} stroke={t.rust} strokeDasharray="4 3" label={{ value: "threshold", fontSize: 10, fill: t.rust, position: "insideTopLeft" }} />
          <ReferenceLine y={0} stroke={t.ink} strokeOpacity={0.3} />
          <Line type="monotone" dataKey="balance" stroke={t.green} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TotalWorthChart({ periods, savingsAccounts, title = "Total across all accounts" }) {
  const t = useTheme();
  const chartData = periods.map((p) => {
    const savingsTotal = savingsAccounts.reduce((s, a) => s + (p.savingsBal[a.id] || 0), 0);
    return {
      date: fmtShort(p.date),
      total: Number((p.endingBal + savingsTotal).toFixed(2)),
      checking: Number(p.endingBal.toFixed(2)),
      savings: Number(savingsTotal.toFixed(2)),
    };
  });
  const fingerprint = chartData.map((d) => `${d.total}|${d.checking}|${d.savings}`).join(",");
  return (
    <div className="rounded-lg p-4 shadow-sm" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
      <h3 className="font-serif text-[16px] mb-3" style={{ color: t.ink }}>{title}</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart key={fingerprint} data={chartData} margin={{ top: 5, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid stroke={t.ruleSoft} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: t.inkSoft }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: t.inkSoft }} width={64} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(v, name) => [fmtMoney(v), name === "total" ? "Checking + savings" : name === "checking" ? "Checking" : "Savings"]}
            contentStyle={{ background: t.inputBg, border: `1px solid ${t.rule}`, borderRadius: 6, fontSize: 12, color: t.ink }}
          />
          <ReferenceLine y={0} stroke={t.ink} strokeOpacity={0.3} />
          <Line type="monotone" dataKey="total" stroke={t.ink} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="checking" stroke={t.green} strokeWidth={1} strokeDasharray="3 3" dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="savings" stroke={t.gold} strokeWidth={1} strokeDasharray="3 3" dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-2 pl-1">
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: t.inkSoft }}><span className="w-3 h-0.5 inline-block" style={{ background: t.ink }} /> Total</span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: t.inkSoft }}><span className="w-3 h-0.5 inline-block" style={{ background: t.green, borderTop: "1px dashed" }} /> Checking</span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: t.inkSoft }}><span className="w-3 h-0.5 inline-block" style={{ background: t.gold }} /> Savings</span>
      </div>
    </div>
  );
}

/* Editable per-paycheck running balance for a savings account. Mirrors the
   checking "Actual" column: the derived value is a placeholder, and entering
   a real observed balance corrects drift from there forward. */
function SavingsBalanceInput({ account, periodIndex, projected, isOverridden, data, setData }) {
  const t = useTheme();
  const [draft, setDraft] = useState(null);
  const cancelledRef = useRef(false);
  const cellRef = useRef(null);
  // Portaled to document.body for the same reason as the Balance column's
  // note: a "previous paycheck" row is dimmed via opacity on the whole
  // <tr>, which always compounds onto descendants — a nested tooltip would
  // inherit that fade no matter how it's styled, so it has to live outside
  // the row's subtree.
  const [tipPos, setTipPos] = useState(null);
  const showTip = () => {
    if (!isOverridden || !cellRef.current) return;
    const r = cellRef.current.getBoundingClientRect();
    setTipPos({ top: r.top - 6, right: window.innerWidth - r.right });
  };
  const hideTip = () => setTipPos(null);
  const committed = account.actualOverrides ? account.actualOverrides[periodIndex] : undefined;
  const inputVal = draft !== null ? draft : formatCommittedAmount(committed);

  const commit = (val) => {
    const clean = sanitizeAmount(val);
    const overrides = { ...(account.actualOverrides || {}) };
    if (clean === "") delete overrides[periodIndex];
    else overrides[periodIndex] = clean;
    setData({
      ...data,
      savingsAccounts: data.savingsAccounts.map((a) => (a.id === account.id ? { ...a, actualOverrides: overrides } : a)),
    });
    setDraft(null);
  };

  return (
    <div ref={cellRef} className="flex items-center justify-end gap-1" onMouseEnter={showTip} onMouseLeave={hideTip}>
      {isOverridden && (
        <button onClick={() => commit("")} title="Reset to calculated balance" className="p-0.5" style={{ color: t.inkSoft }}>
          <X size={11} />
        </button>
      )}
      <span className="text-[11px]" style={{ color: t.inkSoft }}>$</span>
      <input
        value={inputVal}
        placeholder={projected.toFixed(2)}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => { if (cancelledRef.current) { cancelledRef.current = false; setDraft(null); return; } commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelledRef.current = true; e.currentTarget.blur(); } }}
        className="w-20 text-right font-mono text-[12px] rounded px-1 py-0.5 focus:outline-none"
        style={{
          background: isOverridden ? t.goldTintBg : t.inputBg,
          border: `1px solid ${isOverridden ? t.gold : t.rule}`,
          color: t.gold,
          fontWeight: isOverridden ? 700 : 400,
        }}
      />
      {tipPos && isOverridden && createPortal(
        <div
          className="fixed text-[12px] font-mono font-semibold leading-none whitespace-nowrap rounded px-1.5 py-1 shadow-sm pointer-events-none"
          style={{ top: tipPos.top, right: tipPos.right, transform: "translateY(-100%)", color: t.ink, background: t.cardBg, border: `1px solid ${t.rule}`, zIndex: 50 }}
        >
          {fmtMoney(projected)}
        </div>,
        document.body
      )}
    </div>
  );
}

/* Editable per-paycheck amount for a single bill occurrence. Overrides are
   stored on the bill itself, keyed by period index, so "the electric bill on
   the Sept 4 paycheck" can be dialed in without touching the bill's normal
   schedule or its amount on every other paycheck. */
function LineItemAmountInput({ li, periodIndex, data, setData }) {
  const t = useTheme();
  const [draft, setDraft] = useState(null);
  const cancelledRef = useRef(false);
  const bill = data.bills.find((b) => b.id === li.billId);
  const committed = bill && bill.periodOverrides ? bill.periodOverrides[periodIndex] : undefined;
  const inputVal = draft !== null ? draft : formatCommittedAmount(committed);

  const commit = (val) => {
    if (!bill) return;
    const clean = sanitizeAmount(val);
    const overrides = { ...(bill.periodOverrides || {}) };
    if (clean === "") delete overrides[periodIndex];
    else overrides[periodIndex] = clean;
    setData({ ...data, bills: data.bills.map((b) => (b.id === bill.id ? { ...b, periodOverrides: overrides } : b)) });
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      {li.isOverridden && (
        <button onClick={() => commit("")} title="Reset to calculated amount" className="p-0.5" style={{ color: t.inkSoft }}>
          <X size={11} />
        </button>
      )}
      <span className="text-[11px]" style={{ color: t.inkSoft }}>$</span>
      <input
        value={inputVal}
        placeholder={li.amount.toFixed(2)}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => { if (cancelledRef.current) { cancelledRef.current = false; setDraft(null); return; } commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelledRef.current = true; e.currentTarget.blur(); } }}
        className="w-16 text-right font-mono text-[12px] rounded px-1 py-0.5 focus:outline-none"
        style={{
          background: li.isOverridden ? t.goldTintBg : t.inputBg,
          border: `1px solid ${li.isOverridden ? t.gold : t.rule}`,
          color: li.isOverridden ? t.goldDark : t.ink,
          fontWeight: li.isOverridden ? 600 : 400,
        }}
      />
    </div>
  );
}

/* Editable gross pay for a single paycheck — same idea as net pay: dial in
   a one-off overtime check without touching the standing pay rate. Feeds
   both the % of gross bills and the YTD gross total for that period. */
function GrossPayInput({ p, data, setData }) {
  const t = useTheme();
  const [draft, setDraft] = useState(null);
  const cancelledRef = useRef(false);
  const committed = data.paycheck.grossPayOverrides ? data.paycheck.grossPayOverrides[p.index] : undefined;
  const inputVal = draft !== null ? draft : formatCommittedAmount(committed);

  const commit = (val) => {
    const clean = sanitizeAmount(val);
    const overrides = { ...(data.paycheck.grossPayOverrides || {}) };
    if (clean === "") delete overrides[p.index];
    else overrides[p.index] = clean;
    setData({ ...data, paycheck: { ...data.paycheck, grossPayOverrides: overrides } });
    setDraft(null);
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {p.isGrossPayOverridden && (
        <button onClick={() => commit("")} title="Reset to scheduled gross pay" className="p-0.5" style={{ color: t.inkSoft }}>
          <X size={11} />
        </button>
      )}
      <span className="text-[13px]" style={{ color: t.inkSoft }}>$</span>
      <input
        value={inputVal}
        placeholder={p.baseGrossPay.toFixed(2)}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => { if (cancelledRef.current) { cancelledRef.current = false; setDraft(null); return; } commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelledRef.current = true; e.currentTarget.blur(); } }}
        className="w-20 text-right font-mono text-[13px] rounded px-1 py-0.5 focus:outline-none"
        style={{
          background: p.isGrossPayOverridden ? t.goldTintBg : t.inputBg,
          border: `1px solid ${p.isGrossPayOverridden ? t.gold : t.rule}`,
          color: p.isGrossPayOverridden ? t.goldDark : t.ink,
          fontWeight: p.isGrossPayOverridden ? 600 : 400,
        }}
      />
    </div>
  );
}

/* Editable net pay for a single paycheck — lets a one-off overtime or
   reduced-hours check be dialed in without touching the standing pay rate
   in payChanges, which would otherwise apply to every future check too. */
function NetPayInput({ p, data, setData }) {
  const t = useTheme();
  const [draft, setDraft] = useState(null);
  const cancelledRef = useRef(false);
  const committed = data.paycheck.netPayOverrides ? data.paycheck.netPayOverrides[p.index] : undefined;
  const inputVal = draft !== null ? draft : formatCommittedAmount(committed);

  const commit = (val) => {
    const clean = sanitizeAmount(val);
    const overrides = { ...(data.paycheck.netPayOverrides || {}) };
    if (clean === "") delete overrides[p.index];
    else overrides[p.index] = clean;
    setData({ ...data, paycheck: { ...data.paycheck, netPayOverrides: overrides } });
    setDraft(null);
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {p.isNetPayOverridden && (
        <button onClick={() => commit("")} title="Reset to scheduled net pay" className="p-0.5" style={{ color: t.inkSoft }}>
          <X size={11} />
        </button>
      )}
      <span className="text-[13px]" style={{ color: t.inkSoft }}>$</span>
      <input
        value={inputVal}
        placeholder={p.baseNetPay.toFixed(2)}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => { if (cancelledRef.current) { cancelledRef.current = false; setDraft(null); return; } commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelledRef.current = true; e.currentTarget.blur(); } }}
        className="w-20 text-right font-mono text-[13px] rounded px-1 py-0.5 focus:outline-none"
        style={{
          background: p.isNetPayOverridden ? t.goldTintBg : t.inputBg,
          border: `1px solid ${p.isNetPayOverridden ? t.gold : t.rule}`,
          color: p.isNetPayOverridden ? t.goldDark : t.green,
          fontWeight: p.isNetPayOverridden ? 600 : 400,
        }}
      />
    </div>
  );
}

function PeriodRow({ p, data, setData, isCurrent = false, isPrevious = false }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  // Auto-pay bills only ever show up under the paycheck they actually come
  // out of (p.lineItems, from runProjection — unchanged). Non-auto-pay bills
  // additionally show as an editable early-payment row under every OTHER
  // paycheck — defaulting to $0, but a real entry there both charges that
  // paycheck for real and reduces what's left owed on the bill's actual due
  // period (runProjection handles that reduction; this just needs a row to
  // edit from). Reuses the real lineItem if the user already entered one
  // here (isEarlyPayment: true), otherwise a $0 placeholder to type into.
  const dueLineItems = useMemo(() => p.lineItems.filter((li) => !li.isEarlyPayment), [p.lineItems]);
  // A bill outside its own active window (before its start date, or after
  // its end date) isn't a real obligation on this paycheck at all — it
  // shouldn't show as a reminder to pay early any more than an auto-pay
  // bill would show as actually due there.
  const isActiveOn = (b, date) => {
    if (date < parseDate(b.startDate)) return false;
    if (b.endDate && date > parseDate(b.endDate)) return false;
    return true;
  };
  const reminderRows = useMemo(
    () =>
      data.bills
        .filter((b) => !b.autoPay && isActiveOn(b, p.date) && !dueLineItems.some((li) => li.billId === b.id))
        .map((b) => p.lineItems.find((li) => li.billId === b.id && li.isEarlyPayment) || { billId: b.id, name: b.name, amount: 0, account: b.account, isOverridden: false, isEarlyPayment: true }),
    [data.bills, dueLineItems, p.lineItems, p.date]
  );
  const [draft, setDraft] = useState(null);
  const cancelledRef = useRef(false);
  const balanceCellRef = useRef(null);
  // Portaled to document.body rather than rendered inline: the "previous
  // paycheck" row is dimmed via opacity on the whole <tr>, and CSS opacity
  // always compounds onto descendants with no way for a child to opt back
  // out — a nested tooltip would inherit that fade no matter how it's
  // styled. Rendering it outside the row's subtree escapes that entirely.
  const [tipPos, setTipPos] = useState(null);
  const showTip = () => {
    if (!p.isOverridden || !balanceCellRef.current) return;
    const r = balanceCellRef.current.getBoundingClientRect();
    setTipPos({ top: r.top - 6, right: window.innerWidth - r.right });
  };
  const hideTip = () => setTipPos(null);
  const committed = data.paycheck.actualOverrides[p.index];
  const inputVal = draft !== null ? draft : formatCommittedAmount(committed);

  const commit = (val) => {
    const clean = sanitizeAmount(val);
    const overrides = { ...data.paycheck.actualOverrides };
    if (clean === "") delete overrides[p.index];
    else overrides[p.index] = clean;
    setData({ ...data, paycheck: { ...data.paycheck, actualOverrides: overrides } });
    setDraft(null);
  };

  return (
    <>
      <tr
        style={{
          borderBottom: `1px solid ${t.ruleRow}`,
          background: p.isLow ? t.rustTintBg : isCurrent ? t.hoverBg : "transparent",
          opacity: isPrevious ? 0.6 : 1,
        }}
      >
        <td className="py-2 pl-3 pr-2" style={{ borderLeft: `3px solid ${isCurrent ? t.green : "transparent"}` }}>
          <button onClick={() => setOpen(!open)} style={{ color: t.inkSoft }}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className="py-2 pr-3 whitespace-nowrap text-[13px]" style={{ color: t.ink }}>{fmtShort(p.date)}</td>
        <td className="py-2 pr-3 text-right font-mono text-[13px]" style={{ color: p.isNetPayOverridden ? t.goldDark : t.green, fontWeight: p.isNetPayOverridden ? 600 : 400 }}>
          {fmtMoney(p.netPay)}
        </td>
        <td className="py-2 pr-3 text-right font-mono text-[13px]" style={{ color: t.rust }}>{fmtMoney(-p.totalBills)}</td>
        <td ref={balanceCellRef} className="py-2 pr-3 text-right relative" onMouseEnter={showTip} onMouseLeave={hideTip} style={{ overflow: "visible" }}>
          <div className="flex items-center justify-end gap-1">
            {p.isLow && <AlertTriangle size={13} style={{ color: t.rust }} />}
            {p.isOverridden && (
              <button onClick={() => commit("")} title="Clear actual balance, use projected instead" className="p-0.5" style={{ color: t.inkSoft }}>
                <X size={12} />
              </button>
            )}
            <span className="text-[13px]" style={{ color: t.inkSoft }}>$</span>
            <input
              value={inputVal}
              placeholder={p.projectedBal.toFixed(2)}
              inputMode="decimal"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => { if (cancelledRef.current) { cancelledRef.current = false; setDraft(null); return; } commit(e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelledRef.current = true; e.currentTarget.blur(); } }}
              className="w-20 text-right font-mono text-[13px] rounded px-1 py-0.5 focus:outline-none"
              style={{
                background: p.isOverridden ? t.goldTintBg : t.inputBg,
                border: `1px solid ${p.isOverridden ? t.gold : t.rule}`,
                color: p.isOverridden ? t.goldDark : t.ink,
                fontWeight: p.isOverridden ? 600 : 400,
              }}
            />
          </div>
        </td>
        {data.savingsAccounts.map((a) => (
          <td key={a.id} className="py-2 pr-3 text-right font-mono text-[12px]">
            <SavingsBalanceInput
              account={a}
              periodIndex={p.index}
              projected={p.savingsProjected ? p.savingsProjected[a.id] || 0 : p.savingsBal[a.id] || 0}
              isOverridden={p.savingsIsOverridden ? !!p.savingsIsOverridden[a.id] : false}
              data={data}
              setData={setData}
            />
          </td>
        ))}
      </tr>
      {tipPos && p.isOverridden && createPortal(
        <div
          className="fixed text-[12px] font-mono font-semibold leading-none whitespace-nowrap rounded px-1.5 py-1 shadow-sm pointer-events-none"
          style={{ top: tipPos.top, right: tipPos.right, transform: "translateY(-100%)", color: t.ink, background: t.cardBg, border: `1px solid ${t.rule}`, zIndex: 50 }}
        >
          {fmtMoney(p.projectedBal)}
        </div>,
        document.body
      )}
      {open && (
        <tr>
          <td colSpan={5 + data.savingsAccounts.length} className="px-6 py-3" style={{ background: t.hoverBg }}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-3 mb-3" style={{ borderBottom: `1px solid ${t.ruleSoft}` }}>
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Gross pay</span>
                <GrossPayInput p={p} data={data} setData={setData} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Net pay</span>
                <NetPayInput p={p} data={data} setData={setData} />
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>{p.ytdYear} gross YTD</span>
                <span className="font-mono text-[13px]" style={{ color: t.ink }}>{fmtMoney(p.ytdGrossThroughPeriod)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>{p.ytdYear} net YTD</span>
                <span className="font-mono text-[13px]" style={{ color: t.green }}>{fmtMoney(p.ytdNetThroughPeriod)}</span>
              </div>
            </div>
            {dueLineItems.length === 0 && reminderRows.length === 0 ? (
              <p className="text-[12px] italic" style={{ color: t.inkSoft }}>No bills due this paycheck.</p>
            ) : (
              <>
                {dueLineItems.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                    {dueLineItems.map((li, i) => {
                      const acct = li.account && data.savingsAccounts.find((a) => a.id === li.account);
                      const bill = data.bills.find((b) => b.id === li.billId);
                      return (
                        <div key={i} className="flex items-center justify-between text-[12px] gap-3">
                          <span className="truncate flex items-center gap-1.5" style={{ color: t.inkSoft2 }}>
                            {li.name}
                            {bill && bill.autoPay && <Repeat size={11} className="shrink-0" style={{ color: t.green }} title="Auto-pay enabled" />}
                            {acct && (
                              <span className="flex items-center gap-0.5 shrink-0 text-[10px]" style={{ color: t.gold }}>
                                <PiggyBank size={11} /> {acct.name} → {fmtMoney(p.savingsBal[acct.id] || 0)}
                              </span>
                            )}
                          </span>
                          <LineItemAmountInput li={li} periodIndex={p.index} data={data} setData={setData} />
                        </div>
                      );
                    })}
                  </div>
                )}
                {reminderRows.length > 0 && (
                  <div
                    className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5"
                    style={dueLineItems.length > 0 ? { marginTop: "10px", paddingTop: "10px", borderTop: `1px dashed ${t.ruleSoft}` } : undefined}
                  >
                    {reminderRows.map((li) => {
                      const nextDue = p.nextDueByBill && p.nextDueByBill[li.billId];
                      return (
                        <div key={li.billId} className="flex items-center justify-between text-[12px] gap-3" style={{ opacity: li.amount ? 1 : 0.6 }}>
                          <span className="truncate flex items-center gap-1.5" style={{ color: t.inkSoft }}>
                            <Bell size={11} className="shrink-0" />
                            <span className="truncate">{li.name}</span>
                            <span className="text-[10px] italic shrink-0" style={{ color: t.inkSoft }}>
                              not due{nextDue ? ` — next ${fmtShortRelativeTo(nextDue, p.date)}` : ""} — pay early
                            </span>
                          </span>
                          <LineItemAmountInput li={li} periodIndex={p.index} data={data} setData={setData} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* Shared paycheck-by-paycheck table for both the Projection and History
   tabs — same columns and same editable cells either way, just fed a
   different slice of `periods`. */
function PeriodTable({ data, setData, periods, currentIndex = null, previousIndex = null }) {
  const t = useTheme();
  return (
    <div className="rounded-lg shadow-sm overflow-x-auto" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr style={{ borderBottom: `1px solid ${t.rule}`, textAlign: "left" }}>
            <th className="w-8"></th>
            <th className="py-2 pr-3 text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Paycheck</th>
            <th className="py-2 pr-3 text-[11px] uppercase tracking-wide font-semibold text-right" style={{ color: t.inkSoft }}>Net pay</th>
            <th className="py-2 pr-3 text-[11px] uppercase tracking-wide font-semibold text-right" style={{ color: t.inkSoft }}>Bills</th>
            <th className="py-2 pr-3 text-[11px] uppercase tracking-wide font-semibold text-right" style={{ color: t.inkSoft }}>Balance</th>
            {data.savingsAccounts.map((a) => (
              <th key={a.id} className="py-2 pr-3 text-[11px] uppercase tracking-wide font-semibold text-right" style={{ color: t.inkSoft }}>{a.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <PeriodRow key={p.index} p={p} data={data} setData={setData} isCurrent={p.index === currentIndex} isPrevious={p.index === previousIndex} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectionTab({ data, setData, periods, lowCount, totalSavings, endBal, currentIndex, previousIndex }) {
  const t = useTheme();
  const summaryCard = "rounded-lg px-4 py-3";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className={summaryCard} style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
          <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Checking, end of horizon</p>
          <p className="font-mono text-[20px] mt-0.5" style={{ color: endBal < 0 ? t.rust : t.ink }}>{fmtMoney(endBal)}</p>
        </div>
        <div className={summaryCard} style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
          <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Total savings</p>
          <p className="font-mono text-[20px] mt-0.5" style={{ color: t.gold }}>{fmtMoney(totalSavings)}</p>
        </div>
        <div className={summaryCard} style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
          <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Active bills</p>
          <p className="font-mono text-[20px] mt-0.5" style={{ color: t.ink }}>{data.bills.length}</p>
        </div>
        <div className={summaryCard} style={{ background: t.cardBg, border: `1px solid ${lowCount > 0 ? t.rust : t.ruleSoft}` }}>
          <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>Low-balance paychecks</p>
          <p className="font-mono text-[20px] mt-0.5" style={{ color: lowCount > 0 ? t.rust : t.ink }}>{lowCount}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProjectionChart periods={periods} threshold={data.paycheck.lowBalanceThreshold} />
        <TotalWorthChart periods={periods} savingsAccounts={data.savingsAccounts} />
      </div>
      <PeriodTable data={data} setData={setData} periods={periods} currentIndex={currentIndex} previousIndex={previousIndex} />
      <p className="text-[12px] px-1" style={{ color: t.inkSoft }}>
        Click the arrow to see and edit which bills hit each paycheck — adjust any bill or savings transfer just for that pay period without changing its normal amount elsewhere. <span className="font-medium" style={{ color: t.ink }}>Gross pay</span> and <span className="font-medium" style={{ color: t.green }}>net pay</span> are in there too, for a one-off overtime or short check — both feed into the YTD totals on History, and an overridden <span className="font-medium" style={{ color: t.green }}>net pay</span> shows in gold right in the table. The <span className="font-medium" style={{ color: t.ink }}>Balance</span> column shows the checking balance calculated from your bills; type over it once you check your real balance to correct it — the calculated figure stays underneath as a small reference — and each savings column works the same way. Every later row chains forward from the correction until the next one.
      </p>
    </div>
  );
}

/* Projection stays focused on what's actionable: the 2 most recent paychecks
   (for reconciling against a bank statement) plus everything upcoming.
   Anything older than that is archived to the History tab instead of
   accumulating on Projection forever. */
function splitPeriods(periods) {
  const today = todayUTC();
  const past = periods.filter((p) => p.date <= today);
  const future = periods.filter((p) => p.date > today);
  const recentPast = past.slice(-2);
  return {
    projectionPeriods: [...recentPast, ...future],
    historyPeriods: past.slice(0, -2),
    // The most recent landed paycheck ("current") and the one just before it
    // ("previous") — Projection highlights/de-emphasizes these two so the
    // one worth reconciling right now stands out at a glance.
    currentIndex: recentPast.length ? recentPast[recentPast.length - 1].index : null,
    previousIndex: recentPast.length > 1 ? recentPast[recentPast.length - 2].index : null,
  };
}

/* Year-to-date gross/net: every received paycheck (past, any tab) dated in
   the current calendar year, plus an optional starting balance for income
   already earned before tracking began. The starting balance is tagged with
   the year it was entered for, so it — and the whole total — quietly goes
   back to 0 the moment the calendar rolls to a new year. */
function computeYTD(periods, paycheck) {
  const today = todayUTC();
  const year = today.getUTCFullYear();
  const received = periods.filter((p) => p.date <= today);
  const last = received.length ? received[received.length - 1] : null;
  if (last && last.ytdYear === year) {
    return { year, gross: last.ytdGrossThroughPeriod, net: last.ytdNetThroughPeriod };
  }
  const seed = paycheck.ytdSeed;
  return {
    year,
    gross: seed && seed.year === year ? seed.gross || 0 : 0,
    net: seed && seed.year === year ? seed.net || 0 : 0,
  };
}

/* Every distinct calendar year the current projection horizon touches,
   newest first — used to populate the YTD report's year picker. */
function yearsInPeriods(periods) {
  return [...new Set(periods.map((p) => p.date.getUTCFullYear()))].sort((a, b) => b - a);
}

/* Wraps a CSV field in quotes (doubling any inner quotes) only when it
   actually needs it — account names are user-typed text and could contain a
   comma, unlike the plain numbers/dates everywhere else in this report. */
function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* One row per paycheck in the given year — date, gross, net, bills, the
   checking balance (Actual override if set, else Projected, same as the
   Balance column), each savings account's resolved balance, and the running
   YTD gross/net — plus a totals row using the last paycheck's balances.
   For the current calendar year this stops at the most recent paycheck
   that's actually landed, same as the YTD figures shown elsewhere in the
   app — future paychecks in that year are still just a projection, not
   something "year to date" should claim as received. A past year is
   already fully in the past, so it runs in full either way. Plain CSV
   rather than a real .xlsx binary: every spreadsheet app opens it natively
   and it needs no library. When options.includeBills is set, a second
   table is appended below: one row per bill *occurrence* (date, bill,
   category, amount) — the transaction-log shape accounting tools expect,
   which a per-paycheck total can't provide. */
function buildYTDReportCSV(periods, year, savingsAccounts, options = {}) {
  const { includeBills = false, bills = [] } = options;
  const accounts = savingsAccounts || [];
  const today = todayUTC();
  const isCurrentYear = year === today.getUTCFullYear();
  const rows = periods.filter((p) => p.date.getUTCFullYear() === year && (!isCurrentYear || p.date <= today));
  const header = [
    "Paycheck Date", "Gross Pay", "Net Pay", "Bills", "Checking Balance",
    ...accounts.map((a) => a.name),
    "YTD Gross", "YTD Net",
  ];
  const lines = [header.map(csvCell).join(",")];
  rows.forEach((p) => {
    const cells = [
      fmtISO(p.date),
      p.grossPay.toFixed(2),
      p.netPay.toFixed(2),
      p.totalBills.toFixed(2),
      p.endingBal.toFixed(2),
      ...accounts.map((a) => (p.savingsBal[a.id] || 0).toFixed(2)),
      p.ytdGrossThroughPeriod.toFixed(2),
      p.ytdNetThroughPeriod.toFixed(2),
    ];
    lines.push(cells.map(csvCell).join(","));
  });
  if (rows.length) {
    const last = rows[rows.length - 1];
    lines.push("");
    const totalCells = [
      "Total", "", "", "", last.endingBal.toFixed(2),
      ...accounts.map((a) => (last.savingsBal[a.id] || 0).toFixed(2)),
      last.ytdGrossThroughPeriod.toFixed(2),
      last.ytdNetThroughPeriod.toFixed(2),
    ];
    lines.push(totalCells.map(csvCell).join(","));
  }
  if (includeBills) {
    const categoryById = new Map(bills.map((b) => [b.id, b.category || "Misc"]));
    lines.push("");
    lines.push(["Paycheck Date", "Bill", "Category", "Amount"].map(csvCell).join(","));
    rows.forEach((p) => {
      p.lineItems.forEach((li) => {
        lines.push([
          fmtISO(p.date),
          li.name,
          categoryById.get(li.billId) || "Misc",
          li.amount.toFixed(2),
        ].map(csvCell).join(","));
      });
    });
  }
  return lines.join("\n");
}

function HistoryTab({ data, setData, periods, ytd }) {
  const t = useTheme();
  const tableRows = useMemo(() => [...periods].reverse(), [periods]);
  const summaryCard = "rounded-lg px-4 py-3";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className={summaryCard} style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
          <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>{ytd.year} YTD gross</p>
          <p className="font-mono text-[20px] mt-0.5" style={{ color: t.ink }}>{fmtMoney(ytd.gross)}</p>
        </div>
        <div className={summaryCard} style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
          <p className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: t.inkSoft }}>{ytd.year} YTD net</p>
          <p className="font-mono text-[20px] mt-0.5" style={{ color: t.green }}>{fmtMoney(ytd.net)}</p>
        </div>
      </div>

      {periods.length === 0 ? (
        <div className="rounded-lg p-8 text-center shadow-sm" style={{ background: t.cardBg, border: `1px solid ${t.ruleSoft}` }}>
          <Calendar size={20} className="mx-auto mb-2" style={{ color: t.inkSoft }} />
          <p className="text-[13px]" style={{ color: t.inkSoft }}>
            Nothing here yet — paychecks archive to History once there are more than two behind the current one, which still show on Projection.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ProjectionChart periods={periods} threshold={data.paycheck.lowBalanceThreshold} title="Checking balance history" />
            <TotalWorthChart periods={periods} savingsAccounts={data.savingsAccounts} title="Account balances history" />
          </div>
          <PeriodTable data={data} setData={setData} periods={tableRows} />
          <p className="text-[12px] px-1" style={{ color: t.inkSoft }}>
            Older paychecks, newest first — the 2 most recent stay on Projection for reconciling. Same row editor either way, so you can still correct an <span className="font-medium" style={{ color: t.goldDark }}>Actual</span> balance, <span className="font-medium" style={{ color: t.ink }}>gross pay</span>, or <span className="font-medium" style={{ color: t.green }}>net pay</span> here anytime you catch a discrepancy after the fact.
          </p>
        </>
      )}

      <p className="text-[12px] px-1" style={{ color: t.inkSoft }}>
        YTD totals every received paycheck dated in {ytd.year}, plus any starting balance set on the <span className="font-medium" style={{ color: t.ink }}>Pay & Accounts</span> tab. Resets to $0 on January 1st.
      </p>
    </div>
  );
}

/* ============================================================================
   APP
============================================================================ */
function AppInner({ dark, toggleDark }) {
  const {
    data, setData, loading, saveState, resetToSeed,
    syncConfigured, session, syncState, lastSyncedAt, syncNow,
  } = useStorageState();
  const t = useTheme();
  const [tab, setTab] = useState("projection");
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    // Shrinking the header changes its own height, which shifts the page
    // layout enough that a single shared threshold flips back and forth on
    // its own (the browser nudges scrollY to compensate for the size change,
    // which can cross right back over that same threshold) — a feedback
    // loop. Separate enter/exit thresholds leave a dead zone that a shift of
    // that size can't cross, so the state can only flip on real user scroll.
    const onScroll = () => {
      setScrolled((prev) => (prev ? window.scrollY > 8 : window.scrollY > 48));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const periods = useMemo(() => (data ? runProjection(data) : []), [data]);
  const { projectionPeriods, historyPeriods, currentIndex, previousIndex } = useMemo(() => splitPeriods(periods), [periods]);
  const ytd = useMemo(() => computeYTD(periods, data ? data.paycheck : { ytdSeed: null }), [periods, data]);

  if (loading || !data) {
    return (
      <div className="min-h-[400px] flex items-center justify-center font-serif" style={{ background: t.pageBg, color: t.inkSoft }}>
        Loading your bill tracker…
      </div>
    );
  }

  const lowCount = periods.filter((p) => p.isLow).length;
  const totalSavings = data.savingsAccounts.reduce((s, a) => s + (periods.length ? periods[periods.length - 1].savingsBal[a.id] || 0 : a.startingBalance), 0);
  const endBal = periods.length ? periods[periods.length - 1].endingBal : data.paycheck.startingChecking;

  const TABS = [
    { id: "projection", label: "Projection", icon: TrendingUp },
    { id: "history", label: "History", icon: Calendar },
    { id: "bills", label: "Bills", icon: Receipt },
    { id: "paycheck", label: "Pay & Accounts", icon: Settings2 },
    { id: "settings", label: "Settings", icon: Settings },
    ...(IS_DOCKER_BUILD ? [{ id: "downloads", label: "Downloads", icon: Download }] : []),
  ];

  return (
    <div className="min-h-screen transition-colors duration-150" style={{ background: t.pageBg, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-6">
        {/* Sticky header + tabs — stays pinned to the top on scroll and
            compacts itself (shorter padding, smaller title, subtitle
            collapsed) once the page has actually scrolled, so it doesn't
            permanently eat vertical space while also always giving quick
            access back to tab navigation. z-20 keeps it above page content
            but below the Balance-column portal tooltips (zIndex: 50). */}
        <div
          className="sticky top-0 z-20 transition-all duration-200"
          style={{ background: t.pageBg, paddingTop: scrolled ? "12px" : "24px", boxShadow: scrolled ? `0 1px 0 0 ${t.rule}` : "0 1px 0 0 transparent" }}
        >
          <header className={`transition-all duration-200 ${scrolled ? "mb-2" : "mb-6"}`}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h1
                  className="font-serif leading-tight transition-all duration-200"
                  style={{ color: t.ink, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: scrolled ? "18px" : "26px" }}
                >
                  {paySchedulePrefix(data.paycheck.paySchedule && data.paycheck.paySchedule.type)} Bill Ledger
                </h1>
                <p
                  className="text-[13px] mt-0.5 overflow-hidden transition-all duration-200"
                  style={{ color: t.inkSoft, opacity: scrolled ? 0 : 1, maxHeight: scrolled ? "0px" : "20px" }}
                >
                  Every bill, its schedule, and the pay period it lands in.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleDark}
                  title={dark ? "Switch to light mode" : "Switch to dark mode"}
                  className="flex items-center gap-1.5 text-[12px] rounded-full px-2.5 py-1 transition-colors"
                  style={{ color: t.inkSoft, border: `1px solid ${t.rule}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = t.hoverBg)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {dark ? <Sun size={13} /> : <Moon size={13} />}
                  {dark ? "Light" : "Dark"}
                </button>
                <SaveIndicator state={saveState} />
              </div>
            </div>
          </header>

          {/* Tabs */}
          <nav className="flex gap-1 mb-5 overflow-x-auto overflow-y-hidden" style={{ borderBottom: `1px solid ${t.rule}` }}>
            {TABS.map((tb) => {
              const Icon = tb.icon;
              const active = tab === tb.id;
              return (
                <button
                  key={tb.id}
                  onClick={() => setTab(tb.id)}
                  title={tb.label}
                  className="flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-[14px] font-medium transition-colors shrink-0"
                  style={{
                    borderBottom: `2px solid ${active ? t.green : "transparent"}`,
                    marginBottom: "-1px",
                    color: active ? t.ink : t.inkSoft,
                  }}
                >
                  <Icon size={14} /> <span className="hidden sm:inline">{tb.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {tab === "projection" && (
          <ProjectionTab
            data={data}
            setData={setData}
            periods={projectionPeriods}
            lowCount={lowCount}
            totalSavings={totalSavings}
            endBal={endBal}
            currentIndex={currentIndex}
            previousIndex={previousIndex}
          />
        )}
        {tab === "history" && <HistoryTab data={data} setData={setData} periods={historyPeriods} ytd={ytd} />}
        {tab === "bills" && <BillsTab data={data} setData={setData} periods={periods} />}
        {tab === "paycheck" && <PaycheckTab data={data} setData={setData} />}
        {tab === "settings" && (
          <SettingsTab
            data={data} setData={setData} resetToSeed={resetToSeed} periods={periods}
            syncConfigured={syncConfigured} session={session} syncState={syncState} lastSyncedAt={lastSyncedAt} syncNow={syncNow}
          />
        )}
        {tab === "downloads" && <DownloadsTab />}

        <footer className="mt-8 pt-4 text-[11px]" style={{ borderTop: `1px solid ${t.ruleSoft}`, color: t.inkSoft }}>
          Data is saved automatically to your account and persists across visits. Schedule logic ported from the original workbook's macro.
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  const [dark, toggleDark] = useDarkMode();
  return (
    <ThemeCtx.Provider value={dark ? DARK : LIGHT}>
      <AppInner dark={dark} toggleDark={toggleDark} />
    </ThemeCtx.Provider>
  );
}
