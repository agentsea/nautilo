import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluate } from '../../src/formula/formula';
import { Cell } from '../../src/model/core/types';

// Date-only strings such as "2024-03-15" are calendar dates. These checks run
// the date functions in time zones on both sides of UTC, so the result does not
// depend on the zone of the machine running the suite.
const zones = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Santiago',
  'Asia/Kolkata',
  'Pacific/Auckland',
];

for (const zone of zones) {
  describe(`date functions in ${zone}`, () => {
    // Node re-reads TZ when it changes, so Date's local getters follow it.
    beforeAll(() => {
      vi.stubEnv('TZ', zone);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('reads a date-only string as that calendar day', () => {
      expect(evaluate('=DAY("2024-03-15")')).toBe('15');
      expect(evaluate('=MONTH("2024-03-01")')).toBe('3');
      expect(evaluate('=YEAR("2024-01-01")')).toBe('2024');
      expect(evaluate('=WEEKDAY("2024-03-17")')).toBe('1');
      expect(evaluate('=DATEVALUE("2024-03-15")')).toBe('2024-03-15');
      expect(evaluate('=DAY(DATE(2024,3,15))')).toBe('15');
    });

    it('keeps date arithmetic on calendar days', () => {
      expect(evaluate('=EDATE("2024-03-15",-1)')).toBe('2024-02-15');
      expect(evaluate('=EOMONTH("2024-01-15",1)')).toBe('2024-02-29');
      expect(evaluate('=NETWORKDAYS("2024-03-11","2024-03-15")')).toBe('5');
      expect(evaluate('=WORKDAY("2024-01-05",1)')).toBe('2024-01-08');
      expect(evaluate('=YEARFRAC("2024-01-01","2024-07-01",0)')).toBe('0.5');
    });

    it('counts weeks across a daylight saving change', () => {
      // 17 March 2024 is a Sunday, one week after the US clocks went forward.
      expect(evaluate('=WEEKNUM("2024-03-17")')).toBe('12');
      expect(evaluate('=WEEKNUM("2024-03-16")')).toBe('11');
    });

    it('counts business days across a midnight daylight saving change', () => {
      // Santiago moved its clocks forward at midnight on 8 September 2019, so
      // that day has no 00:00.
      expect(evaluate('=NETWORKDAYS("2019-09-06","2019-09-09")')).toBe('2');
      expect(evaluate('=NETWORKDAYS("2019-09-09","2019-09-06")')).toBe('-2');
      expect(evaluate('=NETWORKDAYS.INTL("2019-09-06","2019-09-09")')).toBe('2');
      expect(evaluate('=NETWORKDAYS.INTL("2019-09-09","2019-09-06")')).toBe('-2');
    });

    it('counts whole days between date-only values in financial day counts', () => {
      // 100 a year of interest, basis 3 (actual/365).
      expect(Number(evaluate('=ACCRINTM("2024-03-09","2024-03-11",0.1,1000,3)'))).toBeCloseTo(200 / 365, 10);
      expect(Number(evaluate('=ACCRINTM("2019-09-06","2019-09-09",0.1,1000,3)'))).toBeCloseTo(300 / 365, 10);
    });

    it('keeps the time of day of timestamps in financial day counts', () => {
      expect(Number(evaluate('=ACCRINTM("2024-01-01T00:00:00","2024-01-01T11:59:59",0.1,1000,3)'))).toBeCloseTo(
        (100 * 43199) / 86400 / 365,
        10,
      );
      expect(Number(evaluate('=ACCRINTM("2024-01-01T00:00:00","2024-01-01T12:00:00",0.1,1000,3)'))).toBeCloseTo(
        50 / 365,
        10,
      );
    });

    it('reads YEARFRAC 30/360 dates from date-only values and timestamps', () => {
      // A date-only value is the calendar day written.
      expect(Number(evaluate('=YEARFRAC("2024-02-29","2024-03-31",0)'))).toBeCloseTo(30 / 360, 10);
      expect(Number(evaluate('=YEARFRAC("2024-02-29","2024-03-31",4)'))).toBeCloseTo(31 / 360, 10);
      // A timestamp with an explicit offset is the same instant in every zone
      // and keeps its UTC day: 1 March 07:30 to 1 April 07:30.
      expect(Number(evaluate('=YEARFRAC("2024-02-29T23:30:00-08:00","2024-03-31T23:30:00-08:00",0)'))).toBeCloseTo(
        30 / 360,
        10,
      );
      expect(Number(evaluate('=YEARFRAC("2024-02-29T23:30:00-08:00","2024-03-31T23:30:00-08:00",4)'))).toBeCloseTo(
        30 / 360,
        10,
      );
    });

    it('keeps a leap day in years the Date constructor maps to 19xx', () => {
      expect(evaluate('=DAY("0000-02-29")')).toBe('29');
      expect(evaluate('=MONTH("0000-02-29")')).toBe('2');
      expect(evaluate('=DAY("0099-02-29")')).toBe('1');
    });

    it('matches holidays on the same calendar day', () => {
      const grid = new Map<string, Cell>();
      grid.set('A1', { v: '2024-03-13' } as Cell);
      expect(evaluate('=NETWORKDAYS.INTL("2024-03-11","2024-03-15",1,A1)', grid)).toBe('4');
      expect(evaluate('=WORKDAY.INTL("2024-03-12",1,1,A1)', grid)).toBe('2024-03-14');
    });
  });
}
