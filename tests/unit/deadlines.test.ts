import { describe, expect, it } from "vitest";
import defaultCalendar from "../../src/config/tax-calendar.json";
import { parseTaxCalendar } from "../../src/config/taxConfig";
import {
  daysBetween,
  dueDateFor,
  lastTwoDigits,
  severityFor,
  todayIn,
} from "../../src/modules/alerts/deadlines.service";

const thresholds = { critical: 7, high: 15, medium: 30 };

describe("lastTwoDigits", () => {
  it.each([
    ["1020304050", "50"],
    ["900.123.456-7", "56"], // NIT: se ignora el dígito de verificación
    ["900123456-7", "56"],
    ["CC 1.020.304.007", "07"],
    ["5", "05"],
    ["ABC", null],
  ])("%s → %s", (input, expected) => {
    expect(lastTwoDigits(input)).toBe(expected);
  });
});

describe("fechas", () => {
  it("todayIn usa la zona horaria del calendario (Bogotá = UTC-5)", () => {
    // 2026-08-01 03:00 UTC es todavía 31 de julio en Bogotá.
    expect(todayIn("America/Bogota", new Date("2026-08-01T03:00:00Z"))).toBe("2026-07-31");
    expect(todayIn("America/Bogota", new Date("2026-08-01T06:00:00Z"))).toBe("2026-08-01");
  });

  it("daysBetween cuenta días de calendario", () => {
    expect(daysBetween("2026-08-01", "2026-08-12")).toBe(11);
    expect(daysBetween("2026-08-12", "2026-08-12")).toBe(0);
    expect(daysBetween("2026-08-13", "2026-08-12")).toBe(-1);
  });
});

describe("severityFor (severidad creciente al acercarse la fecha)", () => {
  it.each([
    [60, "low"],
    [31, "low"],
    [30, "medium"],
    [16, "medium"],
    [15, "high"],
    [8, "high"],
    [7, "critical"],
    [0, "critical"],
    [-3, "critical"],
  ])("%i días → %s", (days, expected) => {
    expect(severityFor(days, thresholds)).toBe(expected);
  });
});

describe("calendario tributario", () => {
  it("el archivo incluido es válido y está marcado como EJEMPLO", () => {
    const calendar = parseTaxCalendar(defaultCalendar);
    expect(calendar.esEjemplo).toBe(true);
    expect(Object.keys(calendar.declaracionRentaPersonasNaturales).length).toBeGreaterThan(0);
  });

  it("dueDateFor encuentra el rango de los dos últimos dígitos", () => {
    const calendar = parseTaxCalendar(defaultCalendar);
    const ranges = calendar.declaracionRentaPersonasNaturales["2025"]!;
    const expected = ranges.find((r) => 7 >= Number(r.desde) && 7 <= Number(r.hasta))!.vence;
    expect(dueDateFor(calendar, "2025", "07")).toBe(expected);
    expect(dueDateFor(calendar, "1999", "07")).toBeNull();
  });

  it("rechaza un calendario cuyos rangos no cubren 00-99 o se solapan", () => {
    const base = {
      esEjemplo: true,
      zonaHoraria: "America/Bogota",
      diasDeAnticipacion: 60,
      umbralesSeveridad: thresholds,
    };
    expect(() =>
      parseTaxCalendar({
        ...base,
        declaracionRentaPersonasNaturales: { "2025": [{ desde: "00", hasta: "49", vence: "2026-08-01" }] },
      })
    ).toThrow(/faltan: 50,51/);
    expect(() =>
      parseTaxCalendar({
        ...base,
        declaracionRentaPersonasNaturales: {
          "2025": [
            { desde: "00", hasta: "60", vence: "2026-08-01" },
            { desde: "50", hasta: "99", vence: "2026-08-02" },
          ],
        },
      })
    ).toThrow(/repetidos: 50/);
  });
});
