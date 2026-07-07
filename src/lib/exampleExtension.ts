// Extensão de exemplo instalada na pasta de extensões na primeira execução.
// Serve de referência viva pra quem for escrever a própria (é um .js editável
// na pasta — este arquivo aqui é só o template embarcado no app).

export const EXAMPLE_EXTENSION_FILE = "exemplo-cpf.js";

export const EXAMPLE_EXTENSION_SOURCE = `// Extensão de exemplo do LocalData: tipo de campo "CPF".
//
// Como funciona: qualquer arquivo .js nesta pasta é carregado quando o app
// abre (ou ao clicar em "Recarregar" no menu 📦). O código roda no app com a
// API global \`localdata\`. Um tipo registrado aqui aparece no seletor de tipo
// de campo, no grupo "Extensões".
//
// No banco, todo campo de extensão é TEXTO puro — o que as funções abaixo
// fazem é validar/normalizar na entrada (parse), formatar na exibição
// (format) e colorir (color). Apagar a extensão NÃO perde dados: as células
// voltam a aparecer como texto simples.
//
// API completa:
//   localdata.registerFieldType({
//     id: "meu-tipo",          // obrigatório, único — fica gravado no campo
//     name: "Meu tipo",        // obrigatório — nome no seletor
//     icon: "🧩",              // opcional — ícone no cabeçalho da coluna
//     description: "…",        // opcional — dica no editor de campo
//     placeholder: "…",        // opcional — placeholder do editor
//     multiline: false,        // opcional — editor vira textarea
//     parse(texto) { … },      // opcional — normaliza; throw rejeita a edição
//     format(valor) { … },     // opcional — texto exibido na célula
//     color(valor) { … },      // opcional — cor CSS do texto
//   });

localdata.registerFieldType({
  id: "cpf",
  name: "CPF",
  icon: "🪪",
  description: "CPF brasileiro com validação dos dígitos verificadores",
  placeholder: "000.000.000-00",

  parse(texto) {
    const d = texto.replace(/\\D/g, "");
    if (d.length !== 11) throw new Error("CPF precisa de 11 dígitos");
    if (/^(\\d)\\1{10}$/.test(d)) throw new Error("CPF inválido");
    for (const n of [9, 10]) {
      let soma = 0;
      for (let i = 0; i < n; i++) soma += parseInt(d[i]) * (n + 1 - i);
      const dv = ((soma * 10) % 11) % 10;
      if (dv !== parseInt(d[n])) throw new Error("CPF inválido (dígito verificador)");
    }
    return d; // guarda só os dígitos; a máscara é do format()
  },

  format(valor) {
    const d = String(valor).replace(/\\D/g, "");
    if (d.length !== 11) return String(valor);
    return d.slice(0, 3) + "." + d.slice(3, 6) + "." + d.slice(6, 9) + "-" + d.slice(9);
  },

  color() {
    return undefined; // exemplo: retorne "#16a34a" pra pintar de verde
  },
});
`;
