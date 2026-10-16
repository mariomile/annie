# Chiavi e accessi: dove prenderli, dove metterli

Questa guida serve a dare ad Annie quello che le manca per la prova dal vivo e per Annie Cloud. Le chiavi non si incollano mai in una chat, in un'issue o in un commit: vanno solo nei posti indicati qui.

## Dove si inseriscono

**Nella sessione cloud di Claude Code** (per far fare a Claude la prova dal vivo):

1. Apri la sessione su claude.ai/code e clicca il nome dell'ambiente cloud nella barra del titolo, poi **Edit**.
2. Ogni chiave va in **Network secrets** (nelle app non aggiornate si chiama **API credentials**). Se quella sezione non c'è, aggiungila come **variabile d'ambiente**. Il nome è quello indicato qui sotto, per esempio `ANTHROPIC_API_KEY`.
3. In **Network access** scegli il livello **Limited**. Sotto **Allowed domains** aggiungi i domini della tabella in fondo e lascia spuntato *Allow package managers*. Nelle app non aggiornate la voce si chiama **Custom**. Istruzioni ufficiali: https://code.claude.com/docs/en/cloud-environments#network-access
4. Apri una **nuova sessione**: le chiavi entrano solo nelle sessioni nuove.

**Su un server tuo** (self-host o control plane di Annie Cloud): nel file `.env` accanto al codice, con i nomi di [`.env.example`](../.env.example). Il file non va mai su git, perché è già escluso.

**In GitHub Actions** (solo per il giudice notturno): repository → Settings → Secrets and variables → Actions → New repository secret.

## Le chiavi, in ordine di priorità

### 1. Modello: `ANTHROPIC_API_KEY` (indispensabile)

1. Vai su https://console.anthropic.com (può rimandarti alla nuova console della piattaforma) ed entra con l'account di Buildrs.
2. **Settings → API Keys → Create Key**, nome `annie-dev`.
3. Copia la chiave, che inizia con `sk-ant-`, e salvala come `ANTHROPIC_API_KEY`.
4. Consigliato: in **Settings → Limits** metti un tetto di spesa mensile, per esempio 50 dollari. Annie ha anche il suo tetto giornaliero.
5. Dominio da consentire: `api.anthropic.com`.

### 2. Telegram: `TELEGRAM_BOT_TOKEN` e gli ID delle persone

1. Su Telegram apri **@BotFather** → `/newbot` → scegli nome e username (deve finire in `bot`).
2. BotFather ti dà il token, nella forma `123456789:AA…`: va in `TELEGRAM_BOT_TOKEN`.
3. Il tuo ID numerico: scrivi a **@userinfobot**, che ti risponde con `Id: 123456789`.
4. `ANNIE_TELEGRAM_ALLOWED_USERS` = gli ID di chi può scrivere ad Annie, separati da virgola. `ANNIE_TELEGRAM_APPROVERS` = chi approva gli strumenti proposti (di solito il tuo ID).
5. Apri il bot e premi **Start**: senza, Telegram non lascia scrivere il bot a te.
6. Dominio: `api.telegram.org`.

In alternativa il bot si collega anche dalla console: Impostazioni → Telegram.

### 3. Segreteria commerciale: secondo bot, Gmail, HubSpot

**Secondo bot Telegram**: rifai i passi 1-2 del punto 2 con un altro bot. Il token va in `ANNIE_SEGRETERIA_TELEGRAM_BOT_TOKEN`. Gli ID dei commerciali vanno in `ANNIE_SEGRETERIA_SALES`.

**Gmail della casella commerciale** (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`):

1. https://console.cloud.google.com → crea un progetto, per esempio `annie`.
2. **APIs & Services → Library** → abilita **Gmail API**.
3. **OAuth consent screen**: tipo *External*, stato *Testing*. Aggiungi la casella commerciale tra i *Test users*.
4. **Credentials → Create credentials → OAuth client ID**:
   - tipo *Web application*;
   - redirect URI: `https://developers.google.com/oauthplayground`.
   
   Client ID e secret vanno in `GMAIL_CLIENT_ID` e `GMAIL_CLIENT_SECRET`.
5. Apri https://developers.google.com/oauthplayground e ottieni il refresh token:
   - ingranaggio in alto a destra → *Use your own OAuth credentials*, poi incolla client ID e secret;
   - nel campo degli scope scrivi `https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send` → *Authorize APIs* → entra con la casella commerciale;
   - *Exchange authorization code for tokens* → copia il **Refresh token** in `GMAIL_REFRESH_TOKEN`.
6. Attenzione: con l'app in *Testing* il refresh token scade dopo 7 giorni. Per l'uso vero l'app va pubblicata (vedi il punto 4).
7. Domini: `gmail.googleapis.com`, `oauth2.googleapis.com`.

**HubSpot** (`HUBSPOT_ACCESS_TOKEN`):

1. In HubSpot: icona impostazioni → **Integrazioni → App private**. Nei portali recenti la voce è **Sviluppo → App legacy → Crea app privata**.
2. Nome `Annie`. Nella scheda *Scopes* spunta `crm.objects.contacts.read` e `crm.objects.contacts.write`.
3. Crea l'app e copia l'**Access token** in `HUBSPOT_ACCESS_TOKEN`.
4. Dominio: `api.hubapi.com`.

### 4. Google per persona: `ANNIE_GOOGLE_CLIENT_ID`, `ANNIE_GOOGLE_CLIENT_SECRET`

Serve perché ognuno colleghi il proprio Gmail e Calendar dalla console, in sola lettura.

1. Nello stesso progetto Google Cloud abilita anche **Google Calendar API**.
2. **Credentials → Create credentials → OAuth client ID**, tipo *Web application*. Redirect URI:
   - in locale: `http://localhost:8080/oauth/google/callback`;
   - su un server: `https://<tuo-dominio>/oauth/google/callback`;
   - in Annie Cloud: `https://<dominio-del-control-plane>/oauth/google/callback`.
3. Client ID e secret vanno in `ANNIE_GOOGLE_CLIENT_ID` e `ANNIE_GOOGLE_CLIENT_SECRET`. Facoltativo: `ANNIE_GOOGLE_SERVICES` (`gmail,calendar`, oppure `calendar` da solo).
4. Pubblicazione dell'app (**OAuth consent screen → Publish app**):
   - `calendar.readonly` richiede una verifica di pochi giorni;
   - `gmail.readonly` richiede una valutazione di sicurezza annuale da un assessor approvato da Google. Va chiesto un preventivo.
5. Domini: `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com`.

### 5. Annie Cloud su Railway: `RAILWAY_API_TOKEN`

1. https://railway.com → **Account Settings → Tokens** → crea un token di account (o di workspace) e salvalo come `RAILWAY_API_TOKEN`.
2. Rendi pubblica l'immagine di Annie, che la CI pubblica su GHCR (privata di default):
   - vai su https://github.com/mariomile?tab=packages → `annie` → **Package settings**;
   - **Change visibility → Public**.
   
   In alternativa, dai a Railway le credenziali del registry.
3. Sul control plane: `ANNIE_CLOUD_PROVIDER=railway`, `ANNIE_CLOUD_RAILWAY_IMAGE=ghcr.io/mariomile/annie:latest`.
4. Dominio: `backboard.railway.com` (e `docs.railway.com`, utile per verificare le API).

### 6. Email dei link di accesso: `ANNIE_CLOUD_SMTP_URL`

1. Scegli un servizio con server in UE: Brevo, Mailjet o un altro SMTP europeo. Verifica il dominio mittente (record SPF e DKIM che ti indica il servizio).
2. Prendi le credenziali SMTP e componi `ANNIE_CLOUD_SMTP_URL=smtps://UTENTE:PASSWORD@HOST:465`. Usa `smtp://…:587` se il servizio offre solo STARTTLS. I caratteri speciali della password vanno scritti in forma URL: `@` diventa `%40`.
3. `ANNIE_CLOUD_MAIL_FROM=Annie <accesso@tuodominio.it>`.

### 7. Giudice notturno (facoltativo): `ANNIE_JUDGE_MODEL_KEY`

Una chiave Anthropic separata, magari con un suo tetto di spesa. Va come secret di GitHub Actions (vedi sopra), non nella sessione.

### 8. Abbonamenti: `ANNIE_CLOUD_STRIPE_SECRET_KEY` e i prezzi

Servono solo quando decidi il prezzo di Annie Cloud. Senza, il servizio resta gratuito.

1. https://dashboard.stripe.com → crea l'account di Buildrs e lascia attiva la **modalità test** per le prove.
2. **Developers → API keys → Secret key** (`sk_test_…`, poi `sk_live_…`): va in `ANNIE_CLOUD_STRIPE_SECRET_KEY`. Meglio ancora una **restricted key** con scrittura su Checkout Sessions, Customer portal e Billing meter events, e lettura sulle Subscriptions.
3. **Product catalog → Add product** «Annie», con un prezzo mensile ricorrente. Il suo id (`price_…`) va in `ANNIE_CLOUD_STRIPE_PRICE`.
4. Facoltativo, il consumo del modello: **Billing → Meters → Create meter** con aggregazione *Sum*. Il nome dell'evento, per esempio `annie_model_cost`, va in `ANNIE_CLOUD_STRIPE_METER_EVENT`. Poi aggiungi al prodotto un prezzo a consumo collegato a quel contatore e metti il suo id in `ANNIE_CLOUD_STRIPE_USAGE_PRICE`. Un'unità è un centesimo di dollaro di costo del modello.
5. **Developers → Webhooks → Add endpoint**: `https://<dominio-del-control-plane>/stripe/webhook`, con gli eventi `checkout.session.completed` e `customer.subscription.created`, `.updated`, `.deleted`. Il **Signing secret** (`whsec_…`) va in `ANNIE_CLOUD_STRIPE_WEBHOOK_SECRET`.
6. **Settings → Billing → Customer portal**: attivalo, così ognuno vede le fatture, cambia carta e disdice da solo.
7. Facoltativo: `ANNIE_CLOUD_TRIAL_DAYS`, i giorni di prova (14 se non lo metti).
8. Dominio: `api.stripe.com`.

### 9. WhatsApp: token, ID del numero e app secret (per istanza, dalla console)

Annie risponde su un numero WhatsApp Business attraverso la Cloud API di Meta. I tre valori si inseriscono nella console, in Impostazioni → WhatsApp, non nel file `.env`. Serve un indirizzo https pubblico, perché Meta manda i messaggi a un webhook: in Annie Cloud c'è già, in self-host è `ANNIE_PUBLIC_URL`.

1. https://developers.facebook.com → **My Apps → Create app**, tipo *Business*, e aggiungi il prodotto **WhatsApp**. Collega o crea il **Business portfolio** di Buildrs.
2. In **WhatsApp → API Setup** aggiungi il numero di telefono (un numero non già usato sull'app WhatsApp) e verificalo. Copia il **Phone number ID**: è il campo «ID del numero».
3. Token permanente: in https://business.facebook.com → **Impostazioni → Utenti di sistema** crea un utente di sistema *Admin*. Assegnagli l'app e il WhatsApp Business Account, poi **Genera token** con i permessi `whatsapp_business_messaging` e `whatsapp_business_management`. È il campo «Token di accesso». Il token temporaneo di API Setup dura 24 ore: va bene solo per una prova.
4. **App settings → Basic → App secret** → *Show*: è il campo «App secret».
5. Nella console premi **Collega**. Annie mostra l'indirizzo del webhook e un token di verifica.
6. Di nuovo su developers.facebook.com, in **WhatsApp → Configuration → Webhook → Edit**, incolla indirizzo e token di verifica, poi **Verify and save**. Sotto *Webhook fields* iscriviti a **messages**.
7. In «Chi può scrivere» metti i numeri delle persone con il prefisso, solo cifre (per esempio `393331234567`).
   Se i messaggi non arrivano con un numero vero (non quello di test), l'app va iscritta anche al WhatsApp Business Account: da Graph API Explorer, con il token dell'utente di sistema, `POST /<WABA_ID>/subscribed_apps`.
8. Facoltativo, per i messaggi oltre le 24 ore: in **WhatsApp Manager → Modelli di messaggio → Crea modello**, categoria *Utilità*, lingua italiano. Nel corpo metti una variabile, per esempio «Ciao, ho un aggiornamento per te: {{1}}. Rispondi a questo messaggio per leggerlo tutto.» Quando Meta lo approva, scrivi nome e lingua (`it`) nella scheda WhatsApp della console.
9. Per uscire dalla modalità sviluppo l'app va pubblicata (**App Review** per `whatsapp_business_messaging`) e serve un metodo di pagamento sul Business Account: Meta fa pagare le conversazioni secondo il suo listino.
10. Domini: `graph.facebook.com` (e `lookaside.fbsbx.com` per scaricare i file che le persone mandano).

### 10. Messaggi vocali: `ANNIE_TRANSCRIBE_URL` e `ANNIE_TRANSCRIBE_API_KEY`

Senza queste variabili Annie riceve i vocali ma non li capisce, e chiede di scrivere. Consiglio Mistral, che ha i server in Unione Europea.

1. https://console.mistral.ai → entra con l'account di Buildrs → **Billing**: aggiungi un metodo di pagamento. La trascrizione costa pochi millesimi di dollaro al minuto: controlla il listino aggiornato su https://mistral.ai/pricing.
2. **API Keys → Create new key**, nome `annie-voce`. La chiave va in `ANNIE_TRANSCRIBE_API_KEY`.
3. `ANNIE_TRANSCRIBE_URL=https://api.mistral.ai/v1`. Il modello è `voxtral-mini-latest` se non indichi altro in `ANNIE_TRANSCRIBE_MODEL`.
4. Facoltativo: `ANNIE_TRANSCRIBE_MAX_SECONDS`, la durata massima di un vocale (300 secondi se non lo metti).
5. In Annie Cloud basta metterle sul control plane: passano a tutte le celle.
6. Poi, in ogni istanza che deve capire i vocali: Impostazioni → **Messaggi vocali** → spunta «Trascrivi i vocali di questa istanza».
7. Dominio: `api.mistral.ai`.

In alternativa va bene qualunque servizio con la stessa API di OpenAI: per OpenAI `ANNIE_TRANSCRIBE_URL=https://api.openai.com/v1` (modello `whisper-1`).

## Domini da consentire nella sessione cloud

| Servizio | Domini |
|---|---|
| Modello | `api.anthropic.com` |
| Telegram | `api.telegram.org` |
| Gmail (segreteria) | `gmail.googleapis.com`, `oauth2.googleapis.com` |
| HubSpot | `api.hubapi.com` |
| Google per persona | `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com` |
| Railway | `backboard.railway.com`, `docs.railway.com` |
| Stripe | `api.stripe.com` |
| WhatsApp | `graph.facebook.com`, `lookaside.fbsbx.com` |
| Vocali | `api.mistral.ai` (o il servizio scelto) |

## Cosa succede dopo

In una sessione nuova con le chiavi, il primo comando è `pnpm annie check`. Prova ogni servizio configurato e dice cosa correggere, senza stampare segreti. Poi vengono la prova dal vivo di Telegram, della segreteria (una mail vera fino alla bozza approvata) e di Google, e lo spike Railway con le misure di risveglio e di costo.
