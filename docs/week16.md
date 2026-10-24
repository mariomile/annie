# Settimana 16: Owni invia moduli web, con approvazione

Branch `week-16`. Decisione: [ADR 0011](adr/0011-moduli-web-con-approvazione.md), che rivede in parte l'ADR 0009. Mario ha scelto le azioni web con approvazione come passo dopo la settimana 15.

## Cosa funziona (verificato dai test)

- **`web_read` elenca i moduli** (`test/web-actions.test.ts`): per ogni modulo `POST` della pagina, destinazione, campi visibili con etichetta e scelte, e i pulsanti se sono più d'uno, dentro la recinzione dei dati dal web. I campi nascosti non compaiono.
- **`web_submit` chiede, non invia**: Owni indica pagina, modulo, valori e un motivo. Owni riapre la pagina e controlla modulo, metodo, destinazione e campi, poi salva la richiesta. Un valore per un campo nascosto, inesistente o fuori dalle scelte è rifiutato prima di tutto. Spento finché l'owner non accende «Azioni sul web» in Impostazioni.
- **Chi decide**: chi ha chiesto, nella sua conversazione privata (e solo finché può scrivere all'istanza), oppure un approvatore. In un gruppo solo un approvatore. Un'altra persona non vede né decide la richiesta (403).
- **Schede**: su Telegram e WhatsApp nella chat di chi ha chiesto e in quella degli approvatori, con «Invia» e «Rifiuta»; nella console in Approvazioni. Mostrano destinazione e tutto quello che parte tranne i campi nascosti. Con valori più lunghi di 300 caratteri l'invio si approva solo dalla console. Provato con un Telegram finto: il tocco di un estraneo non fa niente, quello della persona invia, quello dell'approvatore dopo dice «decisa in precedenza».
- **Una volta sola**: all'approvazione la pagina si riapre (token e cookie freschi) e il modulo deve essere identico a quando è stato chiesto, altrimenti non parte. Due approvazioni contemporanee inviano una volta. Una caduta durante l'invio, o un errore dopo che il modulo è partito, lasciano «esito incerto», mai «non inviato».
- **L'esito torna in chat** come messaggio per Owni, con la risposta del sito recintata, e Owni lo riferisce.
- **Audit**: richiesta approvata, rifiutata, inviata, fallita o incerta, con host e numero di campi, mai i valori.
- **Brief del mattino**: lì `web_submit` non gira, come gli altri tool che agiscono.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** Un errore dopo che il modulo era partito (un redirect verso un sito non consentito, una risposta che non arriva) diventava «non è partito», e invitava a inviarlo di nuovo. Ora è «esito incerto», per Owni e nella console.
- **Media.** Un 307 o 308 portava il corpo del modulo a un altro sito: ora è rifiutato. La scheda mostrava solo i valori del modello, non i valori già messi dalla pagina né il pulsante premuto, e un modulo cambiato con la stessa destinazione partiva lo stesso: ora la scheda mostra tutto tranne i campi nascosti, e un'impronta del modulo blocca l'invio se è cambiato. Il parser dei moduli rileggeva la pagina per ogni campo con tag civetta (1,8 secondi per pagina): ora la legge una volta per tag. La scrittura delle schede inviate poteva sovrascrivere una decisione appena presa: ora passa dalla stessa coda. Nomi di campo e scelte arrivavano al modello fuori dalla recinzione negli errori: ora sono ripuliti. Il campo nascosto `terms=0` prima della casella `terms=1` (Rails, Laravel) impediva di spuntarla; più caselle con lo stesso nome si spuntavano tutte insieme; il primo pulsante era sempre «premuto», anche se era «Elimina».
- **Bassa.** Il modello poteva sovrascrivere un campo nascosto con lo stesso nome di uno visibile; i campi disabilitati partivano; le entità esadecimali (`&#x2B;`) rompevano i token; i cookie ignoravano `Domain` e `Secure`; caratteri come «İ» spostavano gli indici del parser (anche in `web_read`); una richiesta poteva nascere due volte se il tool ripartiva dopo una caduta; una persona tolta dall'elenco poteva ancora approvare la propria richiesta; un tocco su una richiesta inesistente dava errore.

## Limiti

| Cosa | Limite |
|---|---|
| Pagine | solo moduli HTML che arrivano con la pagina: quelli costruiti da JavaScript chiedono il browser con clic, dopo le micro-VM |
| File | i moduli con caricamento di file partono senza il file; Owni non carica file |
| Login | Owni non entra con le credenziali di nessuno: solo moduli che non chiedono di essere autenticati |
| Scadenza | 24 ore, al massimo 20 richieste in attesa per istanza |
| CAPTCHA | un modulo con CAPTCHA fallisce, e l'esito lo dice |
