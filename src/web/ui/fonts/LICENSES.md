# Font

Distribuiti con Annie per non dipendere da CDN esterne (la console ha `default-src 'self'`).
Presi dai pacchetti npm `@fontsource-variable/geist@5.3.0` e `@fontsource-variable/geist-mono@5.3.0` (sottoinsiemi latin e latin-ext, peso variabile 100-900).

| File | Font | Licenza |
|---|---|---|
| `geist-latin.woff2`, `geist-latin-ext.woff2` | Geist (The Geist Project Authors) | SIL OFL 1.1 |
| `geist-mono-latin.woff2`, `geist-mono-latin-ext.woff2` | Geist Mono (The Geist Project Authors) | SIL OFL 1.1 |

Testo completo della licenza: [`OFL-Geist.txt`](OFL-Geist.txt).

## Grafici

I grafici (ADR 0030) non usano un file di font: i contorni delle lettere latine di DejaVu Sans e DejaVu Sans Bold sono copiati in `src/core/chart-font.ts` da `scripts/chart-font.ts`. Licenza Bitstream Vera (i cambiamenti di DejaVu sono di pubblico dominio), riportata per intero in testa a quel file. Le lettere copiate sono quelle di Bitstream Vera e di DejaVu, non quelle aggiunte dai font Arev.
