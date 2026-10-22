# Le skill nel menu dei comandi di Telegram

L'ADR 0059 lasciava da fare il menu: le skill si lanciano scrivendo `/nome`, ma su Telegram la persona doveva sapere che esistono. Il menu accanto alla casella del messaggio mostrava solo `/modello`.

## Decisione

- **Una voce di menu per skill, accanto a `/modello`.** Il comando è il nome della skill con i trattini sostituiti da underscore (`chiusura-del-mese` diventa `chiusura_del_mese`), perché Telegram accetta solo `a-z`, `0-9` e `_`. La descrizione è la riga della skill, tagliata a 256 caratteri. La voce si costruisce con `skillMenuEntry`, in `src/core/skills.ts`, accanto a `skillCommand` che fa il percorso inverso.
- **Nessun controllo in più.** Il magazzino delle skill garantisce già nomi validi, unici e di al massimo 32 caratteri, una riga non vuota, `modello` riservato e al massimo 40 skill e bozze per agente: il menu non supera mai le 41 voci. Resta solo il taglio della riga a 256 caratteri, perché una riga può averne 1024.
- **Nessun cambio al lancio.** Il core riconosceva già `/chiusura_del_mese` e `/chiusura_del_mese@NomeBot ottobre` (ADR 0059): toccare una voce del menu manda l'agente a usare quella skill, con le parole della persona che restano quelle che si vedono in chat.
- **Il menu si imposta quando il bot è collegato**: le skill si leggono quando si costruisce l'adattatore e `setMyCommands` parte in `start`, con le skill che l'agente ha in quel momento.

## Conseguenze

- Una skill salvata, cambiata o cancellata dopo l'avvio compare o sparisce dal menu solo al nuovo collegamento del bot (anche dopo un riavvio del server; fermare e riavviare il bot non basta): oggi nel codice non c'è un punto da cui avvisare l'adattatore quando `skills.json` cambia. Nel frattempo `/nome` funziona comunque, anche se la voce non c'è, e una voce di una skill cancellata risponde come un comando sconosciuto.
- Il menu è per bot, quindi per istanza: ogni agente mostra le sue skill.
- Un aggiornamento del menu a ogni salvataggio richiederebbe un canale dal salvataggio (console e `skill_save`) all'adattatore: si può aggiungere dopo, senza cambiare il formato.
