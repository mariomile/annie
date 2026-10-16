# Runbook: installare e gestire Annie

Per chi installa Annie presso un cliente (owner). Un'installazione = un tenant = un container. Vocabolario in [`GLOSSARY.md`](../GLOSSARY.md).

Le chiavi che servono, dove prenderle e dove metterle, passo per passo: [`chiavi.md`](chiavi.md).

## 1. Requisiti

- Un server Linux con Docker e Docker Compose, oppure Node.js 22.19+ e pnpm 10.
- Disco locale per i dati (non NFS/SMB: il lock delle istanze usa lock POSIX).
- Una chiave Anthropic (o OpenAI). Opzionali: un bot Telegram per l'agente, un secondo bot per la segreteria, OAuth Gmail e token HubSpot per la segreteria.
- Un reverse proxy con https davanti alla console (Caddy, nginx, Traefik).

## 2. Installazione con Docker

```bash
git clone <repo> annie && cd annie
cp .env.example .env          # compila almeno ANTHROPIC_API_KEY e ANNIE_PUBLIC_URL
docker compose up -d --build
docker compose exec annie cat /data/owner-login-link.txt
docker compose exec annie rm /data/owner-login-link.txt
```

Al primo avvio Annie crea il tenant, l'istanza `annie` e l'owner, e scrive il link d'accesso dell'owner in `owner-login-link.txt` nella cartella dati (permessi 0600; non finisce nei log). Aprilo nel browser, poi cancella il file.

Il container gira con il minimo dei privilegi: filesystem in sola lettura tranne `/data` e `/tmp`, nessuna capability Linux, niente escalation di privilegi. Se lo avvii senza compose, usa le stesse opzioni (`--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true`).

La porta 8080 è esposta solo su `127.0.0.1`. Esempio Caddy:

```text
annie.cliente.it {
	reverse_proxy 127.0.0.1:8080
}
```

Con `ANNIE_PUBLIC_URL=https://annie.cliente.it` i cookie di sessione sono `Secure` e i link d'accesso hanno l'indirizzo giusto. Il proxy non deve fare buffering degli eventi (`/api/events` è uno stream SSE): Caddy e Traefik vanno bene così; con nginx usa `proxy_buffering off` su quel percorso.

Dietro un proxy aziendale che ispeziona TLS, la build deve fidarsi della sua CA: aggiungi la CA all'immagine (`COPY` + `NODE_EXTRA_CA_CERTS`) e passa il proxy con `--build-arg HTTPS_PROXY=...`.

## 3. Installazione senza Docker

```bash
pnpm install --prod --frozen-lockfile
cp .env.example .env
pnpm start                    # oppure un servizio systemd che lancia questo comando
cat data/owner-login-link.txt && rm data/owner-login-link.txt   # primo avvio
```

Prima di tutto, e ogni volta che cambi una chiave: `pnpm annie check` (con Docker: `docker compose exec annie node_modules/.bin/tsx src/main/cli.ts check`). Prova ogni servizio configurato e dice cosa non va, senza stampare segreti: chiave del modello, bot Telegram, OAuth Gmail con i due scope, token HubSpot (e i valori di `hs_lead_status` del portale), host non raggiungibili.

## 4. Persone e accessi

Dalla console (pagina Persone, solo owner) o da riga di comando:

```bash
pnpm annie person add "Anna Rossi" --instance annie    # stampa il link personale
pnpm annie person list
pnpm annie person link p_xxxxxxxxxxxx                   # nuovo link, il vecchio e le sue sessioni smettono di funzionare
pnpm annie person remove p_xxxxxxxxxxxx
pnpm annie person reset-2fa p_xxxxxxxxxxxx              # toglie la verifica in due passaggi (telefono perso)
```

Con Docker: `docker compose exec annie node_modules/.bin/tsx src/main/cli.ts person add "Anna Rossi" --instance annie`.

Ognuno può attivare la verifica in due passaggi cliccando sul proprio nome nella console: da quel momento per entrare servono il link e il codice dell'app di autenticazione. Per chi gestisce dati di clienti conviene chiederla a tutti.

Il link contiene il token nel frammento (`#...`): non finisce nei log del server né del proxy. Va dato alla persona in privato. In Impostazioni l'owner decide chi può **scrivere** all'istanza dal web e chi **approva** le sue azioni (tool proposti, pratiche della segreteria).

## 5. Telegram

Ogni istanza può avere il suo bot, collegato dall'owner in Impostazioni → Telegram (token, chi può scrivere, chi approva), senza riavviare. In alternativa, per l'istanza principale, da `.env`:

1. Crea un bot con @BotFather e metti il token in `TELEGRAM_BOT_TOKEN`.
2. Metti in `ANNIE_TELEGRAM_ALLOWED_USERS` gli ID numerici di chi può scrivere al bot, e in `ANNIE_TELEGRAM_APPROVERS` chi riceve le schede di approvazione dei tool. Ogni persona apre il bot e preme Start una volta.
3. Riavvia. Chi non è in elenco non riceve risposta (e finisce nell'audit).
4. Facoltativo, webhook invece del long polling: con `ANNIE_PUBLIC_URL` in https e `ANNIE_TELEGRAM_WEBHOOK_SECRET` (lettere, cifre, `_` e `-`), all'avvio Annie registra il webhook e Telegram manda i messaggi a `ANNIE_PUBLIC_URL/hooks/telegram/<istanza>`. Il reverse proxy deve far passare quel percorso. Serve quando il processo può spegnersi (Annie Cloud); in self-host il long polling va benissimo.

## 6. Segreteria commerciale

Richiede un **secondo** bot (due processi in long polling sullo stesso token si rubano gli update):

```text
ANNIE_SEGRETERIA_TELEGRAM_BOT_TOKEN=...
ANNIE_SEGRETERIA_SALES=<ID Telegram dei commerciali>
GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN    # scope gmail.readonly + gmail.send
HUBSPOT_ACCESS_TOKEN                                         # scope crm.objects.contacts.read/write
```

Al primo avvio la segreteria ignora la posta già presente e parte da quella nuova. Le pratiche si gestiscono su Telegram o nella console (pagina Segreteria). Nessuna mail parte senza Approva. Un'app Google in modalità «Testing» ha refresh token che scadono dopo 7 giorni: per l'uso reale pubblica l'app OAuth.

## 6b. Google per persona (Gmail e Calendar in sola lettura)

Ogni persona collega il proprio account Google dal menu del suo account nella console; Annie lo usa solo nelle conversazioni di quella persona dalla console e nel suo brief del mattino. Per attivarlo:

1. In Google Cloud console crea un client OAuth di tipo «Applicazione web» e aggiungi come URI di reindirizzamento `ANNIE_PUBLIC_URL/oauth/google/callback` (in locale `http://localhost:8080/oauth/google/callback`).
2. Abilita Gmail API e Google Calendar API nel progetto.
3. In `.env`: `ANNIE_GOOGLE_CLIENT_ID`, `ANNIE_GOOGLE_CLIENT_SECRET` e, se serve, `ANNIE_GOOGLE_SERVICES` (`gmail,calendar`, il default, oppure uno dei due). Riavvia.
4. In Impostazioni l'owner attiva «Consenti Google a questa istanza».

Verifica dell'app da parte di Google: `calendar.readonly` è uno scope «sensitive» (verifica di pochi giorni), `gmail.readonly` è «restricted» e per un'app pubblica che conserva i dati sul server richiede una valutazione di sicurezza annuale da un assessor approvato da Google. Finché l'app è in «Testing» i refresh token scadono dopo 7 giorni e possono collegarsi solo gli utenti di test; in un'organizzazione Google Workspace l'amministratore può marcare l'app come attendibile. Per partire senza la valutazione: `ANNIE_GOOGLE_SERVICES=calendar`.

Il brief del mattino si attiva dalla pagina Task; `pnpm annie brief` dice quanti sono attivi e quante persone lo ricevono e lo usano. La memoria di una persona vale solo nelle sue conversazioni private (console, chat privata di Telegram), mai nei gruppi.

Il refresh token resta nel secret store del tenant; «Scollega» lo cancella e lo revoca presso Google. In Annie Cloud il control plane passa le variabili alle celle nuove e riceve lui il ritorno da Google (`https://<dominio>/oauth/google/callback`, da registrare come unico URI), poi rimanda la persona alla sua cella.

## 6c. Annie Cloud su un server (control plane e celle container)

Per offrire Annie come servizio su un solo server in UE (ADR 0008). Serve Docker 28 o successivo (prima, le porte pubblicate su 127.0.0.1 erano raggiungibili dalla rete locale), Node 22 e pnpm.

1. Un utente dedicato, nel gruppo `docker` (l'accesso al socket di Docker equivale a root: nessun altro servizio con quell'utente). Clona il repository, `pnpm install --frozen-lockfile`, poi costruisci l'immagine delle celle: `docker build -t annie:local .`.
2. In `.env` del control plane: `ANNIE_CLOUD_DOMAIN` (dominio delle celle, separato da quello di Buildrs e registrato nella Public Suffix List, ADR 0007), `ANNIE_CLOUD_SCHEME=https`, `ANNIE_CLOUD_PROVIDER=docker`, `ANNIE_CLOUD_DOCKER_IMAGE=annie:local`, la chiave del modello (passa alle celle), `ANNIE_CLOUD_SMTP_URL` e `ANNIE_CLOUD_MAIL_FROM` per i link di accesso, e se serve `ANNIE_CLOUD_CELL_MEMORY_MB` (intero, almeno 128; default 512).
3. `pnpm cloud` come servizio (systemd), dietro un reverse proxy https per `dominio` e `*.dominio` (certificato wildcard) che passa l'header `Host` così com'è: lo smistamento alle celle si basa su quello. Il control plane ascolta su 127.0.0.1.
4. Blocca ai container l'endpoint dei metadati del cloud e i servizi dell'host, e rendi la regola permanente (per esempio con `iptables-persistent`): `iptables -I DOCKER-USER -d 169.254.169.254 -j DROP` (e l'equivalente IPv6 se il provider lo espone). Sull'host niente in ascolto su 0.0.0.0 oltre al reverse proxy.
5. Backup ogni notte dei volumi `annie-cell-*` (contengono tutto di ogni tenant) e di `data-cloud/control-plane.json`. Ripristino: ricrea il volume con lo stesso nome, rimetti i file, e la cella riparte al primo messaggio.
6. Aggiornare (nuova versione, nuova chiave del modello): ferma `pnpm cloud`, ricostruisci l'immagine, `pnpm cloud upgrade` (ricrea i container tenendo i volumi), riavvia `pnpm cloud`.

Le celle stanno tutte sulla rete `annie-cells`, dove i container non si parlano fra loro. `ANNIE_TEST_DOCKER_IMAGE=annie:local pnpm vitest run test/docker-provider.test.ts` prova il giro completo su un daemon vero.

`pnpm cloud status` elenca i tenant (email, data, stato della cella, prossimo risveglio) e la spesa sul modello di oggi, del mese e del mese scorso, stimata dai prezzi di listino. Le celle accese vengono interrogate; per quelle che dormono mostra l'ultima spesa letta, senza svegliarle. Il control plane conserva la spesa di ogni mese, anche di quelli chiusi, per la fattura. Funziona con `docker` e `railway`; con il provider `local` (solo sviluppo) le celle sono processi del control plane e da un altro processo risultano tutte spente.

## 6d. Annie Cloud su Railway

In alternativa al server (in valutazione, docs/week9.md): ogni cella è un progetto Railway con un servizio dall'immagine di Annie, un volume su `/data`, la regione EU West (Amsterdam) e la modalità serverless, che la fa dormire da sola dopo qualche minuto senza traffico e la risveglia alla prima richiesta.

1. L'immagine: il workflow `Image` la pubblica su `ghcr.io/<owner>/annie:latest` a ogni merge su `main`. Se il pacchetto GHCR è privato, Railway ha bisogno delle credenziali del registry (o rendi pubblico il pacchetto).
2. Un token di account o workspace Railway (Account Settings → Tokens).
3. In `.env` del control plane: `ANNIE_CLOUD_PROVIDER=railway`, `RAILWAY_API_TOKEN`, `ANNIE_CLOUD_RAILWAY_IMAGE`, facoltativi `ANNIE_CLOUD_RAILWAY_WORKSPACE` e `ANNIE_CLOUD_RAILWAY_REGION` (default `europe-west4-drams3a`), più dominio, chiave del modello e SMTP come in 6c.
4. Il control plane (anche lui su Railway o altrove) raggiunge ogni cella sul suo dominio `*.up.railway.app` in https. La cella risponde solo alle richieste che portano l'intestazione del control plane (derivata dal segreto di cella); una richiesta diretta al dominio Railway riceve 404.
5. Aggiornare: `pnpm cloud upgrade` aggiorna le variabili e rifà il deploy di ogni cella; i volumi restano.

## 6e. Navigazione web

In Impostazioni → Navigazione web l'owner elenca i siti che l'istanza può leggere e fotografare (un dominio per riga, sottodomini compresi; `*` per tutti i siti pubblici). Vuoto vuol dire nessuno. Gli indirizzi interni (rete locale, metadati del cloud) restano negati comunque. Per gli screenshot serve Chromium: nell'immagine Docker con `docker build --build-arg WITH_BROWSER=1 .` (l'immagine pubblicata su GHCR lo ha), senza Docker con `ANNIE_CHROMIUM_PATH` o il browser di Playwright. Chromium deve partire con il suo sandbox; se nel log compare «screenshots off», o si dà al container quello che serve agli user namespace, o si accetta il rischio con `ANNIE_SCREENSHOTS_WITHOUT_SANDBOX=1` (ADR 0009).

## 6f. Abbonamenti (Stripe)

Senza `ANNIE_CLOUD_STRIPE_SECRET_KEY` Annie Cloud è gratuito. Con la chiave, ogni tenant ha una prova (`ANNIE_CLOUD_TRIAL_DAYS`, 14 giorni di default) e poi serve l'abbonamento; finita la prova senza abbonamento la cella resta spenta, con i dati intatti (ADR 0010).

1. In Stripe crea un prodotto «Annie» con un prezzo mensile ricorrente: il suo id (`price_…`) va in `ANNIE_CLOUD_STRIPE_PRICE`.
2. Facoltativo, il consumo del modello: crea un contatore (Billing → Meters) con aggregazione «somma», chiave cliente `stripe_customer_id` e valore `value`. Poi crea un prezzo a consumo collegato al contatore. Un'unità è un centesimo di dollaro di costo del modello a prezzi di listino. Il prezzo per unità copre cambio e ricarico: se un centesimo di dollaro vale X euro, X × 1,5 è un ricarico del 50%. Nome dell'evento del contatore in `ANNIE_CLOUD_STRIPE_METER_EVENT`, id del prezzo in `ANNIE_CLOUD_STRIPE_USAGE_PRICE`.
3. Developers → Webhooks → aggiungi l'endpoint `https://<dominio>/stripe/webhook` con gli eventi `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` e `customer.subscription.deleted`. Il segreto di firma (`whsec_…`) va in `ANNIE_CLOUD_STRIPE_WEBHOOK_SECRET`. A ogni evento il control plane rilegge l'abbonamento da Stripe: la chiave deve poter leggere le subscription.
4. Settings → Billing → Customer portal: attiva il portale (fatture, carta, disdetta). In Settings → Billing → Subscriptions and emails, per i pagamenti non riusciti scegli di annullare l'abbonamento dopo l'ultimo tentativo: finché resta «in ritardo», Annie continua a funzionare.
5. Prova in modalità test (chiavi `sk_test_…`) con le carte di prova di Stripe, poi passa alle chiavi live.

Le persone si abbonano dalla pagina di Annie Cloud («Gestisci l'abbonamento», con il link via email) o, a prova finita, dal link che ricevono entrando. Chi si abbona durante la prova paga dalla fine della prova. `pnpm cloud status` mostra per ogni tenant: in prova fino a quando, abbonato, pagamento in ritardo, oppure sospeso (con lo stato Stripe se l'abbonamento è stato annullato). Lo legge da quello che il control plane ha salvato, quindi non servono le variabili Stripe nella shell. Un secondo abbonamento dello stesso tenant (due pagamenti da due schede) compare nel log del control plane: va rimborsato e annullato su Stripe.

## 6g. WhatsApp

Ogni istanza può avere un numero WhatsApp Business, collegato dall'owner in Impostazioni → WhatsApp con token di accesso, ID del numero e app secret dell'app Meta (passi in [chiavi.md](chiavi.md), punto 9). I messaggi arrivano solo per webhook, quindi serve `ANNIE_PUBLIC_URL` in https. In Annie Cloud il control plane inoltra `/hooks/whatsapp/…` alla cella e la sveglia. Meta firma ogni consegna con l'app secret: una consegna senza firma valida riceve 401. Chi non è in «Chi può scrivere» non riceve risposta e i suoi file non vengono scaricati.

WhatsApp consente risposte libere solo entro 24 ore dall'ultimo messaggio della persona. Un task programmato o un brief che arriva più tardi viene rifiutato da Meta: l'errore finisce nel log («fuori dalla finestra di 24 ore»). Per i messaggi proattivi oltre la finestra servono i template approvati da Meta, che Annie non usa ancora.

## 7. Connettori MCP

Pagina Connettori (owner): un server MCP via HTTP (URL) o locale (comando). Un header o una variabile segreta viene salvata nel secret store del tenant e non è più visibile. Annie riapre l'istanza e mostra quanti tool ha trovato. Un connettore raggiunge solo il suo host, e solo finché è consentito nella egress policy (casella «Consenti»). I connettori locali sono processi sul server di Annie: solo comandi di cui ti fidi.

## 8. Backup e ripristino

Tutto lo stato è nella cartella dati (`/data` nel container, `data/` senza Docker): istanze, conversazioni (SQLite), outbox, pratiche, file, task, persone, segreti, audit.

Backup coerente (pochi secondi di fermo):

```bash
docker compose stop annie
docker run --rm -v annie_annie-data:/data -v "$PWD":/backup busybox tar czf /backup/annie-$(date +%F).tgz -C /data .
docker compose start annie
```

Ripristino: ferma Annie, svuota il volume, estrai l'archivio nel volume, riavvia. Gli archivi contengono `secrets.json` in chiaro: conservali cifrati.

## 9. Aggiornare

```bash
git pull
docker compose up -d --build
```

Le risposte rimaste a metà ripartono dall'outbox; quelle che potrebbero arrivare due volte su Telegram sono segnalate come possibile doppione.

## 10. Ruotare i segreti

- **Chiave del modello, Gmail, HubSpot, token Telegram**: cambia `.env` e riavvia (i valori vengono riscritti nel secret store all'avvio).
- **Segreti dei connettori**: pagina Connettori → Modifica → nuovo valore.
- **Link di una persona**: `pnpm annie person link <id>` o Persone → Nuovo link.
- **Link dell'owner perso**: `pnpm annie person list` per l'ID, poi `pnpm annie person link <id>`.

## 11. Problemi comuni

| Sintomo | Causa probabile |
|---|---|
| `Instance ... is already open in another process` | Due copie di Annie sulla stessa cartella dati. Fermane una. |
| Il bot non risponde | L'utente non è in `ANNIE_TELEGRAM_ALLOWED_USERS`, o non ha premuto Start. Controlla l'audit (Attività). |
| La segreteria non legge la posta | Refresh token Gmail scaduto (`invalid_grant` nei log): rigenera il token. |
| `does not allow connector "hubspot"` all'avvio | La egress policy dell'istanza è stata ristretta: Annie non la allarga da sola. Correggi `instance.json` o usa un'altra istanza. |
| Le risposte web arrivano solo ricaricando | Il proxy bufferizza `/api/events`: disattiva il buffering. |
| Annie ha smesso di usare il modello | Tetto di spesa giornaliero raggiunto (Attività e spesa). Riprende il giorno dopo. |
