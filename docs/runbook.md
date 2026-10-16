# Runbook: installare e gestire Annie

Per chi installa Annie presso un cliente (owner). Un'installazione = un tenant = un container. Vocabolario in [`GLOSSARY.md`](../GLOSSARY.md).

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
