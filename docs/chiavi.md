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

## Domini da consentire nella sessione cloud

| Servizio | Domini |
|---|---|
| Modello | `api.anthropic.com` |
| Telegram | `api.telegram.org` |
| Gmail (segreteria) | `gmail.googleapis.com`, `oauth2.googleapis.com` |
| HubSpot | `api.hubapi.com` |
| Google per persona | `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com` |
| Railway | `backboard.railway.com`, `docs.railway.com` |

## Cosa succede dopo

In una sessione nuova con le chiavi, il primo comando è `pnpm annie check`. Prova ogni servizio configurato e dice cosa correggere, senza stampare segreti. Poi vengono la prova dal vivo di Telegram, della segreteria (una mail vera fino alla bozza approvata) e di Google, e lo spike Railway con le misure di risveglio e di costo.
