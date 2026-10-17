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

## 6b. Google per persona (Gmail e Calendar; scrittura con approvazione)

Ogni persona collega il proprio account Google dal menu del suo account nella console; Annie lo usa solo nelle conversazioni di quella persona dalla console e nel suo brief del mattino. Per attivarlo:

1. In Google Cloud console crea un client OAuth di tipo «Applicazione web» e aggiungi come URI di reindirizzamento `ANNIE_PUBLIC_URL/oauth/google/callback` (in locale `http://localhost:8080/oauth/google/callback`).
2. Abilita Gmail API e Google Calendar API nel progetto.
3. In `.env`: `ANNIE_GOOGLE_CLIENT_ID`, `ANNIE_GOOGLE_CLIENT_SECRET` e, se serve, `ANNIE_GOOGLE_SERVICES` (`gmail,calendar`, il default, oppure uno dei due). Riavvia.
4. In Impostazioni l'owner attiva «Consenti Google a questa istanza».
5. Facoltativo: `ANNIE_GOOGLE_WRITE=1` perché Annie prepari mail, risposte, bozze ed eventi. Ognuno succede solo quando la persona di cui è l'account lo approva, dalla card in chat o in Approvazioni ([ADR 0021](adr/0021-google-scrivere-con-approvazione.md)). Chi aveva già collegato Google lo ricollega dal menu del suo account. Nell'audit: `google_action.*`, senza indirizzi né testi. Una richiesta con «esito incerto» (Google non ha risposto, o Annie si è riavviata a metà) non si ripete: la persona controlla in Gmail o nel calendario.

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

Il computer delle istanze, in Annie Cloud, gira su Fly: vedi 6j, «Su Fly».

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

Lo stesso Chromium fa da browser con clic (`web_browse`, `web_click`, `web_type`, ADR 0014): niente da configurare in più, e «screenshots off» vuol dire anche browser spento. Il browser legge e basta: le richieste non GET non partono, per inviare c'è `web_submit` con approvazione. Al più 4 sessioni per server, una per conversazione, chiuse dopo 5 minuti senza azioni e perse al riavvio; ogni pagina ha un tetto di 400 richieste e 40 MB. Chromium parte senza DNS proprio (`--host-resolver-rules`) e con WebRTC limitato al proxy, che non esiste: ogni richiesta passa dal fetch controllato.

Con `ANNIE_SEARCH_API_KEY` (Brave Search, [chiavi.md](chiavi.md) punto 13) le istanze possono anche cercare (`web_search`, ADR 0017). L'owner lo consente istanza per istanza in Impostazioni → Ricerca sul web (connettore `web_search` nella egress policy, cambio registrato nell'audit). Al servizio vanno solo le parole cercate, con paese e lingua (`ANNIE_SEARCH_COUNTRY`, `ANNIE_SEARCH_LANG`, Italia e italiano di default); nell'audit c'è `web_search.ran` con il numero di risultati, mai la ricerca. Le pagine trovate si aprono solo dai siti consentiti: la stessa scheda ha un pulsante, con conferma, per consentirli tutti. Ogni account fa al più `ANNIE_SEARCH_MAX_PER_DAY` ricerche al giorno (200 di default, contate dal processo: un riavvio azzera il conto del giorno), poi Annie risponde con quello che sa e lo dice. Il costo delle ricerche non entra nel tetto di spesa del modello: si controlla sulla dashboard di Brave. `pnpm annie check` prova la chiave.

Le sentinelle (`watch_*`, ADR 0018) non chiedono niente all'operatore: leggono con lo stesso fetch controllato, dai siti consentiti dell'istanza riletti a ogni controllo, e girano nel passaggio dello scheduler (ogni 30 secondi, al più 20 pagine per passaggio, 4 alla volta, 10 secondi per pagina). Ogni istanza ne ha al più 20, una ogni 30 minuti al più spesso. Il modello lavora solo quando una sentinella ha qualcosa da dire; nell'audit ci sono `watch.created`, `watch.deleted` e `watch.fired` con ID e sito, mai il testo della pagina. Dopo 6 controlli falliti di fila, o 8 messaggi in 24 ore, una sentinella si ferma e lo scrive nella sua conversazione; le persone la vedono, la riattivano e la cancellano in «Task e sentinelle». Se una sentinella non avvisa: guardare lì l'ultimo errore (sito non consentito, pagina che non risponde, frase che non c'è più); se la persona non può più scrivere all'istanza o il canale è stato tolto, la sentinella si ferma senza scrivere.

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

WhatsApp consente risposte libere solo entro 24 ore dall'ultimo messaggio della persona. Annie ricorda quando ognuna delle persone ammesse ha scritto l'ultima volta (`whatsapp-window.json` nella cartella dell'istanza), dall'ora del messaggio e non da quella in cui Meta lo consegna. Un messaggio che parte più tardi, per esempio un brief o un promemoria, viene tenuto da parte (una volta sola, anche se l'invio viene ritentato) e consegnato appena la persona scrive; esce dall'attesa solo dopo essere partito. Se in Impostazioni → WhatsApp c'è un template approvato da Meta, con una variabile `{{1}}` nel corpo, Annie lo manda con un estratto del primo messaggio: uno solo per finestra chiusa, perché Meta fa pagare ogni template. Nel registro un messaggio messo in attesa risulta consegnato: se ne restano più di 20 per persona, i più vecchi si perdono e il log lo dice. I file non possono aspettare: fuori finestra vengono rifiutati. Per chi non ha ancora scritto da quando c'è questa versione la finestra non è nota: il messaggio parte, e se Meta lo rifiuta più tardi il motivo finisce nel log («not delivered: outside the 24-hour window»).

I messaggi passano dai server di Meta, che li conserva secondo le sue regole: per i dati in Unione Europea va verificata l'opzione di archiviazione locale della Cloud API e va indicato Meta nell'informativa.

## 6h. Messaggi vocali

Con `ANNIE_TRANSCRIBE_URL` e `ANNIE_TRANSCRIBE_API_KEY` i vocali di Telegram e WhatsApp possono essere trascritti e arrivare ad Annie come testo, marcati «[Messaggio vocale, trascritto]». L'owner lo consente istanza per istanza in Impostazioni → Messaggi vocali (connettore `voice` nella egress policy, cambio registrato nell'audit); finché non lo fa, l'audio non esce e Annie chiede di scrivere. Il servizio deve avere la stessa API di OpenAI (`/audio/transcriptions`); il consigliato è Mistral, con server in UE ([chiavi.md](chiavi.md), punto 10). L'audio va solo a quel servizio, e solo per le persone che possono scrivere: il vocale di un estraneo non viene nemmeno scaricato. Su Telegram i vocali più lunghi di `ANNIE_TRANSCRIBE_MAX_SECONDS` (300 di default) non vengono nemmeno scaricati; WhatsApp non dice la durata, quindi lì vale solo il limite di 20 MB del download. Un vocale troppo grande arriva come nota, non si perde. Se il servizio non risponde, Annie riceve una nota e chiede di riprovare o di scrivere. `pnpm annie check` controlla chiave e modello. Il costo della trascrizione non entra nel tetto di spesa del modello: si controlla sulla console del servizio.

## 6i. Telefono

Ogni istanza può avere un numero Twilio, collegato dall'owner in Impostazioni → Telefono con Account SID, auth token e numero ([chiavi.md](chiavi.md), punto 11). Annie imposta da sola l'indirizzo delle chiamate del numero su `/hooks/phone/<istanza>`, quindi serve `ANNIE_PUBLIC_URL` in https; in Annie Cloud il control plane inoltra la chiamata alla cella e la sveglia. Twilio firma ogni richiesta con l'auth token (`X-Twilio-Signature`): senza firma valida, 403. Una chiamata da un numero che non è in «Chi può chiamare» viene rifiutata prima di rispondere. Poiché il numero di chi chiama si può falsificare, all'inizio di ogni chiamata si digita il codice scelto dall'owner; tre codici sbagliati chiudono la chiamata e finiscono nel log.

Una chiamata è a turni: Twilio trascrive la frase, Annie risponde, Twilio la legge. La cella aspetta la risposta fino a 8 secondi per richiesta e, se serve di più, fa dire «un momento»; dopo sei attese la chiamata si chiude e la risposta resta da parte (`phone-pending.json` nella cartella dell'istanza, al massimo 5 per numero e per 7 giorni), detta all'inizio della chiamata dopo. Le schede di approvazione e i file non passano dal telefono: arrivano sugli altri canali o nella console. Al telefono Annie non crea task programmati. Scollegare il numero cancella le credenziali e le risposte in attesa; l'indirizzo delle chiamate resta impostato su Twilio, e la cella rifiuta quelle chiamate senza rispondere. A ogni avvio Annie reimposta l'indirizzo delle chiamate, quindi dopo un cambio di `ANNIE_PUBLIC_URL` basta riavviare. Riavviare la cella mentre una chiamata è in corso la fa cadere; la risposta non si perde.

La voce passa da Twilio, che fa riconoscimento e sintesi: per i dati in UE scegli la regione Irlanda (`ANNIE_TWILIO_API`) e indica Twilio nell'informativa. Il costo delle chiamate lo fattura Twilio e non entra nel tetto di spesa del modello.

## 6j. Il computer delle istanze

Annie può eseguire comandi (Python, `jq`, `sqlite3`, `pandoc`, gli strumenti PDF) in un computer suo, un container per istanza senza rete ([ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md)). Serve Docker 20.10 o più recente sullo stesso server.

**Prima di accenderlo: il socket di Docker equivale a root sul server.** Chi lo usa può creare un container che monta tutto il disco. Accendilo solo dove Annie è l'unico servizio della macchina, e mai in Annie Cloud: lì il computer gira solo su Fly (sotto, «Su Fly»).

1. Costruisci l'immagine: `docker build -f docker/computer.Dockerfile -t annie-computer:latest docker`. Va rifatta quando cambia il Dockerfile; al comando dopo, ogni computer viene ricreato con la nuova immagine e i suoi file restano.
2. In `.env`: `ANNIE_COMPUTER=docker`. Le altre variabili hanno valori di default: `ANNIE_COMPUTER_IMAGE` (`annie-computer:latest`), `ANNIE_DOCKER_SOCKET` (`/var/run/docker.sock`), `ANNIE_COMPUTER_MEMORY_MB` (1024), `ANNIE_COMPUTER_CPUS` (1), `ANNIE_COMPUTER_DISK_MB` (2048, la quota di `/work`), `ANNIE_COMPUTER_RUNTIME` (vuoto; `runsc` per gVisor).
3. Con Docker Compose, scommenta in `docker-compose.yml` il socket e `group_add`, con `DOCKER_GID` uguale al gruppo del socket (`stat -c %g /var/run/docker.sock`). Senza Compose, il processo di Annie deve poter leggere e scrivere il socket.
4. `pnpm annie check` dice se Docker risponde e se l'immagine c'è; lo stesso controllo compare nella console (Impostazioni, Computer) e nel log all'avvio.
5. L'owner accende il computer istanza per istanza (Impostazioni, Computer).

Come gira: un container per istanza con rete `none`, file system in sola lettura tranne `/work` (un volume `annie-computer-<hash>`) e `/tmp` (256 MB in memoria), nessuna capability, niente escalation di privilegi, 128 processi, nessun file oltre 1 GB. I comandi girano come uid 1000 e il container come nobody: alla fine di ogni comando tutto quello che il comando ha lasciato acceso viene chiuso. Al massimo 8 computer accesi e 4 comandi alla volta; un computer senza comandi per 10 minuti si ferma. Quando `/work` supera la quota, Annie lo legge nel risultato, i nuovi file restano minuscoli finché non ne cancella e non si copiano altri file dentro. All'avvio Annie ferma i computer rimasti accesi da un avvio precedente: un solo Annie per server Docker, perché due installazioni sullo stesso Docker si fermerebbero i computer a vicenda.

**gVisor** dà al computer un kernel suo invece di quello del server: installa `runsc` ([gvisor.dev](https://gvisor.dev/docs/user_guide/install/)), registralo in `/etc/docker/daemon.json` e imposta `ANNIE_COMPUTER_RUNTIME=runsc`. Consigliato se più persone di fiducia diversa usano la stessa installazione.

**Disco**: i volumi dei computer stanno nella cartella dati di Docker (`/var/lib/docker`). Meglio metterla su una partizione sua, così un computer pieno non ferma il server. `docker system df -v` mostra quanto occupa ogni volume `annie-computer-*`; «Azzera i file del computer» nella console cancella container e volume di un'istanza. I file dei computer non sono nel backup della cartella dati: quello che conta Annie lo copia nel workspace.

**Immagine personalizzata**: si può partire da `docker/computer.Dockerfile` e aggiungere strumenti, purché restino l'utente 1000, `/work` suo, `sh`, `timeout`, `du` e `chmod`. Poi `ANNIE_COMPUTER_IMAGE` con il nuovo nome. `copy_out` legge i file attraverso Docker, non dentro il computer: un collegamento simbolico o una cartella vengono rifiutati.

### Su Fly (micro-VM, anche per Annie Cloud)

Una micro-VM Fly.io per istanza, con un kernel suo, sigillata dal primo processo prima di ogni comando ([ADR 0015](adr/0015-computer-su-micro-vm.md)). Non serve Docker sul server.

1. L'immagine: il workflow `Image` pubblica a ogni merge su `main` `ghcr.io/<owner>/annie-computer:fly` (e `:fly-<commit>`), il target `fly` di `docker/computer.Dockerfile`. Rendi pubblico il pacchetto GHCR, o copia l'immagine nel registry di Fly (`registry.fly.io/<app>`). Meglio indicare il tag con il commit: ogni computer passa alla nuova immagine al comando dopo, con i suoi file.
2. Il token dell'organizzazione ([chiavi](chiavi.md) §12).
3. Su un server proprio, in `.env`: `ANNIE_COMPUTER=fly`, `FLY_API_TOKEN`, `ANNIE_FLY_ORG`, `ANNIE_COMPUTER_IMAGE`. Facoltativi: `ANNIE_FLY_REGION` (`fra`), `ANNIE_COMPUTER_MEMORY_MB` (1024, a passi di 256 e al più 2048 per CPU), `ANNIE_COMPUTER_CPUS` (1, intero fino a 8), `ANNIE_COMPUTER_DISK_MB` (2048, il volume si arrotonda al gigabyte), `ANNIE_COMPUTER_MAX_RUNNING` (8 comandi alla volta), `ANNIE_FLY_APP_PREFIX` (solo se Fly dice che il nome è preso).
4. `pnpm annie check` dice se Fly accetta il token; lo stesso nella console e nel log all'avvio.

Un computer senza comandi per 10 minuti si ferma da solo e costa solo il volume; al comando dopo riparte (un primo avvio, con il download dell'immagine, può chiedere un minuto). «Azzera i file del computer» cancella la app Fly con macchina e volume. Le app si chiamano `annie-computer-<hash>`; `fly apps list -o <org>` le mostra. I volumi di Fly non sono nel backup di Annie.

**In Annie Cloud** il token sta solo nel control plane:

1. Nel `.env` del control plane: `ANNIE_CLOUD_COMPUTER=fly` più le variabili del punto 3 (senza `ANNIE_COMPUTER`). `ANNIE_CLOUD_COMPUTER_URL` è l'indirizzo del control plane come lo raggiungono le celle; di default `https://<dominio>`. Con le celle su Railway serve l'indirizzo pubblico del control plane.
2. Il reverse proxy deve passare al control plane `/internal/computer/` con richieste fino a 100 MB (con nginx `client_max_body_size 100m` su quel percorso) e risposte fino a 25 secondi.
3. Le celle esistenti ricevono `ANNIE_COMPUTER=cloud` con `pnpm cloud upgrade` (control plane fermo); quelle nuove lo hanno da sole.
4. Per spegnerlo: togli `ANNIE_CLOUD_COMPUTER` e rifai `pnpm cloud upgrade`; le celle lo vedono spento nella console.

Tetti per tenant: 2 comandi alla volta, 10 computer, una copia di file alla volta. `pnpm cloud computers` elenca i computer di ogni tenant con la sua app Fly; `pnpm cloud computers delete <tenant>` li cancella, macchine e file, quando un account se ne va.

## 6k. La console come app

- **Installare**: serve l'indirizzo https della console (`ANNIE_PUBLIC_URL`); su http i browser non la installano, e la console funziona lo stesso nella scheda. Su iPhone e iPad: Safari, Condividi, «Aggiungi alla schermata Home».
- **Entrare nell'app su iPhone**: l'app ha una sessione sua, separata da Safari. Chi tocca il link in una mail entra in Safari; nell'app incolla il link nella schermata di accesso («Hai il link ma sei nell'app?»).
- **Cosa resta sul telefono**: solo la shell (pagina, script, stile, font, icone), mai `/api`, file o conversazioni. Il service worker chiede sempre prima alla rete, quindi un aggiornamento arriva al primo avvio online.
- **Il proxy** non deve tenere in cache `/sw.js` né `/manifest.webmanifest` (Annie li manda con `no-cache`). Dopo aver cambiato l'elenco dei file della shell in `sw.js`, cambia il nome `CACHE` lì dentro.
- **«Primi passi» spariti**: Impostazioni → Primi passi, oppure `#/inizia`. Il «Nascondi» vale per istanza e per browser (chiave `annie.setup.hidden` nel localStorage).

## 6l. Immagini

Con `ANNIE_IMAGE_URL` e `ANNIE_IMAGE_API_KEY` ([chiavi.md](chiavi.md), punto 15) Annie crea e ritocca immagini quando gliele chiedono. L'owner lo consente istanza per istanza in Impostazioni → Immagini (connettore `image_generation`, cambio registrato nell'audit come `images.allowed`). Le immagini vanno in `immagini/` del workspace e in chat: nella console si vedono nel messaggio, su Telegram e WhatsApp arrivano come foto (o come documento, se l'app non le prende come foto). `ANNIE_IMAGE_MAX_PER_DAY` (100) conta le immagini fatte per account, nel processo: un riavvio azzera il conto del giorno. L'audit registra `image.generated` con il numero di immagini e se era un ritocco, mai la descrizione. Il costo non entra nel tetto di spesa del modello: si controlla sulla console del servizio. Un errore «rifiuta la chiave» vuol dire chiave sbagliata o organizzazione non verificata da OpenAI.

## 7. Connettori MCP

Pagina Connettori (owner): un server MCP via HTTP (URL) o locale (comando). Un header o una variabile segreta viene salvata nel secret store del tenant e non è più visibile. Annie riapre l'istanza e mostra quanti tool ha trovato. Un connettore raggiunge solo il suo host, e solo finché è consentito nella egress policy (casella «Consenti»). I connettori locali sono processi sul server di Annie: solo comandi di cui ti fidi.

In un clic (settimana 29, ADR 0024): sotto i connettori c'è la galleria dei servizi noti. «Accedi e aggiungi» porta l'owner sulla pagina del servizio e lo riporta a `ANNIE_PUBLIC_URL/oauth/mcp/callback`: senza un indirizzo https molti servizi rifiutano. I token stanno nel secret store (`mcp-oauth.<istanza>.<connettore>`, o `connector.<connettore>.<istanza>.authorization` per i token incollati) e si rinnovano da soli; quando il servizio rifiuta il rinnovo il connettore mostra «Da collegare» e basta premere «Collega». Un accesso in corso si perde a un riavvio. Audit: `connector.authorized`, `connector.sign_in_cancelled`, `connector.removed`.

Azioni con approvazione (settimana 30, ADR 0025): gli strumenti che il servizio non indica come di sola lettura aspettano un «Approva» in Approvazioni, sopra la chat web o sulla card di Telegram e WhatsApp. Le richieste stanno in `connector-actions/` dell'istanza, scadono in 24 ore e al massimo 20 restano in attesa. Una richiesta rimasta «in corso» per un riavvio diventa «esito incerto» all'avvio: controlla sul servizio prima di chiederla di nuovo. Per un servizio di cui ti fidi del tutto, Modifica → togli «Chiedi l'approvazione…». Audit: `connector_action.*`, mai argomenti o risposte.

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
- **Auth token di Twilio**: dopo averlo ruotato su Twilio, Impostazioni → Telefono → nuovo auth token → Salva. Fino ad allora le chiamate ricevono 403.
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
| La console dice «Non riesco a raggiungere Annie» | Il server non risponde (riavvio, cella che si sveglia): riprova da sola ogni 10 secondi. Se resta, guarda i log del server. |
| Annie ha smesso di usare il modello | Tetto di spesa giornaliero raggiunto (Attività e spesa). Riprende il giorno dopo. |
