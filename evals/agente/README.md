# Eval dell'agente generale (ADR 0099)

`cases.jsonl`: una richiesta per riga, `{ id, text, expect }`. `expect` sono gli strumenti accettabili come prima chiamata; `[]` vuol dire nessuno strumento.

```bash
pnpm eval:agente                 # PR CI: ogni strumento atteso esiste nel catalogo dell'agente
pnpm eval:agente:real            # nightly: modello vero, serve ANNIE_JUDGE_MODEL_KEY
pnpm eval:agente:real saluto     # solo i casi con questi id
```

Il rapporto della notte è in `last-report/agente.json`: per ogni caso gli strumenti chiamati, il primo, se è giusto, il costo. Soglia: primo strumento giusto in almeno l'80% dei casi. `ANNIE_MODEL_ID` sceglie il modello da misurare. `tool_search` non conta come primo strumento, perché carica solo i registri rimandati (ADR 0100). Un turno che chiama solo `tool_search` non conta come «nessuno strumento».
