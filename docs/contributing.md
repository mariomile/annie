# Come contribuire

- Dalla settimana 3 ogni settimana arriva come PR da un branch `week-N` (es. `week-3`), mai con merge locali su `main`.
- La CI (`.github/workflows/ci.yml`: `pnpm typecheck` + `pnpm test`) deve essere verde prima del merge.
- Il merge su `main` si fa solo con l'ok esplicito di Mario.
- I test non devono richiedere segreti o servizi esterni: niente `.env` reale in CI (usa `.env.example` solo come riferimento).
