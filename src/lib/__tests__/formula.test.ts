import { describe, expect, it } from "vitest";
import { compileFormula, formatFormulaValue } from "../formula";
import type { Field, RecordRow } from "../types";

const fields: Field[] = [
  { id: "f1", name: "Preço", type: "number", options: {}, pos: 0 },
  { id: "f2", name: "Qtd", type: "number", options: {}, pos: 1 },
  { id: "f3", name: "Nome", type: "text", options: {}, pos: 2 },
  { id: "f4", name: "Início", type: "date", options: {}, pos: 3 },
  { id: "f5", name: "Fim", type: "date", options: {}, pos: 4 },
];

const row = (cells: Record<string, unknown>): RecordRow => ({ id: 1, cells: cells as RecordRow["cells"] });

describe("fórmulas", () => {
  it("aritmética com campos", () => {
    const f = compileFormula("{Preço} * {Qtd}", fields);
    expect(f.eval(row({ f1: 12.5, f2: 4 }), fields)).toBe(50);
  });

  it("concatenação e strings", () => {
    const f = compileFormula('{Nome} & " (" & {Qtd} & ")"', fields);
    expect(f.eval(row({ f3: "Caneta", f2: 3 }), fields)).toBe("Caneta (3)");
  });

  it("IF e comparação", () => {
    const f = compileFormula('IF({Preço} > 100, "caro", "barato")', fields);
    expect(f.eval(row({ f1: 150 }), fields)).toBe("caro");
    expect(f.eval(row({ f1: 50 }), fields)).toBe("barato");
  });

  it("funções de texto e número", () => {
    expect(compileFormula('UPPER("abc")', fields).eval(row({}), fields)).toBe("ABC");
    expect(compileFormula("ROUND(3.14159, 2)", fields).eval(row({}), fields)).toBe(3.14);
    expect(compileFormula("MAX(1, 5, 3)", fields).eval(row({}), fields)).toBe(5);
    expect(compileFormula('LEN(TRIM("  ab  "))', fields).eval(row({}), fields)).toBe(2);
  });

  it("DAYS entre datas", () => {
    const f = compileFormula("DAYS({Fim}, {Início})", fields);
    expect(f.eval(row({ f4: "2026-07-01", f5: "2026-07-11" }), fields)).toBe(10);
  });

  it("erros viram #ERRO sem lançar", () => {
    expect(compileFormula("{Inexistente} + 1", fields).eval(row({}), fields)).toBe("#ERRO");
    expect(compileFormula("1 / 0", fields).eval(row({}), fields)).toBe("#ERRO");
    const broken = compileFormula("1 + + (", fields);
    expect(broken.eval(row({}), fields)).toBe("#ERRO");
    expect(broken.error).toBeTruthy();
  });

  it("precedência e parênteses", () => {
    expect(compileFormula("2 + 3 * 4", fields).eval(row({}), fields)).toBe(14);
    expect(compileFormula("(2 + 3) * 4", fields).eval(row({}), fields)).toBe(20);
    expect(compileFormula("-{Preço} + 10", fields).eval(row({ f1: 3 }), fields)).toBe(7);
  });

  it("formatação de exibição", () => {
    expect(formatFormulaValue(true)).toBe("✓");
    expect(formatFormulaValue(null)).toBe("");
    expect(formatFormulaValue(1.23456789)).toBe("1.2346");
  });
});
