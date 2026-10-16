# Settimana 8: Annie Cloud apribile su un server

Branch `week-8`. Piano: [`piano-cloud.md`](piano-cloud.md). Decisione: [ADR 0008](adr/0008-celle-container-prima-delle-micro-vm.md).

## Perché

Alla Fase 1 mancavano due pezzi per avere clienti veri: le email di accesso (finivano in un file) e un isolamento fra tenant (le celle erano processi dello stesso utente). Entrambi dipendevano da scelte di fornitore; li abbiamo fatti in modo che non dipendano più: SMTP parla con qualunque servizio, e le celle container girano su qualunque server con Docker.

## Cosa funziona (verificato)

- **Link di accesso via SMTP** (`test/smtp.test.ts`, server SMTP finto con TLS vero). `ANNIE_CLOUD_SMTP_URL` con `smtps://` (TLS dal primo byte) o `smtp://` con STARTTLS obbligatorio; AUTH PLAIN o LOGIN; testo UTF-8. SMTP in chiaro solo verso questa macchina; un a capo in un indirizzo o nell'oggetto viene rifiutato (niente header iniettati); un login rifiutato si segnala senza ripetere cosa è stato mandato.
- **Celle come container** (`test/docker-provider.test.ts`). `ANNIE_CLOUD_PROVIDER=docker`: per ogni tenant un container, un volume e una rete; utente `node`, root in sola lettura, nessuna capability, `no-new-privileges`, limiti di memoria, CPU e processi; porta solo su 127.0.0.1. Sul daemon Docker di questa macchina: registrazione, link, cella creata, prima risposta in 4,0 secondi; cella fermata per inattività e risvegliata in 3,7 secondi con la conversazione intatta; tutto rimosso alla fine. A mano: una cella non raggiunge l'altra (timeout), il codice non è scrivibile, `/data` sì.

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: tutti verdi (il test sul daemon vero gira con `ANNIE_TEST_DOCKER_IMAGE`).

## Limiti

| Cosa | Limite |
|---|---|
| Isolamento | quello di un container, kernel condiviso: basta per conversazioni e file, non per il «computer dell'agente» (Fase 3), che chiede micro-VM |
| Server | uno solo: backup notturni dei volumi; sull'host va bloccato l'endpoint dei metadati del cloud (runbook 6c) |
| Immagine | qui costruita copiando le dipendenze già installate, perché il proxy di questo ambiente non lascia scaricare pnpm dal build; su un server normale basta `docker build` |
| Prova dal vivo | Telegram, Gmail, HubSpot e Google veri restano da provare: servono i segreti e i domini consentiti |
