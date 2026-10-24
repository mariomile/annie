# I tool scritti dall'istanza girano solo dopo approvazione, in una sandbox

Un'istanza può scrivere i propri tool, come fa Hermes Agent, ma un tool proposto non entra mai in uso da solo: un approvatore vede codice, descrizione e host che dichiara di raggiungere, e lo approva o lo rifiuta. Approvato, gira in un processo separato con il permission model di Node (filesystem limitato alla sua cartella, niente processi figli né worker), senza variabili d'ambiente, con timeout e limite di memoria. I moduli di rete (`net`, `http`, `tls`, `dns`, ...) non si possono importare (hook di risoluzione e `process.getBuiltinModule` filtrato) e i globali di rete sono rimossi: l'unica uscita è un `fetch` inoltrato al processo principale, che applica l'egress policy (`tool:<nome>`) con gli host dichiarati. Abbiamo scartato l'autonomia piena (incompatibile con ciò che vendiamo: privacy e controllo dei processi) e l'esecuzione in-process con `node:vm` (non è un confine di sicurezza).

## Consequences

Il permission model di Node 22 non limita i socket di rete in sé: il blocco dei moduli di rete è nostro, nel runner, e una falla nel runtime di Node potrebbe aggirarlo. Per questo restano due difese in più: l'approvatore legge il codice e gli host prima di approvare, e per garanzie forti il deployment deve avere un egress firewall a livello di container (come già indicato in architettura).

## Utente di sistema separato: scartato (settimana 6)

Avevamo messo in lista «sandbox sotto un utente di sistema separato». Per far girare il processo del tool con un altro utente, il processo di Owni dovrebbe poter cambiare utente: servono root o le capability `CAP_SETUID`/`CAP_SETGID`, che il container dalla settimana 6 toglie apposta (`cap_drop: [ALL]`, `no-new-privileges`, filesystem in sola lettura tranne `/data` e `/tmp`). Rimettere quei privilegi per separare la sandbox renderebbe più pericoloso proprio il processo che tiene segreti e conversazioni. Un container per ogni esecuzione chiederebbe di dare a Owni il socket di Docker, che equivale a root sull'host.

Restiamo quindi con: permission model di Node e moduli consentiti nel processo del tool; container di Owni con privilegi minimi, che il processo del tool eredita; approvazione umana del codice e degli host; egress firewall sul container per chi vuole garanzie di rete forti. Da rivalutare se Node aggiungerà il blocco dei socket al permission model, o se un cliente chiederà un runner di tool separato, su un'altra macchina.
