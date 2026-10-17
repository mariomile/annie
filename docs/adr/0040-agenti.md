# Agenti: più agenti per tenant, ognuno con la sua personalità

Mario (17 ottobre 2026): «si devono poter creare più Agenti, ognuno con la propria memoria, personalità, automazioni». Come Grok bot, dove ogni bot ha un nome e un carattere.

Quasi tutto c'era già: un'istanza è un agente con il suo modello, le sue conversazioni, la sua memoria (`memory.json` nella cartella dell'istanza), i suoi task programmati e sentinelle, i suoi file, i suoi connettori e il suo bot su Telegram, WhatsApp e telefono. L'owner ne creava di nuove da «Nuova istanza». Mancavano tre cose: un nome che l'agente usa davvero (ogni istanza nuova si presentava come Annie, perché le istruzioni predefinite dicono «Sei Annie»), una personalità che non fosse un muro di istruzioni, e un posto dove vederli tutti.

## Decisione

- **Le persone vedono «agente», il codice resta `Instance`.** Nella console «istanza» diventa «agente» ovunque. Il glossario lo registra: un agente è un'istanza vista da chi la usa.
- **Persona.** `InstanceRecord.persona` ha tre campi facoltativi: `emoji` (la faccia nella console), `tagline` (cosa fa, in una riga, al più 120 caratteri) e `tone` (`naturale`, `formale`, `amichevole`, `conciso`, `scherzoso`). `checkPersona` li controlla: una sola emoji (niente lettere, cifre o spazi), un tono tra quelli previsti.
- **Il modello sa chi è.** All'apertura il runtime passa al motore `withPersona(istruzioni, nome, persona)`: le istruzioni dell'agente, poi un blocco «Chi sei» con il nome (se non è Annie), il compito e il tono. Per l'agente che si chiama Annie, senza persona, non si aggiunge niente: le conversazioni esistenti tengono le loro istruzioni e il motore non le riconfigura. Il blocco sta dopo le istruzioni, così l'owner non lo cancella per sbaglio modificandole, e cambia con un salvataggio (che riapre l'istanza).
- **Pagina Agenti.** Nella barra laterale, per tutti: ogni agente che la persona può vedere, con faccia, compito, modello, tono, canali oltre al web, e quanti task, sentinelle e ricordi ha. Un membro conta solo i task e le sentinelle che lavorano per lui e i ricordi suoi o condivisi, come nelle loro pagine. «Chatta» apre la chat con quell'agente; l'owner ha anche «Personalità e impostazioni».
- **Nuovo agente.** Il modulo parte da un modello (Da zero, Assistente, Ricercatore, Scrittore, Analista, Assistenza clienti) che riempie nome, emoji, compito, tono e istruzioni: si cambia tutto prima di creare. I modelli stanno nella console, non nel server: sono solo un aiuto a compilare.
- **Impostazioni.** La card «Personalità» sostituisce quella con nome e istruzioni: emoji e nome sulla stessa riga, compito, tono, istruzioni.
- **API.** `POST /api/instances` e `PUT /api/instances/:id/settings` accettano `persona`; `GET /api/instances` aggiunge `emoji` e `tagline` quando ci sono; `GET /api/agents` dà la pagina Agenti. Un nome vuoto in Impostazioni non cancella più il nome.

## Scartato

- **Un agente per thread, scelto dalla chat** (come i GPT): ogni agente ha già memoria, file e bot suoi; mescolarli nello stesso elenco di conversazioni confonderebbe di chi è la memoria.
- **Avatar caricati come immagini**: l'emoji basta a riconoscerli, non pesa e si vede uguale sul telefono, nel selettore e nei canali.
- **Personalità libera senza istruzioni**: il tono a scelta chiusa dice al modello una cosa precisa; il resto va nelle istruzioni, come prima.

## Conseguenze

- Gli agenti si parleranno tra loro (ADR successiva): il nome e il compito sono quello che un agente vede degli altri.
- Telegram e WhatsApp non cambiano: ogni agente ha già il suo bot. La faccia e il nome nei canali sono quelli del bot.
