# Eval segreteria commerciale (settimana 3)

Dataset e regole per misurare classificazione, estrazione lead e qualità della bozza (spec `docs/spec-segreteria-commerciale.md` §5.2, §6, §7.2). Tutti i dati sono fittizi: nomi inventati, domini `.example`, P.IVA/C.F. non reali.

## Struttura

```text
evals/segreteria/
  README.md                 # questo file + tabella di copertura
  cases/NNN-slug.json       # fonte di verità: 1 file per caso (input email + expected)
  dataset/cases.jsonl       # generato: solo input (layout spec §5.2)
  gold/labels.jsonl         # generato: solo expected
  schema/lead.schema.json   # LeadFields §4.1 (output estrattore)
  schema/case.schema.json   # schema del file caso
  checks.json               # check deterministici (prezzi, lei/tu, mustAsk, multi, PII, bottoni)
  rubrics/draft_rubric.md   # rubrica judge Sonnet (nightly)
  scripts/gen_cases.py      # generatore dei casi (modificare qui, poi rigenerare)
  scripts/validate_and_build.py  # valida schemi + coerenze e scrive i .jsonl
```

`run.ts` e `judge.ts` (spec §5.2) li scrive Ship: leggono `dataset/` + `gold/`, applicano `checks.json`, scrivono `last-report.json`.

## Come si usa

```bash
python3 scripts/validate_and_build.py     # valida e rigenera i jsonl (CI: deve uscire 0)
pnpm eval:segreteria                      # (Ship) estrazione + check deterministici, modello faux/fixture in PR
pnpm eval:segreteria:judge                # (Ship) judge Sonnet 5.5, nightly o manuale
```

Caso → expected:
- `classification`: `richiesta_preventivo | spam | risposta_thread | non_commerciale`.
- `lead`: LeadFields gold (null per spam/altro). `rawSubject`, `rawSnippet`, `receivedAt`, `mailMessageId` non sono nel gold: li riempie il codice dall'email.
- `requests`: una voce per prodotto/servizio richiesto (più voci = multi-richiesta, sempre **1 pratica, 1 lead**).
- `missingFields` (= `lead.missingFields`) e `draft.mustAsk` ⊆ `missingFields`.
- `draft`: `register: lei`, `mustNotInventPrices`, `allowedAmounts` (solo importi già scritti dal cliente), bullet + domanda sulla priorità per multi, `mustMention`/`mustNotMention`, saluto atteso, `autonomousSend: false`.
- `tenantConfig`: `requireVatNumber` (default `false`).
- `flow`: azione sulla pratica (`create | create_skip | attach_to_existing | noop_duplicate | log_only | notify_only`), numero di `upsertLead` atteso, stato dopo la pipeline, bottoni `[Approva, Modifica, Scarta]`.

Metriche e soglie (spec §7.2): schema 100%; micro-F1 campi ≥ 0.85; exact-match lead ≥ 0.60; classificazione accuracy (proposta ≥ 0.95, nessuno spam classificato preventivo); check deterministici bozza 100% su `prices`, `register`, `mustAsk`, `mustNotMention`; judge media ≥ 3.5.

Prova dei controlli (preflight): prima di dare un punteggio, `run.ts` prova i controlli di `checks.json` su due estremi per ogni caso con bozza (`preflight.ts`). La bozza gold, quella che `run.ts` costruisce dal gold del caso, deve superarli tutti; due bozze senza contenuto, una vuota e una generica («Gentile cliente, la ricontatteremo a breve. Cordiali saluti.»), devono fallire i controlli che il caso attiva e che pretendono qualcosa: ogni domanda di `mustAsk`, ogni voce di `mustMention`, elenco e domanda sulla priorità del multi, il saluto atteso (la generica può contenerlo, es. «Gentile») e il registro (solo la bozza vuota). I controlli del tipo «non deve contenere» (prezzi, tu, `mustNotMention`, PII, `mustNotAskVatNumber`) una bozza senza contenuto li supera legittimamente, quindi non se ne pretende il fallimento. Se un caso viola la regola, l'eval esce con 1 prima di valutare e scrive caso e controllo (`036-piva-errata: empty no-op passes register`). L'idea viene dal preflight oracle/no-op di `score.py --expect` in reason-machines/benchmark.

Distribuzione: 5 completi · 5+1 dati mancanti (033: tenant con P.IVA obbligatoria) · 3 registro · 3 prezzo · 2 multi + 1 multi su thread · 1 allegato · 2 lingua · 2 spam + 3 non commerciali (024, 025, 034) · 2 thread · 2 titoli/PII + 1 PII forte (035) · 1 encoding · 1 mittente invalido · 1 duplicato · 2 P.IVA errata (036 italiana, 037 estera in inglese). Totale 37.

## Copertura: criteri di accettazione e casi limite → casi

| Riferimento spec | Casi | Tipo di verifica |
|---|---|---|
| §7.1-1 Gate umano, nessun `sendReply` prima di Approva | tutti (`flow.sendAllowedOnlyAfterApprove`), 031 | mock send = 0 nella pipeline |
| §7.1-2 Solo tre pulsanti | tutti (`flow.telegramButtons`), 022–025 (stato skip) | check flow |
| §7.1-3 Allowlist (A8: ignorato e registrato anche su pratica chiusa) | — | test motore (non dataset) |
| §7.1-4 Idempotenza ingresso | 032 (dopo 001) | 0 pratiche/upsert extra |
| §7.1-5..10 Idempotenza invio, Approva/Modifica/Scarta, Modifica in linea, crash, doppione, tenant | — | test motore/integrazione (Ship), non qualità modello |
| §7.2-11 Schema lead 100% | tutti con lead (32 casi), 030 | Ajv su `lead.schema.json` |
| §7.2-12 Estrazione F1/exact | 001–021, 026–031 | confronto gold |
| §7.2-13 Dati mancanti → domande, niente prezzi | 006, 007, 008, 009, 010, 012, 016, 018, 019, 021, 029 | `mustAsk` + `prices` |
| §7.2-14 Multi-richiesta: 1 pratica, 1 upsert, bozza a punti | 017, 018, (027 su thread) | `multiRequest` + flow |
| §7.2-15 Spam (022, 023) e non commerciale A4 (024, 025, 034): nessun upsert | 022, 023, 024, 025, 034 | classificazione + `crmUpsertExpected=0` |
| §7.2-16 Reply a thread: nessuna pratica duplicata | 026, 027 (A5: stesso lead, prodotti aggiunti) | `attach_to_existing` |
| §7.2-17 Registro lei | tutti con bozza; mirati 011, 012, 010, 013 | `register` |
| §7.2-18 Niente prezzi inventati / prezzo cliente | tutti con bozza; mirati 014, 015, 016, 012 | `prices` + `allowedAmounts` |
| §7.3-19..21 Routing e tetti | — | config/test motore (eval girano con routing di config) |
| §6 Stessa mail al restart | 032 | flow |
| §6 Mail senza mittente valido (A2) | 031 | `failed`, solo log, avviso senza pulsanti, nessun lead |
| §6 Dati mancanti (qty, sede, P.IVA, product) | 006 qty · 007 sede · 033 P.IVA (tenant) · 008 P.IVA non chiesta · 009 product · 010 più campi | mustAsk |
| P.IVA errata al controllo formale (offline) | 036 italiana con etichetta, IT e spazi · 037 tedesca con la forma sbagliata | `vatNumberInvalid` in mustAsk, numero mai ripetuto, richiesta di ricontrollo esente da `mustNotAskVatNumber`; `run.ts` confronta la P.IVA dell'euristica col gold |
| §6 Più richieste nella stessa mail | 017, 018 | multiRequest |
| §6 Risposta a thread già gestito | 026, 027 | flow + scheda «Nuova mail sul thread» |
| §6 Spam / non-preventivo | 022 newsletter · 023 phishing con esca «preventivo» · 024 fornitore · 025 amministrativa | classificazione |
| §6 Prezzo citato dal cliente | 014 prezzo unitario · 015 budget | allowedAmounts |
| §6 Lingua straniera o mista | 020 EN · 021 IT+EN | A1: bozza nella lingua del cliente, scheda in IT |
| §6 Allegato citato assente | 019 | mustNotMention + nota scheda |
| §6 Titoli e PII | 013 Ing. · 028 Dott. + C.F./data nascita · 029 Avv. · 035 IBAN/indirizzo/cellulare | saluto + mustNotMention |
| §5.2 Formale vs informale | 011, 012 vs 013 | register |
| §5.2 Encoding | 030 (RFC2047 + quoted-printable + HTML entities) | parsing + estrazione |
| §5.2 Completi | 001–005 | baseline |
| §6 Due commerciali, crash, CRM down, soft/hard cap, allowlist a caldo, bozza > 4096 | — | test motore (Ship); non dipendono dal testo della mail |

## Decisioni di Craft applicate (15 ott 2026)

| Punto | Decisione | Dove |
|---|---|---|
| A1 | Bozza nella lingua del cliente (EN formale se scrive in inglese), italiano di default; scheda Telegram sempre in italiano | 020 (`language: en`, `register: formal_en`), 021 (misto → it); `checks.json` `language`, `registerEn`; `flow.telegramLanguage` |
| A2 | Mittente non valido: nessun lead CRM, pratica solo registrata, avviso Telegram senza pulsanti | 031 (`log_only`, `crmUpsertExpected 0`, `telegramButtons []`, nessuna bozza) |
| A3 | `vatNumber` opzionale nel lead; mai chiesta ai privati; alle aziende solo se `tenantConfig.requireVatNumber` | 005 privato, 008 assente con tenant di default (non chiesta), 033 tenant che la richiede; `mustNotAskVatNumber` |
| A4 | Classe `non_commerciale`: niente bozza, niente lead, notifica breve senza pulsanti, non è spam | 024, 025, 034 (`notify_only`, stato `logged`) |
| A5 | Nuova richiesta in un thread già inviato: `upsertLead` sullo stesso lead con i prodotti aggiunti + nuova bozza da approvare | 027 (`leadUpdate: same_lead_add_products`, `newLeadExpected 0`) |
| A6 | `title` e `originalLanguage` confermati | `lead.schema.json` |
| A7 | Nel CRM solo i contatti scritti dal mittente; la bozza nomina solo nome e azienda | 028, 035; `checks.json` `pii` (cellulare, fisso, IBAN, C.F., P.IVA, data di nascita, indirizzo, email) + `crmMustNotContain` |
| A8 | Tap da fuori allowlist: ignorato in silenzio e registrato (`user.denied`), sia su pratica aperta sia chiusa | test motore (Ship), non dataset |

Nota: `logged` (stato pratica) e le azioni `log_only`/`notify_only` sono nuovi rispetto al `PraticaStatus` della spec §2: Ship deve aggiungerli al tipo.
