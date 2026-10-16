# Fase 3, quinto passo: il computer su micro-VM, anche in Annie Cloud

Il computer della settimana 18 (ADR 0013) gira come container sul server dove Annie è installata, e in Annie Cloud resta spento: dare a una cella il socket di Docker equivale a darle il server. Ora il computer può essere una **Fly.io Machine**, una micro-VM con un kernel suo, e così si accende anche per le celle di Annie Cloud.

## Come funziona

- **Una app Fly per computer**, cioè per istanza, su una rete privata sua (nessun'altra app la raggiunge), senza indirizzo pubblico e senza servizi: niente arriva alla macchina. `/work` è un volume cifrato della app, grande quanto la quota arrotondata al gigabyte. Regione UE (`fra` di default).
- **Sigillata prima di tutto**: il primo processo della macchina (`docker/annie-fly-init`, come root) blocca ogni pacchetto in uscita tranne loopback e le risposte a connessioni entrate (che non ce ne sono), con iptables e ip6tables. Solo dopo segna la macchina come sigillata; `annie-run` non avvia un comando su una macchina che non lo è. Se il firewall non si applica, nessun comando parte.
- **I comandi** passano dall'API exec di Fly a `docker/annie-run`, che li esegue come uid 1000 in `/work`, senza privilegi nuovi. Un exec risponde entro 60 secondi, quindi il comando parte in background e si aspetta a fette: un comando può durare fino a 5 minuti come in Docker. Alla fine, o quando la conversazione lo annulla, tutto quello che uid 1000 ha acceso viene chiuso. Stesse uscite di ADR 0013: inizio di stdout e fine di stderr, 64 KB ciascuno, quota del disco.
- **I file** entrano ed escono a pezzi da 512 KB, letti e scritti come uid 1000 senza seguire collegamenti.
- **Si spegne da sola**: senza chiamate per 10 minuti il primo processo termina e la macchina si ferma, anche se chi l'ha accesa non c'è più. Al comando dopo riparte con i suoi file. Una macchina ferma costa solo il volume.
- **Azzerare** cancella la app con macchina e volume.

## In Annie Cloud

Il token di Fly sta solo nel control plane (`ANNIE_CLOUD_COMPUTER=fly`). Le celle ricevono `ANNIE_COMPUTER=cloud` e l'indirizzo del control plane, e chiedono lì i comandi e i file per il proprio tenant, con un token derivato dal loro segreto. Il control plane rinomina ogni computer con il tenant e la chiave mandata dalla cella, quindi una cella non può raggiungere il computer di un altro tenant qualunque chiave mandi. Al più 2 comandi alla volta per tenant; un tenant sospeso (prova finita) non esegue niente. L'owner accende il computer istanza per istanza come prima.

Installando Annie su un proprio server si può usare Fly direttamente (`ANNIE_COMPUTER=fly`): il token sta nel server dell'operatore.

## Alternative scartate

- **Il token di Fly nelle celle**: un token dell'organizzazione raggiunge tutte le app; una cella compromessa raggiungerebbe i computer degli altri. Un token per app sarebbe da creare, dare e ruotare per ogni istanza, e la cella potrebbe comunque cambiare la configurazione della sua macchina (immagine, rete).
- **La rete della macchina affidata solo a Fly**: le network policy di Fly hanno solo regole di permesso e il loro comportamento verso internet non è documentato; nessuna opzione dell'API toglie l'uscita a una macchina. Il sigillo dentro la VM è nostro e si prova nella CI (job `computer`: l'immagine reale su una rete che raggiunge internet).
- **Un comando per exec**: 60 secondi bastano a poco; un comando lungo verrebbe tagliato.
- **Firecracker su server nostri**: più controllo, ma serve gestire host, immagini e rete. Fly lo fa già, in UE.

## Conseguenze

- Prima di accenderlo per tutti serve una prova dal vivo con un token vero (`test/computer-fly.live.test.ts` con `FLY_API_TOKEN` e `ANNIE_TEST_FLY_ORG`): che la macchina parta, che il sigillo regga sul kernel di Fly, che l'exec accetti i pezzi da 512 KB.
- Le risposte alle connessioni entrate restano permesse: se Fly un giorno inoltrasse traffico a una macchina senza servizi, la macchina potrebbe rispondere. Nessun processo in ascolto la rende comunque inutile.
- Copiare 100 MB dentro richiede circa 200 chiamate all'API di Fly.
- I file del computer stanno nei volumi di Fly, fuori dal backup di Annie, come in ADR 0013.
