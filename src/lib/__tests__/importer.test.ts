import { describe, expect, it } from "vitest";
import { convertRaw, inferType } from "../importer";

describe("inferência de tipo do import", () => {
  it("número", () => {
    expect(inferType(["1", "2,5", "300", ""])).toBe("number");
  });
  it("data ISO e BR", () => {
    expect(inferType(["2026-01-02", "2026-05-06"])).toBe("date");
    expect(inferType(["02/01/2026", "06/05/2026"])).toBe("date");
  });
  it("checkbox", () => {
    expect(inferType(["sim", "não", "", "sim"])).toBe("checkbox");
  });
  it("select quando repete pouco valor", () => {
    const vals = ["Alta", "Baixa", "Alta", "Média", "Baixa", "Alta", "Média", "Baixa", "Alta", "Baixa"];
    expect(inferType(vals)).toBe("select");
  });
  it("texto no caso geral", () => {
    expect(inferType(["Ana", "Bruno", "Carla"])).toBe("text");
  });
  it("texto longo", () => {
    expect(inferType(["linha1\nlinha2", "x"])).toBe("long_text");
  });
});

describe("conversão de valores", () => {
  it("data BR -> ISO", () => {
    expect(convertRaw("date", "25/12/2026")).toBe("2026-12-25");
  });
  it("número pt-BR", () => {
    expect(convertRaw("number", "12,5")).toBe(12.5);
  });
  it("checkbox", () => {
    expect(convertRaw("checkbox", "Sim")).toBe(true);
    expect(convertRaw("checkbox", "não")).toBe(false);
  });
  it("vazio vira null", () => {
    expect(convertRaw("text", "  ")).toBe(null);
  });
});
