# Lista de preguntas para José — 2026-06-20 (lote mixto r3)

> Integrada por Claude Code tras ejecutar el lote A/B/C/D/E. Chandler la traslada a José.
> Las preguntas 1–7 son las del prompt; la 8 es un hallazgo nuevo (falta el PDF de CONTENTO).

1. **MSC – Conteiner Protection Fee: ¿50/60 o 25?**
   Tu Excel se contradice: la hoja de detalle de MSC dice **50** (GP/HQ/DC) / **60** (los otros 5 grupos),
   pero la hoja resumen `ALL NAV` del MISMO Excel sigue en **25** (28.99 con IVA). **No se cambió nada** —
   esperamos tu confirmación de cuál es el valor final.

2. **KMTC – ¿renombraste dos cargos a propósito?**
   Se aplicaron (Excel manda sobre el sistema): "Release Fee" → **"Doc Fee at Destination"**;
   "Container Handling" → **"Container Release Fee"** (montos sin cambio). ¿Es intencional el cambio de nombre?

3. **RCL y HAPAG: dijiste que los actualizaste, pero coinciden 100% con el sistema.**
   No requirieron cambio. ¿Confirmas que ya estaban correctos, o creías haberlos cambiado?

4. **Garantía (depósitos) y demoras: no se cotejaron esta vez.**
   El Excel trae datos (p. ej. HAPAG garantía 25000 MXN; `ALL NAV` separa depósitos por `20/40 SD HC` vs `Especial`,
   mientras nuestro JSON usa un mismo monto por grupo). ¿Quieres que los revisemos en una ronda aparte?

5. **CONTENTO – relación naviera ↔ patio.**
   Cargamos los patios y precios (método B), pero `shippingLineIds` quedó VACÍO. ¿Qué naviera corresponde a cada patio?
   (pistas en los nombres: Damco=Maersk, Shanghai=Agunza, Consignataria Oceánica=Sinotrans, Container Care=TIMSA, Hazesa KMCT).

6. **CONTENTO es precio de COSTO (lo que TÚ pagas a CONTENTO), ¿correcto?**
   El sistema lo registra del lado de costo (no se suma automáticamente a la cotización al cliente). Confirma.

7. **7 nuevas navieras (ESL/SINOKOR/SL/SEA LEAD/TS LINES/HMM/SINOTRANS).**
   Ya hay botón "**+ Nueva naviera**" en el backend (nombre/código/RFC → completar cargos/garantía/demoras/terminal).
   Cuando nos des sus tarifas/depósito/demoras/terminal, las damos de alta (o las capturas tú).

8. **[NUEVO] Falta el PDF de CONTENTO en el repositorio.**
   El prompt indicaba `docs/client-info-source/Presentacion_de_Servicios_para_Yisel_Guzman.pdf`, pero **no estaba**.
   Solo teníamos 2 precios de maniobra confirmados (Servimaniobras 3800, Contecon R.F. 4100) y la limpieza estándar (550 MXN).
   Se cargaron los 26 patios nombrados con esos datos; **el resto de las maniobras quedó en 0 con nota "pendiente PDF"** y
   la lista completa (~35) requiere el PDF. **Necesitamos el PDF de CONTENTO** para completar precios y patios.
