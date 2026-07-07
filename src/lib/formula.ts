// Motor de fórmula simples do LocalData, avaliado no frontend por registro.
//
// Sintaxe: {Nome do Campo} referencia o valor do campo no registro atual.
// Operadores: + - * / % & (concatenação) = != > >= < <= e parênteses.
// Funções: IF, AND, OR, NOT, CONCAT, UPPER, LOWER, TRIM, LEN, ROUND, ABS,
// MIN, MAX, TODAY, NOW, YEAR, MONTH, DAY, DAYS.
//
// Erros de sintaxe/avaliação viram a string "#ERRO" (célula continua visível).

import type { Field, RecordRow } from "./types";

export type FormulaValue = string | number | boolean | null;

// --- tokenizer ---

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "field"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "{") {
      const j = src.indexOf("}", i);
      if (j === -1) throw new Error("chave sem fechar");
      toks.push({ t: "field", v: src.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new Error("string sem fechar");
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ t: "comma" });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=" || two === "<>") {
      toks.push({ t: "op", v: two === "<>" ? "!=" : two });
      i += 2;
      continue;
    }
    if ("+-*/%&=<>".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`caractere inesperado: '${c}'`);
  }
  return toks;
}

// --- parser (precedência clássica) ---

type Node =
  | { k: "lit"; v: FormulaValue }
  | { k: "field"; name: string }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "neg"; e: Node }
  | { k: "call"; fn: string; args: Node[] };

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  next(): Tok | undefined {
    return this.toks[this.pos++];
  }
  expr(): Node {
    return this.comparison();
  }
  comparison(): Node {
    let l = this.concat();
    for (;;) {
      const p = this.peek();
      if (p?.t === "op" && ["=", "!=", ">", ">=", "<", "<="].includes(p.v)) {
        this.next();
        l = { k: "bin", op: p.v, l, r: this.concat() };
      } else return l;
    }
  }
  concat(): Node {
    let l = this.additive();
    for (;;) {
      const p = this.peek();
      if (p?.t === "op" && p.v === "&") {
        this.next();
        l = { k: "bin", op: "&", l, r: this.additive() };
      } else return l;
    }
  }
  additive(): Node {
    let l = this.multiplicative();
    for (;;) {
      const p = this.peek();
      if (p?.t === "op" && (p.v === "+" || p.v === "-")) {
        this.next();
        l = { k: "bin", op: p.v, l, r: this.multiplicative() };
      } else return l;
    }
  }
  multiplicative(): Node {
    let l = this.unary();
    for (;;) {
      const p = this.peek();
      if (p?.t === "op" && (p.v === "*" || p.v === "/" || p.v === "%")) {
        this.next();
        l = { k: "bin", op: p.v, l, r: this.unary() };
      } else return l;
    }
  }
  unary(): Node {
    const p = this.peek();
    if (p?.t === "op" && p.v === "-") {
      this.next();
      return { k: "neg", e: this.unary() };
    }
    return this.primary();
  }
  primary(): Node {
    const p = this.next();
    if (!p) throw new Error("fim inesperado");
    if (p.t === "num") return { k: "lit", v: p.v };
    if (p.t === "str") return { k: "lit", v: p.v };
    if (p.t === "field") return { k: "field", name: p.v };
    if (p.t === "ident") {
      if (p.v === "TRUE") return { k: "lit", v: true };
      if (p.v === "FALSE") return { k: "lit", v: false };
      const nx = this.peek();
      if (nx?.t === "lparen") {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.t !== "rparen") {
          for (;;) {
            args.push(this.expr());
            const sep = this.next();
            if (sep?.t === "rparen") break;
            if (sep?.t !== "comma") throw new Error("esperado ',' ou ')'");
          }
        } else {
          this.next();
        }
        return { k: "call", fn: p.v, args };
      }
      throw new Error(`identificador desconhecido: ${p.v}`);
    }
    if (p.t === "lparen") {
      const e = this.expr();
      const close = this.next();
      if (close?.t !== "rparen") throw new Error("esperado ')'");
      return e;
    }
    throw new Error("expressão inválida");
  }
}

// --- avaliação ---

function toNum(v: FormulaValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(",", "."));
    if (!isNaN(n)) return n;
  }
  return 0;
}

function toStr(v: FormulaValue): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function truthy(v: FormulaValue): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== "";
}

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function evalNode(n: Node, get: (name: string) => FormulaValue): FormulaValue {
  switch (n.k) {
    case "lit":
      return n.v;
    case "field":
      return get(n.name);
    case "neg":
      return -toNum(evalNode(n.e, get));
    case "bin": {
      const l = evalNode(n.l, get);
      const r = evalNode(n.r, get);
      switch (n.op) {
        case "+":
          return toNum(l) + toNum(r);
        case "-":
          return toNum(l) - toNum(r);
        case "*":
          return toNum(l) * toNum(r);
        case "/": {
          const d = toNum(r);
          if (d === 0) throw new Error("divisão por zero");
          return toNum(l) / d;
        }
        case "%": {
          const d = toNum(r);
          if (d === 0) throw new Error("divisão por zero");
          return toNum(l) % d;
        }
        case "&":
          return toStr(l) + toStr(r);
        case "=":
          return toStr(l) === toStr(r) || (typeof l === "number" && typeof r === "number" && l === r);
        case "!=":
          return !(toStr(l) === toStr(r));
        case ">":
          return cmp(l, r) > 0;
        case ">=":
          return cmp(l, r) >= 0;
        case "<":
          return cmp(l, r) < 0;
        case "<=":
          return cmp(l, r) <= 0;
        default:
          throw new Error(`operador: ${n.op}`);
      }
    }
    case "call": {
      const a = n.args;
      const ev = (i: number) => evalNode(a[i], get);
      switch (n.fn) {
        case "IF":
          if (a.length < 2) throw new Error("IF(cond, sim, [não])");
          return truthy(ev(0)) ? ev(1) : a.length > 2 ? ev(2) : null;
        case "AND":
          return a.every((_, i) => truthy(ev(i)));
        case "OR":
          return a.some((_, i) => truthy(ev(i)));
        case "NOT":
          return !truthy(ev(0));
        case "CONCAT":
          return a.map((_, i) => toStr(ev(i))).join("");
        case "UPPER":
          return toStr(ev(0)).toUpperCase();
        case "LOWER":
          return toStr(ev(0)).toLowerCase();
        case "TRIM":
          return toStr(ev(0)).trim();
        case "LEN":
          return toStr(ev(0)).length;
        case "ROUND": {
          const digits = a.length > 1 ? toNum(ev(1)) : 0;
          const f = Math.pow(10, digits);
          return Math.round(toNum(ev(0)) * f) / f;
        }
        case "ABS":
          return Math.abs(toNum(ev(0)));
        case "MIN":
          return Math.min(...a.map((_, i) => toNum(ev(i))));
        case "MAX":
          return Math.max(...a.map((_, i) => toNum(ev(i))));
        case "TODAY":
          return isoDate(new Date());
        case "NOW": {
          const d = new Date();
          const p = (x: number) => String(x).padStart(2, "0");
          return `${isoDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        case "YEAR":
          return datePart(toStr(ev(0)), 0);
        case "MONTH":
          return datePart(toStr(ev(0)), 1);
        case "DAY":
          return datePart(toStr(ev(0)), 2);
        case "DAYS": {
          // DAYS(fim, início) — diferença em dias entre duas datas ISO
          const end = Date.parse(toStr(ev(0)).slice(0, 10));
          const start = Date.parse(toStr(ev(1)).slice(0, 10));
          if (isNaN(end) || isNaN(start)) throw new Error("data inválida");
          return Math.round((end - start) / 86_400_000);
        }
        default:
          throw new Error(`função desconhecida: ${n.fn}`);
      }
    }
  }
}

function cmp(l: FormulaValue, r: FormulaValue): number {
  if (typeof l === "string" && typeof r === "string") return l < r ? -1 : l > r ? 1 : 0;
  const a = toNum(l);
  const b = toNum(r);
  return a < b ? -1 : a > b ? 1 : 0;
}

function datePart(s: string, part: 0 | 1 | 2): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error("data inválida");
  return parseInt(m[1 + part], 10);
}

// --- API pública ---

export interface CompiledFormula {
  eval(row: RecordRow, fields: Field[]): FormulaValue;
  error?: string;
}

/** Compila uma fórmula uma vez; avalie por registro. Nunca lança: erros viram "#ERRO". */
export function compileFormula(expr: string, fields: Field[]): CompiledFormula {
  let ast: Node;
  try {
    const toks = tokenize(expr);
    if (!toks.length) return { eval: () => null };
    const p = new Parser(toks);
    ast = p.expr();
    if (p.pos < p.toks.length) throw new Error("sobrou expressão");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { eval: () => "#ERRO", error: msg };
  }
  // resolve nomes de campo -> id na compilação (renomear campo exige recompilar)
  const byName = new Map<string, Field>();
  for (const f of fields) byName.set(f.name.trim().toLowerCase(), f);
  return {
    eval(row: RecordRow): FormulaValue {
      try {
        return evalNode(ast, (name) => {
          const f = byName.get(name.trim().toLowerCase());
          if (!f) throw new Error(`campo desconhecido: {${name}}`);
          const v = row.cells[f.id];
          if (v == null) return null;
          if (Array.isArray(v)) return v.map(String).join(", ");
          return v as FormulaValue;
        });
      } catch {
        return "#ERRO";
      }
    },
  };
}

/** Formata o resultado pra exibição. */
export function formatFormulaValue(v: FormulaValue): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "✓" : "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 10000) / 10000);
  }
  return String(v);
}
