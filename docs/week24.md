# Settimana 24: «Primi passi» e la console come app

Branch `week-24`. Decisione: [ADR 0019](adr/0019-primi-passi-e-console-come-app.md). L'owner che apre Annie la prima volta trova «Primi passi»: cosa la rende utile, con le azioni lì dentro (istruzioni da un esempio, primo messaggio) o un «Vai» che porta alla scheda giusta. La console si installa come app sul telefono e sul desktop, e senza rete o senza server dice cosa succede invece di restare bianca. Non servono chiavi.

## Cosa funziona (verificato dai test)

- **Passi letti dalle impostazioni vere** (`test/onboarding.test.ts`): tutti «da fare» all'inizio; istruzioni, primo messaggio, web e team diventano «fatti» quando lo sono davvero; un bot Telegram collegato conta solo quando qualcuno può scrivergli; una persona aggiunta conta solo quando può scrivere a questa istanza; una vecchia copia delle istruzioni predefinite non conta come scritta dall'owner; solo l'owner vede i passi.
- **Istruzioni dell'owner**: aggiunte dopo quello che Annie sa fare, sostituite a ogni salvataggio (mai doppie); rifiutati testo vuoto, segnaposto «[…]» rimasti, più di 2000 caratteri, istruzioni e blocco insieme; una nuova istanza creata con delle istruzioni le aggiunge allo stesso modo.
- **App**: manifest con `id`, icone che esistono con il tipo giusto (anche maskable e apple-touch), `sw.js` `no-cache`, CSP con `manifest-src` e `worker-src`. Il service worker (eseguito in una sandbox `vm`) non tocca `/api`, altri siti, POST, file aperti in una nuova scheda o il ritorno da Google; tiene come pagina offline solo `/` aperta online; senza rete serve la shell.
- **Console** (Chromium, nessun errore): il primo avvio porta a «Primi passi» con il conteggio nel menu; un esempio seleziona il primo segnaposto e Salva non parte finché ne resta uno; il conteggio scende dopo il salvataggio; «Vai» apre Impostazioni sulla scheda Telegram e la evidenzia; dopo «Nascondi» l'indirizzo `/` apre la chat; offline la barra «Sei offline» e la shell; con il server giù «Non riesco a raggiungere Annie» e Riprova che rientra; il link incollato nella schermata di accesso fa entrare.

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Alta.** Con «Primi passi» primo nel menu, `/` e ogni indirizzo sconosciuto aprivano sempre i passi, anche dopo «Nascondi». Le istruzioni risultavano già scritte su ogni istanza esistente, perché il confronto era con il testo predefinito di oggi. Il telefono risultava collegato anche con un bot a cui nessuno poteva scrivere. Su iPhone l'app installata poteva restare sulla schermata di accesso senza modo di entrare.
- **Media.** Il controllo dei passi chiamava Telegram e Meta e bloccava la prima pagina (ora nessuna rete, e la console disegna prima). La schermata offline aspettava solo il ritorno della rete, mai il server (ora riprova ogni 10 secondi, con Riprova). Il service worker rispondeva con la shell ai file aperti in una nuova scheda. Le istruzioni salvate due volte si duplicavano, venivano tagliate a 20.000 caratteri o cancellavano le istruzioni mandate insieme; gli esempi si salvavano con «[città]». Una risposta d'errore contava come primo messaggio; una persona aggiunta senza accesso contava come team. Il rimando automatico contava passi impossibili da qui (il modello, l'app su Firefox). «Nascondi» valeva per una sola istanza e non si annullava. Nessuna guardia senza istanza. «Vai» portava in cima a una pagina lunga. La barra offline prometteva risposte e copriva il menu.
- **Bassa.** La pagina offline restava quella dell'installazione. Una modifica globale a `replaceChildren` (ora un `mount` locale). Manifest senza `id`, colore della barra fisso scuro, `mobile-web-app-capable` mancante. Dopo una nuova istanza il conteggio restava quello di prima. Testi: «ne mancano 1», prima e terza persona mescolate, «vocali» promessi senza trascrizione, il percorso `docs/chiavi.md` mostrato a chi non gestisce il server, iPad trattato come computer, «Annie è sulla schermata Home» sul desktop, la voce «installata» che restava dopo una disinstallazione. Il modo di trovare il proprio ID Telegram.

Lasciati e scritti nell'ADR: «Nascondi» vale per browser; il nome dell'app è «Annie» per ogni tenant; «Scrivile qualcosa» guarda solo la chat web. Per le persone che non sono owner c'è solo il pulsante per installare l'app nella chat.

## Limiti

| Cosa | Limite |
|---|---|
| Testo dell'owner | 2000 caratteri, un blocco solo |
| Conversazioni lette per «Scrivile qualcosa» | le 5 più recenti, solo web |
| Installazione | solo da https (o da questa macchina) |
| Offline | solo la shell: niente conversazioni né invii |
| Riprova senza server | ogni 10 secondi |
