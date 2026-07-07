import { describe, expect, it } from "vitest";
import { missingChoiceNames, parseDateText, parseNumberText, parseTsv, textToCell, toTsv } from "../clipboard";
import type { Field } from "../types";

describe("tsv", () => {
  it("roda ida e volta com tabs e quebras", () => {
    const m = [
      ["a", "b\tc", 'd"e'],
      ["linha\nquebrada", "", "x"],
    ];
    expect(parseTsv(toTsv(m))).toEqual(m);
  });

  it("parse simples do excel", () => {
    expect(parseTsv("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseNumberText", () => {
  it("aceita pt-BR, moeda e percentual", () => {
    expect(parseNumberText("1.234,56")).toBe(1234.56);
    expect(parseNumberText("R$ 10,50")).toBe(10.5);
    expect(parseNumberText("42%")).toBe(42);
    expect(parseNumberText("3.5")).toBe(3.5);
    expect(parseNumberText("abc")).toBeNull();
  });
});

describe("parseDateText", () => {
  it("converte dd/mm/aaaa e aceita ISO", () => {
    expect(parseDateText("07/07/2026")).toBe("2026-07-07");
    expect(parseDateText("7/7/2026 09:30")).toBe("2026-07-07T09:30");
    expect(parseDateText("2026-07-07")).toBe("2026-07-07");
    expect(parseDateText("nada")).toBeNull();
  });
});

describe("textToCell", () => {
  const f = (type: Field["type"], options: Field["options"] = {}): Field => ({
    id: "f1",
    name: "F",
    type,
    options,
    pos: 0,
  });

  it("converte por tipo", () => {
    expect(textToCell(f("number"), "12,5")).toBe(12.5);
    expect(textToCell(f("checkbox"), "sim")).toBe(true);
    expect(textToCell(f("checkbox"), "")).toBe(false);
    expect(textToCell(f("date"), "01/02/2026")).toBe("2026-02-01");
    expect(textToCell(f("text"), "oi")).toBe("oi");
    expect(textToCell(f("rating"), "★★★")).toBe(3);
    expect(textToCell(f("rating"), "4")).toBe(4);
  });

  it("select casa por nome (case-insensitive)", () => {
    const choices = [{ id: "c1", name: "Alta", color: "" }];
    expect(textToCell(f("select", { choices }), "alta")).toBe("c1");
    expect(textToCell(f("multi_select", { choices }), "Alta, Nada")).toEqual(["c1"]);
  });

  it("computados/relação/anexo não são coláveis", () => {
    expect(textToCell(f("formula"), "x")).toBeUndefined();
    expect(textToCell(f("lookup"), "x")).toBeUndefined();
    expect(textToCell(f("link"), "x")).toBeUndefined();
    expect(textToCell(f("attachment"), "x")).toBeUndefined();
  });

  it("lista opções que faltam", () => {
    const field = f("select", { choices: [{ id: "c1", name: "Alta", color: "" }] });
    expect(missingChoiceNames(field, ["Alta", "Média", "média", "Baixa", ""])).toEqual(["Média", "Baixa"]);
  });
});
