# Settimana 7: verso Annie Cloud

Branch `week-7`. Piano: [`piano-cloud.md`](piano-cloud.md). Decisione: [ADR 0007](adr/0007-annie-cloud-a-celle.md). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md) (Cella, Control plane, Operatore, Annie Cloud).

## Perché

Mario ha chiarito che Annie deve funzionare anche come Grok Bot e dots: un agente a cui ci si registra e si parla, nel cloud. Con lui abbiamo deciso target (professionisti e piccoli team, dati in UE), architettura (una cella per tenant e un control plane sottile) e ordine (prima cella e registrazione, poi memoria e Google). Questa settimana porta la Fase 1 fino al punto in cui serve scegliere il cloud.

## Cosa funziona (verificato dai test)

- **`pnpm annie check`** (`test/check.test.ts`). Prova ogni servizio configurato (chiave del modello, bot Telegram, OAuth Gmail con i due scope, token HubSpot e i valori di `hs_lead_status` del portale) e dice cosa correggere, senza stampare segreti. Il giorno della prova dal vivo parte da qui.
- **Telegram via webhook** (`test/telegram.test.ts`, `test/app.test.ts`). Con `ANNIE_PUBLIC_URL` e `ANNIE_TELEGRAM_WEBHOOK_SECRET` il bot registra un webhook invece del long polling; gli update arrivano a `/hooks/telegram/<istanza>`, controllati con il secret che Telegram ripete in un header. Stesso percorso del polling (tre fallimenti, poi lascia andare), e un update riconsegnato riceve una sola risposta. Serve a una cella che dorme.
- **Contratto della cella** (`test/app.test.ts`, `test/outbox.test.ts`). `ANNIE_OWNER_TOKEN`: il primo owner nasce con un token scelto dal control plane. `ANNIE_CELL_SECRET` abilita `GET /internal/cell` (c'è lavoro in corso? quando va svegliata: primo task programmato, prossimo giro di posta della segreteria) e `POST /internal/owner-link` (un nuovo link per l'owner a ogni accesso; con la verifica in due passaggi il link da solo non basta).
- **Control plane** (`test/cloud.test.ts`, celle vere come processi locali). `pnpm cloud`: registrazione con link via email (una volta sola, 30 minuti, cinque all'ora per indirizzo), una cella per tenant creata alla prima verifica, ingresso già autenticato, smistamento per sottodominio verso la cella (stream degli eventi e webhook compresi, mai gli endpoint `/internal/`), celle inattive fermate se non stanno lavorando e svegliate dal primo messaggio o all'ora del prossimo task. Interfacce `CellProvider` e `Mailer`: oggi un provider a processi locali e un mailer su file.

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: 28 file, 190 test, 0 fallimenti (172 a fine settimana 6). `pnpm eval:segreteria`: 35 casi ok.
- Chromium headless su `annie.localhost`: registrazione, link dalla mail, cella creata, console già autenticata, prima risposta in tempo reale in 2,1 secondi (in locale, con il modello finto).
- `pnpm annie check` eseguito qui: chiave Anthropic finta rifiutata con il nome della variabile, Telegram dato come non raggiungibile con il suggerimento sui domini consentiti.

## Limiti

| Cosa | Limite |
|---|---|
| Celle | provider a processi locali: isolamento del sistema operativo, non di macchina; il provider per micro-VM arriva con la scelta del cloud |
| Email | mailer su file: i link si leggono in `data-cloud/mail/outbox.txt` finché non scegliamo il servizio |
| Sonno | una scheda aperta nel browser tiene sveglia la cella (lo stream degli eventi è una richiesta aperta); la segreteria la sveglia a ogni giro di posta |
| Segreteria in cloud | il suo bot fa ancora long polling: va passato al webhook come quello dell'agente |
| Pagamento | nessuno: ogni cella usa la chiave del modello dell'operatore, con i tetti di spesa per tenant |
