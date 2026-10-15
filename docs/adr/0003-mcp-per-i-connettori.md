# MCP come protocollo dei connettori

I connettori verso servizi terzi parlano MCP (Streamable HTTP e stdio): un solo client nostro dà accesso a tutti i server MCP esistenti invece di un adapter scritto a mano per ogni servizio. Gmail e HubSpot restano adapter nostri perché la segreteria ne usa operazioni precise con garanzie di idempotenza. I connettori HTTP passano dal fetch con egress policy; quelli stdio sono processi locali che solo l'owner può configurare, e la loro rete va controllata a livello di deployment.
