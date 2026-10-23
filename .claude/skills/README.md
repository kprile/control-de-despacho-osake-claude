# Skills del proyecto

Copiadas de [obra/superpowers](https://github.com/obra/superpowers) (commit `2ce8aa1`, licencia MIT, ver `LICENSE-superpowers`).

| Skill | Cuándo se usa |
|---|---|
| `systematic-debugging` | Ante un bug, prueba fallida o comportamiento inesperado: buscar la causa raíz antes de corregir. |
| `verification-before-completion` | Antes de dar algo por terminado, hacer commit o abrir un PR: ejecutar la verificación y mostrar la evidencia. |

Se cargan solo cuando la tarea calza con su descripción. **No se instaló el plugin completo ni su hook `SessionStart`**: ese hook inyecta en cada sesión la regla de invocar skills (brainstorming, planes) antes de cualquier respuesta, lo que haría más lento el trabajo diario.

Cambios respecto del original: se quitaron las referencias a skills no copiadas (`test-driven-development`) y el archivo de ejemplo TypeScript. `find-polluter.sh` es un script de apoyo que solo se ejecuta a mano.
