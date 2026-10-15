# I tool scritti dall'istanza girano solo dopo approvazione, in una sandbox

Un'istanza può scrivere i propri tool, come fa Hermes Agent, ma un tool proposto non entra mai in uso da solo: un approvatore vede codice, descrizione e host che dichiara di raggiungere, e lo approva o lo rifiuta. Approvato, gira in un processo separato con il permission model di Node (filesystem limitato alla sua cartella, niente processi figli né worker), senza variabili d'ambiente, con timeout e limite di memoria, e la rete passa da un fetch inoltrato al processo principale che applica l'egress policy con gli host dichiarati. Abbiamo scartato l'autonomia piena (incompatibile con ciò che vendiamo: privacy e controllo dei processi) e l'esecuzione in-process con `node:vm` (non è un confine di sicurezza).

## Consequences

Il permission model di Node 22 non limita i socket di rete: un tool malevolo che apre connessioni proprie non passa dal nostro fetch. La difesa è doppia: l'approvatore legge il codice prima di approvarlo, e per garanzie forti il deployment deve avere un egress firewall a livello di container (come già indicato in architettura).
