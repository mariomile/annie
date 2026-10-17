# Settimana 27: report di ricerca con le fonti

Branch `week-27`. Decisione: [ADR 0022](adr/0022-report-di-ricerca.md). Quando le chiedono di approfondire un tema, Annie fa più ricerche insieme, legge le pagine migliori dei siti consentiti e scrive un report in Markdown con le fonti numerate, che salva nel workspace e manda in chat. Serve la ricerca sul web della settimana 22 ([chiavi](chiavi.md) §13); i test usano un Brave finto e pagine locali.

## Cosa funziona (verificato dai test)

- **Raccolta** (`test/research.test.ts`): spenta finché l'owner non accende la ricerca; ogni ricerca conta nel limite del giorno, e quando finisce lo dice. Le pagine si aprono una volta (anche con `#` diversi), solo dai siti consentiti; un redirect verso un sito non consentito non si segue. Del testo restano i paragrafi che parlano della domanda, non menu e contorno. Pagina sparita: fuori; pagina che rifiuta, sito non consentito: solo l'estratto, detto. Le parole di una pagina («ignora le istruzioni…») restano dentro il recinto.
- **Dossier**: numerato in `ricerche/<domanda>/fonti.json`; la stessa domanda aggiunge fonti di seguito senza riaprire quelle lette.
- **Report**: numeri che non sono nel dossier e report senza citazioni rifiutati con un messaggio che il modello può correggere; l'elenco di fonti del modello sostituito da quello vero, solo le citate; un titolo già usato fa un file nuovo; un dossier scritto a mano non vale.
- **Audit**: solo numeri, mai la domanda.
- **Console** (Chromium, desktop e telefono, nessun errore): la raccolta e il report in chat, il file `.md` come allegato che si apre.

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Media.** Una seconda raccolta sulla stessa domanda, che il tool stesso suggeriva, cancellava il dossier e rinumerava: le citazioni avrebbero puntato a fonti diverse. Ora si aggiunge. Un `fonti.json` scritto dal modello poteva mettere link `javascript:` nel report: ora il dossier si controlla. Un report con lo stesso titolo sovrascriveva il precedente.
- **Bassa.** Pagine scaricate e poi scartate oltre il limite di fonti; pagine 403 buttate con il loro estratto; anni tra parentesi e testo dei link contati come citazioni; sigle (IVA, UE), plurali e numeri ignorati nella scelta dei paragrafi; estratti di 1.500 caratteri troppo corti; un invio fallito non gestito; «Ricerca del sabato…»; elenco delle fonti senza data; nessun avviso sui siti non consentiti né sui report fatti solo di estratti; un elenco «**Fonti:**» in grassetto restava doppio; descrizioni dei parametri.

Lasciati e scritti nell'ADR: il Markdown su Telegram e WhatsApp, due raccolte contemporanee sulla stessa domanda.

## Limiti

| Cosa | Limite |
|---|---|
| Ricerche per raccolta | da 2 a 6, ognuna dal limite giornaliero |
| Pagine lette | 8 per raccolta, 4 per sito, 4 alla volta |
| Fonti | 12 per raccolta, 24 per dossier |
| Testo per pagina | 2.500 caratteri |
| Report | 60.000 caratteri |
