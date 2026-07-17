// Temas da UI: claro/escuro + as paletas nomeadas (blocos [data-theme] em App.css).

export const THEME_KEY = "localdata.theme";

export const THEMES = ["light", "dark", "nature", "darkblue", "calmgreen", "pastelpink", "punkprincess"] as const;
export type Theme = (typeof THEMES)[number];

/** Lê o tema salvo, caindo pro claro se o valor for desconhecido/ausente. */
export function loadTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return THEMES.includes(v as Theme) ? (v as Theme) : "light";
}
