# Tool per istanza, cambiati riaprendo l'istanza

Pi Durable registra i tool all'apertura dell'harness. Invece di un tool «dispatcher» generico che inoltra chiamate (il modello vedrebbe un solo tool con argomenti opachi e sceglierebbe peggio), ogni istanza ha il suo elenco di tool, calcolato all'apertura da integrati, connettori e tool proposti approvati; quando l'elenco cambia, il runtime chiude e riapre l'istanza. Le conversazioni in corso riprendono dopo la riapertura come dopo un crash.
