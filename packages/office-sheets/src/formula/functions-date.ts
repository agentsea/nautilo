import { ParseTree } from 'antlr4ts/tree/ParseTree';
import { FunctionContext } from '../../antlr/FormulaParser';
import { EvalNode, ErrNode, numNode } from './formula';
import { NumberArgs } from './arguments';
import { Grid } from '../model/core/types';
import {
  toSrefs,
} from '../model/core/coordinates';
import {
  toStr,
} from './functions-helpers';

/**
 * `todayFunc` is the implementation of the TODAY function.
 * TODAY() — returns the current date as YYYY-MM-DD.
 */
function todayFunc(
  _ctx: FunctionContext,
  _visit: (tree: ParseTree) => EvalNode,
  _grid?: Grid,
): EvalNode {
  return { t: 'str', v: formatDate(new Date()) };
}

/**
 * `nowFunc` is the implementation of the NOW function.
 * NOW() — returns the current date and time as YYYY-MM-DD HH:MM:SS.
 */
function nowFunc(
  _ctx: FunctionContext,
  _visit: (tree: ParseTree) => EvalNode,
  _grid?: Grid,
): EvalNode {
  const now = new Date();
  return { t: 'str', v: `${formatDate(now)} ${formatTime(now)}` };
}

/**
 * `dateFunc` is the implementation of the DATE function.
 * DATE(year, month, day) — returns a normalized date as YYYY-MM-DD.
 */
function dateFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const yearNode = NumberArgs.map(visit(exprs[0]), grid);
  if (yearNode.t === 'err') {
    return yearNode;
  }
  const monthNode = NumberArgs.map(visit(exprs[1]), grid);
  if (monthNode.t === 'err') {
    return monthNode;
  }
  const dayNode = NumberArgs.map(visit(exprs[2]), grid);
  if (dayNode.t === 'err') {
    return dayNode;
  }

  const year = Math.trunc(yearNode.v);
  const month = Math.trunc(monthNode.v);
  const day = Math.trunc(dayNode.v);
  if (!isFinite(year) || !isFinite(month) || !isFinite(day)) {
    return ErrNode.VALUE;
  }

  return { t: 'str', v: formatDate(new Date(year, month - 1, day)) };
}

/**
 * `timeFunc` is the implementation of the TIME function.
 * TIME(hour, minute, second) — returns a normalized time as HH:MM:SS.
 */
function timeFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const hourNode = NumberArgs.map(visit(exprs[0]), grid);
  if (hourNode.t === 'err') {
    return hourNode;
  }
  const minuteNode = NumberArgs.map(visit(exprs[1]), grid);
  if (minuteNode.t === 'err') {
    return minuteNode;
  }
  const secondNode = NumberArgs.map(visit(exprs[2]), grid);
  if (secondNode.t === 'err') {
    return secondNode;
  }

  const hour = Math.trunc(hourNode.v);
  const minute = Math.trunc(minuteNode.v);
  const second = Math.trunc(secondNode.v);
  if (!isFinite(hour) || !isFinite(minute) || !isFinite(second)) {
    return ErrNode.VALUE;
  }

  return { t: 'str', v: formatTime(new Date(1970, 0, 1, hour, minute, second)) };
}

/**
 * `daysFunc` is the implementation of the DAYS function.
 * DAYS(end_date, start_date) — returns the number of days between two dates.
 */
function daysFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const endDate = parseDate(visit(exprs[0]), grid);
  if (!(endDate instanceof Date)) {
    return endDate;
  }

  const startDate = parseDate(visit(exprs[1]), grid);
  if (!(startDate instanceof Date)) {
    return startDate;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const endUtc = Date.UTC(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
  );
  const startUtc = Date.UTC(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate(),
  );

  return numNode((endUtc - startUtc) / dayMs);
}

/**
 * `yearFunc` is the implementation of the YEAR function.
 * YEAR(date) — returns the year from a date.
 */
function yearFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) return date;

  return numNode(date.getFullYear());
}

/**
 * `monthFunc` is the implementation of the MONTH function.
 * MONTH(date) — returns the month (1-12) from a date.
 */
function monthFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) return date;

  return numNode(date.getMonth() + 1);
}

/**
 * `dayFunc` is the implementation of the DAY function.
 * DAY(date) — returns the day of the month from a date.
 */
function dayFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) return date;

  return numNode(date.getDate());
}

/**
 * `hourFunc` is the implementation of the HOUR function.
 * HOUR(time) — returns hour (0-23) from a time/datetime value.
 */
function hourFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDateTime(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  return numNode(date.getHours());
}

/**
 * `minuteFunc` is the implementation of the MINUTE function.
 * MINUTE(time) — returns minute (0-59) from a time/datetime value.
 */
function minuteFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDateTime(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  return numNode(date.getMinutes());
}

/**
 * `secondFunc` is the implementation of the SECOND function.
 * SECOND(time) — returns second (0-59) from a time/datetime value.
 */
function secondFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDateTime(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  return numNode(date.getSeconds());
}

/**
 * `weekdayFunc` is the implementation of the WEEKDAY function.
 * WEEKDAY(date, [type]) — returns day-of-week index based on numbering type.
 */
function weekdayFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  let type = 1;
  if (exprs.length === 2) {
    const typeNode = NumberArgs.map(visit(exprs[1]), grid);
    if (typeNode.t === 'err') {
      return typeNode;
    }
    type = Math.trunc(typeNode.v);
  }

  const day = date.getDay(); // Sunday = 0
  if (type === 1) {
    return numNode(day + 1);
  }
  if (type === 2) {
    return numNode(day === 0 ? 7 : day);
  }
  if (type === 3) {
    return numNode(day === 0 ? 6 : day - 1);
  }

  return ErrNode.VALUE;
}

/**
 * EDATE(start_date, months) — returns a date that is a given number of months before/after.
 */
function edateFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  const monthsNode = NumberArgs.map(visit(exprs[1]), grid);
  if (monthsNode.t === 'err') {
    return monthsNode;
  }

  const months = Math.trunc(monthsNode.v);
  const result = new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
  return { t: 'str', v: formatDate(result) };
}

/**
 * EOMONTH(start_date, months) — returns the last day of a month a given number of months away.
 */
function eomonthFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  const monthsNode = NumberArgs.map(visit(exprs[1]), grid);
  if (monthsNode.t === 'err') {
    return monthsNode;
  }

  const months = Math.trunc(monthsNode.v);
  // Day 0 of the next month = last day of the target month
  const result = new Date(date.getFullYear(), date.getMonth() + months + 1, 0);
  return { t: 'str', v: formatDate(result) };
}

/**
 * NETWORKDAYS(start_date, end_date) — returns the number of working days between two dates.
 * Excludes weekends (Saturday and Sunday). Holidays parameter not supported.
 */
function networkdaysFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if (!(startDate instanceof Date)) {
    return startDate;
  }

  const endDate = parseDate(visit(exprs[1]), grid);
  if (!(endDate instanceof Date)) {
    return endDate;
  }

  const direction = calendarDay(startDate) <= calendarDay(endDate) ? 1 : -1;
  const start = direction === 1 ? startDate : endDate;
  const endDay = calendarDay(direction === 1 ? endDate : startDate);

  let count = 0;
  const current = new Date(start);
  while (calendarDay(current) <= endDay) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return numNode(count * direction);
}

/**
 * NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])
 * Returns the number of working days between two dates with custom weekends.
 */
function networkdaysintlFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if ('t' in startDate) return startDate;
  const endDate = parseDate(visit(exprs[1]), grid);
  if ('t' in endDate) return endDate;

  let weekendDays = new Set([0, 6]);
  if (exprs.length >= 3) {
    const wNode = NumberArgs.map(visit(exprs[2]), grid);
    if (wNode.t !== 'err') {
      weekendDays = getWeekendDays(Math.trunc(wNode.v));
    }
  }

  const holidays = new Set<string>();
  if (exprs.length >= 4) {
    const hNode = visit(exprs[3]);
    if (hNode.t === 'ref' && grid) {
      for (const sref of toSrefs([hNode.v])) {
        const cell = grid.get(sref);
        if (cell?.v) {
          const hd = parseDateString(String(cell.v));
          if (!isNaN(hd.getTime())) {
            holidays.add(formatDate(hd));
          }
        }
      }
    }
  }

  const endDay = calendarDay(endDate);
  const direction = endDay >= calendarDay(startDate) ? 1 : -1;
  const current = new Date(startDate);
  let count = 0;
  while ((direction > 0 && calendarDay(current) <= endDay) || (direction < 0 && calendarDay(current) >= endDay)) {
    if (!weekendDays.has(current.getDay()) && !holidays.has(formatDate(current))) {
      count++;
    }
    current.setDate(current.getDate() + direction);
  }

  return numNode(count * direction);
}

/**
 * DATEVALUE(date_string) — converts a date string to a date value.
 */
function datevalueFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  return { t: 'str', v: formatDate(date) };
}

/**
 * TIMEVALUE(time_string) — converts a time string to a time value (fraction of a day).
 */
function timevalueFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDateTime(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const fraction = (hours * 3600 + minutes * 60 + seconds) / 86400;

  return numNode(fraction);
}

/**
 * DATEDIF(start_date, end_date, unit) — calculates the difference between two dates.
 * Units: "Y" (years), "M" (months), "D" (days).
 */
function datedifFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if (!(startDate instanceof Date)) {
    return startDate;
  }

  const endDate = parseDate(visit(exprs[1]), grid);
  if (!(endDate instanceof Date)) {
    return endDate;
  }

  if (startDate > endDate) {
    return ErrNode.VALUE;
  }

  const unitStr = toStr(visit(exprs[2]), grid);
  if (unitStr.t === 'err') {
    return unitStr;
  }

  const unit = unitStr.v.toUpperCase();

  if (unit === 'D') {
    const dayMs = 24 * 60 * 60 * 1000;
    const startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const endUtc = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    return numNode((endUtc - startUtc) / dayMs);
  }

  if (unit === 'M') {
    let months =
      (endDate.getFullYear() - startDate.getFullYear()) * 12 +
      (endDate.getMonth() - startDate.getMonth());
    if (endDate.getDate() < startDate.getDate()) {
      months--;
    }
    return numNode(months);
  }

  if (unit === 'Y') {
    let years = endDate.getFullYear() - startDate.getFullYear();
    if (
      endDate.getMonth() < startDate.getMonth() ||
      (endDate.getMonth() === startDate.getMonth() && endDate.getDate() < startDate.getDate())
    ) {
      years--;
    }
    return numNode(years);
  }

  if (unit === 'MD') {
    let days = endDate.getDate() - startDate.getDate();
    if (days < 0) {
      const prevMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 0);
      days += prevMonth.getDate();
    }
    return numNode(days);
  }

  if (unit === 'YM') {
    let months = endDate.getMonth() - startDate.getMonth();
    if (months < 0) {
      months += 12;
    }
    if (endDate.getDate() < startDate.getDate()) {
      months--;
      if (months < 0) months += 12;
    }
    return numNode(months);
  }

  if (unit === 'YD') {
    const startAdjusted = new Date(endDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    if (startAdjusted > endDate) {
      startAdjusted.setFullYear(startAdjusted.getFullYear() - 1);
    }
    const dayMs = 24 * 60 * 60 * 1000;
    const startUtc = Date.UTC(startAdjusted.getFullYear(), startAdjusted.getMonth(), startAdjusted.getDate());
    const endUtc = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    return numNode((endUtc - startUtc) / dayMs);
  }

  return ErrNode.VALUE;
}

/**
 * WEEKNUM(date, [type]) — returns the week number of the year.
 * type=1 (default): week starts Sunday. type=2: week starts Monday.
 */
function weeknumFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  let type = 1;
  if (exprs.length === 2) {
    const typeNode = NumberArgs.map(visit(exprs[1]), grid);
    if (typeNode.t === 'err') {
      return typeNode;
    }
    type = Math.trunc(typeNode.v);
  }

  const startDay = type === 2 ? 1 : 0;
  const jan1Day = new Date(date.getFullYear(), 0, 1).getDay();
  const dayOffset = (jan1Day - startDay + 7) % 7;
  // Whole calendar days since 1 January, counted in UTC so that a daylight
  // saving change between the two dates cannot shorten the span by an hour.
  const dayOfYear =
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
      Date.UTC(date.getFullYear(), 0, 1)) /
    86400000;
  const weekNum = Math.floor((dayOfYear + dayOffset) / 7) + 1;

  return numNode(weekNum);
}

/**
 * ISOWEEKNUM(date) — returns the ISO week number of the year.
 */
function isoweeknumFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const date = parseDate(visit(exprs[0]), grid);
  if (!(date instanceof Date)) {
    return date;
  }

  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  return numNode(weekNo);
}

/**
 * WORKDAY(start_date, days, [holidays]) — returns a date that is a specified number of working days away.
 */
function workdayFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if (!(startDate instanceof Date)) {
    return startDate;
  }

  const daysNode = NumberArgs.map(visit(exprs[1]), grid);
  if (daysNode.t === 'err') {
    return daysNode;
  }

  const holidayDates = new Set<string>();
  if (exprs.length === 3) {
    const holNode = visit(exprs[2]);
    if (holNode.t === 'err') {
      return holNode;
    }
    if (holNode.t === 'ref' && grid) {
      for (const ref of toSrefs([holNode.v])) {
        const cellVal = grid.get(ref)?.v || '';
        if (cellVal) {
          holidayDates.add(cellVal);
        }
      }
    } else if (holNode.t === 'str') {
      holidayDates.add(holNode.v);
    }
  }

  let remaining = Math.trunc(daysNode.v);
  const direction = remaining > 0 ? 1 : -1;
  remaining = Math.abs(remaining);
  const current = new Date(startDate);

  while (remaining > 0) {
    current.setDate(current.getDate() + direction);
    const day = current.getDay();
    if (day !== 0 && day !== 6 && !holidayDates.has(formatDate(current))) {
      remaining--;
    }
  }

  return { t: 'str', v: formatDate(current) };
}

/**
 * WORKDAY.INTL(start_date, days, [weekend], [holidays]) — workday with custom weekends.
 * weekend: 1=Sat/Sun (default), 2=Sun/Mon, 7=Fri/Sat, 11-17=single day.
 */
function workdayintlFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if ('t' in startDate) return startDate;
  const daysNode = NumberArgs.map(visit(exprs[1]), grid);
  if (daysNode.t === 'err') return daysNode;
  const numDays = Math.trunc(daysNode.v);

  let weekendDays = new Set([0, 6]); // Sunday=0, Saturday=6
  if (exprs.length >= 3) {
    const wNode = NumberArgs.map(visit(exprs[2]), grid);
    if (wNode.t !== 'err') {
      const w = Math.trunc(wNode.v);
      weekendDays = getWeekendDays(w);
    }
  }

  // Collect holidays
  const holidays = new Set<string>();
  if (exprs.length >= 4) {
    const hNode = visit(exprs[3]);
    if (hNode.t === 'ref' && grid) {
      for (const sref of toSrefs([hNode.v])) {
        const cell = grid.get(sref);
        if (cell?.v) {
          const hd = parseDateString(String(cell.v));
          if (!isNaN(hd.getTime())) {
            holidays.add(formatDate(hd));
          }
        }
      }
    }
  }

  const result = new Date(startDate);
  const direction = numDays >= 0 ? 1 : -1;
  let remaining = Math.abs(numDays);
  while (remaining > 0) {
    result.setDate(result.getDate() + direction);
    if (!weekendDays.has(result.getDay()) && !holidays.has(formatDate(result))) {
      remaining--;
    }
  }

  return { t: 'str', v: formatDate(result) };
}

/**
 * YEARFRAC(start_date, end_date, [basis]) — returns the fraction of the year between two dates.
 * basis: 0=US 30/360, 1=actual/actual, 2=actual/360, 3=actual/365, 4=European 30/360.
 */
function yearfracFunc(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if (!(startDate instanceof Date)) {
    return startDate;
  }

  const endDate = parseDate(visit(exprs[1]), grid);
  if (!(endDate instanceof Date)) {
    return endDate;
  }

  let basis = 0;
  if (exprs.length === 3) {
    const basisNode = NumberArgs.map(visit(exprs[2]), grid);
    if (basisNode.t === 'err') {
      return basisNode;
    }
    basis = Math.trunc(basisNode.v);
  }

  if (basis < 0 || basis > 4) {
    return ErrNode.VALUE;
  }

  const s = startDate < endDate ? startDate : endDate;
  const e = startDate < endDate ? endDate : startDate;
  // 30/360 reads a date-only value as the calendar day written, and a
  // timestamp by its UTC day as before, so one with an explicit offset gives
  // the same result in every time zone.
  const dayOf = (date: Date) =>
    isDateOnlyValue(date)
      ? { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
      : { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  const sd = dayOf(s);
  const ed = dayOf(e);
  const actualDays = Math.round(
    (e.getTime() - s.getTime()) / 86400000,
  );

  switch (basis) {
    case 0: {
      // US (NASD) 30/360
      let d1 = sd.d;
      let d2 = ed.d;
      const m1 = sd.m;
      const m2 = ed.m;
      const y1 = sd.y;
      const y2 = ed.y;
      const isLastDayOfFeb = (d: { y: number; m: number; d: number }): boolean =>
        d.m === 2 && d.d === new Date(Date.UTC(d.y, 2, 0)).getUTCDate();
      if (isLastDayOfFeb(sd)) {
        d1 = 30;
        if (isLastDayOfFeb(ed)) d2 = 30;
      }
      if (d1 === 31) d1 = 30;
      if (d2 === 31 && d1 === 30) d2 = 30;
      const days30 = (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
      return numNode(days30 / 360);
    }
    case 4: {
      // European 30/360
      const d1 = Math.min(sd.d, 30);
      const d2 = Math.min(ed.d, 30);
      const days30 = (ed.y - sd.y) * 360 + (ed.m - sd.m) * 30 + (d2 - d1);
      return numNode(days30 / 360);
    }
    case 1: {
      const sy = s.getFullYear();
      const ey = e.getFullYear();
      if (sy === ey) {
        const yearDays = (new Date(sy + 1, 0, 1).getTime() - new Date(sy, 0, 1).getTime()) / 86400000;
        return numNode(actualDays / yearDays);
      }
      const years = ey - sy + 1;
      const totalDays = (new Date(ey + 1, 0, 1).getTime() - new Date(sy, 0, 1).getTime()) / 86400000;
      const avgYear = totalDays / years;
      return numNode(actualDays / avgYear);
    }
    case 2:
      return numNode(actualDays / 360);
    case 3:
      return numNode(actualDays / 365);
    default:
      return ErrNode.VALUE;
  }
}

/**
 * DAYS360(start_date, end_date, [method]) — days between two dates using 360-day year.
 * method: FALSE (default) = US/NASD, TRUE = European.
 */
function days360Func(
  ctx: FunctionContext,
  visit: (tree: ParseTree) => EvalNode,
  grid?: Grid,
): EvalNode {
  const exprs = ctx.args()?.expr() ?? [];

  const startDate = parseDate(visit(exprs[0]), grid);
  if ('t' in startDate) return startDate;
  const endDate = parseDate(visit(exprs[1]), grid);
  if ('t' in endDate) return endDate;

  let european = false;
  if (exprs.length >= 3) {
    const m = visit(exprs[2]);
    european = m.t === 'bool' ? m.v === true : m.t === 'num' ? m.v !== 0 : false;
  }

  let sd = startDate.getDate();
  const sm = startDate.getMonth() + 1;
  const sy = startDate.getFullYear();
  let ed = endDate.getDate();
  const em = endDate.getMonth() + 1;
  const ey = endDate.getFullYear();

  if (european) {
    if (sd > 30) sd = 30;
    if (ed > 30) ed = 30;
  } else {
    // US/NASD method
    if (sd === 31) sd = 30;
    if (ed === 31 && sd >= 30) ed = 30;
  }

  return numNode((ey - sy) * 360 + (em - sm) * 30 + (ed - sd));
}

/**
 * `todayFunc` is the implementation of the TODAY function.
 * TODAY() — returns the current date as YYYY-MM-DD.
 */
export function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * `parseDate` parses a date from an EvalNode, returning a Date or an error.
 */
export function parseDate(
  node: EvalNode,
  grid?: Grid,
): Date | ErrNode {
  const str = toStr(node, grid);
  if (str.t === 'err') return str;

  const date = parseDateString(str.v);
  if (isNaN(date.getTime())) {
    return ErrNode.VALUE;
  }
  return date;
}

/** Dates `parseDateString` read from a date-only (`YYYY-MM-DD`) string. */
const dateOnlyValues = new WeakSet<Date>();

/**
 * `isDateOnlyValue` reports whether `date` was parsed from a date-only string,
 * as opposed to a timestamp.
 */
export function isDateOnlyValue(date: Date): boolean {
  return dateOnlyValues.has(date);
}

/**
 * `calendarDay` returns the local calendar date of `date` as a whole number of
 * days since 1970-01-01, so that two dates compare by day whatever their time
 * of day or a daylight saving change between them.
 */
function calendarDay(date: Date): number {
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return utc.getTime() / 86400000;
}

/**
 * `parseDateString` parses a date string into a Date at local midnight for
 * date-only values.
 *
 * `new Date('2024-03-15')` is defined to parse a date-only ISO string as UTC
 * midnight, while every date function here reads the result with local getters
 * (`getDate`, `getDay`, ...) and formats with `formatDate`. West of UTC that
 * moved every such date back by one day. Other strings keep the built-in parser.
 */
function parseDateString(text: string): Date {
  const isoDate = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(text);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return new Date(NaN);
    }
    // Year, month and day are set together: the Date constructor maps years
    // 0-99 to 19xx, which would roll a leap day such as 0000-02-29 over first.
    const date = new Date(2000, 0, 1);
    date.setFullYear(year, month - 1, day);
    dateOnlyValues.add(date);
    return date;
  }
  return new Date(text);
}

/**
 * `parseDateTime` parses either a full datetime/date value or a time literal.
 */
function parseDateTime(
  node: EvalNode,
  grid?: Grid,
): Date | ErrNode {
  const str = toStr(node, grid);
  if (str.t === 'err') {
    return str;
  }

  const timeOnly = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(str.v.trim());
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = Number(timeOnly[3] || '0');
    if (
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      second < 0 ||
      second > 59
    ) {
      return ErrNode.VALUE;
    }

    return new Date(1970, 0, 1, hour, minute, second);
  }

  const date = parseDateString(str.v);
  if (isNaN(date.getTime())) {
    return ErrNode.VALUE;
  }

  return date;
}

function getWeekendDays(weekendNum: number): Set<number> {
  switch (weekendNum) {
    case 1: return new Set([0, 6]); // Sat, Sun
    case 2: return new Set([0, 1]); // Sun, Mon
    case 3: return new Set([1, 2]); // Mon, Tue
    case 4: return new Set([2, 3]); // Tue, Wed
    case 5: return new Set([3, 4]); // Wed, Thu
    case 6: return new Set([4, 5]); // Thu, Fri
    case 7: return new Set([5, 6]); // Fri, Sat
    case 11: return new Set([0]);   // Sun only
    case 12: return new Set([1]);   // Mon only
    case 13: return new Set([2]);   // Tue only
    case 14: return new Set([3]);   // Wed only
    case 15: return new Set([4]);   // Thu only
    case 16: return new Set([5]);   // Fri only
    case 17: return new Set([6]);   // Sat only
    default: return new Set([0, 6]);
  }
}

export const dateEntries: [string, (...args: any[]) => EvalNode][] = [
  ['TODAY', todayFunc],
  ['NOW', nowFunc],
  ['DATE', dateFunc],
  ['TIME', timeFunc],
  ['DAYS', daysFunc],
  ['YEAR', yearFunc],
  ['MONTH', monthFunc],
  ['DAY', dayFunc],
  ['HOUR', hourFunc],
  ['MINUTE', minuteFunc],
  ['SECOND', secondFunc],
  ['WEEKDAY', weekdayFunc],
  ['EDATE', edateFunc],
  ['EOMONTH', eomonthFunc],
  ['NETWORKDAYS', networkdaysFunc],
  ['NETWORKDAYS.INTL', networkdaysintlFunc],
  ['DATEVALUE', datevalueFunc],
  ['TIMEVALUE', timevalueFunc],
  ['DATEDIF', datedifFunc],
  ['WEEKNUM', weeknumFunc],
  ['ISOWEEKNUM', isoweeknumFunc],
  ['WORKDAY', workdayFunc],
  ['WORKDAY.INTL', workdayintlFunc],
  ['YEARFRAC', yearfracFunc],
  ['DAYS360', days360Func],
];
// Modified by Nautilo: imported engine lint and type safety.
