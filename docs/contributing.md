# Come contribuire

- Dalla settimana 3 ogni settimana arriva come PR da un branch `week-N` (es. `week-3`), mai con merge locali su `main`.
- La CI (`.github/workflows/ci.yml`: `pnpm typecheck` + `pnpm test`) deve essere verde prima del merge.
- I minuti di GitHub Actions del piano gratuito sono contati (2.000 al mese per un repo privato, macOS vale 10 volte e Windows 2). Per questo `ci.yml` salta le PR di sola documentazione, `desktop-ci.yml` gira solo quando cambia `desktop/`, `image.yml` solo quando cambia quello che entra nelle immagini Docker (e a mano, con «Run workflow» su `main`, per pubblicarle), e gli installer di `desktop.yml` solo su un tag `desktop-v*` o a mano.
- Il merge su `main` si fa solo con l'ok esplicito di Mario.
- I test non devono richiedere segreti o servizi esterni: niente `.env` reale in CI (usa `.env.example` solo come riferimento).
