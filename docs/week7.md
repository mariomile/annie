# Settimana 7: verso Annie Cloud

Branch `week-7`. Piano: [`piano-cloud.md`](piano-cloud.md). Decisione: [ADR 0007](adr/0007-annie-cloud-a-celle.md). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md) (Cella, Control plane, Operatore, Annie Cloud).

## Perché

Mario ha chiarito che Annie deve funzionare anche come Grok Bot e dots: un agente a cui ci si registra e si parla, nel cloud. Con lui abbiamo deciso target (professionisti e piccoli team, dati in UE), architettura (una cella per tenant e un control plane sottile) e ordine (prima cella e registrazione, poi memoria e Google). Questa settimana porta la Fase 1 fino al punto in cui serve scegliere il cloud.

## Cosa funziona (verificato dai test)

- **`pnpm annie check`** (`test/check.test.ts`). Prova ogni servizio configurato (chiave del modello, bot Telegram, OAuth Gmail con i due scope, token HubSpot e i valori di `hs_lead_status` del portale) e dice cosa correggere, senza stampare segreti. Il giorno della prova dal vivo parte da qui.
- **Telegram via webhook** (`test/telegram.test.ts`, `test/app.test.ts`). Con `ANNIE_PUBLIC_URL` e `ANNIE_TELEGRAM_WEBHOOK_SECRET` il bot registra un webhook invece del long polling; gli update arrivano a `/hooks/telegram/<istanza>`, controllati con il secret che Telegram ripete in un header. Stesso percorso del polling (tre fallimenti, poi lascia andare), e un update riconsegnato riceve una sola risposta. Serve a una cella che dorme.
- **Contratto della cella** (`test/app.test.ts`, `test/outbox.test.ts`). `ANNIE_CELL_SECRET` abilita `GET /internal/cell` (c'è lavoro in corso? quando va svegliata: primo task programmato, prossimo giro di posta della segreteria) e `POST /internal/owner-link` (un nuovo link per l'owner a ogni accesso, registrato nell'audit della cella; con la verifica in due passaggi il link da solo non basta). Una cella non scrive il link dell'owner su disco.
- **Control plane** (`test/cloud.test.ts`, celle vere come processi locali). `pnpm cloud`: registrazione con link via email (una volta sola, 30 minuti, cinque all'ora per indirizzo, venti all'ora per chi li chiede; se la cella non parte il link resta valido), una cella per tenant creata alla prima verifica con un indirizzo casuale che non mostra il nome della persona, ingresso già autenticato, smistamento per sottodominio verso la cella (stream degli eventi e webhook compresi). Gli endpoint `/internal/` non sono raggiungibili da fuori in nessuna grafia del percorso; al passaggio si tolgono `authorization` e gli header hop-by-hop. Una cella spenta si sveglia per chi ha una sessione o per un webhook, non per richieste anonime; un tenant che non esiste risponde come una cella che dorme. Le celle inattive si fermano se non stanno lavorando (una richiesta arrivata nel frattempo le tiene su, una che arriva durante lo spegnimento aspetta e la risveglia) e si svegliano all'ora del prossimo task, anche dopo un riavvio del control plane. Interfacce `CellProvider` e `Mailer`: oggi un provider a processi locali e un mailer su file.
- **Telegram per istanza dalla console** (`test/app.test.ts`, `test/egress.test.ts`). In Impostazioni l'owner collega il bot di un'istanza (token, chi può scrivere, chi approva): il token viene provato con Telegram, finisce nel secret store e non torna più al browser; il bot parte subito, riparte dopo un riavvio e si scollega con un clic. Con un indirizzo https (una cella) usa il webhook con un segreto per istanza, altrimenti il long polling. La console distingue un token rifiutato da Telegram non raggiungibile. Il test ha trovato un bug del nucleo: la risposta controllava i canali consentiti come erano all'apertura dell'istanza, quindi un canale aggiunto dopo restava bloccato fino al riavvio. Ora vale la policy salvata in quel momento.
- **Robustezza** (`test/telegram.test.ts`, `test/app.test.ts`). Un bot che Telegram non accetta (token sbagliato, webhook su http) non impedisce più ad Annie di partire; il long polling cancella un webhook rimasto da prima. `pnpm annie check` confronta i valori di `hs_lead_status` del portale con quelli che la segreteria imposta.

## Review indipendente

Due revisori separati hanno trovato, tra gli altri:

- **Alta, control plane.** Il blocco di `/internal/` controllava il percorso grezzo: `//x/internal/cell`, `/./internal/cell`, `/a/../internal/cell`, `/%2e/internal/cell` e la forma assoluta arrivavano all'endpoint della cella, protetti solo dal segreto. Ora si controlla il percorso normalizzato, si inoltra quello, e il test prova tutte le varianti.
- **Media.** Qualunque richiesta svegliava una cella (costo e disturbo); gli header del client passavano tutti; una richiesta durante lo spegnimento veniva troncata; un risveglio programmato si perdeva se l'avvio falliva o se il control plane si riavviava; un link usato veniva perso se la cella non partiva; il sottodominio mostrava il nome della persona; l'indirizzo di un tenant inesistente era distinguibile; un bot rifiutato da Telegram impediva alla cella di partire; il glossario diceva che l'operatore non legge le conversazioni, ma con il segreto di cella può entrare come owner. Corretti, e il glossario ora dice come stanno le cose.
- **Bassa.** `ANNIE_OWNER_TOKEN` era codice morto e un segreto in più su disco (tolto); confronto dei segreti e stato della cella duplicati (ora un helper e un tipo); timeout e parallelismo nel giro di controllo delle celle; l'errore di una cella che non parte poteva finire nei log del control plane con contenuti (ora resta nella cartella della cella).

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: 28 file, 198 test, 0 fallimenti (172 a fine settimana 6).
- Chromium: la sezione Telegram in Impostazioni collega un bot; qui Telegram è bloccato dalla rete e la console lo dice («non raggiungibile da questo server»). `pnpm eval:segreteria`: 35 casi ok.
- Chromium headless su `annie.localhost`: registrazione, link dalla mail, cella creata, console già autenticata, prima risposta in tempo reale in 2,1 secondi (in locale, con il modello finto).
- `pnpm annie check` eseguito qui: chiave Anthropic finta rifiutata con il nome della variabile, Telegram dato come non raggiungibile con il suggerimento sui domini consentiti.

## Limiti

| Cosa | Limite |
|---|---|
| Celle | provider a processi locali, solo per sviluppo: le celle girano con lo stesso utente del control plane e potrebbero leggerne i file. L'isolamento per macchina dell'ADR 0007 arriva con il provider per micro-VM |
| Dominio | tenant e pagina di registrazione condividono il dominio: in produzione i tenant vanno su un dominio separato registrato nella Public Suffix List, così una cella non può toccare i cookie delle altre |
| Accesso dell'operatore | con il segreto di cella l'operatore può chiedere un link da owner: resta nell'audit della cella, e con la verifica in due passaggi non basta |
| Email | mailer su file: i link si leggono in `data-cloud/mail/outbox.txt` finché non scegliamo il servizio |
| Sonno | una scheda aperta nel browser tiene sveglia la cella (lo stream degli eventi è una richiesta aperta); la segreteria la sveglia a ogni giro di posta |
| Segreteria in cloud | il suo bot fa ancora long polling: va passato al webhook come quello dell'agente |
| Pagamento | nessuno: ogni cella usa la chiave del modello dell'operatore, con i tetti di spesa per tenant |
