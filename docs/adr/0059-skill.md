# Skill: procedure salvate e comandi slash

Le persone che usano un agente gli spiegano spesso lo stesso modo di lavorare («per chiudere il mese guarda prima le fatture scadute, poi le spese, poi scrivimi il riepilogo così»), e finora dovevano rispiegarlo ogni volta o metterlo nelle istruzioni, che sono dell'owner. Tutte le alternative open source a Grok Bot che abbiamo guardato (MausBot, Rakazo, Codync, OpenBot, [confronto](../../README.md)) hanno le skill: procedure con un nome che l'agente apre quando servono e che la persona lancia con un comando.

## Decisione

- **Una skill è di un agente**: nome, una riga che dice quando usarla, i passi in Markdown. Sta in `skills.json` accanto alla memoria dell'istanza, non nel workspace: un file scaricato dal web o arrivato in una mail non diventa una skill solo perché finisce in una cartella. Al più 40 per agente (bozze comprese), un nome di 32 caratteri come i comandi di Telegram (un nome più lungo si rifiuta, non si taglia), 1024 caratteri di descrizione come nel formato Agent Skills, di cui nelle istruzioni vanno i primi 200, e 20.000 di passi.
- **Il nome è il comando**: «Chiusura del mese» diventa `chiusura-del-mese`, e `/chiusura-del-mese ottobre` la lancia da console, Telegram e WhatsApp (anche `/chiusura_del_mese@NomeBot` in un gruppo Telegram). È il core a riconoscerlo, per ogni canale: i passi si aggiungono dopo le parole della persona, che restano quelle che si vedono in chat, e l'audit scrive `skill.used` con il solo nome. Un comando che non è una skill passa com'è. I nomi dei comandi di Annie (`modello`, `tool`, `start`, `skill` e pochi altri) non si possono usare.
- **L'agente sa quali ha**: in fondo alle istruzioni c'è un blocco «Skill» con come salvarne una e, per ognuna, nome e riga. I passi no: li apre con `skill_read` quando un compito corrisponde. Il blocco si rilegge a ogni messaggio, così una skill salvata vale dal messaggio dopo, anche nelle conversazioni già aperte, senza riaprire l'agente. Per questo `instructions` del motore può essere una funzione (`EngineOpenOptions`).
- **Dalla chat l'agente scrive una bozza, la persona la attiva**: `skill_save`, in una conversazione con una persona sola, salva una bozza di quella persona, che non è nelle istruzioni e non si lancia. Diventa una skill quando la persona scrive `/attiva-skill nome` (o solo `/attiva-skill` se ha una bozza sola). Il comando lo riconosce il core, in un messaggio che la persona ha scritto in una conversazione con lei sola: mai in un task programmato, una sentinella, un avviso o un messaggio di un altro agente. Chi la attiva ne è l'autore: solo lui la aggiorna (con una nuova bozza) o la cancella dalla chat (`skill_delete`).
- **Dalla console si salva attiva**, perché la persona è entrata col suo link: `GET`, `PUT`, `DELETE /api/instances/:id/skills`. Ognuno vede tutte le skill e le sue bozze, salva e cancella le sue; l'owner tutte. Chi l'ha salvata lo vede solo l'owner, perché da una chat è un numero di telefono o un ID di Telegram. Una skill salvata da Telegram o WhatsApp in console la cambia solo l'owner: le identità dei canali non sono legate alle persone della console.
- **Formato Agent Skills**: una skill entra da un `SKILL.md` (intestazione con `name` e `description`, anche su più righe con `>`) caricato in chat o incollato in console, ed esce come `skills/<nome>/SKILL.md` nel workspace con `skill_export`, per mandarla o usarla in un'altra app.

## Sicurezza

- **Una mail o una pagina non aggiunge passi per tutti**: l'agente che le legge può al più scrivere una bozza, e una bozza la attiva solo il suo autore con un messaggio suo. Un task programmato o una sentinella che lavora per una persona scrive bozze a nome suo, mai skill.
- **Nome e riga di ogni skill sono nelle istruzioni di tutte le conversazioni dell'agente**, gruppi compresi: li scrive una persona che può parlare con l'agente, e il blocco li presenta come scritti dalle persone. L'owner vede chi li ha scritti e li toglie dalla console.
- **L'audit ha solo i nomi** (`skill.saved`, `skill.activated`, `skill.used`, `skill.read`, `skill.deleted`), mai descrizione e passi.
- **Un `skills.json` rovinato vale come nessuna skill**: l'agente continua a rispondere. Il file si rilegge solo quando cambia.

## Alternative scartate

- **Salvare attiva dalla chat**, con la sola regola nella descrizione del tool: un testo letto dall'agente poteva bastare a mettere passi davanti a tutti.
- **Approvazione dell'owner per ogni skill**: più sicura per l'owner, ma una persona che insegna una procedura all'agente non dovrebbe aspettare qualcun altro; la bozza che si attiva da sé tiene la stessa garanzia contro i testi letti.

- **Skill come file nel workspace** (`skills/<nome>/SKILL.md`, come Claude Code e Codync): comodo da modificare, ma il workspace lo scrivono anche `web_download`, gli allegati e il terminale, e una skill sono istruzioni. Il file si può sempre importare con `skill_save`.
- **I passi di tutte le skill nelle istruzioni**: 40 skill lunghe in ogni richiesta costano e confondono; bastano nome e riga, come fanno le Agent Skills.
- **Una libreria di skill condivisa fra gli agenti** (la «organization library» di MausBot): per ora ogni agente ha le sue, come la memoria. Si può aggiungere dopo, con l'export e l'import che ci sono già.

## Console

La pagina «Skill» (nella barra, sotto Memoria) elenca le skill dell'agente e le bozze della persona: si crea, si modifica, si importa un `SKILL.md` incollato o caricato, si scarica come `SKILL.md`, si attiva una bozza o la si scarta. Il nome non si cambia dopo il salvataggio, perché è il comando.

I comandi delle skill stanno nel menu di Telegram accanto a `/modello` ([ADR 0104](0104-skill-nel-menu-di-telegram.md)).
