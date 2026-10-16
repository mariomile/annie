# Settimana 9: Annie Cloud su Railway

Branch `week-9`. Mario ha chiesto se Railway va bene per le celle. Questa settimana porta un provider Railway pronto da provare, e l'immagine di Annie costruita e pubblicata dalla CI.

## Cosa c'è

- **Provider Railway** (`src/cloud/railway-provider.ts`, `test/railway-provider.test.ts` con un Railway finto). Per ogni tenant un progetto Railway (rete privata e volume suoi), un servizio dall'immagine di Annie, un volume su `/data`, le variabili della cella senza far partire deploy a metà, la regione EU West (Amsterdam), la modalità serverless e un dominio `*.up.railway.app`. Il primo avvio fa il deploy; i risvegli successivi sono una richiesta che aspetta i 502 dell'avvio a freddo. «Spento» per il control plane vuol dire che smette di parlarle e lascia che Railway la metta a dormire. Una creazione fallita a metà cancella il progetto; gli errori nominano l'operazione, mai il token. `pnpm cloud upgrade` aggiorna variabili e rifà il deploy, tenendo il volume.
- **Control plane anche verso https**: il proxy verso una cella usa https se il suo indirizzo lo è, e manda come `Host` l'indirizzo della cella (Railway smista per quello), con quello pubblico in `X-Forwarded-Host`.
- **Immagine dalla CI** (`.github/workflows/image.yml`): a ogni PR costruisce il `Dockerfile` e controlla che il container, in sola lettura e senza capability, risponda su `/healthz`; su `main` la pubblica su `ghcr.io/<owner>/annie` (`latest` e lo SHA). È anche la verifica del `Dockerfile` vero che qui non si poteva fare.

## Da dove vengono le API

La documentazione di Railway non si raggiunge da questa sessione. Le mutation GraphQL vengono dagli esempi ufficiali citati nei forum di Railway e dal codice di un server MCP open source che le usa (`jason-tan-swe/railway-mcp`): `projectCreate`, `serviceCreate` con `source.image`, `volumeCreate` con `mountPath`, `variableCollectionUpsert` con `skipDeploys`, `serviceInstanceUpdate` con `sleepApplication` e `region`, `serviceDomainCreate`, `serviceInstanceDeployV2`, `projectDelete`. Sono tutte in un solo punto del file (`GQL`): la prima prova dal vivo le conferma o le corregge.

## Da misurare con il token (spike)

| Domanda | Come |
|---|---|
| Le mutation sono giuste | `pnpm cloud` con `ANNIE_CLOUD_PROVIDER=railway`, una registrazione |
| Tempo di risveglio da sonno | prima risposta dopo 15 minuti di silenzio |
| Costo di una cella che dorme | fattura dopo qualche giorno: il volume si paga anche da spenta? |
| Limiti di progetti per workspace | quanti tenant regge un account |
| Il control plane tiene sveglie le celle | non deve chiamarle quando sono «spente» (lo fa già) |

## Limiti

| Cosa | Limite |
|---|---|
| Verifica | solo contro un Railway finto: nessuna chiamata vera senza token |
| Immagine | se il pacchetto GHCR resta privato, Railway ha bisogno delle credenziali del registry |
| Esposizione | ogni cella ha un dominio pubblico: si difende come un self-host, ma è raggiungibile anche senza passare dal control plane |
| Isolamento | quello dei container della piattaforma; per la Fase 3 servono micro-VM |
