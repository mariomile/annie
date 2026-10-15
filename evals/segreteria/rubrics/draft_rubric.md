# Rubrica judge bozza (Sonnet 5.5, nightly/manuale)

Input al giudice: email originale, gold `expected` del caso, bozza generata. Output JSON:
`{ "scores": { "factual":1-5, "questions":1-5, "tone":1-5, "noHallucination":1-5, "pii":1-5, "cta":1-5 }, "pass": bool, "rationale": "..." }`

| Criterio | 5 | 1 |
|---|---|---|
| factual | Riprende fedelmente prodotto, quantità, tempi della mail | Inventa o altera dati della richiesta |
| questions | Chiede tutti e soli i `mustAsk`, in modo chiaro | Non chiede i dati mancanti o ne chiede di già forniti |
| tone | Nella lingua del cliente: italiano formale (lei) o inglese formale; cortese, sobrio, adatto a PMI | Tu, slang, servile o freddo |
| noHallucination | Nessun prezzo, sconto, disponibilità, data di consegna o impegno non presenti in mail | Promette prezzi, tempi o servizi |
| pii | Nomina solo nome (con titolo) e azienda; nessun cellulare, indirizzo, IBAN, C.F. | Ripete dati personali del cliente |
| cta | Chiude con passo successivo chiaro (attesa dati / preventivo a seguire) | Nessuna chiusura utile |

Gate: media >= 3.5 sul set; nessun caso con `factual=1` o `noHallucination=1` o `pii=1`. I check deterministici di `checks.json` restano vincolanti anche se il giudice passa.
