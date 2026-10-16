# Fase 3, secondo passo: inviare moduli web con approvazione, senza browser e senza micro-VM

L'ADR 0009 rimandava le azioni sul web alle micro-VM. Le rivediamo in parte: un'istanza può ora **inviare un modulo** di un sito consentito (`web_submit`), ma solo dopo che una persona ha letto la richiesta intera e l'ha approvata. Niente clic in un browser, niente JavaScript della pagina, niente terminale.

Perché adesso: compilare il modulo di contatto di un fornitore, prenotare un appuntamento, iscriversi a un evento sono le prime azioni che le persone chiedono, e in quasi tutti i siti sono un `<form>` HTML. Inviarlo non richiede di eseguire codice altrui: è una richiesta HTTP, che passa dallo stesso fetch controllato di `web_read` (solo siti consentiti, mai indirizzi interni, ogni redirect ricontrollato). Il rischio delle azioni non è l'isolamento della cella ma l'effetto verso l'esterno, e quello lo copre l'approvazione.

## Come funziona

- `web_read` elenca i moduli della pagina (indice, metodo, destinazione, campi visibili), dentro la recinzione dei dati dal web.
- `web_submit` chiede di inviare il modulo N di una pagina con dei valori. Annie riapre la pagina e controlla che il modulo esista, che sia `POST`, che la destinazione sia un sito consentito e che i campi esistano e siano visibili: i campi nascosti li decide il sito, mai il modello. La richiesta viene salvata e mostrata con destinazione e valori esatti.
- Approva chi ha chiesto l'azione, nella sua conversazione privata con Annie, oppure un approvatore dell'istanza. Le schede arrivano nella conversazione (Telegram, WhatsApp) e nella pagina Approvazioni della console. In un gruppo approva solo un approvatore.
- All'approvazione Annie riapre la pagina, prende i campi nascosti freschi (token CSRF) e i cookie di quella visita, controlla che il modulo abbia ancora la stessa destinazione e lo stesso metodo, e lo invia una volta sola. Lo stato passa da `approved` a `running` prima della richiesta: se il processo cade a metà, l'azione resta «esito incerto» e non riparte da sola.
- L'esito (codice e testo della risposta, recintato) torna nella conversazione come messaggio per Annie, che lo riferisce.

## Limiti voluti

- L'owner accende le azioni per istanza (Impostazioni, «Azioni sul web»); spente di default, come canali e connettori. I siti restano quelli della navigazione.
- Una richiesta scade dopo 24 ore. Al massimo 20 in attesa per istanza.
- Niente file da caricare, niente moduli `GET` (per quelli basta `web_read` con l'indirizzo), niente pagine costruite da JavaScript.
- Nella chat del brief del mattino `web_submit` non gira, come gli altri tool che agiscono.

## Alternative scartate

- **Browser con clic e digitazione**: copre più siti, ma il modello dovrebbe guidare una pagina viva scelta da altri, e per renderlo sicuro servono le micro-VM. Resta per dopo.
- **Approvazione solo dagli approvatori dell'istanza**: in un'istanza personale chi chiede è anche chi risponde dell'azione; mandargli la scheda è più naturale e non indebolisce il controllo, perché vede la richiesta esatta.
- **Inviare subito se la persona lo ha chiesto in chat**: una pagina con istruzioni nascoste potrebbe far partire un invio che nessuno ha chiesto. La scheda separa la richiesta del modello dalla decisione della persona.

## Conseguenze

- Le azioni finiscono nell'audit: richiesta, decisione, esito (mai i valori dei campi).
- I valori dei campi restano nella richiesta salvata nella cartella dell'istanza, come le bozze della segreteria.
- Il terminale e il browser con azioni restano legati alle micro-VM (ADR 0008).
